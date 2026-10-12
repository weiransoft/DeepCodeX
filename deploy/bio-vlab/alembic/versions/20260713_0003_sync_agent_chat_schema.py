"""
同步 agent_chat_* 表 schema 与 ORM 模型定义（2026-07-13）

背景：
- 历史 alembic 链 20260703_0001 因 SQLAlchemy 兼容问题（sa.TIMESTAMP(fsp=3)）无法升级
- 导致生产 DB 中 agent_chat_sessions / agent_chat_messages 缺少 9 + 6 个字段
- 端点测试因此失败（Query ORM 期望字段时 DB 报 1054 Unknown column）

目的：
- 添加 ORM 模型声明但 DB 缺失的 15 个列
- 添加 9 个缺失索引
- 严格按 ORM 定义补齐，不引入业务逻辑变更

差异列表（2026-07-13 扫描）：
[agent_chat_messages] 缺 9 列 + 4 索引
  - sender_role VARCHAR(100) NULL
  - sender_name VARCHAR(200) NULL
  - message_type VARCHAR(50) NULL
  - round INTEGER NULL
  - mentioned_roles JSON NULL
  - mentioned_roles_schema_version VARCHAR(20) NULL
  - attachments JSON NULL
  - attachments_schema_version VARCHAR(20) NULL
  - confidence DECIMAL(5,4) NULL
  - idx_chat_messages_session
  - idx_chat_messages_round
  - idx_chat_messages_created_at
  - idx_chat_messages_client_msg_id

[agent_chat_sessions] 缺 6 列 + 4 索引
  - project_id VARCHAR(36) NULL
  - topic VARCHAR(500) NULL
  - mode VARCHAR(50) NULL
  - consensus_reached BOOLEAN NULL
  - verdict TEXT NULL
  - metadata_json TEXT NULL
  - idx_chat_sessions_owner_status
  - idx_chat_sessions_owner
  - idx_chat_sessions_status
  - idx_chat_sessions_project

注意：
- 所有列 nullable=True / 无 server_default → 不影响现有数据
- JSON 类型在 MySQL 中建为 JSON 而非 TEXT（ORM 用 JSON）
  - 已存数据：从 ORM 模型看，page_context / llm_metadata 在项目惯例中
    存储 JSON 字符串，应用层用 json.dumps/loads → 添加 JSON 列不会破坏
    现有应用（应用层未变）
- metadata_json 之前手工应用但当前 DB 中缺失 → 此 migration 重新添加
- ON DELETE CASCADE / SET NULL 在添加 FK 时一并加（project_id CASCADE，
  parent_session_id SET NULL 已在 20260713_0002 添加）

存量库接入说明（2026-10-07 alembic 接入改造）：
    本版本是 agent_chat_* 系列历史漂移（列 / 索引 / FK）的**收敛终点**。
    存量库经 alembic 从 baseline 回放增量链时必须真实执行本版本，
    才能把 agent_chat_messages / agent_chat_sessions 对齐 ORM 定义——
    因此本版本 upgrade **不做整体跳过式幂等守卫**（逐列/逐索引/逐 FK
    的存在性检查已内置，重复执行安全）；历史版本 20260707_0003 /
    20260707_0004 / 20260712_0001 / 20260712_0002 / 20260713_0001 /
    20260713_0002 已补"预建即跳过"守卫，其修复目标在本版本统一兜底。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "20260713_0003"
down_revision: Union[str, None] = "20260713_0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _column_exists(bind, table_name: str, column_name: str) -> bool:
    """检查列是否已存在（幂等保护：反复 apply 不报错）"""
    inspector = sa.inspect(bind)
    if not inspector.has_table(table_name):
        return False
    return any(c["name"] == column_name for c in inspector.get_columns(table_name))


def _index_exists(bind, table_name: str, index_name: str) -> bool:
    """检查索引是否已存在"""
    inspector = sa.inspect(bind)
    return any(
        ix["name"] == index_name
        for ix in inspector.get_indexes(table_name)
    )


def _fk_exists(bind, table_name: str, fk_name: str) -> bool:
    """检查 FK 是否已存在"""
    inspector = sa.inspect(bind)
    return any(
        fk.get("name") == fk_name
        for fk in inspector.get_foreign_keys(table_name)
    )


def upgrade() -> None:
    """补齐 agent_chat_messages / agent_chat_sessions 缺失字段 + 索引"""
    bind = op.get_bind()

    # ============================================================
    # 1. agent_chat_messages - 9 列
    # ============================================================
    msg_columns = [
        ("sender_role", sa.String(length=100), "虚拟实验室：发送者角色"),
        ("sender_name", sa.String(length=200), "虚拟实验室：发送者名称"),
        ("message_type", sa.String(length=50),
         "discussion/opinion/question/suggestion/verdict"),
        ("round", sa.Integer(), "虚拟实验室：讨论轮次"),
        ("mentioned_roles", sa.JSON(), "虚拟实验室：被 @ 角色列表"),
        ("mentioned_roles_schema_version", sa.String(length=20),
         "mentioned_roles schema 版本"),
        ("attachments", sa.JSON(), "虚拟实验室：附件元数据"),
        ("attachments_schema_version", sa.String(length=20),
         "attachments schema 版本"),
        ("confidence", sa.Numeric(precision=5, scale=4),
         "虚拟实验室：置信度 0.0000-1.0000"),
    ]
    for col_name, col_type, comment in msg_columns:
        if not _column_exists(bind, "agent_chat_messages", col_name):
            op.add_column(
                "agent_chat_messages",
                sa.Column(col_name, col_type, nullable=True, comment=comment),
            )

    # agent_chat_messages 索引
    msg_indexes = [
        ("idx_chat_messages_session", "session_id", False),
        ("idx_chat_messages_round", "round", False),
        ("idx_chat_messages_created_at", "created_at", False),
    ]
    for ix_name, col_name, unique in msg_indexes:
        if not _index_exists(bind, "agent_chat_messages", ix_name):
            op.create_index(
                ix_name, "agent_chat_messages", [col_name], unique=unique,
            )

    # idx_chat_messages_client_msg_id 是 (session_id, client_msg_id) 复合索引
    if not _index_exists(bind, "agent_chat_messages", "idx_chat_messages_client_msg_id"):
        op.create_index(
            "idx_chat_messages_client_msg_id",
            "agent_chat_messages",
            ["session_id", "client_msg_id"],
        )

    # ============================================================
    # 2. agent_chat_sessions - 6 列
    # ============================================================
    sess_columns = [
        ("project_id", sa.String(length=36), "所属研究项目 ID"),
        ("topic", sa.String(length=500), "虚拟实验室：讨论主题"),
        ("mode", sa.String(length=50), "虚拟实验室：讨论模式"),
        ("consensus_reached", sa.Boolean(), "虚拟实验室：是否达成共识"),
        ("verdict", sa.Text(), "虚拟实验室：最终结论"),
        ("metadata_json", sa.Text(),
         "会话元信息 JSON：is_starred / starred_at 等扩展字段"),
    ]
    for col_name, col_type, comment in sess_columns:
        if not _column_exists(bind, "agent_chat_sessions", col_name):
            op.add_column(
                "agent_chat_sessions",
                sa.Column(col_name, col_type, nullable=True, comment=comment),
            )

    # agent_chat_sessions 索引
    sess_indexes = [
        ("idx_chat_sessions_owner", "owner_user_id", False),
        ("idx_chat_sessions_status", "status", False),
    ]
    for ix_name, col_name, unique in sess_indexes:
        if not _index_exists(bind, "agent_chat_sessions", ix_name):
            op.create_index(
                ix_name, "agent_chat_sessions", [col_name], unique=unique,
            )

    # 复合索引 idx_chat_sessions_owner_status (owner_user_id, status)
    if not _index_exists(bind, "agent_chat_sessions", "idx_chat_sessions_owner_status"):
        op.create_index(
            "idx_chat_sessions_owner_status",
            "agent_chat_sessions",
            ["owner_user_id", "status"],
        )

    # 索引 idx_chat_sessions_project
    if not _index_exists(bind, "agent_chat_sessions", "idx_chat_sessions_project"):
        op.create_index(
            "idx_chat_sessions_project",
            "agent_chat_sessions",
            ["project_id"],
        )

    # ============================================================
    # 3. agent_chat_sessions.project_id FK → research_projects.id
    # ON DELETE CASCADE（与 ORM 保持一致）
    # ============================================================
    if not _fk_exists(bind, "agent_chat_sessions", "fk_chat_sessions_project"):
        op.create_foreign_key(
            "fk_chat_sessions_project",
            "agent_chat_sessions",
            "research_projects",
            ["project_id"],
            ["id"],
            ondelete="CASCADE",
        )


def downgrade() -> None:
    """回滚：删除本次添加的列 + 索引 + FK（按反向顺序）"""
    bind = op.get_bind()

    # 1. FK
    if _fk_exists(bind, "agent_chat_sessions", "fk_chat_sessions_project"):
        op.drop_constraint(
            "fk_chat_sessions_project",
            "agent_chat_sessions",
            type_="foreignkey",
        )

    # 2. 索引
    for ix_name in [
        "idx_chat_sessions_project",
        "idx_chat_sessions_owner_status",
        "idx_chat_sessions_status",
        "idx_chat_sessions_owner",
    ]:
        if _index_exists(bind, "agent_chat_sessions", ix_name):
            op.drop_index(ix_name, table_name="agent_chat_sessions")

    for ix_name in [
        "idx_chat_messages_client_msg_id",
        "idx_chat_messages_created_at",
        "idx_chat_messages_round",
        "idx_chat_messages_session",
    ]:
        if _index_exists(bind, "agent_chat_messages", ix_name):
            op.drop_index(ix_name, table_name="agent_chat_messages")

    # 3. 列
    for col_name in [
        "metadata_json", "verdict", "consensus_reached",
        "mode", "topic", "project_id",
    ]:
        if _column_exists(bind, "agent_chat_sessions", col_name):
            op.drop_column("agent_chat_sessions", col_name)

    for col_name in [
        "confidence", "attachments_schema_version", "attachments",
        "mentioned_roles_schema_version", "mentioned_roles",
        "round", "message_type", "sender_name", "sender_role",
    ]:
        if _column_exists(bind, "agent_chat_messages", col_name):
            op.drop_column("agent_chat_messages", col_name)
