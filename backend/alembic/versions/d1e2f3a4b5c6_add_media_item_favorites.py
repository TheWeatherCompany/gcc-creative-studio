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

"""add media_item_favorites table

Revision ID: d1e2f3a4b5c6
Revises: cb3c4680571b
Create Date: 2026-08-31 00:00:00.000000

"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "d1e2f3a4b5c6"
down_revision: str | None = "cb3c4680571b"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "media_item_favorites",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("media_item_id", sa.Integer(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["media_item_id"], ["media_items.id"], ondelete="CASCADE"
        ),
        sa.UniqueConstraint(
            "user_id",
            "media_item_id",
            name="uq_media_item_favorite_user_item",
        ),
    )
    op.create_index(
        "ix_media_item_favorites_user_id",
        "media_item_favorites",
        ["user_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_media_item_favorites_user_id",
        table_name="media_item_favorites",
    )
    op.drop_table("media_item_favorites")
