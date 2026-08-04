# DeepCodeX-cli Phase 2 P0 安全修复实施方案

**日期**：2026-07-31  
**依据**：[PHASE2_SECURITY_ARCHITECTURE_REVIEW_2026-07-31.md](./PHASE2_SECURITY_ARCHITECTURE_REVIEW_2026-07-31.md)  
**范围**：Provider/Settings、bash-handler、EAG exec、ask-user-question 四个面的 10 项 P0 修复

---

## 1. 目标

在不改变业务功能的前提下，关闭 Phase 2 审查报告中列出的 10 项 P0 高危风险，并配套单元/集成测试验证。

---

## 2. 修复清单与实现方案

### 2.1 Provider/Settings

#### P0-1 baseURL SSRF 校验（settings.ts）

- 现状：`sanitizeBaseURL` 已存在，但 `resolveSettingsSources` 返回的 `baseURL` 仍未调用它。
- 方案：
  1. 在 `resolveSettingsSources` 中，对最终写入 `baseURL` 的值调用 `sanitizeBaseURL(trimString(env.BASE_URL) || defaultBaseURL, processEnv)`。
  2. 保持 `DEEPCODE_ALLOW_PRIVATE_BASE_URL=true` 作为本地 Ollama 调试的显式放行开关。
  3. 错误信息不包含原始 URL，避免泄露。
- 文件：
  - `packages/core/src/settings.ts`（`resolveSettingsSources`）
- 验收：
  - `http://127.0.0.1:8000/v1` 默认抛错。
  - `DEEPCODE_ALLOW_PRIVATE_BASE_URL=true` 时放行。
  - `file:///etc/passwd`、`ftp://x`、`http://user:pass@x` 均抛错。

#### P0-2 OpenAI fail-fast 校验 apiKey（openai-provider.ts）

- 现状：`OpenAILLMClient` 构造器不校验 `apiKey`，延迟到 `getUnderlyingOpenAI()`/`createMessage()`。
- 方案：在 `OpenAILLMClient` 构造器首行增加 `if (!settings.apiKey) throw new Error("OpenAI provider 需要 env.API_KEY，请检查 settings.json 配置")`。
- 文件：
  - `packages/core/src/providers/openai-provider.ts`
- 验收：
  - `ProviderFactory.create({ provider: "openai", apiKey: undefined })` 立即抛错，错误信息含 "API_KEY"。

#### P0-3 settings.json 密钥脱敏（settings.ts）

- 现状：`writeSettingsFile` 把 `settings.env` 中的 `API_KEY` 等明文写入磁盘。
- 方案：
  1. 新增 `SENSITIVE_ENV_KEYS = new Set(["API_KEY", "LLM_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "BASE_URL", "LLM_BASE_URL"])`。
  2. `writeSettingsFile` 在序列化前对 `settings.env` 深拷贝并删除上述键；不修改传入对象。
  3. 仅脱敏顶层 `env`，不动 `mcpServers[*].env`（MCP 子进程需要这些值，且写入位置不同）。
- 文件：
  - `packages/core/src/settings.ts`
- 验收：
  - 调用 `writeSettings({ env: { API_KEY: "sk-xxx" } })` 后，文件内容不含 `"sk-xxx"`。
  - 非敏感键（如 `MODEL`）保留。

### 2.2 Permission 模型

#### P0-4 unknown scope 在 allowAll 下仍 ask（permissions.ts）

- 现状：`evaluatePermissionScopes` 对 `unknown` 仅在 `defaultMode !== "allowAll"` 时返回 `ask`。
- 方案：
  1. `evaluatePermissionScopes` 中，只要 `scopes` 含 `unknown` 即返回 `ask`（fail-safe）。
  2. 同步调整 `getPermissionScopesRequiringAsk`，对 `unknown` 无条件加入结果。
- 文件：
  - `packages/core/src/common/permissions.ts`
- 验收：
  - `evaluatePermissionScopes(["unknown"], { defaultMode: "allowAll" })` 返回 `"ask"`。
  - `evaluatePermissionScopes(["read-in-cwd", "unknown"], allowAll)` 返回 `"ask"`。

### 2.3 bash-handler

#### P0-5 marker 安全加固（bash-handler.ts）

- 现状：`buildMarker` 使用 `Math.random()`，且 `stripMarker` 解析的 CWD 不做项目边界校验。
- 方案：
  1. `buildMarker` 改用 `randomUUID()` 生成不可预测 marker。
  2. `handleBashTool` 在 `updateSessionCwd` 前调用新的 `validateCwdWithinProjectRoot(result.cwd, context.projectRoot)`；越界时保留原 CWD 并记录。
  3. `stripMarker` 仅负责解析，校验外移到调用方。
- 文件：
  - `packages/core/src/tools/bash-handler.ts`
- 验收：
  - marker 长度/字符集不可预测。
  - 伪造 marker 指向 `/etc` 时，session CWD 不更新。

#### P0-6 子 shell 环境变量过滤（shell-utils.ts / bash-handler.ts）

- 现状：`buildShellEnv` 直接把 `process.env` 全量 spread 给子 shell，并通过 `extraEnv` 传入 OpenAI 配置。
- 方案：
  1. 新增敏感键黑名单 `SENSITIVE_ENV_KEY_PATTERNS`，匹配 `API_KEY`、`SECRET`、`TOKEN`、`PASSWORD`、`PRIVATE_KEY`、`SSH_AUTH_SOCK`、`DEEPCODE_*` 等。
  2. `buildShellEnv` 在合并 `process.env` 与 `extraEnv` 后，删除黑名单命中的键；保留 `PATH`、`HOME`、`USER`、`SHELL`、`LANG`、`PWD` 等白名单基础变量。
  3. 黑名单优先于白名单：只要命中黑名单即删除。
- 文件：
  - `packages/core/src/common/shell-utils.ts`
- 验收：
  - 子 shell 环境中不存在 `API_KEY`。
  - `PATH` 保留，命令仍可执行。

### 2.4 EAG exec

#### P0-7 verify-stage-handler 移除 shell:true（verify-stage-handler.ts）

- 现状：`spawnSync(command, [], { shell: true })` 直接执行字符串。
- 方案：
  1. 使用 `parseShellCommand(command)` 拆分为 `[program, ...args]`。
  2. 调用 `spawnSync(program, args, { shell: false, ... })`。
  3. 对 `program` 做白名单校验：仅允许 `npm`、`node`、`npx`、`pnpm`、`yarn`、`tsc`、`vitest`、`jest`、`mocha`、`python`、`python3`、`pytest` 等常见测试程序；不在白名单时抛出安全错误。
  4. 解析失败（如含 `;`、`&&`、`|`、`$()`、反引号）也抛错。
- 文件：
  - `packages/core/src/eag/p5/handlers/verify-stage-handler.ts`
- 验收：
  - `"npm test"` 正常执行。
  - `"npm test; rm -rf /"` 抛安全错误，不执行。
  - `"node -e 'console.log(1)'"` 正常执行。

#### P0-8 git-diff-analyzer 改用 execFileSync + ref 校验（git-diff-analyzer.ts）

- 现状：模板字符串 `replace("${base}", base)` 后传给 `execSync`，默认启动 shell。
- 方案：
  1. 新增 `validateGitRef(ref)`：仅允许 `HEAD`、40/64 位十六进制 commit SHA、分支名/tag（`[A-Za-z0-9_.@{}^~/-]+`），禁止空格、反斜杠、美元符号、反引号、分号。
  2. `runGitDiff` 改为 `execFileSync("git", ["-c", "core.quotepath=false", "diff", "--name-status", "${base}..${head}"])` 的数组形式；用 `base..head` 字符串作为最后一个参数。
  3. 删除 `GIT_DIFF_NAME_STATUS_TEMPLATE` 字符串模板常量。
- 文件：
  - `packages/core/src/eag/testing/incremental/git-diff-analyzer.ts`
- 验收：
  - `base="origin/main"`、`head="HEAD"` 正常执行。
  - `base="main; rm -rf /"` 抛安全错误。

### 2.5 ask-user-question

#### P0-9 suggestedCommand 参数沙箱（ask-user-question.ts / App.tsx）

- 现状：白名单仅校验首个 token，不限制 `--task-file /etc/passwd`、`--project-root /` 等参数。
- 方案：
  1. 在 `packages/core/src/tools/ask-user-question-handler.ts` 的核心层白名单函数中，新增参数校验：
     - 禁止 `--task-file`、`--task_file` 等指向项目外的路径；
     - 禁止 `--project-root`、`--project_root` 指向当前项目根之外；
     - 禁止任何 `../`、绝对路径 `/etc/passwd`、以及 `~` 展开。
  2. CLI 层 `normalizeSuggestedCommand` 增加同样的参数校验作为第二道防线。
  3. 校验失败时降级为不自动执行（仅发送回答）。
- 文件：
  - `packages/core/src/tools/ask-user-question-handler.ts`
  - `packages/cli/src/ui/core/ask-user-question.ts`
- 验收：
  - `/team dispatch --task-file /etc/passwd` 被拦截。
  - `/team dispatch --project-root /tmp` 被拦截。
  - `/team dispatch --role architect` 放行。

#### P0-10 ask-user-question 二次确认展示（AskUserQuestionPrompt.tsx）

- 现状：UI 不展示即将自动执行的命令。
- 方案：
  1. 在 `AskUserQuestionPrompt` 组件中，当 `suggestedCommand` 存在时，渲染命令字符串与 reason。
  2. 对写操作/文件相关命令显示二次确认提示。
- 文件：
  - `packages/cli/src/ui/components/AskUserQuestionPrompt.tsx`（或对应路径）
- 验收：
  - UI 快照/测试可捕获到 suggestedCommand 文本。

---

## 3. 测试计划

### 3.1 新增测试文件

| 测试文件 | 覆盖内容 |
|---|---|
| `packages/core/src/tests/provider-security.test.ts` | baseURL SSRF、OpenAI 缺 key、settings.json 脱敏 |
| `packages/core/src/tests/permissions-unknown-scope.test.ts` | unknown scope 在 allowAll 下 ask |
| `packages/core/src/tests/bash-handler-safety.test.ts` | marker CSPRNG、CWD 越界、env 黑名单 |
| `packages/core/src/eag/p5/handlers/tests/verify-stage-handler-safety.test.ts` | shell:true 移除、命令注入拦截 |
| `packages/core/src/eag/testing/incremental/tests/git-diff-analyzer-safety.test.ts` | 非法 ref 拦截、execFileSync 调用 |
| `packages/cli/src/ui/core/tests/ask-user-question-safety.test.ts` | suggestedCommand 参数越界、白名单 |

### 3.2 回归测试

- 运行 `npm test`（工作区级）。
- 运行 `npm run typecheck`。
- 运行 `npm run lint`。

---

## 4. 验收标准

1. 全部 10 项 P0 修复在源码中落地。
2. 每项修复至少有一个正向/负向测试用例。
3. `npm test`、`npm run typecheck`、`npm run lint` 全部通过。
4. 代码中无新增 TODO/FIXME（已实现的 TODO/FIXME 不残留）。
5. 不改变现有 CLI 正常交互流程（仅收紧安全边界）。

---

## 5. 风险与回退

| 风险 | 缓解 |
|---|---|
| SSRF 校验误拦截本地 Ollama | 提供 `DEEPCODE_ALLOW_PRIVATE_BASE_URL=true` 显式开关 |
| env 黑名单过严导致工具链找不到依赖 | 保留 `PATH`、`HOME`、`USER`、`SHELL` 等基础变量 |
| unknown scope 一律 ask 增加交互频率 | P0 安全优先；P1 可优化合法 sideEffects 推断 |
| verify-stage-handler 白名单限制测试框架 | 初始白名单覆盖常见 Node/Python 测试命令，后续可扩展 |

