"""add agent_chat_messages.content FULLTEXT index (P2-4 search)

Revision ID: 20260713_0001
Revises: 20260712_0002
Create Date: 2026-07-13 10:00:00.000000

P2-4 优化：为 agent_chat_messages.content 字段添加 FULLTEXT 索引以支持全文搜索。

设计决策：
1. 使用 MySQL 5.7+ InnoDB FULLTEXT（与项目 MySQL 8 默认一致）
2. 索引名 ftx_chat_messages_content（ftx_ 前缀 = FULLTEXT 索引）
3. 不使用 MATCH AGAINST ngram parser：保持简单，LIKE 路径在已有索引上仍能命中
4. 字段已为 NOT NULL（应用层保证非空）
5. 无需升级大表：InnoDB 在线 DDL 即可（ALGORITHM=INPLACE）

应用层使用：
- service.search_messages 使用 LIKE 走索引扫描
- 端点 /agent-chat/search 暴露此能力
- 前端 /agent-history 集成搜索 UI + HighlightText 组件

降级：删除索引即可，不影响数据完整性
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "20260713_0001"
down_revision: Union[str, None] = "20260712_0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """为 agent_chat_messages.content 添加 FULLTEXT 索引

    注意：
    - SQLite 无 FULLTEXT 概念，但 _create_all_tables 会跳过此步骤
    - 生产 MySQL 8 默认支持 InnoDB FULLTEXT，无需额外配置
    - 在线 DDL：使用 ALGORITHM=INPLACE 不阻塞读
    """
    # 实际生产执行时使用 raw SQL
    # SQLite 测试环境会忽略此语句（_create_all_tables 检测 dialect）
    bind = op.get_bind()
    if bind.dialect.name == "mysql":
        # 幂等守卫（2026-10-07 alembic 接入改造补）：索引已存在则跳过
        existing = {
            ix["name"]
            for ix in sa.inspect(bind).get_indexes("agent_chat_messages")
        }
        if "ftx_chat_messages_content" in existing:
            return
        # [D4 修复 2026-10-09] 原语句 `... (content) ALGORITHM=INPLACE
        # LOCK=NONE` 在 MySQL 8.0.36 实测报 1064 语法错误（ALGORITHM/LOCK
        # 必须以逗号分隔）；改逗号后 LOCK=NONE 又被 1846 拒绝——FULLTEXT
        # 索引创建强制要锁（"Reason: Fulltext index creation requires a
        # lock. Try LOCK=SHARED"）。最终采用 `, ALGORITHM=INPLACE`：在线
        # 重建不锁表写全停，MySQL 自动选择允许的最宽松锁（SHARED，读不
        # 阻塞），无需也不允许显式 LOCK=NONE。
        op.execute(
            "ALTER TABLE agent_chat_messages "
            "ADD FULLTEXT INDEX ftx_chat_messages_content (content), "
            "ALGORITHM=INPLACE"
        )
    # SQLite / 其他：no-op（service.search_messages 仍可用 LIKE %keyword% 走主索引扫描）


def downgrade() -> None:
    """回滚：删除 FULLTEXT 索引"""
    bind = op.get_bind()
    if bind.dialect.name == "mysql":
        op.execute(
            "ALTER TABLE agent_chat_messages "
            "DROP INDEX ftx_chat_messages_content"
        )
