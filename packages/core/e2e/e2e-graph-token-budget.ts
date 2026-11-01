/**
 * E2E：`/eag-graph` 命令链路（token 预算软化 + 隔离终态）
 *
 * 覆盖 2026-11-01 两项引擎修复的**端到端**行为（非单元测试）：
 *   1. `--max-tokens` 耗尽后图必须继续跑完（旧行为是中途 stop_failure，
 *      用户看到的现象是"任务跑到一半就不执行了"）；
 *   2. 节点被自动隔离后，整图终态必须是 failed，不得报 completed
 *      （旧行为把 isolated 当成功，等于"有活儿没干却报绿"）。
 *
 * 走的是真实链路：
 *   命令行字符串 → extractEagGraphRequestFromPrompt（参数解析）
 *   → EagGraphCommandHandler.execute（图 JSON 解析 / 配置三层合并）
 *   → GraphLifecycleManager（生命周期）
 *   → GraphLoopOrchestrator + GraphSchedulerImpl + GraphGuardImpl + EdgeResolverImpl
 *   → GraphRunReport + Markdown 报告
 *
 * 唯一注入的是 NodeExecutorProtocol（真实场景由 LLM 驱动节点执行，
 * 本脚本用确定性执行器替代，并在执行时真实累加 context.totalTokensUsed，
 * 与生产 executors 的做法一致）。
 *
 * 运行：
 *   node --import tsx packages/core/e2e/e2e-graph-token-budget.ts
 *
 * 退出码：0 = 全部通过；1 = 有用例失败
 */
import { EagGraphCommandHandler, extractEagGraphRequestFromPrompt } from "../src/eag/cli/eag-graph-command";
import { GraphLoopOrchestrator } from "../src/eag/graph/graph-loop-orchestrator";
import { EdgeResolverImpl } from "../src/eag/graph/graph-edge-resolver";
import { GraphGuardImpl } from "../src/eag/graph/graph-guard";
import { GraphSchedulerImpl } from "../src/eag/graph/graph-scheduler";
import { PredicateRegistryImpl } from "../src/eag/graph/predicate-registry";
import { createRetrySuppressionConfig } from "../src/eag/graph/graph-loop-models";
import type { GraphLogger, GraphNodeDef, GraphNodeResult, GraphRunContext } from "../src/eag/graph/graph-loop-models";
import type { NodeExecutorProtocol } from "../src/eag/graph/graph-loop-protocols";

// ============================================================================
// 辅助
// ============================================================================

const logger: GraphLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

let pass = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass += 1;
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** 构造图 JSON（A → end 两节点，可指定 config） */
function graphJson(config: Record<string, unknown>): string {
  return JSON.stringify({
    graphId: "g-e2e-budget",
    name: "预算与隔离验证图",
    description: "E2E：验证 token 预算不终止与隔离终态",
    entryNodeId: "A",
    nodes: [
      {
        nodeId: "A",
        nodeType: "task",
        label: "A",
        task: "执行任务 A",
        inputContract: [],
        outputContract: [],
        // task 节点的 plugin 为必填（图结构校验会拦），这里用内置 echo
        plugin: "echo",
      },
      { nodeId: "end", nodeType: "end", label: "end", task: "结束", inputContract: [], outputContract: [] },
    ],
    edges: [{ edgeId: "e1", from: "A", to: "end", dataMapping: {} }],
    config,
  });
}

/**
 * 构造执行器：A 恒成功或恒失败；每次执行真实累加 token 消耗
 *
 * @param opts.aFails A 节点是否恒失败
 * @param opts.tokensPerNode 每次节点执行消耗的 token
 */
function createExecutor(opts: { aFails?: boolean; tokensPerNode?: number } = {}): NodeExecutorProtocol {
  const { aFails = false, tokensPerNode = 5000 } = opts;
  // 每节点尝试次数：真实 executor 由编排器递增 retryCount，这里同样逐个上报，
  // 否则调度器会认为永远"还没重试够"而无法进入隔离分支
  const attempts = new Map<string, number>();
  return {
    async execute(
      node: Readonly<GraphNodeDef>,
      _input: Readonly<Record<string, unknown>>,
      context: Readonly<GraphRunContext>
    ): Promise<GraphNodeResult> {
      // 与生产 executors 一致：执行完把 token 消耗累加到图上下文
      (context as { totalTokensUsed: number }).totalTokensUsed += tokensPerNode;

      const attempt = attempts.get(node.nodeId) ?? 0;
      attempts.set(node.nodeId, attempt + 1);

      if (node.nodeType === "end") {
        return {
          nodeId: node.nodeId,
          nodeType: node.nodeType,
          status: "completed",
          output: {},
          durationSec: 0.01,
          retryCount: attempt,
        };
      }
      if (aFails) {
        return {
          nodeId: node.nodeId,
          nodeType: node.nodeType,
          status: "failed",
          output: {},
          durationSec: 0.01,
          failureReason: `E2E：${node.nodeId} 模拟持续失败`,
          retryCount: attempt,
        };
      }
      return {
        nodeId: node.nodeId,
        nodeType: node.nodeType,
        status: "completed",
        output: {},
        durationSec: 0.01,
        retryCount: attempt,
      };
    },
  };
}

/** 构造真实 handler（依赖全部为真实实现，仅 nodeExecutor 注入） */
function createHandler(executor: NodeExecutorProtocol): EagGraphCommandHandler {
  const orchestratorOptions = {
    nodeExecutor: executor,
    edgeResolver: new EdgeResolverImpl(logger),
    graphScheduler: new GraphSchedulerImpl(createRetrySuppressionConfig(100, 100, 10), logger),
    graphGuard: new GraphGuardImpl(logger),
    predicateRegistry: new PredicateRegistryImpl(),
    logger,
  };
  // 顺带验证编排器本身可独立构造（不依赖 handler 内部魔改）
  void new GraphLoopOrchestrator(orchestratorOptions);
  return new EagGraphCommandHandler(orchestratorOptions);
}

const PROJECT_ROOT = process.cwd();

// ============================================================================
// 场景 1：token 预算耗尽但未开硬停 → 图必须跑完
// ============================================================================

console.log("\n【场景 1】/eag-graph --max-tokens 100：预算耗尽后必须继续跑完");
{
  const cmd = `/eag-graph --inline-graph '${graphJson({ maxTokens: 100, maxParallelism: 1 })}' --max-tokens 100`;
  const request = extractEagGraphRequestFromPrompt(cmd);
  check("命令行参数解析：--max-tokens 生效", request.maxTokens === 100, `maxTokens=${request.maxTokens}`);
  check("命令行参数解析：inline-graph 已解析", typeof request.inlineGraph === "string");

  const handler = createHandler(createExecutor({ tokensPerNode: 5000 }));
  const result = await handler.execute(request, PROJECT_ROOT);

  const report = result.runReport;
  check("图执行产出运行报告", report !== undefined, result.errorMessage);
  if (report) {
    check(
      "预算已被真实突破（消耗 > 预算）",
      report.totalTokensUsed > 100,
      `totalTokensUsed=${report.totalTokensUsed} > maxTokens=100`
    );
    check(
      "预算耗尽的图仍然跑完（finalStatus=completed，不再中途终止）",
      report.finalStatus === "completed",
      `finalStatus=${report.finalStatus}`
    );
    check("遍历包含全部节点（A → end）", report.traversalPath.length >= 2, `path=${report.traversalPath.join(" → ")}`);
    check("命令结果 success=true", result.success === true);
    check("Markdown 报告包含最终状态", result.markdownReport.includes("最终状态"));
  }
}

// ============================================================================
// 场景 2：显式 tokenBudgetHardStop=true → 恢复硬停语义
// ============================================================================

console.log("\n【场景 2】图配置 tokenBudgetHardStop=true：预算耗尽必须终止（旧行为可恢复）");
{
  const cmd = `/eag-graph --inline-graph '${graphJson({ maxTokens: 100, maxParallelism: 1, tokenBudgetHardStop: true })}'`;
  const request = extractEagGraphRequestFromPrompt(cmd);
  const handler = createHandler(createExecutor({ tokensPerNode: 5000 }));
  const result = await handler.execute(request, PROJECT_ROOT);

  const report = result.runReport;
  check("图执行产出运行报告", report !== undefined, result.errorMessage);
  if (report) {
    check(
      "硬停开启时图终态为 failed（预算耗尽即终止）",
      report.finalStatus === "failed",
      `finalStatus=${report.finalStatus}`
    );
    check("命令结果 success=false", result.success === false);
    check(
      "未执行到 end 节点（被提前终止）",
      report.nodeResults.get("end")?.status !== "completed",
      `end=${report.nodeResults.get("end")?.status ?? "未执行"}`
    );
  }
}

// ============================================================================
// 场景 3：节点被自动隔离 → 整图不得报 completed
// ============================================================================

console.log("\n【场景 3】A 恒失败被自动隔离：整图终态必须 failed（不得报绿）");
{
  // nodeRetryLimit=1：失败 1 次即进入隔离分支（缩短重试等待）
  const cmd = `/eag-graph --inline-graph '${graphJson({ maxTokens: 0, maxParallelism: 1, nodeRetryLimit: 1 })}'`;
  const request = extractEagGraphRequestFromPrompt(cmd);
  const handler = createHandler(createExecutor({ aFails: true, tokensPerNode: 10 }));
  const result = await handler.execute(request, PROJECT_ROOT);

  const report = result.runReport;
  check("图执行产出运行报告", report !== undefined, result.errorMessage);
  if (report) {
    const aStatus = report.nodeResults.get("A")?.status;
    const endStatus = report.nodeResults.get("end")?.status;
    check("A 被自动隔离（enableAutoIsolation 默认开启）", aStatus === "isolated", `A=${aStatus}`);
    check("隔离后下游仍继续执行（end 已跑）", endStatus === "completed", `end=${endStatus ?? "未执行"}`);
    check(
      "存在 isolated 节点时整图终态为 failed（不再误报 completed）",
      report.finalStatus === "failed",
      `finalStatus=${report.finalStatus}；A=${aStatus}；end=${endStatus ?? "未执行"}`
    );
    check("命令结果 success=false", result.success === false);
    check(
      "Markdown 报告不含虚假成功",
      result.markdownReport.includes("failed") || result.markdownReport.includes("失败")
    );
  }
}

// ============================================================================
// 场景 4：关闭自动隔离 → 节点失败直接终止整图
// ============================================================================

console.log("\n【场景 4】enableAutoIsolation=false：节点失败必须直接终止（不吞错）");
{
  const cmd = `/eag-graph --inline-graph '${graphJson({
    maxTokens: 0,
    maxParallelism: 1,
    enableAutoIsolation: false,
  })}'`;
  const request = extractEagGraphRequestFromPrompt(cmd);
  const handler = createHandler(createExecutor({ aFails: true, tokensPerNode: 10 }));
  const result = await handler.execute(request, PROJECT_ROOT);

  const report = result.runReport;
  check("图执行产出运行报告", report !== undefined, result.errorMessage);
  if (report) {
    check("图终态为 failed", report.finalStatus === "failed", `finalStatus=${report.finalStatus}`);
    check(
      "失败节点未被隔离（按配置直接终止）",
      report.nodeResults.get("A")?.status === "failed",
      `A=${report.nodeResults.get("A")?.status}`
    );
    check("下游 end 未执行", report.nodeResults.get("end")?.status === undefined);
  }
}

// ============================================================================
// 汇总
// ============================================================================

console.log("\n========================================");
if (failures.length === 0) {
  console.log(`✅ eag-graph 端到端全部通过（${pass} 项断言）`);
  process.exit(0);
}
console.log(`❌ 失败 ${failures.length} 项 / 通过 ${pass} 项：`);
for (const f of failures) console.log(`   - ${f}`);
process.exit(1);
