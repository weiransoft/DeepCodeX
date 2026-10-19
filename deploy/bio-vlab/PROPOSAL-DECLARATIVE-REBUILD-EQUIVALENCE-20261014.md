# §7.3 声明重建等效性修复方案（评审稿，2026-10-14）

> 背景：FIX-CONTAINER-NAME-AND-BINDCRAFT-SMOKE-20261012.md §7.3 证实——若某
> 组件 `is_resident` 置回 False，平台按 `docker-container` 声明重建的结果与
> 当前实际运行容器不等效（entrypoint/GPU/volumes/env 漂移），重建必失败或
> 起一个"名存在、服务不可用"的残废容器。本方案给出最小修复面。
> **状态：已评审、已实施（2026-10-14，见文末"实施记录"）。** 决策：
> gpu_all 放 metadata；克隆等效性实测已做（发现 D8 workdir 缺口并修复）；
> 其余 6 组件同批静态体检已做（全部不等效，明细见实施记录 §D）。

## 1. 漂移清单（全部 [已验证]，取证命令见 §6）

| # | 项 | 实际运行容器 | 平台声明（yml/DB） | container_run 现能力 | 后果 |
|---|---|---|---|---|---|
| D1 | boltz2 启动命令 | entrypoint=`python`，cmd=`-m uvicorn serve:app --host 0.0.0.0 --port 8000` | `command: null`（DB 亦 null） | 仅拼 `command` 追加在 image 后，**无 `--entrypoint` 支持** | 镜像默认 ENTRYPOINT=`boltz`、CMD=`--help`，打印即退 |
| D2 | boltz2 GPU | `--gpus all`（DeviceRequests.Count=-1, caps=[gpu]） | `gpu_device_ids: []` | 仅 `--gpus "device=0,1"` 语法；`gpu_devices` 为空则**不下发** | 重建容器无 GPU，推理必挂 |
| D3 | proteinmpnn 挂载 | `/opt/bio-services/proteinmpnn/pylibs:ro`、`/opt/bio-services/logs:rw`、`/root/bio/bio-services/adapter:/opt/adapter:ro` | `./data/models:ro` + named volume `proteinmpnn-tmp` | volumes 透传可用 | adapter 缺失 → `mpnn_server:app` 模块不存在，起不来 |
| D4 | proteinmpnn env | `MPNN_LIB=/opt/bio-services/proteinmpnn/pylibs`、`TZ=Asia/Shanghai`（业务项） | `SERVER_MODE/PROTEINMPNN_MODEL_DIR/...` 5+1 项 | env 透传可用 | 与实际运行环境脱节（adapter 不读这些键） |
| D5 | 相对卷源 | binds 全为宿主绝对路径 | proteinmpnn `./data/models` | `-v ./data/models:...` 相对 backend 容器 cwd，daemon 拒绝非绝对/非 named-volume 源 | `docker run` 直接报错 |
| D6 | proteinmpnn 启动命令 | entrypoint=`python`，cmd=`-m uvicorn mpnn_server:app --host 0.0.0.0 --port 8085` | `command: null` | 同 D1 | 同 D1 |
| D7 | proteinmpnn 网络/重启 | `appserver-deploy_bio-net` / `unless-stopped` | metadata **缺 network 与 restart_policy 键**（DB rp=NULL） | 有键则下发 | 重建容器不在 bio-net → healthcheck/工具调用全断 |

注：proteinmpnn 的 GPU 实际为 `--gpus '"device=0"'`（Count=0 + NVIDIA_VISIBLE_DEVICES=0），
声明 `gpu_device_ids: []` 同样漂移，可在修 D3/D4 时一并置 `["0"]`。

## 2. 修复面 A：`container_run` 增加 entrypoint 覆盖 + GPU all 语义

改动文件（2 个 py + 1 个 schema）：

1. `app/core/docker/component_config.py` — `RuntimeConfig`（docker-container 分支）新增：
   ```python
   entrypoint: Optional[List[str]] = Field(default=None, description="覆盖镜像 ENTRYPOINT（docker run --entrypoint）")
   ```
2. `app/core/docker/docker_service.py::container_run` — 新增两个参数：
   - `entrypoint: Optional[List[str]] = None`：置于 image 之前
     `args.extend(["--entrypoint", entrypoint[0]])`；多段 entrypoint（如
     `["python","-m"]`）不常见，约定首元素为 entrypoint、其余并入 command。
   - GPU all 语义：`gpu_devices == ["all"]` 时下发 `--gpus all`，其余维持
     现 `device=` 语法：
     ```python
     if gpu_devices:
         if gpu_devices == ["all"]:
             args.extend(["--gpus", "all"])
         else:
             args.extend(["--gpus", f'"device={",".join(gpu_devices)}"'])
     ```
3. `app/core/docker/backends/local.py::run_container` — 透传：
   ```python
   entrypoint=config.runtime.entrypoint,
   gpu_devices=gpus or resources.gpu_device_ids or (["all"] if meta.get("gpu_all") else None),
   ```
   `metadata.gpu_all: true` 作为声明侧开关（与 ports/network/restart_policy
   同一 metadata 惯例，不动 resources schema 语义）。

**明确不做**：不改 `execute()` 的 shell 字符串拼接为 argv 数组（改动面波及
全部 docker_service 调用方，单列技术债）。entrypoint/command 值来自受控
bio-config 声明而非用户输入，注入面可控；但需在 yml 评审时人工过目含
空格的值（`execute` 走 shell）。

**remote_agent 后端**：`_component_to_start_request` 的 payload 需同步携带
`entrypoint`/`gpu_all`；Agent 端（GPU 机）消费逻辑属另一仓库——若 Agent
未升级，字段被忽略、行为与现状一致（向后兼容，无回归风险）。GPU 机当前
组件全部 resident，此路径实际不会被触发。

## 3. 修复面 B：proteinmpnn/boltz2 声明对齐（bio-config yml）

`proteinmpnn.component.yml`：

```yaml
runtime:
  type: docker-container
  image: boltz:latest
  entrypoint: ["python"]
  command: ["-m", "uvicorn", "mpnn_server:app", "--host", "0.0.0.0", "--port", "8085", "--log-level", "info"]
env:
  MPNN_LIB: /opt/bio-services/proteinmpnn/pylibs
  TZ: Asia/Shanghai
  PYTHONUNBUFFERED: "1"
volumes:
  - source: /opt/bio-services/proteinmpnn/pylibs
    target: /opt/bio-services/proteinmpnn/pylibs:ro
  - source: /opt/bio-services/logs
    target: /app/logs:rw
  - source: /root/bio/bio-services/adapter
    target: /opt/adapter:ro
resources:
  gpu_device_ids: ["0"]        # 实际 NVIDIA_VISIBLE_DEVICES=0
metadata:
  ports: ["8085:8085"]
  network: appserver-deploy_bio-net     # 新增（D7）
  restart_policy: unless-stopped        # 新增（D7）
```

`boltz2.component.yml`：

```yaml
runtime:
  type: docker-container
  image: boltz:latest
  entrypoint: ["python"]
  command: ["-m", "uvicorn", "serve:app", "--host", "0.0.0.0", "--port", "8000"]
metadata:
  gpu_all: true                # 对应 --gpus all（D2）
  # 其余（ports/network/restart_policy/volumes/env）2026-10-12 已对齐，不动
```

变更流程：改 repo `deploy/bio-vlab/bio-config/` → 同步宿主
`/root/bio/appserver-deploy/bio-config/`（双向 diff 空）→
`POST /docker-components/scan` 重导入 → DB 抽查 runtime_config。
**scan 不会触碰运行中容器**（10-12 已实测，resident 短路一切启停）[已验证]。

## 4. 验证方案（评审通过后实施时执行）

1. **单测**：`container_run` 参数拼装——entrypoint 存在时 argv 含
   `--entrypoint X` 且在 image 前；`["all"]` → `--gpus all`；`["0","1"]` →
   `device=0,1`；`None` → 无 `--gpus`。落
   `tests/unit/services/docker_components/test_docker_service.py`（新建或并入）。
2. **声明等效性静态断言**（新测试）：读 8 个 yml，对声明为可重建
   （非 resident 兜底路径）的组件断言 volumes 全为绝对路径或 named volume、
   entrypoint/command 非空。防回归漂移。
3. **等效性实测（谨慎）**：不拿生产组件开刀。克隆一个测试组件声明
   （如 proteinmpnn 的声明 + 随机容器名 + 端口避让），走平台 start →
   `docker inspect` diff 实际容器（entrypoint/cmd/binds/env/gpus/network/restart）
   → 平台 stop + `docker rm` 清理。只在低峰窗口、确认 GPU 有余量时做。
4. 回归：`test_lifecycle_manager.py`（16 用例基线）+ docker_components
   全目录（182 passed 基线，4 errors 为容器缺 respx/pytest-asyncio 的既有
   环境问题）。

## 5. 风险与回滚

| 风险 | 缓解 |
|---|---|
| entrypoint 值经 shell 拼接，含特殊字符破坏命令 | 值仅来自受控 yml；评审时人工过目；后续技术债转 argv |
| scan 重导入覆盖运行态字段 | scan 实测仅 upsert 声明字段，不动 status/container_id [已验证 2026-10-12] |
| remote GPU 机 Agent 不识别新字段 | 字段向后兼容（未知键忽略）；GPU 机组件全 resident 不触发该路径 |
| 误把 resident 置 False 触发坏重建 | 本方案完成后重建等效，风险本身消除；置位操作仍应保持双人复核 |
| 回滚 | 代码改动集中在 3 文件增量参数，`git revert` 单提交即可；yml 回滚 = 还原 bio-config 备份 + rescan |

## 6. 取证命令索引

```console
# 实际容器快照（D1/D2/D3/D4/D6）
docker inspect boltz2 proteinmpnn --format '{{.Name}} EP={{json .Config.Entrypoint}} CMD={{json .Config.Cmd}} GPU={{json .HostConfig.Resources.DeviceRequests}} BINDS={{json .HostConfig.Binds}}'
docker inspect proteinmpnn --format '{{json .NetworkSettings.Networks}} {{.HostConfig.RestartPolicy.Name}}'   # D7
# 声明侧
grep -A3 "runtime:" deploy/bio-vlab/bio-config/{boltz2,proteinmpnn}.component.yml
SELECT component_id, JSON_EXTRACT(runtime_config,'$.command'), JSON_EXTRACT(metadata,'$.restart_policy')
  FROM docker_components WHERE component_id IN ('boltz2','proteinmpnn');
# container_run 能力边界
sed -n 167,241p backend/app/core/docker/docker_service.py
```

## 7. 决策请求（评审时回答）

1. GPU all 开关放 `metadata.gpu_all`（本方案）还是 `resources.gpu_device_ids: ["all"]` 哨兵值？前者不动 resources 语义，推荐前者。
2. 等效性实测（§4.3 克隆组件重建）做不做？不做则结论止步于"静态等效"。
3. 其余 6 个 resident 组件声明是否同批体检（同法对照 inspect 快照）？建议同批，成本为纯静态 diff。

---

# 实施记录（2026-10-14，评审决策后执行）

决策落地：① `gpu_all` 放 `metadata`（采纳推荐案）；② 等效性克隆实测=做；
③ 其余 6 个 resident 组件同批静态体检=做。

## A. 修复面 A 实施 [已验证]

| 文件 | 变更 |
|---|---|
| `component_config.py` | RuntimeConfig 新增 `entrypoint: Optional[List[str]]`（working_dir 原已存在，本次开始被消费） |
| `docker_service.py::container_run` | 新增 `entrypoint`（image 前 `--entrypoint <首元素>`）、`workdir`（`-w`，克隆实测发现的 D8 追加）、`gpu_devices==["all"]` → `--gpus all` |
| `backends/local.py` | 透传 `entrypoint=config.runtime.entrypoint`、`workdir=config.runtime.working_dir`、`gpu_devices=gpus or gpu_device_ids or (["all"] if metadata.gpu_all else None)` |
| `backends/remote_agent.py` | start payload 增 `entrypoint`/`gpu_all`（`getattr(component,"metadata_",None)` 防御性读取，向后兼容） |

守护测试 `test_container_run_equivalence.py`：**20 passed**（argv 位置、
gpu_all 优先级 调度>固定设备>gpu_all、workdir、schema、remote payload）。
全目录回归 **199→202 passed**（期间发现并修复 remote_agent 直接属性访问
破坏 FakeComponent 的回归：改防御性 getattr，7 passed）。

## B. 修复面 B 实施 [已验证]

- boltz2：`entrypoint:["python"]` + uvicorn command + `metadata.gpu_all: true`
- proteinmpnn：entrypoint/command、binds 三项实际挂载（pylibs/logs/adapter）、
  env 收敛为 MPNN_LIB/TZ/PYTHONUNBUFFERED、`gpu_device_ids:["0"]`、
  metadata 补 network/restart_policy、**working_dir: /opt/adapter（D8）**
- 宿主 `/root/bio/appserver-deploy/bio-config/` 同步 → scan loaded_count=8
  → DB 抽查 entrypoint/command/gpu_all/network/working_dir 全部入库；
  生产组件 is_resident=1 未受影响。

## C. 克隆等效性实测 [已验证]

克隆 proteinmpnn 声明为临时组件 `eqclone-mpnn`（改名 + 端口 18085 避让 +
restart=no 避让）→ 平台 start → 与生产容器 inspect diff：

| 项 | 结果 |
|---|---|
| entrypoint / cmd / image / workdir / binds / nets | **MATCH** |
| ports | EXPECTED-DIFF（容器端口同、宿主端口 18085 避让，克隆设计如此） |
| restart | 预期 DIFF（克隆刻意 no，防残留自启） |
| DeviceRequests Driver 字段 | 语义等价（DeviceIDs=['0'] 相同；Driver='' vs 'nvidia' 为 docker run CLI 与 compose 下发路径差异，GPU 分配行为一致） |
| 功能验证 | `GET :18085/api/v1/mpnn/health` → healthy，available_models 4 权重，与生产响应一致 |

**D8 新发现（克隆实测独有产出）**：真实 proteinmpnn `WorkingDir=/opt/adapter`，
`mpnn_server` 模块在 adapter 挂载内且不在 PYTHONPATH——无 `-w` 时容器
`Exited(3) Could not import module "mpnn_server"`。已补 container_run
`workdir` 参数 + 声明 `working_dir` + 守护测试。boltz2 WorkingDir=/app
（镜像内置）无需处理。

**实施插曲（运维教训）**：worker 重启前 D8 补丁不在内存，第二次 start 仍
Exited(3)；重启 worker 后第三次 start 成功。另观察到一次"容器 start 成功后
数秒被清理"（DB 却记 running+container_id）——归因于外部回收任务清理了
Exited 残留壳，平台 start 前未校验 container_id 有效性；因组件均 resident
不触发重建路径，暂不单修，记录为已知限制。

清理：克隆容器 rm、声明文件删除、rescan loaded_count=8、DB 行删除，
生产组件全程未受扰动（Up 状态复核通过）。

## D. 其余 6 组件静态体检 [已验证]（脚本 /tmp/healthcheck_6comps.py）

**结论：6 组件声明全部不等效，且漂移模式与 boltz2/proteinmpnn 同构**——
command/entrypoint 未声明、network/restart_policy 缺失、GPU 设备未声明、
binds 用相对路径 `./` 或虚构 named volume、env 为虚构模板项。

| 组件 | 关键漂移（实测 vs 声明） |
|---|---|
| protenix | cmd=`python -m uvicorn protenix_server:app :8088`（声明 null）；binds `./model-cache/...` 相对路径；缺 network/restart。GPU 声明 `["1"]` 与实际一致 ✓ |
| genosm-mlx | 实际容器名 **genosm-cuda**（≠组件 id，改名遗留）；ep=tini+entrypoint.sh；GPU NVD=all 未声明；binds 相对路径 |
| opendde | 实际容器名 **opendde-gateway**、image=opendde-gateway:latest（声明 bio-opendde:latest 不存在）；GPU NVD=1 未声明；env 4 项虚构；binds 全错 |
| alphafold3 | cmd=`python3 /app/af3_cuda_server.py`；GPU NVD=0 未声明；binds 三个实际挂载全缺；**ports 声明 8092 实际 8642**；env 4 项漂移 |
| rfdiffusion | cmd=`bash`（服务模式在 bio-rfd-api/adapter 双容器旁路，复杂拓扑）；image 声明 bio-rfdiffusion:latest 实际 openeuler/rfdiffusion:1.1.0-oe2403sp4；GPU --gpus all 未声明；无端口发布（走 bio-rfd-api） |
| bindcraft | cmd=`python -m uvicorn bindcraft_server:app :8086`；GPU DeviceIDs=['0'] 声明一致 ✓；env 2 项虚构；缺 network/restart |

共性：全部 `restart_policy=unless-stopped` 实际 vs 声明缺失。
**处置建议（未实施）**：这 6 个组件与 boltz2/proteinmpnn 同为 resident，
生命周期在 operator 侧；若要具备重建能力需逐组件补声明（其中 rfdiffusion
双容器旁路拓扑复杂，建议保持"不可重建"现状并在 yml 注明，或改 compose
托管）。genosm-mlx/opendde 的**容器名≠组件 id**是 rename 项目的漏网项，
列入容器命名统一后续批。

## E. 终态验证 [已验证]

- 补丁链完整：§7.2（hc 键名）+ §7.3（entrypoint/gpu_all/workdir）均在
  源文件与两容器一致，backend healthy
- 回归：equivalence 20 + lifecycle 16 + api 22 = **58 passed**；
  docker_components 全目录 **202 passed / 0 failed**（4 errors 为容器缺
  respx/pytest-asyncio 既有环境问题）
- 生产 DB：8 组件、is_resident=1、proteinmpnn working_dir=/opt/adapter

## F. 后续批执行（2026-10-14 同日，用户指令"执行建议后续"）[已验证]

三项建议后续全部落地，git 提交 `9d46044`（代码+克隆实测修复链）与
`0035b67`（声明补齐+rename 持久化+测试守护）。

### F.1 六组件声明补齐批 [已验证]

6 个 yml 逐项对齐 inspect 快照（同 B 节方法论），repo `docker/components/`
与宿主 `bio-config/` 双向 diff 为空；部署前用容器内同一 ComponentConfig
Pydantic 校验 6/6 通过；宿主 `.bak-declare-align-20261014/` 留 8 文件备份。

| 组件 | 关键修复 |
|---|---|
| protenix | binds ./→绝对路径；metadata 补 network/restart_policy；HostIp 发布形式对齐（127.0.0.1:8088）；EP/CMD 镜像内置不声明（重建回落即等效） |
| genosm-mlx | GPU `["1"]` 补齐（原 []，实际 --gpus device=1 与 protenix 共卡）；binds 绝对路径；network/restart 补齐；**rename genosm-cuda→genosm-mlx 落地**（旧名保留 bio-net DNS 别名） |
| opendde | image → opendde-gateway:latest（原声明本机不存在）；env 4 项虚构删除；GPU ["1"]；binds → /home/llm/data:/opendde_data:ro；**rename opendde-gateway→opendde 落地**（旧名别名保留） |
| alphafold3 | **ports 8092→8642（速修项并入）** + tool_integration.port 同步；env 5 项虚构删除（运行时注入集为空）；GPU ["0"]；binds 三实际挂载（/af3_jobs、model、database_afdb） |
| rfdiffusion | image → openeuler/rfdiffusion:1.1.0-oe2403sp4；env 5→1（仅 RFDIFFUSION_HOME）；binds 实际两项；ports []（无发布，HTTP 在 bio-rfd-adapter）；头部注明旁路拓扑不可等效重建语义 |
| bindcraft | env 虚构 2 项删除；ports/network/restart 补齐；GPU ["0"] 维持 |

rename 影响面核查 [已验证]：cron/宿主脚本无旧名引用（grep 空）；
deploy/bio-services/docker-compose.yml 亦无 genosm/opendde 服务定义
（仅一处注释提及 bio-genosm，两容器由 operator 独立创建，rename 不影响
任何 compose up 路径）；backend/.env `OPENDDE_HOST`、
`GENOSM_API_URL` 已切换新名（`.env.bak-rename-batch-20261014` 备份；
compose `${VAR:-ip}` 注入链下，运行中 backend 仍持旧 env 但旧名 DNS 别名
保留 → 无需重启，正常发布后自然收敛）。rename 后双名 DNS 均解析到同一 IP
（172.22.0.7 / 172.22.0.8），genosm/opendde 服务健康未中断（Up 6/7 days
未重启），rescan 后 6 组件 runtime_state absent→running（容器名=组件 id
命中 LocalBackend 解析路径，附带修复了运维页长期显示 absent 的问题）。

### F.2 alphafold3 ports 速修 [已验证]

已并入 F.1（metadata.ports 8642:8642 + tool_integration.port 8642，
healthcheck endpoint 原本即 8642 正确）。附带发现：af3 服务实际路由为
`/api/jobs*`（openapi 实测），invoke_endpoint `/api/v1/af3/predict` 为虚构
——CUDA af3 工具尚未接线（local_tool_registry:2190 注释证实），与 boltz2
映射端点不一致同列工具映射批待办，yml 内已注记。

### F.3 git 入库 [已验证]

- `9d46044` fix(docker): resident stop 探测键名兼容 + container_run 声明
  重建等效性（lifecycle_manager/docker_service/component_config/local/
  remote_agent + equivalence 20 用例 + lifecycle 3 用例）
- `0035b67` fix(components): 8 组件声明对齐 + rename 持久化 + 测试守护
  （8 yml + test_component_yml_integration 修正与 D5 卷源守护新增 +
  test_tool_integration_config protenix_tool 期望补齐 + deploy compose
  container_name）
- 工作区 clean（仅 2 个 .bak-* 未跟踪备份留存，不入库）

### F.4 测试守护固化 [已验证]

- `test_docker_container_volume_sources_are_valid`：docker-container 组件卷
  源必须绝对路径或 named volume（D5 ./ 相对卷防回归，8 组件全过）
- `test_cuda_components_volumes_include_model_mount` 重写：按各组件实测模型
  挂载路径逐组件断言（旧断言统一 /data/models 前缀属早期模板腐化——
  在 HEAD 基线上本有 1 失败，与新树对照确认非本批引入后修正）
- `test_cuda_components_disabled_not_genosm`：genosm enabled=false 旧断言
  系 T-006 CUDA 化前的腐化断言（HEAD 基线同样失败），改为 enabled=true
- 集成测试文件 10/10 passed（含 2 处腐化修正 + 1 新守护）；docker_components
  全目录 202 passed / 0 failed 维持
