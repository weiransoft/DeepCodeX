"""疫苗候选评价字段扩展（ASFV 管线 BP-A01 断点修复：候选评价机制）

背景（ASFV 全流程演练需求）：
    CPV 轮次疫苗候选仅支持单候选设计落库，无候选间横向比较能力。
    ASFV 管线需多抗原（p72/p54/p30/CD2v 等）独立设计候选后做多维加权
    评价 + 综合评分排序 + top10 报告，本迁移为 vaccine_candidates 表
    新增三个评价字段。

变更内容：
    1. composite_score:  DECIMAL(6,4)，综合评分 [0,1]（多维加权），
                         NULL=未评价；
    2. evaluation:       JSON，多维评价详情（dimensions/weights/
                         data_completeness 等）；
    3. evaluated_at:     TIMESTAMP(3)，最近评价时间，NULL=未评价。

新增索引：
    - ix_vaccine_candidates_score: composite_score 降序检索（排序端点）。

回滚策略：删除三列与索引（本迁移仅新增字段，不承载既有评价数据语义）。
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql


# revision identifiers, used by Alembic.
revision: str = "20260901_0006"
down_revision: Union[str, None] = "20260901_0005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """新增疫苗候选评价三字段 + 评分检索索引"""
    # 幂等守卫（2026-10-07 alembic 接入改造补）：init_db() create_all
    # 可能已预建 composite_score 列，已存在则整体跳过，保证迁移可安全重放
    inspector = sa.inspect(op.get_bind())
    existing_cols = {c["name"] for c in inspector.get_columns("vaccine_candidates")}
    if "composite_score" in existing_cols:
        return
    # 综合评分 [0,1]（多维加权，NULL=未评价）
    op.add_column(
        "vaccine_candidates",
        sa.Column("composite_score", sa.Numeric(precision=6, scale=4),
                  nullable=True, comment="综合评分 [0,1]（多维加权，NULL=未评价）"),
    )
    # 多维评价详情（JSON）
    op.add_column(
        "vaccine_candidates",
        sa.Column("evaluation", sa.JSON(), nullable=True,
                  comment="多维评价详情（JSON）"),
    )
    # 最近评价时间
    op.add_column(
        "vaccine_candidates",
        sa.Column("evaluated_at", mysql.TIMESTAMP(fsp=3), nullable=True,
                  comment="最近评价时间"),
    )
    # 评分检索索引（排序端点按综合评分降序）
    op.create_index("ix_vaccine_candidates_score", "vaccine_candidates",
                    ["composite_score"])


def downgrade() -> None:
    """删除疫苗候选评价三字段与索引"""
    op.drop_index("ix_vaccine_candidates_score", table_name="vaccine_candidates")
    op.drop_column("vaccine_candidates", "evaluated_at")
    op.drop_column("vaccine_candidates", "evaluation")
    op.drop_column("vaccine_candidates", "composite_score")
