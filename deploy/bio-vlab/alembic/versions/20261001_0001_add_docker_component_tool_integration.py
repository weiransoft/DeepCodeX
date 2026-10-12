"""docker_components 表增加 tool_integration_config JSON 列（CUDA 双卡平台 · 工具-组件集成）

背景（工具-组件扩展与调度机制）：
    docker/components/*.component.yml 新增 tool_integration 段，声明组件
    对外暴露的 HTTP 调用端点（port / invoke_endpoint）与工具 schema 引用
    （input_schema_ref / output_schema_ref），供 ToolDataflowResolver 按
    "上游输出键 ⊇ 下游所需键" 自动接线。component_config.to_db_dict() 已
    将该段序列化为 tool_integration_config 键，随 registry upsert 落库。
    本迁移补齐 docker_components 表的对应 JSON 列（NULL = 该组件不注册为工具）。

变更内容：
    ALTER TABLE docker_components ADD COLUMN tool_integration_config JSON NULL
    COMMENT '工具集成配置（tool_integration 段）'；

    MySQL 8.0.36 INSTANT DDL ADD JSON NULL 列，对生产零中断。

防御说明：
    upgrade 前用 inspector.has_column 检查 tool_integration_config 是否已存在
    （init_db() create_all 预建），已存在则跳过。

回滚策略：
    downgrade 执行 DROP COLUMN tool_integration_config；该列为纯配置快照，
    删除后组件运行时行为不受影响（权威来源仍是 component.yml）。
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "20261001_0001"
down_revision: Union[str, None] = "20260929_0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """为 docker_components 表加 tool_integration_config JSON 列（幂等）"""
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not inspector.has_table("docker_components"):
        return

    existing_cols = {col["name"] for col in inspector.get_columns("docker_components")}
    if "tool_integration_config" not in existing_cols:
        op.add_column(
            "docker_components",
            sa.Column(
                "tool_integration_config",
                sa.JSON,
                nullable=True,
                comment="工具集成配置（tool_integration 段）",
            ),
        )


def downgrade() -> None:
    """回滚：删 tool_integration_config 列（配置快照列，删除无损）"""
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not inspector.has_table("docker_components"):
        return

    existing_cols = {col["name"] for col in inspector.get_columns("docker_components")}
    if "tool_integration_config" in existing_cols:
        op.drop_column("docker_components", "tool_integration_config")
