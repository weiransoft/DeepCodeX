"""Alembic 迁移环境（T-004 / D4 修复）

与默认模板的差异（都是本项目的硬约束，勿改回默认写法）：

1. **DSN 不读 alembic.ini**：口令只存在于 .env / secret 中，ini 里刻意留空。
   优先接受 app.database.run_migrations() 注入的引擎串（x_process_revision 的
   cfg.attributes）；离线 CLI 场景再回落 env DATABASE_URL / DB_* 分段拼装。
2. **target_metadata 取项目 Base.metadata**：使 `alembic revision --autogenerate`
   可用，避免团队退回去手工比对 ORM 模型与库结构。导入 app.models 以注册全部
   映射；运行环境缺少 backend 包（如纯 CI 静态检查）时降级为 None，只影响
   autogenerate，不影响 upgrade/downgrade。
3. **compare_type=True**：D4 之后结构演进只由迁移决定，列类型漂移必须能被
   autogenerate 检出，否则新旧镜像的列类型差异会静默存在。
"""
from __future__ import annotations

import os
import sys
from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

# 迁移脚本目录为 deploy/bio-vlab/alembic/，仓库根需上溯三级后进 backend/
_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.abspath(os.path.join(_HERE, "..", "..", ".."))
_BACKEND_ROOT = os.path.join(_REPO_ROOT, "backend")
if os.path.isdir(_BACKEND_ROOT) and _BACKEND_ROOT not in sys.path:
    sys.path.insert(0, _BACKEND_ROOT)

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# ---------------------------------------------------------------------------
# target_metadata
# ---------------------------------------------------------------------------
try:  # pragma: no cover - 取决于运行环境是否具备 backend 依赖
    from app.database import Base  # type: ignore
    import app.models  # noqa: F401  导入即注册所有 ORM 模型到 Base.metadata

    target_metadata = Base.metadata
except Exception:  # pragma: no cover - 降级：仅禁用 autogenerate
    target_metadata = None


def _dsn() -> str:
    """解析迁移用 DSN

    优先级：
      1. run_migrations() 经 cfg.attributes 注入的引擎串（生产唯一路径，
         含 connect_args / 池参数一致的引擎 URL，且口令不出 .env）
      2. env DATABASE_URL
      3. env DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME 分段拼装

    Returns:
        str: SQLAlchemy URL

    Raises:
        RuntimeError: 三者皆缺失（避免拿着 ini 里的空 URL 静默连错库）
    """
    injected = config.attributes.get("sqlalchemy.url") if hasattr(config, "attributes") else None
    if injected:
        return str(injected)

    url = str(os.environ.get("DATABASE_URL", "")).strip()
    if url:
        return url

    host = str(os.environ.get("DB_HOST", "")).strip()
    user = str(os.environ.get("DB_USER", "")).strip()
    if host and user:
        port = str(os.environ.get("DB_PORT", "3306")).strip() or "3306"
        password = os.environ.get("DB_PASSWORD", "")
        name = str(os.environ.get("DB_NAME", "bio_ai")).strip() or "bio_ai"
        return f"mysql+pymysql://{user}:{password}@{host}:{port}/{name}?charset=utf8mb4"

    raise RuntimeError(
        "Alembic 无法确定数据库地址：应由 app.database.run_migrations() 注入，"
        "或设置 env DATABASE_URL / DB_HOST+DB_USER。alembic.ini 内不保存含口令 DSN。"
    )


def _configure() -> None:
    """把解析出的 DSN 写入迁移配置（upgrade / downgrade / offline 共用）"""
    config.set_main_option("sqlalchemy.url", _dsn().replace("%", "%%"))


def run_migrations_offline() -> None:
    """离线模式：只输出 SQL（用于评审变更语句，不连库）

    注意：离线模式无法判定"老库已有 schema"，因此不要用离线输出初始化
    既有库——那是 baseline 迁移 + stamp 的职责。
    """
    _configure()
    context.configure(
        url=config.get_main_option("sqlalchemy.url"),
        target_metadata=target_metadata,
        literal_binds=True,
        compare_type=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """在线模式：连库执行迁移

    render_as_batch=True 让 MySQL 也走批处理路径，为后续 ALTER 类迁移留下
    可移植性（同一套迁移需在 sqlite 单测库上跑通）。
    """
    _configure()
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            compare_type=True,
            render_as_batch=True,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
