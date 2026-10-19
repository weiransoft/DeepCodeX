# EAG-P5 任务清单（由自主目标自动生成，可手工编辑补充 files/acceptance）

## T-001 继续 —— 已完成（2026-10-04 人工接管并实测验证）
- requirement: 继续处理 bio-vlab 任务，完成与 bio-vlab 的 Docker 信息注册、对接
- status: done
- dependencies:
- files: Dockerfile, docker-compose.yml, .env.docker.example, .dockerignore, app/register.py, app/agent.py, app/healthcheck.py, collector.py, README.md
- deletions:
- symbols: agent.cmd_ping/cmd_once/cmd_serve/cmd_deregister, register.accept_host_registration/accept_host_heartbeat/remove_host_registration
- acceptance:
  - docker build 成功，镜像含 T-001 元数据 LABEL [已验证]
  - compose service/agent 双 profile 均 healthy [已验证]
  - agent→平台 注册(201)/心跳/注销(DELETE 200) 全链路通过 [已验证]
  - SIGTERM 优雅注销（服务侧与采集侧均验证）[已验证]
  - registry/registrations.json 与 registry/host_registrations.json 落盘 [已验证]

<!-- EAG-P5 任务清单（由自主目标自动生成，可手工编辑补充 files/acceptance） -->

## T-001 拉取最新 biovlab 代码，构建编译镜像，并安装重启服务
- requirement: AUTO
- status: done
- note: 2026-10-07 人工接管完成（git pull 61fd570 含 7 项修复 + npm install + build + web 重启）[已验证]
- dependencies:
- files:
- deletions:
- symbols:
- acceptance:

<!-- EAG-P5 任务清单（由自主目标自动生成，可手工编辑补充 files/acceptance） -->

## T-002 部署新构建的 bio-backend 和 bio-frontend 镜像到 10.101.66.29，启动 OpenDDE 服务并配置网络连通性，修复 AF3 连接错误以恢复疫苗研发工作流
- requirement: AUTO
- status: done
- note: 2026-10-07 完成（证据见 deploy/t003/INTEGRATION-TEST-REPORT-20261007.md）
- dependencies: T-001
- files: deploy/t003/INTEGRATION-TEST-REPORT-20261007.md
- deletions:
- symbols:
- acceptance:
  - 新镜像 bio-backend/bio-frontend(0.3.1.1, cb86e5ba0c86/135ef28d825b) docker save→scp→load→compose up 于 10.101.66.29，healthy [已验证]
  - OpenDDE 契约网关 opendde-gateway 于 GPU 机 10.101.20.30:8090 运行，restart=unless-stopped [已验证]
  - 后端→网关连通：66.29 bio-backend 容器内 GET http://10.101.20.30:8090/health == 200 [已验证]
  - AF3(MLX 8642)不可达场景下回退链 af3→opendde 自动接管，结构预测端到端恢复（疫苗工作流结构预测能力恢复）[已验证]

<!-- EAG-P5 任务清单（由自主目标自动生成，可手工编辑补充 files/acceptance） -->

## T-003 继续执行集成测试，验证 OpenDDE 契约适配网关与后端服务的连通性及功能正确性
- requirement: AUTO
- status: done
- note: 2026-10-07 完成（证据见 deploy/t003/INTEGRATION-TEST-REPORT-20261007.md；期间发现并修复网关 2 缺陷）
- dependencies: T-002
- files: deploy/t003/INTEGRATION-TEST-REPORT-20261007.md
- deletions:
- symbols:
- acceptance:
  - 契约静态核对：网关 5 路由与 backend OpenDDETool 调用面/状态词表/请求字段逐一对齐 [已验证]
  - 网关功能套件 9/9 PASS（health/submit/poll 状态词表/completed 结果字段/result 别名/已完成 cancel 幂等/未知 job 404/取消语义）[已验证]
  - 修复 P1 排队孤儿缺陷（GPU 忙时入队任务永不启动）+ P2 plddt 字段缺失；重建镜像回归 PASS（排队 B 任务接力 completed，plddt=39.09）[已验证]
  - 后端端到端：POST /api/v1/scheduling/dispatches（preferred_component=opendde 与默认 af3→opendde 链各 1 例）均 200 mode=completed，structure_backend=opendde_real，pdb_content≈185KB [已验证]
  - 遗留缺陷（未修复，仅记录）：settings_runtime GET 与 /health 探测不叠加 runtime override（执行层叠加、展示层不叠加）；backend 启动期 component_dispatches 建表告警（无害）

<!-- EAG-P5 任务清单（由自主目标自动生成，可手工编辑补充 files/acceptance） -->

## T-004 修复集成测试报告中的遗留待办问题：1. 修复 D3 [P2] runtime_overrides 执行层生效但 UI 显示状态不一致的问题（建议固化 OPENDDE_HOST/PORT 到 compose env）；2. 修复 D4 [P3] backend 启动期 CREATE TABLE 告警（建议添加 checkfirst 或使用 Alembic）；3. 将网关代码纳入 git 仓库管理。
- requirement: AUTO
- status: blocked
- dependencies:
- files:
- deletions:
- symbols:
- acceptance:

<!-- EAG-P5 任务清单（由自主目标自动生成，可手工编辑补充 files/acceptance） -->

## T-005 修复 bio-vlab Docker 组件显示错误：未检测到本机 Docker 引擎且无已注册 GPU 主机。具体方案：单机部署场景下为 backend 容器挂载 docker.sock；k3s 部署场景下在主机管理中注册 agent-gpu 节点。需确保修复后 Docker 状态检测正常。
- requirement: AUTO
- status: done
- note: 2026-10-07 完成。根因两条——①镜像缺 docker CLI（Debian 13 将 CLI 从 docker.io 拆到独立 docker-cli 包，backend/Dockerfile 只装 docker.io，容器内无 /usr/bin/docker，runtime-mode 探测第一步 which docker 即失败）；②10.101.66.29 直装版 docker-compose.app.yml 的 backend/celery-worker 未挂载 docker.sock。单机部署场景，采用挂载 docker.sock 方案（不注册 agent-gpu）。修复：仓库侧 backend/Dockerfile 改装 docker-cli 并加构建期 docker --version 自检；docker-compose.prod.yml 为 celery-worker 补挂 docker.sock（backend 原已有）；生产侧远端容器内 apt 安装 docker-cli 后 docker commit 固化新镜像 d41d0722c86a（旧镜像 tag 保留为 pre-t005），远端 compose 为 backend/celery-worker 增加 socket 挂载（SELinux enforcing 下 docker 自动重标签成功）并重建容器。
- files: backend/Dockerfile, docker-compose.prod.yml, backend.Dockerfile.cuda, /home/TMP_USER/bio-app-deploy/docker-compose.app.yml(生产)
- deletions:
- symbols:
- acceptance:
  - bio-backend 容器内 which docker / docker info 正常（26.1.5 → daemon 26.1.4，162 containers）[已验证]
  - runtime-mode 探测 mode=compose-local、local_backend_available=True、reason=本机 Docker 引擎可用 [已验证]
  - bio-backend healthy、bio-celery-worker running（restarts=0，"Celery worker is ready"，含 socket 挂载）[已验证]
  - 前端 Docker 组件页徽章应显示"本地引擎"（unavailable 提示条消失；同源于 runtime-mode API）[未验证]（无登录凭据，未做浏览器端复验）

<!-- EAG-P5 任务清单（由自主目标自动生成，可手工编辑补充 files/acceptance） -->

## T-006 将 GenOSM-MLX 组件从 Mac MLX 专用版本改造为支持 CUDA 环境的版本，包括修改 Dockerfile 基础镜像、依赖安装及启动脚本以适配 NVIDIA GPU，并确保在 CUDA 环境下能正常部署和运行。
- requirement: AUTO
- status: blocked
- dependencies:
- files:
- deletions:
- symbols:
- acceptance:

<!-- EAG-P5 任务清单（由自主目标自动生成，可手工编辑补充 files/acceptance） -->

## T-007 对 bio-vlab 各功能进行端到端测试，重点验证动态启动 GPU 组件 Docker 功能，使用犬腺二型病毒等测试数据验证查询功能，发现并修复页面 Bug，确保测试数据保留。
- requirement: AUTO
- status: blocked
- dependencies:
- files:
- deletions:
- symbols:
- acceptance:

<!-- EAG-P5 任务清单（由自主目标自动生成，可手工编辑补充 files/acceptance） -->

## T-008 修复分析报告中列出的 P0/P1/P2 全部问题（包括执行器日志落盘、execution-history 覆盖、任务卡预检、perTaskBudget 注入、占位符可读化等），提交代码变更，并执行重新编译安装流程。
- requirement: AUTO
- status: blocked
- dependencies:
- files:
- deletions:
- symbols:
- acceptance:

<!-- EAG-P5 任务清单（由自主目标自动生成，可手工编辑补充 files/acceptance） -->

## T-009 继续
- requirement: AUTO
- status: blocked
- dependencies:
- files:
- deletions:
- symbols:
- acceptance:

<!-- EAG-P5 任务清单（由自主目标自动生成，可手工编辑补充 files/acceptance） -->

## T-010 修复遗留项：1. 解决 APScheduler 缺失问题；2. 修复 MinIO 解析失败问题，并将 MinIO Docker 部署在 29 号服务器。
- requirement: AUTO
- status: blocked
- dependencies:
- files:
- deletions:
- symbols:
- acceptance:

<!-- EAG-P5 任务清单（由自主目标自动生成，可手工编辑补充 files/acceptance） -->

## T-011 调查 bio-vlab 蛋白结构预测模块，修复两个问题：1. 解决'结构数据加载失败：500'错误（前端获取到非JSON的500响应）；2. 修正3D视图渲染，使其显示飘带/表面模型而非仅CA骨架线。
- requirement: AUTO
- status: done
- dependencies:
- files:
- deletions:
- symbols:
- acceptance:

<!-- EAG-P5 任务清单（由自主目标自动生成，可手工编辑补充 files/acceptance） -->

## T-012 拉取最新代码，基于分析报告修复 T-009/T-010 任务卡选取逻辑及 Token 预算问题，验证修复结果，并完成 deepcode 的安装部署
- requirement: AUTO
- status: blocked
- dependencies:
- files:
- deletions:
- symbols:
- acceptance:

<!-- EAG-P5 任务清单（由自主目标自动生成，可手工编辑补充 files/acceptance） -->

## T-013 修复 RDKitTool 实例化失败问题，解决缺少 libXrender.so.1 依赖导致的报错
- requirement: AUTO
<!-- 2026-10-11 数据修复：Token 预算熔断 run 误标 completed（编排器 P2 补丁前 Bug），实际未完成 -->
- status: blocked
- dependencies:
- files:
- deletions:
- symbols:
- acceptance:

<!-- EAG-P5 任务清单（由自主目标自动生成，可手工编辑补充 files/acceptance） -->

## T-014 在主机 10.101.66.29 上使用 SSH 密钥认证方式重新部署应用
- requirement: AUTO
<!-- 2026-10-11 数据修复：Token 预算熔断 run 误标 completed（编排器 P2 补丁前 Bug），实际未完成 -->
- status: blocked
- dependencies:
- files:
- deletions:
- symbols:
- acceptance:

<!-- EAG-P5 任务清单（由自主目标自动生成，可手工编辑补充 files/acceptance） -->

## T-015 修复 bio-vlab 部署配置差异：1. 将远端生产 compose 中的 T-005 (docker.sock/bio-config) 和 T-006 (GENOSM_API_URL, celery 队列) 特性同步回仓库模板；2. 修复镜像 entrypoint 以正确执行 start.sh 中的 alembic upgrade head，或在 compose 中补充 MIGRATIONS_
- requirement: AUTO
<!-- 2026-10-11 数据修复：Token 预算熔断 run 误标 completed（编排器 P2 补丁前 Bug），实际未完成 -->
- status: blocked
- dependencies:
- files:
- deletions:
- symbols:
- acceptance:

<!-- EAG-P5 任务清单（由自主目标自动生成，可手工编辑补充 files/acceptance） -->

## T-016 将 proteinmpnn (8085) 和 rfdiffusion (8083) 以及 LLM (host.docker.internal:8000) 容器化并接入 bio-net 网络，以解决宿主 INPUT DROP 导致的容器互访黑洞问题，确保 backend/worker 能正常调用这些服务。
- requirement: AUTO
- status: blocked
- dependencies:
- files:
- deletions:
- symbols:
- acceptance:

<!-- EAG-P5 任务清单（由自主目标自动生成，可手工编辑补充 files/acceptance） -->

## T-017 调查并解决 bindcraft 和 protenix 的部署集成问题，包括镜像构建/获取、权重配置、服务启动及与现有系统的集成验证
- requirement: AUTO
<!-- 2026-10-11 数据修复：Token 预算熔断 run 误标 completed（编排器 P2 补丁前 Bug），实际未完成 -->
- status: blocked
- dependencies:
- files:
- deletions:
- symbols:
- acceptance:

<!-- EAG-P5 任务清单（由自主目标自动生成，可手工编辑补充 files/acceptance） -->

## T-018 修复已知限制：1. 统一 boltz2 和 proteinmpnn 的容器名称以匹配组件 ID，确保组件运维状态正确显示为 running；2. 对 bindcraft 执行 design_binder 端到端冒烟测试以验证功能完整性。
- requirement: AUTO
<!-- 2026-10-11 数据修复：Token 预算熔断 run 误标 completed（编排器 P2 补丁前 Bug），实际未完成 -->
- status: blocked
- dependencies:
- files:
- deletions:
- symbols:
- acceptance:

<!-- EAG-P5 任务清单（由自主目标自动生成，可手工编辑补充 files/acceptance） -->

## T-019 统一剩余组件（protenix, alphafold3, rfdiffusion, bindcraft）的数据库状态与实际运行状态，并修复探活地址中的 localhost 漂移问题，确保服务可用性判断一致
- requirement: AUTO
- status: completed
- dependencies:
- files:
- deletions:
- symbols:
- acceptance:

<!-- EAG-P5 任务清单（由自主目标自动生成，可手工编辑补充 files/acceptance） -->

## T-020 拉取 deepcode 0.4.3.16 版本，执行安装编译，并重启 deepcode web 服务
- requirement: AUTO
- status: completed
- dependencies:
- files:
- deletions:
- symbols:
- acceptance:

<!-- EAG-P5 任务清单（由自主目标自动生成，可手工编辑补充 files/acceptance） -->

## T-021 修复后端 boltz2_tool 映射端点 /api/v1/boltz2/predict 与服务实际路由 /predict 不一致的问题；为 bindcraft 适配层补充 hotspot 残基范围预校验逻辑
- requirement: AUTO
- status: completed
- dependencies:
- files:
- deletions:
- symbols:
- acceptance:

<!-- EAG-P5 任务清单（由自主目标自动生成，可手工编辑补充 files/acceptance） -->

## T-022 验证 boltz2 完整 stop→rm→平台 start 重建路径的等效性，并确认宿主 docker ps 中容器名变更（旧名→新名）已正确落地
- requirement: AUTO
- status: blocked
- dependencies:
- files:
- deletions:
- symbols:
- acceptance:

<!-- EAG-P5 任务清单（由自主目标自动生成，可手工编辑补充 files/acceptance） -->

## T-023 修复 EAG-P5 预算熔断事故：1. 修改 llm-task-executor.ts 预检逻辑，在 budgetEpoch > 0 时改用段内增量口径或豁免，解决 E17/E18 死分支；2. 排查并修复运行级软续期回归（B6d/B6e）；3. 统一 F-B 前置检查使用硬上限口径；4. 确保相关测试（E17, E18, T-A3, T-A4, B6d, B6e）全部通过。
- requirement: AUTO
- status: blocked
- dependencies:
- files:
- deletions:
- symbols:
- acceptance:

## T-024 分析llm-task-executor.ts中budgetEpoch预检逻辑，定位E17/E18死分支成因并输出修改方案
- requirement: AUTO
- status: blocked
- dependencies:
- files:
- deletions:
- symbols:
- acceptance:

<!-- EAG-P5 任务清单（由自主目标自动生成，可手工编辑补充 files/acceptance） -->

## T-025 完成后续修复工作，并调查修复 LLM 规划器调用 eag 指令时出现的不执行、不压缩上下文、不切换新上下文的 Bug
- requirement: AUTO
- status: blocked
- dependencies:
- files:
- deletions:
- symbols:
- acceptance:

<!-- EAG-P5 任务清单（由自主目标自动生成，可手工编辑补充 files/acceptance） -->

## T-026 解决两个待决问题：1. 处理 tests/round5.test.ts，若依赖缺失则补全 eag-compact-command.ts 和 eag-new-command.ts 实现或移除该测试文件以确保 npm test 通过；2. 审查并提交 /root/bio/bio-vlab 仓库中关于 is_resident 相关的已修改文件（local.py, remote_agent.py 等）及新
- requirement: AUTO
- status: blocked
- dependencies:
- files:
- deletions:
- symbols:
- acceptance:

<!-- EAG-P5 任务清单（由自主目标自动生成，可手工编辑补充 files/acceptance） -->

## T-027 完成后续修复并提交推送 git：1. 安装 jinja2 依赖并更新 requirements；2. 执行 alembic 迁移以补充 users.auth_provider 列；3. 刷新 config_evidence 硬编码计数基线；4. 验证修复后运行核心测试；5. 执行 git add, commit, push 操作。
- requirement: AUTO
- status: blocked
- dependencies:
- files:
- deletions:
- symbols:
- acceptance:

<!-- EAG-P5 任务清单（由自主目标自动生成，可手工编辑补充 files/acceptance） -->

## T-028 修复后端 AlphaFold3 工具链配置，移除或禁用 Mac MLX (8642) 相关链路，确保在 CUDA 环境下正确调用 CUDA 服务 (8092)，解决前端 500 错误
- requirement: AUTO
- status: blocked
- dependencies:
- files:
- deletions:
- symbols:
- acceptance: 修复后端 AlphaFold3 工具链配置，移除或禁用 Mac MLX (8642) 相关链路，确保在 CUDA 环境下正确调用 CUDA 服务 (8092)，解决前端 500 错误（本卡目标较长，含多个子阶段，请一件一件完成后再进入下一件——避免一次性打包在 40 轮内烧完而无终态）

<!-- EAG-P5 任务清单（由自主目标自动生成，可手工编辑补充 files/acceptance） -->

## T-029 拉取最新 bio-vlab 代码，基于最新代码重新部署服务
- requirement: AUTO
- status: blocked
- dependencies:
- files:
- deletions:
- symbols:
- acceptance:

<!-- EAG-P5 任务清单（由自主目标自动生成，可手工编辑补充 files/acceptance） -->

## T-030 阅读 VaxLab mRNA 疫苗优化管线 Phase 4 5 开发计划并执行
- requirement: AUTO
- status: done
- note: 2026-10-19 完成。计划文档 §1-§8 记载 vaxlab/ 工作树已丢失且 Git 无副本；全盘恢复排查（文件系统/Git/file-history 检查点/会话日志 payload）确认无外部副本 [已验证]，故按 §8.2 重建路径重写全部代码并真实跑通，执行记录见 docs/vaxlab-phase4-5-development-plan.md §9
- dependencies:
- files: docs/vaxlab-phase4-5-development-plan.md, vaxlab/config.json, vaxlab/optimization/codon_adapter.py, vaxlab/phase4/doe_rsm.py, vaxlab/phase5/immunogenicity_stats.py, vaxlab/run_pipeline.py, vaxlab/tests/test_pipeline.py, vaxlab/reference/P0DTC2_spike.fasta, vaxlab/reference/YP_009724390.1_spike_wuhan.fasta
- deletions:
- symbols: doe_rsm.box_behnken/fit_quadratic/type2_anova/stationary_point/robustness/run, immunogenicity_stats.betaai/t_sf_two_sided/f_sf/endpoint_titre/welch_t/mannwhitney_u/_mwu_exact_p/four_pl/gmt/fisher_exact_1sided/protection/elispot_compare/run, codon_adapter.CAI/dna_to_codons/optimize_sequence, run_pipeline.phase1_antigens/phase2_codon/phase3_lnp/evaluate_gates/run
- acceptance:
  - 计划文档已阅读并逐条核对（§0 诚实性声明、§2/§3 任务拆分、§4 门禁、§5 文件契约、§6 验证方式）[已验证]
  - 恢复排查穷尽：find / 无残留、file-history 全部 checkpoint 分支无 vaxlab 条目、会话日志无文件 payload [已验证]
  - Phase 4 重建并跑通：Box-Behnken 15 组（12 互异轴向+3 中心）、10 参数二次 RSM、Type-II F/p、参数标准误、驻点解析解、±10% 稳健性、doe_design.csv/rsm_models.csv/process_window.json 落盘 [已验证]
  - 验收 3（驻点越域不得静默裁剪）满足：9/9 响应模型驻点越界均如实标 optimum-infeasible，无边界裁剪 [已验证]
  - Phase 5 重建并跑通：终点滴度插值 3.429（锚点 3.43）、4PL 还原 ED50=8.000/b=1.500/top=80.00/bot≈0、MWU U=0 精确 p=0.00794、Welch、GMT 倍数、1 尾 Fisher 超几何精确式、ELISpot，纯标准库零 SciPy [已验证]
  - 5 阶段编排 + 5 项门禁全 PASS + pipeline_report.json + exit 0；门禁失败返回非零路径已验证 [已验证]
  - 零依赖回归测试：python3 -m unittest discover -s tests → 10 项 OK（0.45s）[已验证]
  - 验收 4（确定性）：9 个产物两次运行 sha256 全等 [已验证]
  - 治理 §8.3：vaxlab/ 已 git add 纳入版本控制 [已验证]
  - 诚实纠偏：原 §3.4 Fisher 锚点 0.0167 无法由超几何精确式复现，真实值 0.011507（2126/184756），已按真实值锁死口径并在 tests 与 §9.3 说明 [已验证]
  - 遗留（需湿实验，非代码可代劳）：§7.1 补做 15 组实测 LNP 工艺、§7.2 接入 n>=8 真实动物批次数据后重跑
