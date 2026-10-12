"""platform_benchmarks 表增加 env_flags JSON 列（bio 阶段一详细设计 v1.0 §5.3）

背景（benchmark 可复现性）：
    platform_benchmarks 表当前只存 overall_status/duration_ms/items/
    triggered_by，无法对齐运行时 settings 开关组合。v1.0 §4 裁决新增
    app/core/config/env_flags.py 纯函数快照模块，本迁移让每次 benchmark
    run 落库一条 env_flags JSON 快照，评分结果可与开关组合（灰度状态）
    对齐复现。

    快照字段清单（env_flags._ENV_FLAG_FIELDS，7 键）：
        topology_gate / dmta_enabled / intern_agent_loop /
        execution_loop / reflection_planning / tool_semantic_retrieval /
        experience_memory（当前不存在 → 快照值恒 None）。

变更内容：
    ALTER TABLE platform_benchmarks ADD COLUMN env_flags JSON NULL
    COMMENT '环境开关位快照（env_flags.snapshot_env_flags 输出）'；

    MySQL 8.0.36 INSTANT DDL ADD JSON NULL 列，对生产零中断。

防御说明：
    upgrade 前用 inspector.has_column 检查 env_flags 是否已存在
    （init_db() create_all 预建），已存在则跳过。

回滚策略：
    downgrade 执行 DROP COLUMN env_flags；历史记录的开关快照信息
    随列删除——这是可接受损失（基线评分数据不受开关组合影响，只有
    复现性注释价值）。
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "20260929_0002"
down_revision: Union[str, None] = "20260929_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """为 platform_benchmarks 表加 env_flags JSON 列（幂等）"""
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not inspector.has_table("platform_benchmarks"):
        return

    existing_cols = {col["name"] for col in inspector.get_columns("platform_benchmarks")}
    if "env_flags" not in existing_cols:
        op.add_column(
            "platform_benchmarks",
            sa.Column(
                "env_flags",
                sa.JSON,
                nullable=True,
                comment="环境开关位快照（env_flags.snapshot_env_flags 输出）",
            ),
        )


def downgrade() -> None:
    """回滚：删 env_flags 列"""
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not inspector.has_table("platform_benchmarks"):
        return

    existing_cols = {col["name"] for col in inspector.get_columns("platform_benchmarks")}
    if "env_flags" in existing_cols:
        op.drop_column("platform_benchmarks", "env_flags")
