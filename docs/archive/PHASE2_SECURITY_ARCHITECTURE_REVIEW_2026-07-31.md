# DeepCodeX-cli Phase 2 安全/架构/性能深度审查报告

**日期**：2026-07-31  
**范围**：bash-handler 命令边界、ask-user-question `suggestedCommand` 白名单、EAG exec 使用、provider 路由、permission 模型  
**审查方式**：5 路并行子代理代码走读 + 静态分析  
**结论**：发现 3 项高危、10+ 项中危风险，需修复后方可进入生产就绪状态。

---

## 1. 审查概览

| 审查面 | 关键文件 | 主要风险数 | 最高风险 |
|---|---|---|---|
| bash-handler 命令边界 | `core/src/tools/bash-handler.ts`、`common/shell-utils.ts`、`common/process-tree.ts`、`eag/p5/guards/*` | 10 | 高：guard 链未强制接入、marker 可预测、env 全量透传 |
| ask-user-question suggestedCommand | `core/src/tools/ask-user-question-handler.ts`、`cli/src/ui/core/ask-user-question.ts`、`cli/src/ui/views/App.tsx` | 7 | 高：白名单只校验命令名、参数可越权 |
| EAG exec 使用 | `eag/devops/*`、`eag/deploy/*`、`eag/long-horizon/*`、`eag/p5/*` | 9 | 高：`shell:true` 与 `execSync` 字符串拼接导致命令注入 |
| provider 路由与敏感配置 | `core/src/providers/*`、`core/src/settings.ts`、`core/src/session.ts` | 12 | 高：baseURL 无 SSRF 校验、OpenAI 缺 fail-fast、密钥明文持久化 |
| permission 模型 | `core/src/common/permissions.ts`、`core/src/settings.ts` | 10 | 高：默认 `allowAll` + `unknown` scope 放行、非法 sideEffects 降级为 allow |

---

## 2. 高危风险（P0）

### 2.1 bash-handler：EAG guard 链未强制前置接入

- **位置**：`packages/core/src/tools/bash-handler.ts` L45–88；`ToolExecutor` 调用链
- **问题**：`handleBashTool` 本身不调用 `BlockerGuardChain`，依赖调用方注入 `onBeforeToolExecution` 钩子。若调用方未接守卫，危险命令直接执行。
- **绕过示例**：直接调用 `handleBashTool({ command: "rm -rf /" }, ctx)` 即可绕过 A-1/A-2 守护。
- **修复方向**：在 `ToolExecutor` 中对 bash 等高危工具内置 `BlockerGuardChain` 执行，或将守卫结果作为 `ToolExecutionContext` 必填字段做 fail-closed 校验。
- **测试**：新增“guard 未接入时危险命令仍被拦截”的集成测试。

### 2.2 bash-handler：会话 CWD marker 可预测且可被伪造

- **位置**：`packages/core/src/tools/bash-handler.ts` L404–407、L439–462
- **问题**：marker 使用 `Math.random()` 生成，命令标准输出可被攻击者控制。若命令输出伪造 `__DEEPCODE_PWD__<marker>/evil/path`，`stripMarker` 会将其解析为下一次会话 CWD。
- **修复方向**：使用 CSPRNG（`randomUUID`/`randomBytes`）生成 marker；解析后校验 cwd 是否仍在 `projectRoot` 子树内；长期看将 marker 写入独立文件描述符。
- **测试**：补充 marker 伪造与 CWD 越界测试。

### 2.3 bash-handler：子 shell 继承完整 `process.env`

- **位置**：`packages/core/src/common/shell-utils.ts` L157–172；`bash-handler.ts` L152–153、L270–274
- **问题**：子 shell 继承父进程所有环境变量，并可读取 `createOpenAIClient().env` 透传的值，存在生产密钥/API Key/SSH Agent 泄露风险。
- **修复方向**：建立环境变量白名单/黑名单；敏感变量默认不传递给子 shell；OpenAIClient env 必须经过过滤而非直接 spread。
- **测试**：补充环境变量泄露与过滤测试。

### 2.4 ask-user-question：suggestedCommand 只校验命令名、不校验参数

- **位置**：`packages/cli/src/ui/views/App.tsx` L1442–1471；`packages/cli/src/team/team-cmd.ts`
- **问题**：白名单仅匹配首个 token（如 `/team`），但 `/team` 支持 `--task-file`、`--project-root` 等参数，可读取任意文件、切换任意目录。
- **绕过示例**：`suggestedCommand.command = "/team dispatch --role architect --task-file /etc/passwd --project-root /"`
- **修复方向**：
  1. 对 suggestedCommand 参数做白名单/沙箱校验，禁止指向项目外的路径；
  2. 或改为“预填充到输入框”由用户显式确认；
  3. 若必须自动执行，在问题界面展示完整命令与 reason 并二次确认。
- **测试**：路径穿越、任意 `--project-root`、组合参数测试。

### 2.5 EAG：`verify-stage-handler.ts` 使用 `shell: true`

- **位置**：`packages/core/src/eag/p5/handlers/verify-stage-handler.ts` L358–365
- **问题**：`spawnSync(command, [], { shell: true })` 直接以 shell 执行用户可控的 `testCommand`。
- **修复方向**：移除 `shell: true`；将 `testCommand` 解析为 `[程序, ...参数]` 数组后调用 `spawnSync(cmd, args, { shell: false })`。
- **测试**：注入含 `;`、`&&`、`|`、`$()`、反引号的恶意 `testCommand`，断言被拦截或仅执行白名单程序。

### 2.6 EAG：`git-diff-analyzer.ts` 使用字符串 `execSync` 拼接 git ref

- **位置**：`packages/core/src/eag/testing/incremental/git-diff-analyzer.ts` L172–174
- **问题**：`execSync(cmd, { ... })` 在传入字符串时默认启动 shell，`cmd` 由模板 `replace("${base}", base)` 拼接。
- **修复方向**：改用 `execFileSync("git", [...], ...)`；对 `base`/`head` 做 git ref 安全校验（仅允许 `HEAD`、commit SHA、分支名、tag，禁止空格与 shell 元字符）。
- **测试**：传入非法 ref 字符验证抛出安全错误。

### 2.7 Provider：baseURL 缺乏 SSRF 校验

- **位置**：`packages/core/src/settings.ts` L646；`providers/openai-provider.ts` L58；`providers/anthropic-provider.ts` L72、L243
- **问题**：`baseURL` 直接采信环境变量或 `settings.json`，未校验协议、主机、私网地址，可导致 SSRF、元数据窃取、内网探测。
- **修复方向**：新增 `sanitizeBaseURL`：强制仅允许 `http(s)`；拒绝 `file://`、`ftp://` 等 scheme；可选拦截 RFC1918、本地回环、链路本地及云厂商元数据地址；对项目级 `baseURL` 增加额外白名单或用户确认。
- **测试**：构造非法 baseURL（`file:///etc/passwd`、`http://127.0.0.1`、`http://169.254.169.254/latest/meta-data/`）验证抛错。

### 2.8 Provider：OpenAI 路径未 fail-fast 校验 `apiKey`

- **位置**：`packages/core/src/providers/openai-provider.ts` L30–32、L46–50
- **问题**：`createClient` 未对 `apiKey` 做 fail-fast，校验延迟到 `getUnderlyingOpenAI()`/`createMessage()`，与 Anthropic 路径不一致。
- **修复方向**：在 `OpenAIProvider.createClient` 或 `OpenAILLMClient` 构造器中增加 `if (!settings.apiKey) throw new Error(...)`；错误信息不得包含密钥。
- **测试**：补充 OpenAI 缺 key 时 `ProviderFactory.create` 抛错的用例。

### 2.9 Provider：密钥明文持久化到 `settings.json`

- **位置**：`packages/core/src/settings.ts` L745–756；`packages/core/src/settings.ts` L93–95
- **问题**：`DeepcodingSettings.env` 允许把 `API_KEY` 等写入 `settings.json`，`writeSettingsFile` 直接明文写入磁盘。
- **修复方向**：写入前对 `env` 做脱敏，删除 `API_KEY`、`LLM_API_KEY`、`ANTHROPIC_API_KEY` 等敏感键；或在设置向导中明确警告并引导使用环境变量/系统密钥链。
- **测试**：调用 `writeSettings` 后读取文件，断言不含 `API_KEY` 值。

### 2.10 Permission：默认 `allowAll` 且 `unknown` scope 被放行

- **位置**：`packages/core/src/settings.ts` L247–248；`packages/core/src/common/permissions.ts` L303–305、L320
- **问题**：默认 `defaultMode: "allowAll"`，且 `unknown` scope 在该模式下被放行。结合 `parseBashSideEffects` 对非法 `sideEffects` 降级为 `["unknown"]`，LLM 可通过构造非法 sideEffects 让高风险 bash 命令绕过权限检查。
- **修复方向**：将默认 `defaultMode` 改为 `"askAll"`；或在 `allowAll` 模式下仍对 `unknown` 返回 `ask`。
- **测试**：新增 `evaluatePermissionScopes(["unknown"], allowAll)` 返回 `ask` 的断言。

---

## 3. 中危风险（P1）

### 3.1 bash-handler

| 编号 | 问题 | 位置 | 修复方向 |
|---|---|---|---|
| B-M1 | 后台任务无超时 | `bash-handler.ts` L258–369 | 为背景任务设置默认/可配置超时；进程退出时清理 detached 子进程 |
| B-M2 | 超时直接 SIGKILL，无优雅停机 | `bash-handler.ts` L182–189；`process-tree.ts` L16–40 | 先 SIGTERM 等待宽限期，再升级 SIGKILL |
| B-M3 | `buildShellInitCommand` source 用户 `~/.bashrc`/`~/.zshrc` | `shell-utils.ts` L83–97 | 使用 `--noprofile --norc`；显式注入白名单变量 |
| B-M4 | `GIT_EDITOR=true` 让交互式 git 命令静默成功 | `shell-utils.ts` L162 | 对交互式 git 命令拦截；或将 `GIT_EDITOR` 设为 `:` 并附加警告 |
| B-M5 | JSON schema 要求 `sideEffects`，但 `bash-handler` 未读取/校验 | `templates/tools/bash.md`；`bash-handler.ts` 全文 | 在 `bash-handler`/`ToolExecutor` 层解析 `sideEffects` 并做最小权限校验 |
| B-M6 | 路径牢笼未解析符号链接、未过滤 null 字节 | `env-boundary-guard.ts` L82–97、L393–437 | 对关键写/删操作使用 `fs.realpath`；过滤 null 字节 |

### 3.2 ask-user-question

| 编号 | 问题 | 位置 | 修复方向 |
|---|---|---|---|
| A-M1 | `suggestedCommand` 随 tool message content 进入 LLM 上下文 | `core/src/tools/executor.ts`；`session.ts`；`openai-message-converter.ts` | 转换 tool message 时删除 `metadata.suggestedCommand` |
| A-M2 | 白名单与 `BUILTIN_SLASH_COMMANDS` 不一致 | `ask-user-question-handler.ts`；`ask-user-question.ts`；`slash-commands.ts` | 统一来源；未注册的从白名单移除，已注册但未加入的补齐 |
| A-M3 | `handleQuestionAnswers` 未对白名单做二次校验 | `App.tsx` L1442–1471 | 执行前显式校验首个 token；限制可自动执行的 kind 集合 |
| A-M4 | 问题界面不展示即将执行的命令 | `AskUserQuestionPrompt.tsx` | 渲染 `command` + `reason`；写操作强制二次确认 |
| A-M5 | 自动执行时未把用户回答文本传入后续流程 | `App.tsx` L1457–1462 | 先追加 `formatAskUserQuestionAnswers` 再执行命令 |
| A-M6 | 核心层与 CLI 层各维护一份白名单 | `ask-user-question-handler.ts`；`ask-user-question.ts` | 提取到 `@vegamo/deepcode-core` 公共常量；或增加构建期同步校验 |

### 3.3 EAG exec

| 编号 | 问题 | 位置 | 修复方向 |
|---|---|---|---|
| E-M1 | `namespace`/`projectName`/`image` 等缺少格式校验 | `pre-deploy-checker.ts`、`post-deploy-checker.ts`、`rollback-manager.ts` 等 | 统一 K8s/Docker 标识符校验 |
| E-M2 | IaC 生成器字符串拼接 YAML/HCL | `k8s-manifest-generator.ts`、`helm-chart-generator.ts`、`terraform-generator.ts` | 结构化数据生成 + 输入校验/转义 |
| E-M3 | 大量 `spawn`/`execFile` 未设置 timeout | `deploy/*`、`devops/*` | 统一设置 timeout（30s/60s）与强制清理 |
| E-M4 | `runRegressionTests` 任意可执行文件均可配置 | `milestone-tagger.ts` L631–647 | 对 `cmd` 做 allowlist 校验 |
| E-M5 | 回滚预案文件默认 `0o644` | `rollback-manager.ts` L859–900 | 写入时设置 `mode: 0o600` |
| E-M6 | CLI 错误输出可能泄露敏感信息 | `rollback-manager.ts`、`deploy/*` | stderr/stdout 敏感信息扫描/脱敏 |
| E-M7 | `dangerous-command-guard` 未覆盖 deploy/devops | `blocker-guard-chain.ts` | 扩展 Guard 链或新增 deploy/devops 专用校验层 |

### 3.4 Provider

| 编号 | 问题 | 位置 | 修复方向 |
|---|---|---|---|
| P-M1 | `SessionManager` 同一周期内多次解析 settings | `session.ts` L4573–4580、L920–929 | 每次请求周期解析一次 `ResolvedDeepcodingSettings` 快照 |
| P-M2 | 流式与非流式错误语义不一致 | `openai-provider.ts` L67–71、L126–131、L195–197 | 凭证/配置类错误统一抛异常；仅网络异常转为 `error` 事件 |
| P-M3 | 未知 provider 错误信息拼接不可信输入 | `provider-factory.ts` L34 | 对 `settings.provider` 做长度截断与可见字符过滤 |
| P-M4 | Anthropic 数值配置缺乏边界校验 | `settings.ts` L623–625；`anthropic-provider.ts` L74–75、L91–118 | 校验 `maxTokens > 0`、thinkingBudget < maxTokens |
| P-M5 | provider 名称大小写敏感 | `settings.ts` L600–613；`provider-factory.ts` L18–20 | 解析时 `toLowerCase()` 再校验白名单 |

### 3.5 Permission

| 编号 | 问题 | 位置 | 修复方向 |
|---|---|---|---|
| R-M1 | 路径判定未解析符号链接 | `permissions.ts` L418–447 | 比较前调用 `fs.realpathSync` |
| R-M2 | 路径判定未过滤 null 字节 | `permissions.ts` L418–447 | 拒绝含 `\0` 的路径 |
| R-M3 | `appendProjectPermissionAllows` 非原子、无并发控制 | `permissions.ts` L456–541 | 临时文件 + `fs.renameSync` 原子写；必要时加锁 |
| R-M4 | MCP 权限粒度过粗 | `permissions.ts` L278–285 | 拆分为 `mcp:<serverName>:<toolName>` 或至少 `mcp:<serverName>` |
| R-M5 | `readPermissionExemptPaths` 未经校验 | `permissions.ts` L211–229；`session.ts` L4845 | 白名单校验：绝对路径、存在、位于允许目录下 |
| R-M6 | `permissionOverrides` 可覆盖历史 toolCallId | `permissions.ts` L116–136 | 校验 `permissionOverrides` 中的 `toolCallId` 属于当前待授权批次 |
| R-M7 | `PermissionPrompt` 组件级测试缺失 | `PermissionPrompt.tsx`；`permission-prompt.test.ts` | 增加 `ink-testing-library` 组件测试 |
| R-M8 | `forceAskScopes` 外部可注入 | `permissions.ts` L192–205；`session.ts` L4844 | 限制来源、非法 scope 抛出或记录警告 |

---

## 4. 性能观察

1. **SessionManager 反复解析 settings**：主循环先调用 `createOpenAIClient()` 解析一次，再调用 `createLLMClient()` 又解析一次，同一周期内可能不一致且重复 I/O。
2. **EAG 正则 guard 链**：`dangerous-command-guard.ts` 每次命令执行需遍历 30+ 正则，虽单次 <1ms，但在高频 autonomous 循环中累计可观；可考虑将模式编译为单一 NFA 或 Trie。
3. **大输出截断**：`bash-handler.ts` MAX_CAPTURE_CHARS = 10MB，字符串拼接在 Node 中可能造成短期大内存占用，需确认是否有流式截断计划。
4. **会话消息全量序列化**：`OpenAIMessageConverter` 每次请求转换全部历史消息，长会话下 O(n) 累积；建议引入上下文窗口压缩/摘要机制。

---

## 5. 修复计划（按优先级）

### P0（必须修复，阻断生产）

1. **baseURL SSRF 校验**：新增 `sanitizeBaseURL`，在 `settings.ts` 解析阶段与 `ProviderFactory.create` 阶段双重校验。
2. **OpenAI fail-fast 校验 `apiKey`**：与 Anthropic 保持一致。
3. **Permission 默认策略收紧**：默认 `defaultMode` 改为 `askAll`；或在 `allowAll` 下 `unknown` 永远 `ask`。
4. **bash-handler 强制接入 guard 链**：在 `ToolExecutor` 内置 `BlockerGuardChain` 或要求守卫结果字段。
5. **bash-handler marker 安全加固**：使用 `randomUUID` 并校验 CWD 边界。
6. **bash-handler 环境变量白名单**：过滤敏感变量。
7. **EAG `shell:true` 移除**：`verify-stage-handler.ts` 改为数组参数。
8. **EAG `git-diff-analyzer` 改为 `execFileSync`** + ref 校验。
9. **ask-user-question 参数沙箱**：禁止 `--task-file`/`--project-root` 等项目外路径；或改为预填充输入框。
10. **settings.json 密钥脱敏**：写入前删除敏感 `env` 键。

### P1（建议本迭代修复）

1. 为 EAG `spawn`/`execFile` 统一加 timeout。
2. 统一校验 K8s/Docker 标识符。
3. IaC 生成器结构化生成 + 输入校验。
4. `appendProjectPermissionAllows` 原子写 + 并发测试。
5. 路径判定 `realpath` + null 字节过滤。
6. `suggestedCommand` 不出现在 LLM 上下文。
7. `PermissionPrompt` 二次确认与展示命令。
8. Provider settings 快照一致性。

### P2（后续迭代）

1. MCP 细粒度权限模型。
2. 环境变量写保护（`env-boundary-guard`）覆盖 deploy/devops。
3. CLI 输出敏感信息脱敏。
4. 性能：settings 缓存、guard 正则优化、上下文窗口压缩。

---

## 6. 测试计划

每项 P0/P1 修复必须配套新增/更新测试，放在 `tests` 目录或各包 `src/tests` 下：

- `provider-security.test.ts`：baseURL SSRF、apiKey fail-fast、密钥不落地。
- `permissions-unknown-scope.test.ts`：默认策略、`unknown`、非法 `sideEffects`。
- `bash-handler-guard-integration.test.ts`：guard 强制接入、marker 伪造、env 过滤。
- `eag-exec-safety.test.ts`：`shell:true` 移除、git ref 注入、timeout、标识符校验。
- `ask-user-question-safety.test.ts`：参数越界、白名单对齐、metadata 不泄露。
- `permissions-concurrency.test.ts`：并发持久化、路径符号链接/null 字节。

---

## 7. 总体结论

当前代码在功能层面已较完整，但安全边界存在多处可被利用的缺口，主要集中在：

- **默认策略过宽**（permission `allowAll` + `unknown` 放行）
- **外部输入未充分校验**（baseURL、git ref、test command、K8s 标识符、ask-user-question 参数）
- **敏感信息保护不足**（env 全量透传、密钥明文持久化、CLI 输出可能泄露）
- **guard 链覆盖不完整**（bash-handler 可选接入、deploy/devops 未覆盖）

建议：先完成 P0 修复并通过测试，再由 QA/安全角色进行一轮渗透验证；P1/P2 纳入后续迭代排期。
