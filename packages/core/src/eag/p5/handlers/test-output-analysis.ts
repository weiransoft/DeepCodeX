/**
 * EAG-P5 测试输出分析（verify 证据构建 + fix 反馈回灌的唯一实现）。
 *
 * 背景（2026-11-03，run b64490b8ad78 事故）：
 * - verify 阶段旧实现只保留测试输出的**前 2000 字符**（head-only 截断），
 *   fix 阶段再从该摘要里取**前 500 字符**拼进 fix 轮提示词；
 * - 而 pytest / unittest / jest / mocha / node --test 的失败详情（FAILED 用例、
 *   断言消息、堆栈、统计汇总）都出现在输出**尾部**；
 * - 结果是 fix 模型只看到"进度点"，拿不到任何失败用例与断言 → 只能凭猜测改动，
 *   与 dev 轮产出相同实现 → 相同测试失败 → 确定性失败熔断（两轮指纹完全一致）。
 *
 * 本模块提供三个纯函数把"测试输出文本"变成"可用证据"：
 * 1. parseTestOutput      —— 多格式 pass/fail/skip 统计（含 node:test、unittest、
 *                            "N failed, M passed" 逆序汇总）；
 * 2. buildTestOutputSummary —— 失败窗口优先的摘要（不再 head-only 丢证据）；
 * 3. extractFailedTestIds —— 失败用例标识清单（供 fix 提示词与最终报告引用）。
 *
 * 设计原则：
 * - 纯函数、零 I/O、零依赖，便于单测与复用；
 * - 全部正则按真实 runner 输出验证（见 packages/core/src/tests/eag-p5-verify-fix-evidence.test.ts）；
 * - 不确定时保守返回 unknown/空数组，绝不臆造计数（诚实降级）。
 *
 * @module eag/p5/handlers/test-output-analysis
 */

// ============================================================================
// 1. 常量与类型
// ============================================================================

/**
 * 测试输出摘要默认最大字符数（与 verify 阶段 CompletionEvidence 的既有上限一致）。
 * 取值 2000：平衡可观测性与日志体积。
 */
export const DEFAULT_SUMMARY_MAX_CHARS = 2000 as const;

/**
 * 失败用例标识默认提取上限（防止超长失败清单淹没 fix 提示词）。
 */
export const DEFAULT_MAX_FAILED_TEST_IDS = 20 as const;

/**
 * 通用汇总解析的尾部窗口大小（字符）。
 *
 * 通用模式（`23 passed, 1 failed`）只在输出尾部此窗口内匹配并取最后一处：
 * 测试输出里可能打印 fixture 文本（本仓库 E2E 用例就打印该串），
 * 全文匹配会让 exitCode=0 的通过轮被误判为失败。
 * 取值 4000：pytest 尾部短摘要 + unittest 失败段通常远小于该值。
 */
const GENERIC_SUMMARY_TAIL_CHARS = 4000 as const;

/** 摘要中"中间省略"标记模板 */
function omitMarker(omittedChars: number): string {
  return `\n...(省略 ${omittedChars} 字符)...\n`;
}

/**
 * 测试结果统计（pass/fail/skip）。
 *
 * 字段语义与 EAG-P5 verify 阶段既有契约保持一致（不可改字段名）。
 */
export interface TestResultStats {
  /** 通过的测试数量 */
  readonly passed: number;
  /** 失败的测试数量 */
  readonly failed: number;
  /** 跳过的测试数量 */
  readonly skipped: number;
  /** 测试总数（passed + failed + skipped） */
  readonly total: number;
  /** 命中的解析器名称（node-test/jest/mocha/unittest/generic-pass-fail/unknown） */
  readonly parser: string;
}

/**
 * 失败用例标识提取结果。
 */
export interface FailedTestIdList {
  /** 失败用例标识（去重保序，最多 max 条） */
  readonly ids: ReadonlyArray<string>;
  /** 实际识别到的失败用例总数（可能大于 ids.length） */
  readonly total: number;
}

// ============================================================================
// 2. 测试结果统计解析
// ============================================================================

/**
 * 解析测试输出（stdout + stderr），提取 pass/fail/skip 统计。
 *
 * 解析顺序为**契约**（命中即返回，顺序不可随意调整）：
 * 1. node:test（`# tests N` / `# pass N` / `# fail N`，容忍 `# suites` 等插入行）
 * 2. Jest（`Tests: 12 passed, 0 failed, 2 skipped`）— e2e N2 断言 parser==="jest"，不可后移
 * 3. Mocha（`12 passing` … `1 failing` … `3 pending`）
 * 4. unittest（`Ran 24 tests` + `FAILED (failures=1)`）
 * 5. Vitest（`Tests  1 failed | 23 passed (24)`，分隔符为 `|` 且无逗号）
 * 6. 通用汇总（`23 passed, 1 failed` / `1 failed, 23 passed`）
 *
 * 通用汇总只在**输出尾部 4KB** 内、取**最后一处**匹配：
 * 测试输出里常出现 fixture 文本（例如本仓库大量用例打印 `1 failed, 23 passed`），
 * 全文匹配会把 exitCode=0 的通过轮误判为失败（架构评审 B6/T5）。
 *
 * 全部不命中 → unknown(0/0/0)，由调用方按"无测试可跑/未验证"处理。
 *
 * @param stdout 标准输出
 * @param stderr 标准错误（部分 runner 输出到 stderr，合并解析）
 * @returns 冻结的测试统计
 */
export function parseTestOutput(stdout: string, stderr: string): TestResultStats {
  const output = `${stdout}\n${stderr}`;
  // 汇总类模式只看尾部窗口：测试输出里可能打印 fixture 文本，全文匹配会误判
  const tail = output.slice(Math.max(0, output.length - GENERIC_SUMMARY_TAIL_CHARS));

  // 1. node:test 汇总块：三行 # tests / # pass / # fail 之间允许 # suites、
  //    # cancelled、# todo 等行插入（真实 TAP 输出必然含 # suites 0）。
  //    三个计数分别独立匹配，兼容"三行"与"单行紧凑"两种排布。
  const nodeTests = /#\s*tests\s+(\d+)/i.exec(output);
  const nodePass = /#\s*pass(?:ed)?\s+(\d+)/i.exec(output);
  const nodeFail = /#\s*fail(?:ed)?\s+(\d+)/i.exec(output);
  if (nodeTests && nodePass && nodeFail) {
    const passed = parseIntOrZero(nodePass[1]);
    const failed = parseIntOrZero(nodeFail[1]);
    const skipped = parseIntOrZero(/#\s*(?:skipped|skip)\s+(\d+)/i.exec(output)?.[1]);
    return freezeStats(passed, failed, skipped, "node-test");
  }

  // 2. Jest：`Tests: 12 passed, 0 failed, 2 skipped` / `Tests: 1 failed, 23 passed, 24 total`
  //    （jest 的失败用例汇总也是 "Tests:" 前缀，必须先于通用分支）
  const jestMatch = /Tests:\s+(\d+)\s+passed(?:,\s+(\d+)\s+failed)?(?:,\s+(\d+)\s+(?:skipped|todo|skipping))?/i.exec(
    tail
  );
  if (jestMatch) {
    return freezeStats(
      parseIntOrZero(jestMatch[1]),
      parseIntOrZero(jestMatch[2]),
      parseIntOrZero(jestMatch[3]),
      "jest"
    );
  }
  const jestFailedFirst = /Tests:\s+(\d+)\s+failed(?:,\s*(\d+)\s+passed)?/i.exec(tail);
  if (jestFailedFirst) {
    // 失败用例数与通过数同时给出时才能确定统计；只有 "Tests: 1 failed" 时通过数未知，
    // 保守按 0 处理并由调用方用退出码裁定（不臆造 passed）
    return freezeStats(parseIntOrZero(jestFailedFirst[2]), parseIntOrZero(jestFailedFirst[1]), 0, "jest-failed-first");
  }

  // 3. Mocha：`12 passing (34ms)` … `1 failing` … `3 pending`
  //    （全部通过时没有 failing 行，故 failing/pending 都是可选）
  const mochaPass = /(\d+)\s+passing\b/i.exec(tail);
  if (mochaPass) {
    const failed = parseIntOrZero(/(\d+)\s+failing\b/i.exec(tail)?.[1]);
    const skipped = parseIntOrZero(/(\d+)\s+pending\b/i.exec(tail)?.[1]);
    return freezeStats(parseIntOrZero(mochaPass[1]), failed, skipped, "mocha");
  }

  // 4. unittest：`Ran 24 tests in 0.85s` + `FAILED (failures=1, errors=0)`
  //    passed = ran - failed（unittest 不单独打印 passed 计数）
  const unittestRan = /Ran\s+(\d+)\s+tests?\s+in\s+/i.exec(tail);
  if (unittestRan) {
    const ran = parseIntOrZero(unittestRan[1]);
    const failedMatch = /FAILED\s*\(([^)]*)\)/i.exec(tail);
    let failed = 0;
    if (failedMatch) {
      failed += parseIntOrZero(/failures\s*=\s*(\d+)/i.exec(failedMatch[1])?.[1]);
      failed += parseIntOrZero(/errors\s*=\s*(\d+)/i.exec(failedMatch[1])?.[1]);
    }
    const passed = Math.max(0, ran - failed);
    return freezeStats(passed, failed, 0, "unittest");
  }

  // 5. Vitest：`Tests  1 failed | 23 passed (24)`（`|` 分隔、无逗号）
  const vitestMatch = /Tests\s+(\d+)\s+failed\s*\|\s*(\d+)\s+passed/i.exec(tail);
  if (vitestMatch) {
    return freezeStats(parseIntOrZero(vitestMatch[2]), parseIntOrZero(vitestMatch[1]), 0, "vitest");
  }
  const vitestPassFirst = /Tests\s+(\d+)\s+passed\s*\|\s*(\d+)\s+failed/i.exec(tail);
  if (vitestPassFirst) {
    return freezeStats(parseIntOrZero(vitestPassFirst[1]), parseIntOrZero(vitestPassFirst[2]), 0, "vitest");
  }

  // 6. 通用汇总：只在尾部窗口内取最后一处匹配（防 fixture 文本误判，架构评审 B6/T5）

  // 6a. 逆序：`1 failed, 23 passed`（pytest 汇总常见顺序；必须先于正序尝试，
  //     否则正序正则会先命中后面的 "23 passed" 并把 failed 解析成 0）
  const failedFirst = lastMatch(/(\d+)\s+failed\s*,\s*(\d+)\s+passed/i, tail);
  if (failedFirst) {
    return freezeStats(parseIntOrZero(failedFirst[2]), parseIntOrZero(failedFirst[1]), 0, "generic-failed-first");
  }

  // 6b. 正序：`23 passed, 1 failed` / `23 passed`
  const passedFirst = lastMatch(/(\d+)\s+passed(?:,\s*(\d+)\s+failed)?(?:,\s*(\d+)\s+(?:skipped|pending))?/i, tail);
  if (passedFirst) {
    return freezeStats(
      parseIntOrZero(passedFirst[1]),
      parseIntOrZero(passedFirst[2]),
      parseIntOrZero(passedFirst[3]),
      "generic-pass-fail"
    );
  }

  return freezeStats(0, 0, 0, "unknown");
}

/**
 * 在同一段文本中找**最后一处**正则匹配（通用汇总必须取最后一次，避免把早期
 * 打印的 fixture 文本当成最终统计）。
 *
 * @param pattern 非全局正则
 * @param text 搜索范围
 * @returns 最后一处匹配；无匹配返回 null
 */
function lastMatch(pattern: RegExp, text: string): RegExpExecArray | null {
  const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  let last: RegExpExecArray | null = null;
  let current = global.exec(text);
  while (current !== null) {
    last = current;
    current = global.exec(text);
  }
  return last;
}

/**
 * 构造冻结的测试统计对象。
 *
 * @param passed 通过数
 * @param failed 失败数
 * @param skipped 跳过数
 * @param parser 解析器名称
 * @returns 冻结对象
 */
function freezeStats(passed: number, failed: number, skipped: number, parser: string): TestResultStats {
  return Object.freeze({
    passed,
    failed,
    skipped,
    total: passed + failed + skipped,
    parser,
  });
}

/**
 * 安全解析整数（解析失败返回 0）。
 *
 * @param value 待解析的字符串（可能为 undefined）
 * @returns 解析后的整数，或 0
 */
function parseIntOrZero(value: string | undefined): number {
  if (!value) return 0;
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? 0 : n;
}

// ============================================================================
// 3. 失败窗口优先的输出摘要
// ============================================================================

/**
 * 强失败标记（失败段起始形态明确，几乎不会误命中）。
 */
const STRONG_FAILURE_MARKERS: ReadonlyArray<RegExp> = Object.freeze([
  /^=+\s*FAILURES\s*=+$/m,
  /^=+\s*ERRORS\s*=+$/m,
  /^FAILED\s+\S+/m,
  /^(?:FAIL|ERROR):\s+\S+/m,
  /^not ok\s+\d+/m,
  /^\s*✕\s+\S/m,
  /^\s*●\s+\S/m,
  /^Traceback \(most recent call last\)/m,
]);

/**
 * 弱失败标记（形态通用，可能出现在堆栈/正文中，仅在强标记全不命中时兜底）。
 */
const WEAK_FAILURE_MARKERS: ReadonlyArray<RegExp> = Object.freeze([/^\s*\d+\)\s+\S/m]);

/**
 * 定位输出中第一个失败标记的下标（先强标记后弱标记；无标记返回 -1）。
 *
 * @param output 合并后的测试输出
 * @returns 失败标记起始下标；无标记返回 -1
 */
function findFailureIndex(output: string): number {
  const strong = findEarliest(output, STRONG_FAILURE_MARKERS);
  if (strong >= 0) return strong;
  return findEarliest(output, WEAK_FAILURE_MARKERS);
}

/**
 * 在一组正则中找出最早出现的匹配下标。
 *
 * @param output 合并后的测试输出
 * @param markers 正则列表
 * @returns 最早下标；全部未命中返回 -1
 */
function findEarliest(output: string, markers: ReadonlyArray<RegExp>): number {
  let earliest = -1;
  for (const marker of markers) {
    const match = marker.exec(output);
    if (match === null) continue;
    const index = match.index;
    if (index >= 0 && (earliest < 0 || index < earliest)) {
      earliest = index;
    }
  }
  return earliest;
}

/**
 * 构建"失败窗口优先"的测试输出摘要。
 *
 * 短输出（≤ maxChars）原样返回；长输出按以下顺序拼装，保证失败证据不丢：
 * 1. 头部上下文（runner 头信息、命令回显）——固定小额预算；
 * 2. 失败窗口（从第一个失败标记前 200 字符开始）——主要预算；
 * 3. 尾部统计段（`1 failed, 23 passed in 0.85s`、`# fail 1` 等）——固定预算。
 * 找不到失败标记时退化为"头 45% + 尾 55%"。所有拼接处标注省略字符数。
 *
 * @param output 合并后的测试输出（stdout + stderr）
 * @param maxChars 摘要最大字符数（默认 2000）
 * @returns 摘要字符串（长度 ≤ maxChars）
 */
export function buildTestOutputSummary(output: string, maxChars: number = DEFAULT_SUMMARY_MAX_CHARS): string {
  if (!output) return "";
  if (output.length <= maxChars) return output;

  // 预算过小时不做分段（无意义的碎块），直接取头部
  if (maxChars < 400) return output.slice(0, maxChars);

  const headBudget = Math.min(240, Math.floor(maxChars * 0.15));
  const tailBudget = Math.min(600, Math.floor(maxChars * 0.35));
  // 两处省略标记各预留 32 字符（形如 "\n...(省略 12345 字符)...\n"）
  const separatorReserve = 64;
  const windowBudget = maxChars - headBudget - tailBudget - separatorReserve;

  const failureIndex = windowBudget > 0 ? findFailureIndex(output) : -1;

  if (failureIndex < 0) {
    // 无失败标记：头部 + 尾部各取一部分，保留统计与退出信息
    // （预算先扣除省略标记的预留空间，保证最终长度 ≤ maxChars）
    const usable = maxChars - separatorReserve;
    const head = output.slice(0, Math.floor(usable * 0.45));
    const tail = output.slice(output.length - Math.floor(usable * 0.55));
    const omitted = output.length - head.length - tail.length;
    if (omitted <= 0) return output.slice(0, maxChars);
    const assembled = `${head}${omitMarker(omitted)}${tail}`;
    return assembled.length <= maxChars ? assembled : assembled.slice(0, maxChars);
  }

  // 失败窗口：从失败标记前 200 字符开始，长度受 windowBudget 约束。
  // 若窗口起点落在头部预算内，则放弃头部片段（避免同一段文本重复出现），
  // 由窗口从 0 开始覆盖头部上下文。
  const rawWindowStart = Math.max(0, failureIndex - 200);
  const useHead = rawWindowStart > headBudget;
  const head = useHead ? output.slice(0, headBudget) : "";
  const windowStart = useHead ? rawWindowStart : 0;
  const windowEnd = Math.min(output.length, windowStart + windowBudget);
  const window = output.slice(windowStart, windowEnd);
  const tailStart = Math.max(windowEnd, output.length - tailBudget);
  const tail = output.slice(tailStart);

  const omittedHead = useHead ? Math.max(0, windowStart - headBudget) : 0;
  const omittedMiddle = Math.max(0, tailStart - windowEnd);

  let result = head;
  if (omittedHead > 0) result += omitMarker(omittedHead);
  result += window;
  if (omittedMiddle > 0) result += omitMarker(omittedMiddle);
  result += tail;

  // 预算已预留分隔符，理论上不会超限；此处做最后兜底，保证契约"≤ maxChars"成立
  return result.length <= maxChars ? result : result.slice(0, maxChars);
}

// ============================================================================
// 4. 失败用例标识提取
// ============================================================================

/**
 * 失败用例标识正则表。
 *
 * 每条规则 [正则, 提取函数]，正则须为全局模式（逐行扫描全部命中）。
 */
interface FailedIdRule {
  readonly pattern: RegExp;
  /** 从正则匹配结果构造用例标识 */
  readonly build: (match: RegExpExecArray) => string;
}

const FAILED_ID_RULES: ReadonlyArray<FailedIdRule> = Object.freeze([
  // pytest：`FAILED tests/test_x.py::test_y - AssertionError: ...`
  // 负向前瞻排除 `FAILED (failures=1)` 这类汇总行（不是用例标识）
  {
    pattern: /^FAILED\s+(?!\()(\S+)/gm,
    build: (m) => m[1] ?? "",
  },
  // unittest：`FAIL: test_y (tests.test_x.TC)` / `ERROR: test_z (tests.test_x.TC)`
  {
    pattern: /^(?:FAIL|ERROR):\s+(\S+)\s+\(([^)]+)\)/gm,
    build: (m) => `${m[2]}.${m[1]}`,
  },
  // jest（verbose）：`  ✕ 用例名` / vitest：`× 用例名` / 失败段标题 `● 用例名`
  {
    pattern: /^\s*✕\s+(.+)$/gm,
    build: (m) => (m[1] ?? "").trim(),
  },
  {
    pattern: /^\s*×\s+(.+)$/gm,
    build: (m) => (m[1] ?? "").trim(),
  },
  {
    pattern: /^\s*●\s+(.+)$/gm,
    build: (m) => (m[1] ?? "").trim(),
  },
  // mocha：`  1) 用例名`
  {
    pattern: /^\s*\d+\)\s+(.+)$/gm,
    build: (m) => (m[1] ?? "").trim(),
  },
  // node TAP：`not ok 3 - 用例名`
  {
    pattern: /^not ok\s+\d+\s+-\s+(.+)$/gm,
    build: (m) => (m[1] ?? "").trim(),
  },
]);

/**
 * 从测试输出中提取失败用例标识（去重保序）。
 *
 * 支持 pytest / unittest / jest / mocha / node TAP 五类标识形态；
 * 提取结果供 fix 提示词（"请优先定位这些用例"）与最终报告（可操作信息）使用。
 *
 * @param output 合并后的测试输出
 * @param max 最多返回条数（默认 20）
 * @returns 失败用例标识列表与识别总数
 */
export function extractFailedTestIds(output: string, max: number = DEFAULT_MAX_FAILED_TEST_IDS): FailedTestIdList {
  if (!output) return Object.freeze({ ids: Object.freeze([]), total: 0 });

  const seen = new Set<string>();
  const ids: string[] = [];

  for (const rule of FAILED_ID_RULES) {
    // 每次调用都复用常量正则：先重置 lastIndex，避免跨调用状态残留
    rule.pattern.lastIndex = 0;
    let match: RegExpExecArray | null = rule.pattern.exec(output);
    while (match !== null) {
      const id = rule.build(match).trim();
      if (id.length > 0 && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
      match = rule.pattern.exec(output);
    }
    rule.pattern.lastIndex = 0;
  }

  return Object.freeze({
    ids: Object.freeze(ids.slice(0, Math.max(0, max))),
    total: ids.length,
  });
}
