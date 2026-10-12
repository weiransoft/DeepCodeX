"""audit_logs 表结构对齐 ORM（演练断点修复：审计写入 1054 Unknown column）

背景：开发库 audit_logs 为旧租户版结构（user_id/resource_type/...），
与现行统一审计四元组 ORM（actor_id/timestamp/target_type/target_id/
action/detail）漂移，所有 record_audit 写入失败（不阻断业务但审计缺失）。

处理：旧表归档改名（RENAME，不 DROP——保留潜在历史数据；本库实测 0 行），
按 ORM 定义重建新表。alembic 版本 20260901_0005。
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql


# revision identifiers, used by Alembic.
revision: str = "20260901_0005"
down_revision: Union[str, None] = "20260901_0004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """旧 audit_logs 归档改名 + 按统一审计四元组 ORM 重建"""
    # 1. 旧表归档（幂等：归档表已存在说明已执行过，跳过改名）
    conn = op.get_bind()
    has_legacy = conn.execute(
        sa.text(
            "SELECT COUNT(*) FROM information_schema.tables "
            "WHERE table_schema = DATABASE() AND table_name = 'audit_logs'"
        )
    ).scalar()
    has_archive = conn.execute(
        sa.text(
            "SELECT COUNT(*) FROM information_schema.tables "
            "WHERE table_schema = DATABASE() "
            "AND table_name = 'audit_logs_legacy_tenant'"
        )
    ).scalar()
    if has_legacy and not has_archive:
        op.execute("RENAME TABLE audit_logs TO audit_logs_legacy_tenant")
    elif has_legacy and has_archive:
        # 极端场景：两张表并存。2026-10-07 alembic 接入回放实测：
        # 本迁移曾手工应用后，create_all 又按 ORM 重建了新 audit_logs，
        # 与归档 legacy 并存——此时若现存 audit_logs 已对齐统一审计
        # 四元组 ORM 结构（幂等守卫语义），直接跳过；结构仍漂移则
        # 如实失败，提示人工处理（不静默丢弃任何审计数据）
        col_names = {c["name"] for c in sa.inspect(conn).get_columns("audit_logs")}
        orm_aligned = {"actor_id", "timestamp", "target_type",
                       "target_id", "action", "detail"} <= col_names
        if not orm_aligned:
            raise RuntimeError(
                "audit_logs 与 audit_logs_legacy_tenant 同时存在，"
                "且现存 audit_logs 未对齐统一审计四元组 ORM 结构，"
                "请人工确认后重试（禁止自动丢弃任何审计数据）"
            )

    # 2. 按统一审计四元组 ORM 重建（列定义与 core/audit/audit_service.py 一致）
    # alembic 幂等守卫（2026-10-07 alembic 接入改造补）：归档改名后
    # audit_logs 本应不存在；若已存在说明本迁移已执行过（或环境特殊），
    # 直接跳过重建，避免 create_table 冲突中断迁移链
    if not conn.execute(
        sa.text(
            "SELECT COUNT(*) FROM information_schema.tables "
            "WHERE table_schema = DATABASE() AND table_name = 'audit_logs'"
        )
    ).scalar():
        op.create_table(
            "audit_logs",
            sa.Column("id", sa.String(length=36), primary_key=True,
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
        )
        op.create_index("ix_audit_logs_action", "audit_logs", ["action"])
        op.create_index("ix_audit_logs_target", "audit_logs",
                        ["target_type", "target_id"])
        op.create_index("ix_audit_logs_actor", "audit_logs", ["actor_id"])
        op.create_index("ix_audit_logs_timestamp", "audit_logs", ["timestamp"])


def downgrade() -> None:
    """回滚：删除新表并把归档旧表改回 audit_logs"""
    op.drop_index("ix_audit_logs_timestamp", table_name="audit_logs")
    op.drop_index("ix_audit_logs_actor", table_name="audit_logs")
    op.drop_index("ix_audit_logs_target", table_name="audit_logs")
    op.drop_index("ix_audit_logs_action", table_name="audit_logs")
    op.drop_table("audit_logs")
    op.execute("RENAME TABLE audit_logs_legacy_tenant TO audit_logs")
