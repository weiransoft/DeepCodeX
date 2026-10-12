"""add workflow_artifacts and workflow_results tables

Revision ID: 20260703_0001
Revises:
Create Date: 2026-07-03 00:00:00.000000

新增两张表用于替代 scminer.tech 外链方案：

- workflow_artifacts：工作流产出物元数据表
  * 二进制文件统一存储到 MinIO bio-workflows 桶，本表只存元数据
  * 同时支持 local_path（开发回退模式）
  * workflow_node_id 可空（支持工作流级全局产出物）
  * artifact_type 用于前端图标 / 渲染策略选择

- workflow_results：工作流结构化结果表（数值指标 / 候选分子）
  * payload 字段统一 JSON 存储 ResultMetric[] 或 Candidate[]
  * 通过 result_type 区分指标与候选分子
  * 节点删除时置空（结构化结果可独立保留以供回溯）

涉及的外键：
- workflow_id → workflows.id（ON DELETE CASCADE）
- workflow_node_id → workflow_nodes.id（ON DELETE SET NULL）
- uploaded_by → users.id（ON DELETE SET NULL）

注意事项：
1. alembic env.py 已绑定 Base.metadata + settings.database_url
2. MySQL 8 默认 utf8mb4 / utf8mb4_unicode_ci，无需显式声明
3. TIMESTAMP(3) 保留毫秒精度，与现有模型一致
4. LONGBLOB/LONGTEXT 已在 models/__init__.py 顶层 import，本迁移不需要
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql


# revision identifiers, used by Alembic.
revision: str = "20260703_0001"
# 接入 alembic 正式版本链（2026-10-07 alembic 接入改造补）：
# down_revision 由 None 指向 20261007_00001（空 baseline 锚点），
# 使本历史增量成为 baseline 之后的链上第一环。
# 【重要】历史子链仅作"已发生历史"的档案记录，**不作为新库升级
# 路径**——真库/空库实测子链首步即 1824（依赖 create_all 预建的
# workflows 等基表），详见 20261007_00001/00002 头注释。
down_revision: Union[str, None] = "20261007_00001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """创建 workflow_artifacts 和 workflow_results 两张表 + 索引"""
    # 幂等守卫（2026-10-07 alembic 接入改造补）：init_db() create_all
    # 可能已预建本表，已存在则整体跳过，保证迁移可安全重放
    inspector = sa.inspect(op.get_bind())
    if inspector.has_table("workflow_artifacts") and inspector.has_table("workflow_results"):
        return
    # -----------------------------------------------------------------------
    # 1. workflow_artifacts - 工作流产出物元数据表
    # -----------------------------------------------------------------------
    op.create_table(
        "workflow_artifacts",
        sa.Column("id", sa.String(length=36), nullable=False, comment="UUID 主键"),
        sa.Column("workflow_id", sa.String(length=36), nullable=False, comment="所属工作流"),
        sa.Column(
            "workflow_node_id",
            sa.String(length=36),
            nullable=True,
            comment="所属工作流节点（可空，表示工作流级产出物）",
        ),
        sa.Column("name", sa.String(length=255), nullable=False, comment="原始文件名"),
        sa.Column(
            "storage_type",
            sa.String(length=20),
            nullable=False,
            server_default="minio",
            comment="存储类型：minio / local",
        ),
        sa.Column("bucket", sa.String(length=100), nullable=True, comment="MinIO 桶名"),
        sa.Column("object_key", sa.String(length=500), nullable=True, comment="MinIO 对象 key"),
        sa.Column("local_path", sa.String(length=500), nullable=True, comment="本地存储路径"),
        sa.Column(
            "size_bytes",
            sa.BigInteger(),
            nullable=False,
            server_default="0",
            comment="文件大小（字节）",
        ),
        sa.Column("mime_type", sa.String(length=100), nullable=True, comment="MIME 类型"),
        sa.Column(
            "artifact_type",
            sa.String(length=50),
            nullable=False,
            comment="产出物类型：pdb / sdf / csv / json / png / txt / log / pdf / other",
        ),
        sa.Column("description", sa.Text(), nullable=True, comment="业务描述"),
        sa.Column(
            "uploaded_by",
            sa.String(length=36),
            nullable=True,
            comment="上传人（自动产出时为 NULL）",
        ),
        sa.Column(
            "created_at",
            mysql.TIMESTAMP(fsp=3),
            server_default=sa.text("CURRENT_TIMESTAMP(3)"),
            nullable=False,
            comment="创建时间",
        ),
        # 主键约束
        sa.PrimaryKeyConstraint("id", name="pk_workflow_artifacts"),
        # 外键约束
        sa.ForeignKeyConstraint(
            ["workflow_id"],
            ["workflows.id"],
            name="fk_workflow_artifacts_workflow_id",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["workflow_node_id"],
            ["workflow_nodes.id"],
            name="fk_workflow_artifacts_node_id",
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["uploaded_by"],
            ["users.id"],
            name="fk_workflow_artifacts_uploaded_by",
            ondelete="SET NULL",
        ),
        # 表选项
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
        comment="工作流产出物元数据表（2026-07-03 新增）",
    )

    # workflow_artifacts 索引
    op.create_index(
        "ix_workflow_artifacts_workflow_id",
        "workflow_artifacts",
        ["workflow_id"],
    )
    op.create_index(
        "ix_workflow_artifacts_node_id",
        "workflow_artifacts",
        ["workflow_node_id"],
    )
    op.create_index(
        "ix_workflow_artifacts_type",
        "workflow_artifacts",
        ["artifact_type"],
    )
    op.create_index(
        "ix_workflow_artifacts_workflow_type",
        "workflow_artifacts",
        ["workflow_id", "artifact_type"],
    )

    # -----------------------------------------------------------------------
    # 2. workflow_results - 工作流结构化结果表
    # -----------------------------------------------------------------------
    op.create_table(
        "workflow_results",
        sa.Column("id", sa.String(length=36), nullable=False, comment="UUID 主键"),
        sa.Column("workflow_id", sa.String(length=36), nullable=False, comment="所属工作流"),
        sa.Column(
            "workflow_node_id",
            sa.String(length=36),
            nullable=True,
            comment="所属工作流节点（可空，表示工作流级结果）",
        ),
        sa.Column(
            "result_type",
            sa.String(length=50),
            nullable=False,
            comment="结果类型：metrics / candidates",
        ),
        sa.Column(
            "payload",
            sa.JSON(),
            nullable=False,
            comment="结果载荷（JSON 数组）",
        ),
        sa.Column("description", sa.Text(), nullable=True, comment="业务描述"),
        sa.Column(
            "created_at",
            mysql.TIMESTAMP(fsp=3),
            server_default=sa.text("CURRENT_TIMESTAMP(3)"),
            nullable=False,
            comment="创建时间",
        ),
        # 主键约束
        sa.PrimaryKeyConstraint("id", name="pk_workflow_results"),
        # 外键约束
        sa.ForeignKeyConstraint(
            ["workflow_id"],
            ["workflows.id"],
            name="fk_workflow_results_workflow_id",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["workflow_node_id"],
            ["workflow_nodes.id"],
            name="fk_workflow_results_node_id",
            ondelete="SET NULL",
        ),
        # 表选项
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
        comment="工作流结构化结果表（2026-07-03 新增）",
    )

    # workflow_results 索引
    op.create_index(
        "ix_workflow_results_workflow_id",
        "workflow_results",
        ["workflow_id"],
    )
    op.create_index(
        "ix_workflow_results_node_id",
        "workflow_results",
        ["workflow_node_id"],
    )
    op.create_index(
        "ix_workflow_results_type",
        "workflow_results",
        ["result_type"],
    )
    op.create_index(
        "ix_workflow_results_workflow_type",
        "workflow_results",
        ["workflow_id", "result_type"],
    )


def downgrade() -> None:
    """回滚：删除 workflow_results 和 workflow_artifacts 两张表"""
    # workflow_results 先删（依赖 workflow_artifacts 顺序无关，但保持创建顺序反向）
    op.drop_index("ix_workflow_results_workflow_type", table_name="workflow_results")
    op.drop_index("ix_workflow_results_type", table_name="workflow_results")
    op.drop_index("ix_workflow_results_node_id", table_name="workflow_results")
    op.drop_index("ix_workflow_results_workflow_id", table_name="workflow_results")
    op.drop_table("workflow_results")

    op.drop_index("ix_workflow_artifacts_workflow_type", table_name="workflow_artifacts")
    op.drop_index("ix_workflow_artifacts_type", table_name="workflow_artifacts")
    op.drop_index("ix_workflow_artifacts_node_id", table_name="workflow_artifacts")
    op.drop_index("ix_workflow_artifacts_workflow_id", table_name="workflow_artifacts")
    op.drop_table("workflow_artifacts")
