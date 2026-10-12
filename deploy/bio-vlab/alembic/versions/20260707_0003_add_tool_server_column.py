"""add tools.server column (P0-8 MCP aggregation layer optional part)

Revision ID: 20260707_0003
Revises: 20260707_0002
Create Date: 2026-07-07 00:03:00.000000

为 tools 表新增 server 列（P0-8 可选部分：MCP server 元数据字段）。

设计动机（Claude Science P0-8 "MCP 聚合层"）：
  当前 30+ 工具扁平注册在 ToolRegistry 中，缺乏 MCP server 归属信息。
  未来引入 MCP 聚合层时，需要按 server 分组发现工具，因此需要在 tools 表
  和 ToolEntry 中记录工具所属的 MCP server 名称。

向后兼容设计：
  1. server 列 nullable=True，所有现有工具记录默认 NULL（表示未归属任何 MCP server）
  2. ToolEntry.server 默认 None，register() 不传 server 参数时保持原行为
  3. ToolResponse.server 字段 Optional，向前端返回 None 时不影响现有 UI
  4. 不修改现有 list_tools / discover 方法的行为（仅新增 server 字段输出）

字段语义：
  - NULL：工具未归属任何 MCP server（本地原生工具，如 FreeBindCraftTool / ProteinMPNNTool）
  - "mcp_structure"：工具属于结构生物学 MCP server（示例）
  - "mcp_chemistry"：工具属于化学 MCP server（示例）

数据流：
  1. 本地工具注册：local_tool_registry.register_local_protein_design_tools()
     显式传 server=None，与原行为一致
  2. MCP 工具注册：未来 MCP 聚合层注册时传 server="mcp_xxx"
  3. 查询：ToolRegistry.discover_by_server(server) / list_tools_by_server(server)
     - server=None 查找未归属工具
     - server="mcp_xxx" 查找指定 server 下的工具

注意事项：
1. alembic env.py 已绑定 Base.metadata + settings.database_url
2. MySQL 8 默认 utf8mb4 / utf8mb4_unicode_ci，无需显式声明
3. server 列加索引，便于按 server 分组查询（MCP 聚合层高频查询路径）
4. 不新增外键约束，因为 MCP server 定义在外部配置而非数据库表
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "20260707_0003"
down_revision: Union[str, None] = "20260707_0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """为 tools 表新增 server 列（P0-8 可选部分）"""
    # 幂等守卫（2026-10-07 alembic 接入改造补）：init_db() create_all
    # 可能已预建 server 列，已存在则整体跳过，保证迁移可安全重放
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing_cols = {c["name"] for c in inspector.get_columns("tools")}
    if "server" in existing_cols:
        return

    # 新增 server 列：nullable=True，所有现有记录默认 NULL
    # String(100) 与 ToolEntry.server 字段语义一致，足够容纳 MCP server 名称
    op.add_column(
        "tools",
        sa.Column(
            "server",
            sa.String(length=100),
            nullable=True,
            comment="所属 MCP server 名称（None=本地原生工具）",
        ),
    )

    # 索引：按 server 分组查询（MCP 聚合层高频查询路径）
    # 注意：MySQL 索引中 NULL 值不聚集，server=NULL 的工具不会被此索引加速
    # 但 server="mcp_xxx" 的查询会被显著加速，符合 MCP 聚合层的使用场景
    op.create_index(
        "ix_tools_server",
        "tools",
        ["server"],
    )


def downgrade() -> None:
    """回滚：删除 tools.server 列"""
    # 先删索引，再删列（MySQL 删列会自动级联删索引，显式删除便于审计）
    op.drop_index(
        "ix_tools_server",
        table_name="tools",
    )
    op.drop_column(
        "tools",
        "server",
    )
