"""新增平台基准评测表 platform_benchmarks（增强报告 §2.6 P1-D3）

为「平台基准评测」能力提供结果持久化：每次运行 run_platform_benchmark()
（POST /api/v1/benchmark/run，admin 触发）落库一条记录，前端「性能监控」
页经 GET /api/v1/benchmark/latest 读取最新一条展示。

新增表：
- platform_benchmarks: 平台基准评测记录表
  - id:            基准记录 ID（UUID 32 位无连字符十六进制，即对外
                   暴露的 benchmark_id）
  - ran_at:        评测时间（UTC，TIMESTAMP(3) 毫秒精度；Python 侧
                   default 生成，flush 后立即可读，与 audit_logs 同风格）
  - overall_status: 整体状态 ok / degraded / unavailable
  - duration_ms:   本次评测总耗时（毫秒，Float）
  - items:         评测项明细（JSON 数组，每项含 name/label/kind/status/
                   iterations/p50_ms/p95_ms/error/detail）
  - triggered_by:  触发用户 ID（admin；可空，系统内部触发为 NULL）

新增索引：
- ix_platform_benchmarks_ran_at: 按评测时间检索（latest 查询与历史趋势）

回滚策略：整表删除（本迁移新增独立表，不承载既有业务数据）。
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql


# revision identifiers, used by Alembic.
revision: str = "20260831_0001"
down_revision: Union[str, None] = "20260830_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """创建平台基准评测表 platform_benchmarks 及时间检索索引"""
    # 幂等守卫（2026-10-07 alembic 接入改造补）：init_db() create_all
    # 可能已预建本表，已存在则整体跳过，保证迁移可安全重放
    if sa.inspect(op.get_bind()).has_table("platform_benchmarks"):
        return
    op.create_table(
        "platform_benchmarks",
        sa.Column("id", sa.String(length=36), nullable=False,
                  comment="基准记录 ID（benchmark_id）"),
        sa.Column("ran_at", mysql.TIMESTAMP(fsp=3), nullable=False,
                  comment="评测时间（UTC）"),
        sa.Column("overall_status", sa.String(length=20), nullable=False,
                  comment="整体状态 ok/degraded/unavailable"),
        sa.Column("duration_ms", sa.Float(), nullable=False,
                  comment="评测总耗时(ms)"),
        sa.Column("items", sa.JSON(), nullable=False,
                  comment="评测项明细（JSON 数组）"),
        sa.Column("triggered_by", sa.String(length=36), nullable=True,
                  comment="触发用户 ID（admin）"),
        sa.PrimaryKeyConstraint("id"),
    )
    # 按评测时间检索：latest 查询与历史趋势分析的主索引
    op.create_index("ix_platform_benchmarks_ran_at", "platform_benchmarks",
                    ["ran_at"])


def downgrade() -> None:
    """删除平台基准评测表 platform_benchmarks 及其索引"""
    op.drop_index("ix_platform_benchmarks_ran_at",
                  table_name="platform_benchmarks")
    op.drop_table("platform_benchmarks")
