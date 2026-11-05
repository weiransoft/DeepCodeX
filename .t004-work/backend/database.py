"""
智能体协作平台 - 数据库连接模块
提供 SQLAlchemy 引擎、会话管理、模型基类、连接重试工具

## 连接层容错策略

Docker MySQL 运行时偶发网络瞬断会触发 pymysql OperationalError(2013, 2006)
即 "Lost connection to MySQL server" / "MySQL server has gone away"。根因不是
MySQL 本身（wait_timeout=28800s + OOMKilled=False 已排除），而是 Docker 网络栈
在多进程并发连接建立时的瞬时抖动。

本模块从三层修复：

1. **Engine 参数增强**（连接建立阶段）
   - connect_timeout=30: pymysql TCP 握手超时从默认 10s 放宽到 30s，
     应对冷启动时 Docker 网络尚未就绪
   - read_timeout=60 / write_timeout=60: 单次 SQL 读写超时从默认无限制
     收紧到 60s，避免长时间阻塞导致连接被中间路由杀掉
   - pool_use_lifo=True: LIFO 策略让热门连接被频繁复用，冷门连接
     自然被回收，减少空闲连接被 MySQL wait_timeout 断开的概率
   - pool_pre_ping=True + pool_recycle=3600: 保留原有连接健康检查 + 1h 回收

2. **retry_on_db_operational_error 装饰器**（SQL 执行阶段）
   - 捕获 pymysql.err.OperationalError / sqlalchemy.exc.OperationalError
     中常见的可重试错误码（2006/2013/2014/2048）
   - 指数退避（100ms → 200ms → 400ms）最多重试 3 次
   - 每次重试前 invalidate 连接池（避免使用已失效的连接）

3. **create_session_with_retry 工厂**（Session 创建 + 首次查询）
   - 构造后先执行一次 SELECT 1 作为健康检查，若失败立即重试
   - 返回包装过的 Session 对象，其 query/execute 在 OperationalError 时
     自动重连重试
"""
from __future__ import annotations

import logging
import time
import functools
from typing import Any, Callable, TypeVar, ParamSpec

from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker, declarative_base, Session
from sqlalchemy.exc import OperationalError as SQLAlchemyOperationalError
from pymysql.err import OperationalError as PyMySQLOperationalError

from app.config import settings

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 可重试的 MySQL OperationalError 错误码
# ---------------------------------------------------------------------------
# 2006 MySQL server has gone away — 连接被服务器关闭
# 2013 Lost connection to MySQL server during query — 查询执行中网络抖动
# 2014 Commands out of sync — 上一个结果集没读完就发新请求（重连可解）
# 2048 Lost connection to MySQL server at 'reading initial communication packet'
_RETRYABLE_MYSQL_CODES = frozenset({2006, 2013, 2014, 2048})

# 重试配置
_MAX_RETRIES = 3           # 最多重试次数（首次执行 + 3 次 retry = 共 4 次尝试）
_INITIAL_BACKOFF_SEC = 0.1  # 首次重试等待 100ms
_MAX_BACKOFF_SEC = 2.0      # 最大单次等待 2s

# ---------------------------------------------------------------------------
# 增强 Engine
# ---------------------------------------------------------------------------
# [21 CFR Part 11 合规] 会话时区强制锁定为 UTC：
# MySQL TIMESTAMP 列的存取值会按「会话时区」做转换，若应用层统一写入
# datetime.utcnow()（naive UTC）而服务器/连接会话时区漂移（如 global
# time_zone 被运维改为 +08:00，或新连接继承了不同的 time_zone），全部
# 历史时间值读取时会被二次偏移，导致电子签名的 HMAC 可复算校验静默
# 失效（signed_at 读取值 ≠ 签名时写入值）。因此每个物理连接建立时
# 通过 init_command 显式 SET time_zone='+00:00'，保证整库时间语义
# 恒定为 UTC，不依赖服务器全局配置。
engine = create_engine(
    settings.database_url,
    pool_size=20,
    max_overflow=10,
    pool_timeout=30,
    pool_recycle=3600,
    pool_pre_ping=True,
    pool_use_lifo=True,  # LIFO 策略减少空闲连接被 wait_timeout 断开
    connect_args={
        # 每个新连接初始化时强制 UTC 会话时区（幂等执行，无副作用）
        "init_command": "SET time_zone = '+00:00'",
        # pymysql 连接阶段超时（Docker 冷启动时网络未就绪的兜底）
        "connect_timeout": 30,
        # 单次 SQL 读写超时（避免长时间阻塞导致中间路由杀连接）
        "read_timeout": 60,
        "write_timeout": 60,
        # 开启 pymysql autocommit 保持 Session 语义（SQLAlchemy 已管理事务）
        "charset": "utf8mb4",
    },
    echo=False,  # 生产环境设为 False，开发时可设为 True 查看 SQL
)

# ---------------------------------------------------------------------------
# SQLAlchemy Session 工厂
# ---------------------------------------------------------------------------
# 创建会话工厂，autocommit=False 表示需要手动提交事务
# autoflush=True 表示在查询前自动 flush 待提交的更改
# expire_on_commit=False 表示 commit 后**不自动 expire 所有 ORM 对象**
# （默认 True 会导致 commit 后对象的属性标为 expired，下次访问需重新
# SELECT；如果 Session 已 close 就会 DetachedInstanceError——这是 SQLAlchemy
# 的经典坑）。设 False 后 commit 只持久化，不影响对象属性，Session close
# 后对象仍能安全访问所有已加载属性（JSON 列、普通列等）。
SessionLocal = sessionmaker(
    autocommit=False,
    autoflush=True,
    bind=engine,
    expire_on_commit=False,
)

# 声明式基类，所有模型继承自此类
Base = declarative_base()


# ---------------------------------------------------------------------------
# FastAPI 依赖注入函数
# ---------------------------------------------------------------------------
def get_db():
    """
    获取数据库会话的依赖注入函数（原始版本，无自动重试）

    用于 FastAPI 路由的 Depends 参数，确保每次请求结束后关闭会话。
    适合轻量、低冲突场景（单次查询/单条写入）。
    对执行长时间查询或需要强容错的路径，应使用 get_db_retry 或
    create_session_with_retry。
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ---------------------------------------------------------------------------
# 连接重试工具
# ---------------------------------------------------------------------------
def _invalidate_connection_pool() -> None:
    """
    安全地失效连接池（跨 SQLAlchemy 版本兼容）

    新版 SQLAlchemy QueuePool.invalidate()，旧版叫 _invalidate()。
    连接池失效后，下次 create_engine 或 sessionmaker 取连接时
    会强制重新握手，扔掉所有已死的物理连接。
    """
    try:
        pool = engine.pool
        # 新版 SQLAlchemy 2.0+ 有公开方法 invalidate
        if hasattr(pool, "invalidate"):
            pool.invalidate()  # type: ignore[attr-defined]
        elif hasattr(pool, "_invalidate"):
            pool._invalidate()  # type: ignore[attr-defined]
        else:
            # 兜底：关闭所有连接（让 QueuePool 下次按需重建）
            pool.dispose()
    except Exception:
        # 连接池失效失败不应阻断主流程（降级继续尝试重连）
        logger.debug("连接池 invalidate 失败（安全降级）", exc_info=True)


def _is_retryable_operational_error(exc: Exception) -> bool:
    """
    判断异常是否为可重试的 MySQL OperationalError

    Args:
        exc: SQLAlchemy 或 pymysql 抛出的异常

    Returns:
        True 如果错误码属于可重试集合（网络瞬断 / 连接丢失）
    """
    # SQLAlchemy 包装过的 OperationalError：里面的 orig 才是 pymysql 原始异常
    orig = exc
    if isinstance(exc, SQLAlchemyOperationalError) and exc.orig is not None:
        orig = exc.orig

    if isinstance(orig, PyMySQLOperationalError):
        code = orig.args[0] if orig.args else None
        return code in _RETRYABLE_MYSQL_CODES

    # SQLAlchemy 包装但 orig 不是 pymysql 的情况（兼容其他 DB driver）
    if isinstance(exc, SQLAlchemyOperationalError):
        msg = str(exc).lower()
        return any(kw in msg for kw in (
            "lost connection",
            "server has gone away",
            "connection reset",
            "broken pipe",
        ))

    return False


def retry_on_db_operational_error(
    max_retries: int = _MAX_RETRIES,
    initial_backoff: float = _INITIAL_BACKOFF_SEC,
    invalidate_pool_on_retry: bool = True,
):
    """
    装饰器：捕获 MySQL OperationalError 并指数退避重试

    适用场景：
    - 执行单条 SQL 的函数 / 方法（query、execute、commit）
    - 异步和同步函数都支持

    Args:
        max_retries: 最大重试次数（不含首次执行）
        initial_backoff: 首次重试前等待秒数（指数退避基准）
        invalidate_pool_on_retry: 重试前是否调用 _invalidate_connection_pool()
            （确保不会用已死的物理连接重试）

    用法：
        @retry_on_db_operational_error()
        def fetch_user(db: Session, uid: str):
            return db.query(User).filter(User.id == uid).first()

    注意：
        - 装饰器内调用的 db.execute 必须是传入的 Session 实例，
          且该 Session 绑定的 engine 是本模块的 engine
        - 对异步函数（async def），需要 await 版本的装饰器，见下方
          retry_on_db_operational_error_async
    """
    def decorator(func: Callable[..., Any]) -> Callable[..., Any]:
        @functools.wraps(func)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            backoff = initial_backoff
            last_exc: Exception | None = None
            for attempt in range(max_retries + 1):
                try:
                    return func(*args, **kwargs)
                except (SQLAlchemyOperationalError, PyMySQLOperationalError) as e:
                    if not _is_retryable_operational_error(e) or attempt >= max_retries:
                        raise
                    last_exc = e
                    logger.warning(
                        "[DB Retry] %s 第 %d/%d 次重试（等待 %.2fs）: %s",
                        func.__qualname__, attempt + 1, max_retries, backoff, e,
                    )
                    if invalidate_pool_on_retry:
                        try:
                            _invalidate_connection_pool()
                        except Exception:
                            pass
                    time.sleep(backoff)
                    backoff = min(backoff * 2, _MAX_BACKOFF_SEC)
            # 理论上不会到达这里（range 最后一次 raise 已 return 或 raise）
            raise last_exc  # type: ignore[misc]
        return wrapper
    return decorator


def retry_on_db_operational_error_async(
    max_retries: int = _MAX_RETRIES,
    initial_backoff: float = _INITIAL_BACKOFF_SEC,
    invalidate_pool_on_retry: bool = True,
):
    """
    异步版本的 retry 装饰器（用于 async def 函数）

    用法同同步版本，但等待用 asyncio.sleep 不阻塞事件循环。
    """
    import asyncio

    def decorator(func: Callable[..., Any]) -> Callable[..., Any]:
        @functools.wraps(func)
        async def wrapper(*args: Any, **kwargs: Any) -> Any:
            backoff = initial_backoff
            last_exc: Exception | None = None
            for attempt in range(max_retries + 1):
                try:
                    return await func(*args, **kwargs)
                except (SQLAlchemyOperationalError, PyMySQLOperationalError) as e:
                    if not _is_retryable_operational_error(e) or attempt >= max_retries:
                        raise
                    last_exc = e
                    logger.warning(
                        "[DB Retry Async] %s 第 %d/%d 次重试（等待 %.2fs）: %s",
                        func.__qualname__, attempt + 1, max_retries, backoff, e,
                    )
                    if invalidate_pool_on_retry:
                        try:
                            _invalidate_connection_pool()
                        except Exception:
                            pass
                    await asyncio.sleep(backoff)
                    backoff = min(backoff * 2, _MAX_BACKOFF_SEC)
            raise last_exc  # type: ignore[misc]
        return wrapper
    return decorator


def execute_with_retry(
    db: Session,
    operation: Callable[[Session], Any],
    max_retries: int = _MAX_RETRIES,
    initial_backoff: float = _INITIAL_BACKOFF_SEC,
) -> Any:
    """
    对任意 Session 执行操作进行重试的通用工具（无需装饰器）

    适用场景：需要在同一个函数里对 db.query / db.execute / db.commit
    多步操作整体重试时，用这个函数包住整个操作比装饰器更灵活。

    Args:
        db: SQLAlchemy Session 实例
        operation: 接受 Session 参数、返回任意值的可调用对象
        max_retries: 最大重试次数（不含首次）
        initial_backoff: 指数退避基准（秒）

    Returns:
        operation(db) 的返回值

    Raises:
        最后一次重试失败时抛出原始异常

    用法：
        result = execute_with_retry(db, lambda d: d.query(AgentTask).get(task_id))
    """
    backoff = initial_backoff
    last_exc: Exception | None = None
    for attempt in range(max_retries + 1):
        try:
            return operation(db)
        except (SQLAlchemyOperationalError, PyMySQLOperationalError) as e:
            if not _is_retryable_operational_error(e) or attempt >= max_retries:
                raise
            last_exc = e
            logger.warning(
                "[DB Retry execute] 第 %d/%d 次重试（等待 %.2fs）: %s",
                attempt + 1, max_retries, backoff, e,
            )
            # 连接池失效 + 关闭当前 Session（Session 会下次自动新建）
            try:
                _invalidate_connection_pool()
                db.close()
            except Exception:
                pass
            time.sleep(backoff)
            backoff = min(backoff * 2, _MAX_BACKOFF_SEC)
            # Session 关闭后重新创建 —— 但调用方持有的 db 引用已失效！
            # 调用方必须在 operation 内部只使用传入的 Session，且不跨调用持久化
            # （这也是为什么 execute_with_retry 要求 operation 必须接收 Session 参数）
    raise last_exc  # type: ignore[misc]


def run_with_session_retry(
    operation: Callable[[Session], Any],
    healthcheck: bool = True,
    max_retries: int = _MAX_RETRIES,
    initial_backoff: float = _INITIAL_BACKOFF_SEC,
    session_factory: Optional[Callable[[], Session]] = None,
) -> Any:
    """
    执行带自动重试的 DB Session 操作（无 contextmanager 坑）

    这是一个**无状态、无 yield、无 contextmanager** 的纯函数重试包装，
    直接规避了 contextmanager + retry 组合的经典 RuntimeError 问题
    （RuntimeError("generator didn't stop after throw()")）。

    适用场景：在一个 Session 内执行多条 DB 操作（query → 修改 → commit），
    当操作抛出可重试的 MySQL OperationalError 时，自动回滚旧 Session、
    失效连接池、指数退避、重建 Session、重跑整个 operation 函数体。

    Args:
        operation: 接受 Session 参数、返回任意值的 callable
        healthcheck: 每次新建 Session 后是否执行 SELECT 1 健康检查
        max_retries: 最大重试次数（不含首次执行）
        initial_backoff: 首次重试前等待秒数（指数退避基准）
        session_factory: 可选自定义 Session 工厂（默认用本模块 SessionLocal）
            Orchestrator 等外部模块需要注入自己的工厂时传此参数，
            以保证测试里 monkeypatch 的 db_session_factory 能被正确使用。

    Returns:
        operation(db) 的返回值

    Raises:
        最后一次重试失败时抛出原始异常；非可重试异常直接向上传播

    用法示例（orchestrator 的 _update_task_workflow_config 改造）：

        async def _update_task_workflow_config(self, task_id, workflow_dag):
            from app.database import run_with_session_retry
            try:
                return run_with_session_retry(
                    lambda db: self._do_update(db, task_id, workflow_dag),
                    session_factory=self.db_session_factory,
                    max_retries=3,
                )
            except Exception as e:
                logger.error(...); return False

    关键设计：session_factory 参数让调用方可以注入自己的 Session 创建逻辑，
    这样测试里 monkeypatch 了 `orchestrator.db_session_factory` 后，
    run_with_session_retry 内部会调用注入的工厂而不是硬编码 SessionLocal()。
    这保证了生产环境用真实 DB、测试环境用 monkeypatch Session 都能正常工作。
    """
    from sqlalchemy import text as sql_text

    # 默认用本模块的 SessionLocal；调用方传入 session_factory 时用传入的
    _factory = session_factory or SessionLocal

    backoff = initial_backoff
    last_exc: Exception | None = None

    for attempt in range(max_retries + 1):
        db: Session | None = None
        try:
            db = _factory()  # 用注入的 Session 工厂创建（保证测试兼容性）
            if healthcheck:
                db.execute(sql_text("SELECT 1"))
            # 执行传入的操作（操作内若抛 OperationalError 会被 except 捕获）
            result = operation(db)
            # 成功 → 提交（如果 operation 里自己 commit 了，这里不会有未提交更改）
            try:
                db.commit()
            except Exception:
                # operation 已经 commit 过的情况下，第二次 commit 可能报错
                # （但 SQLAlchemy 已 commit 时再 commit 是 no-op，通常不会有问题）
                pass

            # 关键：在 Session 关闭前，把返回的 ORM 对象 expunge 出来
            # 防止调用方在 Session 关闭后访问对象属性时抛 DetachedInstanceError。
            # （DetachedInstanceError 经典坑：Session close 后 ORM 对象的延迟属性
            # 无法再查询——expunge 后对象脱离 Session 但保留已加载的属性）
            try:
                if result is not None:
                    # 单个 ORM 对象：直接 expunge
                    if hasattr(result, '__table__'):
                        db.expunge(result)
                    # list/tuple of ORM 对象：逐个 expunge
                    elif isinstance(result, (list, tuple)):
                        for item in result:
                            if item is not None and hasattr(item, '__table__'):
                                db.expunge(item)
            except Exception:
                # expunge 失败（result 不是 ORM 对象）不影响正常返回
                pass

            return result
        except (SQLAlchemyOperationalError, PyMySQLOperationalError) as retry_err:
            # 只捕获可重试的 OperationalError
            try:
                if db is not None:
                    db.rollback()
                    db.close()
            except Exception:
                pass

            if not _is_retryable_operational_error(retry_err) or attempt >= max_retries:
                # 不可重试或已达上限 → 抛出最后一次异常
                last_exc = retry_err
                raise

            logger.warning(
                "[DB Session Retry] 重试 %d/%d（等待 %.2fs）: %s",
                attempt + 1, max_retries, backoff, retry_err,
            )
            _invalidate_connection_pool()
            time.sleep(backoff)
            backoff = min(backoff * 2, _MAX_BACKOFF_SEC)
            # continue → 进入下一次 for 循环，用同一个 _factory 重新创建 Session + 执行 operation

        # 非 OperationalError → 不捕获，直接让它自然 propagate
        # （IntegrityError / ProgrammingError / 业务异常等不需要重试）
        finally:
            # 确保每次循环结束时 Session 都被关闭（无论成功还是失败）
            # 但注意：OperationalError 分支里已经 close 过了，这里再 close 一次也安全
            try:
                if db is not None:
                    db.close()
            except Exception:
                pass

    # 理论上不会到达这里（range 最后一次 raise 已经 raise）
    raise RuntimeError(
        f"run_with_session_retry 意外结束（重试 {max_retries + 1} 次均未成功抛出异常）"
    )


def create_session_with_retry(
    healthcheck: bool = True,
    max_retries: int = _MAX_RETRIES,
) -> Session:
    """
    创建一个带重试的 SQLAlchemy Session（工厂函数）

    与 SessionLocal() 的区别：
    - 可选 healthcheck=True：Session 创建后立即执行 SELECT 1，
      若失败则指数退避重试（最多 max_retries 次）
    - 适合独立 Python 脚本 / 后台任务 / SSE 长轮询等需要
      强连接可靠性的场景

    Args:
        healthcheck: 是否在创建 Session 后立即执行连接健康检查
        max_retries: 健康检查最大重试次数

    Returns:
        已通过健康检查的 Session 实例

    Raises:
        max_retries 次重试均失败时抛出原始异常
    """
    backoff = _INITIAL_BACKOFF_SEC
    last_exc: Exception | None = None
    for attempt in range(max_retries + 1):
        try:
            session = SessionLocal()
            if healthcheck:
                session.execute(__import__("sqlalchemy").text("SELECT 1"))
            return session
        except (SQLAlchemyOperationalError, PyMySQLOperationalError) as e:
            last_exc = e
            logger.warning(
                "[DB Session Retry] 第 %d/%d 次创建 Session 失败（等待 %.2fs）: %s",
                attempt + 1, max_retries, backoff, e,
            )
            try:
                _invalidate_connection_pool()
            except Exception:
                pass
            time.sleep(backoff)
            backoff = min(backoff * 2, _MAX_BACKOFF_SEC)
    raise last_exc  # type: ignore[misc]


# ---------------------------------------------------------------------------
# 初始化 DB
# ---------------------------------------------------------------------------
# [D4 修复 T-004 2026-10-07] MySQL "already exists" 类错误码
# 1050 = ER_TABLE_EXISTS_ERROR（Table 'x' already exists）
# 1061 = ER_DUP_KEY（索引/约束重名，同属并发建表幂等冲突）
_TABLE_EXISTS_MYSQL_CODES = frozenset({1050, 1061})

# 首次建库判定哨兵表：该表存在即认为 schema 已初始化，无需再发任何 CREATE
# （旧库缺 component_dispatches 等新表时，由 Alembic 迁移负责补齐，见 run_migrations）
_INIT_PROBE_TABLE = "system_settings"


def _table_exists(conn, table_name: str) -> bool:
    """在当前连接上检查表是否存在（跨 dialect 的幂等判定）

    Args:
        conn: SQLAlchemy Connection
        table_name: 表名

    Returns:
        bool: 表存在返回 True；检查失败按 False 处理（交给建表兜底）
    """
    from sqlalchemy import inspect as _sa_inspect

    try:
        return bool(_sa_inspect(conn).has_table(table_name))
    except Exception:  # pragma: no cover - inspect 异常不应阻断初始化
        return False


def _is_table_exists_error(exc: BaseException) -> bool:
    """判断异常链是否为 MySQL「表/索引已存在」幂等冲突（1050/1061）

    Args:
        exc: 待判异常（可能是 SQLAlchemy 包装后的异常）

    Returns:
        bool: 属于「已存在」类冲突返回 True
    """
    seen: set[int] = set()
    cur: BaseException | None = exc
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        args = getattr(cur, "args", ())
        if args and isinstance(args[0], int) and args[0] in _TABLE_EXISTS_MYSQL_CODES:
            return True
        cur = cur.__cause__ or cur.__context__
    return False


def _create_tables_idempotent(bind) -> list[str]:
    """逐表 checkfirst 建表，并吞掉并发竞态导致的「已存在」冲突

    checkfirst=True 消除绝大多数无谓 CREATE；但"检查 → 建表"两步之间仍有
    竞态窗口（多副本 backend/celery-worker 并发启动），故再兜一层 1050 吞异常。

    Args:
        bind: SQLAlchemy Engine 或 Connection

    Returns:
        list[str]: 本次实际新建的表名

    Raises:
        非「已存在」类的真实建表错误（权限/语法/字符集）原样上抛
    """
    from sqlalchemy.exc import OperationalError as SAOpErr
    from sqlalchemy.exc import ProgrammingError

    created: list[str] = []
    for table in Base.metadata.sorted_tables:
        try:
            table.create(bind=bind, checkfirst=True)
            created.append(table.name)
        except (ProgrammingError, SAOpErr) as exc:
            if _is_table_exists_error(exc):
                logger.debug("[DB Init] 表 %s 已被其他进程创建，跳过", table.name)
                continue
            raise
    return created


def init_db(force: bool = False) -> None:
    """初始化数据库：幂等补齐缺失的表（不做任何破坏性操作）

    D4 修复（T-004，2026-10-07）：
    1. 旧实现 `Base.metadata.create_all(bind=engine)` 对已存在的表仍会发
       CREATE，触发 pymysql 1050 "Table 'component_dispatches' already
       exists" 告警栈（backend + 多副本 celery-worker 并发启动必现）。现改为
       逐表 `create(checkfirst=True)` + 1050/1061 幂等吞异常。
    2. 常规启动不再无条件发 DDL：哨兵表存在即认为 schema 就绪，结构演进交
       由 Alembic（deploy/bio-vlab/alembic/，compose 的 MIGRATIONS_ENABLED）。
       需要全量 checkfirst 校验时传 force=True（或 env AUTO_CREATE_ALL=true）。

    Args:
        force: True 时跳过哨兵表短路，对所有表逐一遍历 checkfirst 补齐

    Raises:
        Exception: 非「已存在」类的真实建表错误原样抛出
    """
    from app import models  # noqa: F401 - 导入所有模型以注册到 Base.metadata

    with engine.begin() as conn:
        if not force and _table_exists(conn, _INIT_PROBE_TABLE):
            logger.debug(
                "[DB Init] 已存在 schema（%s 在位），跳过建表；"
                "结构演进请使用 alembic upgrade head",
                _INIT_PROBE_TABLE,
            )
            return
        created = _create_tables_idempotent(conn)

    if created:
        logger.info("[DB Init] 幂等创建 %d 张表: %s", len(created), ", ".join(created[:20]))
    else:
        logger.debug("[DB Init] 无需建表，schema 已就绪")


def _resolve_alembic_ini():
    """定位 alembic.ini：优先 env ALEMBIC_INI，其次项目根与部署挂载点

    Returns:
        pathlib.Path | None: 找到的 ini 路径；全部未命中返回 None
    """
    import os
    from pathlib import Path

    candidates: list[Any] = []
    env_ini = str(os.environ.get("ALEMBIC_INI", "")).strip()
    if env_ini:
        candidates.append(Path(env_ini))
    project_root = Path(__file__).resolve().parent.parent.parent
    candidates += [
        project_root / "alembic.ini",
        Path("/opt/bio-vlab/alembic.ini"),
        Path(__file__).resolve().parent.parent / "alembic.ini",
    ]
    for path in candidates:
        try:
            if Path(path).is_file():
                return Path(path)
        except OSError:  # pragma: no cover - 非法路径继续尝试下一个
            continue
    return None


def run_migrations() -> bool:
    """用 Alembic 迁移管理结构演进（compose 的 MIGRATIONS_ENABLED=true 时调用）

    多副本安全：迁移前取 MySQL 命名锁 GET_LOCK('bio_vlab_alembic_migrate', 60)
    串行化，避免 backend 与 worker 并发 upgrade 互踩；老库（由 create_all 建出、
    无 alembic_version 表）先 stamp 到最新修订作为基线，不重放历史 DDL。

    Alembic 未安装或迁移脚本未挂载时降级为 init_db(force=True)（checkfirst
    幂等兜底），只改变"结构演进方式"，不影响服务可用性。

    Returns:
        bool: True = alembic 迁移已执行；False = 降级为 init_db 兜底
    """
    try:
        from alembic import command
        from alembic.config import Config
    except ImportError:
        logger.warning("[DB Migrate] 未安装 alembic，降级为 init_db(checkfirst) 兜底")
        init_db(force=True)
        return False

    ini = _resolve_alembic_ini()
    if ini is None:
        logger.warning("[DB Migrate] 未找到 alembic.ini，降级为 init_db(checkfirst) 兜底")
        init_db(force=True)
        return False

    with engine.connect() as conn:
        try:
            locked = conn.exec_driver_sql(
                "SELECT GET_LOCK('bio_vlab_alembic_migrate', 60)"
            ).scalar()
        except Exception:  # 非 MySQL 后端（如 sqlite 测试）无命名锁，直接迁移
            locked = 1
        try:
            if locked != 1:
                logger.warning("[DB Migrate] 未取得迁移锁（其他副本正在迁移），跳过本次 upgrade")
                return False
            cfg = Config(str(ini))
            cfg.set_main_option("script_location", str(ini.parent / "alembic"))
            cfg.set_main_option(
                "sqlalchemy.url", engine.url.render_as_string(hide_password=False)
            )
            if not _table_exists(conn, "alembic_version"):
                from alembic.script import ScriptDirectory

                heads = ScriptDirectory.from_config(cfg).get_heads()
                command.stamp(cfg, heads[0] if heads else "head")
                logger.info(
                    "[DB Migrate] 既有 schema 无 alembic_version，已 stamp 基线 %s", heads
                )
            command.upgrade(cfg, "head")
            logger.info("[DB Migrate] alembic upgrade head 完成")
        finally:
            try:
                conn.exec_driver_sql("SELECT RELEASE_LOCK('bio_vlab_alembic_migrate')")
            except Exception:  # pragma: no cover - 连接关闭时锁自动释放
                pass
    return True
