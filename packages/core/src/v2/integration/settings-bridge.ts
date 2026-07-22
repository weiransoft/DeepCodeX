/**
 * V2 配置四层合并入口（P1-06 修复）
 *
 * 设计依据：V2_CONTEXT_MEMORY_TECH_DESIGN.md §9.4.1 配置合并规范
 *
 * 职责：
 * - 定义 V2Config zod schema（V2 全部配置项的默认值与类型约束）
 * - 实现 mergeV2Config 四层优先级合并函数
 * - 提供深合并语义（对象递归合并、数组整体替换、未知键 strict 拒绝）
 *
 * 四层配置源优先级（低 → 高，高层覆盖低层）：
 *   1. 内置默认值（zod schema .default 值）
 *   2. 用户设置文件（~/.deepcode/settings.json 的 v2 子树）
 *   3. 环境变量（DEEPCODEX_V2_* 前缀，双下划线表达嵌套）
 *   4. CLI 参数（--v2-* 启动参数，点号表达嵌套）
 *
 * 深合并硬规则（§9.4.1）：
 * 1. 对象递归合并：同一路径的对象按 key 逐层下钻合并，仅叶子值被高层覆盖；
 *    低层有而高层缺失的 key 保留低层值（非整体替换对象）；
 * 2. 数组整体替换（非拼接）：同一路径的数组以高层数组整体替换低层数组；
 * 3. 未知键 strict 拒绝：任何配置源出现 schema 未声明的 key，合并即抛 V2ConfigError。
 *
 * @module v2/integration/settings-bridge
 */

import { z } from "zod";

// ============================================================================
// 1. V2Config zod schema 定义（§9.4 V2Config）
// ============================================================================

/**
 * V2 配置 schema
 *
 * 对应 V2_CONTEXT_MEMORY_TECH_DESIGN.md §9.4 的 V2Config 定义。
 * 每个字段均提供 .default()，作为四层合并的第 1 层（内置默认值）。
 *
 * 注意：嵌套对象 schema 使用 .prefault({})（zod 4 语义）：嵌套 key 缺失时
 * 先 parse 空对象，触发内部字段的 .default() 填充，保证嵌套默认值生效。
 * （zod 4 的 .default({}) 在嵌套 key 为 undefined 时会 short-circuit 直接返回 {}，
 * 不会触发内部字段默认值填充，不符合"内置默认值层"语义。）
 *
 * 嵌套 schema 提取说明：
 * 各嵌套配置的所有字段均带 .default()，.prefault({}) 传入空对象即可由运行时
 * 自动填充全部字段，类型安全无需断言（CFG-01~18 测试覆盖）。
 */

/** Diff 增强配置 schema（低风险，默认启用） */
const diffConfigSchema = z.object({
  enabled: z.boolean().default(true),
  colorEnabled: z.boolean().default(true),
  contextLines: z.number().default(3),
  maxDiffLines: z.number().default(500),
  maxFuzz: z.number().default(2),
});

/** Approval Gate 配置 schema（高风险，默认关闭） */
const approvalConfigSchema = z.object({
  enabled: z.boolean().default(false),
  approvalMode: z.enum(["suggest", "auto-approve", "fail-closed"]).default("suggest"),
  appMode: z.enum(["agent", "yolo", "plan"]).default("agent"),
  arityDictionaryPath: z.string().optional(),
});

/** Side-Git 配置 schema（默认启用） */
const sideGitConfigSchema = z.object({
  enabled: z.boolean().default(true),
  autoSnapshot: z.boolean().default(true),
  maxSnapshots: z.number().default(100),
});

/** 双层上下文配置 schema（高风险，默认关闭） */
const contextConfigSchema = z.object({
  enabled: z.boolean().default(false),
  tokenBudget: z.number().default(100000),
  globalTtlMs: z.number().default(30 * 60 * 1000),
  taskTtlMs: z.number().default(10 * 60 * 1000),
  syncIntervalMs: z.number().default(60 * 1000),
  topKFiles: z.number().default(20),
  keepRecentTurns: z.number().default(5),
});

/** CodeMap 配置 schema */
const codemapConfigSchema = z.object({
  autoGenerateOnStartup: z.boolean().default(true),
  incremental: z.boolean().default(true),
  excludeDirs: z.array(z.string()).default(["node_modules", ".git", "dist", "build"]),
  maxFileSizeKb: z.number().default(100),
});

/** 记忆配置 schema */
const memoryConfigSchema = z.object({
  userGlobalEnabled: z.boolean().default(true),
  projectMemoryEnabled: z.boolean().default(true),
  experienceEnabled: z.boolean().default(true),
  maxFacts: z.number().default(100),
  maxExperiences: z.number().default(1000),
  systemPromptInjectionLimit: z.number().default(2000),
});

export const V2Config = z.object({
  /** 是否启用 V2 功能（v2.1 W-09：默认 false，灰度发布） */
  enabled: z.boolean().default(false),

  /** Diff 增强配置（低风险，默认启用） */
  diff: diffConfigSchema.prefault({}),

  /** Approval Gate 配置（高风险，默认关闭） */
  approval: approvalConfigSchema.prefault({}),

  /** Side-Git 配置（默认启用） */
  sideGit: sideGitConfigSchema.prefault({}),

  /** 双层上下文配置（高风险，默认关闭） */
  context: contextConfigSchema.prefault({}),

  /** CodeMap 配置 */
  codemap: codemapConfigSchema.prefault({}),

  /** 记忆配置 */
  memory: memoryConfigSchema.prefault({}),
});

/** V2Config 类型（zod 推导） */
export type V2Config = z.infer<typeof V2Config>;

// ============================================================================
// 2. V2ConfigError 自定义错误
// ============================================================================

/**
 * V2 配置错误
 *
 * 合并过程中遇到未知键 / 类型不匹配 / 非法枚举值时抛出。
 * 错误信息包含键路径与来源层，便于定位配置错误。
 */
export class V2ConfigError extends Error {
  /** 错误发生的键路径（如 "diff.contextLines"） */
  readonly keyPath: string;
  /** 引发错误的配置源层（"userJson" / "env" / "cliArgs" / "default"） */
  readonly sourceLayer: string;

  constructor(message: string, keyPath: string, sourceLayer: string) {
    super(message);
    this.name = "V2ConfigError";
    this.keyPath = keyPath;
    this.sourceLayer = sourceLayer;
  }
}

// ============================================================================
// 3. 辅助函数：点号路径 → 嵌套对象、深合并、未知键检测
// ============================================================================

/**
 * 将点号分隔的路径（如 "diff.contextLines"）转换为嵌套对象
 *
 * @param path 点号分隔的路径
 * @param value 叶子值
 * @returns 嵌套对象（如 { diff: { contextLines: value } }）
 */
function pathToNestedObject(path: string, value: unknown): Record<string, unknown> {
  const keys = path.split(".");
  if (keys.length === 0) {
    return {};
  }
  const result: Record<string, unknown> = {};
  let current: Record<string, unknown> = result;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (key === "") {
      throw new V2ConfigError(`无效路径：${path}（含空段）`, path, "path");
    }
    const next: Record<string, unknown> = {};
    current[key] = next;
    current = next;
  }
  const lastKey = keys[keys.length - 1];
  if (lastKey === "") {
    throw new V2ConfigError(`无效路径：${path}（尾部空段）`, path, "path");
  }
  current[lastKey] = value;
  return result;
}

/**
 * 深合并两个对象（对象递归合并、数组整体替换）
 *
 * 规则：
 * - 同 key 均为对象 → 递归合并
 * - 同 key 均为数组 → high 整体替换 low（非拼接）
 * - 同 key 一方为对象一方为数组 → high 覆盖 low
 * - 同 key 均为叶子值 → high 覆盖 low
 * - low 有而 high 缺失的 key → 保留 low 值
 *
 * @param low 低优先级对象
 * @param high 高优先级对象（覆盖 low）
 * @returns 合并后的新对象（不修改入参）
 */
function deepMerge(low: Record<string, unknown>, high: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...low };
  for (const key of Object.keys(high)) {
    const lowVal = low[key];
    const highVal = high[key];
    if (highVal === undefined) {
      // high 显式传 undefined，视为不覆盖，保留 low 值
      continue;
    }
    if (lowVal === undefined) {
      // low 无此 key，直接取 high
      result[key] = highVal;
      continue;
    }
    // 数组整体替换（非拼接）
    if (Array.isArray(highVal)) {
      result[key] = highVal;
      continue;
    }
    // 对象递归合并
    if (isPlainObject(lowVal) && isPlainObject(highVal)) {
      result[key] = deepMerge(lowVal as Record<string, unknown>, highVal as Record<string, unknown>);
      continue;
    }
    // 叶子值或类型不一致，high 覆盖 low
    result[key] = highVal;
  }
  return result;
}

/**
 * 判断值是否为普通对象（非 null、非数组、非 Date 等）
 *
 * @param value 待判断的值
 * @returns true 表示是普通对象
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return false;
  }
  // 排除 Date / RegExp / Error 等内置对象
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * 从 ZodSchema 中提取 ZodObject（unwrap ZodDefault / ZodOptional / ZodNullable 等包裹）
 *
 * zod 6 中 .default({}) / .optional() / .nullable() 会包裹原 schema，
 * 需要逐层 unwrap 才能获取底层的 ZodObject 以读取其 shape。
 *
 * @param schema 待解包的 ZodSchema
 * @returns 底层的 ZodObject，无法解包时返回 null
 */
function unwrapToObject(schema: unknown): z.ZodObject<z.ZodRawShape> | null {
  let current: unknown = schema;
  // 最多解包 5 层（防止无限循环）
  for (let i = 0; i < 5; i++) {
    if (current instanceof z.ZodObject) {
      return current as z.ZodObject<z.ZodRawShape>;
    }
    // ZodDefault / ZodOptional / ZodNullable 提供 .unwrap() 方法
    const maybeWrapped = current as { unwrap?: () => unknown };
    if (typeof maybeWrapped.unwrap === "function") {
      current = maybeWrapped.unwrap();
      continue;
    }
    return null;
  }
  return null;
}

/**
 * 检测对象中是否存在 schema 未声明的未知键
 *
 * @param schemaShape schema 声明的合法键集合（递归嵌套）
 * @param obj 待检测的对象
 * @param currentPath 当前键路径（递归用，如 "diff"）
 * @param sourceLayer 配置源层（错误信息用）
 * @returns 第一个未知键的路径，无未知键返回 null
 */
function detectUnknownKey(
  schemaShape: z.ZodRawShape,
  obj: Record<string, unknown>,
  currentPath: string,
  sourceLayer: string
): string | null {
  for (const key of Object.keys(obj)) {
    const fullPath = currentPath ? `${currentPath}.${key}` : key;
    const fieldSchema = schemaShape[key];
    if (!fieldSchema) {
      return fullPath;
    }
    // 递归检测嵌套对象（需 unwrap ZodDefault 等包裹获取底层 ZodObject）
    const value = obj[key];
    if (isPlainObject(value)) {
      const objectSchema = unwrapToObject(fieldSchema);
      if (objectSchema !== null) {
        const nested = detectUnknownKey(objectSchema.shape, value as Record<string, unknown>, fullPath, sourceLayer);
        if (nested !== null) {
          return nested;
        }
      }
    }
  }
  return null;
}

// ============================================================================
// 4. 环境变量解析（DEEPCODEX_V2_* 前缀）
// ============================================================================

/** 环境变量前缀（双下划线表达嵌套） */
const ENV_PREFIX = "DEEPCODEX_V2_";
/** 环境变量嵌套分隔符 */
const ENV_SEPARATOR = "__";

/**
 * 将环境变量名中的下划线分隔段转换为小驼峰
 *
 * 例：
 *   "CONTEXT_LINES" → "contextLines"
 *   "DIFF"          → "diff"
 *   "MAX_DIFF_LINES" → "maxDiffLines"
 *
 * 算法：按 "_" 分割为单词，第一个单词全小写，后续单词首字母大写其余小写。
 *
 * @param part 环境变量名段（已转小写前的原始形式）
 * @returns 小驼峰形式
 */
function envSegmentToCamel(part: string): string {
  const words = part.toLowerCase().split("_");
  return words
    .map((word, idx) => {
      if (idx === 0) {
        return word;
      }
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join("");
}

/**
 * 将 DEEPCODEX_V2_* 环境变量解析为嵌套对象
 *
 * 规则：
 * - 前缀 DEEPCODEX_V2_ 去除
 * - 双下划线 __ 转为点号 .（嵌套路径）
 * - 单下划线 _ 在段内分隔单词，转为小驼峰（如 CONTEXT_LINES → contextLines）
 * - 值尝试解析为 JSON，失败则视为字符串
 *
 * 示例：
 *   DEEPCODEX_V2_DIFF__CONTEXT_LINES=7 → { diff: { contextLines: 7 } }
 *   DEEPCODEX_V2_ENABLED=true          → { enabled: true }
 *   DEEPCODEX_V2_MEMORY__MAX_FACTS=300 → { memory: { maxFacts: 300 } }
 *
 * @param env 环境变量键值对（已过滤非 V2 前缀）
 * @returns 嵌套对象
 */
function parseEnvVars(env: Record<string, string>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const envKey of Object.keys(env)) {
    if (!envKey.startsWith(ENV_PREFIX)) {
      continue;
    }
    const stripped = envKey.slice(ENV_PREFIX.length);
    if (stripped === "") {
      continue;
    }
    // 双下划线分隔嵌套层级；每段单独转小驼峰
    const pathParts = stripped.split(ENV_SEPARATOR);
    const camelPath = pathParts.map(envSegmentToCamel).join(".");
    const rawValue = env[envKey];
    // 尝试 JSON 解析（支持 true/false/数字/JSON 字符串）
    let parsedValue: unknown = rawValue;
    try {
      parsedValue = JSON.parse(rawValue);
    } catch {
      // 非 JSON 字符串，保留原值
      parsedValue = rawValue;
    }
    const nested = pathToNestedObject(camelPath, parsedValue);
    Object.assign(result, deepMerge(result, nested));
  }
  return result;
}

// ============================================================================
// 5. CLI 参数解析（--v2-* 参数）
// ============================================================================

/**
 * 将 CLI --v2-* 参数键值对解析为嵌套对象
 *
 * 规则：
 * - 键已是点号分隔路径（如 "diff.contextLines"）
 * - 值尝试解析为 JSON，失败则视为字符串
 *
 * 示例：
 *   { "diff.contextLines": 9 } → { diff: { contextLines: 9 } }
 *
 * @param cliArgs CLI 参数键值对
 * @returns 嵌套对象
 */
function parseCliArgs(cliArgs: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(cliArgs)) {
    if (key === "" || key === undefined) {
      continue;
    }
    const value = cliArgs[key];
    if (value === undefined) {
      continue;
    }
    const nested = pathToNestedObject(key, value);
    Object.assign(result, deepMerge(result, nested));
  }
  return result;
}

// ============================================================================
// 6. mergeV2Config 主函数
// ============================================================================

/**
 * V2 配置四层合并入口（P1-06）
 *
 * 按 §9.4.1 优先级表从低到高依次叠加：
 *   内置默认（V2Config schema 的 .default 值）
 *   → settings.json 的 v2 子树
 *   → DEEPCODEX_V2_* 环境变量映射结果
 *   → CLI --v2-* 参数映射结果
 *
 * 深合并语义：对象递归合并、数组整体替换、未知键 strict 拒绝（抛 V2ConfigError）。
 * 合并完成后经 V2Config.parse() 做 zod 类型校验（类型错误同样抛 V2ConfigError，
 * 附 zod issue 路径），保证返回对象一定是完整合法的 V2Config。
 *
 * @param userJson  settings.json 的 v2 字段子树（无 v2 字段时传 {}）
 * @param env       DEEPCODEX_V2_* 环境变量键值对（已过滤非 V2 前缀；
 *                  嵌套路径以双下划线分隔，如 DEEPCODEX_V2_DIFF__CONTEXT_LINES）
 * @param cliArgs   CLI --v2-* 参数键值对（嵌套路径以点号分隔，如 { "diff.contextLines": 9 }）
 * @returns 合并并校验通过的完整 V2Config
 * @throws V2ConfigError 未知键 / 类型不匹配 / 非法枚举值（信息含键路径与来源层）
 */
export function mergeV2Config(
  userJson: Record<string, unknown>,
  env: Record<string, string>,
  cliArgs: Record<string, unknown>
): V2Config {
  // 步骤 1：获取内置默认值（第 1 层）
  // V2Config 嵌套 schema 使用 .prefault({})（zod 4 语义）：嵌套 key 缺失时自动
  // 触发内部字段默认值填充。此处显式传入嵌套空对象，与 .prefault 行为一致，
  // 且使"获取默认值"的意图在代码中显式可见。
  const defaultConfig = V2Config.parse({
    diff: {},
    approval: {},
    sideGit: {},
    context: {},
    codemap: {},
    memory: {},
  });

  // 步骤 2：检测 userJson 未知键（第 2 层）
  if (Object.keys(userJson).length > 0) {
    const unknownKey = detectUnknownKey(V2Config.shape, userJson, "", "userJson");
    if (unknownKey !== null) {
      throw new V2ConfigError(
        `未知配置键: "${unknownKey}"（settings.json 的 v2 子树中出现 schema 未声明的 key）`,
        unknownKey,
        "userJson"
      );
    }
  }

  // 步骤 3：解析环境变量（第 3 层）
  const envObj = parseEnvVars(env);
  if (Object.keys(envObj).length > 0) {
    const unknownKey = detectUnknownKey(V2Config.shape, envObj, "", "env");
    if (unknownKey !== null) {
      throw new V2ConfigError(
        `未知配置键: "${unknownKey}"（DEEPCODEX_V2_* 环境变量中出现 schema 未声明的 key）`,
        unknownKey,
        "env"
      );
    }
  }

  // 步骤 4：解析 CLI 参数（第 4 层）
  const cliObj = parseCliArgs(cliArgs);
  if (Object.keys(cliObj).length > 0) {
    const unknownKey = detectUnknownKey(V2Config.shape, cliObj, "", "cliArgs");
    if (unknownKey !== null) {
      throw new V2ConfigError(
        `未知配置键: "${unknownKey}"（CLI --v2-* 参数中出现 schema 未声明的 key）`,
        unknownKey,
        "cliArgs"
      );
    }
  }

  // 步骤 5：四层深合并（默认 → userJson → env → cliArgs）
  let merged: Record<string, unknown> = defaultConfig as Record<string, unknown>;
  merged = deepMerge(merged, userJson);
  merged = deepMerge(merged, envObj);
  merged = deepMerge(merged, cliObj);

  // 步骤 6：zod 类型校验（类型错误同样抛 V2ConfigError）
  const parseResult = V2Config.safeParse(merged);
  if (!parseResult.success) {
    const firstIssue = parseResult.error.issues[0];
    const keyPath = firstIssue.path.join(".");
    const sourceLayer = inferSourceLayer(keyPath, userJson, envObj, cliObj);
    throw new V2ConfigError(`配置类型错误: 键 "${keyPath}" ${firstIssue.message}`, keyPath, sourceLayer);
  }

  return parseResult.data;
}

/**
 * 根据键路径推断错误来源层
 *
 * @param keyPath 错误键路径
 * @param userJson 用户设置
 * @param envObj 环境变量解析结果
 * @param cliObj CLI 参数解析结果
 * @returns 来源层名称
 */
function inferSourceLayer(
  keyPath: string,
  userJson: Record<string, unknown>,
  envObj: Record<string, unknown>,
  cliObj: Record<string, unknown>
): string {
  // 按 CLI → env → userJson 顺序查找（高优先级先查）
  if (hasPath(cliObj, keyPath)) return "cliArgs";
  if (hasPath(envObj, keyPath)) return "env";
  if (hasPath(userJson, keyPath)) return "userJson";
  return "default";
}

/**
 * 检查对象是否包含指定路径的键
 *
 * @param obj 待检查对象
 * @param path 点号分隔的路径
 * @returns true 表示存在
 */
function hasPath(obj: Record<string, unknown>, path: string): boolean {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (!isPlainObject(current)) {
      return false;
    }
    if (!(part in current)) {
      return false;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return true;
}
