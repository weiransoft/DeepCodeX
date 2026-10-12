"""抗体候选落库表 antibody_candidates（抗体工作流真实接入改造 §5.2）

背景（抗体工作流真实接入，docs/Antibody-Workflow-Integration-Plan.md）：
    抗体设计端点（POST /api/v1/antibody/design、
    POST /api/v1/antibody/affinity-mature）产出的候选此前仅存于进程内
    _candidate_store 字典，重启即丢；且候选未经结构预测模型验证与智能体
    评审。本迁移新建 antibody_candidates 表，承接"设计 → Chai-1 结构验证
    → 三角色智能体评审 → composite_score 加权"管线结果的持久化登记。

变更内容：
    新建 antibody_candidates 表（列定义与 models.AntibodyCandidate 逐列
    一致，业务 ID 主键 cand-+uuid4hex[:8]）与五个检索索引：
    project_id / framework_id / composite_score / created_by / created_at。
    外键均 SET NULL：项目删除时候选保留归属置空（设计资产不随项目删除），
    用户删除时候选保留发起人置空（审计口径）。

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
revision: str = "20260917_0001"
down_revision: Union[str, None] = "20260901_0007"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """新建 antibody_candidates 表 + 五个检索索引（has_table 幂等防御）"""
    # init_db() create_all 可能已在启动时建表：已存在则跳过，保证迁移可安全重放
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if inspector.has_table("antibody_candidates"):
        return

    op.create_table(
        "antibody_candidates",
        # 业务候选 ID 主键（cand- + uuid4 前 8 位，应用侧生成）
        sa.Column("id", sa.String(length=36), nullable=False,
                  comment="业务候选 ID（cand- + uuid4 前 8 位）"),
        sa.Column("project_id", sa.String(length=36), nullable=True,
                  comment="所属虚拟实验室研究项目 ID（NULL=全局候选）"),
        sa.Column("created_by", sa.String(length=36), nullable=True,
                  comment="发起人用户 ID"),
        sa.Column("target_sequence_digest", mysql.JSON(), nullable=False,
                  comment="抗原序列摘要（sha256 + 长度，不存抗原全序列）"),
        sa.Column("framework_id", sa.String(length=32), nullable=False,
                  comment="IMGT 框架编号（无来源时 n/a）"),
        sa.Column("antibody_type", sa.String(length=16), nullable=False,
                  comment="候选类型：full/scfv/fab/nanobody/derived"),
        sa.Column("sequence", mysql.LONGTEXT(), nullable=False,
                  comment="候选抗体全序列（氨基酸单字母码）"),
        sa.Column("cdr_lengths", mysql.JSON(), nullable=True,
                  comment="CDR 环长（cdr1/cdr2/cdr3，IMGT 口径）"),
        sa.Column("estimated_affinity_kd_nm", sa.Numeric(precision=12, scale=4),
                  nullable=True, comment="估算亲和常数 KD（nM，公式估算口径）"),
        sa.Column("mutations_applied", sa.Integer(), nullable=False,
                  comment="已引入突变数量"),
        sa.Column("developability", mysql.JSON(), nullable=True,
                  comment="可开发性评估（6 维得分 + 理化指标 + 警告）"),
        sa.Column("structure_validation", mysql.JSON(), nullable=True,
                  comment="Chai-1 结构验证结果（含显式 status，NULL=未执行）"),
        sa.Column("agent_review", mysql.JSON(), nullable=True,
                  comment="三角色智能体评审结果（含显式 status，NULL=未执行）"),
        sa.Column("composite_score", sa.Numeric(precision=6, scale=4),
                  nullable=True, comment="综合评分 [0,1]（三源加权，NULL=未评价）"),
        sa.Column("status", sa.String(length=20), nullable=False,
                  comment="状态：designed/structure_validated/reviewed"),
        sa.Column("created_at", mysql.TIMESTAMP(fsp=3),
                  server_default=sa.text("CURRENT_TIMESTAMP(3)"), nullable=True,
                  comment="创建时间"),
        sa.ForeignKeyConstraint(["project_id"], ["research_projects.id"],
                                name="fk_antibody_candidates_project_id_research_projects",
                                ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"],
                                name="fk_antibody_candidates_created_by_users",
                                ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id",
                                name="pk_antibody_candidates"),
        comment="抗体候选设计表（设计→结构验证→智能体评审管线结果持久化）",
    )
    # 检索索引：命名与 models.AntibodyCandidate.__table_args__ 逐一对应
    op.create_index("ix_antibody_candidates_project_id", "antibody_candidates", ["project_id"])
    op.create_index("ix_antibody_candidates_framework_id", "antibody_candidates", ["framework_id"])
    op.create_index("ix_antibody_candidates_composite_score", "antibody_candidates", ["composite_score"])
    op.create_index("ix_antibody_candidates_created_by", "antibody_candidates", ["created_by"])
    op.create_index("ix_antibody_candidates_created_at", "antibody_candidates", ["created_at"])


def downgrade() -> None:
    """生产红线：严禁 DROP TABLE——回滚有意不执行，需人工评估后手工操作"""
    raise RuntimeError(
        "antibody_candidates 承载抗体设计资产，按生产红线禁止自动 DROP TABLE；"
        "如确需回滚，请运维确认数据迁移方案后手工处理，并将版本标记回退。"
    )
