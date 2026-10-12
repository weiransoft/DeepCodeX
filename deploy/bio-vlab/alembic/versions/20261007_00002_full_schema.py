"""全量建表版本（head）：用应用当前 SQLAlchemy 元数据一次性建出全部表（2026-10-07）

Revision ID: 20261007_00002
Revises: 20261004_0001（历史增量子链末端）——本版本为当前唯一 head
Create Date: 2026-10-07 00:00:00.000000

版本链位置（全链单线，根见 20261007_00001 docstring）：
    20261007_00001(空 baseline, down=None)
        → 20260703_0001 → … 33 个历史增量 … → 20261004_0001
        → 20261007_00002(本版本) ← 唯一 head

    两条接入路径（2026-10-07 一次性测试库 + 真库实测）：
      存量库：`stamp 20261007_00002` 直接接入 + `upgrade head` 验证
              （no-op）。历史子链**不回放**——真库回放实测暴露
              MySQL 动态外键名漂移（1826）、增量 CREATE TABLE 列
              定义与 ORM 漂移等不可安全重放问题；子链仅作已发生
              历史的档案记录保留；
      新   库：`stamp --purge 20261004_0001`（指针占位子链末端）
              后 `upgrade head`——线形拓扑下仅执行本版本一步
              create_all 全量建表。
              【严禁写法：空库从 baseline（20261007_00001）出发
               `upgrade head`——会逐一回放历史子链，首步
               create_table 引用 workflows 等 create_all 预建基表，
               空库必 1824（2026-10-07 实测踩坑）。】
    本版本 upgrade 幂等（create_all checkfirst），重复执行安全。

用途（新库全量建表 / 存量库终态对齐）：
    upgrade() 调用 Base.metadata.create_all(bind=op.get_bind())，
    按应用**当前** ORM 模型定义建出全部缺失表。create_all 默认
    checkfirst=True，逐表检查存在性、已存在整体跳过——因此：
      - 新空库：一次建出全部表；
      - 存量库（已 stamp 到本版本）：不再执行；若误执行则 no-op。

与增量链的一致性论证：
    历史链中所有 create_table 增量建的列与索引都是当前 ORM 模型的
    子集/演进前态；其 add_column 增量（tools.server、tenant_id、
    env_flags、证书轮换列等）已全部反映在当前 ORM 模型定义里。
    因此 create_all 产出 schema 与"完整回放增量链"终态等价
    （索引命名以 ORM 定义为准）。

生产红线（用户强制约束）：
    1. downgrade() 使用 Base.metadata.drop_all —— 会删除元数据中
       全部业务表。**严禁在生产库（bio_lab_v2）执行 downgrade /
       downgrade base / downgrade <任何版本>！**
    2. CI 流水线默认只跑 `alembic upgrade head`，严禁在 CI 跑
       downgrade 方向。
    3. 本版本 upgrade() 不含任何 DROP 语句，生产 upgrade 安全。
"""

import os
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa  # downgrade 中 SET FOREIGN_KEY_CHECKS 需要

# 导入应用声明式基类：env.py 已加载 app.database，此处取同一 Base 实例，
# import app.models 触发全部模型注册到 Base.metadata（78 张表）
from app.database import Base
import app.models  # noqa: F401  确保全量表注册（独立运行本模块时也生效）


# revision identifiers, used by Alembic.
revision: str = "20261007_00002"
# 纯线形挂历史增量子链末端：全链单线
#   20261007_00001(baseline, down=None) → 20260703_0001 → …
#   → 20261004_0001 → 20261007_00002(本版本) ← 唯一 head
# 不使用 merge / branch label——alembic 对 merge+branch 组合的路由
# 不可控（2026-10-07 实测：带标签 merge 节点从分支点出发被强制
# 路由到无名主干；纯 merge 从分支点出发同样走主干；branch label
# 与 merge 父冲突报 "Revision has a branch label"）。线形拓扑行为
# 确定。
# 两条接入路径：
#   存量库：`stamp 20261007_00002` 直接接入（历史子链真库实测不可
#           安全整体重放——1826 动态外键名漂移、列定义漂移，仅作
#           已发生历史的档案保留；已逐一补 inspector 幂等守卫的
#           部分供未来同构环境重放参考）；
#   新   库：`stamp --purge 20261004_0001`（指针占位子链末端）后
#           `upgrade head`——线形拓扑下仅执行本版本一步 create_all
#           全量建表。一次性测试库实测通过。
down_revision: Union[str, Sequence[str], None] = "20261004_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """
    全量建表（幂等）：按当前 SQLAlchemy 元数据创建所有缺失表。

    create_all(checkfirst=True)（默认）逐表检查存在性，已存在的表
    整体跳过——不触碰既有表结构与数据，因此对"回放增量到此"的
    存量库是 no-op，对新库是完整建表，生产 upgrade 安全。

    注意：create_all 不会给**已存在**的表补新增列。存量库的列级
    漂移应通过回放增量链（历史 add_column 迁移，均已补幂等守卫）
    修复——本版本只负责"缺表"，不负责"缺列"。

    列对齐自愈（2026-10-07 一次性测试库实测补强）：若指针曾被
    downgrade 退到子链中段再回放回来，历史增量的 ALTER 可能把
    列改回旧定义（如 ENUM 收窄），与现行 ORM 漂移。本版本对
    已知漂移点做幂等 MODIFY 对齐；全部使用 MySQL 原生 MODIFY
    COLUMN（幂等，重复执行无副作用）。
    """
    bind = op.get_bind()
    Base.metadata.create_all(bind=bind)

    # ── 已知列漂移自愈（均经一次性测试库实测为幂等）──
    # 20260921_0001 曾把 primer_designs.status ENUM 收窄，
    # 现行 ORM 定义为宽 ENUM（见 app/models 中 PrimerDesign）。
    insp = sa.inspect(bind)
    if "primer_designs" in insp.get_table_names():
        bind.execute(sa.text(
            "ALTER TABLE primer_designs MODIFY COLUMN status "
            "ENUM('pending','running','completed','failed','cancelled') "
            "NOT NULL DEFAULT 'pending' "
            "COMMENT '设计状态（20260921_0001 拓宽：+cancelled）'"
        ))


def downgrade() -> None:
    """
    全量删表 —— 生产红线警示。

    ⚠️⚠️⚠️ 严禁在生产库执行 ⚠️⚠️⚠️
    会删除元数据注册的**全部业务表及数据**。
    本 downgrade 仅用于一次性测试库验证 downgrade 链
    （alembic downgrade base 回到 baseline 空状态）。

    用户红线：生产环境严禁 drop_all / DROP TABLE；CI 严禁跑 downgrade。

    downgrade 链现实约束（2026-10-07 一次性测试库实测）：历史子链
    中 primer_designs / binder_designs 等资产表的 downgrade 按红线
    有意 raise RuntimeError 拒绝自动 DROP——`downgrade base` 只能
    走到这些守卫处为止。测试库完整清场用
    `downgrade 20261004_0001`（只执行本版本删表）+ DROP DATABASE。

    实现说明：模型元数据存在循环外键（projects ↔ targets、
    research_projects ↔ research_stages 互相引用），直接 drop_all
    在 Python 侧排序即抛 CircularDependencyError，与 MySQL 会话级
    FOREIGN_KEY_CHECKS 无关（2026-10-07 一次性测试库实测：仅设
    FK_CHECKS=0 仍失败）。因此改为：SET FOREIGN_KEY_CHECKS=0 +
    **逐表裸 DROP TABLE**（reversed(sorted(...)) 固定顺序，约束
    校验已关，顺序无关紧要）。仅对一次性测试库使用。
    """
    # 双保险防御：若 shell 显式声明了生产环境标识，直接中止，
    # 防止误在生产机器上敲下 alembic downgrade
    if os.environ.get("APP_ENV", "").lower() in ("prod", "production"):
        raise RuntimeError(
            "生产环境（APP_ENV=prod/production）严禁执行全量 downgrade，已中止"
        )
    bind = op.get_bind()
    # 关闭本会话外键约束校验（会话级，连接归还/关闭即复位）
    bind.execute(sa.text("SET FOREIGN_KEY_CHECKS = 0"))
    try:
        # 绕开元数据拓扑排序（循环外键不可排序），逐表 DROP
        for table in sorted(Base.metadata.tables.values(), key=lambda t: t.name, reverse=True):
            bind.execute(
                sa.text(f"DROP TABLE IF EXISTS `{table.name}`")
            )
    finally:
        bind.execute(sa.text("SET FOREIGN_KEY_CHECKS = 1"))
