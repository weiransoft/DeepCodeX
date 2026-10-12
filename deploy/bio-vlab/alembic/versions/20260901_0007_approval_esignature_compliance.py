"""审批电子签名合规字段（21 CFR Part 11 专项：Round 16 遗留项①）

背景（电子签名合规专项，design/ESIGNATURE_COMPLIANCE_PLAN_v1.0.md）：
    审批签名此前存在三个合规缺口：签批凭证不验证、签名哈希混入未存储
    的墙钟时间戳导致事后不可复算、审批单无指定责任人字段。本迁移为
    approval_requests 表新增两个合规字段，配合 ApprovalManager 的
    HMAC-SHA256 可复算签名结构与凭证真实验证。

变更内容：
    1. assigned_approver: VARCHAR(36)，指定责任人（FK users.id，
                          NULL=未指定）；该审批单仅此人可签批，委托
                          成功后改派为被委托人；带外键约束
                          fk_approval_assigned_approver_users，与
                          models.ApprovalRequest 的 ForeignKey 声明
                          保持一致（ondelete=SET NULL，用户被删时
                          审批单保留但恢复为"未指定"状态）；
    2. signed_at:         TIMESTAMP(3)，签名时间（UTC，秒精度截断），
                          既是 Part 11 §11.50 签名 manifestation 的时间
                          要求，又作为 HMAC 签名输入的组成字段（签名
                          输入全部可持久化复现）。

回滚策略：先删除外键约束再删除两列（MySQL 不允许删除被外键引用的
列，必须先 drop_constraint）；本迁移仅新增可空列，不承载既有数据
语义，零 DROP 既有结构；历史行的 signed_at 保持 NULL，
verify_signature 如实报 False。
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql


# revision identifiers, used by Alembic.
revision: str = "20260901_0007"
down_revision: Union[str, None] = "20260901_0006"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# 外键约束名：与 models.ApprovalRequest.assigned_approver 声明对应，
# 命名遵循「fk_<表>_<列>_<引用表>」约定，便于运维定位与回滚
_FK_ASSIGNED_APPROVER = "fk_approval_requests_assigned_approver_users"


def upgrade() -> None:
    """新增审批电子签名合规两字段（指定责任人 / 签名时间）+ 外键约束"""
    # 幂等守卫（2026-10-07 alembic 接入改造补）：init_db() create_all
    # 可能已预建 assigned_approver 列，已存在则整体跳过，保证迁移可安全重放
    inspector = sa.inspect(op.get_bind())
    existing_cols = {c["name"] for c in inspector.get_columns("approval_requests")}
    if "assigned_approver" in existing_cols:
        return
    # 指定责任人：NULL=未指定（任何通过项目级写权限校验者均可签）
    op.add_column(
        "approval_requests",
        sa.Column("assigned_approver", sa.String(length=36), nullable=True,
                  comment="指定责任人（仅此人可签批，NULL=未指定）"),
    )
    # 签名时间（UTC，秒精度截断）：HMAC 签名输入组成字段，保证可复算
    op.add_column(
        "approval_requests",
        sa.Column("signed_at", mysql.TIMESTAMP(fsp=3), nullable=True,
                  comment="签名时间（UTC，秒精度，可复算签名输入字段）"),
    )
    # 指定责任人外键约束：引用 users.id，用户被删时置 NULL（SET NULL），
    # 保证审批单本身不被级联删除（审计痕迹不可随用户删除而丢失）
    op.create_foreign_key(
        _FK_ASSIGNED_APPROVER,
        source_table="approval_requests",
        referent_table="users",
        local_cols=["assigned_approver"],
        remote_cols=["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    """删除审批电子签名合规两字段（先删外键约束，再删列）"""
    # MySQL 要求先解除外键引用才能删除被引用列，顺序不可颠倒
    op.drop_constraint(_FK_ASSIGNED_APPROVER, "approval_requests", type_="foreignkey")
    op.drop_column("approval_requests", "signed_at")
    op.drop_column("approval_requests", "assigned_approver")
