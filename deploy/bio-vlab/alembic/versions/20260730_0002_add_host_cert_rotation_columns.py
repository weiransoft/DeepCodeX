"""为 hosts 表新增证书轮换相关字段

包含：
- cert_rotation_state: 证书轮换状态
- previous_cert_serial: 上一次有效证书序列号（用于回滚）
- previous_cert_not_after: 上一次证书过期时间
- last_rotation_at: 最近轮换时间
- last_rotation_error: 最近轮换错误信息
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql


# revision identifiers, used by Alembic.
revision: str = "20260730_0002"
down_revision: Union[str, None] = "20260730_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """为 hosts 表新增证书轮换状态与回滚所需字段"""
    # 幂等守卫（2026-10-07 alembic 接入改造补）：init_db() create_all
    # 可能已预建 cert_rotation_state 列，已存在则整体跳过，保证迁移可安全重放
    inspector = sa.inspect(op.get_bind())
    existing_cols = {c["name"] for c in inspector.get_columns("hosts")}
    if "cert_rotation_state" in existing_cols:
        return
    op.add_column(
        "hosts",
        sa.Column(
            "cert_rotation_state",
            sa.String(length=32),
            nullable=True,
            comment="证书轮换状态 current/rotating/active_new/rolled_back",
        ),
    )
    op.add_column(
        "hosts",
        sa.Column(
            "previous_cert_serial",
            sa.String(length=64),
            nullable=True,
            comment="上一次有效证书序列号（用于回滚）",
        ),
    )
    op.add_column(
        "hosts",
        sa.Column(
            "previous_cert_not_after",
            mysql.TIMESTAMP(fsp=3),
            nullable=True,
            comment="上一次证书过期时间",
        ),
    )
    op.add_column(
        "hosts",
        sa.Column(
            "last_rotation_at",
            mysql.TIMESTAMP(fsp=3),
            nullable=True,
            comment="最近轮换时间",
        ),
    )
    op.add_column(
        "hosts",
        sa.Column(
            "last_rotation_error",
            sa.Text(),
            nullable=True,
            comment="最近轮换错误信息",
        ),
    )


def downgrade() -> None:
    """回滚：删除 hosts 表新增的证书轮换字段"""
    op.drop_column("hosts", "last_rotation_error")
    op.drop_column("hosts", "last_rotation_at")
    op.drop_column("hosts", "previous_cert_not_after")
    op.drop_column("hosts", "previous_cert_serial")
    op.drop_column("hosts", "cert_rotation_state")
