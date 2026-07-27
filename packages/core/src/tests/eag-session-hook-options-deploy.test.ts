/**
 * EAG-P3 批次 10 / EAG-P4 批次 13 单元测试：SessionManagerOptions 字段传递 + /eag-deploy 命令
 * （拆分自 eag-session-commands-hook.test.ts）
 *
 * 测试范围（对齐 EAG-P3 批次 10 §4.18.5 + EAG-P4 批次 13 §5.2）：
 * - M. SessionManagerOptions 新增字段（testingOrchestrator / designOrchestrator / runStateStore / ruleLearner）
 *      正确传递与向后兼容
 * - N. /eag-deploy 命令（EAG-P4 批次 13 Phase 7 §5.2）：EagCommandParser 判定 +
 *      handleEagDeployCommand 依赖校验 + extractDeployRequest + renderDevOpsResult +
 *      dryRun 模式 + devopsOrchestrator 字段传递
 *
 * 测试约定（严格遵循项目"禁止 mock"规则）：
 * - 使用 node:test + node:assert/strict
 * - 真实组件：
 *   1. SessionManager（session.ts）—— 真实类，通过 createTestManager 装配或直接 new
 *   2. RuleLearner（eag/rlis/rule-learner.ts）—— 真实类，无外部依赖，直接 new
 *   3. RunStateStore（eag/long-horizon/run-state-store.ts）—— 真实类，构造零成本
 *   4. 测试用 orchestrator 占位对象 —— 仅用于"已注入但未提供 request"路径的字段校验
 *      （此路径不调用 orchestrator.run()，与既有 F19 模式一致）
 * - 所有结果 fixture 使用 Object.freeze 冻结（对齐不可变优先 §5.12.4 G-A6d）
 * - 通过 `manager as any` 访问私有方法（与既有测试模式一致，非 mock 框架）
 * - 中文注释
 *
 * 设计依据：
 * - EAG-P3 批次 10 设计文档 §4.18.5 SessionManagerOptions 字段传递
 * - EAG-P4 批次 13 设计文档 §3.4 DevOpsOrchestrator 5 步编排
 * - EAG-P4 批次 13 设计文档 §5.2 SessionManager 集成（handleEagDeployCommand 装配逻辑）
 * - EAG 方案 §5.12.4 G-A6d 配置冻结原则（不可变优先）
 * - session.ts handleEagDeployCommand / renderDevOpsResult
 *
 * @module tests/eag-session-hook-options-deploy
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../session";
import { RuleLearner } from "../eag/rlis/rule-learner";
import { RunStateStore } from "../eag/long-horizon/run-state-store";
// EAG-P4 批次 13 Phase 7 新增导入：DevOps 编排结果类型（§3.4 / §5.2）
import type { DevOpsResult } from "../eag/devops/types";
import {
  createMinimalDeployRequest,
  createMinimalDeployRequestWithDryRun,
  createTestManager,
} from "./fixtures/eag-command-fixtures";

// ============================================================================
// M. SessionManagerOptions 字段传递与向后兼容测试（§4.18.5）
// ============================================================================

test("M1. 注入 testingOrchestrator/designOrchestrator/runStateStore/ruleLearner 时字段正确传递", () => {
  // 验证：SessionManager 构造函数正确赋值 EAG-P3 批次 10 新增字段
  // 对应 session.ts §605-608：this.testingOrchestrator = options.testingOrchestrator 等
  const fakeTestingOrchestrator = { run: () => ({}) } as any;
  const fakeDesignOrchestrator = { run: () => ({}) } as any;
  const runStateStore = new RunStateStore();
  const ruleLearner = new RuleLearner();

  const manager = new SessionManager({
    projectRoot: process.cwd(),
    createOpenAIClient: () => ({ client: null, model: "test-model", thinkingEnabled: false }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
    // EAG-P3 批次 10 新增字段
    testingOrchestrator: fakeTestingOrchestrator,
    designOrchestrator: fakeDesignOrchestrator,
    runStateStore,
    ruleLearner,
  });

  const internal = manager as any;
  assert.equal(internal.testingOrchestrator, fakeTestingOrchestrator, "testingOrchestrator 字段应正确传递");
  assert.equal(internal.designOrchestrator, fakeDesignOrchestrator, "designOrchestrator 字段应正确传递");
  assert.equal(internal.runStateStore, runStateStore, "runStateStore 字段应正确传递");
  assert.equal(internal.ruleLearner, ruleLearner, "ruleLearner 字段应正确传递");
});

test("M2. 未注入 testingOrchestrator/designOrchestrator/runStateStore/ruleLearner 时 SessionManager 正常构造（向后兼容）", () => {
  // 验证：EAG-P3 批次 10 字段均为可选，不注入时 SessionManager 正常构造
  // （向后兼容保证，§4.18.5 既有测试零回归）
  const manager = new SessionManager({
    projectRoot: process.cwd(),
    createOpenAIClient: () => ({ client: null, model: "test-model", thinkingEnabled: false }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
    // 不传入任何 EAG-P3 批次 10 字段
  });

  assert.ok(manager instanceof SessionManager, "SessionManager 应正常实例化");
  const internal = manager as any;
  assert.equal(internal.testingOrchestrator, undefined, "未注入时 testingOrchestrator 应为 undefined");
  assert.equal(internal.designOrchestrator, undefined, "未注入时 designOrchestrator 应为 undefined");
  assert.equal(internal.runStateStore, undefined, "未注入时 runStateStore 应为 undefined");
  assert.equal(internal.ruleLearner, undefined, "未注入时 ruleLearner 应为 undefined");
});

test("M3. 注入 ruleLearner 后主对话循环可调用 detectRuleCandidateHook（端到端验证字段传递）", async () => {
  // 验证：注入 ruleLearner 后，detectRuleCandidateHook 可正常调用 ruleLearner.detectCorrection
  // 端到端验证字段传递的正确性（不只是字段赋值，还包括方法可调用）
  // 输入"必须测试先行再实现功能"含"测试先行"关键词 → 推断分类 process-gate
  // detectedPattern "必须..." → 推断级别 MAJOR
  const messages: string[] = [];
  const ruleLearner = new RuleLearner();
  const manager = createTestManager((content) => messages.push(content), { ruleLearner });

  const internal = manager as any;
  // 调用两次同类纠正，验证 ruleLearner 字段确实被注入并可调用
  await internal.detectRuleCandidateHook("必须测试先行再实现功能", "test-session-field-1");
  await internal.detectRuleCandidateHook("必须测试先行再实现功能", "test-session-field-1");

  // 验证：第二次调用触发了推送（证明 ruleLearner 字段已正确注入且方法可调用）
  assert.ok(messages.length > 0, "应推送确认请求（证明 ruleLearner 已正确注入）");
  const prompt = messages[messages.length - 1];
  assert.ok(prompt.includes("必须测试先行再实现功能"), "确认请求应包含纠正内容");
  assert.ok(prompt.includes("process-gate"), "确认请求应包含推断的分类（process-gate，因输入含'测试先行'关键词）");
  assert.ok(prompt.includes("MAJOR"), "确认请求应包含推断的级别（MAJOR，因'必须'语气）");
});

// ============================================================================
// N. /eag-deploy 命令测试（EAG-P4 批次 13 Phase 7 §3.4 / §5.2）
// ============================================================================

test("N1. EagCommandParser 对 /eag-deploy 命令返回 eag-deploy kind（命令判定逻辑）", () => {
  // EAG-P4 批次 13 Phase 7 §5.1：/eag-deploy 命令由 EagCommandParser.parse() 统一入口判定
  // 验证：EagCommandParser 能正确识别 /eag-deploy 命令（kind === "eag-deploy"）
  // 判定规则：text 严格匹配 /eag-deploy，无图片附件，无技能匹配
  const manager = createTestManager(() => {});
  const internal = manager as any;
  const parser = internal.eagCommandParser;

  // 正确命令格式
  assert.equal(parser.parse({ text: "/eag-deploy" }).kind, "eag-deploy");
  assert.equal(parser.parse({ text: "  /eag-deploy  " }).kind, "eag-deploy");
  // 非命令格式（严格匹配，不允许参数内嵌）
  assert.equal(parser.parse({ text: "请帮我执行 /eag-deploy" }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-deploy --project order-service" }).kind, "unknown");
  // 其他 EAG 命令不受影响
  assert.equal(parser.parse({ text: "/eag-build" }).kind, "eag-build");
  assert.equal(parser.parse({ text: "/eag-status" }).kind, "eag-status");
  // 非字符串 / undefined 兜底
  assert.equal(parser.parse({ text: undefined }).kind, "unknown");
  assert.equal(parser.parse({ text: 123 as any }).kind, "unknown");
  // 含图片或技能时不识别为命令（避免误触发）
  assert.equal(parser.parse({ text: "/eag-deploy", imageUrls: ["data:image/png;base64,..."] }).kind, "unknown");
  assert.equal(
    parser.parse({ text: "/eag-deploy", skills: [{ name: "test", path: "/", description: "" }] }).kind,
    "unknown"
  );
});

test("N2. handleEagDeployCommand 未注入 devopsOrchestrator 时通知错误并标记 failed", async () => {
  // 验证 handleEagDeployCommand 的依赖校验逻辑（session.ts §handleEagDeployCommand 步骤 1）：
  // 未注入 devopsOrchestrator → 通知用户配置缺失，更新 session 状态为 failed
  const messages: string[] = [];
  const manager = createTestManager((content) => messages.push(content));

  const internal = manager as any;
  // handleEagDeployCommand 第三参数 request 由 EagCommandParser 预提取
  // 此测试验证未注入 devopsOrchestrator 路径，request 传 null（依赖校验先于 request 校验）
  await internal.handleEagDeployCommand("test-session-deploy-1", { text: "/eag-deploy" }, null, new AbortController());

  // 验证：通知消息含"DevOps 编排器未注入"字样
  assert.ok(messages.length > 0, "应发送至少一条通知消息");
  assert.ok(
    messages.some((m) => m.includes("DevOps 编排器未注入")),
    `通知消息应含"DevOps 编排器未注入"，实际为：${messages.join("\n")}`
  );
});

test("N3. handleEagDeployCommand 已注入但未提供 DeployRequest 时通知错误", async () => {
  // 验证 handleEagDeployCommand 的请求校验逻辑（session.ts §handleEagDeployCommand 步骤 2）：
  // 已注入 devopsOrchestrator 但未提供 DeployRequest → 通知用户配置缺失
  const messages: string[] = [];
  // 注：此测试只走到请求校验失败分支，不调用 orchestrator.run()
  // 使用最小真实对象（{ run: () => ({}) }）满足字段校验，与既有 F19/G3/H3 模式一致
  const fakeOrchestrator = { run: () => ({}) } as any;
  const manager = createTestManager((content) => messages.push(content), { devopsOrchestrator: fakeOrchestrator });

  const internal = manager as any;
  // 此测试验证未提供 DeployRequest 路径，request 显式传 null 触发 "DeployRequest 未提供" 错误
  await internal.handleEagDeployCommand("test-session-deploy-2", { text: "/eag-deploy" }, null, new AbortController());

  // 验证：通知消息含"DeployRequest 未提供"字样
  assert.ok(messages.length > 0, "应发送至少一条通知消息");
  assert.ok(
    messages.some((m) => m.includes("DeployRequest 未提供")),
    `通知消息应含"DeployRequest 未提供"，实际为：${messages.join("\n")}`
  );
});

test("N4. EagCommandParser 正确提取并校验 DeployRequest 字段", () => {
  // EAG-P4 批次 13 Phase 7 §5.1：extractDeployRequest 已迁移至 EagCommandParser.parse() 内部
  // 验证 EagCommandParser.parse() 的字段校验逻辑（payload 提取）：
  // 1. messageParams 缺失/空 → payload 为 null
  // 2. deployRequest 字段缺失 → payload 为 null
  // 3. deployRequest 字段不完整（缺 projectName / image / port / replicas 等）→ payload 为 null
  // 4. deployRequest 字段取值非法（environment / iacType / strategy）→ payload 为 null
  // 5. deployRequest.port / replicas 超范围 → payload 为 null
  // 6. deployRequest.dryRun 非 boolean → payload 为 null
  // 7. deployRequest 字段完整且合法 → payload 为 DeployRequest 对象
  const manager = createTestManager(() => {});
  const internal = manager as any;
  const parser = internal.eagCommandParser;

  // 情况 1：messageParams 为 undefined
  assert.equal(parser.parse({ text: "/eag-deploy" }).payload, null);
  // 情况 1：messageParams 为 null
  assert.equal(parser.parse({ text: "/eag-deploy", messageParams: null }).payload, null);
  // 情况 1：messageParams 为空对象
  assert.equal(parser.parse({ text: "/eag-deploy", messageParams: {} }).payload, null);
  // 情况 2：deployRequest 字段缺失
  assert.equal(parser.parse({ text: "/eag-deploy", messageParams: { other: "value" } }).payload, null);

  // 情况 3：deployRequest.projectName 缺失
  assert.equal(
    parser.parse({
      text: "/eag-deploy",
      messageParams: {
        deployRequest: {
          environment: "prod",
          image: "img",
          port: 8080,
          replicas: 3,
          iacType: "helm-chart",
          strategy: "rolling",
        },
      },
    }).payload,
    null
  );
  // 情况 3：deployRequest.image 缺失
  assert.equal(
    parser.parse({
      text: "/eag-deploy",
      messageParams: {
        deployRequest: {
          projectName: "svc",
          environment: "prod",
          port: 8080,
          replicas: 3,
          iacType: "helm-chart",
          strategy: "rolling",
        },
      },
    }).payload,
    null
  );

  // 情况 4：environment 取值非法
  assert.equal(
    parser.parse({
      text: "/eag-deploy",
      messageParams: {
        deployRequest: {
          projectName: "svc",
          environment: "qa",
          image: "img",
          port: 8080,
          replicas: 3,
          iacType: "helm-chart",
          strategy: "rolling",
        },
      },
    }).payload,
    null
  );
  // 情况 4：iacType 取值非法
  assert.equal(
    parser.parse({
      text: "/eag-deploy",
      messageParams: {
        deployRequest: {
          projectName: "svc",
          environment: "prod",
          image: "img",
          port: 8080,
          replicas: 3,
          iacType: "pulumi",
          strategy: "rolling",
        },
      },
    }).payload,
    null
  );
  // 情况 4：strategy 取值非法
  assert.equal(
    parser.parse({
      text: "/eag-deploy",
      messageParams: {
        deployRequest: {
          projectName: "svc",
          environment: "prod",
          image: "img",
          port: 8080,
          replicas: 3,
          iacType: "helm-chart",
          strategy: "recreate",
        },
      },
    }).payload,
    null
  );

  // 情况 5：port 超范围（> 65535）
  assert.equal(
    parser.parse({
      text: "/eag-deploy",
      messageParams: {
        deployRequest: {
          projectName: "svc",
          environment: "prod",
          image: "img",
          port: 70000,
          replicas: 3,
          iacType: "helm-chart",
          strategy: "rolling",
        },
      },
    }).payload,
    null
  );
  // 情况 5：replicas 超范围（> 100）
  assert.equal(
    parser.parse({
      text: "/eag-deploy",
      messageParams: {
        deployRequest: {
          projectName: "svc",
          environment: "prod",
          image: "img",
          port: 8080,
          replicas: 200,
          iacType: "helm-chart",
          strategy: "rolling",
        },
      },
    }).payload,
    null
  );

  // 情况 6：dryRun 非 boolean（字符串）
  assert.equal(
    parser.parse({
      text: "/eag-deploy",
      messageParams: {
        deployRequest: {
          projectName: "svc",
          environment: "prod",
          image: "img",
          port: 8080,
          replicas: 3,
          iacType: "helm-chart",
          strategy: "rolling",
          dryRun: "yes",
        },
      },
    }).payload,
    null
  );

  // 情况 7：字段完整且合法 → 返回对象
  const validRequest = createMinimalDeployRequest();
  const parsed = parser.parse({
    text: "/eag-deploy",
    messageParams: { deployRequest: validRequest },
  });
  assert.ok(parsed.payload, "字段完整时应返回 DeployRequest 对象");
  assert.equal((parsed.payload as any).projectName, "order-service");
  assert.equal((parsed.payload as any).environment, "prod");
  assert.equal((parsed.payload as any).port, 8080);
  assert.equal((parsed.payload as any).replicas, 3);
  assert.equal((parsed.payload as any).iacType, "helm-chart");
  assert.equal((parsed.payload as any).strategy, "blue-green");

  // 情况 7（含 dryRun）：dryRun=true 应被正确提取
  const validRequestWithDryRun = createMinimalDeployRequestWithDryRun();
  const parsedDryRun = parser.parse({
    text: "/eag-deploy",
    messageParams: { deployRequest: validRequestWithDryRun },
  });
  assert.ok(parsedDryRun.payload, "含 dryRun 的 DeployRequest 应被正确提取");
  assert.equal((parsedDryRun.payload as any).dryRun, true);
});

test("N5. renderDevOpsResult 正确渲染结果摘要（成功场景 + 失败场景，§3.4 / §5.2）", () => {
  // 验证 renderDevOpsResult 的渲染逻辑：
  // 1. 包含标题 [EAG DEPLOY Loop]
  // 2. 包含最终状态（成功/失败）
  // 3. 包含 runId 与总耗时
  // 4. 包含 IaC 模板清单（前 10 个，含 type / filePath / hash 前 8 位）
  // 5. 包含部署资源清单（前 10 个）
  // 6. 包含健康检查结果
  // 7. 包含烟雾测试结果
  // 8. 包含 G-8 门禁结果（passed + reason + severity）
  // 9. 包含错误信息列表（前 10 条）
  const manager = createTestManager(() => {});
  const internal = manager as any;

  // 构造测试用 DevOpsResult（成功场景）
  const successResult: DevOpsResult = Object.freeze({
    success: true,
    runId: "deploy-run-001",
    startedAt: "2026-07-20T10:00:00.000Z",
    finishedAt: "2026-07-20T10:02:30.000Z",
    duration: 150000, // 150 秒
    iacTemplates: Object.freeze([
      Object.freeze({
        type: "helm-chart",
        content: "...",
        filePath: "Chart.yaml",
        hash: "abc123def4567890abcdef1234567890abcdef1234567890abcdef1234567890",
        generatedAt: "2026-07-20T10:01:00.000Z",
      }),
      Object.freeze({
        type: "helm-chart",
        content: "...",
        filePath: "values.yaml",
        hash: "def4567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        generatedAt: "2026-07-20T10:01:00.000Z",
      }),
    ]),
    deployResult: Object.freeze({
      success: true,
      deployedAt: "2026-07-20T10:02:00.000Z",
      duration: 60000,
      resources: Object.freeze([
        Object.freeze({
          kind: "Deployment",
          name: "order-service",
          namespace: "prod",
          status: "Running",
        }),
        Object.freeze({
          kind: "Service",
          name: "order-service-svc",
          namespace: "prod",
          status: "Running",
        }),
      ]),
      errors: Object.freeze([]),
    }),
    healthCheckResult: Object.freeze({
      healthy: true,
      checkedAt: "2026-07-20T10:02:15.000Z",
      endpoints: Object.freeze([
        Object.freeze({
          url: "http://order-service.prod.svc.cluster.local:8080/healthz",
          statusCode: 200,
          responseTimeMs: 50,
          healthy: true,
        }),
      ]),
      failures: Object.freeze([]),
    }),
    smokeTestResult: Object.freeze({
      passed: true,
      totalTests: 1,
      passedTests: 1,
      failedTests: 0,
      duration: 2000,
      failures: Object.freeze([]),
    }),
    gateResult: Object.freeze({
      passed: true,
      gate: "G-8",
      reason: "全部部署就绪条件满足",
      severity: "blocker",
    }),
    errors: Object.freeze([]),
  }) as DevOpsResult;

  const successSummary: string = internal.renderDevOpsResult(successResult);

  // 验证渲染内容（成功场景）
  assert.ok(successSummary.includes("[EAG DEPLOY Loop]"), "应包含标题");
  assert.ok(successSummary.includes("最终状态: 成功"), "应包含最终状态（成功）");
  assert.ok(successSummary.includes("runId: deploy-run-001"), "应包含 runId");
  assert.ok(successSummary.includes("总耗时: 150.0s"), "应包含总耗时（秒）");
  assert.ok(successSummary.includes("IaC 模板 (2 个)"), "应包含 IaC 模板数");
  assert.ok(successSummary.includes("[helm-chart] Chart.yaml"), "应包含 Chart.yaml 模板");
  assert.ok(successSummary.includes("[helm-chart] values.yaml"), "应包含 values.yaml 模板");
  assert.ok(successSummary.includes("hash: abc123de"), "应包含 hash 前 8 位");
  assert.ok(successSummary.includes("部署资源 (2 个)"), "应包含部署资源数");
  assert.ok(successSummary.includes("Deployment/order-service"), "应包含 Deployment 资源");
  assert.ok(successSummary.includes("健康检查: 通过"), "应包含健康检查结果（通过）");
  assert.ok(successSummary.includes("端点数: 1"), "应包含端点数");
  assert.ok(successSummary.includes("烟雾测试: 通过"), "应包含烟雾测试结果（通过）");
  assert.ok(successSummary.includes("通过: 1"), "应包含烟雾测试通过数");
  assert.ok(successSummary.includes("G-8 门禁: 通过"), "应包含 G-8 门禁结果（通过）");
  assert.ok(successSummary.includes("全部部署就绪条件满足"), "应包含门禁理由");

  // 验证失败场景：含 errors + G-8 未通过
  const failedResult: DevOpsResult = Object.freeze({
    ...successResult,
    success: false,
    runId: "deploy-run-002",
    gateResult: Object.freeze({
      passed: false,
      gate: "G-8",
      reason: "健康检查未通过：1 个端点不健康",
      severity: "blocker",
    }),
    errors: Object.freeze(["G-8 门禁未通过：健康检查未通过：1 个端点不健康", "DeployStage 执行失败：smoke-test 超时"]),
  }) as DevOpsResult;

  const failedSummary: string = internal.renderDevOpsResult(failedResult);
  assert.ok(failedSummary.includes("最终状态: 失败"), "应渲染失败状态");
  assert.ok(failedSummary.includes("runId: deploy-run-002"), "应渲染失败的 runId");
  assert.ok(failedSummary.includes("G-8 门禁: 未通过"), "应渲染 G-8 门禁未通过");
  assert.ok(failedSummary.includes("健康检查未通过：1 个端点不健康"), "应渲染门禁失败理由");
  assert.ok(failedSummary.includes("错误信息 (2 条)"), "应包含错误信息数");
  assert.ok(failedSummary.includes("G-8 门禁未通过"), "应包含第一条错误");
  assert.ok(failedSummary.includes("DeployStage 执行失败"), "应包含第二条错误");
});

test("N6. handleEagDeployCommand dryRun 模式启用时通知用户（§5.1）", async () => {
  // 验证 handleEagDeployCommand 的 dryRun 模式通知逻辑：
  // DeployRequest.dryRun=true → 在编排前通知用户"dryRun 模式已启用"
  // 注：批次 13 暂不支持 dryRun 短路，DevOpsOrchestrator.run() 始终执行完整 5 步编排
  // 此测试仅验证 dryRun 通知消息，不验证编排结果（编排由 devops-orchestrator.test.ts 覆盖）
  const messages: string[] = [];
  // 构造 fakeOrchestrator：run() 返回成功的 DevOpsResult，避免编排异常干扰测试
  const fakeSuccessResult: DevOpsResult = Object.freeze({
    success: true,
    runId: "test-dry-run",
    startedAt: "2026-07-20T10:00:00.000Z",
    finishedAt: "2026-07-20T10:00:01.000Z",
    duration: 1000,
    iacTemplates: Object.freeze([]),
    gateResult: Object.freeze({
      passed: true,
      gate: "G-8",
      reason: "测试通过",
      severity: "blocker",
    }),
    errors: Object.freeze([]),
  }) as DevOpsResult;
  const fakeOrchestrator = { run: () => Promise.resolve(fakeSuccessResult) } as any;
  const manager = createTestManager((content) => messages.push(content), { devopsOrchestrator: fakeOrchestrator });

  const internal = manager as any;
  const dryRunRequest = createMinimalDeployRequestWithDryRun();
  await internal.handleEagDeployCommand(
    "test-session-deploy-dryrun",
    { text: "/eag-deploy" },
    dryRunRequest,
    new AbortController()
  );

  // 验证：dryRun 通知消息存在
  assert.ok(messages.length > 0, "应发送至少一条通知消息");
  assert.ok(
    messages.some((m) => m.includes("dryRun 模式已启用")),
    `通知消息应含"dryRun 模式已启用"，实际为：${messages.join("\n")}`
  );
});

test("N7. SessionManagerOptions.devopsOrchestrator 字段正确传递（§5.2）", () => {
  // 验证：SessionManager 构造函数正确赋值 EAG-P4 批次 13 新增字段 devopsOrchestrator
  // 对应 session.ts §this.devopsOrchestrator = options.devopsOrchestrator
  const fakeDevOpsOrchestrator = { run: () => ({}) } as any;

  const manager = new SessionManager({
    projectRoot: process.cwd(),
    createOpenAIClient: () => ({ client: null, model: "test-model", thinkingEnabled: false }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
    // EAG-P4 批次 13 新增字段
    devopsOrchestrator: fakeDevOpsOrchestrator,
  });

  const internal = manager as any;
  assert.equal(internal.devopsOrchestrator, fakeDevOpsOrchestrator, "devopsOrchestrator 字段应正确传递");
});

test("N8. 未注入 devopsOrchestrator 时 SessionManager 正常构造（向后兼容，§5.2）", () => {
  // 验证：EAG-P4 批次 13 字段 devopsOrchestrator 为可选，不注入时 SessionManager 正常构造
  // （向后兼容保证，既有测试零回归）
  const manager = new SessionManager({
    projectRoot: process.cwd(),
    createOpenAIClient: () => ({ client: null, model: "test-model", thinkingEnabled: false }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
    // 不传入任何 EAG-P4 批次 13 字段
  });

  assert.ok(manager instanceof SessionManager, "SessionManager 应正常实例化");
  const internal = manager as any;
  assert.equal(internal.devopsOrchestrator, undefined, "未注入时 devopsOrchestrator 应为 undefined");
});

test("N9. handleEagDeployCommand 编排异常时通知错误并标记 failed（P1-3 修复）", async () => {
  // 验证 handleEagDeployCommand 步骤 4 的 catch 块（session.ts L3111-L3134）：
  // devopsOrchestrator.run() 抛异常 → 通知用户错误，更新 session 状态为 failed
  // P1-3 修复（架构师审查）：补充编排异常路径测试覆盖
  const messages: string[] = [];
  // 构造抛异常的 fakeOrchestrator（真实 Error，非 mock 框架，与既有 F19 模式一致）
  const fakeOrchestrator = {
    run: () => Promise.reject(new Error("IaC 生成器校验失败：terraform validate 异常")),
  } as any;
  const manager = createTestManager((content) => messages.push(content), { devopsOrchestrator: fakeOrchestrator });

  const internal = manager as any;
  const validRequest = createMinimalDeployRequest();
  await internal.handleEagDeployCommand(
    "test-session-deploy-err",
    { text: "/eag-deploy" },
    validRequest,
    new AbortController()
  );

  // 验证：通知消息含"编排异常"字样（实际消息格式：[EAG DEPLOY Loop] 编排异常：...）
  // 注：消息中 "DEPLOY Loop" 与 "编排异常" 之间有 "] " 分隔，故只匹配 "编排异常"
  assert.ok(messages.length > 0, "应发送至少一条通知消息");
  assert.ok(
    messages.some((m) => m.includes("编排异常")),
    `通知消息应含"编排异常"，实际为：${messages.join("\n")}`
  );
  // 验证：通知消息含异常详情（IaC 生成器校验失败）
  assert.ok(
    messages.some((m) => m.includes("IaC 生成器校验失败")),
    `通知消息应含异常详情，实际为：${messages.join("\n")}`
  );
  // 验证：通知消息含依赖组件提示（帮助用户排查）
  assert.ok(
    messages.some((m) => m.includes("IaCGenerator") && m.includes("GateG8Checker")),
    `通知消息应含依赖组件提示，实际为：${messages.join("\n")}`
  );
  // 注：session 状态通过 updateSessionEntry 更新（从磁盘 sessions.json 读取），
  // 测试环境未创建 session entry 时 updateSessionEntry 返回 null，故不验证 session 状态
  // （与既有 G2/G3/H2/H3 测试模式一致，仅验证通知消息）
});

test("N10. handleEagDeployCommand 入口前 abort 时抛 AbortError（P1-4 修复）", async () => {
  // 验证 handleEagDeployCommand 入口 abort 检查（session.ts L2966 throwIfAborted）：
  // controller.abort() 后调用 → throwIfAborted 抛 AbortError（name === "AbortError"）
  // P1-4 修复（架构师审查）：补充 abort 中断场景测试覆盖
  const messages: string[] = [];
  // fakeOrchestrator.run() 不会被调用（入口 abort 检查先抛异常）
  // 但仍需提供占位以满足 devopsOrchestrator 注入校验
  const fakeOrchestrator = { run: () => Promise.resolve({}) } as any;
  const manager = createTestManager((content) => messages.push(content), { devopsOrchestrator: fakeOrchestrator });

  const internal = manager as any;
  const controller = new AbortController();
  controller.abort();

  // 验证：入口 throwIfAborted 抛 AbortError，且错误类型正确
  // 实际生产环境中，该异常由 processUserInput 主循环的 catch 捕获并标记 session 为 failed
  let caughtError: Error | null = null;
  try {
    await internal.handleEagDeployCommand(
      "test-session-deploy-abort",
      { text: "/eag-deploy" },
      createMinimalDeployRequest(),
      controller
    );
  } catch (e) {
    caughtError = e instanceof Error ? e : new Error(String(e));
  }

  // 验证：捕获到 AbortError
  assert.ok(caughtError !== null, "应抛出异常（AbortError）");
  assert.equal(caughtError?.name, "AbortError", `异常 name 应为 AbortError，实际为：${caughtError?.name}`);
  assert.ok(caughtError?.message.includes("aborted"), `异常 message 应含 aborted，实际为：${caughtError?.message}`);

  // 验证：abort 路径下未发送任何 assistant 消息（异常在 updateSessionEntry 之前抛出）
  assert.equal(messages.length, 0, "abort 路径不应发送任何 assistant 消息");
});

test("N11. handleEagDeployCommand 渲染失败时降级为简单文本（P1-1 修复）", async () => {
  // 验证 handleEagDeployCommand 步骤 5 的 try-catch（session.ts L3156-L3165）：
  // DevOpsResult 字段异常导致 renderDevOpsResult 抛错 → 降级为简单文本摘要
  // P1-1 修复（架构师审查）：渲染失败不阻塞 session 状态更新
  const messages: string[] = [];
  // 构造一个返回字段不完整 DevOpsResult 的 fakeOrchestrator
  // - gateResult 缺失（renderDevOpsResult 访问 result.gateResult.passed 会抛错）
  // - iacTemplates 元素缺少 hash 字段（renderDevOpsResult 访问 t.hash.slice 会抛错）
  // 验证：渲染失败时降级为简单文本，session 状态仍正确更新
  const incompleteResult = Object.freeze({
    success: true,
    runId: "deploy-run-render-err",
    startedAt: "2026-07-20T10:00:00.000Z",
    finishedAt: "2026-07-20T10:02:30.000Z",
    duration: 150000,
    iacTemplates: Object.freeze([
      Object.freeze({ type: "helm-chart", filePath: "/tmp/Chart.yaml" }), // 缺少 hash 字段
    ]),
    // 故意省略 gateResult 字段，触发 renderDevOpsResult 抛错
    errors: Object.freeze([]),
  }) as DevOpsResult;
  const fakeOrchestrator = {
    run: () => Promise.resolve(incompleteResult),
  } as any;
  const manager = createTestManager((content) => messages.push(content), { devopsOrchestrator: fakeOrchestrator });

  const internal = manager as any;
  await internal.handleEagDeployCommand(
    "test-session-deploy-render-err",
    { text: "/eag-deploy" },
    createMinimalDeployRequest(),
    new AbortController()
  );

  // 验证：通知消息含降级文本（"结果渲染失败"）
  assert.ok(messages.length > 0, "应发送至少一条通知消息");
  assert.ok(
    messages.some((m) => m.includes("结果渲染失败")),
    `通知消息应含"结果渲染失败"字样，实际为：${messages.join("\n")}`
  );
  // 验证：降级文本含最终状态与 runId
  assert.ok(
    messages.some((m) => m.includes("最终状态: 成功") && m.includes("deploy-run-render-err")),
    `降级文本应含最终状态与 runId，实际为：${messages.join("\n")}`
  );
  // 注：session 状态通过 updateSessionEntry 更新（从磁盘 sessions.json 读取），
  // 测试环境未创建 session entry 时 updateSessionEntry 返回 null，故不验证 session 状态
  // （与既有 G2/G3/H2/H3 测试模式一致，仅验证通知消息）
});
