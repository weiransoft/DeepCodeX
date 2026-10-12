"""add agent_chat_sessions.metadata_json column (P0-5 chat history persistence)

Revision ID: 20260712_0001
Revises: 20260707_0004
Create Date: 2026-07-12 00:01:00.000000

为 agent_chat_sessions 表新增 metadata_json 列，用于存储会话级别的扩展元信息。

背景（架构师审查 P0-5）：
  feature-chat-history 方案需要在会话级别支持 is_starred（收藏）等扩展字段。
  当前 AgentChatSession 模型（app/core/virtual_lab/models.py:417-452）只提供：
  - title / industry / route_key / entity_id（基础元信息）
  - message_count / last_message_at / last_client_id（统计字段）
  - status（active/archived/deleted）
  无通用元信息承载位。直接修改表结构添加 is_starred BOOLEAN 列会破坏扩展性，
  后续若需要更多会话级扩展字段（is_pinned / shared_with / theme_color 等）会反复 migration。

设计决策：
  1. 采用 metadata_json TEXT 列（与项目 llm_metadata / page_context JSON 字段保持一致）
     - TEXT 而非 JSON 类型：避免 MySQL 5.7 JSON 字段索引限制，TEXT + 应用层 json.dumps/loads
       是项目现有惯例（见 AgentChatMessage.page_context / llm_metadata）
  2. nullable=True：现有会话记录无需回填，应用层缺省为 '{}'
  3. 不加索引：会话级扩展字段的查询走 owner_user_id 主索引，metadata 内的字段
     无高频精确查询需求（is_starred 通过 status 类似的轻量字段应用层过滤即可）
  4. 不加 server_default：JSON 序列化由应用层负责，避免 MySQL JSON_VALID 校验与
     SQLAlchemy 序列化的兼容问题

字段语义（应用层约定）：
  metadata_json 内容为 JSON 字符串，可包含：
  - is_starred: bool  收藏标记
  - starred_at: str   ISO 8601 收藏时间
  - is_pinned: bool   置顶标记（未来扩展）
  - shared_with: list 共享用户列表（未来扩展，V26 团队协作场景）
  - theme_color: str  会话主题色（UI 个性化扩展）

应用层契约：
  - 读取：json.loads(sess.metadata_json) if sess.metadata_json else {}
  - 写入：sess.metadata_json = json.dumps(metadata_dict, ensure_ascii=False)
  - PATCH 端点通过 AgentChatSessionUpdate.is_starred 触发更新（agent_chat.py:212-234）

注意事项：
1. alembic env.py 已绑定 Base.metadata + settings.database_url（见 alembic/env.py:25-32）
2. MySQL 8 默认 utf8mb4 / utf8mb4_unicode_ci，无需显式声明
3. nullable=True 与现有 AgentChatSession 其他可选字段一致
4. TEXT 类型足够（典型 metadata < 2KB）
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "20260712_0001"
down_revision: Union[str, None] = "20260707_0004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """为 agent_chat_sessions 表新增 metadata_json 扩展字段列"""
    # 幂等守卫（2026-10-07 alembic 接入改造补）：init_db() create_all
    # 或 20260713_0003 可能已添加本列，已存在则跳过，保证迁移可安全重放
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing_cols = {c["name"] for c in inspector.get_columns("agent_chat_sessions")}
    if "metadata_json" in existing_cols:
        return

    # 新增 metadata_json 列：nullable=True（应用层缺省为 '{}'）
    # TEXT 类型（不是 JSON）— 与项目中 page_context / llm_metadata 字段保持一致
    # 原因：项目惯例用 TEXT + 应用层 json.dumps/loads，避免 MySQL JSON 字段约束
    op.add_column(
        "agent_chat_sessions",
        sa.Column(
            "metadata_json",
            sa.Text(),
            nullable=True,
            comment="会话元信息 JSON 字符串：is_starred / starred_at 等扩展字段",
        ),
    )


def downgrade() -> None:
    """回滚：删除 agent_chat_sessions.metadata_json 列"""
    op.drop_column("agent_chat_sessions", "metadata_json")
