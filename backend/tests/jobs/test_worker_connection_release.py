# Copyright 2026 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""Generation jobs must not hold a DB connection through their long calls.

A job's first query autobegins a transaction, which keeps its connection
checked out of the pool until the transaction ends. pool_pre_ping only checks
connections on checkout, so a connection held through a minutes-long Vertex
call and dropped meanwhile fails the job's next write with "connection was
closed in the middle of operation". Each test reads through a real session,
then checks the session is out of its transaction when the long call runs.
"""

import base64
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from google.genai.interactions import VideoContent
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from src.common.base_dto import GenerationModelEnum
from src.common.schema.media_item_model import JobStatusEnum
from src.images.dto.create_imagen_dto import CreateImagenDto
from src.images.dto.vto_dto import VtoDto, VtoInputLink
from src.images.imagen_service import (
    _process_image_in_background,
    _process_upload_upscale_in_background,
    _process_vto_in_background,
)
from src.users.user_model import UserModel, UserRoleEnum
from src.videos.dto.concatenate_videos_dto import (
    ConcatenateVideosDto,
    ConcatenationInput,
)
from src.videos.dto.create_veo_dto import AssetReferenceDto, CreateVeoDto
from src.videos.veo_service import (
    _process_video_concatenation_in_background,
    _process_video_in_background,
)

USER = UserModel(
    id=1,
    email="user@example.com",
    roles=[UserRoleEnum.USER],
    name="User",
    picture="http://example.com/u.jpg",
)
SOURCE = SimpleNamespace(
    id=7,
    gcs_uri="gs://bucket/source.png",
    gcs_uris=["gs://bucket/source.mp4"],
    original_gcs_uris=None,
    mime_type="image/png",
)


class _Probe:
    """Real session plumbing plus a fake repository that reads through it."""

    def __init__(self, path):
        self.path = path
        self.sessions = []
        self.updates = []
        self.held_during_call = []

    def worker_database(self):
        probe = self

        class _FakeWorkerDatabase:
            engine = None

            async def __aenter__(self):
                self.engine = create_async_engine(
                    f"sqlite+aiosqlite:///{probe.path}"
                )
                return async_sessionmaker(self.engine, expire_on_commit=False)

            async def __aexit__(self, *exc):
                await self.engine.dispose()

        return _FakeWorkerDatabase

    def repository(self, item=SOURCE):
        probe = self

        class _Repo:
            """Stands in for MediaRepository and SourceAssetRepository."""

            def __init__(self, db):
                self.db = db
                probe.sessions.append(db)

            async def get_by_id(self, item_id, **_):
                del item_id
                # Like the real get_by_id, a read opens a transaction.
                await self.db.execute(text("SELECT 1"))
                assert self.db.in_transaction()
                return item

            async def update(self, item_id, data):
                del item_id
                probe.updates.append(data)

        return _Repo

    def record(self, result=None):
        """A stand-in for the long call that notes if a connection is held."""

        def call(*args, **kwargs):
            del args, kwargs
            self.held_during_call.append(
                any(s.in_transaction() for s in self.sessions)
            )
            return result

        return call

    def assert_released_and_completed(self):
        assert self.held_during_call, "the long call never ran"
        assert not any(self.held_during_call)
        assert self.updates[-1]["status"] == JobStatusEnum.COMPLETED


@pytest.fixture(name="probe")
def fixture_probe(tmp_path, monkeypatch):
    # The video workers write temp files relative to the working directory.
    monkeypatch.chdir(tmp_path)
    return _Probe(tmp_path / "jobs.db")


def _image(uri):
    return SimpleNamespace(image=SimpleNamespace(gcs_uri=uri, mime_type="png"))


def test_image_job_releases_its_connection_during_generation(probe):
    dto = CreateImagenDto(
        workspace_id=1,
        prompt="Make it night",
        generation_model=GenerationModelEnum.GEMINI_3_1_FLASH_IMAGE_PREVIEW,
        aspect_ratio="1:1",
        source_asset_ids=[7],
    )
    with (
        patch(
            "src.images.imagen_service.WorkerDatabase",
            probe.worker_database(),
        ),
        patch("src.images.imagen_service.MediaRepository", probe.repository()),
        patch(
            "src.images.imagen_service.SourceAssetRepository",
            probe.repository(),
        ),
        patch("src.images.imagen_service.GeminiService"),
        patch("src.images.imagen_service.GcsService"),
        patch("src.images.imagen_service.IamSignerCredentials"),
        patch("src.images.imagen_service.GenAIModelSetup.init"),
        patch(
            "src.images.imagen_service.generate_image_thumbnail_from_gcs",
            return_value="gs://bucket/thumb.png",
        ),
        patch(
            "src.images.imagen_service.gemini_generate_image",
            side_effect=probe.record((_image("gs://bucket/out.png"), None)),
        ),
    ):
        _process_image_in_background(
            media_item_id=1, request_dto=dto, current_user=USER
        )

    probe.assert_released_and_completed()


def test_vto_job_releases_its_connection_during_generation(probe):
    dto = VtoDto(
        workspace_id=1,
        person_image=VtoInputLink(source_asset_id=7),
        top_image=VtoInputLink(source_asset_id=7),
    )
    generated = MagicMock()
    generated.image.gcs_uri = "gs://bucket/vto.png"
    response = SimpleNamespace(generated_images=[generated])
    with (
        patch(
            "src.images.imagen_service.WorkerDatabase",
            probe.worker_database(),
        ),
        patch("src.images.imagen_service.MediaRepository", probe.repository()),
        patch(
            "src.images.imagen_service.SourceAssetRepository",
            probe.repository(),
        ),
        patch("src.images.imagen_service.GcsService") as gcs_class,
        patch("src.images.imagen_service.IamSignerCredentials"),
        patch(
            "src.images.imagen_service.optimize_image_bytes",
            return_value=b"img",
        ),
        patch(
            "src.images.imagen_service.generate_image_thumbnail_from_gcs",
            return_value="gs://bucket/thumb.png",
        ),
        patch("src.images.imagen_service.GenAIModelSetup.init") as init,
    ):
        gcs_class.return_value.download_bytes_from_gcs.return_value = b"img"
        init.return_value.models.recontext_image.side_effect = probe.record(
            response
        )
        _process_vto_in_background(
            media_item_id=1, request_dto=dto, current_user=USER
        )

    probe.assert_released_and_completed()


def test_upscale_job_releases_its_connection_during_the_upscale(probe):
    async def upscale(*args, **kwargs):
        return probe.record(_image("gs://bucket/up.png"))(*args, **kwargs)

    with (
        patch(
            "src.images.imagen_service.WorkerDatabase",
            probe.worker_database(),
        ),
        patch("src.images.imagen_service.MediaRepository", probe.repository()),
        patch(
            "src.images.imagen_service.SourceAssetRepository",
            probe.repository(),
        ),
        patch("src.images.imagen_service.ImagenService") as imagen_class,
        patch("src.images.imagen_service.GcsService"),
        patch("src.images.imagen_service.IamSignerCredentials"),
        patch("src.images.imagen_service.GeminiService"),
        patch(
            "src.images.imagen_service.generate_image_thumbnail_from_gcs",
            return_value="gs://bucket/thumb.png",
        ),
    ):
        imagen_class.return_value.upscale_image.side_effect = upscale
        _process_upload_upscale_in_background(
            media_item_id=1,
            workspace_id=1,
            user=USER,
            gcs_uri="gs://bucket/source.png",
            file_bytes=None,
            filename=None,
            upscale_factor="x2",
            aspect_ratio=None,
            source_asset_id=7,
        )

    probe.assert_released_and_completed()


def _run_video(probe, dto, client_patch, configure):
    with (
        patch("src.database.WorkerDatabase", probe.worker_database()),
        patch("src.videos.veo_service.MediaRepository", probe.repository()),
        patch(
            "src.videos.veo_service.SourceAssetRepository",
            probe.repository(),
        ),
        patch("src.videos.veo_service.GeminiService"),
        patch("src.videos.veo_service.GcsService") as gcs_class,
        patch("src.videos.veo_service.generate_thumbnail", return_value=None),
        patch("src.videos.veo_service.GenAIModelSetup.init"),
        patch(client_patch) as client_factory,
    ):
        gcs_class.return_value.upload_file_to_gcs.return_value = "gs://b/v.mp4"
        configure(client_factory.return_value)
        _process_video_in_background(
            media_item_id=1, request_dto=dto, user_email="user@example.com"
        )


def test_veo_job_releases_its_connection_while_veo_runs(probe):
    dto = CreateVeoDto(
        workspace_id=1,
        prompt="A storm rolling in",
        generation_model=GenerationModelEnum.VEO_3_QUALITY,
        start_image_asset_id=AssetReferenceDto(id=7, type="source_asset"),
    )
    video = SimpleNamespace(video=SimpleNamespace(uri="gs://bucket/out.mp4"))
    operation = SimpleNamespace(
        done=True,
        error=None,
        name="op",
        response=SimpleNamespace(generated_videos=[video]),
    )

    def configure(client):
        client.models.generate_videos.side_effect = probe.record(operation)

    _run_video(
        probe, dto, "src.videos.veo_service.GenAIModelSetup.init", configure
    )

    probe.assert_released_and_completed()


def test_omni_job_releases_its_connection_while_omni_runs(probe):
    dto = CreateVeoDto(
        workspace_id=1,
        prompt="A storm rolling in",
        generation_model=GenerationModelEnum.GEMINI_OMNI_1_1_FLASH_PREVIEW,
        reference_video=AssetReferenceDto(id=7, type="media_item"),
    )
    video = VideoContent(
        data=base64.b64encode(b"video").decode(), mime_type="video/mp4"
    )
    step = MagicMock(type="model_output", content=[video], signature="sig")
    interaction = MagicMock(id="interaction", steps=[step])

    def configure(client):
        client.interactions.create.side_effect = probe.record(interaction)

    _run_video(
        probe,
        dto,
        "src.videos.veo_service.GenAIModelSetup.get_omni_client",
        configure,
    )

    probe.assert_released_and_completed()


def test_concatenation_job_releases_its_connection_while_it_downloads(probe):
    dto = ConcatenateVideosDto(
        workspace_id=1,
        inputs=[
            ConcatenationInput(id=7, type="media_item"),
            ConcatenationInput(id=8, type="source_asset"),
        ],
    )
    video = SimpleNamespace(**{**vars(SOURCE), "gcs_uri": "gs://b/s.mp4"})
    with (
        patch("src.database.WorkerDatabase", probe.worker_database()),
        patch("src.videos.veo_service.MediaRepository", probe.repository()),
        patch(
            "src.videos.veo_service.SourceAssetRepository",
            probe.repository(video),
        ),
        patch("src.videos.veo_service.GcsService") as gcs_class,
        patch(
            "src.videos.veo_service.concatenate_videos",
            return_value="/tmp/out.mp4",
        ),
        patch("src.videos.veo_service.generate_thumbnail", return_value=None),
    ):
        gcs = gcs_class.return_value
        gcs.download_from_gcs.side_effect = probe.record("/tmp/in.mp4")
        gcs.upload_file_to_gcs.return_value = "gs://bucket/out.mp4"
        _process_video_concatenation_in_background(
            media_item_id=1, request_dto=dto
        )

    assert len(probe.held_during_call) == 2
    probe.assert_released_and_completed()
