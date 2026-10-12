"""Alembic 基线版本（空操作）：schema 所有权移交 alembic 的逻辑锚点（2026-10-07）

Revision ID: 20261007_00001
Revises: 无（down_revision=None，全链根）
Create Date: 2026-10-07 00:00:00.000000

版本链位置（全链单线，head 见 20261007_00002 docstring）：
    20261007_00001(本版本, 空 baseline, down=None)
        → 20260703_0001 → … 33 个历史增量 … → 20261004_0001
        → 20261007_00002(全量建表) ← 唯一 head

    两种库的接入方法（现行有效流程，均经一次性测试库/真库实测）：
    存量库（已有全部/大部分表，如 bio_lab_v2）：
        alembic stamp 20261007_00002   # 指针直接放到 head（现状=目标态）
        alembic upgrade head           # no-op 验证
        历史子链**不回放**（见下方决策依据 1）。
    新   库（空库全量建表）：
        alembic stamp --purge 20261004_0001  # 指针占位子链末端
        alembic upgrade head                 # 线形拓扑：仅执行 00002 create_all
        【为什么占位而不是 stamp baseline：从 baseline 出发
         `upgrade head` 会逐一回放 34 个历史增量——增量 CREATE
         TABLE 依赖 create_all 预建的基表（workflows 等），空库
         首步即 1824（2026-10-07 一次性测试库实测踩坑）。占位到
         子链末端后，线形拓扑下 upgrade head 只剩 00002 一步。】

    【拓扑决策依据（2026-10-07 一次性测试库 + 真库实测）】
    1. 历史子链（20260703_0001…20261004_0001）作为"已发生历史"
       的档案保留在链上，不作为任何库的升级路径。真库回放实测
       暴露两类不可安全重放问题：MySQL 动态外键名漂移（1826
       重复约束名）、增量 CREATE TABLE 列定义与现行 ORM 漂移。
       已逐一补 inspector 幂等守卫的部分可以继续，但无法保证
       子链对异环境库整体可重放——诚实结论：档案保留。
    2. 曾尝试 merge / branch label 拓扑把全量版本从 baseline 短
       路径分出。alembic 对 merge+branch label 组合的路由不可控
       （实测强制走无名主干、且 merge 节点不能再携带 branch
       label），放弃；最终采用线形拓扑——行为确定、可验证。

背景（alembic 正式接入改造）：
    本平台历史上有两条建表路径：
      1. scripts/migrate.py 的 19 个裸 DDL（已 deprecated）；
      2. 应用启动 init_db() 的 Base.metadata.create_all（全量补建）。
    两条路径都不记录版本，schema 所有权游离在 alembic 之外。
    本 baseline 是 alembic 管辖的逻辑起点标记，upgrade/downgrade
    均为空操作（SELECT 1），不触碰任何表。

本 baseline 的剩余用途：
    - downgrade 链的终点占位（`alembic downgrade 20261007_00001`
      把指针退回"接入前"状态，仅改版本行，不动任何表）；
    - 文档性锚点：标记 alembic 正式接入时点（2026-10-07）。

生产红线：
    本版本 upgrade/downgrade 均为空操作，不触碰任何表；
    全链 downgrade 方向严禁在生产库执行（head 版本 00002 的
    downgrade 含全量删表，详见该文件警示）。
"""

from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = "20261007_00001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """
    空操作：baseline 仅作为 alembic 管辖的逻辑起点标记。

    把已存在的库（migrate.py 建的 19 张老表 + create_all 补建的
    增量表）标记为 alembic 管辖起点，本步骤本身不改变任何 schema。
    SELECT 1 仅为让 alembic 产生一次真实往返、确认连接可用。
    """
    op.execute("SELECT 1")


def downgrade() -> None:
    """
    空操作：baseline 不承载任何 schema 状态，回滚亦无操作。

    注意：从 head（20261007_00002）向本版本回滚时，00002 及其前
    各历史增量的 downgrade 会先执行——其中 00002 含全量删表、
    primer_designs/binder_designs 等按红线有意 raise 拒绝——
    危险方向，生产严禁，与本文件无关。
    """
    op.execute("SELECT 1")
