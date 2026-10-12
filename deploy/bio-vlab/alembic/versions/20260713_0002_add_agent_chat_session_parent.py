"""
添加 agent_chat_sessions.parent_session_id 字段（P2-6 分支树，2026-07-13）

目的：
- 支持消息分支树形结构（P2-6）
- parent_session_id 为 NULL → 根会话
- parent_session_id 指向另一 session → 该 session 是分支会话
- ON DELETE SET NULL：父会话硬删除时不影响子会话（孤儿处理，子会话升级为根）

设计决策：
- 用 String(36) 与现有 id 字段类型保持一致
- nullable=True：现有会话都是根，不需要回填
- 加索引：分支树遍历时高频按 parent 过滤
- ON DELETE SET NULL：避免 cascade 级联删除子会话
- 注：SQLite 内存测试环境会忽略此 FK（_create_all_tables 通过 monkey-patch
  兼容 ON DELETE SET NULL）

降级：先删 FK 再删列再删索引
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "20260713_0002"
down_revision: Union[str, None] = "20260713_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """添加 parent_session_id 字段 + FK + 索引"""
    # 幂等守卫（2026-10-07 alembic 接入改造补）：init_db() create_all
    # 可能已预建 parent_session_id 列，已存在则整体跳过，保证迁移可安全重放
    inspector = sa.inspect(op.get_bind())
    existing_cols = {c["name"] for c in inspector.get_columns("agent_chat_sessions")}
    if "parent_session_id" in existing_cols:
        return

    # 1. 添加列
    op.add_column(
        "agent_chat_sessions",
        sa.Column(
            "parent_session_id",
            sa.String(length=36),
            nullable=True,
            comment="父会话 ID（分支用）",
        ),
    )

    # 2. 添加 FK（ondelete SET NULL）
    op.create_foreign_key(
        "fk_chat_sessions_parent_session",
        "agent_chat_sessions",
        "agent_chat_sessions",
        ["parent_session_id"],
        ["id"],
        ondelete="SET NULL",
    )

    # 3. 添加索引（分支树遍历时按 parent 过滤高频）
    op.create_index(
        "idx_chat_sessions_parent",
        "agent_chat_sessions",
        ["parent_session_id"],
    )


def downgrade() -> None:
    """回滚：先删索引再删 FK 再删列（顺序敏感）"""
    op.drop_index("idx_chat_sessions_parent", table_name="agent_chat_sessions")
    op.drop_constraint(
        "fk_chat_sessions_parent_session",
        "agent_chat_sessions",
        type_="foreignkey",
    )
    op.drop_column("agent_chat_sessions", "parent_session_id")
