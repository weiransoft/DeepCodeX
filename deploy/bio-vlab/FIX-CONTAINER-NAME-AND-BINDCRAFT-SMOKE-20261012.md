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

## 7. 验证命令索引

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
```
