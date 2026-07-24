/**
 * EAG 动态编排建议层 E2E 测试脚本（从 core 包直接引用源文件）
 *
 * 运行方式：
 *   cd /Users/wangwei/Documents/VG/DeepCodeX-cli/packages/core
 *   npx tsx e2e/e2e-dynamic-suggester.ts
 */

import { resolveCurrentSettings } from "../src/settings";
import { ProviderFactory } from "../src/providers/provider-factory";
import { createEagDynamicSuggester } from "../src/eag/dynamic/eag-dynamic-suggester";
import type { DynamicCommandDescriptor } from "../src/eag/dynamic/eag-dynamic-suggester";

// ============================================================================
// 测试框架
// ============================================================================

const TestResults = {
  passed: 0,
  failed: 0,
  details: [] as string[],
};

function assert(condition: boolean, message: string): void {
  if (condition) {
    TestResults.passed++;
    TestResults.details.push(`  ✅ PASS: ${message}`);
  } else {
    TestResults.failed++;
    TestResults.details.push(`  ❌ FAIL: ${message}`);
  }
}

// ============================================================================
// 构造组件
// ============================================================================

const projectRoot = process.cwd();

// 构造 LLM 客户端
const settings = resolveCurrentSettings(projectRoot);
if (!settings.apiKey) {
  console.error("❌ 未配置 API Key，无法进行 E2E 测试");
  process.exit(1);
}

console.log(`📋 LLM 配置: model=${settings.model}, baseURL=${settings.baseURL}`);

// 构造全部命令描述符（模拟 session.ts listAvailableCommands + CLI dynamicCommandDescriptors）
const eagCommands: DynamicCommandDescriptor[] = [
  {
    category: "eag",
    id: "eag-design",
    name: "/eag-design",
    description: "设计阶段。接受原始需求描述，生成架构/领域模型/任务分解。",
  },
  { category: "eag", id: "eag-build", name: "/eag-build", description: "编码实现阶段。需要已提供 spec/plan/tasks。" },
  { category: "eag", id: "eag-test", name: "/eag-test", description: "测试阶段。需要已提供被测代码或测试计划。" },
  { category: "eag", id: "eag-run", name: "/eag-run", description: "继续执行一次已存在的 run。" },
  { category: "eag", id: "eag-resume", name: "/eag-resume", description: "恢复一个已暂停/中断的 run。" },
  { category: "eag", id: "eag-status", name: "/eag-status", description: "查询当前或指定 run 的状态。" },
  { category: "eag", id: "eag-deploy", name: "/eag-deploy", description: "部署阶段。需要已完成构建产物和部署配置。" },
  {
    category: "eag",
    id: "eag-autonomous",
    name: "/eag-autonomous",
    description: "多阶段自动循环（plan→dev→verify→fix）。适合需求模糊、需要自动设计并实现的功能。",
  },
  {
    category: "eag",
    id: "eag-autonomous-status",
    name: "/eag-autonomous-status",
    description: "查询无人值守 run 的状态。",
  },
  { category: "eag", id: "eag-autonomous-stop", name: "/eag-autonomous-stop", description: "中止或回滚无人值守 run。" },
  {
    category: "eag",
    id: "eag-graph",
    name: "/eag-graph",
    description: "显式图编排入口。需要用户已提供图定义 JSON 文件。",
  },
];

const teamCommands: DynamicCommandDescriptor[] = [
  { category: "team", id: "team-list", name: "/team list", description: "列出所有可用角色。" },
  { category: "team", id: "team-match", name: "/team match", description: "根据关键词匹配最合适的角色。" },
  {
    category: "team",
    id: "team-dispatch",
    name: "/team dispatch",
    description: "分派任务到指定角色。适合单角色任务。",
  },
  {
    category: "team",
    id: "team-autonomous",
    name: "/team autonomous",
    description: "启动 Ralph 自主迭代模式。适合需要自动迭代的多步任务。",
  },
  {
    category: "team",
    id: "team-full-lifecycle",
    name: "/team full-lifecycle",
    description: "8 阶段项目全流程。适合新项目启动。",
  },
];

const rulesCommands: DynamicCommandDescriptor[] = [
  { category: "rules", id: "rules-list", name: "/rules list", description: "列出所有生效规则。" },
  { category: "rules", id: "rules-add", name: "/rules add", description: "添加用户规则或项目规则。" },
  { category: "rules", id: "rules-remove", name: "/rules remove", description: "移除规则。" },
  { category: "rules", id: "rules-show", name: "/rules show", description: "查看规则详情。" },
  { category: "rules", id: "rules-path", name: "/rules path", description: "显示规则文件路径。" },
];

const slashCommands: DynamicCommandDescriptor[] = [
  { category: "slash", id: "skills", name: "/skills", description: "列出技能。" },
  { category: "slash", id: "model", name: "/model", description: "选择模型。" },
  { category: "slash", id: "new", name: "/new", description: "新建会话。" },
  { category: "slash", id: "init", name: "/init", description: "初始化项目配置。" },
  { category: "slash", id: "resume", name: "/resume", description: "恢复会话。" },
  { category: "slash", id: "undo", name: "/undo", description: "撤销上次操作。" },
  { category: "slash", id: "mcp", name: "/mcp", description: "MCP 服务器管理。" },
  { category: "slash", id: "raw", name: "/raw", description: "切换原始输出模式。" },
  { category: "slash", id: "memory", name: "/memory", description: "记忆管理。" },
];

const allCommands = [...eagCommands, ...teamCommands, ...rulesCommands, ...slashCommands];

console.log(`📋 全部可用命令: ${allCommands.length} 个`);
console.log(`   - EAG: ${eagCommands.length}`);
console.log(`   - Team: ${teamCommands.length}`);
console.log(`   - Rules: ${rulesCommands.length}`);
console.log(`   - Slash: ${slashCommands.length}`);
console.log("");

// 构造 EagDynamicSuggester
const eagDynamicSuggester = createEagDynamicSuggester({
  createDecisionLLMClient: () => ProviderFactory.create(settings),
  enabled: true,
  confidenceThreshold: 0.6,
  maxDecisionTokens: 2048,
});

// ============================================================================
// 测试用例
// ============================================================================

interface TestCase {
  name: string;
  goal: string;
  expectedType: "direct_chat" | "suggest_command" | "suggest_autonomous" | "suggest_graph" | "ask_clarification";
  expectedCategory?: string;
  description: string;
}

const testCases: TestCase[] = [
  {
    name: "简单闲聊",
    goal: "你好",
    expectedType: "direct_chat",
    description: "闲聊应直接进入主对话，不触发命令建议",
  },
  {
    name: "单阶段设计任务",
    goal: "帮我设计一个用户登录模块的架构",
    expectedType: "suggest_command",
    expectedCategory: "eag",
    description: "明确单阶段设计任务，应建议 /eag-design",
  },
  {
    name: "多阶段自动任务",
    goal: "帮我实现一个完整的用户认证系统，包括登录、注册、权限管理",
    expectedType: "suggest_autonomous",
    description: "模糊多阶段目标，应建议 /eag-autonomous",
  },
  {
    name: "Team 协作任务",
    goal: "启动一个新项目，需要架构师和开发者协作完成",
    expectedType: "suggest_command",
    description: "需要多角色协同，应建议 /team dispatch 或 /team full-lifecycle",
  },
  {
    name: "Rules 规则查询",
    goal: "查看当前有哪些规则生效",
    expectedType: "suggest_command",
    description: "查询规则，应建议 /rules list",
  },
  {
    name: "Slash 技能查询",
    goal: "有哪些技能可用",
    expectedType: "suggest_command",
    description: "查询技能，应建议 /skills",
  },
];

// ============================================================================
// 执行测试
// ============================================================================

console.log("=".repeat(60));
console.log("🚀 EAG 动态编排建议层 E2E 测试");
console.log("=".repeat(60));

for (const tc of testCases) {
  console.log(`\n🔍 测试: ${tc.name}`);
  console.log(`   输入: "${tc.goal}"`);
  console.log(`   预期: ${tc.expectedType}${tc.expectedCategory ? ` (category=${tc.expectedCategory})` : ""}`);

  try {
    const suggestion = await eagDynamicSuggester.suggest({
      sessionId: `e2e-${Date.now()}`,
      projectRoot,
      goal: tc.goal,
      availableCommands: allCommands,
    });

    console.log(`   实际: ${suggestion.type}`);

    // 验证返回类型
    assert(suggestion.type === tc.expectedType, `${tc.name}: 期望返回 ${tc.expectedType}，实际返回 ${suggestion.type}`);

    // 验证命令类别（如果有期望）
    if (tc.expectedCategory && suggestion.type === "suggest_command") {
      assert(
        suggestion.commandCategory === tc.expectedCategory,
        `${tc.name}: 期望 commandCategory=${tc.expectedCategory}，实际 ${suggestion.commandCategory}`
      );
    }

    // 输出详细信息
    if (suggestion.type === "suggest_command") {
      console.log(`   命令: ${suggestion.commandCategory}/${suggestion.commandId}`);
      console.log(`   Hint: ${suggestion.commandHint}`);
      console.log(`   消息: ${suggestion.messageToUser}`);
    } else if (suggestion.type === "suggest_autonomous") {
      console.log(`   Hint: ${suggestion.commandHint}`);
      console.log(`   消息: ${suggestion.messageToUser}`);
    } else if (suggestion.type === "suggest_graph") {
      console.log(`   Hint: ${suggestion.commandHint}`);
      console.log(`   消息: ${suggestion.messageToUser}`);
    } else if (suggestion.type === "ask_clarification") {
      console.log(`   问题: ${suggestion.question}`);
      console.log(`   选项: ${suggestion.options.map((o) => o.label).join(", ")}`);
    } else if (suggestion.type === "direct_chat") {
      console.log(`   推理: ${suggestion.reasoning}`);
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.log(`   ❌ 异常: ${errMsg}`);
    TestResults.failed++;
    TestResults.details.push(`  ❌ FAIL: ${tc.name} - 异常: ${errMsg}`);
  }
}

// ============================================================================
// 输出结果
// ============================================================================

console.log("\n" + "=".repeat(60));
console.log("📊 E2E 测试结果");
console.log("=".repeat(60));
for (const detail of TestResults.details) {
  console.log(detail);
}
console.log("");
console.log(`✅ 通过: ${TestResults.passed}`);
console.log(`❌ 失败: ${TestResults.failed}`);
console.log("");

if (TestResults.failed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
