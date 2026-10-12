"""add agent_chat_message_versions table (UI-4 message edit/regenerate/branch)

Revision ID: 20260712_0002
Revises: 20260712_0001
Create Date: 2026-07-12 22:55:00.000000

为 agent_chat_messages 表配套新增 agent_chat_message_versions 历史版本表。

背景（V26 P0-5 / 阶段 3 UI 增强）：
  feature-chat-history 方案需要支持消息编辑/重新生成/分支功能，遵循
  "保留所有历史版本（不可物理删除）" 的产品约束。
  现有 AgentChatMessage 表只存储"当前内容"，编辑后旧内容会丢失。
  通过独立历史版本表实现"严格只追加"语义。

设计决策：
  1. 新建独立表 agent_chat_message_versions 而非在 agent_chat_messages
     表加 "current_version" + "parent_version" 列：
     - 单表多版本会让索引/查询变复杂，且与"1 条消息 1 行"的主流范式相悖
     - 独立表 append-only 设计天然契合"不可物理删除"约束
  2. ON DELETE CASCADE：消息物理删除时一并删除其历史版本（与"消息硬删时
     不保留历史"的边界一致；软删除时消息本身还在，版本自然保留）
  3. 索引策略：
     - (message_id) 单列索引：拉取某条消息的全部版本
     - (created_at) 单列索引：按时间范围统计
     - (message_id, created_at) 复合索引：分页拉取时按时间倒序
  4. source 字段限定枚举值（应用层校验）：user-edit / regenerate /
     rollback / initial，避免脏数据
  5. edited_at 字段保存 ChatMessage.editedAt 毫秒时间戳，
     created_at 是服务端入库时间（用于排序与一致性检查）

字段语义（应用层约定）：
  - id: UUID 主键
  - message_id: 关联的 agent_chat_messages.id
  - content: 该版本的内容（旧内容，编辑前的快照）
  - msg_metadata: JSON 字符串，该版本的 llm_metadata 快照
  - source: user-edit / regenerate / rollback / initial
  - note: 简短备注（用户视角的"为什么有这个版本"）
  - edited_at: 该版本的编辑时间（毫秒时间戳，对应 ChatMessage.editedAt）
  - edited_by: 触发编辑的用户 ID（系统自动 regenerate 时为 NULL）
  - created_at: 入库时间（服务端时间）

应用层契约：
  - append_message_version(session, user_id, content, ...) → 创建一条版本记录
  - list_message_versions(session, message_id) → 按时间倒序返回该消息的全部版本
  - update_message(session, user_id, message_id, content, ...) → 写入前先
    append 一条 user-edit/regenerate 快照，再 UPDATE agent_chat_messages.content

注意事项：
1. alembic env.py 已绑定 Base.metadata + settings.database_url（见 alembic/env.py:25-32）
2. MySQL 8 默认 utf8mb4 / utf8mb4_unicode_ci，无需显式声明
3. msg_metadata 使用 JSON 类型（与 AgentChatMessage.llm_metadata 保持一致，
   不同于会话级 metadata_json TEXT — 这里的版本是结构化 LLM 响应元数据）
4. ON DELETE CASCADE 与项目其他版本化表（如 artifact_versions）保持一致
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql
from sqlalchemy.dialects.mysql import JSON as MYSQL_JSON


# revision identifiers, used by Alembic.
revision: str = "20260712_0002"
down_revision: Union[str, None] = "20260712_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """新建 agent_chat_message_versions 历史版本表"""
    # 幂等守卫（2026-10-07 alembic 接入改造补）：init_db() create_all
    # 可能已预建本表，已存在则整体跳过，保证迁移可安全重放
    inspector = sa.inspect(op.get_bind())
    if inspector.has_table("agent_chat_message_versions"):
        return

    op.create_table(
        "agent_chat_message_versions",
        # UUID 主键
        sa.Column(
            "id",
            sa.String(length=36),
            primary_key=True,
            autoincrement=False,
            comment="UUID 主键",
        ),
        # 关联消息 ID
        sa.Column(
            "message_id",
            sa.String(length=36),
            sa.ForeignKey("agent_chat_messages.id", ondelete="CASCADE"),
            nullable=False,
            comment="所属消息 ID",
        ),
        # 该版本内容（旧内容，编辑前的快照）
        sa.Column(
            "content",
            sa.Text(),
            nullable=False,
            server_default="",
            comment="该版本的内容",
        ),
        # 该版本的 LLM 元数据快照
        sa.Column(
            "msg_metadata",
            MYSQL_JSON(),
            nullable=True,
            comment="该版本的 LLM 元数据快照",
        ),
        # 版本来源：user-edit / regenerate / rollback / initial
        sa.Column(
            "source",
            sa.String(length=20),
            nullable=False,
            server_default="user-edit",
            comment="版本来源：user-edit / regenerate / rollback / initial",
        ),
        # 简短备注
        sa.Column(
            "note",
            sa.String(length=200),
            nullable=True,
            comment="简短备注（用户视角）",
        ),
        # 该版本的编辑时间（毫秒时间戳）
        sa.Column(
            "edited_at",
            sa.BigInteger(),
            nullable=True,
            comment="该版本的编辑时间（毫秒）",
        ),
        # 触发编辑的用户 ID
        sa.Column(
            "edited_by",
            sa.String(length=36),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
            comment="触发编辑的用户 ID",
        ),
        # 入库时间
        sa.Column(
            "created_at",
            mysql.TIMESTAMP(fsp=3),
            server_default=sa.func.current_timestamp(3),
            nullable=False,
            comment="入库时间（服务端时间）",
        ),
    )

    # 复合索引：拉取某条消息的全部版本（按时间倒序）
    op.create_index(
        "idx_chat_message_versions_message",
        "agent_chat_message_versions",
        ["message_id"],
        unique=False,
    )
    op.create_index(
        "idx_chat_message_versions_created_at",
        "agent_chat_message_versions",
        ["created_at"],
        unique=False,
    )
    op.create_index(
        "idx_chat_message_versions_msg_created",
        "agent_chat_message_versions",
        ["message_id", "created_at"],
        unique=False,
    )


def downgrade() -> None:
    """回滚：删除 agent_chat_message_versions 表"""
    op.drop_index(
        "idx_chat_message_versions_msg_created",
        table_name="agent_chat_message_versions",
    )
    op.drop_index(
        "idx_chat_message_versions_created_at",
        table_name="agent_chat_message_versions",
    )
    op.drop_index(
        "idx_chat_message_versions_message",
        table_name="agent_chat_message_versions",
    )
    op.drop_table("agent_chat_message_versions")
