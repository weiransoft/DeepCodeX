# T-007 容器化 proteinmpnn/rfdiffusion/LLM 接入 bio-net（2026-10-10）

## 现象

- backend/worker 调用 mpnn(8085)/rfdiffusion(8083)/LLM(8000) 全部超时；
  宿主侧 `curl 127.0.0.1:8085/...` 却正常。
- `GET /api/v1/settings/runtime/health` 中 vllm/proteinmpnn/rfdiffusion 恒 down。

## 根因

1. **宿主 INPUT 黑洞**：ufw INPUT policy DROP + IOA_IP_INTERCEPT。容器发起的
   `host.docker.internal`/宿主 IP 访问经 docker bridge 注入 lo 后走 INPUT 链，
   无放行规则 → DROP；已建立 DNAT 的 conntrack 会话被黑洞化（连接挂起而非拒绝）。
2. **8000 端口错指**：`LLM_API_BASE_URL` 指向的宿主 8000 实际是 boltz 推理服务，
   不是 LLM。
3. **config.py 别名陷阱**：`LLM_API_BASE_URL` 只是 `VLLM_BASE_URL` 的只读
   property 兼容别名；仅注入 `LLM_*` env 被 pydantic 忽略，进程回落
   `http://localhost:8000/v1`（容器内=自身，永不可达）。
4. **RFdiffusion 生成路径从未工作过**（宿主 systemd 时代 outputs 目录自 8/26
   建目录以来恒空）：subprocess shell 拆词、hydra 键错组（min_b 属 diffuser 非
   denoiser）、contig 旧格式与新版解析不符、容器内 dgl 1.1.3 为 CPU 构建
   （`Operator Range does not support cuda device`）。

## 变更

- 新增 `/root/bio/bio-services/`（compose，project=bio-services）：
  bio-proteinmpnn(boltz 镜像+GPU0)、bio-rfd-api(8030，docker.sock 驱动常驻
  rfdiffusion 容器)、bio-rfd-adapter(8083)、bio-llm(ollama，复用宿主 41G 模型库)。
  全部 external 挂 `appserver-deploy_bio-net`，发布端口仅 127.0.0.1。
- `deploy/bio-vlab/docker-compose.app.yml`（repo 模板同步更新）：backend/worker
  两段 env 改指 `http://llm:11434/v1`/`http://proteinmpnn:8085`/
  `http://rfd-adapter:8083`，并补注入 `VLLM_BASE_URL/VLLM_API_KEY/VLLM_MODEL_NAME`
  （别名陷阱）。实际部署由 /root/bio/appserver-deploy/.env 覆盖生效。
- DB `docker_components` 与 `bio-config/*.component.yml`：healthcheck endpoint
  localhost → bio-net 服务名。
- rfd-api 代码修复：argv 直传、diffuser.min_b/max_b、移除 num_seq_per_target、
  `_normalize_contigs()` 兼容旧格式（原文件备份 main.py.bak-20261010）。
- rfdiffusion 容器装 dgl cu118 + nvidia cu11 运行时库并 ldconfig，
  `docker commit rfdiffusion rfdiffusion:cu11-fixed` 固化。
- 宿主 systemd：mpnn-api/rfd-adapter/rfdiffusion-api/ollama 全部
  `disable --now`（unit 保留可回滚）。

## 验证（全部实跑，2026-10-10）

| 项 | 结果 |
|---|---|
| 4 新容器 healthcheck | healthy（docker ps 可见） |
| backend/worker 内 curl 4 服务 | 全 200 |
| runtime/health | vllm/proteinmpnn/rfdiffusion/boltz/opendde/af3 = up |
| backend 进程内 settings | llm:11434 / proteinmpnn:8085 / rfd-adapter:8083 生效 |
| ProteinMPNN 推理 | success，2 序列，score 1.4001，31.9s |
| LLM chat（1.5b 从 backend 内发起） | 200，正常出 token |
| deepseek-r1:70b | 冷加载成功（~3.5min），已 keep_alive=0 释放 |
| RFdiffusion design 端到端 | success:true，PDB 200 ATOM，落盘宿主 outputs/ |

## 遗留

- minio/sciminer/protenix/bindcraft 此前即未部署（与本变更无关）。
- dgl 修复在 rfdiffusion 容器层；重建须用 `rfdiffusion:cu11-fixed` 镜像
  （命令见 /root/bio/bio-services/README.md）。
