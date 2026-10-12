"""Binder 设计落库表 binder_designs（BINDER-DESIGN-PIPELINE-PLAN §2.2）

背景（binder 设计管线整合，design/BINDER-DESIGN-PIPELINE-PLAN.md）：
    平台已有 BindCraft/FreeBindCraft/RFdiffusion/ProteinMPNN/Chai-1 工具
    但无端到端 binder 设计链路与落库。本迁移新建 binder_designs 表，
    承接 POST /api/v1/binder/design 端点"兼容矩阵预检 → 骨架生成降级链
    → ProteinMPNN 序列 → Chai-1 独立复折叠 → 过滤排名 → 三角色评审"
    管线结果的持久化登记（一次设计运行 = 一行，异步作业模式）。

变更内容：
    新建 binder_designs 表（列定义与 models.BinderDesign 逐列一致，
    业务 ID 主键 bnd-+uuid4hex[:8]）与四个检索索引：
    project_id / composite_score / created_by / created_at。
    外键均 SET NULL：项目删除时设计保留归属置空（设计资产不随项目
    删除，抗体/引物表同口径），用户删除时设计保留发起人置空（审计口径）。
    updated_at 列（onupdate CURRENT_TIMESTAMP(3)）承担 running 孤儿
    TTL 判定（后台作业进程重启中断如实标 failed）。

防御说明：
    应用启动 init_db() 的 create_all 可能已先建出本表（开发环境常见），
    upgrade 前用 inspector.has_table 检查，已存在则整体跳过，避免
    create_table 冲突导致迁移链中断。

回滚策略：
    生产红线——严禁对生产 MySQL 执行任何 DROP TABLE。downgrade 有意
    不执行删除，仅抛异常提示人工评估（本表承载设计资产，回滚需运维
    确认数据迁移方案后手工操作）。
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql


# revision identifiers, used by Alembic.
revision: str = "20260922_0001"
down_revision: Union[str, None] = "20260921_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """新建 binder_designs 表 + 四个检索索引（has_table 幂等防御）"""
    # init_db() create_all 可能已在启动时建表：已存在则跳过，保证迁移可安全重放
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if inspector.has_table("binder_designs"):
        return

    op.create_table(
        "binder_designs",
        # 业务设计 ID 主键（bnd- + uuid4 前 8 位，应用侧生成）
        sa.Column("id", sa.String(length=36), nullable=False,
                  comment="业务设计 ID（bnd- + uuid4 前 8 位）"),
        sa.Column("project_id", sa.String(length=36), nullable=True,
                  comment="所属研究项目 ID（NULL=全局设计）"),
        sa.Column("created_by", sa.String(length=36), nullable=True,
                  comment="发起人用户 ID"),
        sa.Column("target_digest", mysql.JSON(), nullable=False,
                  comment="靶点摘要（sha256/长度/来源/链）"),
        sa.Column("target_pdb", mysql.LONGTEXT(), nullable=False,
                  comment="靶点 PDB 原文（可复现必需）"),
        sa.Column("request_parameters", mysql.JSON(), nullable=False,
                  comment="设计请求全部参数（可复现）"),
        sa.Column("preflight", mysql.JSON(), nullable=False,
                  comment="兼容矩阵+backend_plan 预检结果"),
        sa.Column("design_result", mysql.JSON(), nullable=True,
                  comment="binder 候选全量证据（running 期增量更新）"),
        sa.Column("agent_review", mysql.JSON(), nullable=True,
                  comment="三角色智能体评审（NULL=未执行）"),
        sa.Column("composite_score", sa.Numeric(precision=6, scale=4),
                  nullable=True, comment="top1 候选综合评分 [0,1]（NULL=未评价）"),
        sa.Column("pipeline_status", sa.String(length=32), nullable=False,
                  comment="管线状态：running/completed/structure_degraded/review_degraded/partial/failed"),
        sa.Column("created_at", mysql.TIMESTAMP(fsp=3),
                  server_default=sa.text("CURRENT_TIMESTAMP(3)"), nullable=True,
                  comment="创建时间"),
        sa.Column("updated_at", mysql.TIMESTAMP(fsp=3),
                  server_default=sa.text("CURRENT_TIMESTAMP(3)"), nullable=True,
                  comment="更新时间（running 孤儿 TTL 判定依据）"),
        sa.ForeignKeyConstraint(["project_id"], ["research_projects.id"],
                                name="fk_binder_designs_project_id_research_projects",
                                ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"],
                                name="fk_binder_designs_created_by_users",
                                ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id",
                                name="pk_binder_designs"),
        comment="Binder 设计表（兼容矩阵预检→骨架降级链→MPNN 序列→Chai-1 复折叠→排名→评审管线结果持久化）",
    )
    # 检索索引：命名与 models.BinderDesign.__table_args__ 逐一对应
    op.create_index("ix_binder_designs_project_id", "binder_designs", ["project_id"])
    op.create_index("ix_binder_designs_composite_score", "binder_designs", ["composite_score"])
    op.create_index("ix_binder_designs_created_by", "binder_designs", ["created_by"])
    op.create_index("ix_binder_designs_created_at", "binder_designs", ["created_at"])


def downgrade() -> None:
    """生产红线：严禁 DROP TABLE——回滚有意不执行，需人工评估后手工操作"""
    raise RuntimeError(
        "binder_designs 承载 binder 设计资产，按生产红线禁止自动 DROP TABLE；"
        "如确需回滚，请运维确认数据迁移方案后手工处理，并将版本标记回退。"
    )
