"""
智能体协作平台 - 运行时配置 API 路由模块

提供环境变量 / 依赖组件地址的运行时视图、健康探测、白名单修改与
基础设施容器（docker compose）启停能力。

设计要点（详见 docs/SYSTEM_RUNTIME_SETTINGS_DESIGN.md）：
1. 只读视图：从 app.config.settings（pydantic BaseSettings，env 覆盖后的生效值）
   分组读取，敏感字段（密码/密钥）统一脱敏；
2. 白名单修改：仅开放无需重启进程即可生效的低风险项（OPENDDE/AF3 地址与超时），
   持久化到 system_settings 表（key=runtime_overrides），读取时叠加展示；
3. 基础设施启停：OpenDDE 通过 docker compose 启停（仅 admin、命令硬编码、
   asyncio.Lock 防并发竞态）；AF3 为本地 MLX 进程，仅提供 status 探测。
"""
import asyncio
import logging
import re
import time
import uuid
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.config import settings as app_settings
from app.database import get_db
from app.dependencies import get_current_user
from app.models import SystemSetting, User

router = APIRouter(prefix="/settings/runtime", tags=["运行时配置"])
logger = logging.getLogger(__name__)

# ============================================================
# 常量定义
# ============================================================

# runtime_overrides 在 system_settings 表中的键名
RUNTIME_OVERRIDES_KEY = "runtime_overrides"

# 自定义组件在 system_settings 表中的键名（JSON 数组）
CUSTOM_COMPONENTS_KEY = "custom_components"

# 自定义组件允许的分类
COMPONENT_CATEGORIES = ("inference", "llm", "storage", "tool", "database", "cache", "other")

# 允许通过 PUT 修改的白名单字段及其取值约束（type, min, max）
# 设计原则：仅开放无需重启进程即可生效的工具类地址/超时项；
# 进程级配置（DATABASE_URL/REDIS_URL）与安全级配置（密钥）明确不开放
RUNTIME_EDITABLE_FIELDS: dict[str, dict[str, Any]] = {
    "OPENDDE_HOST": {"type": "host", "description": "OpenDDE 服务主机名"},
    "OPENDDE_PORT": {"type": "int", "min": 1, "max": 65535, "description": "OpenDDE 端口"},
    "OPENDDE_REQUEST_TIMEOUT": {
        "type": "float", "min": 30, "max": 3600, "description": "OpenDDE 请求超时（秒）",
    },
    "AF3_HOST": {"type": "host", "description": "AF3 服务主机名"},
    "AF3_PORT": {"type": "int", "min": 1, "max": 65535, "description": "AF3 端口"},
    "AF3_HEALTHCHECK_TIMEOUT": {
        "type": "float", "min": 1, "max": 120, "description": "AF3 健康检查超时（秒）",
    },
}

# 主机名/IP 合法性校验（字母数字点横线下划线，长度 1-253）
_HOSTNAME_RE = re.compile(r"^[a-zA-Z0-9_\-\.]{1,253}$")

# OpenDDE CPU 模式 compose 文件（相对项目根目录；GPU 模式互斥，如需切换
# 由运维直接改文件，API 只暴露最常用的 CPU compose）
_OPENDDE_COMPOSE = "docker/docker-compose.opendde.cpu.yml"

# 项目根目录（backend/ 的上一级），用于解析 compose 相对路径
_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent

# docker compose 并发锁：防止 up/down 并发执行导致状态竞态
_compose_lock = asyncio.Lock()

# 健康探测单组件超时（秒）
_HEALTH_TIMEOUT = 3.0


# ============================================================
# 请求/响应 Schema
# ============================================================

class RuntimeOverridesUpdate(BaseModel):
    """运行时可修改项更新请求（字段白名单见 RUNTIME_EDITABLE_FIELDS）"""

    # [T-062 修复 2026-11-05] 示例端口 8642（Mac MLX 遗留，T-028 已退役）改为
    # CUDA 规范端口 8092：示例会引导运维经 PUT 写入 override，沿
    # runtime_overrides → _get_effective_value → 工具实例化/探测/门面 全链路
    # 生效，错误示例即端口污染源。
    updates: dict[str, Any] = Field(
        ..., description="待更新的字段与值，仅接受白名单字段", examples=[{"AF3_PORT": 8092}]
    )


# ============================================================
# 内部工具函数
# ============================================================

def _mask_url(value: str) -> str:
    """对 URL 中的密码段脱敏：scheme://user:***@host 形式

    Args:
        value: 原始 URL 字符串

    Returns:
        str: 密码段被 *** 替换后的 URL
    """
    return re.sub(r"(://[^:/@]+:)[^@]+(@)", r"\1***\2", value)


def _get_overrides_record(db) -> SystemSetting | None:
    """查询 runtime_overrides 设置记录（不存在时返回 None）"""
    return (
        db.query(SystemSetting)
        .filter(SystemSetting.key == RUNTIME_OVERRIDES_KEY)
        .first()
    )


def _get_effective_value(field: str, overrides: dict[str, Any]) -> Any:
    """获取某字段的有效值：override 优先，其次 env 覆盖后的 settings 生效值"""
    if field in overrides:
        return overrides[field]
    return getattr(app_settings, field, None)


def _get_runtime_overrides(db) -> dict[str, Any]:
    """读取 runtime_overrides 字典（无记录 / DB 不可用时返回空字典）

    D3 修复（T-004，2026-10-07）：展示层（组件清单 GET /components、健康
    探测 GET /health）此前只读裸 app_settings（env 默认值），导致 PUT
    已成功写入的 runtime_overrides 在执行层生效、展示层却恒显旧地址
    （运维 UI 误报 down）。统一经本函数取 override，使取值链与执行层
    （opendde_tool）同构：env 默认值 → runtime_overrides 覆盖。

    Args:
        db: SQLAlchemy 会话（由 get_db 注入）

    Returns:
        dict[str, Any]: override 字典；查询异常时返回 {}（降级用 env 生效值）
    """
    try:
        record = _get_overrides_record(db)
        return dict(record.value) if record and record.value else {}
    except Exception:  # pragma: no cover - DB 瞬断不应阻断只读视图
        logger.warning("[Runtime Settings] 读取 runtime_overrides 失败，降级 env 生效值")
        return {}


async def _probe_http(name: str, url: str) -> dict[str, Any]:
    """HTTP GET 探测单个服务，返回状态/延迟/详情

    Args:
        name: 组件名（redis/opendde/af3/minio）
        url: 探测 URL

    Returns:
        dict: {status: up|down, latency_ms, detail}
    """
    start = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=_HEALTH_TIMEOUT, trust_env=False) as client:
            resp = await client.get(url)
            latency = round((time.monotonic() - start) * 1000, 1)
            ok = resp.status_code == 200
            return {
                "status": "up" if ok else "down",
                "latency_ms": latency,
                "detail": f"HTTP {resp.status_code}",
            }
    except Exception as exc:  # 探测失败不影响整体，仅标记 down
        latency = round((time.monotonic() - start) * 1000, 1)
        return {"status": "down", "latency_ms": latency, "detail": str(exc)[:120]}


async def _probe_tcp(host: str, port: int) -> dict[str, Any]:
    """TCP 连接探测（MySQL/Redis 等非 HTTP 服务），超时 3 秒

    Args:
        host: 目标主机
        port: 目标端口

    Returns:
        dict: {status: up|down, latency_ms, detail}
    """
    start = time.monotonic()
    try:
        _, writer = await asyncio.wait_for(
            asyncio.open_connection(host, port), timeout=_HEALTH_TIMEOUT
        )
        writer.close()
        await writer.wait_closed()
        latency = round((time.monotonic() - start) * 1000, 1)
        return {"status": "up", "latency_ms": latency, "detail": "TCP connect ok"}
    except Exception as exc:
        latency = round((time.monotonic() - start) * 1000, 1)
        return {"status": "down", "latency_ms": latency, "detail": str(exc)[:120]}


def _parse_netloc(url: str) -> tuple[str, int]:
    """从 URL 解析 host 与 port（缺省端口按协议补全：redis=6379, mysql=3306）

    Args:
        url: 连接 URL（如 redis://localhost:6380/0）

    Returns:
        tuple: (host, port)
    """
    parsed = urlparse(url)
    host = parsed.hostname or "127.0.0.1"
    default_port = 6379 if parsed.scheme.startswith("redis") else 3306
    return host, parsed.port or default_port


def _builtin_components(
    overrides: Optional[dict[str, Any]] = None,
) -> list[dict[str, Any]]:
    """构建内置依赖组件注册表（地址取 env 生效值，并叠加 runtime_overrides）

    每个组件含：key / name / category / probe（http|tcp|none）/ endpoint 展示串
    （密码脱敏）/ probe_url 或 probe_host+probe_port。probe=none 表示未配置，
    健康探测时返回 skipped。

    D3 修复（T-004，2026-10-07）：新增 overrides 参数。此前本函数只读裸
    app_settings，导致 GET /components 展示地址与 GET /health 探测目标恒为
    env 默认值（如 127.0.0.1:8090），而执行层（opendde_tool）已叠加
    runtime_overrides（如 10.101.20.30:8090）——表现为"调用能成、UI 恒显
    down"。现由调用方把库内 override 传入，三层取值（视图/探测/执行）同源。

    Args:
        overrides: runtime_overrides 字典（None 或空表示不叠加，等价旧行为）

    Returns:
        list[dict]: 内置组件定义列表（白名单字段已按 override 覆盖）
    """

    def http_key(base: str, path: str = "") -> dict[str, Any]:
        """构造 HTTP 探测条目片段"""
        base = base.rstrip("/")
        return {"probe": "http", "probe_url": f"{base}{path}", "endpoint": base}

    ov: dict[str, Any] = overrides or {}

    def eff(field: str) -> Any:
        """override 优先的有效值；override 值为空时回落 env 生效值"""
        value = _get_effective_value(field, ov)
        return value if value not in (None, "") else getattr(app_settings, field, None)

    redis_host, redis_port = _parse_netloc(str(app_settings.REDIS_URL or ""))
    broker_host, broker_port = _parse_netloc(str(app_settings.CELERY_BROKER_URL or ""))
    backend_host, backend_port = _parse_netloc(
        str(app_settings.CELERY_RESULT_BACKEND or "")
    )

    minio_endpoint = app_settings.MINIO_ENDPOINT
    kb_mineru = app_settings.KB_MINERU_BASE_URL
    kb_vllm = app_settings.KB_VLLM_BASE_URL

    components: list[dict[str, Any]] = [
        {"key": "mysql", "name": "MySQL 数据库", "category": "database",
         "probe": "tcp", "probe_host": app_settings.DB_HOST, "probe_port": app_settings.DB_PORT,
         "endpoint": f"{app_settings.DB_HOST}:{app_settings.DB_PORT}"},
        {"key": "redis", "name": "Redis", "category": "cache",
         "probe": "tcp", "probe_host": redis_host, "probe_port": redis_port,
         "endpoint": f"{redis_host}:{redis_port}"},
        {"key": "celery-broker", "name": "Celery Broker", "category": "cache",
         "probe": "tcp", "probe_host": broker_host, "probe_port": broker_port,
         "endpoint": f"{broker_host}:{broker_port}"},
        {"key": "celery-backend", "name": "Celery Result", "category": "cache",
         "probe": "tcp", "probe_host": backend_host, "probe_port": backend_port,
         "endpoint": f"{backend_host}:{backend_port}"},
        {"key": "opendde", "name": "OpenDDE 推理", "category": "inference",
         **http_key(f"http://{eff('OPENDDE_HOST')}:{eff('OPENDDE_PORT')}", "/health")},
        # [T-062] 展示名去除已退役的 MLX 标识（T-028 后本组件为 8092 CUDA 服务；
        # key 保持 "af3" 不变，前端与自定义组件重名冲突校验均按 key 匹配）
        {"key": "af3", "name": "AlphaFold3 CUDA", "category": "inference",
         **http_key(f"http://{eff('AF3_HOST')}:{eff('AF3_PORT')}", "/api/system/status")},
        {"key": "vllm", "name": "vLLM LLM 服务", "category": "llm",
         **http_key(str(app_settings.VLLM_BASE_URL or ""), "/models")},
        {"key": "kb-mineru", "name": "MinerU 文档解析", "category": "tool",
         **(http_key(str(kb_mineru)) if kb_mineru else {"probe": "none", "endpoint": None})},
        {"key": "kb-vllm", "name": "KB vLLM 服务", "category": "llm",
         **(http_key(str(kb_vllm), "/models") if kb_vllm else {"probe": "none", "endpoint": None})},
        {"key": "sciminer", "name": "SciMiner API", "category": "tool",
         **http_key(str(app_settings.SCIMINER_API_BASE_URL or ""))},
        {"key": "minio", "name": "MinIO 对象存储", "category": "storage",
         **(http_key(str(minio_endpoint)) if minio_endpoint else {"probe": "none", "endpoint": None})},
        {"key": "bindcraft", "name": "BindCraft", "category": "inference",
         **http_key(str(app_settings.BINDCRAFT_API_URL or ""))},
        {"key": "proteinmpnn", "name": "ProteinMPNN", "category": "inference",
         **http_key(str(app_settings.PROTEINMPNN_API_URL or ""))},
        {"key": "protenix", "name": "Protenix", "category": "inference",
         **http_key(str(app_settings.PROTENIX_API_URL or ""))},
        {"key": "rfdiffusion", "name": "RFdiffusion", "category": "inference",
         **http_key(str(app_settings.RFDIFFUSION_API_URL or ""))},
        {"key": "boltz", "name": "Boltz-2", "category": "inference",
         **http_key(f"http://{app_settings.BOLTZ_HOST}:{app_settings.BOLTZ_PORT}")},
    ]
    return components


async def _get_custom_components(db) -> list[dict[str, Any]]:
    """读取自定义组件列表（system_settings key=custom_components，无记录返回空表）"""
    record = (
        db.query(SystemSetting)
        .filter(SystemSetting.key == CUSTOM_COMPONENTS_KEY)
        .first()
    )
    return list(record.value) if record else []


def _upsert_custom_components(db, components: list[dict[str, Any]]) -> None:
    """写入自定义组件列表（存在则覆盖 value，不存在则新建记录）"""
    record = (
        db.query(SystemSetting)
        .filter(SystemSetting.key == CUSTOM_COMPONENTS_KEY)
        .first()
    )
    if record is None:
        record = SystemSetting(
            key=CUSTOM_COMPONENTS_KEY,
            value=components,
            description="自定义依赖组件（健康监控与地址登记）",
        )
        db.add(record)
    else:
        record.value = components
    db.commit()


# ============================================================
# 只读视图与健康探测
# ============================================================

@router.get("")
async def get_runtime_settings(
    db=Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """运行时配置只读视图（分组返回，敏感值脱敏）

    数据来源：app.config.settings（env 覆盖后的生效值）叠加 runtime_overrides。
    所有已登录用户可查看；修改见 PUT 端点（仅 admin）。

    Returns:
        dict: {success, data: {overrides: {...}, groups: {database/cache/infra/storage/docker}}}
    """
    overrides_record = _get_overrides_record(db)
    overrides: dict[str, Any] = dict(overrides_record.value) if overrides_record else {}

    # 数据库连接信息：密码不回传，仅展示主机/端口/库名与是否已配置
    db_url = str(
        getattr(app_settings, "SYNC_DATABASE_URL", None)
        or getattr(app_settings, "DATABASE_URL", None)
        or ""
    )
    db_url_masked = _mask_url(db_url)
    # 是否显式配置了密码（脱敏后无法看出，补充 configured 标志）
    db_configured = bool(getattr(app_settings, "DB_PASSWORD", ""))

    # Redis/Celery URL 脱敏
    redis_masked = _mask_url(str(app_settings.REDIS_URL or ""))
    broker_masked = _mask_url(str(app_settings.CELERY_BROKER_URL or ""))
    result_masked = _mask_url(str(app_settings.CELERY_RESULT_BACKEND or ""))

    # MinIO：密钥类字段不回传明文，仅返回是否已配置
    minio_endpoint = app_settings.MINIO_ENDPOINT
    minio_configured = bool(
        minio_endpoint
        and app_settings.MINIO_ACCESS_KEY
        and app_settings.MINIO_SECRET_KEY
    )

    data = {
        # 白名单可修改项的当前生效值（override 优先）
        "overrides": {
            f: _get_effective_value(f, overrides)
            for f in RUNTIME_EDITABLE_FIELDS
        },
        "editable_fields": RUNTIME_EDITABLE_FIELDS,
        "groups": {
            "database": {
                "DATABASE_URL": db_url_masked if db_configured else None,
                "DATABASE_CONFIGURED": db_configured,
                "DB_HOST": app_settings.DB_HOST,
                "DB_PORT": app_settings.DB_PORT,
                "DB_NAME": app_settings.DB_NAME,
                "DB_USER": app_settings.DB_USER,
            },
            "cache": {
                "REDIS_URL": redis_masked,
                "CELERY_BROKER_URL": broker_masked,
                "CELERY_RESULT_BACKEND": result_masked,
            },
            "infra": {
                "OPENDDE": {
                    "HOST": _get_effective_value("OPENDDE_HOST", overrides),
                    "PORT": _get_effective_value("OPENDDE_PORT", overrides),
                    "REQUEST_TIMEOUT": _get_effective_value(
                        "OPENDDE_REQUEST_TIMEOUT", overrides
                    ),
                },
                "AF3": {
                    "HOST": _get_effective_value("AF3_HOST", overrides),
                    "PORT": _get_effective_value("AF3_PORT", overrides),
                },
            },
            "storage": {
                "MINIO_ENDPOINT": minio_endpoint,
                "MINIO_CONFIGURED": minio_configured,
                "MINIO_BUCKET": app_settings.MINIO_BUCKET,
                "UPLOAD_DIR": str(app_settings.UPLOAD_DIR),
            },
            "docker": {
                "COMPOSE_FILE": str(app_settings.DOCKER_COMPOSE_FILE),
                "COMPONENTS_DIR": str(app_settings.DOCKER_COMPONENTS_DIR),
                "COMMAND_TIMEOUT": app_settings.DOCKER_COMMAND_TIMEOUT_SECONDS,
            },
        },
    }
    return {"success": True, "data": data}


@router.get("/health")
async def get_runtime_health(
    db=Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """依赖组件连通性探测：全部内置组件 + 启用的自定义组件（并行，单组件 3s 超时）

    探测方式按组件定义：HTTP GET（推理/LLM/存储/工具服务）或 TCP 连接
    （MySQL/Redis/Celery）。probe=none 的未配置组件返回 skipped。
    探测失败不影响整体响应，仅该组件标记为 down。

    Returns:
        dict: {success, data: {component_key: {status, latency_ms, detail}}}
    """
    # D3 修复：探测目标同样叠加 runtime_overrides，与执行层（opendde_tool）同源，
    # 否则 override 生效时 UI 仍探测 env 默认地址而误报 down
    builtins = _builtin_components(_get_runtime_overrides(db))
    custom = await _get_custom_components(db)

    async def probe_component(comp: dict[str, Any]) -> tuple[str, dict[str, Any]]:
        """按组件定义选择探测方式，返回 (key, 探测结果)"""
        probe = comp.get("probe")
        if probe == "http":
            return comp["key"], await _probe_http(comp["key"], comp["probe_url"])
        if probe == "tcp":
            return comp["key"], await _probe_tcp(comp["probe_host"], int(comp["probe_port"]))
        return comp["key"], {"status": "skipped", "latency_ms": 0, "detail": "未配置"}

    # 内置组件 + 启用的自定义组件统一并行探测
    tasks = [probe_component(c) for c in builtins]
    tasks += [
        probe_component(
            {"key": f"custom:{c['id']}", "probe": "http", "probe_url": c["url"]}
        )
        for c in custom
        if c.get("enabled", True)
    ]
    results = await asyncio.gather(*tasks)

    return {"success": True, "data": dict(results)}


# ============================================================
# 依赖组件清单与自定义组件 CRUD
# ============================================================

class CustomComponentCreate(BaseModel):
    """自定义组件新增/修改请求体"""

    name: str = Field(..., min_length=1, max_length=50, description="组件名称（全局唯一）")
    category: str = Field(..., description=f"分类：{'/'.join(COMPONENT_CATEGORIES)}")
    url: str = Field(..., min_length=1, max_length=500, description="服务地址（http/https）")
    enabled: bool = Field(default=True, description="是否参与健康探测")


@router.get("/components")
async def list_runtime_components(
    db=Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """依赖组件清单：内置注册表 + 自定义组件

    内置清单从 settings 生效值动态构建（地址/端点随 env 与 override 变化）；
    自定义清单来自 system_settings(key=custom_components)。

    Returns:
        dict: {success, data: {builtin: [...], custom: [...], categories: [...]}}
    """
    return {
        "success": True,
        "data": {
            "builtin": _builtin_components(_get_runtime_overrides(db)),
            "custom": await _get_custom_components(db),
            "categories": list(COMPONENT_CATEGORIES),
        },
    }


def _validate_component_payload(
    body: CustomComponentCreate,
    existing: list[dict[str, Any]],
    exclude_id: Optional[str] = None,
) -> dict[str, Any]:
    """自定义组件载荷校验：URL 协议、分类枚举、名称唯一（含内置 key 冲突）

    Args:
        body: 请求体
        existing: 当前自定义组件列表（调用方预先查出）
        exclude_id: 更新场景排除自身后的唯一性检查

    Returns:
        dict: 规范化后的组件字段

    Raises:
        HTTPException 400: URL 非法 / 分类非法 / 名称冲突
    """
    url = body.url.strip()
    if not url.startswith(("http://", "https://")):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="URL 必须以 http:// 或 https:// 开头",
        )
    if body.category not in COMPONENT_CATEGORIES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"分类非法，可选: {'/'.join(COMPONENT_CATEGORIES)}",
        )

    name = body.name.strip()
    # 内置 key 集合与地址无关，无需叠加 override（保持纯静态取值）
    builtin_keys = {c["key"] for c in _builtin_components()}
    if name in builtin_keys:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"组件名称与内置组件冲突: {name}",
        )
    others = [c for c in existing if c["id"] != exclude_id]
    if any(c["name"] == name for c in others):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"组件名称已存在: {name}",
        )

    return {
        "name": name,
        "category": body.category,
        "url": url,
        "enabled": body.enabled,
    }


@router.post("/components")
async def create_runtime_component(
    body: CustomComponentCreate,
    db=Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """新增自定义依赖组件（仅 admin）

    校验通过后写入 system_settings(key=custom_components)，
    立即参与 GET /health 的健康探测。

    Raises:
        HTTPException 403: 非管理员
        HTTPException 400: 载荷校验失败
    """
    if current_user.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="仅管理员可管理自定义组件",
        )

    fields = _validate_component_payload(body, await _get_custom_components(db))
    component = {
        "id": uuid.uuid4().hex,
        **fields,
        "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    existing = await _get_custom_components(db)
    _upsert_custom_components(db, [*existing, component])
    logger.info("管理员 %s 新增自定义组件: %s (%s)", current_user.name, component["name"], component["url"])
    return {"success": True, "data": component}


@router.put("/components/{component_id}")
async def update_runtime_component(
    component_id: str,
    body: CustomComponentCreate,
    db=Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """修改自定义依赖组件（仅 admin，按 id 定位）

    Raises:
        HTTPException 403: 非管理员
        HTTPException 404: 组件不存在
        HTTPException 400: 载荷校验失败
    """
    if current_user.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="仅管理员可管理自定义组件",
        )

    existing = await _get_custom_components(db)
    target = next((c for c in existing if c["id"] == component_id), None)
    if target is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="自定义组件不存在",
        )

    fields = _validate_component_payload(body, existing, exclude_id=component_id)
    target.update(fields)
    _upsert_custom_components(db, existing)
    logger.info("管理员 %s 修改自定义组件 %s: %s", current_user.name, component_id, fields)
    return {"success": True, "data": target}


@router.delete("/components/{component_id}")
async def delete_runtime_component(
    component_id: str,
    db=Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """删除自定义依赖组件（仅 admin，按 id 定位）

    Raises:
        HTTPException 403: 非管理员
        HTTPException 404: 组件不存在
    """
    if current_user.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="仅管理员可管理自定义组件",
        )

    existing = await _get_custom_components(db)
    remaining = [c for c in existing if c["id"] != component_id]
    if len(remaining) == len(existing):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="自定义组件不存在",
        )
    _upsert_custom_components(db, remaining)
    logger.info("管理员 %s 删除自定义组件 %s", current_user.name, component_id)
    return {"success": True, "data": {"deleted": component_id}}


# ============================================================
# 白名单修改
# ============================================================

@router.put("")
async def update_runtime_settings(
    body: RuntimeOverridesUpdate,
    db=Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """更新运行时可修改项（白名单，仅 admin）

    校验流程：
    1. 权限：非 admin 返回 403
    2. 字段：不在白名单返回 400（防止越权修改 DATABASE_URL 等敏感项）
    3. 值：按字段类型/范围校验（host 正则、int/float 范围）
    4. 持久化到 system_settings(key=runtime_overrides)，读取时叠加生效

    Raises:
        HTTPException 403: 非管理员
        HTTPException 400: 字段不在白名单 / 值非法
    """
    if current_user.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="仅管理员可修改运行时配置",
        )

    # 字段白名单校验
    for field in body.updates:
        if field not in RUNTIME_EDITABLE_FIELDS:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"字段不可修改或不存在: {field}",
            )

    # 值校验并规范化
    validated: dict[str, Any] = {}
    for field, value in body.updates.items():
        spec = RUNTIME_EDITABLE_FIELDS[field]
        if spec["type"] == "host":
            if not isinstance(value, str) or not _HOSTNAME_RE.match(value):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"{field} 值非法: {value!r}（应为合法主机名/IP）",
                )
            validated[field] = value
        elif spec["type"] in ("int", "float"):
            try:
                num = float(value)
            except (TypeError, ValueError):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"{field} 应为数字，收到: {value!r}",
                )
            if not (spec["min"] <= num <= spec["max"]):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"{field} 超出范围 [{spec['min']}, {spec['max']}]: {num}",
                )
            validated[field] = int(num) if spec["type"] == "int" else num

    # 持久化（merge 既有 override）
    record = _get_overrides_record(db)
    if record is None:
        record = SystemSetting(
            key=RUNTIME_OVERRIDES_KEY,
            value=validated,
            description="运行时配置覆盖项（白名单字段，即时生效）",
        )
        db.add(record)
    else:
        merged = dict(record.value)
        merged.update(validated)
        record.value = merged
    db.commit()
    db.refresh(record)

    logger.info(
        "管理员 %s 更新运行时配置: %s", current_user.name, validated
    )
    return {"success": True, "data": {"updated": validated, "overrides": record.value}}


# ============================================================
# 基础设施启停（docker compose / 本地进程探测）
# ============================================================

async def _run_compose(args: list[str], timeout: float) -> dict[str, Any]:
    """执行 docker compose 子命令（参数硬编码，不拼接用户输入）

    Args:
        args: compose 子命令参数列表（如 ["up", "-d"]）
        timeout: 子进程超时（秒）

    Returns:
        dict: {ok, stdout, stderr}
    """
    cmd = ["docker", "compose", "-f", _OPENDDE_COMPOSE, *args]
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        cwd=str(_PROJECT_ROOT),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        return {
            "ok": proc.returncode == 0,
            "stdout": stdout.decode(errors="replace")[-2000:],
            "stderr": stderr.decode(errors="replace")[-2000:],
        }
    except asyncio.TimeoutError:
        proc.kill()
        return {"ok": False, "stdout": "", "stderr": f"命令超时（>{timeout}s）"}


@router.get("/overrides")
async def get_effective_overrides(
    db=Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """白名单项的「三层取值」对照视图（D3 修复配套可观测性端点）

    运维排查"UI 显示与调用实际不一致"时，一次请求即可看到差异发生在哪一层：
    env 默认值（app_settings）→ 库内 runtime_overrides → 有效值（override 优先）。

    Returns:
        dict: {success, data: {fields: {NAME: {env, override, effective, source}}}}
    """
    overrides = _get_runtime_overrides(db)
    fields = {
        field: {
            "env": getattr(app_settings, field, None),
            "override": overrides.get(field),
            "effective": _get_effective_value(field, overrides),
            "source": "runtime_override" if field in overrides else "env",
        }
        for field in RUNTIME_EDITABLE_FIELDS
    }
    return {
        "success": True,
        "data": {
            "fields": fields,
            # 执行层（opendde_tool）与本视图同源：override 优先，回落 env 生效值
            "resolution_rule": "runtime_overrides > env(app_settings)",
        },
    }


async def _opendde_effective_base_url(db) -> str:
    """OpenDDE 的有效基址（叠加 runtime_overrides），供 infra 状态探测使用

    D3 修复（T-004）：infra 端点此前直连 app_settings.OPENDDE_HOST/PORT，
    override 生效时探测目标与执行层不一致（同一组件在不同页面一会 up 一会
    down）。统一走本函数后，视图/探测/执行三层同源。
    """
    overrides = _get_runtime_overrides(db)
    return f"http://{_get_effective_value('OPENDDE_HOST', overrides)}:{_get_effective_value('OPENDDE_PORT', overrides)}"


async def _af3_effective_base_url(db) -> str:
    """AF3 的有效基址（叠加 runtime_overrides），语义同 _opendde_effective_base_url"""
    overrides = _get_runtime_overrides(db)
    return f"http://{_get_effective_value('AF3_HOST', overrides)}:{_get_effective_value('AF3_PORT', overrides)}"


@router.post("/infra/opendde/{action}")
async def opendde_infra_action(
    action: str,
    db=Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """OpenDDE 基础设施操作：start / stop / status

    - start: docker compose up -d（CPU 模式 compose）
    - stop:  docker compose down（保留数据卷）
    - status: 容器状态 + HTTP /health 探测（目标地址叠加 runtime_overrides）

    安全约束：仅 admin；命令参数硬编码；compose 操作加锁防并发竞态；
    操作全程记录日志（用户名/操作/结果）。

    Raises:
        HTTPException 403: 非管理员
        HTTPException 400: 未知 action
        HTTPException 502: docker 命令执行失败
    """
    if current_user.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="仅管理员可操作基础设施",
        )

    if action == "status":
        # 状态查询：compose ps + HTTP 探测，无副作用不加锁
        # compose ps 在无匹配容器/profile 未激活时可能返回非零，
        # 不影响 status 判定（HTTP /health 探测才是可用性的关键信号）
        compose = await _run_compose(
            ["ps", "--format", "json"],
            timeout=app_settings.DOCKER_COMMAND_TIMEOUT_SECONDS,
        )
        # D3 修复：探测目标叠加 runtime_overrides，与组件健康视图/执行层同源
        base_url = await _opendde_effective_base_url(db)
        health = await _probe_http("opendde", f"{base_url}/health")
        return {
            "success": True,
            "data": {
                "compose_ok": compose["ok"],
                "compose_ps": compose["stdout"],
                "compose_stderr": compose["stderr"],
                "health": health,
                "running": health["status"] == "up",
                # 探测目标一并回传，UI 可直接看出"探的是哪个地址"（D3 可观测性）
                "probe_url": f"{base_url}/health",
            },
        }

    if action not in ("start", "stop"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"不支持的操作: {action}（可选 start/stop/status）",
        )

    # start/stop：加锁防止并发 up/down 竞态
    async with _compose_lock:
        compose_args = ["up", "-d"] if action == "start" else ["down"]
        result = await _run_compose(
            compose_args, timeout=app_settings.DOCKER_COMMAND_TIMEOUT_SECONDS
        )

    if not result["ok"]:
        logger.error(
            "管理员 %s OpenDDE %s 失败: %s",
            current_user.name, action, result["stderr"][:300],
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"OpenDDE {action} 失败: {result['stderr'][:200]}",
        )

    logger.info(
        "管理员 %s 执行 OpenDDE %s（docker compose %s）成功",
        current_user.name, action, " ".join(compose_args),
    )
    return {"success": True, "data": {"action": action, "message": f"OpenDDE {action} 已执行"}}


@router.post("/infra/af3/{action}")
async def af3_infra_action(
    action: str,
    db=Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """AF3 基础设施操作：仅 status 探测

    AF3 为本地 MLX 进程（非容器）。出于安全考虑不提供远程 start/stop
    （避免误杀进程/重复加载 5GB 权重），启停请使用：
        bash backend/scripts/start_af3_local.sh

    Raises:
        HTTPException 403: 非管理员
        HTTPException 400: action 不是 status
    """
    if current_user.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="仅管理员可操作基础设施",
        )

    if action != "status":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="AF3 为本地进程，仅支持 status 探测；"
            "启停请使用 backend/scripts/start_af3_local.sh",
        )

    # D3 修复：探测目标叠加 runtime_overrides（与 /health 视图、执行层同源）
    base_url = await _af3_effective_base_url(db)
    health = await _probe_http("af3", f"{base_url}/api/system/status")
    return {"success": True, "data": {"health": health, "probe_url": f"{base_url}/api/system/status"}}
