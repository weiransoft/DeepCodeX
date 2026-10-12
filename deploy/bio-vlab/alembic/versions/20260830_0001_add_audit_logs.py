"""新增统一审计日志表 audit_logs（审计四元组 A5）

为关键业务端点（审批/人类决策/任务状态转换/删除/报告导出）提供
数据库型统一审计记录能力，补全审计四元组：
actor (actor_id) / timestamp / target (target_type + target_id) / action。

新增表：
- audit_logs: 统一审计日志表
  - id:          UUID 主键（32 位无连字符十六进制）
  - actor_id:    操作者用户 ID（系统动作为 NULL；不设外键，保证用户
                 删除后审计记录仍完整保留）
  - timestamp:   动作时间戳（UTC，TIMESTAMP(3) 毫秒精度）
  - target_type: 目标对象类型（project/workflow/task/molecule/
                 knowledge_base/approval/decision/report）
  - target_id:   目标对象 ID
  - action:      动作名（如 project.deleted / workflow.paused /
                 approval.approved）
  - detail:      动作上下文详情（JSON，可空）

新增索引：
- ix_audit_logs_action:   按动作名检索
- ix_audit_logs_target:   按目标对象 (target_type, target_id) 检索
- ix_audit_logs_actor:    按操作者检索
- ix_audit_logs_timestamp: 按时间范围检索

回滚策略：整表删除（本迁移新增独立表，不承载既有业务数据）。
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql


# revision identifiers, used by Alembic.
revision: str = "20260830_0001"
down_revision: Union[str, None] = "20260826_0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """创建统一审计日志表 audit_logs 及四类检索索引"""
    # 幂等守卫（2026-10-07 alembic 接入改造补）：init_db() create_all
    # 可能已预建本表，已存在则整体跳过，保证迁移可安全重放
    #（注意：旧租户版 audit_logs 的结构漂移由 20260901_0005 归档重建处理）
    if sa.inspect(op.get_bind()).has_table("audit_logs"):
        return
    op.create_table(
        "audit_logs",
        sa.Column("id", sa.String(length=36), nullable=False,
                  comment="UUID 主键"),
        sa.Column("actor_id", sa.String(length=36), nullable=True,
                  comment="操作者用户 ID（actor）"),
        sa.Column("timestamp", mysql.TIMESTAMP(fsp=3), nullable=False,
                  comment="动作时间戳（UTC）"),
        sa.Column("target_type", sa.String(length=50), nullable=False,
                  comment="目标对象类型"),
        sa.Column("target_id", sa.String(length=64), nullable=False,
                  comment="目标对象 ID"),
        sa.Column("action", sa.String(length=100), nullable=False,
                  comment="动作名"),
        sa.Column("detail", sa.JSON(), nullable=True,
                  comment="动作上下文详情（JSON）"),
        sa.PrimaryKeyConstraint("id"),
    )
    # 按动作名检索（如统计所有删除动作）
    op.create_index("ix_audit_logs_action", "audit_logs", ["action"])
    # 按目标对象检索（查看某个项目/工作流的全部审计记录）
    op.create_index("ix_audit_logs_target", "audit_logs",
                    ["target_type", "target_id"])
    # 按操作者检索（审计某用户的全部操作）
    op.create_index("ix_audit_logs_actor", "audit_logs", ["actor_id"])
    # 按时间范围检索（合规审计的时间窗口查询）
    op.create_index("ix_audit_logs_timestamp", "audit_logs", ["timestamp"])


def downgrade() -> None:
    """删除统一审计日志表 audit_logs 及其索引"""
    op.drop_index("ix_audit_logs_timestamp", table_name="audit_logs")
    op.drop_index("ix_audit_logs_actor", table_name="audit_logs")
    op.drop_index("ix_audit_logs_target", table_name="audit_logs")
    op.drop_index("ix_audit_logs_action", table_name="audit_logs")
    op.drop_table("audit_logs")
