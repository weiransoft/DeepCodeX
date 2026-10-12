"""组学资产项目外键统一切换到虚拟实验室 research_projects（演练断点 BP-C12）

背景（CPV 全流程演练实测发现）：
    OmicsAsset.project_id 原外键指向旧 projects 表，而组学证据回流链路
    （core/virtual_lab/omics_integration.py 的 generate_omics_evidence_report）
    按虚拟实验室 research_projects.id 查询资产——两套项目身份不一致，
    导致虚拟实验室项目挂组学资产时违反外键约束
    （MySQL OperationalError 1452，HTTP 500）。

变更内容：
    1. 既有遗留数据：project_id 指向旧 projects 的行统一置 NULL
       （降级为平台级全局资产，不丢弃资产数据，admin 仍可管理）；
    2. 删除旧外键 fk_omics_assets_project_id（→ projects.id）；
    3. 新建同名外键指向 research_projects.id（ON DELETE CASCADE，
       研究项目删除时级联清理组学资产，与虚拟实验室子资源语义一致）。

回滚策略：
    反向执行（删新外键 → 恢复旧外键指向 projects.id）；已置 NULL 的
    project_id 历史值不可自动还原（旧 projects 行仍在时可按业务重挂）。
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "20260901_0002"
down_revision: Union[str, None] = "20260901_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """外键切换：projects.id → research_projects.id（含遗留数据降级）"""
    # 幂等守卫（2026-10-07 alembic 接入改造补）：外键已指向
    # research_projects 说明本迁移已执行过，跳过，保证可安全重放
    conn = op.get_bind()
    current_ref = conn.execute(
        sa.text(
            "SELECT referenced_table_name FROM information_schema.key_column_usage "
            "WHERE table_schema = DATABASE() AND table_name = 'omics_assets' "
            "AND column_name = 'project_id' "
            "AND referenced_table_name IS NOT NULL"
        )
    ).scalar()
    if current_ref == "research_projects":
        return
    # 1. 遗留行降级为全局资产（project_id=NULL），避免删外键前数据悬挂
    op.execute(
        "UPDATE omics_assets SET project_id = NULL "
        "WHERE project_id IS NOT NULL AND project_id NOT IN "
        "(SELECT id FROM research_projects)"
    )
    # 2. 删除指向旧 projects 表的外键
    op.drop_constraint(
        "fk_omics_assets_project_id", "omics_assets", type_="foreignkey",
    )
    # 3. 新建指向 research_projects 的外键（级联删除）
    op.create_foreign_key(
        "fk_omics_assets_project_id",
        "omics_assets",
        "research_projects",
        ["project_id"],
        ["id"],
        ondelete="CASCADE",
    )


def downgrade() -> None:
    """回滚：外键恢复指向旧 projects.id（不还原已置 NULL 的历史值）"""
    op.drop_constraint(
        "fk_omics_assets_project_id", "omics_assets", type_="foreignkey",
    )
    op.create_foreign_key(
        "fk_omics_assets_project_id",
        "omics_assets",
        "projects",
        ["project_id"],
        ["id"],
        ondelete="CASCADE",
    )
