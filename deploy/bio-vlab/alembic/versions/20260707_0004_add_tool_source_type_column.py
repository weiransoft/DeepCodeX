"""add tools.source_type column (P0-8 SciMiner global switch integration)

Revision ID: 20260707_0004
Revises: 20260707_0003
Create Date: 2026-07-07 00:04:00.000000

为 tools 表新增 source_type 列，支持 SciMiner 全局开关与单工具开关的联动。

设计动机（Claude Science P0-8 "MCP 聚合层" + 工具可用性治理）：
  当前 tools 表只有 is_active 单工具开关，无法区分工具来源。
  引入 source_type 列后，可实现两层开关联动：
    1. is_active：单工具级开关（管理员显式禁用某个工具）
    2. SCIMINER_TOOLS_ENABLED：全局开关（False 时所有 source_type='sciminer' 的工具不可用）
  sciminer 工具需同时满足全局开关=True + is_active=True 才可用，
  local/external 工具仅受 is_active 控制。

向后兼容设计：
  1. source_type 列 nullable=False，server_default='local'
     所有现有工具记录默认为 'local'（本地原生工具），不受全局开关影响
  2. Tool 模型 default=ToolSourceType.LOCAL.value，新插入记录自动获得 'local'
  3. is_tool_available() / ToolRegistry.list_available_tools() 统一消费此字段
  4. 不修改现有 register() 签名（source_type 作为 metadata 传入，向后兼容）

字段语义：
  - 'sciminer'：SciMiner 平台工具，受 SCIMINER_TOOLS_ENABLED 全局开关控制
  - 'local'：本地原生工具（如 FreeBindCraftTool / ProteinMPNNTool），仅受 is_active 控制
  - 'external'：外部工具（如 HTTP API 调用的第三方工具），仅受 is_active 控制

数据流：
  1. 本地工具注册：local_tool_registry.register_local_protein_design_tools()
     通过 getattr(tool, "source_type", "local") 读取工具类属性，传入 metadata
  2. SciMiner 工具注册：未来 SciMiner 适配器注册时 source_type="sciminer"
  3. 查询：is_tool_available(tool) / ToolRegistry.list_available_tools()
     统一读取 source_type 字段，结合 SCIMINER_TOOLS_ENABLED 判断可用性

注意事项：
1. alembic env.py 已绑定 Base.metadata + settings.database_url
2. server_default='local' 确保 ADD COLUMN 时现有行自动获得默认值（MySQL 支持）
3. source_type 列加索引，便于按来源类型分组查询（运维监控高频查询路径）
4. 不新增外键约束，source_type 是枚举字符串而非引用表
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "20260707_0004"
down_revision: Union[str, None] = "20260707_0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """为 tools 表新增 source_type 列（SciMiner 全局开关联动）"""
    # 幂等守卫（2026-10-07 alembic 接入改造补）：init_db() create_all
    # 可能已预建 source_type 列，已存在则整体跳过，保证迁移可安全重放
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing_cols = {c["name"] for c in inspector.get_columns("tools")}
    if "source_type" in existing_cols:
        return

    # 新增 source_type 列：nullable=False + server_default='local'
    # server_default 确保 ADD COLUMN 时所有现有行自动获得 'local' 值（MySQL 原生支持）
    # String(50) 足以容纳 source_type 枚举值（sciminer/local/external）及未来扩展
    op.add_column(
        "tools",
        sa.Column(
            "source_type",
            sa.String(length=50),
            nullable=False,
            server_default="local",
            comment="工具来源类型：sciminer/local/external",
        ),
    )

    # 索引：按 source_type 分组查询（运维监控、可用性统计高频查询路径）
    # 例如：SELECT COUNT(*) FROM tools WHERE source_type='sciminer' AND is_active=1
    op.create_index(
        "ix_tools_source_type",
        "tools",
        ["source_type"],
    )


def downgrade() -> None:
    """回滚：删除 tools.source_type 列"""
    # 先删索引，再删列（MySQL 删列会自动级联删索引，显式删除便于审计）
    op.drop_index(
        "ix_tools_source_type",
        table_name="tools",
    )
    op.drop_column(
        "tools",
        "source_type",
    )
