"""add artifact visibility contract columns (P0-5-b)

Revision ID: 20260707_0001
Revises: 20260706_0001
Create Date: 2026-07-07 00:00:00.000000

新增 workflow_artifacts 表的可见性契约字段（P0-5-b 私有草稿区 → 显式发布）：

- is_published：是否已发布（False=私有草稿，True=正式交付物）
  * server_default='1'：迁移时现有记录全部标记为已发布，保持向后兼容
    （现有产出物在引入可见性契约前就是可见的，不应因迁移而消失）
  * 服务层 register_artifact 默认 is_published=True（向后兼容现有调用方）
  * list_workflow_artifacts 默认 include_unpublished=False（只返回已发布产出物）

- published_at：发布时间（is_published=True 时设置，NULL 表示未发布）

- published_by：发布人用户 ID（外键 → users.id，ON DELETE SET NULL）
  * 与 uploaded_by 区分：uploaded_by 是上传者，published_by 是发布者
  * 自动产出的产出物 uploaded_by 可能为 NULL，但发布时 published_by 应设置

设计说明（架构师审查 P0-1 修复）：
  复用 current_version_id 表达"当前已发布版本"，不新增 latest_version_id 字段。
  is_published 只控制"是否对外可见"，current_version_id 控制"当前版本指针"，
  两者正交：一个产出物可以有多个版本，但只有 is_published=True 的才出现在默认列表中。

注意事项：
1. alembic env.py 已绑定 Base.metadata + settings.database_url
2. MySQL 8 默认 utf8mb4 / utf8mb4_unicode_ci，无需显式声明
3. TIMESTAMP(3) 保留毫秒精度，与现有模型一致
4. server_default 使用 sa.text("1") 而非 sa.false()，确保 MySQL 兼容
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql


# revision identifiers, used by Alembic.
revision: str = "20260707_0001"
down_revision: Union[str, None] = "20260706_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """添加 workflow_artifacts 表的可见性契约字段（P0-5-b）"""
    # 幂等守卫（2026-10-07 alembic 接入改造补）：init_db() create_all
    # 可能已预建 is_published 列，已存在则整体跳过，保证迁移可安全重放
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing_cols = {c["name"] for c in inspector.get_columns("workflow_artifacts")}
    if "is_published" in existing_cols:
        return

    # -----------------------------------------------------------------------
    # 1. is_published - 是否已发布（NOT NULL，server_default='1' 保证现有记录为已发布）
    # -----------------------------------------------------------------------
    # 设计说明：server_default='1' 是关键——迁移前已存在的产出物必须保持可见，
    # 否则 list_workflow_artifacts 默认查询（include_unpublished=False）会返回空列表，
    # 破坏所有依赖产出物列表的现有功能。
    op.add_column(
        "workflow_artifacts",
        sa.Column(
            "is_published",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("1"),
            comment="是否已发布（False=私有草稿，True=正式交付物）",
        ),
    )

    # -----------------------------------------------------------------------
    # 2. published_at - 发布时间（nullable，未发布时为 NULL）
    # -----------------------------------------------------------------------
    op.add_column(
        "workflow_artifacts",
        sa.Column(
            "published_at",
            mysql.TIMESTAMP(fsp=3),
            nullable=True,
            comment="发布时间（is_published=True 时设置）",
        ),
    )

    # -----------------------------------------------------------------------
    # 3. published_by - 发布人用户 ID（nullable，外键 → users.id）
    # -----------------------------------------------------------------------
    op.add_column(
        "workflow_artifacts",
        sa.Column(
            "published_by",
            sa.String(length=36),
            nullable=True,
            comment="发布人用户 ID（is_published=True 时设置）",
        ),
    )
    # 外键约束：published_by → users.id（ON DELETE SET NULL，用户删除时保留发布记录）
    op.create_foreign_key(
        "fk_workflow_artifacts_published_by",
        "workflow_artifacts",
        "users",
        ["published_by"],
        ["id"],
        ondelete="SET NULL",
    )

    # -----------------------------------------------------------------------
    # 4. 数据迁移：为现有已发布产出物回填 published_at（使用 created_at 作为近似值）
    # -----------------------------------------------------------------------
    # 现有记录的 is_published 已通过 server_default='1' 设为 True，
    # 但 published_at 为 NULL。使用 created_at 作为 published_at 的近似值，
    # 保证 published_at 字段在已发布产出物上非空（便于按发布时间排序/过滤）。
    op.execute(
        "UPDATE workflow_artifacts SET published_at = created_at "
        "WHERE is_published = 1 AND published_at IS NULL"
    )


def downgrade() -> None:
    """回滚：删除 workflow_artifacts 表的可见性契约字段"""
    # 1. 先删 published_by 的外键约束
    op.drop_constraint(
        "fk_workflow_artifacts_published_by",
        "workflow_artifacts",
        type_="foreignkey",
    )
    # 2. 删除 3 个字段（按添加的逆序删除）
    op.drop_column("workflow_artifacts", "published_by")
    op.drop_column("workflow_artifacts", "published_at")
    op.drop_column("workflow_artifacts", "is_published")
