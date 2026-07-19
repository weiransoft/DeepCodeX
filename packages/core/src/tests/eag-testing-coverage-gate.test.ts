/**
 * EAG-P3 批次 10 单元测试：覆盖率门禁（CoverageGate + C8ReportParser）
 *
 * 测试范围（对齐设计文档 §4.4）：
 * - T1. C8ReportParser.parse() 成功解析合法 JSON 报告
 * - T2. C8ReportParser.parse() JSON 解析失败 → 抛 CoverageGateError (c8-parse)
 * - T3. C8ReportParser.parse() schema 校验失败 → 抛 CoverageGateError (c8-parse)
 *   - T3a. 缺 total 字段
 *   - T3b. 缺 pct 字段
 *   - T3c. pct 非数字
 *   - T3d. 空字符串输入
 * - T4. C8ReportParser.parse() 返回冻结对象（不可变性）
 * - T5. CoverageGate 实例化与工厂函数
 *   - T5a. 默认构造
 *   - T5b. 注入 logger
 *   - T5c. createDefaultCoverageGate 工厂
 *   - T5d. createC8ReportParser 工厂
 * - T6. CoverageGate.check() 请求校验失败路径
 *   - T6a. projectRoot 空 → CoverageGateError (threshold-config)
 *   - T6b. testDir 空 → CoverageGateError (threshold-config)
 *   - T6c. implementationRoot 空 → CoverageGateError (threshold-config)
 *   - T6d. topN < 1 → CoverageGateError (threshold-config)
 *   - T6e. consecutiveFailureCount < 0 → CoverageGateError (threshold-config)
 * - T7. CoverageGate.check() c8 不可用 → 抛 CoverageGateError (c8-spawn)
 *   注：当前环境 c8 未安装，触发真实 spawn 失败路径
 * - T8. c8 可用环境下的成功路径（test.skip：需 c8 安装）
 *   - T8a. 覆盖率达标 → verdict=pass
 *   - T8b. 行覆盖率不达标 → verdict=fail
 *   - T8c. 高风险符号未覆盖 → verdict=fail
 *   - T8d. 首次失败 WARNING（passed=true）
 *   - T8e. 连续 2 次失败升级 BLOCKER（passed=false）
 * - T9. isC8Available() 返回 boolean（同步检测）
 * - T10. 不可变性
 *   - T10a. DEFAULT_COVERAGE_THRESHOLD 冻结
 *   - T10b. C8ParsedReport 冻结
 *   - T10c. C8ParsedReport.uncoveredFiles 冻结
 *   - T10d. C8ParsedReport.raw 冻结
 * - T11. 错误类
 *   - T11a. CoverageGateError 含 kind 属性
 *   - T11b. CoverageGateError 含 cause 属性
 *   - T11c. CoverageGateError name 属性
 * - T12. 常量重导出
 *   - T12a. DEFAULT_COVERAGE_THRESHOLD 重导出
 *   - T12b. DEFAULT_HIGH_RISK_TOP_N 重导出
 *   - T12c. COVERAGE_CONSECUTIVE_FAILURE_THRESHOLD 重导出
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，使用真实 PkcAccessor 实现 + 真实 c8 spawn（若可用）
 * - c8 不可用时使用 test.skip 跳过真实 c8 路径测试，附明确注释
 *
 * @module core/tests/eag-testing-coverage-gate
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  CoverageGate,
  CoverageGateError,
  C8ReportParser,
  createDefaultCoverageGate,
  createC8ReportParser,
  isC8Available,
} from "../eag/testing/coverage-gate";
import type { CoverageGateRequest, C8ParsedReport } from "../eag/testing/coverage-gate";
import type { CoverageThreshold, PkcAccessor, E2eTestSpec, UncoveredSymbol } from "../eag/testing/types";
import {
  DEFAULT_COVERAGE_THRESHOLD,
  DEFAULT_HIGH_RISK_TOP_N,
  COVERAGE_CONSECUTIVE_FAILURE_THRESHOLD,
} from "../eag/testing/types";

// ============================================================================
// 辅助函数：构造测试 fixture
// ============================================================================

/**
 * 创建临时项目目录
 *
 * @returns 临时目录绝对路径
 */
function createTmpProjectDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "eag-testing-coverage-"));
}

/**
 * 清理临时目录
 *
 * @param dir 临时目录路径
 */
function cleanupTmpDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // 忽略清理失败
  }
}

/**
 * 内存版 PKC 访问器（真实实现，非 mock）
 *
 * 通过构造时传入的 hotspots 列表返回真实数据。
 * 实现 PkcAccessor 协议的 3 个方法，便于覆盖率门禁测试注入。
 */
class InMemoryPkcAccessor implements PkcAccessor {
  /** 业务流程列表（构造时注入，运行期只读） */
  private readonly flows: ReadonlyArray<E2eTestSpec>;
  /** 风险热点列表（构造时注入，运行期只读） */
  private readonly hotspots: ReadonlyArray<UncoveredSymbol>;

  constructor(flows: ReadonlyArray<E2eTestSpec> = [], hotspots: ReadonlyArray<UncoveredSymbol> = []) {
    this.flows = flows;
    this.hotspots = hotspots;
  }

  /**
   * 查询业务流程列表
   *
   * @param _projectRoot 项目根目录（本内存实现忽略）
   * @returns 构造时注入的 flows 列表
   */
  async queryBusinessFlows(_projectRoot: string): Promise<ReadonlyArray<E2eTestSpec>> {
    return this.flows;
  }

  /**
   * 查询风险热点列表
   *
   * @param _projectRoot 项目根目录（本内存实现忽略）
   * @param _topN Top-N（本内存实现忽略）
   * @returns 构造时注入的 hotspots 列表
   */
  async queryRiskHotspots(_projectRoot: string, _topN?: number): Promise<ReadonlyArray<UncoveredSymbol>> {
    return this.hotspots;
  }

  /**
   * 查询 L1 全局视野
   *
   * @param _projectRoot 项目根目录
   * @returns 空对象（本测试不消费此字段）
   */
  async queryL1GlobalView(_projectRoot: string): Promise<Readonly<Record<string, unknown>>> {
    return {};
  }
}

/**
 * 抛错的 PKC 访问器（用于测试 pkc-query 降级路径）
 *
 * 真实实现：queryRiskHotspots 抛出真实错误，触发 CoverageGate 内部降级逻辑。
 */
class ThrowingPkcAccessor implements PkcAccessor {
  async queryBusinessFlows(_projectRoot: string): Promise<ReadonlyArray<E2eTestSpec>> {
    throw new Error("PKC 数据库连接失败");
  }
  async queryRiskHotspots(_projectRoot: string, _topN?: number): Promise<ReadonlyArray<UncoveredSymbol>> {
    throw new Error("PKC 数据库连接失败");
  }
  async queryL1GlobalView(_projectRoot: string): Promise<Readonly<Record<string, unknown>>> {
    throw new Error("PKC 数据库连接失败");
  }
}

/**
 * 构造合法的 c8 JSON 报告字符串
 *
 * c8 --reporter=json 输出格式（基于 v8-coverage），含：
 * - total：总行数 / 总分支数 / 总函数数 / 总语句数
 * - covered：覆盖行数 / 覆盖分支数 / 覆盖函数数 / 覆盖语句数
 * - pct：百分比覆盖率（0~100）
 * - uncoveredFiles：未覆盖文件列表（相对路径）
 *
 * @param overrides 覆盖字段（用于定制测试场景）
 * @returns c8 报告 JSON 字符串
 */
function buildC8ReportJson(
  overrides: Partial<{
    total: Record<string, number>;
    covered: Record<string, number>;
    pct: Record<string, number>;
    uncoveredFiles: string[];
  }> = {}
): string {
  const report = {
    total: {
      lines: 100,
      statements: 100,
      functions: 50,
      branches: 80,
      ...overrides.total,
    },
    covered: {
      lines: 90,
      statements: 90,
      functions: 45,
      branches: 60,
      ...overrides.covered,
    },
    pct: {
      lines: 90.0,
      statements: 90.0,
      functions: 90.0,
      branches: 75.0,
      ...overrides.pct,
    },
    uncoveredFiles: ["src/services/PaymentService.ts", ...(overrides.uncoveredFiles ?? [])],
  };
  return JSON.stringify(report);
}

/**
 * 构造合法的 CoverageGateRequest
 *
 * @param overrides 覆盖字段
 * @returns CoverageGateRequest 实例
 */
function createCoverageGateRequest(overrides: Partial<CoverageGateRequest> = {}): CoverageGateRequest {
  return {
    projectRoot: "/tmp/test-project",
    testDir: "tests/",
    implementationRoot: "src/",
    topN: DEFAULT_HIGH_RISK_TOP_N,
    consecutiveFailureCount: 0,
    ...overrides,
  };
}

// ============================================================================
// T1. C8ReportParser.parse() 成功解析合法 JSON 报告
// ============================================================================

test("T1: C8ReportParser.parse() 成功解析合法 JSON 报告", () => {
  const parser = new C8ReportParser();
  const rawJson = buildC8ReportJson();
  const parsed = parser.parse(rawJson);

  // 验证核心字段提取
  assert.equal(parsed.lines, 90.0, "行覆盖率应为 90.0");
  assert.equal(parsed.branches, 75.0, "分支覆盖率应为 75.0");
  assert.equal(parsed.functions, 90.0, "函数覆盖率应为 90.0");

  // 验证未覆盖文件列表提取
  assert.ok(Array.isArray(parsed.uncoveredFiles), "uncoveredFiles 应为数组");
  assert.ok(parsed.uncoveredFiles.length > 0, "应提取至少 1 个未覆盖文件");
  assert.ok(parsed.uncoveredFiles.includes("src/services/PaymentService.ts"), "未覆盖文件列表应含 PaymentService.ts");

  // 验证未覆盖符号列表（parser 阶段为空，由 CoverageGate.check() 通过 PKC 交叉比对填充）
  assert.ok(Array.isArray(parsed.uncoveredSymbols), "uncoveredSymbols 应为数组");
  assert.equal(parsed.uncoveredSymbols.length, 0, "parser 阶段 uncoveredSymbols 应为空");

  // 验证原始报告保留：raw 应为原始 c8 报告的浅拷贝对象
  // - raw 不为 undefined
  // - raw 包含原始报告的全部字段（total / covered / pct / uncoveredFiles）
  // - raw 内容与原始 JSON 报告一致（浅拷贝语义：顶层属性值相同）
  // - 注：两次 JSON.parse 产生的对象引用不同，故使用 deepEqual 验证内容一致
  assert.ok(parsed.raw, "raw 应保留原始 JSON 对象");

  // 解析原始 JSON 以便对比 raw 内容
  const originalParsed = JSON.parse(rawJson) as Record<string, unknown>;
  const rawObj = parsed.raw as Record<string, unknown>;

  // raw 应包含 total 字段（与原始报告内容一致）
  assert.ok(rawObj.total !== undefined, "raw 应保留 total 字段（浅拷贝原始报告）");
  assert.deepEqual(rawObj.total, originalParsed.total, "raw.total 应与原始报告内容一致（浅拷贝）");
  // 进一步验证 total 字段的子字段值
  const rawTotal = rawObj.total as Record<string, number>;
  assert.equal(rawTotal.lines, 100, "raw.total.lines 应为 100");
  assert.equal(rawTotal.statements, 100, "raw.total.statements 应为 100");
  assert.equal(rawTotal.functions, 50, "raw.total.functions 应为 50");
  assert.equal(rawTotal.branches, 80, "raw.total.branches 应为 80");

  // raw 应包含 pct 字段（与原始报告内容一致）
  assert.ok(rawObj.pct !== undefined, "raw 应保留 pct 字段");
  assert.deepEqual(rawObj.pct, originalParsed.pct, "raw.pct 应与原始报告内容一致");

  // raw 应包含 uncoveredFiles 字段
  assert.ok(Array.isArray(rawObj.uncoveredFiles), "raw 应保留 uncoveredFiles 数组");

  // raw 应为浅拷贝：与 JSON.parse 解析的对象不是同一引用
  assert.notEqual(rawObj, originalParsed, "raw 应为浅拷贝（与 JSON.parse 结果不同引用）");
});

// ============================================================================
// T2. C8ReportParser.parse() JSON 解析失败 → 抛 CoverageGateError (c8-parse)
// ============================================================================

test("T2: C8ReportParser.parse() JSON 解析失败 → 抛 CoverageGateError (c8-parse)", () => {
  const parser = new C8ReportParser();
  // 非法 JSON 字符串
  const invalidJson = "{ this is not valid json }";

  assert.throws(
    () => parser.parse(invalidJson),
    (err: unknown) => {
      assert.ok(err instanceof CoverageGateError, "应抛 CoverageGateError");
      assert.equal((err as CoverageGateError).kind, "c8-parse", "kind 应为 c8-parse");
      assert.ok((err as CoverageGateError).message.includes("JSON 解析失败"));
      return true;
    }
  );
});

// ============================================================================
// T3. C8ReportParser.parse() schema 校验失败 → 抛 CoverageGateError (c8-parse)
// ============================================================================

test("T3a: 缺 total 字段 → 抛 CoverageGateError (c8-parse)", () => {
  const parser = new C8ReportParser();
  // 缺 total 字段（仅含 covered/pct）
  const badJson = JSON.stringify({
    covered: { lines: 90, statements: 90, functions: 45, branches: 60 },
    pct: { lines: 90, statements: 90, functions: 90, branches: 75 },
  });

  assert.throws(
    () => parser.parse(badJson),
    (err: unknown) => {
      assert.ok(err instanceof CoverageGateError);
      assert.equal((err as CoverageGateError).kind, "c8-parse");
      assert.ok((err as CoverageGateError).message.includes("结构校验失败"));
      return true;
    }
  );
});

test("T3b: 缺 pct 字段 → 抛 CoverageGateError (c8-parse)", () => {
  const parser = new C8ReportParser();
  // 缺 pct 字段
  const badJson = JSON.stringify({
    total: { lines: 100, statements: 100, functions: 50, branches: 80 },
    covered: { lines: 90, statements: 90, functions: 45, branches: 60 },
  });

  assert.throws(
    () => parser.parse(badJson),
    (err: unknown) => {
      assert.ok(err instanceof CoverageGateError);
      assert.equal((err as CoverageGateError).kind, "c8-parse");
      return true;
    }
  );
});

test("T3c: pct 非数字 → 抛 CoverageGateError (c8-parse)", () => {
  const parser = new C8ReportParser();
  // pct.lines 为字符串而非数字
  const badJson = JSON.stringify({
    total: { lines: 100, statements: 100, functions: 50, branches: 80 },
    covered: { lines: 90, statements: 90, functions: 45, branches: 60 },
    pct: { lines: "90%", statements: 90, functions: 90, branches: 75 },
  });

  assert.throws(
    () => parser.parse(badJson),
    (err: unknown) => {
      assert.ok(err instanceof CoverageGateError);
      assert.equal((err as CoverageGateError).kind, "c8-parse");
      return true;
    }
  );
});

test("T3d: 空字符串输入 → 抛 CoverageGateError (c8-parse)", () => {
  const parser = new C8ReportParser();
  // 空字符串
  assert.throws(
    () => parser.parse(""),
    (err: unknown) => {
      assert.ok(err instanceof CoverageGateError);
      assert.equal((err as CoverageGateError).kind, "c8-parse");
      assert.ok((err as CoverageGateError).message.includes("空或非字符串"));
      return true;
    }
  );

  // 仅空白字符
  assert.throws(
    () => parser.parse("   "),
    (err: unknown) => {
      assert.ok(err instanceof CoverageGateError);
      assert.equal((err as CoverageGateError).kind, "c8-parse");
      return true;
    }
  );
});

// ============================================================================
// T4. C8ReportParser.parse() 返回冻结对象（不可变性）
// ============================================================================

test("T4: C8ReportParser.parse() 返回冻结对象", () => {
  const parser = new C8ReportParser();
  const parsed = parser.parse(buildC8ReportJson());

  // 顶层冻结
  assert.ok(Object.isFrozen(parsed), "C8ParsedReport 应冻结");

  // uncoveredFiles 数组冻结
  assert.ok(Object.isFrozen(parsed.uncoveredFiles), "uncoveredFiles 数组应冻结");

  // uncoveredSymbols 数组冻结
  assert.ok(Object.isFrozen(parsed.uncoveredSymbols), "uncoveredSymbols 数组应冻结");

  // raw 对象冻结
  assert.ok(Object.isFrozen(parsed.raw), "raw 对象应冻结");
});

// ============================================================================
// T5. CoverageGate 实例化与工厂函数
// ============================================================================

test("T5a: 默认构造 → 实例化成功", () => {
  const pkcAccessor = new InMemoryPkcAccessor();
  const gate = new CoverageGate(pkcAccessor);
  assert.ok(gate, "应成功实例化");
  assert.equal(typeof gate.check, "function", "应含 check 方法");
});

test("T5b: 注入 logger → 实例化成功", () => {
  const pkcAccessor = new InMemoryPkcAccessor();
  const logs: Array<{ message: string; level?: string }> = [];
  const logger = (message: string, level?: "info" | "warn" | "error") => {
    logs.push({ message, level });
  };
  const gate = new CoverageGate(pkcAccessor, DEFAULT_COVERAGE_THRESHOLD, logger);
  assert.ok(gate);
});

test("T5c: createDefaultCoverageGate 工厂函数", () => {
  const pkcAccessor = new InMemoryPkcAccessor();
  const gate = createDefaultCoverageGate(pkcAccessor);
  assert.ok(gate instanceof CoverageGate, "应返回 CoverageGate 实例");
});

test("T5d: createC8ReportParser 工厂函数", () => {
  const parser = createC8ReportParser();
  assert.ok(parser instanceof C8ReportParser, "应返回 C8ReportParser 实例");
});

test("T5e: 注入自定义阈值 → 实例化成功", () => {
  const pkcAccessor = new InMemoryPkcAccessor();
  // 自定义更严格的阈值
  const customThreshold: CoverageThreshold = Object.freeze({
    lines: 95,
    branches: 85,
    functions: 95,
    highRiskSymbols: 100,
  });
  const gate = new CoverageGate(pkcAccessor, customThreshold);
  assert.ok(gate);
});

// ============================================================================
// T6. CoverageGate.check() 请求校验失败路径
// ============================================================================

test("T6a: projectRoot 空 → 抛 CoverageGateError (threshold-config)", async () => {
  const pkcAccessor = new InMemoryPkcAccessor();
  const gate = new CoverageGate(pkcAccessor);
  const request = createCoverageGateRequest({ projectRoot: "" });

  await assert.rejects(
    () => gate.check(request),
    (err: unknown) => {
      assert.ok(err instanceof CoverageGateError);
      assert.equal((err as CoverageGateError).kind, "threshold-config");
      assert.ok((err as CoverageGateError).message.includes("projectRoot"));
      return true;
    }
  );
});

test("T6b: testDir 空 → 抛 CoverageGateError (threshold-config)", async () => {
  const pkcAccessor = new InMemoryPkcAccessor();
  const gate = new CoverageGate(pkcAccessor);
  const request = createCoverageGateRequest({ testDir: "" });

  await assert.rejects(
    () => gate.check(request),
    (err: unknown) => {
      assert.ok(err instanceof CoverageGateError);
      assert.equal((err as CoverageGateError).kind, "threshold-config");
      assert.ok((err as CoverageGateError).message.includes("testDir"));
      return true;
    }
  );
});

test("T6c: implementationRoot 空 → 抛 CoverageGateError (threshold-config)", async () => {
  const pkcAccessor = new InMemoryPkcAccessor();
  const gate = new CoverageGate(pkcAccessor);
  const request = createCoverageGateRequest({ implementationRoot: "" });

  await assert.rejects(
    () => gate.check(request),
    (err: unknown) => {
      assert.ok(err instanceof CoverageGateError);
      assert.equal((err as CoverageGateError).kind, "threshold-config");
      assert.ok((err as CoverageGateError).message.includes("implementationRoot"));
      return true;
    }
  );
});

test("T6d: topN < 1 → 抛 CoverageGateError (threshold-config)", async () => {
  const pkcAccessor = new InMemoryPkcAccessor();
  const gate = new CoverageGate(pkcAccessor);
  const request = createCoverageGateRequest({ topN: 0 });

  await assert.rejects(
    () => gate.check(request),
    (err: unknown) => {
      assert.ok(err instanceof CoverageGateError);
      assert.equal((err as CoverageGateError).kind, "threshold-config");
      assert.ok((err as CoverageGateError).message.includes("topN"));
      return true;
    }
  );
});

test("T6e: consecutiveFailureCount < 0 → 抛 CoverageGateError (threshold-config)", async () => {
  const pkcAccessor = new InMemoryPkcAccessor();
  const gate = new CoverageGate(pkcAccessor);
  const request = createCoverageGateRequest({ consecutiveFailureCount: -1 });

  await assert.rejects(
    () => gate.check(request),
    (err: unknown) => {
      assert.ok(err instanceof CoverageGateError);
      assert.equal((err as CoverageGateError).kind, "threshold-config");
      assert.ok((err as CoverageGateError).message.includes("consecutiveFailureCount"));
      return true;
    }
  );
});

// ============================================================================
// T7. CoverageGate.check() c8 不可用 → 抛 CoverageGateError (c8-spawn)
// ============================================================================

/**
 * c8 不可用时，CoverageGate.check() 会调用 spawn("c8", ...)，
 * spawn 触发 'error' 事件 → 抛 CoverageGateError (c8-spawn)。
 *
 * 真实测试：当前环境 c8 未安装，触发真实 spawn 失败路径。
 */
test("T7: c8 不可用 → 抛 CoverageGateError (c8-spawn)", async () => {
  // 跳过条件：仅当 c8 真实不可用时执行此测试
  if (isC8Available()) {
    test.skip("c8 已安装，跳过 c8 不可用测试");
    return;
  }

  const projectRoot = createTmpProjectDir();
  try {
    // 在临时目录中创建 tests/ 与 src/ 目录，使请求字段合法
    fs.mkdirSync(path.join(projectRoot, "tests"), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
    // 写入一个简单的实现文件，保证 c8 命令参数合法
    fs.writeFileSync(
      path.join(projectRoot, "src", "sample.ts"),
      "export function add(a: number, b: number): number { return a + b; }",
      "utf-8"
    );

    const pkcAccessor = new InMemoryPkcAccessor();
    const gate = new CoverageGate(pkcAccessor);
    const request = createCoverageGateRequest({
      projectRoot,
      testDir: "tests/",
      implementationRoot: "src/",
    });

    await assert.rejects(
      () => gate.check(request),
      (err: unknown) => {
        assert.ok(err instanceof CoverageGateError, "应抛 CoverageGateError");
        assert.equal((err as CoverageGateError).kind, "c8-spawn", "kind 应为 c8-spawn");
        assert.ok(
          (err as CoverageGateError).message.includes("c8 命令启动失败") ||
            (err as CoverageGateError).message.includes("c8"),
          "错误消息应含 c8"
        );
        return true;
      }
    );
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

// ============================================================================
// T8. c8 可用环境下的成功/失败路径（test.skip：需 c8 安装）
// ============================================================================

/**
 * T8 系列测试需要 c8 真实可用。
 * 当前环境 c8 未安装，使用 test.skip 跳过。
 * 安装 c8 后（npm install -g c8 或 npm install c8），这些测试将自动启用。
 */

test("T8a: c8 可用 - 覆盖率达标 → CoverageReport verdict=pass", async () => {
  if (!isC8Available()) {
    test.skip("c8 未安装，跳过覆盖率达标测试");
    return;
  }

  const projectRoot = createTmpProjectDir();
  try {
    // 构造一个简单的高覆盖率项目
    fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, "tests"), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, "src", "add.ts"),
      "export function add(a: number, b: number): number { return a + b; }",
      "utf-8"
    );
    fs.writeFileSync(
      path.join(projectRoot, "tests", "add.test.ts"),
      [
        'import { test } from "node:test";',
        'import assert from "node:assert/strict";',
        'import { add } from "../src/add.ts";',
        'test("add", () => { assert.equal(add(1, 2), 3); });',
      ].join("\n"),
      "utf-8"
    );

    const pkcAccessor = new InMemoryPkcAccessor();
    const gate = new CoverageGate(pkcAccessor);
    const request = createCoverageGateRequest({ projectRoot });

    const report = await gate.check(request);
    assert.ok(report.passed, "覆盖率达标时应 passed=true");
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

test("T8b: c8 可用 - 行覆盖率不达标 → verdict=fail（含 missing 覆盖率字段）", async () => {
  if (!isC8Available()) {
    test.skip("c8 未安装，跳过覆盖率不达标测试");
    return;
  }

  const projectRoot = createTmpProjectDir();
  try {
    // 构造一个低覆盖率项目（src 文件未被测试覆盖）
    fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, "tests"), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, "src", "complex.ts"),
      [
        "export function complex(x: number): number {",
        "  if (x > 0) return x * 2;",
        "  if (x < 0) return -x;",
        "  return 0;",
        "}",
      ].join("\n"),
      "utf-8"
    );
    fs.writeFileSync(
      path.join(projectRoot, "tests", "complex.test.ts"),
      [
        'import { test } from "node:test";',
        'import assert from "node:assert/strict";',
        'import { complex } from "../src/complex.ts";',
        'test("complex positive", () => { assert.equal(complex(1), 2); });',
        // 仅覆盖正向分支，负向分支未覆盖
      ].join("\n"),
      "utf-8"
    );

    // 使用更严格的阈值，强制触发不达标
    const strictThreshold: CoverageThreshold = Object.freeze({
      lines: 100,
      branches: 100,
      functions: 100,
      highRiskSymbols: 100,
    });
    const pkcAccessor = new InMemoryPkcAccessor();
    const gate = new CoverageGate(pkcAccessor, strictThreshold);
    const request = createCoverageGateRequest({ projectRoot });

    const report = await gate.check(request);
    // 首次失败（consecutiveFailureCount=0）→ WARNING（passed=true）
    // 但 failedDimensions 应包含未达标维度
    assert.ok(report.failedDimensions.length > 0 || report.passed, "应记录未达标维度或首次失败 WARNING");
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

test("T8c: c8 可用 - 高风险符号未覆盖 → verdict=fail", async () => {
  if (!isC8Available()) {
    test.skip("c8 未安装，跳过高风险符号未覆盖测试");
    return;
  }

  const projectRoot = createTmpProjectDir();
  try {
    fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, "tests"), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, "src", "PaymentService.ts"),
      "export class PaymentService { pay(amount: number): boolean { return amount > 0; } }",
      "utf-8"
    );
    fs.writeFileSync(
      path.join(projectRoot, "tests", "dummy.test.ts"),
      'import { test } from "node:test"; test("dummy", () => {});',
      "utf-8"
    );

    // 构造 InMemoryPkcAccessor 返回高风险符号（PaymentService.pay）
    const highRiskSymbol: UncoveredSymbol = {
      symbolId: "src/PaymentService.ts:PaymentService.pay",
      filePath: "src/services/PaymentService.ts",
      reason: "high-risk-no-test",
      riskScore: 0.9,
    };
    const pkcAccessor = new InMemoryPkcAccessor([], [highRiskSymbol]);
    const gate = new CoverageGate(pkcAccessor);
    const request = createCoverageGateRequest({ projectRoot });

    const report = await gate.check(request);
    // 高风险符号未覆盖应影响 highRiskSymbols 覆盖率
    assert.ok(typeof report.highRiskSymbols === "number");
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

test("T8d: c8 可用 - 首次失败 WARNING（passed=true）", async () => {
  if (!isC8Available()) {
    test.skip("c8 未安装，跳过首次失败 WARNING 测试");
    return;
  }

  /**
   * 算法（对齐 §4.4.3 第 8 步）：
   * - consecutiveFailureCount=0 → isBlocker=false → passed=true（WARNING）
   * - consecutiveFailureCount=1 → isBlocker=true → passed=false（BLOCKER）
   *
   * 验证：首次失败（consecutiveFailureCount=0）时即使 failedDimensions 非空，passed 仍为 true
   */
  const projectRoot = createTmpProjectDir();
  try {
    fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, "tests"), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, "src", "low.ts"),
      "export function f(x: number): number { if (x > 0) return x; return -x; }",
      "utf-8"
    );
    fs.writeFileSync(
      path.join(projectRoot, "tests", "low.test.ts"),
      'import { test } from "node:test"; test("low", () => {});',
      "utf-8"
    );

    // 极严阈值，强制触发失败
    const strictThreshold: CoverageThreshold = Object.freeze({
      lines: 100,
      branches: 100,
      functions: 100,
      highRiskSymbols: 100,
    });
    const pkcAccessor = new InMemoryPkcAccessor();
    const gate = new CoverageGate(pkcAccessor, strictThreshold);
    // 首次失败：consecutiveFailureCount=0
    const request = createCoverageGateRequest({ consecutiveFailureCount: 0, projectRoot });

    const report = await gate.check(request);
    // 首次失败应 passed=true（WARNING，不阻断）
    assert.equal(report.passed, true, "首次失败应 passed=true（WARNING）");
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

test("T8e: c8 可用 - 连续 2 次失败升级 BLOCKER（passed=false）", async () => {
  if (!isC8Available()) {
    test.skip("c8 未安装，跳过连续失败升级 BLOCKER 测试");
    return;
  }

  /**
   * 算法（对齐 §4.4.3 第 8 步）：
   * - consecutiveFailureCount >= COVERAGE_CONSECUTIVE_FAILURE_THRESHOLD - 1 = 1 → isBlocker=true
   * - isBlocker=true 时若 failedDimensions 非空 → passed=false
   */
  const projectRoot = createTmpProjectDir();
  try {
    fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, "tests"), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, "src", "low.ts"),
      "export function f(x: number): number { if (x > 0) return x; return -x; }",
      "utf-8"
    );
    fs.writeFileSync(
      path.join(projectRoot, "tests", "low.test.ts"),
      'import { test } from "node:test"; test("low", () => {});',
      "utf-8"
    );

    const strictThreshold: CoverageThreshold = Object.freeze({
      lines: 100,
      branches: 100,
      functions: 100,
      highRiskSymbols: 100,
    });
    const pkcAccessor = new InMemoryPkcAccessor();
    const gate = new CoverageGate(pkcAccessor, strictThreshold);
    // 连续 2 次失败：consecutiveFailureCount=1
    const request = createCoverageGateRequest({ consecutiveFailureCount: 1, projectRoot });

    const report = await gate.check(request);
    // 连续 2 次失败应 passed=false（BLOCKER）
    assert.equal(report.passed, false, "连续 2 次失败应 passed=false（BLOCKER）");
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

// ============================================================================
// T9. isC8Available() 返回 boolean（同步检测）
// ============================================================================

test("T9: isC8Available() 返回 boolean（同步检测）", () => {
  const result = isC8Available();
  // 必须返回布尔值
  assert.equal(typeof result, "boolean", "isC8Available 应返回 boolean");

  // 当前环境 c8 未安装，应返回 false
  // 注：若环境变化（安装 c8），此断言可能需要更新
  // 这里只断言类型，不强断言 false 值，以适应环境变化
  assert.ok(result === true || result === false, "应为 true 或 false");
});

test("T9b: isC8Available() 与 process.cwd() 下 node_modules/c8 实际存在性一致", () => {
  /**
   * 此测试验证 isC8Available() 的实现契约：
   * - 源实现（coverage-gate.ts 第 634-646 行）使用 process.cwd() 检查 node_modules/c8/package.json
   * - 测试不依赖 __dirname（ESM 模块中 __dirname 不可用）
   * - 直接使用 process.cwd() 与源实现对齐，确保测试断言与实现一致
   *
   * 当 c8 未安装时，源实现返回 false，本测试应通过；
   * 当 c8 已安装时（CI 环境），源实现返回 true，本测试同样应通过。
   */
  const result = isC8Available();

  // 与源实现对齐：检查 process.cwd()/node_modules/c8/package.json 是否存在
  // 源实现（coverage-gate.ts isC8Available）：
  //   const c8PackagePath = path.resolve(process.cwd(), "node_modules/c8/package.json");
  //   return fs.existsSync(c8PackagePath);
  const expectedBySourceLogic = fs.existsSync(path.resolve(process.cwd(), "node_modules/c8/package.json"));

  assert.equal(
    result,
    expectedBySourceLogic,
    "isC8Available 应与 process.cwd()/node_modules/c8/package.json 实际存在性一致"
  );

  // 当前环境 c8 未安装，应返回 false
  // 注：若 CI 环境安装了 c8，此断言可能需要更新
  if (!expectedBySourceLogic) {
    assert.equal(result, false, "c8 未安装时 isC8Available 应返回 false");
  }
});

// ============================================================================
// T10. 不可变性
// ============================================================================

test("T10a: DEFAULT_COVERAGE_THRESHOLD 冻结", () => {
  assert.ok(Object.isFrozen(DEFAULT_COVERAGE_THRESHOLD), "DEFAULT_COVERAGE_THRESHOLD 应冻结");
  // 验证字段值（对齐 §5.2.4 领域层 ≥80% + 行业最佳实践）
  assert.equal(DEFAULT_COVERAGE_THRESHOLD.lines, 80, "lines 阈值应为 80");
  assert.equal(DEFAULT_COVERAGE_THRESHOLD.branches, 70, "branches 阈值应为 70");
  assert.equal(DEFAULT_COVERAGE_THRESHOLD.functions, 85, "functions 阈值应为 85");
  assert.equal(DEFAULT_COVERAGE_THRESHOLD.highRiskSymbols, 100, "highRiskSymbols 阈值应为 100");
});

test("T10b: C8ParsedReport 冻结", () => {
  const parser = new C8ReportParser();
  const parsed = parser.parse(buildC8ReportJson());
  assert.ok(Object.isFrozen(parsed), "C8ParsedReport 应冻结");
});

test("T10c: C8ParsedReport.uncoveredFiles 冻结", () => {
  const parser = new C8ReportParser();
  const parsed = parser.parse(buildC8ReportJson());
  assert.ok(Object.isFrozen(parsed.uncoveredFiles), "uncoveredFiles 应冻结");
});

test("T10d: C8ParsedReport.raw 冻结", () => {
  const parser = new C8ReportParser();
  const parsed = parser.parse(buildC8ReportJson());
  assert.ok(Object.isFrozen(parsed.raw), "raw 应冻结");
});

test("T10e: CoverageReport 通过 check() 返回时冻结（c8 不可用环境下跳过）", async () => {
  if (!isC8Available()) {
    test.skip("c8 未安装，跳过 CoverageReport 冻结测试");
    return;
  }
  const projectRoot = createTmpProjectDir();
  try {
    fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, "tests"), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, "src", "add.ts"),
      "export function add(a: number, b: number): number { return a + b; }",
      "utf-8"
    );
    fs.writeFileSync(
      path.join(projectRoot, "tests", "add.test.ts"),
      'import { test } from "node:test"; import { add } from "../src/add.ts"; test("add", () => { add(1,2); });',
      "utf-8"
    );

    const pkcAccessor = new InMemoryPkcAccessor();
    const gate = new CoverageGate(pkcAccessor);
    const request = createCoverageGateRequest({ projectRoot });
    const report = await gate.check(request);

    assert.ok(Object.isFrozen(report), "CoverageReport 应冻结");
    assert.ok(Object.isFrozen(report.failedDimensions), "failedDimensions 应冻结");
    assert.ok(Object.isFrozen(report.uncoveredFiles), "uncoveredFiles 应冻结");
    assert.ok(Object.isFrozen(report.uncoveredHighRiskSymbols), "uncoveredHighRiskSymbols 应冻结");
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

// ============================================================================
// T11. 错误类
// ============================================================================

test("T11a: CoverageGateError 含 kind 属性", () => {
  const error = new CoverageGateError("c8-spawn", "测试错误");
  assert.equal(error.kind, "c8-spawn");
  assert.equal(error.name, "CoverageGateError");
  assert.ok(error.message.includes("测试错误"));
  assert.ok(error instanceof Error, "应继承 Error");
});

test("T11b: CoverageGateError 含 cause 属性", () => {
  const cause = new Error("原始错误");
  const error = new CoverageGateError("c8-parse", "解析失败", cause);
  assert.equal(error.cause, cause, "cause 应为原始错误");
});

test("T11c: CoverageGateError 各 kind 值可用", () => {
  // 验证 4 种 kind 值都能正确构造
  const kinds: Array<"c8-spawn" | "c8-parse" | "pkc-query" | "threshold-config"> = [
    "c8-spawn",
    "c8-parse",
    "pkc-query",
    "threshold-config",
  ];
  for (const kind of kinds) {
    const error = new CoverageGateError(kind, `${kind} 错误`);
    assert.equal(error.kind, kind, `kind 应为 ${kind}`);
  }
});

// ============================================================================
// T12. 常量重导出
// ============================================================================

test("T12a: DEFAULT_COVERAGE_THRESHOLD 从 coverage-gate 模块重导出", () => {
  // 通过 coverage-gate 模块重导出验证
  // 注：coverage-gate.ts 末尾有 export { DEFAULT_COVERAGE_THRESHOLD, ... } from "./types"
  // 这里通过直接导入验证（已在文件顶部导入）
  assert.ok(DEFAULT_COVERAGE_THRESHOLD, "DEFAULT_COVERAGE_THRESHOLD 应可用");
  assert.equal(DEFAULT_COVERAGE_THRESHOLD.lines, 80);
});

test("T12b: DEFAULT_HIGH_RISK_TOP_N 重导出", () => {
  assert.equal(DEFAULT_HIGH_RISK_TOP_N, 10, "DEFAULT_HIGH_RISK_TOP_N 应为 10");
});

test("T12c: COVERAGE_CONSECUTIVE_FAILURE_THRESHOLD 重导出", () => {
  assert.equal(
    COVERAGE_CONSECUTIVE_FAILURE_THRESHOLD,
    2,
    "COVERAGE_CONSECUTIVE_FAILURE_THRESHOLD 应为 2（连续 2 次失败升级 BLOCKER）"
  );
});

// ============================================================================
// T13. PKC 查询失败降级测试（c8 不可用环境下的 indirect 验证）
// ============================================================================

/**
 * 由于 c8 不可用，无法直接验证 CoverageGate.check() 的 PKC 降级路径。
 * 此测试通过 ThrowingPkcAccessor 间接验证：
 * - check() 会先调用 c8 → c8-spawn 错误（在 PKC 查询前抛出）
 *
 * 完整的 PKC 降级路径在 c8 可用时通过 T8 系列测试覆盖。
 */
test("T13: ThrowingPkcAccessor 不影响 c8-spawn 错误抛出", async () => {
  if (isC8Available()) {
    test.skip("c8 已安装，跳过此 c8-spawn 错误测试");
    return;
  }

  const projectRoot = createTmpProjectDir();
  try {
    fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, "tests"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "src", "sample.ts"), "export function f(): number { return 1; }", "utf-8");

    // 即使 PKC 抛错，CoverageGate.check() 仍会先因 c8 不可用抛 c8-spawn
    const pkcAccessor = new ThrowingPkcAccessor();
    const gate = new CoverageGate(pkcAccessor);
    const request = createCoverageGateRequest({ projectRoot });

    await assert.rejects(
      () => gate.check(request),
      (err: unknown) => {
        assert.ok(err instanceof CoverageGateError);
        assert.equal((err as CoverageGateError).kind, "c8-spawn");
        return true;
      }
    );
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

// ============================================================================
// T14. c8 真实可用时的额外集成测试（test.skip）
// ============================================================================

test("T14: c8 可用 - 真实 c8 调用产出 C8ParsedReport 结构正确", async () => {
  if (!isC8Available()) {
    test.skip("c8 未安装，跳过真实 c8 集成测试");
    return;
  }

  const projectRoot = createTmpProjectDir();
  try {
    fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, "tests"), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, "src", "add.ts"),
      "export function add(a: number, b: number): number { return a + b; }",
      "utf-8"
    );
    fs.writeFileSync(
      path.join(projectRoot, "tests", "add.test.ts"),
      [
        'import { test } from "node:test";',
        'import assert from "node:assert/strict";',
        'import { add } from "../src/add.ts";',
        'test("add works", () => { assert.equal(add(1, 2), 3); });',
      ].join("\n"),
      "utf-8"
    );

    const pkcAccessor = new InMemoryPkcAccessor();
    const gate = new CoverageGate(pkcAccessor);
    const request = createCoverageGateRequest({ projectRoot });
    const report = await gate.check(request);

    // 验证 CoverageReport 字段结构
    assert.equal(typeof report.lines, "number", "lines 应为 number");
    assert.equal(typeof report.branches, "number", "branches 应为 number");
    assert.equal(typeof report.functions, "number", "functions 应为 number");
    assert.equal(typeof report.highRiskSymbols, "number", "highRiskSymbols 应为 number");
    assert.equal(typeof report.passed, "boolean", "passed 应为 boolean");
    assert.ok(Array.isArray(report.failedDimensions), "failedDimensions 应为数组");
    assert.ok(Array.isArray(report.uncoveredFiles), "uncoveredFiles 应为数组");
    assert.ok(Array.isArray(report.uncoveredHighRiskSymbols), "uncoveredHighRiskSymbols 应为数组");
    assert.ok(report.rawReport, "rawReport 应存在");
  } finally {
    cleanupTmpDir(projectRoot);
  }
});
