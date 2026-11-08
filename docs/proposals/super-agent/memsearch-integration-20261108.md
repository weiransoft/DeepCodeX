# memsearch 接入实施报告（2026-11-08）

> 决策：采纳「直接安装官方 `zilliztech/memsearch` + TS 桥接」，**不**在 TypeScript 里复刻向量库 / embedding / 分块。
> 官方 CLI 是唯一检索实现，DeepCodeX 只做参数组装、子进程调用、JSON 解析与诚实降级。

## 1. 为什么改方案

原计划「完整复刻」需要处理三处架构冲突：既有提案明确「❌ 不做向量语义检索 / 零外部依赖内核」、ONNX bge-m3 约 558MB 默认从 HuggingFace 下载（本机 `huggingface.co` 实测 `000` 不可达）、Milvus schema 与混合检索需自行维护。

直接安装后这三点全部消失：

| 卡点 | 结论 |
|---|---|
| 依赖安装 | `uv tool install memsearch` 隔离 venv，Python 3.12，`memsearch 0.4.23`（MIT），不污染系统 Python / 项目内核 |
| pypi 超时 | 官方源拉 `pydantic` 超时 76s → 清华镜像 `0.37s`，`--default-index` 重装成功 |
| embedding 模型 | as1 实测 `/v1/models` 有 **`qwen3-embedding`**（维度 **1024**），`openai.py` 原生支持 `OPENAI_BASE_URL` / CLI `--base-url --api-key --model`；**不需要 bge-m3、不访问 HuggingFace** |
| Milvus | Milvus Lite 默认 `~/.memsearch/milvus.db`，零配置 |

## 2. 安装与配置（本机已落地）

```bash
uv tool install memsearch --default-index https://pypi.tuna.tsinghua.edu.cn/simple
# ~/.local/bin/memsearch → 0.4.23
```

`~/.memsearch/config.toml`（**0600，用户级，不进仓库**）：

```toml
[embedding]
provider = "openai"
model = "qwen3-embedding"
base_url = "https://as1.hongene-sh.com/v1"
api_key = "<本机 API key，从 ~/.deepcode/desktop-secrets.db 的 apiKeyRef 取得>"

[milvus]
uri = "~/.memsearch/milvus.db"
collection = "deepcodex_memory"
```

凭证说明：`desktop.json` 只存 42 字符 `apiKeyRef`，明文在 `~/.deepcode/desktop-secrets.db` 的 `secrets` 表（`service=com.vegamo.deepcode.desktop`、`account=model:<uuid>`）。为让 CLI / 桌面端无需每次 `export`，把明文写入 0600 的用户级 `config.toml`，安全等级与既有 `secrets.db`（0600）等价。

⚠️ **过程中一次失误**：`memsearch config list` 的输出本应过滤 `api_key`，但过滤表达式用了 `\s`（macOS BSD grep 不支持），导致明文 key 出现在一次工具输出里。后续命令不再调用 `config list`。**建议视情况在 as1 轮换该 key**；如要不落盘，把 `api_key` 改回 `"env:MEMSEARCH_API_KEY"` 并在启动环境注入。

## 3. 真机验证（非 mock）

| 验证 | 实测 |
|---|---|
| `/v1/embeddings` | 200，维度 **1024**，model `qwen3-embedding` |
| `memsearch index` 临时语料 | `Indexed 4 chunks.`（首次初始化 Milvus Lite + trial embed 探测维度） |
| `memsearch stats` | `Total indexed chunks: 4` |
| `memsearch search "无进展熔断阈值和 deny 豁免" --json-output` | 3 条；Top1 `无进展双轨熔断` score **0.99999994**，语义排序正确 |
| `memsearch expand <hash> --json-output` | 返回完整章节 `start_line 6 / end_line 8` |
| 不带任何环境变量直接 search | exit 0，命中 `TNS 与结构感知分块` |
| `deepcode memsearch search "无进展熔断阈值" --collection dcx_smoke` | exit 0，`ok:true` / `cliVersion 0.4.23` / 2 命中（0.5000、0.4919） |

`search --json-output` 顶层是**数组**，字段：`chunk_hash / content / source / heading / heading_level / start_line / end_line / score`；`expand --json-output` 是**对象**：`chunk_hash / source / heading / start_line / end_line / content`。

## 4. 代码结构

| 文件 | 职责 |
|---|---|
| `packages/core/src/common/memsearch-bridge.ts` | 新增。可执行文件发现（`DEEPCODE_MEMSEARCH_BIN` > PATH > `~/.local/bin`）、真实 spawn + 超时 + SIGKILL 兜底、L1 search / L2 expand / index / stats、严格 JSON 解析与脏数据计数 |
| `packages/core/src/tools/memory-search-tool.ts` | 新增。`memory_search` LLM 工具：L1 返回 300 字预览 + `chunk_hash`，传 `expand_hash` 走 L2 |
| `packages/core/src/session.ts` / `index.ts` | 注册工具、导出桥接 API |
| `packages/core/src/v2/memory/memory-commands.ts` | `/memory search <query> [--top-k n]`，检索函数**依赖注入**（遵守 V2→V1 单一入口约束，用结构化类型不跨层 import） |
| `packages/cli/src/memsearch/memsearch-cmd.ts` | `deepcode memsearch search/expand/index/stats/help`，human-first + `--format json`，失败只写 stderr |
| `packages/cli/src/cli-args.ts` / `cli.tsx` | yargs 注册与路由 |
| `packages/cli/src/ui/views/App.tsx` | TUI 注入 `searchMemories` |
| `packages/web/src/api/memory-search-api.ts` / `server.ts` | `GET /api/memory/search?q=&top_k=&expand=`，挂全局 JWT 门禁之后 |

### 诚实降级（硬约束）

CLI 缺失 / 超时 / 非零退出 / JSON 非法 / 字段全不合规，一律 `ok:false` + 具体 `status`（`unavailable | error | timeout | invalid-output`）+ `reason` + `hint`，**绝不用空结果伪装成功**；stderr 原文进入 reason。只有拿到合法结果（含合法空数组）才 `ok:true`。

- Web：CLI 不可用 `503`，调用失败 `502`，缺参数 `400`；默认用 `--source-prefix` 限定到 `skillsHomeForUser(settings, ctx.userId)`，不接受 URL 覆盖，避免跨用户越权。
- LLM 工具：工具描述里明写「`ok:false` 时不得编造召回事实」。

## 5. 验证实数

| 门禁 | 结果 |
|---|---|
| 新增 5 个测试文件 | **41 / 41 / 0** |
| 既有 `/memory` + Web 路由回归 | **48 / 48 / 0** |
| 既有 `cli-args` 回归 | **65 / 65 / 0** |
| `npm run check`（typecheck + lint + format + IPC） | exit 0，**0 error** / 138 既有 warnings |
| `npm run build`（core → web → bundle） | exit 0；`templates 16 / bundled 130`；`cli.js` 含 `searchMemories` / `memory_search` / `handleMemorySearch` |
| 真实 as1 端到端冒烟 | exit 0，2 命中 |

五个测试文件：`memsearch-bridge.test.ts`（17）、`memory-search-tool.test.ts`（6）、`memory-search-command.test.ts`（7）、`memsearch-cli-e2e.test.ts`（7）、`memory-search-route.test.ts`（4）。CLI/Web 测试用临时 fake CLI 保证确定性，但 yargs → 路由 → bridge → JSON 解析全为真实链路；另有一次真实 as1 冒烟。

## 6. 使用方式

```bash
deepcode memsearch search "过去的构建为什么失败" --top-k 5
deepcode memsearch search "TNS" --format json
deepcode memsearch expand 3ae1e0f660051529
deepcode memsearch index ./docs --collection deepcodex_memory
deepcode memsearch stats
```

- TUI：`/memory search 无进展熔断阈值 --top-k 5`
- Web：`GET /api/memory/search?q=...&top_k=5`（需 JWT Cookie）；`?expand=<hash>` 走 L2
- LLM：模型自主调用 `memory_search` 工具（按需召回，不改动现有静态 Top-N 注入）

## 7. 诚实边界（未覆盖）

1. **没有替换静态 Top-N 注入**。`renderSoulPrompt()` / `injectIntoSystemPrompt()` 仍是会话创建时一次性注入；`memory_search` 是并存的「按需召回」通道，不是替换。要改成每轮自动召回需给 `refreshContextAsync(sessionId)` 补 query 透传，改动面更大，本轮未做。
2. **L3 transcript 只由官方 CLI 直调**（`memsearch transcript <path>`），TS 桥接未封装。
3. **Web 的 per-user 隔离是 `--source-prefix` 过滤**，前提是索引时已把各用户 markdown 语料纳入同一 collection；未索引该前缀时接口会如实返回 0 条，不会跨用户回落。
4. **首次使用必须先 `index`**，否则搜索恒为空；这是官方设计，不是缺陷。
5. 本机验证用临时语料 `/tmp/dcx-ms-*` 与 collection `dcx_smoke`；生产 collection `deepcodex_memory` 尚未灌入项目文档。
6. 工作区里另有**与本任务无关**的语音链路在途改动（`package.json`、`scripts/voice/*`），本轮未触碰、未提交。
7. `memsearch config list` 会把 `env:` 引用解析成明文打印，**禁止**把它的输出写进日志或报告。

## 8. 运维

```bash
memsearch --version
memsearch stats --collection deepcodex_memory
memsearch reset --yes            # 清索引后需重新 index
# 换 embedding 服务：改 ~/.memsearch/config.toml 后必须 --force 重建索引
memsearch index ./docs --force
```
