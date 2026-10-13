# 组件容器名统一 + BindCraft design_binder 端到端冒烟（2026-10-12）

> 范围：处置 2026-10-11 集成报告（BINDCRAFT-PROTENIX-INTEGRATION-20261011.md）§6
> 的两条已知限制——①boltz2/proteinmpnn 组件 `runtime_state=absent`（容器历史命名
> 与组件 id 不一致）；②bindcraft 缺少 design_binder 端到端冒烟。
> 所有结论附验证命令，未标注 `[已验证]` 者不成立。

## 1. 容器 rename 落地与状态复核 [已验证]

| 组件 id | 旧容器名 | 现容器名 | 佐证 |
|---|---|---|---|
| boltz2 | boltz | **boltz2** | `docker ps` 仅见 boltz2（3719fa830a1d）；bio-net DNSNames=`[boltz2, 3719fa830a1d]` |
| proteinmpnn | bio-proteinmpnn | **proteinmpnn** | `docker ps` 仅见 proteinmpnn（1ac3bd4b4324）；bio-net DNSNames=`[proteinmpnn, bio-proteinmpnn, 1ac3bd4b4324]`（旧名以网络别名保留，向后兼容） |

注：rename 本体在上一会话与本次核查之间落地（宿主 `docker ps` 于 2026-10-11 仍见
`boltz`/`bio-proteinmpnn`，2026-10-12 核查时已为目标名）；本次完成的是终态验证、
组件定义对齐与启停实测。

组件 API 复核（`GET /api/v1/docker-components/{id}/status`）[已验证]：

- boltz2：`runtime_state=running`，`container_id=3719fa830a1d`，`health=True`
- proteinmpnn：`runtime_state=running`，`container_id=1ac3bd4b4324`，`health=True`

（absent 根因：`LocalBackend._resolve_container_name()` 对 docker-container 类型
按组件 id 找容器名；`image` 仅影响缺失时的重建路径。）

## 2. 旧名引用回归 [已验证]

- backend 容器内 DNS：`boltz2`/`proteinmpnn` 解析正常；`bio-proteinmpnn` 经别名
  仍解析（兼容窗口）；旧名 `boltz` 在 bio-net 内**不再解析**。
- 宿主 `.env` `BOLTZ_HOST=boltz2` 已切换 [已验证]；宿主发布端口不变
  （boltz2→0.0.0.0:8000，proteinmpnn→127.0.0.1:8085），HTTP 探活不受影响：
  - `GET :8085/api/v1/mpnn/health` → healthy，4 权重，device=auto(cuda/cpu)
  - `GET :8000/health` → ok
- `GET /api/v1/settings/runtime/health` 全量 up（12 项，含 boltz/proteinmpnn/
  bindcraft/protenix）；sciminer down（外部 SaaS 301）、kb-mineru/kb-vllm/minio
  skipped——与 10-11 报告一致，非本次引入。

## 3. 组件定义对齐（bio-config）与仓库同步 [已验证]

- `proteinmpnn.component.yml`：
  - `runtime.image: bio-proteinmpnn:latest` → **`boltz:latest`**（旧声明镜像本机
    不存在，容器缺失时平台重建必失败；实际容器=boltz:latest+adapter 挂载，
    health 自述 `backend=proteinmpnn-cli-adapter`）；
  - `lifecycle.start_command: docker run -d --name proteinmpnn` →
    **`docker start proteinmpnn`**（对齐 genosm-mlx 的已验证惯例：常驻容器
    缺失时 `docker run` 兜底命令不完整必然失败，`docker start` 复活现容器）。
- `boltz2.component.yml`：healthcheck endpoint 修正为 `http://boltz2:8000/health`
  （原 `localhost:8080` 指向错误）；bindcraft/protenix 同步为 bio-net 服务名
  endpoint。
- 宿主 `/root/bio/appserver-deploy/bio-config/` ↔ 仓库
  `deploy/bio-vlab/bio-config/` 已双向同步（diff 为空）[已验证]。
- `POST /api/v1/docker-components/scan` → `loaded_count: 8`；scan 后
  proteinmpnn `image=boltz:latest` 生效 [已验证]。

## 4. 容器级启停实测 [已验证]

`POST /api/v1/docker-components/boltz2/restart` → 200（task e3422e5d）；
6s 后 status 复查 `status=running, runtime_state=running, health=True`。
组件运维页对 boltz2/proteinmpnn 的容器级启停自 rename 后可用。

遗留处置（2026-10-12 追加）：boltz2 的 `start` 路径 compose 声明漂移**已修复**——
`boltz2.component.yml` 由 `docker-compose-service`（指向部署目录不存在的
`docker-compose.prod.yml`）改为 `docker-container`，逐项对齐实际运行容器：
`image=boltz:latest`、env `BOLTZ_CACHE=/app/cache`+`PYTHONUNBUFFERED=1`、
volumes=实际 5 个 binds（/home/llm/boltz/{input,output,boltz_cache,api-data/inputs,
api-data/outputs}）、`metadata.ports=["8000:8000"]`（原 8080/8081 为模板虚构值，
实际发布 8000）、`network=appserver-deploy_bio-net`、`restart_policy=
unless-stopped`；`tool_integration.port` 8080→8000。rescan 后
`image=boltz:latest`、`runtime_state=running` 复核通过，容器未受扰动
（容器级 start/restart 实测均在 rename 修复后走 container_id 路径，未回归实测
完整 stop→start 重建，避免扰动 GPU 常驻推理服务 [不确定]）。
附带发现（未变更）：boltz 服务实际路由为 `/health、/predict、/tasks/{id}`
（openapi 实测），与 tool_integration 声明的 `/api/v1/boltz2/predict` 不一致，
属后端 boltz2_tool 映射层问题，单列待办。

## 5. BindCraft design_binder 端到端冒烟 [已验证]

请求：`POST :8086/api/v1/bindcraft/design_binder`（async_mode=true），
靶点=PDL1.pdb（base64 内联），chain=A，hotspots=[60..67]（PDL1 结合面），
binder_length=60，num_designs=2，design_mode=relaxed，seed=424242。

- task_id=`bc-20261012-212855-6c9fd282`：queued→running→**completed**，
  elapsed=1403.8s（GPU0），`partial=false`。
- 产出 2 个设计，全指标达标（见下表），PDB 落盘
  `/root/bio/model-cache/jobs/bindcraft/bc-20261012-212855-6c9fd282/design/`。

| 指标 | mean | Rank1 (binder_l60_s109919_mpnn2) |
|---|---|---|
| pLDDT | 0.895 | 0.90 |
| pTM | 0.865 | 0.87 |
| i_pTM | 0.825 | 0.83 |
| i_pAE | 0.185 | 0.18 |
| dG | -55.59 | -56.27 |
| ShapeComp | 0.695 | 0.71 |
| PackStat | 0.62 | 0.60 |
| Hotspot_RMSD | 1.215 | 1.15 |
| Clashes | 0.0 | 0.0 |

Rank1 序列（60aa）：
`SEEEHKLEAGKRNVLALQEVVKNPNPSMSPEDQEVEKRIAQTLIDHLKKNYPELNEVPDV`

- 首次提交（hotspots=10..22）failed：PDL1.pdb 残基编号从 18 起，越界 hotspot
  在 ColabDesign prep_pos 断言失败（rc=1，8.8s 快速失败）。**这是有效负样本**：
  证明错误路径快速可见、错误信息含日志尾部可诊断。
  建议（未实施）：适配层 submit 时按 target PDB 实际残基范围预校验 hotspots，
  越界直接 400 而非消耗 GPU 队列。

## 6. 已知限制更新

- ~~boltz2 / proteinmpnn 组件 runtime_state=absent~~ → 已修复（§1-§4）。
- ~~bindcraft 待补 design_binder 端到端冒烟~~ → 已完成（§5）。
- ~~boltz2 组件 start 路径 compose 文件声明漂移~~ → 已修复（§4 遗留处置，
  docker-container 化重建路径）；新发现待办：boltz2_tool 映射端点与服务实际
  路由不一致（§4 附带发现）。
- bindcraft 适配层 hotspot 越界不预校验（§5，P3，待办）。
- （2026-10-13 复检）原"未实测完整 stop→rm→start 重建路径 [不确定]"更正为
  **路径不可达**：8 组件 `is_resident=True`，平台启停均为状态同步短路，不拥有
  容器生命周期；若置 False，声明重建仍不等效（entrypoint/volumes/env 漂移）
  （§7.1/§7.3，待办）。
- （2026-10-13 复检）resident stop 探测键名错位 `url` vs `endpoint`，探测恒
  pass——组件真 down 时 stop 也无法收敛 health_check_failed（§7.2，P2，
  一行补丁待评审）。
- （2026-10-13 复检）rename 持久化补强：宿主 compose 已 pin
  `container_name: boltz2`，"依赖下次自然重启检验"一项**关闭**（§7.4）。

## 7. 遗留项复检（2026-10-13 追加）

针对两条遗留"未验证项"的代码级 + 终态复检。代码引用均为
`/root/bio/bio-vlab/backend/app/core/docker/` 现行版本。

### 7.1 重建路径不可达：全组件 is_resident=True 短路一切启停 [已验证]

**API 实测**：`GET /docker-components` 返回 8 个组件全部 `is_resident=True`
（boltz2/proteinmpnn/protenix/genosm-mlx/opendde/alphafold3/rfdiffusion/bindcraft）。

**代码路径**（lifecycle_manager.py；HTTP 启停经 Celery 任务
`docker_component.start/stop/restart`（L1314/1345/1369）最终仍进入下述同一方法）：

| 操作 | is_resident=True 行为 | 位置 |
|---|---|---|
| start | 短路：仅 DB status=running + 事件，**跳过 `_execute_start_command`**（不调 docker run） | L365-390 |
| stop | 短路：探测后保持 running 或置 health_check_failed，**跳过 `stop_container`**（不调 docker stop） | L514-570 |
| restart | stop（短路近似 no-op）+ start（status 已 running → "跳过重复启动"） | L665-697 |
| force stop 的 `container_remove` | 仅 `_execute_stop_command` 失败才触发；resident 下 stop 不走后端，恒不触发 | L594-604 |

**交叉佐证**：`docker ps` 中 boltz2 `Up 3 weeks`（未被重建）。这同时修正 §4
的结论：当时 `POST /boltz2/restart` "实测通过"实为 resident 短路的 DB 状态
no-op + bio-net HTTP 探活复核，并未证明容器级重启生效——对 resident=True
组件，平台启停自始是状态同步而非生命周期控制。

**对遗留项①的结论**：`stop→rm→平台 start` 完整重建路径在当前 DB 状态下
**不可达，也无必要**——平台按 resident 语义不拥有这些容器的生命周期，
实际生命周期归 operator 的宿主 compose 工程（`/home/llm/boltz/docker-compose.yml`）。
此前声明的"对齐即重建等效"应修正为：对齐后的 docker-container 声明只有在
is_resident 置回 False 时才会被消费，而届时重建仍会失败（见 7.3）。
is_resident=True 的设入主体（update API/SQL/历史脚本）未追溯 [不确定]。

### 7.2 附带发现 A：resident stop 探测键名错位（url vs endpoint）[已验证-代码]

`lifecycle_manager.py` stop 短路分支读 `hc_config.get("url")`（L529），而 DB
`healthcheck_config` 实际键为 `endpoint`（API 实测两组件均为
`{"mode":"http","endpoint":"http://boltz2:8000/health",...}`）→ `hc_url`
恒 None → 探测恒跳过、恒 `probe_ok=True`、恒"保持 running"。即使组件真
down，对 resident 组件的 stop 请求也无法收敛到 health_check_failed。
建议一行补丁：`hc_url = hc_config.get("url") or hc_config.get("endpoint")`。

### 7.3 附带发现 B：若 is_resident 置 False，声明重建仍不等效 [已验证-代码+快照 diff]

`docker-container` 类型 start 恒走 `DockerService.container_run`（`docker run`
组装，docker_service.py L167-241），**不支持 entrypoint 覆盖**。对照运行容器
inspect 快照：

| 项 | 运行容器实际 | 当前声明 | 重建后果 |
|---|---|---|---|
| boltz2 启动命令 | entrypoint=`python` + `-m uvicorn serve:app --port 8000` | `command: null` | 镜像默认 ENTRYPOINT=`boltz` CMD=`--help` 打印即退，API 服务起不来 |
| boltz2 GPU | `--gpus all`（DeviceRequests.Count=-1） | `gpu_device_ids=[]` 且无 allocated_gpus 时不下发 `--gpus` | 无 GPU |
| proteinmpnn 挂载 | `/root/bio/bio-services/adapter:/opt/adapter:ro` + pylibs + logs | `./data/models` + named volume `proteinmpnn-tmp` | adapter 缺失，`mpnn_server:app` 不存在 |
| proteinmpnn env | `MPNN_LIB`、`TZ` | `SERVER_MODE/PROTEINMPNN_*` 等 5 项 | 与实际运行环境脱节 |
| 相对卷源 | 实际 binds 全为宿主绝对路径 | `./data/models`（相对 backend 容器 cwd） | `docker run -v ./data/models` 源路径非法，run 直接报错 |

即"声明已对齐"仅对 boltz2 的 env/volumes/ports/network/restart_policy 子集
成立；command/entrypoint 表达能力缺失 + proteinmpnn volumes/env 漂移，置
False 后重建必失败。未实施变更（生产生命周期逻辑，待评审后修复）。

### 7.4 遗留项②终态复核：rename 持久化 [已验证]

- `docker ps`：仅 `boltz2`（3719fa830a1d，Up 3 weeks healthy）与
  `proteinmpnn`（1ac3bd4b4324，Up 3 days healthy）；`docker inspect boltz`
  仅回落镜像 ID（同名容器不存在）。
- bio-net DNS（bio-backend 容器内）：`boltz` FAIL；`boltz2`/`proteinmpnn`
  正常解析；`bio-proteinmpnn` 经网络别名兼容解析。
- **新证据**：宿主 `/home/llm/boltz/docker-compose.yml` 现含
  `container_name: boltz2`，与 `.bak-20261012` 备份 diff 仅此一行
  （`container_name: boltz` → `boltz2`）——rename 已固化进 compose 工程
  定义，未来 compose 重建仍保持新名，消除"下次重启回退旧名"风险。
- 组件声明与 yml（repo ↔ 宿主 bio-config）同步状态维持 §3 结论。

## 8. 验证命令索引

```console
# 组件状态
docker exec bio-backend python - <<'PY'   # 或任意 HTTP 客户端带 JWT
GET /api/v1/docker-components/boltz2/status
GET /api/v1/docker-components/proteinmpnn/status
PY
# DNS / 探活
docker exec bio-backend python -c "import socket;print(socket.gethostbyname('boltz2'))"
curl -s http://127.0.0.1:8085/api/v1/mpnn/health
# 组件级重启
POST /api/v1/docker-components/boltz2/restart
# bindcraft 冒烟（async 提交 + status 轮询）
curl -s http://127.0.0.1:8086/api/v1/bindcraft/status/bc-20261012-212855-6c9fd282
# 遗留项复检（2026-10-13）
GET  /api/v1/docker-components            # 8 组件 is_resident 全 True
diff /home/llm/boltz/docker-compose.yml.bak-20261012 /home/llm/boltz/docker-compose.yml
docker inspect boltz2 --format '{{.State.StartedAt}}'   # Up 3 weeks：未被重建
```
