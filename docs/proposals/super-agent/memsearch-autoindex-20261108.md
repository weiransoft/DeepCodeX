# memsearch 生产灌入与启动时自动增量索引（2026-11-08）

> 承接 [`memsearch-integration-20261108.md`](./memsearch-integration-20261108.md)。
> 上一阶段解决了「能装、能查」；本阶段解决「生产库有内容、内容会自动更新、Web 查得到且不会越权」。
> 全部数字为本机真机实测，非估算。

## 1. 结论

| 目标 | 结果 |
|---|---|
| 生产 collection 灌入 | `deepcodex_memory` 从「不存在」到 **2721 chunks**（102 篇 docs + 14 篇项目记忆） |
| 启动时自动增量索引 | 已落地，`startWebServer` listen 后 fire-and-forget；实测 **listen 6ms**、后台 4.35s 完成、语料无变化时 **0 chunks / 0 次 embedding** |
| Web 查得到共享语料 | 服务端声明的共享根与自动索引**同源**；本地多前缀过滤，越权 source 不出现 |
| `expand` 越权 | 修复：按 `chunk_hash` 直取时强制校验 source 归属，否则 **403** |
| 诚实性 | 修复「CLI exit 0 但有文件失败被报成成功」；错误详情脱敏 |

## 2. 四个关键发现（都是实测，不是推断）

1. **官方 `index` 本身就是内容哈希级增量**。`core.py:191` 非 `--force` 时只 embed `compute_chunk_id(source, start_line, end_line, content_hash, model)` 不在 `old_ids` 里的 chunk，并清理已删文件的陈旧 chunk。因此**不需要自造 mtime manifest**，也绝不传 `--force`。
2. **默认 batch 会把 as1 打爆**。`embeddings/openai.py:19` `_DEFAULT_BATCH_SIZE = 256`；超宽表格文件让单 batch 累计 `est 38545 tokens > context 32768`，CLI 输出 `Failed to index ..., skipping` 却**仍以 exit 0 结束**并报 `Indexed 2602 chunks`。已把 `batch_size = 16` 写入用户级 `~/.memsearch/config.toml`（0600）。
3. **Web 的 `--source-prefix` 与共享 docs 天然冲突**。本机 `personalOnly` 默认 `true`，前缀是 per-user 引擎数据根，`docs/` 不在其下 —— 灌进去 Web 也查不到。且官方 CLI 的 `--source-prefix` 只接受单根、不可重复。
4. **`expand` 是真实越权缺口**。它按 `chunk_hash` 直取、不走 `--source-prefix`；生产库为空时无风险，灌入 2721 chunks 后任何认证用户都能按 hash 展开他人内容。

## 3. 生产语料灌入

语料筛选遵循仓库约定：`docs/dev/`(25 篇)、`docs/fusion/`(20 篇)、`docs/research/`(5 篇) 被 `.gitignore` 明确忽略且注释写明「已从 Git 历史移除，防止误重新提交」，**不灌入**。用官方 `scan_paths` 零成本验证排除规则：`152 → 102` 篇，误留 **0**；再加显式传入的 `.workbuddy/memory/*.md` 14 篇（hidden 目录需显式文件路径，官方 scanner 支持）。

```bash
memsearch index ./docs .workbuddy/memory/*.md \
  --exclude 'dev/**' --exclude 'fusion/**' --exclude 'research/**' \
  --collection deepcodex_memory
```

| 轮次 | 结果 | 耗时 |
|---|---|---|
| 首次 | **2602 chunks / 115 files / 1 file failed**（超宽表格 batch 溢出） | 57s |
| 写入 `batch_size=16` 后增量补 | **119 chunks / 0 failed** | 5s |
| 无变化再跑（增量证据） | **0 chunks / 0 failed** | 3s |
| 最终 `stats` | **2721 chunks** | — |

**语义检索真机验证**：`memsearch search "EAG 无进展双轨熔断阈值和 deny 豁免"` → 3 命中（`EAG P5 自主迭代` 0.5000 / `6. 开关与回退契约` 0.5000 / `概述` 0.4919）；`deepcode memsearch search "结构感知分块保护哪些原子区间" --format json` → `ok:true` / `cliVersion 0.4.23` / 2 命中。

## 4. 启动时自动增量索引

### 设计取舍

- **挂载点**：`startWebServer` 的 `listen` resolve 之后。CLI `deepcode web`、`scripts/start.js web`、桌面端 tauri dev 拉起的引擎三条常驻服务入口都收敛于此；TUI / 一次性子命令是短命进程，不挂（避免重复计费）。全仓**不存在**覆盖所有入口的唯一收口点，这是按「常驻服务 + 成本 + 可清理」口径的最优单一点。
- **非阻塞**：`void`-style fire-and-forget，`startWebServer` 不 await。实测 `LISTEN_MS=6` / `/api/health=200` / listen 时 `AUTOINDEX_LOG_AT_LISTEN=0`，后台任务在 4.35s 后单独输出 `status=ok dirs=1 chunks=0 failedFiles=0 durationMs=4351`。
- **默认不污染**：未显式配置语料根时 `enabled=false`，**连 `--version` 探测都不 spawn**，因此 15+ 个既有 `startWebServer` 集成测试零回归（Web 全量 706/706 实测未 hanging）。`DEEPCODE_WEB_MEMSEARCH_AUTOINDEX=0` 可强制关闭。
- **可清理**：`close()` 首行 `autoIndex.cancel()`；`spawn` 的超时/杀进程定时器均已 `unref()`（沿用桥接层既有实现）。
- **日志脱敏**：只输出 `status / dirs / chunks / failedFiles / durationMs / skipReason` 结构化字段，**绝不输出 reason / stderr / env / `config list` 输出**。真机 `LOG_LEAKS_STDERR=false`。

### 配置（一次配置，所有常驻入口永久自动生效）

```bash
# 语料根 = 自动索引的目录 = Web 允许检索的共享前缀（单一事实源）
export DEEPCODE_WEB_MEMSEARCH_CORPUS_DIRS="/Users/wangwei/Documents/VG/DeepCodeX-cli/docs"
export DEEPCODE_WEB_MEMSEARCH_EXCLUDES="dev/**,fusion/**,research/**"
# 可选：DEEPCODE_WEB_MEMSEARCH_COLLECTION（默认 deepcodex_memory）
#       DEEPCODE_WEB_MEMSEARCH_BATCH_SIZE（默认 16）
#       DEEPCODE_WEB_MEMSEARCH_AUTOINDEX=0（强制关闭）
```

硬约束：只接受**绝对路径**（相对路径静默丢弃）、显式 `--collection`、**绝不 `--force`**、probe 前置、目录全不存在时 `no-valid-dirs` 且不假装成功、`partial` / `error` / `unavailable` 各自独立状态。

## 5. Web 检索隔离改造

| 场景 | 行为 |
|---|---|
| 未声明共享根 | **逐字零回归**：仍传 `--source-prefix <per-user 根>` 给 CLI |
| 声明共享根 | 不传 CLI 前缀（单根不够用），`top_k ×3`（上限 50）召回后在服务端按「per-user 根 + 共享根」做**路径边界安全**的本地过滤，截回用户请求的 topK；返回 `allowedPrefixes` 与 `excludedCount` |
| `expand` | 一律校验 `expansion.source` 落在允许前缀内，否则 **403** 且不返回正文 |

共享根由**服务端环境变量**声明，URL 不可覆盖；`isUnder()` 用 `path.resolve` + 分隔符边界判定，避免 `/home/user2` 被 `/home/user` 误匹配。

## 6. 代码清单

| 文件 | 改动 |
|---|---|
| `packages/core/src/common/memsearch-bridge.ts` | `MemsearchIndexOptions` 加 `excludePatterns` / `batchSize`；`MemsearchIndexOutcome` 加 `failedFiles` / `partial`；识别 stderr 的 `Failed to index ... skipping` 并按路径去重，`ok:false` 但保留 `indexedChunks` 证据；错误详情凭据脱敏 |
| `packages/web/src/memsearch-autoindex.ts` | **新增**。配置解析、probe → 目录校验 → 增量 index 编排、结构化报告、fire-and-forget 启动与 cancel、日志格式化 |
| `packages/web/src/server.ts` | listen 之后挂自动索引；`WebServerOptions.disableMemsearchAutoIndex` 注入点；`close()` cancel |
| `packages/web/src/api/memory-search-api.ts` | 共享根多前缀本地过滤；`expand` 归属校验 403 |
| `packages/core/src/tests/memsearch-index-honesty.test.ts` | **新增 8 用例**：参数契约、force A/B、部分失败、去重、脱敏、空路径零调用 |
| `packages/web/tests/memsearch-autoindex.test.ts` | **新增 10 用例**：零副作用、参数契约、六种状态、非阻塞 + cancel、日志不泄漏 |
| `packages/web/tests/memory-search-route.test.ts` | **新增 3 用例**：共享根过滤、expand 越权 403、expand 合法 200；`before` 显式关闭自动索引做环境隔离 |
| `docs/proposals/super-agent/memsearch-integration-20261108.md` | 修正过期事实（batch_size、脱敏、隔离语义、生产库已灌入） |

## 7. 验证实数

| 门禁 | 结果 |
|---|---|
| 本轮新增/扩展 3 个测试文件 | **25 / 25 / 0** |
| 既有 memsearch / memory / route / cli-args 定向 | **118 / 118 / 0** |
| Web 全量套件（官方 runner） | **706 / 706 / 0**，未 hanging |
| `npm run check`（typecheck + lint + format + IPC） | exit 0，**0 error** / 138 既有 warnings |
| core 全量 4 runner（剥离宿主 shim，后台 13m33s） | **8702 / 8684 / 0 / 18 skipped**，4/4 runner exit 0，`not ok` 0 条 |
| 真机自动索引 | `LISTEN_MS=6` / health 200 / `status=ok chunks=0 durationMs=4351` / `LOG_LEAKS_STDERR=false` / `CLOSED=ok` |
| 真机生产检索 | 官方 CLI 3 命中；TS 桥接 CLI 2 命中 `ok:true` |

## 8. 诚实边界

1. **默认仍需显式配置语料根**才执行自动索引。这是为避免污染既有集成测试与多用户共享目录而做的取舍；本轮未擅自修改桌面端启动脚本或用户 `~/.zshrc`。
2. **静态 Top-N 记忆注入未被替换**，`memory_search` 仍是并存的按需通道；L3 `transcript` 仍只由官方 CLI 直调。
3. **共享根本地过滤是 best-effort 配额**：放大 3 倍后过滤，极端情况下若全局 top-K 全是不允许来源，合法结果可能不足 topK；不会因此回落成跨用户放行。
4. **`personalOnly=false`**（共享模式）下 `skillsHomeForUser` 返回进程家目录，前缀范围显著变大；自动索引在该模式下应显式评估是否启用。
5. `~/.memsearch/config.toml` 含明文 api_key（0600、用户级、不入库）；上一阶段记录过一次 `config list` 导致的输出泄露，**仍建议在 as1 轮换该 key**。
6. 桌面端 tauri dev 引擎在本轮开始时已随后台任务回收（`54223` 不可达），Web 全量与真机验证均用独立 `startWebServer` 实例完成，未重启桌面端。
7. 工作区另有**与本任务无关**的语音链路在途改动（`package.json`、`scripts/voice/*`），本轮未触碰、未提交。

## 9. 运维

```bash
memsearch stats --collection deepcodex_memory          # 2721 chunks
memsearch search "..." --top-k 5 --collection deepcodex_memory
# 手动触发一次增量（不带 --force）
memsearch index ./docs --exclude 'dev/**' --exclude 'fusion/**' --exclude 'research/**' \
  --collection deepcodex_memory
# 查看自动索引日志：服务启动后等数秒，形如
# [memsearch-autoindex] status=ok dirs=1 chunks=0 failedFiles=0 durationMs=4351
```
