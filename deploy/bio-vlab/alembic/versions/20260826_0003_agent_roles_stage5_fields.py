"""agent_roles 补齐阶段 5 Claude Science 风格裁剪字段

Revision ID: 20260826_0003
Revises: 20260824_0002
Create Date: 2026-08-26

既有缺口修复：ORM 模型 AgentRole（app/models/__init__.py L1359-1367，
阶段 5 新增字段）先于本迁移落库，agent_roles 表缺 4 列导致
GET /api/v1/agents/roles 查询报
"Unknown column 'agent_roles.enable_thinking'"（500）。
本迁移补齐模型已声明的 4 列（add_column 可逆操作，不动既有数据）。
"""
from typing import Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import mysql

# revision identifiers, used by Alembic.
revision: str = "20260826_0003"
down_revision: Union[str, None] = "20260824_0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """为 agent_roles 表补齐阶段 5 新增的 4 个裁剪字段"""
    # 幂等守卫（2026-10-07 alembic 接入改造补）：init_db() create_all
    # 可能已预建 enable_thinking 列，已存在则整体跳过，保证迁移可安全重放
    inspector = sa.inspect(op.get_bind())
    existing_cols = {c["name"] for c in inspector.get_columns("agent_roles")}
    if "enable_thinking" in existing_cols:
        return
    op.add_column(
        "agent_roles",
        sa.Column("enable_thinking", sa.Boolean(), nullable=True,
                  server_default=sa.text("1"),
                  comment="是否启用 thinking 模式"),
    )
    op.add_column(
        "agent_roles",
        sa.Column("skills_locked", sa.JSON(), nullable=True,
                  comment="锁定的 skill_id 列表"),
    )
    op.add_column(
        "agent_roles",
        sa.Column("excluded_tools", sa.JSON(), nullable=True,
                  comment="排除的 tool_id 列表"),
    )
    op.add_column(
        "agent_roles",
        sa.Column("internal", sa.Boolean(), nullable=True,
                  server_default=sa.text("0"),
                  comment="是否为内部角色"),
    )


def downgrade() -> None:
    """回滚：移除阶段 5 新增的 4 个裁剪字段"""
    op.drop_column("agent_roles", "internal")
    op.drop_column("agent_roles", "excluded_tools")
    op.drop_column("agent_roles", "skills_locked")
    op.drop_column("agent_roles", "enable_thinking")
