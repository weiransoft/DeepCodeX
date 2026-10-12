"""execution_feedback_loop 表新增人类决策字段（FR-11）

智能体群组协作实时闭环机制的人类决策接入（设计文档：
backend/docs/AGENT_RUNTIME_COLLABORATION_LOOP_DESIGN.md §3.13.4）。

L4 审批级触发时生成结构化决策单（六选项：批准/否决/修改目标/调整任务/
补充指示/取消任务），决策单随闭环审计记录同行持久化；人工提交决策后
回填决策结果字段。

新增列：
- decision_id: 决策单 ID
- decision_options: 决策选项快照（JSON）
- decision_status: 决策单状态（pending/approved/rejected/modified/
                   guided/cancelled/expired）
- decision_action: 人工选择的动作
- decision_params: 决策参数（goal_text/instruction/guidance）
- decision_reason: 决策理由
- decision_resolved_at: 决策提交时间
- 新增 decision_id 索引（决策单定位）

回滚策略：删除新增列与索引（审计扩展字段，不承载既有业务数据）。
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql


# revision identifiers, used by Alembic.
revision: str = "20260824_0002"
down_revision: Union[str, None] = "20260824_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """为 execution_feedback_loop 表新增人类决策字段与索引"""
    # 幂等守卫（2026-10-07 alembic 接入改造补）：init_db() create_all
    # 可能已预建 decision_id 列，已存在则整体跳过，保证迁移可安全重放
    inspector = sa.inspect(op.get_bind())
    existing_cols = {c["name"] for c in inspector.get_columns("execution_feedback_loop")}
    if "decision_id" in existing_cols:
        return
    op.add_column(
        "execution_feedback_loop",
        sa.Column("decision_id", sa.String(length=64), nullable=True,
                  comment="人类决策单 ID"),
    )
    op.add_column(
        "execution_feedback_loop",
        sa.Column("decision_options", sa.JSON(), nullable=True,
                  comment="决策选项快照"),
    )
    op.add_column(
        "execution_feedback_loop",
        sa.Column("decision_status", sa.String(length=16), nullable=True,
                  comment="决策单状态"),
    )
    op.add_column(
        "execution_feedback_loop",
        sa.Column("decision_action", sa.String(length=32), nullable=True,
                  comment="人工选择的动作"),
    )
    op.add_column(
        "execution_feedback_loop",
        sa.Column("decision_params", sa.JSON(), nullable=True,
                  comment="决策参数"),
    )
    op.add_column(
        "execution_feedback_loop",
        sa.Column("decision_reason", sa.Text(), nullable=True,
                  comment="决策理由"),
    )
    op.add_column(
        "execution_feedback_loop",
        sa.Column("decision_resolved_at", mysql.TIMESTAMP(fsp=3), nullable=True,
                  comment="决策提交时间"),
    )
    # 决策单定位索引（决策结果落库按 decision_id 检索审计行）
    op.create_index(
        "idx_efl_decision", "execution_feedback_loop", ["decision_id"],
    )


def downgrade() -> None:
    """删除人类决策字段与索引"""
    op.drop_index("idx_efl_decision", table_name="execution_feedback_loop")
    op.drop_column("execution_feedback_loop", "decision_resolved_at")
    op.drop_column("execution_feedback_loop", "decision_reason")
    op.drop_column("execution_feedback_loop", "decision_params")
    op.drop_column("execution_feedback_loop", "decision_action")
    op.drop_column("execution_feedback_loop", "decision_status")
    op.drop_column("execution_feedback_loop", "decision_options")
    op.drop_column("execution_feedback_loop", "decision_id")
