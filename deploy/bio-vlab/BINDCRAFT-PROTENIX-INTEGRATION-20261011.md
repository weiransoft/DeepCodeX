# BindCraft / Protenix 部署集成报告（2026-10-11）

> 范围：GPU 机（10.101.20.20/本地）bindcraft 与 protenix 两个推理适配服务的
> 镜像构建、权重挂载、容器上线、bio-net 接入与 backend 集成验证；
> 附带 CORS_ORIGINS 对 GPU 机 3100 前端的放行修复。
> 所有结论均附验证命令，未标注者不成立。

## 1. CORS 修复 [已验证]

浏览器从 GPU 机前端（`http://10.101.20.20:3100` / `http://10.101.20.30:3100`）
直连 8080 API 时被 CORS 拦截（原白名单仅 `http://10.101.66.29:3000`）。
走 frontend 同源 rewrites 的场景本不受影响，本修复仅覆盖直连场景。

修改四处（默认值与显式值同源，避免模板回落漂移）：

| 文件 | 位置 |
|---|---|
| `/root/bio/appserver-deploy/.env` | `CORS_ORIGINS`（备份 `.env.bak-cors-20261011`） |
| `deploy/bio-vlab/.env` + `.env.app.example` | 模板同步 |
| `deploy/bio-vlab/docker-compose.app.yml` | backend（L137）与 celery-worker（L269）默认值，整体加单引号防 YAML flow-sequence 误解析 |

新值：

```
CORS_ORIGINS=["http://10.101.20.20:3100","http://10.101.20.30:3100","http://10.101.66.29:3000"]
```

验证（OPTIONS 预检返回对应 `access-control-allow-origin`）：

```console
$ curl -si -X OPTIONS http://127.0.0.1:8080/api/v1/jobs \
    -H "Origin: http://10.101.20.20:3100" -H "Access-Control-Request-Method: POST" | grep -i allow-origin
access-control-allow-origin: http://10.101.20.20:3100
# 20.30:3100 与 66.29:3000 同样放行
```

## 2. BindCraft（bio-bindcraft:latest，11.2GB）

- 镜像：`/root/bio/bio-services/bindcraft/Dockerfile`
  （python:3.11-slim + PyRosetta cp311 wheel + ColabDesign + BindCraft 仓库 + 8086 适配服务）
- 容器：`bindcraft`，GPU **0**，`--network appserver-deploy_bio-net --network-alias bindcraft`，
  发布 `127.0.0.1:8086:8086`
- 权重：`/root/bio/model-cache/bindcraft/params` → `/data/models/bindcraft/params:ro`
  （AF2 params 15 个 npz：model_1..5 × {base,ptm,multimer_v3}）
- jobs：`/root/bio/model-cache/jobs/bindcraft` → `/data/jobs/bindcraft:rw`

### 2.1 关键缺陷：jax 版本错配导致 CUDA 不可用 [已验证]

症状（容器启动正常但 health 报 `device: unknown`）：

```
RuntimeError: Unable to initialize backend 'cuda': INVALID_ARGUMENT:
Unexpected option name passed to PJRT_Client_Create: abort_collectives_on_failure
```

根因：镜像内 `jax/jaxlib=0.10.2` 与 `jax-cuda12-{pjrt,plugin}=0.6.0` 错配——
`pip install "jax[cuda12]==0.6.0"` 时 extras 版本约束没有把主包钉住（后续
chex/optax 等依赖安装也会把 jax 拉高）。

修复（两层保险）：

1. **镜像层**：Dockerfile 初装层显式同时钉 `jax==0.6.0 jaxlib==0.6.0
   jax-cuda12-pjrt==0.6.0 jax-cuda12-plugin==0.6.0`，并在所有 pip 层之后
   追加 `--force-reinstall --no-deps` 终钉层 + `assert jax.__version__=='0.6.0'`；
2. **运行层**：对已上线容器热修后 `docker commit bindcraft bio-bindcraft:latest` 固化。

修复后自检：

```console
$ docker exec bindcraft python -c "import jax; print(jax.devices())"
[CudaDevice(id=0)]
$ curl -s http://127.0.0.1:8086/api/v1/bindcraft/health | jq .device
"cuda"
```

## 3. Protenix（bio-protenix:latest）

- 容器：**改名 `bio-protenix` → `protenix`**（组件运维按组件 id 找容器名，
  原名导致 `runtime_state=absent`）；GPU **1**，bio-net 别名 `protenix` 不变，
  发布 `127.0.0.1:8088:8088`
- 权重：`protenix-v2/checkpoint` + `protenix/common` 只读挂载，jobs 读写挂载
- env：`PROTENIX_ROOT_DIR=/data/models/protenix`、`PROTENIX_MODEL=protenix-v2`

## 4. 组件定义（bio-config）与组件运维

- 新增 `protenix.component.yml`（health=`/api/v1/protenix/health`，gpu_device_ids=["1"]）；
- 修正 `bindcraft.component.yml`：`gpu_device_ids: ["0"]`，volumes 改为与
  运行容器一致的绝对路径（原 `./data/models` 相对路径与实际挂载不符）；
- `POST /api/v1/docker-components/scan` → `loaded_count: 8`（含 protenix）；
- 已同步回仓库 `deploy/bio-vlab/bio-config/`。

## 5. 集成验证汇总 [已验证]

| 检查项 | 命令/接口 | 结果 |
|---|---|---|
| 宿主 health | `curl :8086/api/v1/bindcraft/health` | `healthy, device=cuda, weights=15` |
| 权重清单 | `curl :8086/api/v1/bindcraft/models` | model_1..5 全量 |
| backend→服务名探活 | `docker exec bio-backend python urllib …` | bindcraft 200 / protenix 200 |
| backend 运行时健康 | `GET /api/v1/settings/runtime/health` | bindcraft up 36ms / protenix up 27ms |
| 组件实时状态 | `GET /api/v1/docker-components/{id}/status` | 两者 `runtime_state=running` |
| DNS | bio-net 内 `bindcraft`→172.22.0.16，`protenix`→172.22.0.15 | 解析正常 |

运行时健康全景（本次抓取）：mysql/redis/celery×2/opendde/af3/vllm/**bindcraft**/
**proteinmpnn**/**protenix**/**rfdiffusion**/**boltz** 共 12 项 up；
kb-mineru/kb-vllm skipped（未配置，预期）；sciminer down（外部 SaaS 301，与本平台无关）；
minio down（本机未启用 minio profile，预期降级）。

## 6. 已知限制

> [2026-10-12 更新] 第 1、3 条已闭环，详见
> `FIX-CONTAINER-NAME-AND-BINDCRAFT-SMOKE-20261012.md`。

- ~~boltz2 / proteinmpnn 组件 `runtime_state=absent`~~ **已修复（2026-10-12）**：
  容器已 rename 为 `boltz2` / `proteinmpnn`（proteinmpnn 保留 `bio-proteinmpnn`
  网络别名过渡），组件 `runtime_state=running` 且容器级启停实测可用
  （boltz2 restart 6s 恢复）。后续遗留（compose 声明漂移）亦已同日修复：
  boltz2 组件 runtime docker-container 化并对齐实际容器。
- bindcraft 容器由 `docker run` 手工上线（GPU0 绑定在命令行），非 compose 管理；
  重启宿主机后由 `--restart unless-stopped` 自动拉起，无需人工干预。
- ~~bindcraft 待补 design_binder 端到端冒烟~~ **已完成（2026-10-12）**：
  task `bc-20261012-212855-6c9fd282`（PDL1 靶点）completed，2 个设计
  mean i_pTM=0.825 / dG=-55.59 / Clashes=0，详见上述报告 §5。
- Dockerfile 全新构建验证以 `bio-bindcraft:ci-test` 在后台进行中（构建机镜像层
  已含终钉修复，本次运行容器已经 commit 固化，不阻塞上线）。
