"""引物探针设计落库表 primer_designs（多序列保守区引物探针设计工作流 §5.2）

背景（引物探针设计工作流，docs/Primer-Probe-Design-Workflow-Plan.md）：
    平台缺少"给定一组同源核酸序列，在保守区内设计 qPCR 引物对 + 水解
    探针"的能力。本迁移新建 primer_designs 表，承接
    POST /api/v1/primer/design 端点"MSA+保守区分析 → primer3-py 引物
    搜索 → in-silico 覆盖验证 → 三角色智能体评审 → composite_score
    加权"管线结果的持久化登记（一次设计请求 = 一行）。

变更内容：
    新建 primer_designs 表（列定义与 models.PrimerDesign 逐列一致，
    业务 ID 主键 prd-+uuid4hex[:8]）与四个检索索引：
    project_id / composite_score / created_by / created_at。
    外键均 SET NULL：项目删除时设计保留归属置空（设计资产不随项目
    删除，抗体表 D5 同口径），用户删除时设计保留发起人置空（审计口径）。

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
revision: str = "20260920_0001"
down_revision: Union[str, None] = "20260917_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """新建 primer_designs 表 + 四个检索索引（has_table 幂等防御）"""
    # init_db() create_all 可能已在启动时建表：已存在则跳过，保证迁移可安全重放
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if inspector.has_table("primer_designs"):
        return

    op.create_table(
        "primer_designs",
        # 业务设计 ID 主键（prd- + uuid4 前 8 位，应用侧生成）
        sa.Column("id", sa.String(length=36), nullable=False,
                  comment="业务设计 ID（prd- + uuid4 前 8 位）"),
        sa.Column("project_id", sa.String(length=36), nullable=True,
                  comment="所属虚拟实验室研究项目 ID（NULL=全局设计）"),
        sa.Column("created_by", sa.String(length=36), nullable=True,
                  comment="发起人用户 ID"),
        sa.Column("input_sequences_digest", mysql.JSON(), nullable=False,
                  comment="输入序列集摘要（count/total_length/per_sequence sha256）"),
        sa.Column("input_fasta", mysql.LONGTEXT(), nullable=False,
                  comment="输入多序列 FASTA 原文（覆盖验证与可复现必需）"),
        sa.Column("design_parameters", mysql.JSON(), nullable=False,
                  comment="本次设计全部生效参数（可复现）"),
        sa.Column("conservation_analysis", mysql.JSON(), nullable=True,
                  comment="MSA+保守区分析结果（含显式 status，NULL=未执行）"),
        sa.Column("design_result", mysql.JSON(), nullable=False,
                  comment="引物对/探针候选全量（含 coverage 子记录）"),
        sa.Column("agent_review", mysql.JSON(), nullable=True,
                  comment="三角色智能体评审结果（含显式 status，NULL=未执行）"),
        sa.Column("composite_score", sa.Numeric(precision=6, scale=4),
                  nullable=True, comment="综合评分 [0,1]（三源加权，NULL=未评价）"),
        sa.Column("pipeline_status", sa.String(length=32), nullable=False,
                  comment="管线状态：complete/conservation_degraded/review_degraded/degraded"),
        sa.Column("status", sa.String(length=32), nullable=False,
                  comment="状态：designed/conservation_analyzed/reviewed"),
        sa.Column("created_at", mysql.TIMESTAMP(fsp=3),
                  server_default=sa.text("CURRENT_TIMESTAMP(3)"), nullable=True,
                  comment="创建时间"),
        sa.ForeignKeyConstraint(["project_id"], ["research_projects.id"],
                                name="fk_primer_designs_project_id_research_projects",
                                ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"],
                                name="fk_primer_designs_created_by_users",
                                ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id",
                                name="pk_primer_designs"),
        comment="引物探针设计表（保守区分析→引物搜索→覆盖验证→智能体评审管线结果持久化）",
    )
    # 检索索引：命名与 models.PrimerDesign.__table_args__ 逐一对应
    op.create_index("ix_primer_designs_project_id", "primer_designs", ["project_id"])
    op.create_index("ix_primer_designs_composite_score", "primer_designs", ["composite_score"])
    op.create_index("ix_primer_designs_created_by", "primer_designs", ["created_by"])
    op.create_index("ix_primer_designs_created_at", "primer_designs", ["created_at"])


def downgrade() -> None:
    """生产红线：严禁 DROP TABLE——回滚有意不执行，需人工评估后手工操作"""
    raise RuntimeError(
        "primer_designs 承载引物探针设计资产，按生产红线禁止自动 DROP TABLE；"
        "如确需回滚，请运维确认数据迁移方案后手工处理，并将版本标记回退。"
    )
