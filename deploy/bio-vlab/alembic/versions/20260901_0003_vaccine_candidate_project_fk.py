"""疫苗候选项目外键统一切换到虚拟实验室 research_projects（演练断点 BP-C12）

背景（CPV 全流程演练实测发现）：
    VaccineCandidate.project_id 原外键指向旧 projects 表，而疫苗候选的
    消费方（GET /vaccine/projects/{id}/candidates、湿实验订单包）均按
    虚拟实验室 research_projects.id 检索——项目身份不一致导致设计成功
    后落库外键违约（MySQL 1452，HTTP 500，IEDB 真实预测结果丢失）。

变更内容（与 20260901_0002 omics_assets 同一模式）：
    1. 既有遗留数据：project_id 指向旧 projects 的行统一置 NULL
       （降级为平台级全局候选，admin 仍可管理）；
    2. 删除旧外键 vaccine_candidates_ibfk_1（→ projects.id，Alembic 建表
       自动命名，回滚时按实际约束名重建）；
    3. 新建外键 fk_vaccine_candidates_project_id 指向 research_projects.id
       （ON DELETE CASCADE）。

回滚策略：
    反向执行（删新外键 → 恢复旧外键指向 projects.id）；
    已置 NULL 的 project_id 历史值不可自动还原。
"""

from typing import Sequence, Union

from alembic import op
from sqlalchemy import text


# revision identifiers, used by Alembic.
revision: str = "20260901_0003"
down_revision: Union[str, None] = "20260901_0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _existing_fk_name(referenced_table: str) -> str | None:
    """查询 vaccine_candidates.project_id 当前指向指定表的外键约束名

    Alembic 建表生成的约束名（ibfk_N）与环境相关，须动态探测后删除，
    避免硬编码约束名在部分环境失效。
    """
    conn = op.get_bind()
    row = conn.execute(
        text(
            "SELECT constraint_name FROM information_schema.key_column_usage "
            "WHERE table_schema = DATABASE() AND table_name = 'vaccine_candidates' "
            "AND column_name = 'project_id' AND referenced_table_name = :ref_table"
        ),
        {"ref_table": referenced_table},
    ).fetchone()
    return row[0] if row else None


def upgrade() -> None:
    """外键切换：projects.id → research_projects.id（含遗留数据降级）"""
    # 幂等守卫（2026-10-07 alembic 接入改造补）：外键已指向
    # research_projects 说明本迁移已执行过（旧库曾手工应用/重放场景），
    # 跳过避免 MySQL 1826 重复约束名错误，保证可安全重放
    if _existing_fk_name("research_projects") is not None:
        return
    # 1. 遗留行降级为全局候选（project_id=NULL），避免外键切换后悬挂
    op.execute(
        "UPDATE vaccine_candidates SET project_id = NULL "
        "WHERE project_id IS NOT NULL AND project_id NOT IN "
        "(SELECT id FROM research_projects)"
    )
    # 2. 删除指向旧 projects 表的外键（约束名动态探测）
    legacy_fk = _existing_fk_name("projects")
    if legacy_fk is not None:
        op.drop_constraint(legacy_fk, "vaccine_candidates", type_="foreignkey")
    # 3. 新建指向 research_projects 的外键（级联删除）
    op.create_foreign_key(
        "fk_vaccine_candidates_project_id",
        "vaccine_candidates",
        "research_projects",
        ["project_id"],
        ["id"],
        ondelete="CASCADE",
    )


def downgrade() -> None:
    """回滚：外键恢复指向旧 projects.id（不还原已置 NULL 的历史值）"""
    op.drop_constraint(
        "fk_vaccine_candidates_project_id", "vaccine_candidates",
        type_="foreignkey",
    )
    op.create_foreign_key(
        "fk_vaccine_candidates_project_id",
        "vaccine_candidates",
        "projects",
        ["project_id"],
        ["id"],
        ondelete="CASCADE",
    )
