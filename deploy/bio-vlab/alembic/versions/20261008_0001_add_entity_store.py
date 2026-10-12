"""新增 entity_store 表（P2.1 实体存储 · E2E-BUG-5 修复）

背景（2026-10-08 E2E 测试发现）：
    commit 5faef6c 重构时误删 backend/app/api/entity_store.py 与
    EntityStore 模型，但前端 lib/api/entity-store.ts（数据池离线同步、
    P3.2 模板市场）调用点仍在 → GET/POST /api/v1/entity-store* 全部 404，
    页面表现为"同步失败"徽标恒亮、模板市场空态报 404。

变更内容：
    CREATE TABLE entity_store（复合主键 {user_id}:{entity_type}:{entity_id}、
    data JSON、version 乐观锁、is_public/published_at 市场字段、
    fork_from_* 溯源字段）+ 3 个二级索引：
    - ix_entity_store_user_type：按用户+类型查询主路径
    - ix_entity_store_public：公开模板列表
    - ix_entity_store_updated：增量同步水位

防御说明：
    upgrade 前 inspector.has_table 检查（init_db() create_all 预建场景），
    已存在则跳过，保证幂等。

回滚策略：
    downgrade DROP TABLE entity_store（用户数据池/模板丢失，需谨慎）。
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.mysql import JSON, TIMESTAMP


# revision identifiers, used by Alembic.
revision: str = "20261008_0001"
# [D4 修复 2026-10-09] 原误挂在历史子链末端 20261004_0001 上，与全量建表版本
# 20261007_00002 形成双 head —— `alembic upgrade head` 抛 MultipleHeadsError，
# 破坏 run_migrations 的 stamp(head)+upgrade 接入流程（镜像内 alembic heads
# 实测 2 条 head 即此根因）。改挂 20261007_00002 之后恢复基线 docstring 声明
# 的单线拓扑；本版本 upgrade 自带 has_table 幂等守卫，存量库经 stamp head
# 接入后为 no-op，安全。
down_revision: Union[str, None] = "20261007_00002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if inspector.has_table("entity_store"):
        return

    op.create_table(
        "entity_store",
        sa.Column("id", sa.String(length=120), nullable=False,
                  comment="复合主键 {user_id}:{entity_type}:{entity_id}"),
        sa.Column("user_id", sa.String(length=36), nullable=False, comment="所属用户"),
        sa.Column("entity_type", sa.String(length=50), nullable=False,
                  comment="实体类型 gene/target/.../workflowTemplate"),
        sa.Column("entity_id", sa.String(length=100), nullable=False, comment="实体业务 ID"),
        sa.Column("data", JSON, nullable=False, comment="实体完整 JSON 数据"),
        sa.Column("version", sa.Integer(), nullable=True, comment="乐观锁版本（v1 暂不强校验）"),
        sa.Column("is_public", sa.Boolean(), nullable=True, comment="是否公开（仅 workflowTemplate 用）"),
        sa.Column("published_at", TIMESTAMP(3), nullable=True, comment="发布时间"),
        sa.Column("fork_from_id", sa.String(length=120), nullable=True, comment="导入自哪个公开模板"),
        sa.Column("fork_from_author", sa.String(length=100), nullable=True, comment="原作者（展示用）"),
        sa.Column("created_at", TIMESTAMP(3), server_default=sa.func.now(), nullable=True),
        sa.Column("updated_at", TIMESTAMP(3), server_default=sa.func.now(), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_entity_store_user_type", "entity_store", ["user_id", "entity_type"])
    op.create_index("ix_entity_store_public", "entity_store", ["is_public", "published_at"])
    op.create_index("ix_entity_store_updated", "entity_store", ["updated_at"])


def downgrade() -> None:
    op.drop_index("ix_entity_store_updated", table_name="entity_store")
    op.drop_index("ix_entity_store_public", table_name="entity_store")
    op.drop_index("ix_entity_store_user_type", table_name="entity_store")
    op.drop_table("entity_store")
