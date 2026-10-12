"""扩宽 primer_designs.status 列以匹配业务枚举（引物设计工作流 §5.1 第 6 点）

背景（引物探针设计工作流实测暴露的真实 bug）：
    v1.0 建表时把 status 列写成 String(20)，但业务枚举里
    `conservation_analyzed` 长 22 字符（designed=8、reviewed=8、
    conservation_analyzed=22），一旦保守区分析成功落库
    (pipeline 里 design_stage_status 返回 conservation_analyzed)
    即触发 MySQL (1406, "Data too long for column 'status'")，
    整条 POST /primer/design 事务 500 回滚，导致真实数据无法持久化。

    模型层 `String(20)` 与迁移层 `sa.String(length=20)` 双处不匹配
    ——models.PrimerDesign.status 注释与 §5.1 契约都写着三态枚举
    designed / conservation_analyzed / reviewed，说明列宽本就应至少
    覆盖 22。

变更内容：
    ALTER TABLE primer_designs MODIFY COLUMN status VARCHAR(32) NOT NULL
    COMMENT '状态：designed/conservation_analyzed/reviewed';
    选 32（与 pipeline_status 对齐）而非 22：预留未来枚举扩展空间，
    避免二次 ALTER。

回滚策略：
    回退到 String(20)——若已有 `conservation_analyzed` 数据回退会
    截断报错，故 rollback 前先审计确认无该值，本迁移仅用于开发环境。
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "20260921_0001"
down_revision: Union[str, None] = "20260920_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """把 primer_designs.status 从 VARCHAR(20) 扩宽到 VARCHAR(32)"""
    op.alter_column(
        "primer_designs",
        "status",
        existing_type=sa.String(length=20),
        type_=sa.String(length=32),
        existing_nullable=False,
        existing_comment="状态：designed/conservation_analyzed/reviewed",
    )


def downgrade() -> None:
    """回滚：VARCHAR(32) 回退到 VARCHAR(20)

    注意：若已有 conservation_analyzed 值，回退会因截断报错——
    开发环境可控；生产回滚前需 SELECT COUNT(*) WHERE status='conservation_analyzed'
    审计确认为 0 再执行。
    """
    op.alter_column(
        "primer_designs",
        "status",
        existing_type=sa.String(length=32),
        type_=sa.String(length=20),
        existing_nullable=False,
        existing_comment="状态：designed/conservation_analyzed/reviewed",
    )
