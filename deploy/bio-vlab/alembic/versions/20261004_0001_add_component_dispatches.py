"""新增 component_dispatches 表（组件按需调度门面 + GPU 占用排队 · ARCH-CMP-SCHED-001）

背景（组件按需调度门面 / PRD-CMP-SCHED-001）：
    POST /protein/af3/predict 接入 ComponentDispatchFacade 后，GPU 组件
    未运行/无空闲 GPU 的预测请求进入 DB 排队（而非直接 502）。排队中间态
    必须跨进程持久（uvicorn 与 Celery worker 是不同进程，进程内队列不可靠），
    故新增 component_dispatches 表承载派发状态机：
    queued → allocated → starting → running → completed | failed |
    timeout | cancelled（queued 可直接 cancelled）。

变更内容：
    CREATE TABLE component_dispatches（UUID 主键、capability/executor/
    component_id、status 状态机、priority 优先级、caller_source/user_id、
    payload JSON、timeout_seconds、next_attempt_at 退避、claimed_by +
    lease_expires_at 认领租约、queued_at/finished_at 时间戳、
    error_message/result）+ 3 个二级索引：
    - ix_component_dispatches_status_next_attempt：sweep 认领扫描主路径
    - ix_component_dispatches_queue_order：queued 位次查询（FIFO + 优先级）
    - ix_component_dispatches_capability：观测端点按能力分组

防御说明：
    upgrade 前用 inspector.has_table 检查表是否已存在（init_db() create_all
    预建场景），已存在则整体跳过，保证幂等。

回滚策略：
    downgrade DROP TABLE component_dispatches。该表为调度运行态数据，
    回滚仅影响排队功能（旧行为不依赖该表），非生产严禁在有 queued 行时回滚。
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.mysql import JSON, TIMESTAMP


# revision identifiers, used by Alembic.
revision: str = "20261004_0001"
# 接入 alembic 正式版本链（2026-10-07 改造）：保持 down_revision
# 原始值 20261001_0001 不动——本版本是历史增量子链末端，子链
# 仅作"已发生历史"的档案保留，不作为任何库的升级路径（真库实测
# 子链不可安全整体重放，见 20261007_00001/00002 头注释）。
# 曾尝试把本版本 merge 到 20261007_00002：因 00002 的 merge 父
# 已包含本版本，双向互指构成环（CycleDetected），已回退。
down_revision: Union[str, None] = "20261001_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """创建 component_dispatches 表（幂等：inspector.has_table 防御）"""
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if inspector.has_table("component_dispatches"):
        return

    op.create_table(
        "component_dispatches",
        sa.Column(
            "id", sa.String(length=36), primary_key=True, comment="UUID 主键"
        ),
        sa.Column(
            "capability",
            sa.String(length=50),
            nullable=False,
            comment="能力标识",
        ),
        sa.Column(
            "executor",
            sa.String(length=50),
            nullable=False,
            comment="锁定的执行器标识",
        ),
        sa.Column(
            "component_id",
            sa.String(length=50),
            nullable=True,
            comment="关联组件业务 ID（可空）",
        ),
        sa.Column(
            "status",
            sa.String(length=20),
            nullable=False,
            comment="状态机：queued/allocated/starting/running/completed/failed/timeout/cancelled",
        ),
        sa.Column(
            "priority",
            sa.Integer(),
            nullable=False,
            server_default="0",
            comment="优先级，越大越先出队",
        ),
        sa.Column(
            "caller_source",
            sa.String(length=50),
            nullable=False,
            comment="调用来源标识",
        ),
        sa.Column("user_id", sa.String(length=36), nullable=True, comment="发起用户 ID"),
        sa.Column("payload", JSON(), nullable=False, comment="执行载荷 JSON"),
        sa.Column(
            "timeout_seconds",
            sa.Float(),
            nullable=True,
            comment="任务级超时（秒），NULL=用全局默认",
        ),
        sa.Column(
            "next_attempt_at",
            TIMESTAMP(fsp=3),
            nullable=True,
            comment="失败退避到期时间（NULL=可立即认领）",
        ),
        sa.Column(
            "last_attempt_at",
            TIMESTAMP(fsp=3),
            nullable=True,
            comment="最近一次尝试时间",
        ),
        sa.Column(
            "claimed_by",
            sa.String(length=100),
            nullable=True,
            comment="原子认领者标识",
        ),
        sa.Column(
            "lease_expires_at",
            TIMESTAMP(fsp=3),
            nullable=True,
            comment="认领租约到期时间",
        ),
        sa.Column(
            "queued_at",
            TIMESTAMP(fsp=3),
            nullable=True,
            comment="入队时间（超时与位次计算基准）",
        ),
        sa.Column(
            "finished_at",
            TIMESTAMP(fsp=3),
            nullable=True,
            comment="终态时间",
        ),
        sa.Column("error_message", sa.Text(), nullable=True, comment="失败或超时原因"),
        sa.Column(
            "result", JSON(), nullable=True, comment="执行结果 / 回退链报告 JSON"
        ),
        sa.Column(
            "created_at",
            TIMESTAMP(fsp=3),
            server_default=sa.text("CURRENT_TIMESTAMP(3)"),
            nullable=True,
            comment="创建时间",
        ),
        sa.Column(
            "updated_at",
            TIMESTAMP(fsp=3),
            server_default=sa.text("CURRENT_TIMESTAMP(3)"),
            nullable=True,
            comment="更新时间",
        ),
    )
    op.create_index(
        "ix_component_dispatches_status_next_attempt",
        "component_dispatches",
        ["status", "next_attempt_at"],
        unique=False,
    )
    op.create_index(
        "ix_component_dispatches_queue_order",
        "component_dispatches",
        ["status", "priority", "created_at"],
        unique=False,
    )
    op.create_index(
        "ix_component_dispatches_capability",
        "component_dispatches",
        ["capability"],
        unique=False,
    )


def downgrade() -> None:
    """回滚：删除 component_dispatches 表（调度运行态数据，旧行为不依赖）"""
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not inspector.has_table("component_dispatches"):
        return

    op.drop_index(
        "ix_component_dispatches_capability", table_name="component_dispatches"
    )
    op.drop_index(
        "ix_component_dispatches_queue_order", table_name="component_dispatches"
    )
    op.drop_index(
        "ix_component_dispatches_status_next_attempt",
        table_name="component_dispatches",
    )
    op.drop_table("component_dispatches")
