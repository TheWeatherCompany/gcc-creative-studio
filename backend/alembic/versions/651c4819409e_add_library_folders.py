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

"""add_library_folders

Revision ID: 651c4819409e
Revises: d1e2f3a4b5c6
Create Date: 2026-09-23 00:00:00.000000

Squashes upstream's two library-folders migrations from
GoogleCloudPlatform/gcc-creative-studio#284 into one fork-owned revision:
d4e5f6a7b8c9 (create_folders_and_hierarchy) and e5f6a7b8c9d0
(enforce_unique_folder_names).

Why a fresh revision id instead of upstream's: upstream's d4e5f6a7b8c9
revises 7a8b9c0d1e2f, which exists only on upstream develop, and its view
reads develop-only columns (titles, descriptions, external_url). Reusing that
id re-parented onto our chain would, once develop's migrations are synced,
make Alembic treat every develop migration before it as already applied on a
database stamped at or past it, and skip them without error.

The folders DDL is identical to upstream's. The view is our current
definition from 4547b010ca1c (restore_tags_in_view) plus folder_id, added at
the same ordinal position in both UNION ALL branches.

When upstream's folder revisions arrive with a develop sync: their DDL is all
IF NOT EXISTS, so it no-ops against what this revision created, and their view
rebuild supersedes this one once the develop columns it reads exist. Join the
two heads with an Alembic merge revision; do not renumber or delete this one.

"""
from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "651c4819409e"
down_revision: Union[str, None] = "d1e2f3a4b5c6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. Create folders table
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS folders (
            id SERIAL PRIMARY KEY,
            workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            user_email VARCHAR NOT NULL,
            name VARCHAR(255) NOT NULL,
            parent_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
            color VARCHAR(32) DEFAULT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            deleted_at TIMESTAMPTZ DEFAULT NULL,
            deleted_by INTEGER REFERENCES users(id) ON DELETE SET NULL
        );
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_folders_workspace_parent 
        ON folders(workspace_id, parent_id) 
        WHERE deleted_at IS NULL;
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_folders_workspace_id 
        ON folders(workspace_id);
        """
    )

    # 2. Add folder_id to media_items and source_assets
    op.execute(
        """
        ALTER TABLE media_items 
        ADD COLUMN IF NOT EXISTS folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL;
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_media_items_folder_id 
        ON media_items(folder_id) 
        WHERE deleted_at IS NULL;
        """
    )

    op.execute(
        """
        ALTER TABLE source_assets 
        ADD COLUMN IF NOT EXISTS folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL;
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_source_assets_folder_id 
        ON source_assets(folder_id) 
        WHERE deleted_at IS NULL;
        """
    )

    # 3. Update unified_gallery_view to include folder_id
    op.execute("DROP VIEW IF EXISTS unified_gallery_view;")
    op.execute(
        """
        CREATE VIEW unified_gallery_view AS
        WITH unified_base AS (
            SELECT
                mi.id,
                mi.workspace_id,
                mi.user_id,
                mi.folder_id,
                mi.created_at,
                'media_item'::text AS item_type,
                mi.status,
                mi.gcs_uris,
                mi.thumbnail_uris,
                mi.deleted_at,
                jsonb_build_object(
                    'model', mi.model,
                    'prompt', mi.prompt,
                    'original_prompt', mi.original_prompt,
                    'negative_prompt', mi.negative_prompt,
                    'aspect_ratio', mi.aspect_ratio,
                    'mime_type', mi.mime_type,
                    'style', mi.style,
                    'lighting', mi.lighting,
                    'num_media', mi.num_media,
                    'generation_time', mi.generation_time,
                    'is_video', (mi.mime_type like 'video%'),
                    'is_audio', (mi.mime_type like 'audio%'),
                    'tags', (
                        SELECT jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'color', t.color, 'workspace_id', t.workspace_id))
                        FROM media_item_tags mit
                        JOIN tags t ON mit.tag_id = t.id
                        WHERE mit.media_item_id = mi.id
                    )
                ) AS metadata
            FROM media_items mi
            UNION ALL
            SELECT
                sa.id,
                sa.workspace_id,
                sa.user_id,
                sa.folder_id,
                sa.created_at,
                'source_asset'::text AS item_type,
                'completed'::text AS status,
                ARRAY[sa.gcs_uri] AS gcs_uris,
                CASE
                    WHEN (sa.thumbnail_gcs_uri IS NOT NULL) THEN ARRAY[sa.thumbnail_gcs_uri]
                    ELSE '{}'::text[]
                END AS thumbnail_uris,
                sa.deleted_at,
                jsonb_build_object(
                    'original_filename', sa.original_filename,
                    'mime_type', sa.mime_type,
                    'aspect_ratio', sa.aspect_ratio,
                    'asset_type', sa.asset_type,
                    'is_video', (sa.mime_type like 'video%'),
                    'is_audio', (sa.mime_type like 'audio%'),
                    'tags', (
                        SELECT jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'color', t.color, 'workspace_id', t.workspace_id))
                        FROM source_asset_tags sat
                        JOIN tags t ON sat.tag_id = t.id
                        WHERE sat.source_asset_id = sa.id
                    )
                ) AS metadata
            FROM source_assets sa
        )
        SELECT 
            ub.*,
            w.name AS workspace_name,
            u.picture AS user_picture,
            u.email AS user_email
        FROM unified_base ub
        LEFT JOIN workspaces w ON ub.workspace_id = w.id
        LEFT JOIN users u ON ub.user_id = u.id;
        """
    )

    # 4. Disambiguate any existing duplicate active subfolder names (parent_id IS NOT NULL)
    op.execute(
        """
        WITH numbered_subfolders AS (
            SELECT 
                id, 
                name, 
                ROW_NUMBER() OVER (
                    PARTITION BY workspace_id, parent_id, LOWER(TRIM(name)) 
                    ORDER BY created_at ASC, id ASC
                ) AS rn
            FROM folders
            WHERE parent_id IS NOT NULL AND deleted_at IS NULL
        )
        UPDATE folders
        SET name = numbered_subfolders.name || ' (' || (numbered_subfolders.rn - 1) || ')'
        FROM numbered_subfolders
        WHERE folders.id = numbered_subfolders.id AND numbered_subfolders.rn > 1;
        """
    )

    # 5. Disambiguate any existing duplicate active root folder names (parent_id IS NULL)
    op.execute(
        """
        WITH numbered_root_folders AS (
            SELECT 
                id, 
                name, 
                ROW_NUMBER() OVER (
                    PARTITION BY workspace_id, LOWER(TRIM(name)) 
                    ORDER BY created_at ASC, id ASC
                ) AS rn
            FROM folders
            WHERE parent_id IS NULL AND deleted_at IS NULL
        )
        UPDATE folders
        SET name = numbered_root_folders.name || ' (' || (numbered_root_folders.rn - 1) || ')'
        FROM numbered_root_folders
        WHERE folders.id = numbered_root_folders.id AND numbered_root_folders.rn > 1;
        """
    )

    # 6. Create partial unique index for active subfolders
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_folders_workspace_parent_name_active
        ON folders (workspace_id, parent_id, LOWER(TRIM(name)))
        WHERE parent_id IS NOT NULL AND deleted_at IS NULL;
        """
    )

    # 7. Create partial unique index for active root folders
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_folders_workspace_root_name_active
        ON folders (workspace_id, LOWER(TRIM(name)))
        WHERE parent_id IS NULL AND deleted_at IS NULL;
        """
    )


def downgrade() -> None:
    # 1. Drop the partial unique indexes on active folder names
    op.execute("DROP INDEX IF EXISTS uq_folders_workspace_parent_name_active;")
    op.execute("DROP INDEX IF EXISTS uq_folders_workspace_root_name_active;")

    # 2. Restore previous unified_gallery_view (without folder_id)
    op.execute("DROP VIEW IF EXISTS unified_gallery_view;")
    op.execute(
        """
        CREATE VIEW unified_gallery_view AS
        WITH unified_base AS (
            SELECT
                mi.id,
                mi.workspace_id,
                mi.user_id,
                mi.created_at,
                'media_item'::text AS item_type,
                mi.status,
                mi.gcs_uris,
                mi.thumbnail_uris,
                mi.deleted_at,
                jsonb_build_object(
                    'model', mi.model,
                    'prompt', mi.prompt,
                    'original_prompt', mi.original_prompt,
                    'negative_prompt', mi.negative_prompt,
                    'aspect_ratio', mi.aspect_ratio,
                    'mime_type', mi.mime_type,
                    'style', mi.style,
                    'lighting', mi.lighting,
                    'num_media', mi.num_media,
                    'generation_time', mi.generation_time,
                    'is_video', (mi.mime_type like 'video%'),
                    'is_audio', (mi.mime_type like 'audio%'),
                    'tags', (
                        SELECT jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'color', t.color, 'workspace_id', t.workspace_id))
                        FROM media_item_tags mit
                        JOIN tags t ON mit.tag_id = t.id
                        WHERE mit.media_item_id = mi.id
                    )
                ) AS metadata
            FROM media_items mi
            UNION ALL
            SELECT
                sa.id,
                sa.workspace_id,
                sa.user_id,
                sa.created_at,
                'source_asset'::text AS item_type,
                'completed'::text AS status,
                ARRAY[sa.gcs_uri] AS gcs_uris,
                CASE
                    WHEN (sa.thumbnail_gcs_uri IS NOT NULL) THEN ARRAY[sa.thumbnail_gcs_uri]
                    ELSE '{}'::text[]
                END AS thumbnail_uris,
                sa.deleted_at,
                jsonb_build_object(
                    'original_filename', sa.original_filename,
                    'mime_type', sa.mime_type,
                    'aspect_ratio', sa.aspect_ratio,
                    'asset_type', sa.asset_type,
                    'is_video', (sa.mime_type like 'video%'),
                    'is_audio', (sa.mime_type like 'audio%'),
                    'tags', (
                        SELECT jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'color', t.color, 'workspace_id', t.workspace_id))
                        FROM source_asset_tags sat
                        JOIN tags t ON sat.tag_id = t.id
                        WHERE sat.source_asset_id = sa.id
                    )
                ) AS metadata
            FROM source_assets sa
        )
        SELECT 
            ub.*,
            w.name AS workspace_name,
            u.picture AS user_picture,
            u.email AS user_email
        FROM unified_base ub
        LEFT JOIN workspaces w ON ub.workspace_id = w.id
        LEFT JOIN users u ON ub.user_id = u.id;
        """
    )

    # 3. Drop folder_id columns and indexes
    op.execute("DROP INDEX IF EXISTS idx_media_items_folder_id;")
    op.execute("ALTER TABLE media_items DROP COLUMN IF EXISTS folder_id;")

    op.execute("DROP INDEX IF EXISTS idx_source_assets_folder_id;")
    op.execute("ALTER TABLE source_assets DROP COLUMN IF EXISTS folder_id;")

    # 4. Drop folders table
    op.execute("DROP TABLE IF EXISTS folders CASCADE;")
