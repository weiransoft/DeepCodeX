#!/usr/bin/env python3
"""T-004 部署契约静态一致性检查（D3 / D4 / 网关入库）

不依赖 sqlalchemy / fastapi / alembic / pytest，可在未装 backend 依赖的机器
（GPU 机、CI 静态检查阶段、改 compose 后的自检）上直接运行：

    python3 tests/scripts/check-t004-deploy-contract.py

覆盖 T-003 报告 §7 三项遗留的落地不变量：

1. D3  运行时配置三层同源：compose 的 backend 与 celery-worker 必须都固化
     OPENDDE_HOST / OPENDDE_PORT；backend/settings_runtime.py 的展示层
     （组件清单 / 健康探测）必须叠加 runtime_overrides，否则 UI 会重犯
     "执行层生效、展示层恒显 down"。
2. D4  启动期 DDL 幂等：不得再有裸 create_all(bind=engine)（checkfirst
     缺省 False），必须走 checkfirst=True + 1050 吞异常 + Alembic；
     compose 引用的 alembic.ini / alembic 目录 / env.py / script.py.mako 齐备。
3. 入库  网关源码与 Dockerfile 在仓库内，且不再是"只有 GPU 机上有"的状态。

退出码 0 = 全部通过；1 = 存在失败项（逐条打印）。
"""
from __future__ import annotations

import ast
import configparser
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

COMPOSE = REPO_ROOT / "deploy/bio-vlab/docker-compose.app.yml"
ENV_TEMPLATE = REPO_ROOT / "deploy/bio-vlab/.env.app.example"
ALEMBIC_INI = REPO_ROOT / "deploy/bio-vlab/alembic.ini"
ALEMBIC_DIR = REPO_ROOT / "deploy/bio-vlab/alembic"
GATEWAY_DIR = REPO_ROOT / "backend/docker/opendde-gateway"

# backend 侧被改造的两个源文件在部署侧的仓库内路径（backend 仓为独立检出时，
# 这些路径由部署同步流程维护；此处校验其存在与内容不变量）
BACKEND_FILES = {
    "settings_runtime.py": REPO_ROOT / ".t004-work/backend/settings_runtime.py",
    "database.py": REPO_ROOT / ".t004-work/backend/database.py",
}

FAILURES: list[str] = []
PASSES: list[str] = []


def check(condition: bool, label: str, hint: str = "") -> bool:
    """记录一条断言结果

    Args:
        condition: 断言是否成立
        label: 断言说明（打印用）
        hint: 失败时的修复提示

    Returns:
        bool: condition 原值
    """
    if condition:
        PASSES.append(label)
        print(f"  PASS  {label}")
    else:
        FAILURES.append(label + (f"\n        ↳ {hint}" if hint else ""))
        print(f"  FAIL  {label}" + (f"\n        ↳ {hint}" if hint else ""))
    return condition


def read(path: Path) -> str:
    """读文件；缺失时返回空串并计一条失败（便于批量看缺什么）"""
    if not path.is_file():
        check(False, f"文件存在: {path.relative_to(REPO_ROOT)}", "文件缺失，T-004 交付不完整")
        return ""
    return path.read_text(encoding="utf-8")


def service_block(compose_text: str, service: str) -> str:
    """取出 compose 中某个服务的定义块（按两空格缩进的顶层 key 切分）

    Args:
        compose_text: compose 全文
        service: 服务名（backend / celery-worker）

    Returns:
        str: 该服务块文本；未找到返回空串
    """
    m = re.search(rf"^  {re.escape(service)}:\n(.*?)(?=^  [a-zA-Z0-9_-]+:|^networks:|^volumes:)",
                  compose_text, re.S | re.M)
    return m.group(0) if m else ""


def naked_create_all_calls(path: Path) -> list[str]:
    """用 AST 找出"裸 create_all"调用（未显式传 checkfirst 的全量建表）

    必须走 AST 而不是子串 grep：D4 修复后的 database.py 在 docstring 里仍保留
    `Base.metadata.create_all(bind=engine)` 字样（解释旧行为为什么错），子串
    匹配会把这段说明文字误判成回归（本检查首版即踩到该假阳性）。

    Args:
        path: 待检 Python 文件

    Returns:
        list[str]: 形如 "L613 create_all(...) 未显式 checkfirst" 的问题项；无则空表
    """
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"))
    except (OSError, SyntaxError) as exc:
        return [f"<无法解析: {exc}>"]

    offenders: list[str] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        fname = func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", "")
        if fname != "create_all":
            continue
        kwargs = {kw.arg for kw in node.keywords if kw.arg}
        # 全量建表调用未显式 checkfirst → 等价 checkfirst=False，对已存在表发 CREATE
        if "checkfirst" not in kwargs:
            offenders.append(f"L{node.lineno} create_all(...) 未显式 checkfirst")
    return offenders


def main() -> int:
    print("=" * 78)
    print("T-004 部署契约静态一致性检查")
    print("=" * 78)

    # ---------------------------------------------------------------- D3
    print("\n[D3] runtime_overrides 与 UI 显示一致（compose env 固化 + 展示层叠加）")
    compose = read(COMPOSE)
    backend = service_block(compose, "backend")
    worker = service_block(compose, "celery-worker")

    check(bool(backend), "compose 存在 backend 服务块")
    check(bool(worker), "compose 存在 celery-worker 服务块")
    for name, block in (("backend", backend), ("celery-worker", worker)):
        check("OPENDDE_HOST:" in block,
              f"{name} 固化 OPENDDE_HOST",
              "缺失会使 backend 回落 config.py 默认 127.0.0.1:8090（容器内不可达）→ D3 复现")
        check("OPENDDE_PORT:" in block,
              f"{name} 固化 OPENDDE_PORT",
              "缺失同上；worker 侧缺失会让异步任务打到自己容器的 8090")
    check("${OPENDDE_HOST:-" in backend,
          "OPENDDE_HOST 采用 ${VAR:-默认} 形式（可按 env 覆盖而非硬编码）")

    env_tpl = read(ENV_TEMPLATE)
    check("OPENDDE_HOST=" in env_tpl and "OPENDDE_PORT=" in env_tpl,
          ".env.app.example 含 OPENDDE_HOST/OPENDDE_PORT 条目",
          "运维照模板建 .env 时若缺项，等于没固化")

    # env 模板必须是 compose 能解析的 KEY=VALUE（曾因误写入 * 号导致 --env-file 直接失败）
    bad_env = [
        ln for ln in env_tpl.splitlines()
        if ln.strip() and not ln.lstrip().startswith("#")
        and not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", ln.strip())
    ]
    check(not bad_env,
          ".env.app.example 每行均为合法 KEY=VALUE（compose --env-file 可解析）",
          f"非法行示例: {bad_env[:3]}")
    check("MYSQL_PASSWORD=" in env_tpl,
          ".env.app.example 含 MYSQL_PASSWORD 占位（compose mysql/backend 均引用）")

    rt_text = read(BACKEND_FILES["settings_runtime.py"])
    check("def _get_runtime_overrides(" in rt_text,
          "settings_runtime 提供统一 override 读取入口 _get_runtime_overrides()")
    check("_builtin_components(_get_runtime_overrides(db))" in rt_text,
          "组件清单 GET /components 叠加 runtime_overrides")
    check(rt_text.count("_builtin_components(_get_runtime_overrides(db))") >= 2,
          "健康探测 GET /health 同样叠加 override（展示与探测同源）",
          "只改清单不改探测会残留 UI 误报 down")
    check("_builtin_components(\n    overrides" in rt_text or "def _builtin_components(\n    overrides" in rt_text,
          "_builtin_components 接收 overrides 参数（而非只读裸 app_settings）")

    # ---------------------------------------------------------------- D4
    print("\n[D4] 启动期 CREATE TABLE 告警（checkfirst / Alembic）")
    db_text = read(BACKEND_FILES["database.py"])
    naked = naked_create_all_calls(BACKEND_FILES["database.py"])
    check(not naked,
          "database.py 无可执行的裸 create_all(...)（未显式 checkfirst）",
          f"裸 create_all 等价 checkfirst=False，对已存在表发 CREATE → pymysql 1050 告警栈: {naked}")
    check("checkfirst=True" in db_text,
          "建表路径使用 checkfirst=True")
    check("def _is_table_exists_error(" in db_text,
          "对并发竞态的 1050/1061 做幂等吞异常（check→create 之间仍有窗口）")
    check("GET_LOCK(" in db_text,
          "迁移对 alembic_version 取 MySQL 命名锁串行化（多副本安全）")
    check("def run_migrations(" in db_text,
          "database.py 提供 run_migrations()（compose MIGRATIONS_ENABLED 的落点）")
    check("def init_db(force: bool = False)" in db_text,
          "init_db 支持 force 参数（缺库时 checkfirst 兜底补齐）")

    for name, block in (("backend", backend), ("celery-worker", worker)):
        check("MIGRATIONS_ENABLED:" in block,
              f"{name} 显式声明 MIGRATIONS_ENABLED（DDL 归属明确）")
        check("AUTO_CREATE_ALL:" in block,
              f"{name} 显式声明 AUTO_CREATE_ALL（不再无条件裸建表）")
    check("${WORKER_MIGRATIONS_ENABLED:-false}" in worker,
          "celery-worker 默认关闭迁移（避免多副本并发建表竞态，D4 主因）")

    check(COMPOSE.is_file() and "- ./alembic:" in compose and "- ./alembic.ini:" in compose,
          "compose 挂载 ./alembic 与 ./alembic.ini（否则 run_migrations 找不到 ini，静默降级）")

    if ALEMBIC_INI.is_file():
        cp = configparser.ConfigParser()
        cp.read(ALEMBIC_INI, encoding="utf-8")
        check(cp.has_section("alembic"), "alembic.ini 含 [alembic] 段")
        check(cp.has_section("loggers"), "alembic.ini 含日志段（env.py 的 fileConfig 依赖）")
        check(not cp["alembic"].get("sqlalchemy.url", "").strip(),
              "alembic.ini 未硬编码含口令 DSN（口令只应存在于 .env/secret）")
        check(cp["alembic"].get("version_table", "").strip() == "alembic_version",
              "version_table 为默认 alembic_version（run_migrations 的老库判定依赖该名）")
    else:
        check(False, "alembic.ini 存在", "缺失会使 D4 的 Alembic 方案完全失效")

    for rel in ("env.py", "script.py.mako", "versions"):
        check((ALEMBIC_DIR / rel).exists(), f"alembic/{rel} 存在")

    versions = sorted((ALEMBIC_DIR / "versions").glob("*.py")) if (ALEMBIC_DIR / "versions").is_dir() else []
    check(bool(versions), "alembic/versions 至少有一个基线迁移")
    rev_ids: list[str] = []
    for vf in versions:
        vsrc = vf.read_text(encoding="utf-8")
        m = re.search(r'^revision\s*=\s*["\']([^"\']+)["\']', vsrc, re.M)
        if m:
            rev_ids.append(m.group(1))
        check("def upgrade(" in vsrc and "def downgrade(" in vsrc,
              f"迁移 {vf.name} 定义 upgrade()/downgrade()")
        # alembic SourceCodeLoader 用正则取 revision，文件名须与之可配对
        check(bool(re.fullmatch(r"[A-Za-z0-9_]+", vf.stem)),
              f"迁移文件名合法: {vf.name}")
    check(len(rev_ids) == len(set(rev_ids)), "迁移 revision id 全局唯一", f"重复: {rev_ids}")

    # ---------------------------------------------------------------- 入库
    print("\n[入库] OpenDDE 契约适配网关纳入 git 管理")
    gw_main = GATEWAY_DIR / "app/main.py"
    gw_docker = GATEWAY_DIR / "Dockerfile"
    check(gw_main.is_file(), "backend/docker/opendde-gateway/app/main.py 在仓库内",
          "T-003 遗留事项 3：网关此前只存在于 GPU 机 /root/bio，改镜像即丢代码")
    check(gw_docker.is_file(), "backend/docker/opendde-gateway/Dockerfile 在仓库内")
    check((GATEWAY_DIR / "README.md").is_file(), "网关 README（契约/部署/约束）在仓库内")

    if gw_main.is_file():
        main_src = gw_main.read_text(encoding="utf-8")
        # D1/D2 修复不变量：回归一旦有人手改回去，这里应当红
        check("_start_next_queued" in main_src,
              "网关保留排队接力 _start_next_queued()（D1：排队任务不得孤儿 pending）")
        check('"plddt"' in main_src and "confidence" in main_src,
              "网关保留 plddt/confidence 双 key 兜底（D2：plddt 不得恒 null）")
        for route in ("/health", "/api/predict", "/cancel"):
            check(route in main_src, f"网关契约路由在位: {route}")
        for st in ("pending", "running", "completed", "failed", "cancelled"):
            check(f'"{st}"' in main_src, f"网关状态词表与 OpenDDEJobStatus 对齐: {st}")
    if gw_docker.is_file():
        dsrc = gw_docker.read_text(encoding="utf-8")
        check("aurekaresearch/opendde:v1" in dsrc,
              "网关基础镜像为 CUDA 版 aurekaresearch/opendde:v1（GPU 依赖由基础镜像承担）")
        check('"--workers", "1"' in dsrc or "--workers 1" in dsrc,
              "uvicorn 固定 --workers 1（内存态任务表 + GPU 串行，多 worker 会抢卡）")
        check("EXPOSE 8090" in dsrc, "网关暴露端口 8090（与 compose 固化端口一致）")

    # ---------------------------------------------------------------- 汇总
    print("\n" + "=" * 78)
    print(f"结果: {len(PASSES)} PASS / {len(FAILURES)} FAIL")
    if FAILURES:
        print("\n失败项:")
        for i, f in enumerate(FAILURES, 1):
            print(f"  {i}. {f}")
        print("=" * 78)
        return 1
    print("全部通过：D3 env 固化 + 展示层同源、D4 幂等 DDL + Alembic、网关已入库。")
    print("=" * 78)
    return 0


if __name__ == "__main__":
    sys.exit(main())
