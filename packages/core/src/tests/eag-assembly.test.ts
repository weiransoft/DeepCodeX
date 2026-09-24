/**
 * EAG 编排器统一装配 + 建议自动执行白名单单元测试（T1 装配下沉，2026-09-24）
 *
 * 设计依据：docs/dev/eag-web-sedimentation-fixes.md §2.1 / §3（测试用例 EA-01 / EA-02）
 *
 * 测试范围：
 * - EA-01（eag/assembly.ts）：三个 build* 工厂在真实注入下返回真实例；
 *   内部组件构造抛错 → 返回 undefined + error 日志（fail-closed 语义回归）；
 *   ProductionLoopHandoffAdapter（原 CLI 版 CliLoopHandoffAdapter）executor 的
 *   fail-closed 路径（loop 节点未配置 plugin → 诚实返回 success=false）。
 * - EA-02（eag/suggestion-auto.ts）：extractAutoExecutableEagCommandName 命中
 *   eag-autonomous / 拒绝 eag-graph、eag-design、非白名单与非 "/" 前缀输入；
 *   extractSuggestedCommandText 引号参数提取 + 否定保护（"不建议执行"不提取）。
 *
 * 测试约定：
 * - 使用 node:test + node:assert/strict，经 core 根 barrel（../index.js）导入，
 *   同时锁定根 index re-export 链路完整（装配符号 + 白名单符号均可从包入口解析）；
 * - 禁止 mock：直接调用真实装配函数，LLM 客户端工厂传真实函数
 *   （装配阶段不发起 LLM 调用，工厂仅在命令执行时被惰性调用）；
 * - CLI 既有等价测试（packages/cli/src/tests/eag-design-assembly.test.ts A1-A4、
 *   suggestion-fallback.test.ts 全量）经薄壳 re-export 保持全绿，本文件不重复堆用例，
 *   仅补充 core 侧独有的 EA-01 autonomous/graph 工厂断言与 EA-02 设计文档要点断言。
 *
 * @module tests/eag-assembly
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAutonomousOrchestrator,
  buildGraphLoopOrchestratorOptions,
  buildDesignOrchestrator,
  ProductionLoopHandoffAdapter,
  GoalDispatcher,
  PluginRegistry,
  AutonomousOrchestrator,
  DesignLoopOrchestrator,
  AUTO_EXECUTABLE_EAG_COMMANDS,
  extractAutoExecutableEagCommandName,
  extractSuggestedCommandText,
  extractSuggestedCommandAndGoal,
  buildAutoExecuteCommand,
  shouldDemoteToolCallFragment,
} from "../index.js";
import type { AssemblyLogCallback, GraphLogger } from "../index.js";

// ============================================================================
// EA-01：三工厂成功路径（真实注入 → 真实例）
// ============================================================================

test("EA-01a. buildAutonomousOrchestrator 真实装配并返回 AutonomousOrchestrator 实例", () => {
  // level 为可选参数（AssemblyLogCallback 签名），日志记录类型需兼容 undefined
  const logs: Array<{ message: string; level: string | undefined }> = [];
  const log: AssemblyLogCallback = (message, level) => logs.push({ message, level });

  const orchestrator = buildAutonomousOrchestrator(log);

  // 实例断言：装配产物为 AutonomousOrchestrator（真实类，非空壳对象）
  assert.ok(orchestrator, "装配应返回实例");
  assert.ok(orchestrator instanceof AutonomousOrchestrator, "应为 AutonomousOrchestrator 实例");
  assert.equal(typeof orchestrator.run, "function", "应暴露 run() 方法");

  // 日志断言：成功装配记录 info 级"装配完成"日志（与 CLI 版文案逐字节一致）
  const completed = logs.find((l) => l.message.includes("AutonomousOrchestrator 装配完成"));
  assert.ok(completed, "应记录装配完成日志");
  assert.equal(completed?.level, "info");
});

test("EA-01b. buildAutonomousOrchestrator 默认日志回调（无 log 参数）不抛错", () => {
  // 默认空操作日志回调路径冒烟（覆盖 log 缺省值分支）
  const orchestrator = buildAutonomousOrchestrator();
  assert.ok(orchestrator instanceof AutonomousOrchestrator);
});

test("EA-01c. buildGraphLoopOrchestratorOptions 真实装配并返回完整编排选项", () => {
  const logs: Array<{ message: string; level: string | undefined }> = [];
  const log: AssemblyLogCallback = (message, level) => logs.push({ message, level });

  const options = buildGraphLoopOrchestratorOptions(process.cwd(), log);

  // 结构断言：GraphLoopOrchestratorOptions 必需组件全部真实构造（非 undefined）
  assert.ok(options, "装配应返回选项对象");
  assert.ok(options.nodeExecutor, "nodeExecutor 应真实构造");
  assert.ok(options.edgeResolver, "edgeResolver 应真实构造");
  assert.ok(options.graphScheduler, "graphScheduler 应真实构造");
  assert.ok(options.graphGuard, "graphGuard 应真实构造");
  assert.ok(options.predicateRegistry, "predicateRegistry 应真实构造");
  assert.equal(options.projectRoot, process.cwd(), "projectRoot 应透传（evaluator 执行测试命令的工作目录）");
  assert.ok(options.logger && typeof options.logger.info === "function", "logger 应实现 GraphLogger 接口");

  // 日志断言：成功装配记录 info 级"装配完成"日志（与 CLI 版文案逐字节一致）
  const completed = logs.find((l) => l.message.includes("GraphLoopOrchestratorOptions 装配完成"));
  assert.ok(completed, "应记录装配完成日志");
  assert.equal(completed?.level, "info");
});

test("EA-01d. buildDesignOrchestrator 真实装配三角色并返回 DesignLoopOrchestrator 实例", () => {
  const logs: Array<{ message: string; level: string | undefined }> = [];
  const log: AssemblyLogCallback = (message, level) => logs.push({ message, level });

  // createLLMClient 返回 null 不影响装配（角色运行时才失败，装配阶段惰性持有工厂）
  const orchestrator = buildDesignOrchestrator(() => null, log);

  assert.ok(orchestrator, "装配应返回实例");
  assert.ok(orchestrator instanceof DesignLoopOrchestrator, "应为 DesignLoopOrchestrator 实例");
  assert.equal(typeof orchestrator.run, "function", "应暴露 run() 方法");

  const completed = logs.find((l) => l.message.includes("DesignLoopOrchestrator 装配完成"));
  assert.ok(completed, "应记录装配完成日志");
  assert.equal(completed?.level, "info");
});

// ============================================================================
// EA-01：fail-closed 路径（必抛注入桩 → undefined + error 日志）
// ============================================================================

test("EA-01e. buildDesignOrchestrator 组件构造异常时返回 undefined 并记录 error 日志（fail-closed）", () => {
  const logs: Array<{ message: string; level: string | undefined }> = [];
  const log: AssemblyLogCallback = (message, level) => logs.push({ message, level });

  // 必抛注入桩：非函数 createLLMClient → LlmProductManager 构造函数抛错 → 装配层捕获
  const throwingFactory = undefined as unknown as () => null;
  const orchestrator = buildDesignOrchestrator(throwingFactory, log);

  assert.equal(orchestrator, undefined, "构造失败应返回 undefined（命令降级为不可用）");
  const failed = logs.find((l) => l.message.includes("DesignLoopOrchestrator 装配失败"));
  assert.ok(failed, "应记录装配失败日志");
  assert.equal(failed?.level, "error");
  assert.ok(failed?.message.includes("createLLMClient"), "失败日志应含具体原因");
});

test("EA-01f. buildDesignOrchestrator 装配期不调用 LLM 工厂（惰性调用语义，宿主不崩溃）", () => {
  // 抛出型工厂：装配期不应调用；调用即抛——装配函数本身仍返回实例证明未触碰工厂
  const throwingFactory = (): null => {
    throw new Error("装配期不应调用 LLM 工厂");
  };
  const orchestrator = buildDesignOrchestrator(throwingFactory);
  assert.ok(orchestrator instanceof DesignLoopOrchestrator, "装配期不调用工厂（惰性调用语义）");
});

test("EA-01g. ProductionLoopHandoffAdapter 未配置 plugin 的 loop 节点诚实返回失败（fail-closed）", async () => {
  // 静默 GraphLogger 桩（测试观测点为返回值而非日志）
  const silentLogger: GraphLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  const adapter = new ProductionLoopHandoffAdapter({
    // 真实 GoalDispatcher（空注册表；fail-closed 路径不触发派发）
    goalDispatcher: new GoalDispatcher(new PluginRegistry()),
    projectRoot: process.cwd(),
    logger: silentLogger,
  });

  // 构造最小 loop 节点定义（不配置 plugin 字段）
  const executor = adapter.createLoopExecutor(
    { nodeId: "loop-no-plugin", type: "loop", task: "无 plugin 的循环任务" } as never,
    {},
    { runId: "test-run" } as never
  );
  const result = await executor(0, {}, { runId: "test-run" } as never, undefined);

  // fail-closed 断言：绝不假装成功
  assert.equal(result.success, false, "未配置 plugin 必须返回 success=false");
  assert.ok(typeof result.error === "string" && result.error.includes("fail-closed"), "失败原因应说明 fail-closed");
});

// ============================================================================
// EA-02：EAG 白名单迁移回归（提取 + 校验 + 否定保护）
// ============================================================================

test("EA-02a. AUTO_EXECUTABLE_EAG_COMMANDS 仅含 eag-autonomous（保守收录回归）", () => {
  // 白名单内容逐字节不变：仅 eag-autonomous（建议器 suggest_autonomous 的标准产出）
  assert.ok(AUTO_EXECUTABLE_EAG_COMMANDS.has("eag-autonomous"));
  for (const name of ["eag-autonomous-stop", "eag-autonomous-status", "eag-graph", "eag-design", "eag-build"]) {
    assert.ok(!AUTO_EXECUTABLE_EAG_COMMANDS.has(name), `${name} 不得在 EAG 自动执行白名单中`);
  }
});

test("EA-02b. extractAutoExecutableEagCommandName 命中 eag-autonomous（含参数）", () => {
  // 白名单内 EAG 命令 + 完整参数：返回命令名
  assert.equal(
    extractAutoExecutableEagCommandName("/eag-autonomous --goal '同步数据库' --max-iterations 10"),
    "eag-autonomous"
  );
});

test("EA-02c. extractAutoExecutableEagCommandName 拒绝 eag-graph / eag-design / 非白名单 / 畸形输入", () => {
  // 需复杂参数类 EAG 命令：严禁自动执行
  assert.equal(extractAutoExecutableEagCommandName("/eag-graph --graph-file x.json"), null);
  assert.equal(extractAutoExecutableEagCommandName("/eag-design --spec y.yaml"), null);
  // 熔断 / 查询类：严禁自动执行
  assert.equal(extractAutoExecutableEagCommandName("/eag-autonomous-stop"), null);
  assert.equal(extractAutoExecutableEagCommandName("/eag-autonomous-status"), null);
  // 非 EAG 命令（内置 slash 体系）、非 "/" 前缀、空串、纯 "/"：均拒绝
  assert.equal(extractAutoExecutableEagCommandName("/review"), null);
  assert.equal(extractAutoExecutableEagCommandName("eag-autonomous"), null);
  assert.equal(extractAutoExecutableEagCommandName(""), null);
  assert.equal(extractAutoExecutableEagCommandName("/"), null);
});

test("EA-02d. extractSuggestedCommandText 提取单引号中文参数（F9-v2 回归）", () => {
  // 单引号包裹的中文参数（含空格）完整捕获，不截断
  assert.equal(
    extractSuggestedCommandText("建议启动 /eag-autonomous --goal '从本机 46 导出数据库到 43'"),
    "/eag-autonomous --goal '从本机 46 导出数据库到 43'"
  );
  // 引号参数后可继续跟 ASCII token 参数
  assert.equal(
    extractSuggestedCommandText("建议启动 /eag-autonomous --goal '同步数据库' --max-iterations 10"),
    "/eag-autonomous --goal '同步数据库' --max-iterations 10"
  );
});

test("EA-02e. extractSuggestedCommandText 否定保护（「不建议执行」不提取）", () => {
  // 否定标记（不建议）紧邻匹配前文 → 视为转述约束文本，跳过（对齐 CLI 既有
  // 「我不会再说"建议执行 /review"了」用例的 12 字符否定窗口语义）
  assert.equal(extractSuggestedCommandText('我不会再说"建议执行 /review"了'), null);
  // 前一次否定语境、后一次真实建议 → 命中最后一次非否定匹配
  assert.equal(extractSuggestedCommandText("不建议执行 /quality-check。根据任务需要，建议执行 /review"), "/review");
  // 常规句式提取回归（下沉后行为逐字节不变）
  assert.equal(extractSuggestedCommandText("根据分析，建议执行 /review 来完成代码审查"), "/review");
  assert.equal(extractSuggestedCommandText("代码审查已完成，共发现 3 个问题。"), null);
});

// EA-02f. extractSuggestedCommandAndGoal 抽取中文散文 goal（EA-03b 根因修复）
test("EA-02f. extractSuggestedCommandAndGoal 从建议句式抽取命令 + 中文散文 goal", () => {
  // 裸命令 + 中文散文 goal（句号终结）——EA-03b 根因场景
  const cap1 = extractSuggestedCommandAndGoal("分析完成，建议启动 /eag-autonomous 修复登录失败问题。");
  assert.ok(cap1, "应捕获有效建议句式");
  assert.equal(cap1.commandWithSlash, "/eag-autonomous");
  assert.equal(cap1.commandName, "eag-autonomous");
  assert.equal(cap1.goalText, "修复登录失败问题");

  // 多句散文到句号截断
  const cap2 = extractSuggestedCommandAndGoal("建议启动 /eag-autonomous 再来一次修复登录失败问题。");
  assert.equal(cap2?.goalText, "再来一次修复登录失败问题");

  // 句号结尾无散文 → goalText 空
  const cap3 = extractSuggestedCommandAndGoal("建议启动 /eag-autonomous。");
  assert.equal(cap3?.goalText, "");

  // 已带 --goal 参数 → goalText 归零（冲突防护）
  const cap4 = extractSuggestedCommandAndGoal('建议启动 /eag-autonomous --goal "修复登录" --max-iterations 10');
  assert.equal(cap4?.goalText, "");

  // 否定保护（"不建议"）——整条跳过，返回 null
  const capNeg = extractSuggestedCommandAndGoal("不建议启动 /eag-autonomous 来修复问题");
  assert.equal(capNeg, null);

  // 无有效句式 → null
  const capNone = extractSuggestedCommandAndGoal("代码审查已完成");
  assert.equal(capNone, null);
});

// EA-02g. buildAutoExecuteCommand 构造完整命令字符串（带 --goal/--max-iterations）
test("EA-02g. buildAutoExecuteCommand 从裸命令 + goal 散文构造完整可执行命令", () => {
  // /eag-autonomous：完整参数链
  const full = buildAutoExecuteCommand("/eag-autonomous", "修复登录失败问题");
  assert.equal(
    full,
    '/eag-autonomous --goal "修复登录失败问题" --max-iterations 10 --confirmation smart',
    "autonomous 命令应带 goal + iterations + confirmation"
  );

  // /eag-design：--requirement + --paradigm
  assert.equal(
    buildAutoExecuteCommand("/eag-design", "用户认证模块重构"),
    '/eag-design --requirement "用户认证模块重构" --paradigm ddd-layered'
  );

  // /eag-build / /eag-test / /eag-run / /eag-deploy：--goal 通用
  for (const cmd of ["/eag-build", "/eag-test", "/eag-run", "/eag-deploy"]) {
    assert.equal(buildAutoExecuteCommand(cmd, "加退款功能"), `${cmd} --goal "加退款功能"`);
  }

  // goal 空 → 裸命令
  assert.equal(buildAutoExecuteCommand("/eag-autonomous", ""), "/eag-autonomous");

  // goal 含双引号 → 安全转义
  assert.equal(
    buildAutoExecuteCommand("/eag-autonomous", '修复 "登录" 模块'),
    '/eag-autonomous --goal "修复 \\"登录\\" 模块" --max-iterations 10 --confirmation smart'
  );

  // /eag-graph 等未知命令 → 裸透传
  assert.equal(buildAutoExecuteCommand("/eag-graph", "任何"), "/eag-graph");
});

// EA-02h. 整合端到端：extractSuggestedCommandAndGoal + buildAutoExecuteCommand
// 模拟 Web 宿主 session-pool scheduleAutoExecuteSuggestion 的完整链路
test("EA-02h. extractSuggestedCommandAndGoal + buildAutoExecuteCommand 端到端构造完整命令（EA-03b 修复闭环）", () => {
  const assistantReply = "分析完成，建议启动 /eag-autonomous 修复登录失败问题。";
  const capture = extractSuggestedCommandAndGoal(assistantReply);
  assert.ok(capture);
  const fullCommand = buildAutoExecuteCommand(capture!.commandWithSlash, capture!.goalText);
  // handleEagAutonomousCommand 可直接解析此完整命令
  assert.equal(fullCommand, '/eag-autonomous --goal "修复登录失败问题" --max-iterations 10 --confirmation smart');
  // 必含 --goal（EA-03b 之前就是缺这个导致 parse 失败 → executor 零请求）
  assert.ok(fullCommand.includes("--goal"), "完整命令必须带 --goal 参数，否则 handleEagAutonomousCommand 解析失败");
});

// ============================================================================
// EA-02i~l. shouldDemoteToolCallFragment（脏碎片治理纯函数判据，2026-09-24）
// ============================================================================

// 工具轮回合的最小合法 tool_calls 结构（对齐 normalizeLlmToolCalls 输出）
const MIN_TOOL_CALL = [{ index: 0, id: "call-1", type: "function", function: { name: "bash", arguments: "{}" } }];

test("EA-02i. shouldDemoteToolCallFragment 核心命中：工具轮 + reasoning 空 + content 短 < 80 → true（用户脏碎片场景复现）", () => {
  // 用户原始场景：qwen3.8 在工具循环中间轮次把 "数据库连接池异常" 6 字误输出在正文通道
  assert.equal(
    shouldDemoteToolCallFragment({
      normalizedToolCalls: MIN_TOOL_CALL,
      reasoningContent: "",
      content: "数据库连接池异常",
    }),
    true,
    "6 字碎片 + 工具轮 + 无 reasoning → 应降级"
  );

  // 边界：content 在 0 < len < 80 内的任何短文本都应触发（只要满足另外两条件）
  assert.equal(
    shouldDemoteToolCallFragment({ normalizedToolCalls: MIN_TOOL_CALL, reasoningContent: "", content: "好的稍等" }),
    true,
    "4 字 + 工具轮 + 无 reasoning → 应降级"
  );
  assert.equal(
    shouldDemoteToolCallFragment({
      normalizedToolCalls: MIN_TOOL_CALL,
      reasoningContent: "",
      content: " ".repeat(79) + "x",
    }),
    true,
    "79 字符（trim 后 1 字 x）+ 工具轮 → 应降级（trim 后 < 80）"
  );
});

test("EA-02j. shouldDemoteToolCallFragment 合法长前导不误伤：content ≥ 80 + 工具轮 + reasoning 空 → false", () => {
  // 用 JS repeat 拼出稳定 ≥ 80 字符的长前导（避免中文长度误判）
  const longPreamble = "好的，让我先检查一下项目结构和相关配置，然后给你一份完整的排查方案。".repeat(3);
  assert.ok(longPreamble.length >= 80, `测试前置条件：前导文本 ≥ 80 字符（实际 ${longPreamble.length}）`);

  assert.equal(
    shouldDemoteToolCallFragment({
      normalizedToolCalls: MIN_TOOL_CALL,
      reasoningContent: "",
      content: longPreamble,
    }),
    false,
    "合法长前导叙述（≥ 80 字）不应降级"
  );

  // 边界：trim 后刚好 80 字符 → 不降级（≥ maxLen 触发 return false）
  const exact80 = "a".repeat(80);
  assert.equal(
    shouldDemoteToolCallFragment({ normalizedToolCalls: MIN_TOOL_CALL, reasoningContent: "", content: exact80 }),
    false,
    "trim 后刚好 80 字符 → 边界值不降级"
  );
});

test("EA-02k. shouldDemoteToolCallFragment reasoning 非空不误伤：工具轮 + reasoning 非空 + content 短 → false（正常 thinking 模式）", () => {
  // 模型正常产出 reasoning_content + 短 content 前导 → 降级不触发
  assert.equal(
    shouldDemoteToolCallFragment({
      normalizedToolCalls: MIN_TOOL_CALL,
      reasoningContent: "让我想想这个问题的解决路径...先看认证流程...",
      content: "好的",
    }),
    false,
    "reasoning 通道正常产出 → 降级不触发（即使 content 短）"
  );
});

test("EA-02l. shouldDemoteToolCallFragment content-only 回合不误伤：无工具调用 + 短 content → false（合法短回复）", () => {
  // Advisor 批评的误伤场景：合法短回复 "好的"/"已完成"/"明白了" 与脏碎片
  // 无法通过长度区分 → 没有工具调用的回合一律不降级
  assert.equal(
    shouldDemoteToolCallFragment({ normalizedToolCalls: undefined, reasoningContent: "", content: "好的" }),
    false,
    "content-only 回合（无 tool_calls）→ 不降级（合法短回复不误伤）"
  );
  assert.equal(
    shouldDemoteToolCallFragment({ normalizedToolCalls: null, reasoningContent: "", content: "已完成" }),
    false,
    "normalizedToolCalls 为 null → 不降级"
  );
  assert.equal(
    shouldDemoteToolCallFragment({ normalizedToolCalls: [], reasoningContent: "", content: "明白了" }),
    false,
    "normalizedToolCalls 为空数组 → 不降级"
  );
  // content 空串 / 全空白 → 不降级
  assert.equal(
    shouldDemoteToolCallFragment({ normalizedToolCalls: MIN_TOOL_CALL, reasoningContent: "", content: "" }),
    false,
    "content 空串 → 不降级"
  );
  assert.equal(
    shouldDemoteToolCallFragment({ normalizedToolCalls: MIN_TOOL_CALL, reasoningContent: "", content: "   \n\t" }),
    false,
    "content 全空白 → 不降级（trim 后 length === 0）"
  );
});
