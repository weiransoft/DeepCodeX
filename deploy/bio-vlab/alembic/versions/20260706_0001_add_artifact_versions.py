"""add artifact_versions table for versioned lineage (P0-5-c)

Revision ID: 20260706_0001
Revises: 20260703_0001
Create Date: 2026-07-06 00:00:00.000000

新增 artifact_versions 表，实现产出物版本化血缘（P0-5-c）：

- artifact_versions：产出物版本表
  * 每个 WorkflowArtifact 可有多个版本，通过 parent_version_id 形成血缘 DAG
  * content_hash（SHA256）用于检测内容是否真正变化，避免空版本
  * is_stale 标记：上游版本变更后，所有下游版本递归标记为 stale
  * version_number 在同一 artifact 内部递增，通过唯一约束保证不重复
  * storage_path 复用 WorkflowArtifact 的 object_key/local_path 模式

- workflow_artifacts.current_version_id：新增字段，指向当前版本
  * 使用 use_alter=True 避免循环依赖（artifact_versions.artifact_id → workflow_artifacts.id，
    workflow_artifacts.current_version_id → artifact_versions.id）

涉及的外键：
- artifact_id → workflow_artifacts.id（ON DELETE CASCADE）
- parent_version_id → artifact_versions.id（ON DELETE SET NULL，自引用）
- created_by → users.id（ON DELETE SET NULL）
- current_version_id → artifact_versions.id（ON DELETE SET NULL，use_alter）

注意事项：
1. alembic env.py 已绑定 Base.metadata + settings.database_url
2. MySQL 8 默认 utf8mb4 / utf8mb4_unicode_ci，无需显式声明
3. TIMESTAMP(3) 保留毫秒精度，与现有模型一致
4. 循环依赖通过 use_alter=True 处理，迁移顺序：先建 artifact_versions 表，再加 current_version_id 字段
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql


# revision identifiers, used by Alembic.
revision: str = "20260706_0001"
down_revision: Union[str, None] = "20260703_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """创建 artifact_versions 表 + 添加 workflow_artifacts.current_version_id 字段"""
    # 幂等守卫（2026-10-07 alembic 接入改造补）：init_db() create_all
    # 可能已预建本表，已存在则整体跳过，保证迁移可安全重放
    inspector = sa.inspect(op.get_bind())
    if inspector.has_table("artifact_versions"):
        return

    # -----------------------------------------------------------------------
    # 1. artifact_versions - 产出物版本表（P0-5-c 版本化血缘）
    # -----------------------------------------------------------------------
    op.create_table(
        "artifact_versions",
        sa.Column("id", sa.String(length=36), nullable=False, comment="UUID 主键"),
        sa.Column("artifact_id", sa.String(length=36), nullable=False, comment="所属产出物 ID"),
        sa.Column("version_number", sa.Integer(), nullable=False, comment="版本号（同一 artifact 内递增）"),
        sa.Column("parent_version_id", sa.String(length=36), nullable=True, comment="父版本 ID（血缘 DAG，NULL 表示初始版本）"),
        sa.Column("content_hash", sa.String(length=64), nullable=False, comment="内容 SHA256 哈希"),
        sa.Column("storage_path", sa.String(length=500), nullable=False, comment="存储路径（object_key 或 local_path）"),
        sa.Column("is_stale", sa.Boolean(), nullable=False, server_default=sa.text("0"), comment="是否过期（上游变更后标记）"),
        sa.Column("metadata_json", sa.JSON(), nullable=True, comment="版本元数据（JSON）"),
        sa.Column("created_by", sa.String(length=36), nullable=True, comment="创建人（自动产出时为 NULL）"),
        sa.Column(
            "created_at",
            mysql.TIMESTAMP(fsp=3),
            server_default=sa.text("CURRENT_TIMESTAMP(3)"),
            nullable=False,
            comment="创建时间",
        ),
        # 主键约束
        sa.PrimaryKeyConstraint("id", name="pk_artifact_versions"),
        # 外键约束
        sa.ForeignKeyConstraint(
            ["artifact_id"],
            ["workflow_artifacts.id"],
            name="fk_artifact_versions_artifact_id",
            ondelete="CASCADE",
        ),
        # 自引用外键：parent_version_id → artifact_versions.id
        sa.ForeignKeyConstraint(
            ["parent_version_id"],
            ["artifact_versions.id"],
            name="fk_artifact_versions_parent_id",
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["created_by"],
            ["users.id"],
            name="fk_artifact_versions_created_by",
            ondelete="SET NULL",
        ),
        # 唯一约束：同一 artifact 内 version_number 唯一
        sa.UniqueConstraint("artifact_id", "version_number", name="uq_artifact_version_number"),
        # 表选项
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
        comment="产出物版本表（P0-5-c 版本化血缘，2026-07-06 新增）",
    )

    # artifact_versions 索引
    op.create_index(
        "ix_artifact_versions_artifact_id",
        "artifact_versions",
        ["artifact_id"],
    )
    op.create_index(
        "ix_artifact_versions_parent_id",
        "artifact_versions",
        ["parent_version_id"],
    )
    op.create_index(
        "ix_artifact_versions_stale",
        "artifact_versions",
        ["is_stale"],
    )

    # -----------------------------------------------------------------------
    # 2. workflow_artifacts.current_version_id - 新增字段（指向当前版本）
    # -----------------------------------------------------------------------
    # 使用 use_alter=True 避免循环依赖（先建 artifact_versions 表，再加此字段）
    op.add_column(
        "workflow_artifacts",
        sa.Column(
            "current_version_id",
            sa.String(length=36),
            nullable=True,
            comment="当前版本 ID（P0-5-c 版本化血缘）",
        ),
    )
    op.create_foreign_key(
        "fk_workflow_artifacts_current_version",
        "workflow_artifacts",
        "artifact_versions",
        ["current_version_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    """回滚：删除 current_version_id 字段 + 删除 artifact_versions 表"""
    # 1. 先删 workflow_artifacts.current_version_id 的外键和字段
    op.drop_constraint(
        "fk_workflow_artifacts_current_version",
        "workflow_artifacts",
        type_="foreignkey",
    )
    op.drop_column("workflow_artifacts", "current_version_id")

    # 2. 删除 artifact_versions 索引
    op.drop_index("ix_artifact_versions_stale", table_name="artifact_versions")
    op.drop_index("ix_artifact_versions_parent_id", table_name="artifact_versions")
    op.drop_index("ix_artifact_versions_artifact_id", table_name="artifact_versions")

    # 3. 删除 artifact_versions 表
    op.drop_table("artifact_versions")
