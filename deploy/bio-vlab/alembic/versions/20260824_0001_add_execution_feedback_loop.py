"""新增执行中闭环记录表 execution_feedback_loop

智能体群组协作实时闭环机制（设计文档：
backend/docs/AGENT_RUNTIME_COLLABORATION_LOOP_DESIGN.md §3.11）的审计持久化表。

记录每次"主动汇报→群组讨论→共识→动态调整"闭环的完整链路：
- L3 讨论级：汇报内容、讨论消息快照、共识方式、计划版本变迁、调整指令
- L4 审批级：高风险信号与 pause_expires_at（Celery beat 超时扫描用）

回滚策略：downgrade 直接删除本表（该表为审计记录，不承载业务主数据）。
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql


# revision identifiers, used by Alembic.
revision: str = "20260824_0001"
down_revision: Union[str, None] = "20260730_0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """创建执行中闭环记录表（含会话/分级/暂停超时三个索引）"""
    # 幂等守卫（2026-10-07 alembic 接入改造补）：init_db() create_all
    # 可能已预建本表，已存在则整体跳过，保证迁移可安全重放
    if sa.inspect(op.get_bind()).has_table("execution_feedback_loop"):
        return
    op.create_table(
        "execution_feedback_loop",
        sa.Column(
            "id", sa.String(length=36), primary_key=True,
            comment="UUID 主键",
        ),
        sa.Column(
            "session_id", sa.String(length=64), nullable=False,
            comment="coordinate 会话 ID",
        ),
        sa.Column(
            "task_id", sa.String(length=64), nullable=False,
            comment="关联任务 ID",
        ),
        sa.Column(
            "agent_role", sa.String(length=64), nullable=False,
            comment="汇报者角色",
        ),
        sa.Column(
            "report_level", sa.String(length=16), nullable=False,
            comment="汇报分级 l1_info/l2_concern/l3_discuss/l4_approval",
        ),
        sa.Column(
            "report_content", sa.Text(), nullable=True,
            comment="汇报正文",
        ),
        sa.Column(
            "evidence", sa.JSON(), nullable=True,
            comment="数据证据",
        ),
        sa.Column(
            "discussion_room_id", sa.String(length=64), nullable=True,
            comment="讨论室 ID",
        ),
        sa.Column(
            "consensus_reached", sa.Boolean(), nullable=False,
            server_default=sa.text("0"), comment="是否达成共识",
        ),
        sa.Column(
            "consensus_method", sa.String(length=32), nullable=True,
            comment="共识方式",
        ),
        sa.Column(
            "discussion_messages", sa.JSON(), nullable=True,
            comment="讨论消息快照",
        ),
        sa.Column(
            "plan_version_before", sa.Integer(), nullable=True,
            comment="计划版本（前）",
        ),
        sa.Column(
            "plan_version_after", sa.Integer(), nullable=True,
            comment="计划版本（后）",
        ),
        sa.Column(
            "adjustments", sa.JSON(), nullable=True,
            comment="共识调整指令",
        ),
        sa.Column(
            "agent_execution_id", sa.String(length=36), nullable=True,
            comment="关联执行记录",
        ),
        sa.Column(
            "pause_expires_at", mysql.TIMESTAMP(fsp=3), nullable=True,
            comment="暂停超时时间",
        ),
        sa.Column(
            "created_at", mysql.TIMESTAMP(fsp=3), nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP(3)"), comment="创建时间",
        ),
    )
    # 会话维度索引（按会话检索完整闭环链路）
    op.create_index("idx_efl_session", "execution_feedback_loop", ["session_id"])
    # 汇报分级索引（L3/L4 审计检索）
    op.create_index("idx_efl_level", "execution_feedback_loop", ["report_level"])
    # 暂停超时索引（Celery beat 扫描 PAUSED 超时任务）
    op.create_index("idx_efl_pause", "execution_feedback_loop", ["pause_expires_at"])


def downgrade() -> None:
    """删除执行中闭环记录表（审计记录表，删除不影响业务主数据）"""
    op.drop_index("idx_efl_pause", table_name="execution_feedback_loop")
    op.drop_index("idx_efl_level", table_name="execution_feedback_loop")
    op.drop_index("idx_efl_session", table_name="execution_feedback_loop")
    op.drop_table("execution_feedback_loop")
