# DeepCodeX-cli 新特性全量审查修复计划

> **版本**：v1.0
> **日期**：2026-07-30
> **关联文档**：
> - 新特性总览：[docs/new-features.md](new-features.md)
> - 架构审查报告：本计划 §3 引用架构师审查结论
> - V2 上下文记忆：[docs/fusion/V2_CONTEXT_MEMORY_PRD.md](fusion/V2_CONTEXT_MEMORY_PRD.md)
> - EAG 企业应用生成：[docs/enterprise/ENTERPRISE_APP_GENERATION_DESIGN.md](enterprise/ENTERPRISE_APP_GENERATION_DESIGN.md)

---

## 1. 目标

对照 `docs/new-features.md` 检查 A-J/K/L/M-O 能力域的实现与集成，修复已识别的核心差异，确保：

1. V2 上下文记忆真正接入 CLI 主循环；
2. EAG 公共 API 完整导出，CLI 层可合法注入 orchestrator；
3. quality-gates 评分算法正确使用 `weight` 与 `required` 字段；
4. quality-gates 真实 executor 具备充分的单元测试覆盖；
5. 全部改动通过 `typecheck` 与相关测试，文档与代码保持一致。

---

## 2. 问题清单与优先级

| 优先级 | 问题 | 风险等级 | 关联能力域 |
|--------|------|----------|------------|
| P0 | VS Code Webview assistant 消息 XSS（`innerHTML = content`） | Critical | I. 日志与可观测性 / UI |
| P0 | V2 Context 未真正接入 CLI | 高 | E. V2 上下文记忆 |
| P0 | EAG 公共 API 导出缺口 | 中高 | C. EAG / D. Loop-Graph |
| P1 | quality-gates 评分未使用 weight / required | 中高 | A. 多角色协作 |
| P1 | quality-gates executor 测试覆盖不足 | 中 | A. 多角色协作 |
| P1 | DangerousCommandGuard 黑名单可绕过 | 中高 | B. 自主编排 |
| P2 | `scripts/build.js` 使用 `shell: true` | 中 | 构建安全 |
| P2 | `SkillInjector` 极简 YAML 解析器脆弱 | 中 | H. Builtin Skills |
| P2 | `session.ts` 硬编码阈值过多 | 中 | E. V2 上下文记忆 |
| P2 | 长耗时 E2E 测试混入默认 `npm test` | 中 | 测试性能 |
| P2 | Dynamic Workflows 6 大模式、11 状态机、web-artisan/code-mode-orchestrator 测试缺失 | 中 | B. 自主编排 / H. Builtin Skills |
| P3 | `session.ts` 过于臃肿 | 低 | 架构健康度 |
| P3 | TODO/FIXME 门禁与 EAG 占位 TODO 冲突 | 低 | A. 多角色协作 |

---

## 3. 修复方案

### 3.1 V2 Context 真正接入 CLI

**现状**：
- `packages/cli/src/ui/views/App.tsx:232-234` 使用 `new DefaultSessionContextHook()`，未启用 `DualLayerContextManager`；
- `packages/core/src/session.ts:1708-1727` 的 `handleUserPrompt` 未在 turn 入口调用 `contextHook?.refreshContextAsync(sessionId)`。

**修复步骤**：
1. 在 `packages/core/src/v2/context/dual-layer-manager.ts` 或 `packages/core/src/v2/integration/session-hook.ts` 新增工厂函数 `createDualLayerContextHook(projectRoot, v2Config?)`，返回实现 `SessionContextHook` 的适配对象：
   - 内部持有 `DualLayerContextManager` 实例；
   - `refreshContextAsync(sessionId)` 调用 `buildOptimizedContext(sessionId)` 并将结果写入缓存；
   - `preBuildContext(messages)` 同步返回缓存片段。
2. 在 `App.tsx:232-234` 将 `contextHook` 替换为 `createDualLayerContextHook(projectRoot, resolvedSettings)`；后台任务使用独立的 context hook 实例。
3. 在 `session.ts:1708-1727` 的 `handleUserPrompt` 中，于 `createSession` / `replySession` 之前调用 `await this.contextHook?.refreshContextAsync(this.activeSessionId)`。
4. 未注入或不可用时，降级为 `DefaultSessionContextHook` 行为，保证零回归。

**验证检查点**：
- [ ] `App.tsx` 使用 `createDualLayerContextHook`；
- [ ] `session.ts` 在 turn 入口调用 `refreshContextAsync`；
- [ ] `buildMessages` 保持同步签名；
- [ ] 未启用 V2 时无 `## V2 Context` 区块，启用后出现。

### 3.2 EAG 公共 API 导出及 CLI 注入

**现状**：
- `packages/core/src/index.ts` 未 re-export `eag/index.ts`，仅零散导出了部分子模块；
- CLI 层无法通过 `@vegamo/deepcode-core` 访问 `CodingOrchestrator`、`TestingOrchestrator`、`AutonomousOrchestrator` 等。

**修复步骤**：
1. 在 `packages/core/src/index.ts` 新增命名空间导出：
   ```ts
   export * as Eag from "./eag/index.js";
   export * as EagP5 from "./eag/p5/index.js";
   ```
2. 检查 `packages/core/src/eag/index.ts` 是否已导出 `p5` 子模块；如缺失则补充 `export * from "./p5/index";`。
3. 在 `App.tsx` 的 `SessionManager` 构造中，根据配置统一构造并注入 EAG orchestrator 实例（`evaluator`、`codingOrchestrator`、`testingOrchestrator`、`designOrchestrator`、`autonomousOrchestrator`、`graphLoopOrchestrator` 等）；未启用时保持 `undefined`，主循环零回归。

**验证检查点**：
- [ ] `core/index.ts` 可通过 `export * as Eag` 编译通过；
- [ ] CLI 层可仅通过 `@vegamo/deepcode-core` 导入 EAG orchestrator；
- [ ] `npm run typecheck` 全量通过。

### 3.3 quality-gates 评分与报告细节

**现状**：
- `packages/core/src/team/principles/quality-gates.ts:296-301` 的 `requiredAllPassed` 未按 `config.required` 过滤；
- `packages/core/src/team/principles/quality-gates.ts:304-310` 的 `overallScore` 硬编码 `totalWeight += 1.0`，未读取 `config.weight`。

**修复步骤**：
1. 修改 `createQualityReport` 签名，增加可选 `configs?: QualityGateConfig[]` 参数。
2. 构建 `gateId → config` 映射，用于查询 `weight` 与 `required`。
3. 加权平均分计算：
   ```ts
   const weight = configMap.get(r.gateId)?.weight ?? 1.0;
   totalWeight += weight;
   weightedScore += r.score * weight;
   ```
4. `requiredAllPassed` 仅过滤 `cfg?.required === true && r.status !== SKIPPED` 的门禁。
5. 更新 `QualityGateManager.runAll()` 调用 `createQualityReport` 时传入 `this.configs`；未传 configs 时按旧行为兜底。

**验证检查点**：
- [ ] `UIUX_VISUAL`（`required: false`）失败时 `overallPassed` 仍为 true；
- [ ] 调整 `weight` 后 `overallScore` 按权重变化；
- [ ] 未传 `configs` 时行为与旧版一致；
- [ ] 现有 `quality-gates.test.ts` 更新并通过。

### 3.4 quality-gates 真实 executor 测试覆盖

**现状**：
- `packages/core/src/team/principles/quality-gate-executors.ts` 已实现 7 个真实 executor；
- 缺少针对单个 executor 的 pass/fail 路径单元测试。

**修复步骤**：
1. 在 `tests/team/principles/quality-gate-executors.test.ts` 新增测试文件。
2. 每个 executor 至少覆盖：
   - 通过路径（干净源码，score 接近 1.0）；
   - 失败路径（触发典型 findings，score 下降）；
   - 边界条件（配置开关、测试文件跳过等）。
3. 测试使用临时目录写入受控源码，直接调用 `executor.execute(projectPath, config)`，不依赖真实 LLM、不依赖生产数据库、不 mock 源码扫描行为。

**验证检查点**：
- [ ] 7 个 executor 均有独立 pass/fail 用例；
- [ ] 新增测试全部通过；
- [ ] 测试不引入真实网络或数据库依赖。

### 3.5 P2 架构健康度改进

| 风险 | 处理方案 |
|------|----------|
| `DEFAULT_QUALITY_GATE_MANAGER` 全局副作用 | 改为懒加载工厂 `createDefaultQualityGateManager()` |
| CLI 层 EAG orchestrator 注入点缺失 | 在 `App.tsx` 统一构造并可选注入 |
| `cybernetics` 与 `team/principles` 潜在循环依赖 | 共享类型下沉到独立 `types.ts` |
| `DualLayerContextManager` 缺少工厂函数 | 新增 `createDualLayerContextHook` |
| `session.ts` 硬编码阈值 | 迁移到 `settings.json` schema 或集中常量，补充中文注释 |

### 3.6 安全修复（P0-P1）

#### 3.6.1 VS Code Webview XSS

**位置**：`packages/vscode-ide-companion/resources/webview.html:669/694`

**问题**：`contentDiv.innerHTML = content` 直接将 assistant 的 HTML/原始内容插入 DOM，若 `content` 含 `<script>`、事件处理器或恶意标签，将在 webview 中执行。

**修复步骤**：
1. 新增 `escapeHtml(text)` 函数，将 `& < > " '` 转义为 HTML 实体。
2. 普通 assistant 消息（非 `html` 模式）使用 `escapeHtml(content)` 后再 `innerHTML`；或改用 `textContent`。
3. 若确实需要渲染后端生成的 Markdown HTML，必须在 webview 侧引入可信 sanitization（DOMPurify）并配置严格 CSP；当前阶段先关闭 `innerHTML` 直接赋值，统一转义为纯文本。
4. 新增/更新 webview 相关测试，验证脚本标签被转义、事件处理器不执行。

**验证检查点**：
- [ ] `innerHTML` 不再直接赋未转义的 assistant 内容；
- [ ] 测试注入 `<script>alert(1)</script>` 不触发；
- [ ] 正常 Markdown 文本仍正确显示。

#### 3.6.2 `scripts/build.js` shell 注入面

**位置**：`scripts/build.js:10`

**修复**：移除 `shell: true`，直接 `spawnSync("npm", args, { stdio: "inherit", cwd: root })`。

#### 3.6.3 DangerousCommandGuard 黑名单绕过

**位置**：`packages/core/src/eag/p5/guards/dangerous-command-guard.ts`

**修复**：
1. 在现有黑名单基础上增加命令 token 化预检，拒绝 `eval`、反引号、`$()`、Base64 管道等构造。
2. 默认启用 fail-closed 模式：未命中白名单的 shell 元字符/构造直接拦截。
3. 补充绕过用例单元测试。

### 3.7 测试与性能改进（P2）

| 问题 | 处理方案 |
|------|----------|
| 长耗时 E2E 混入默认 `npm test` | 将 `eag-e2e-*.test.ts` 移入 `test:e2e` 脚本，默认套件保留 ≤30s 用例 |
| Dynamic Workflows 6 模式缺少 E2E | 新增 `team/tests/dynamic-workflows-*.test.ts` 覆盖 fan-out-aggregate / adversarial-verify / loop-until-done |
| 11 状态机缺少完整转换表测试 | 新增 `tests/task-state-machine.test.ts` |
| web-artisan / code-mode-orchestrator 测试缺失 | 新增对应 skill 功能测试 |
| Quality Gate 执行器测试覆盖不足 | 见 3.4 |

---

## 4. 实施顺序

1. **VS Code Webview XSS 修复**（Critical，P0）
2. **V2 Context 接入**（P0）
3. **EAG 公共 API 导出 + CLI 注入**（P0）
4. **quality-gates 评分修复**（P1）
5. **quality-gates executor 测试覆盖**（P1）
6. **DangerousCommandGuard 加固**（P1）
7. **P2 架构健康度改进**（build.js、`session.ts` 阈值等）
8. **测试与性能改进**（E2E 拆分、状态机/模式/技能测试）
9. **全量 typecheck + 目标测试验证**
10. **对照 new-features.md 文档代码一致性审查**

---

## 5. 验收标准

- [ ] `npm run typecheck` 在 `packages/core` 与 `packages/cli` 均通过；
- [ ] `npm test` 相关测试全部通过（quality-gates 新增测试 + 既有测试）；
- [ ] VS Code Webview 中 assistant 内容不再通过未转义的 `innerHTML` 插入；
- [ ] `DangerousCommandGuard` 对 `eval`、反引号、`$()`、Base64 管道等构造默认拦截；
- [ ] `docs/new-features.md` 中 A-J 能力域与代码实现一致；
- [ ] 代码中无残留未实现 TODO/FIXME；
- [ ] 修复不引入新的循环依赖或类型错误；
- [ ] 新增/修改代码含中文注释，关键逻辑注释符合 TypeScript 规范。

---

## 6. 回退策略

- 每个修复步骤独立提交（或至少可独立回滚）；
- V2 Context 与 EAG 注入均通过可选注入实现，未启用时主循环行为不变；
- quality-gates 评分修复保持未传 `configs` 时的旧行为兜底；
- 若 typecheck 或测试失败，优先回滚最近一步修改并重新审查。
