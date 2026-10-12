"""add user_agent_profiles table (P1-1 identity/working_style split)

Revision ID: 20260707_0002
Revises: 20260707_0001
Create Date: 2026-07-07 00:02:00.000000

新增 user_agent_profiles 表（P1-1 身份/工作风格切分）：
允许用户为指定角色定制身份描述（identity_prompt），而保持角色的
工作风格描述（working_style_prompt）不变。

设计哲学（Claude Science "Identity vs Working Style"）：
  system_prompt = identity_prompt + working_style_prompt
  - identity_prompt: 用户可替换（"你是一个专注于 EGFR 的药物研究员..."）
  - working_style_prompt: 始终继承角色默认（"严谨第一/不确定性透明..."）

表结构：
  - id: UUID 主键（32 位无连字符十六进制）
  - user_id: 所属用户（FK users.id，CASCADE 删除）
  - role_key: 基础角色 key（如 drug-researcher，不加 FK，角色定义在 YAML）
  - identity_prompt: 用户自定义身份描述（Text，NOT NULL）
  - display_name: 自定义显示名（可选，前端展示用）
  - is_active: 是否启用（默认 True，False 时回退到角色默认）
  - created_at / updated_at: 时间戳

约束：
  - UNIQUE(user_id, role_key)：同一用户对同一角色只能有一个自定义 profile
  - INDEX(user_id)：按用户查询其所有自定义 profile

数据流：
  1. 用户通过 API 创建 UserAgentProfile（POST /api/v1/users/{user_id}/agent-profiles）
  2. BaseAgent.__init__ 接收 user_id 参数（由 agent_core.py 从 context 注入）
  3. BaseAgent.get_system_prompt() 查询 UserAgentProfile：
     - 命中且 is_active=True：用 user_profile.identity_prompt 替换 role.identity_prompt
     - 未命中或 is_active=False：回退到 role.identity_prompt
  4. working_style_prompt 始终来自 role，不受 UserAgentProfile 影响

注意事项：
1. alembic env.py 已绑定 Base.metadata + settings.database_url
2. MySQL 8 默认 utf8mb4 / utf8mb4_unicode_ci，无需显式声明
3. TIMESTAMP(3) 保留毫秒精度，与现有模型一致
4. role_key 不加外键约束，因为角色定义在 YAML 中而非数据库表
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql


# revision identifiers, used by Alembic.
revision: str = "20260707_0002"
down_revision: Union[str, None] = "20260707_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """创建 user_agent_profiles 表（P1-1 身份/工作风格切分）"""
    # 幂等守卫（2026-10-07 alembic 接入改造补）：init_db() create_all
    # 可能已预建本表，已存在则整体跳过，保证迁移可安全重放
    inspector = sa.inspect(op.get_bind())
    if inspector.has_table("user_agent_profiles"):
        return

    op.create_table(
        "user_agent_profiles",
        # UUID 主键，32 位无连字符十六进制字符串
        sa.Column(
            "id",
            sa.String(length=36),
            primary_key=True,
            comment="UUID 主键",
        ),
        # 所属用户，关联 users 表，用户删除时级联删除其自定义 profile
        sa.Column(
            "user_id",
            sa.String(length=36),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            comment="所属用户 ID",
        ),
        # 基础角色 key，引用 YAML profile 的 role_key（如 drug-researcher）
        # 不加外键约束，因为角色定义在 YAML 中而非数据库
        sa.Column(
            "role_key",
            sa.String(length=100),
            nullable=False,
            comment="基础角色 key（如 drug-researcher）",
        ),
        # 用户自定义身份描述，将替换角色的 identity_prompt
        # working_style_prompt 始终继承角色默认，不存储在此表中
        sa.Column(
            "identity_prompt",
            sa.Text(),
            nullable=False,
            comment="用户自定义身份描述",
        ),
        # 自定义显示名（可选），用于前端展示区分不同自定义 profile
        sa.Column(
            "display_name",
            sa.String(length=100),
            nullable=True,
            comment="自定义显示名",
        ),
        # 是否启用，False 时 BaseAgent 回退到角色默认 identity_prompt
        sa.Column(
            "is_active",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("1"),
            comment="是否启用",
        ),
        # 创建时间，服务器自动填充当前时间
        sa.Column(
            "created_at",
            mysql.TIMESTAMP(fsp=3),
            server_default=sa.func.now(),
            nullable=False,
            comment="创建时间",
        ),
        # 更新时间，记录更新时自动刷新
        sa.Column(
            "updated_at",
            mysql.TIMESTAMP(fsp=3),
            server_default=sa.func.now(),
            nullable=False,
            comment="更新时间",
        ),
        # 唯一约束：同一用户对同一角色只能有一个自定义 profile
        sa.UniqueConstraint(
            "user_id",
            "role_key",
            name="uq_user_agent_profile_role",
        ),
    )

    # 索引：按用户查询其所有自定义 profile
    op.create_index(
        "ix_user_agent_profiles_user_id",
        "user_agent_profiles",
        ["user_id"],
    )


def downgrade() -> None:
    """回滚：删除 user_agent_profiles 表"""
    # 先删索引，再删表（MySQL 删表会自动级联删索引，显式删除便于审计）
    op.drop_index(
        "ix_user_agent_profiles_user_id",
        table_name="user_agent_profiles",
    )
    op.drop_table("user_agent_profiles")
