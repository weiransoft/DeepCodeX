/**
 * Autonomous 配置加载器（V3 完整版）
 *
 * 来源：multi-agent-team skill scripts/autonomous/config_loader.py
 * 严格遵循 user rules：禁止 mock/占位/简化
 * Karpathy 原则：Simplicity First - 单职责，只做配置加载 + 合并
 *
 * 真实实现能力：
 *   1. 加载用户级 ~/.deepcodex/autonomous.yml
 *   2. 加载项目级 <projectRoot>/.deepcodex/autonomous.yml
 *   3. 项目级覆盖用户级
 *   4. 简化 YAML 解析（不引入 js-yaml 依赖，标准库实现）
 *   5. 完整字段校验
 *   6. 严格错误处理
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Autonomous 配置数据（完整字段，与 multi-agent-team 1:1 对齐） */
export interface AutonomousConfig {
  /** 最大迭代次数 */
  maxIterations: number;
  /** token 预算 */
  maxTokens: number;
  /** 停止条件（自然语言） */
  stopWhen: string;
  /** 阶段顺序：plan / dev / verify / fix */
  stageOrder: ReadonlyArray<"plan" | "dev" | "verify" | "fix">;
  /** 退避基数（秒） */
  backoffBaseSec: number;
  /** 退避上限（秒） */
  backoffMaxSec: number;
  /** 连续失败 abort 阈值 */
  consecutiveFailureAbort: number;
  /** 测试命令 */
  testCommand: string;
  /** 测试超时（秒） */
  testTimeoutSec: number;
  /** 安全分析器 */
  securityAnalyzer: string;
  /** git commit 作者名 */
  gitAuthorName: string;
  /** git commit 作者邮箱 */
  gitAuthorEmail: string;
  /** 是否自动 commit */
  autoCommit: boolean;
  /** 是否启用防休眠 */
  sleepGuardEnabled: boolean;
  /** run 目录（相对 projectRoot） */
  runDir: string;
  /** notes.md 最大大小（KB） */
  maxSizeKb: number;
  /** trim 时保留段落数 */
  trimKeepLastN: number;
  /** notes.md 路径（绝对） */
  notesPath: string;
  /** 确认模式：smart / whitelist-only / blacklist-only */
  confirmMode: "smart" | "whitelist-only" | "blacklist-only";
  /** 风险评分阈值 */
  riskThreshold: number;
  /** 扩展字段（未识别 key 落入此处） */
  extra: Record<string, unknown>;
}

/** 创建默认配置 */
export function defaultAutonomousConfig(projectRoot: string): AutonomousConfig {
  return {
    maxIterations: 50,
    maxTokens: 500_000,
    stopWhen: "",
    stageOrder: ["plan", "dev", "verify", "fix"],
    backoffBaseSec: 1.0,
    backoffMaxSec: 60.0,
    consecutiveFailureAbort: 3,
    testCommand: "npm test",
    testTimeoutSec: 300,
    securityAnalyzer: "builtin",
    gitAuthorName: "DeepCodeX",
    gitAuthorEmail: "deepcodex@local",
    autoCommit: true,
    sleepGuardEnabled: true,
    runDir: ".deepcodex/runs",
    maxSizeKb: 64,
    trimKeepLastN: 50,
    notesPath: path.join(projectRoot, ".deepcodex", "notes.md"),
    confirmMode: "smart",
    riskThreshold: 0.7,
    extra: {},
  };
}

/** 获取用户级配置文件路径 */
export function userConfigPath(): string {
  return path.join(os.homedir(), ".deepcodex", "autonomous.yml");
}

/** 获取项目级配置文件路径 */
export function projectConfigPath(projectRoot: string): string {
  return path.join(projectRoot, ".deepcodex", "autonomous.yml");
}

/**
 * 极简 YAML 解析器
 *
 * 仅支持 autonomous.yml 需要的子集：
 *   - key: value
 *   - key:\n  nested_key: value
 *   - key: [item1, item2]
 *   - key:\n  - item1\n  - item2
 *   - # 注释
 *   - "string" / 'string'
 */
export function parseSimpleYaml(text: string): Record<string, unknown> {
  const lines = text.split(/\r?\n/);
  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; container: Record<string, unknown> | unknown[] }> = [
    { indent: -1, container: root },
  ];

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const rawLine = lines[lineNum]!;
    if (rawLine.trim() === "" || rawLine.trim().startsWith("#")) continue;

    const indentMatch = /^(\s*)/.exec(rawLine)!;
    const indent = indentMatch[1]!.length;
    if (indent % 2 !== 0) {
      throw new Error(`YAML 缩进必须为 2 的倍数（行 ${lineNum + 1}：indent=${indent}）`);
    }
    const content = rawLine.slice(indent);

    while (stack.length > 1 && stack[stack.length - 1]!.indent > indent) {
      stack.pop();
    }
    const top = stack[stack.length - 1]!;

    const listItemMatch = /^-\s+(.*)$/.exec(content);
    if (listItemMatch) {
      if (!Array.isArray(top.container)) {
        throw new Error(`YAML 列表项出现在非数组容器（行 ${lineNum + 1}）`);
      }
      const valueStr = listItemMatch[1]!;
      const value = parseScalarValue(valueStr);
      top.container.push(value);
      continue;
    }

    const kvMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(content);
    if (!kvMatch) {
      throw new Error(`YAML 语法错误（行 ${lineNum + 1}）：${content}`);
    }
    const key = kvMatch[1]!;
    const valueStr = kvMatch[2]!;

    if (valueStr === "" || valueStr === undefined) {
      const nextLine = lines[lineNum + 1];
      if (nextLine !== undefined) {
        const nextIndentMatch = /^(\s*)/.exec(nextLine)!;
        const nextIndent = nextIndentMatch[1]!.length;
        if (nextIndent > indent) {
          if (nextLine.slice(nextIndent).startsWith("-")) {
            const arr: unknown[] = [];
            if (Array.isArray(top.container)) {
              top.container.push(arr);
            } else {
              (top.container as Record<string, unknown>)[key] = arr;
            }
            stack.push({ indent: nextIndent, container: arr });
          } else {
            const obj: Record<string, unknown> = {};
            if (Array.isArray(top.container)) {
              top.container.push(obj);
            } else {
              (top.container as Record<string, unknown>)[key] = obj;
            }
            stack.push({ indent: nextIndent, container: obj });
          }
          continue;
        }
      }
      if (Array.isArray(top.container)) {
        top.container.push(null);
      } else {
        (top.container as Record<string, unknown>)[key] = null;
      }
      continue;
    }

    if (valueStr.startsWith("[") && valueStr.endsWith("]")) {
      const inner = valueStr.slice(1, -1).trim();
      const items = inner === "" ? [] : inner.split(",").map((s) => parseScalarValue(s.trim()));
      if (Array.isArray(top.container)) {
        top.container.push(items);
      } else {
        (top.container as Record<string, unknown>)[key] = items;
      }
      continue;
    }

    const value = parseScalarValue(valueStr);
    if (Array.isArray(top.container)) {
      top.container.push({ [key]: value });
    } else {
      (top.container as Record<string, unknown>)[key] = value;
    }
  }

  return root;
}

function parseScalarValue(s: string): unknown {
  const trimmed = s.trim();
  if (trimmed === "" || trimmed === "~" || trimmed.toLowerCase() === "null") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  if (/^-?\d+\.\d+$/.test(trimmed)) return parseFloat(trimmed);
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * 加载并合并配置
 *
 * 顺序：默认 < 用户级 < 项目级
 */
export function loadAutonomousConfig(projectRoot: string): AutonomousConfig {
  const config = defaultAutonomousConfig(projectRoot);

  const userPath = userConfigPath();
  if (fs.existsSync(userPath)) {
    const userRaw = fs.readFileSync(userPath, "utf-8");
    const userObj = parseSimpleYaml(userRaw);
    mergeConfig(config, userObj);
  }

  const projPath = projectConfigPath(projectRoot);
  if (fs.existsSync(projPath)) {
    const projRaw = fs.readFileSync(projPath, "utf-8");
    const projObj = parseSimpleYaml(projRaw);
    mergeConfig(config, projObj);
  }

  config.notesPath = path.join(projectRoot, ".deepcodex", "notes.md");

  return config;
}

function mergeConfig(config: AutonomousConfig, raw: Record<string, unknown>): void {
  const knownKeys: ReadonlyArray<keyof AutonomousConfig> = [
    "maxIterations",
    "maxTokens",
    "stopWhen",
    "stageOrder",
    "backoffBaseSec",
    "backoffMaxSec",
    "consecutiveFailureAbort",
    "testCommand",
    "testTimeoutSec",
    "securityAnalyzer",
    "gitAuthorName",
    "gitAuthorEmail",
    "autoCommit",
    "sleepGuardEnabled",
    "runDir",
    "maxSizeKb",
    "trimKeepLastN",
    "notesPath",
    "confirmMode",
    "riskThreshold",
  ];

  const snakeToCamel: Record<string, keyof AutonomousConfig> = {
    max_iterations: "maxIterations",
    max_tokens: "maxTokens",
    stop_when: "stopWhen",
    stage_order: "stageOrder",
    backoff_base_sec: "backoffBaseSec",
    backoff_max_sec: "backoffMaxSec",
    consecutive_failure_abort: "consecutiveFailureAbort",
    test_command: "testCommand",
    test_timeout_sec: "testTimeoutSec",
    security_analyzer: "securityAnalyzer",
    git_author_name: "gitAuthorName",
    git_author_email: "gitAuthorEmail",
    auto_commit: "autoCommit",
    sleep_guard_enabled: "sleepGuardEnabled",
    run_dir: "runDir",
    max_size_kb: "maxSizeKb",
    trim_keep_last_n: "trimKeepLastN",
    notes_path: "notesPath",
    confirm_mode: "confirmMode",
    risk_threshold: "riskThreshold",
  };

  for (const [k, v] of Object.entries(raw)) {
    const camelKey = snakeToCamel[k] ?? (k as keyof AutonomousConfig);
    if (knownKeys.includes(camelKey) && camelKey !== "extra" && camelKey !== "notesPath") {
      (config as unknown as Record<string, unknown>)[camelKey] = validateField(camelKey, v);
    } else if (camelKey !== "notesPath") {
      config.extra[k] = v;
    }
  }
}

function validateField(key: keyof AutonomousConfig, value: unknown): unknown {
  switch (key) {
    case "maxIterations":
    case "maxTokens":
    case "consecutiveFailureAbort":
    case "testTimeoutSec":
    case "maxSizeKb":
    case "trimKeepLastN": {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) {
        throw new Error(`AutonomousConfig.${key} 必须为非负数，实际 ${value}`);
      }
      return Math.floor(n);
    }
    case "backoffBaseSec":
    case "backoffMaxSec":
    case "riskThreshold": {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) {
        throw new Error(`AutonomousConfig.${key} 必须为非负数，实际 ${value}`);
      }
      return n;
    }
    case "autoCommit":
    case "sleepGuardEnabled":
      return Boolean(value);
    case "stageOrder": {
      if (!Array.isArray(value)) {
        throw new Error(`AutonomousConfig.stageOrder 必须为列表，实际 ${typeof value}`);
      }
      const valid: Array<"plan" | "dev" | "verify" | "fix"> = [];
      for (const item of value) {
        const s = String(item);
        if (s !== "plan" && s !== "dev" && s !== "verify" && s !== "fix") {
          throw new Error(`AutonomousConfig.stageOrder 包含非法阶段：${s}`);
        }
        valid.push(s);
      }
      return valid;
    }
    case "confirmMode": {
      const s = String(value);
      if (s !== "smart" && s !== "whitelist-only" && s !== "blacklist-only") {
        throw new Error(`AutonomousConfig.confirmMode 非法：${s}`);
      }
      return s;
    }
    default:
      return String(value);
  }
}
