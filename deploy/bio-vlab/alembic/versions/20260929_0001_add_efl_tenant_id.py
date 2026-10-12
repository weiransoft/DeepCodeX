"""execution_feedback_loop 表增加 tenant_id 列（bio 阶段一详细设计 v1.0 §5.2）

背景（tenant_id 渐进式隔离方案）：
    平台 execution_feedback_loop 表（EFL）当前无租户维度，多租户部署时
    所有审计记录混在一起，无法按租户检索隔离。本迁移在 EFL 表上加
    tenant_id VARCHAR(64) NOT NULL DEFAULT '' 列 + 复合索引 idx_efl_tenant_level。

    渐进式迁移期语义：
    - 写入侧：execution_loop L2590/L2972 两处 db.add 必须传 tenant_id
      （取不到时落空串，server_default 兜底）；
    - 检索侧：experience_memory.py 查询 EFL 时 tenant_id=None 不过滤
      + WARNING（存量全空串）；tenant_id 有值时
      query.filter(EFL.tenant_id.in_([tenant_id, ""])) 含空串行（渐进期
      新租户查询时既命中本租户也命中存量空串，平滑过渡到全租户化）。

变更内容：
    ALTER TABLE execution_feedback_loop ADD COLUMN tenant_id VARCHAR(64)
    NOT NULL DEFAULT '' COMMENT '租户 ID（渐进迁移期空串=未分配）';
    ALTER TABLE execution_feedback_loop ADD INDEX idx_efl_tenant_level
    (tenant_id, report_level);

    MySQL 8.0.36 支持 INSTANT DDL ADD COLUMN + INPLACE ADD INDEX，
    本次 ALTER TABLE 不触发表重建，对生产零中断。

防御说明：
    应用启动 init_db() 的 create_all 可能已先建出 tenant_id 列（开发
    环境常见），upgrade 前用 inspector.has_column 检查，已存在则跳过，
    避免列冲突导致迁移链中断。

回滚策略：
    downgrade 执行 DROP COLUMN tenant_id + DROP INDEX idx_efl_tenant_level。
    （tenant_id 是新增检索列，不是核心业务数据，回滚不会丢失审计内容；
    若已有租户数据写入，运维需手工备份后再回滚）。
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "20260929_0001"
down_revision: Union[str, None] = "20260922_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """为 execution_feedback_loop 表加 tenant_id 列 + 复合索引（幂等）"""
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not inspector.has_table("execution_feedback_loop"):
        return  # 表不存在则跳过（极端情况）

    # 幂等防御：tenant_id 列可能已由 init_db() create_all 预建
    existing_cols = {col["name"] for col in inspector.get_columns("execution_feedback_loop")}
    if "tenant_id" not in existing_cols:
        op.add_column(
            "execution_feedback_loop",
            sa.Column(
                "tenant_id",
                sa.String(64),
                nullable=False,
                server_default=sa.text("''"),
                comment="租户 ID（渐进迁移期空串=未分配租户）",
            ),
        )

    # 幂等防御：idx_efl_tenant_level 可能已预建
    existing_idx_names = {idx["name"] for idx in inspector.get_indexes("execution_feedback_loop")}
    if "idx_efl_tenant_level" not in existing_idx_names:
        op.create_index(
            "idx_efl_tenant_level",
            "execution_feedback_loop",
            ["tenant_id", "report_level"],
        )


def downgrade() -> None:
    """回滚：删复合索引 + 删 tenant_id 列"""
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not inspector.has_table("execution_feedback_loop"):
        return

    existing_idx_names = {idx["name"] for idx in inspector.get_indexes("execution_feedback_loop")}
    if "idx_efl_tenant_level" in existing_idx_names:
        op.drop_index("idx_efl_tenant_level", table_name="execution_feedback_loop")

    existing_cols = {col["name"] for col in inspector.get_columns("execution_feedback_loop")}
    if "tenant_id" in existing_cols:
        op.drop_column("execution_feedback_loop", "tenant_id")
