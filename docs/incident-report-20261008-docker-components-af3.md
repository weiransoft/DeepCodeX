# 故障诊断与修复报告：Docker 组件启停失败 & AlphaFold3 不可用

- 日期：2026-10-08
- 影响页面：`http://10.101.66.29:3000/ops/docker-components`、`http://10.101.66.29:3000/protein-structure`
- 拓扑：应用服务器 10.101.66.29（无 GPU，Docker 27.3.1）；GPU 服务器 10.101.20.30（A800×2，本次所有模型服务宿主）

---

## 一、故障现象

1. `/ops/docker-components` 页面点击启动后组件始终 stopped，状态很快变 error。
2. `/protein-structure` 页面提示：**AF3 MLX 服务不可用：连接失败: All connection attempts failed**，回退 Chou-Fasman 合成算法（非真实 ML 推理）。

## 二、根因分析（全部有命令证据）

### RC-1 组件定义停留在 Mac/MLX 时代（启停失败主因）[已验证]

应用服务器 `bio-config/*.component.yml` 定义的启动命令/镜像在该机不可执行：

| 组件 | 原配置问题 | 报错证据 |
|---|---|---|
| alphafold3 | `docker run ... bio-alphafold3:latest`（本机无此镜像）→ 试图从 Docker Hub 拉取 | `docker logs` 中 pull 报错、操作日志 `exit 125`、状态 error |
| genosm-mlx | `runtime: native-script`，指向 macOS MLX 脚本 `/opt/bio-services/genosm-mlx/...` | Linux 上不存在该脚本，无法启动 |
| boltz2 | `docker-compose-service` 指向 `docker-compose.prod.yml` 中不存在的 service | `no such service: boltz2` |
| 其余 | 同上类似 | 启动任务全部失败 |

证据：`docker run` 返回码 125（镜像不存在）；`/api/v1/docker-components` 原始返回中 `alphafold3.status=error`、`genosm-mlx.runtime=native-script`。

### RC-2 Celery 队列名不匹配（启停任务"石沉大海"的直接原因）[已验证]

- API `POST /docker-components/{id}/start` 通过 `celery_app.send_task("docker_component.start")` 投递，**未指定队列 → 进入默认队列 `celery`**。
- 生产 worker 启动参数为 `-Q default,bio_workflow`，**不消费 `celery` 队列**。
- 证据：`redis-cli llen celery` = 10（任务堆积）；worker 日志 `queues: default / bio_workflow`；修复前 worker 无任何任务收讫日志。

### RC-3 AF3_HOST 指向已下线的 Mac MLX 服务 [已验证]

- 生产 backend 环境 `AF3_HOST=127.0.0.1 / AF3_PORT=8642`（Mac MLX 兼容接口遗留），应用服务器 8642 无监听 → `All connection attempts failed` → `/protein/models` 返回 `af3.is_available=false` → 前端回退 Chou-Fasman。
- 证据：修复前 `curl 127.0.0.1:8642` 返回 000（无监听）；`/api/v1/protein/models` 中 af3 带 unavailable_reason。

### RC-4 GPU 机缺少 AF3 CUDA REST 服务 [已验证]

GPU 机当时仅提供 boltz2(:8000)、genosm CUDA(:8011)、opendde(:8090)；8642/8083/8085 均无监听。

## 三、修复措施

### 3.1 GPU 服务器（10.101.20.30）

1. **AF3 CUDA REST 服务**（对齐 MLX 契约：`/api/system/status`、`/api/jobs...`）：
   - 基于官方 `alphafold3:latest` 构建 `bio-alphafold3:latest`（6.61GB，含 jax-cuda12 + hmmer 管道工具）；
   - 自研 `af3_cuda_server.py`（真执行：subprocess 调 `run_alphafold.py`，零 mock；单并发 FIFO 队列）；
   - 容器 `alphafold3` 常驻：`docker run -d --restart unless-stopped --gpus '"device=0"' -p 8642:8642`，挂载模型权重 `data_source/model → /root/models`、627G 数据库 `database_afdb → /root/public_databases`。
2. **ProteinMPNN adapter**（systemd `mpnn-api`，:8085， proteinmpnn-cli-adapter 真推理）、**RFdiffusion adapter**（systemd `rfd-adapter`，:8083）设为开机自启。
3. `ufw` 对 10.101.66.29 定向放行 8642/8083/8085/8011/8000/8090。
4. MLX 清理：容器 `genosm-mlx` 更名 `genosm-cuda`（CUDA 版）；GPU 机无 MLX 镜像残留。

### 3.2 应用服务器（10.101.66.29）

1. **重写全部 7 个组件定义**为 CUDA 常驻（resident）形态并部署到 `bio-config/`：
   - `alphafold3` → health `http://10.101.20.30:8642/api/system/status`
   - `boltz2` → :8000、`genosm`(CUDA) → :8011、`opendde` → :8090、`proteinmpnn` → :8085、`rfdiffusion` → :8083、`bindcraft` → `enabled: false`（暂无 CUDA 服务，页面置灰）
   - **删除 `genosm-mlx.component.yml`**；删除 `docker-compose.prod.yml` 中失效的 compose 引用。
2. `POST /docker-components/scan` 重扫 + API 将 6 个真实服务组件置 `is_resident=true`（resident 短路：由宿主 operator 管理，Backend 仅同步状态、绝不再 `docker run`）；`DELETE /docker-components/genosm-mlx` 清除旧记录。
3. **修复 Celery 队列 bug**：`docker-compose.app.yml` worker 参数改为 `-Q default,bio_workflow,celery`（原文件已备份 `.bak.*`），重建 `bio-celery-worker`。
4. **backend env 修正**：`AF3_HOST=10.101.20.30`、`AF3_PORT=8642`、`PROTEINMPNN/RFDIFFUSION_SERVICE_URL` 指向 GPU 机，重启 bio-backend。
5. GPU 机 `af3_cuda_server.py` 热修两处结果收集 bug 并 `docker commit` 固化进镜像：
   - 样本 glob 增加 fold-input 子目录 `output/*/seed-*_sample-*`；
   - `ranked` 存样本目录完整路径（structure 端点直接取用）。

## 四、验证结果

### 4.1 组件逐一启停验证（模拟页面操作）[已验证]

| 组件 | start | stop | health-check |
|---|---|---|---|
| alphafold3 | 200 → running | 200 → resident 状态保持（正确语义） | ✅ healthy 84ms |
| boltz2 | 200 → running | ✅ | ✅ healthy 15ms |
| proteinmpnn | 200 → running | ✅ | ✅ healthy 18ms |
| rfdiffusion | 200 → running | ✅ | ✅ healthy 67ms |
| opendde | 200 → running | ✅ | ✅ healthy 18ms |
| genosm | 200 → running | ✅ | ✅ healthy 13ms |
| bindcraft | 按设计置灰（enabled=false） | - | - |

证据：`operation-logs` 6 条 start/stop 均 success；health-check API 返回 `is_healthy:true`；redis 队列长度 0。

### 4.2 AF3 可用性与真实推理 E2E [已验证]

- `GET /api/v1/protein/models`：**af3 `is_available: true`**（不再出现"AF3 MLX 服务不可用…将回退 Chou-Fasman"）。
- 前端同源 `:3000/api/v1/protein/models`：af3/boltz2 均 available。
- GPU 真实推理（容器内 jax + A800）：作业 `ef73eca0…` 完整执行 jackhmmer(uniref90/mgy/bfd) → hmmsearch → 模型推理，产出 `seed-42_sample-0..4`、`summary_confidences.json`、`model.cif`、`ranking_scores.csv`（修复前此处被收集 bug 误判 failed，已修复）。
- 生产端点 `POST /api/v1/protein/af3/predict` E2E（2026-10-08 19:21–19:31 实测）[已验证]：
  - 请求：33 残基序列 `MKTAYIAKQRQISFVKSHFSRQLEERLGLIEVQ`；
  - 响应：`success:true`，`prediction_id=af3_796ccf9a0cfe4537`，**`is_synthetic:false`**，`algorithm=af3_mlx_real`；
  - 真实结果：PDB 22,526 字符（277 原子/33 残基），mean pLDDT **83.64**（min 54.16 / max 95.28），ptm 0.51，总耗时 630.6s（jackhmmer×4 数据管道 + JAX/A800 扩散采样）。
  - 即 `/protein-structure` 页面已走真实 AF3 推理，**不再回退 Chou-Fasman 合成算法**。

### 4.3 修复后 ops 页面状态（经前端代理 :3000 实测）[已验证]

`genosm/boltz2/alphafold3/proteinmpnn/opendde/rfdiffusion = running，bindcraft = stopped(禁用)`

## 五、遗留与建议

1. `bio-backend` 启动日志中 `APScheduler 未安装`、`MinIO minio:9000 无法解析`为非致命遗留（与本故障无关），建议后续单独处理（影响工作流下载功能）。
2. bindcraft 如需上线：在 GPU 机部署 CUDA bindcraft + adapter 后改写 `bindcraft.component.yml` 并 enable。
3. 组件定义已收敛为"resident + GPU 宿主 systemd/docker 自启"模式，GPU 机重启后组件随 docker `--restart unless-stopped` 与 systemd 自动恢复，无需再在页面点启动。
4. Celery 队列命名建议统一（生产端 send_task 显式指定 queue 或 worker 消费默认队列），避免同类问题复发。

## 附录：关键证据命令

- `redis-cli llen celery` → 修复前 10，修复后 0
- `docker inspect bio-celery-worker --format {{json .Config.Cmd}}` → `-Q default,bio_workflow,celery`
- `POST /api/v1/docker-components/{id}/health-check` ×6 → `is_healthy:true`
- `GET /api/v1/protein/models` → af3 is_available=true
- `docker exec alphafold3 ls /tmp/af3_jobs/<job>/output/*/` → 真实 sample/置信度文件
