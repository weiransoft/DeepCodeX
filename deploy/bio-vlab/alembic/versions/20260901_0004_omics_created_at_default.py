"""omics_assets.created_at 补服务端默认值（CPV 演练断点修复）

背景：开发库 omics_assets 表由早期建表路径生成，created_at 列缺少
服务端默认值，与 ORM 模型（server_default=func.now()）漂移；
MySQL 严格模式（NO_ZERO_DATE/STRICT_TRANS_TABLES）下 INSERT 不携带
created_at 即报 1364 "Field 'created_at' doesn't have a default value"，
组学资产上传 500。

变更：MODIFY created_at 为 NOT NULL DEFAULT CURRENT_TIMESTAMP(3)，
与 ORM 契约对齐（毫秒精度，与 research_projects 等表同口径）。
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "20260901_0004"
down_revision: Union[str, None] = "20260901_0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """为 omics_assets.created_at 补 CURRENT_TIMESTAMP(3) 服务端默认值"""
    # 幂等守卫（2026-10-07 alembic 接入改造补）：新库由 create_all 建出时
    # server_default 已随 ORM 定义就位，重复 MODIFY 无意义；仅当列仍缺
    # 服务端默认值（旧建表路径漂移）才执行 ALTER
    inspector = sa.inspect(op.get_bind())
    col = next(
        c for c in inspector.get_columns("omics_assets") if c["name"] == "created_at"
    )
    if col.get("default") is not None:
        return
    op.execute(
        "ALTER TABLE omics_assets "
        "MODIFY COLUMN created_at TIMESTAMP(3) NOT NULL "
        "DEFAULT CURRENT_TIMESTAMP(3)"
    )


def downgrade() -> None:
    """回滚：移除服务端默认值（恢复漂移前的列定义）"""
    op.execute(
        "ALTER TABLE omics_assets "
        "MODIFY COLUMN created_at TIMESTAMP(3) NOT NULL"
    )
