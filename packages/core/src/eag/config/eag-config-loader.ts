/**
 * EAG 配置文件加载器 —— 从项目级 .deepcode/eag.yml 加载 EAG 引擎配置
 *
 * 本模块实现 `EagConfigLoader` 类，负责从项目根目录下的 `.deepcode/eag.yml`
 * 文件加载 EAG 引擎配置，并与命令行参数合并（命令行参数优先级高于配置文件）。
 *
 * 核心职责：
 * 1. 查找并读取 `.deepcode/eag.yml` 配置文件（YAML 格式）
 * 2. 解析 YAML 内容为 EagConfig 对象
 * 3. 与命令行参数合并（命令行参数优先级更高）
 * 4. 校验配置字段合法性（类型、取值范围）
 * 5. 返回合并后的 EagConfig（不可变，Object.freeze 冻结）
 *
 * 配置优先级（从高到低）：
 * 1. 命令行参数（--max-iterations、--test-command 等）
 * 2. 项目级配置文件（<projectRoot>/.deepcode/eag.yml）
 * 3. 内置默认值（maxIterations=10、testCommand="npm test" 等）
 *
 * 设计约束：
 * - 使用 Node.js 内置模块（不引入新依赖）
 * - YAML 解析使用简单的键值对解析器（不依赖 js-yaml 等外部库）
 * - 配置文件不存在时不抛错，返回空配置（使用默认值）
 * - 配置文件解析失败时记录到 stderr，返回空配置
 * - 所有配置字段校验失败时记录到 stderr，使用默认值
 *
 * @module eag/config/eag-config-loader
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ============================================================================
// 1. EagConfig 配置接口
// ============================================================================

/**
 * EAG 引擎配置接口
 *
 * 字段说明（对齐 AutonomousRunRequest）：
 * - `maxIterations`：最大迭代次数（默认 10，上限 1000）
 * - `testCommand`：测试命令（默认 "npm test"）
 * - `testTimeoutSec`：测试超时秒数（默认 600）
 * - `consecutiveFailureAbort`：连续失败 abort 阈值（默认 3）
 * - `maxTokens`：最大 Token 预算（默认 200000）
 * - `stopWhen`：确定性停止条件（如 "all tests pass"）
 * - `confirmation`：确认模式（smart / always-ask / fail-closed）
 * - `initialLoop`：初始 Loop 类型（默认 "coding"）
 *
 * 设计约束：
 * - 所有字段可选（未提供时使用默认值）
 * - 所有字段 readonly（不可变）
 */
export interface EagConfig {
  /** 最大迭代次数（默认 10，上限 1000） */
  readonly maxIterations?: number;
  /** 测试命令（默认 "npm test"） */
  readonly testCommand?: string;
  /** 测试超时秒数（默认 600） */
  readonly testTimeoutSec?: number;
  /** 连续失败 abort 阈值（默认 3） */
  readonly consecutiveFailureAbort?: number;
  /** 最大 Token 预算（默认 200000） */
  readonly maxTokens?: number;
  /** 确定性停止条件（如 "all tests pass"） */
  readonly stopWhen?: string;
  /** 确认模式（smart / always-ask / fail-closed） */
  readonly confirmation?: "smart" | "always-ask" | "fail-closed";
  /** 初始 Loop 类型（默认 "coding"） */
  readonly initialLoop?: "coding" | "testing" | "reviewing" | "refactoring";
}

// ============================================================================
// 2. EagConfigLoader 类实现
// ============================================================================

/**
 * EAG 配置文件加载器
 *
 * 从项目根目录下的 `.deepcode/eag.yml` 文件加载 EAG 引擎配置。
 *
 * 使用示例：
 * ```typescript
 * const loader = new EagConfigLoader({ projectRoot: "/path/to/project" });
 * const config = loader.load(); // 加载 .deepcode/eag.yml
 * const merged = loader.mergeWithCliArgs(config, { maxIterations: 20 }); // 合并命令行参数
 * ```
 */
export class EagConfigLoader {
  /** 项目根目录 */
  private readonly projectRoot: string;

  /** 配置文件路径（.deepcode/eag.yml） */
  private readonly configPath: string;

  /**
   * 构造 EagConfigLoader
   *
   * @param options 构造选项
   */
  constructor(options: { readonly projectRoot: string }) {
    this.projectRoot = path.resolve(options.projectRoot);
    this.configPath = path.join(this.projectRoot, ".deepcode", "eag.yml");
  }

  // ============================================================================
  // 2.1 load 加载配置文件
  // ============================================================================

  /**
   * 加载配置文件
   *
   * 流程：
   * 1. 检查配置文件是否存在（不存在返回空对象）
   * 2. 读取文件内容
   * 3. 解析 YAML 为 EagConfig（简单的键值对解析）
   * 4. 校验配置字段合法性
   * 5. 返回 EagConfig（Object.freeze 冻结）
   *
   * 错误处理：
   * - 文件不存在返回空对象（不抛错）
   * - 文件读取失败返回空对象（记录到 stderr）
   * - 解析失败返回空对象（记录到 stderr）
   *
   * @returns EagConfig 配置对象（可能为空对象）
   */
  load(): EagConfig {
    try {
      // 1. 检查文件是否存在
      if (!fs.existsSync(this.configPath)) {
        return {};
      }
      // 2. 读取文件内容
      const content = fs.readFileSync(this.configPath, "utf-8");
      // 3. 解析 YAML
      const config = this.parseYaml(content);
      // 4. 校验字段
      return this.validate(config);
    } catch (err) {
      // 加载失败返回空对象
      console.error(
        `[EagConfigLoader] load 失败（configPath=${this.configPath}）：`,
        err instanceof Error ? err.message : String(err)
      );
      return {};
    }
  }

  // ============================================================================
  // 2.2 mergeWithCliArgs 合并命令行参数
  // ============================================================================

  /**
   * 合并配置文件与命令行参数
   *
   * 优先级：命令行参数 > 配置文件 > 默认值
   *
   * 流程：
   * 1. 以配置文件为基础
   * 2. 命令行参数非 undefined 的字段覆盖配置文件
   * 3. 返回合并后的 EagConfig（Object.freeze 冻结）
   *
   * @param fileConfig 配置文件加载的配置
   * @param cliArgs 命令行参数（仅包含用户显式提供的参数）
   * @returns 合并后的 EagConfig
   */
  mergeWithCliArgs(fileConfig: EagConfig, cliArgs: Partial<EagConfig>): EagConfig {
    const merged: EagConfig = {
      maxIterations: cliArgs.maxIterations ?? fileConfig.maxIterations,
      testCommand: cliArgs.testCommand ?? fileConfig.testCommand,
      testTimeoutSec: cliArgs.testTimeoutSec ?? fileConfig.testTimeoutSec,
      consecutiveFailureAbort: cliArgs.consecutiveFailureAbort ?? fileConfig.consecutiveFailureAbort,
      maxTokens: cliArgs.maxTokens ?? fileConfig.maxTokens,
      stopWhen: cliArgs.stopWhen ?? fileConfig.stopWhen,
      confirmation: cliArgs.confirmation ?? fileConfig.confirmation,
      initialLoop: cliArgs.initialLoop ?? fileConfig.initialLoop,
    };
    return Object.freeze(merged);
  }

  // ============================================================================
  // 2.3 内部辅助方法
  // ============================================================================

  /**
   * 解析 YAML 内容为 EagConfig
   *
   * 简单的键值对解析器（不依赖 js-yaml 等外部库）：
   * - 每行一个键值对（key: value）
   * - 忽略注释行（以 # 开头）
   * - 忽略空行
   * - 值类型推断：数字转 number，字符串保持 string
   *
   * @param content YAML 文件内容
   * @returns 解析后的 EagConfig
   */
  private parseYaml(content: string): EagConfig {
    const config: Record<string, unknown> = {};
    const lines = content.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      // 忽略注释行和空行
      if (trimmed === "" || trimmed.startsWith("#")) {
        continue;
      }
      // 解析键值对（key: value）
      const colonIndex = trimmed.indexOf(":");
      if (colonIndex === -1) {
        continue;
      }
      const key = trimmed.slice(0, colonIndex).trim();
      const value = trimmed.slice(colonIndex + 1).trim();
      // 值类型推断
      if (value === "") {
        continue;
      }
      // 数字转 number
      const numValue = Number(value);
      if (!isNaN(numValue) && value !== "") {
        config[key] = numValue;
      } else {
        // 字符串去除引号
        config[key] = value.replace(/^["']|["']$/g, "");
      }
    }
    return config as unknown as EagConfig;
  }

  /**
   * 校验配置字段合法性
   *
   * 校验规则：
   * - maxIterations：正整数，1-1000
   * - testTimeoutSec：正整数
   * - consecutiveFailureAbort：正整数
   * - maxTokens：正整数
   * - confirmation：取值 smart / always-ask / fail-closed
   * - initialLoop：取值 coding / testing / reviewing / refactoring
   *
   * 校验失败时记录到 stderr，并使用 undefined（后续使用默认值）。
   *
   * @param config 待校验的配置
   * @returns 校验后的 EagConfig
   */
  private validate(config: EagConfig): EagConfig {
    const validated: Record<string, unknown> = {};
    // maxIterations：正整数，1-1000
    if (config.maxIterations !== undefined) {
      if (Number.isInteger(config.maxIterations) && config.maxIterations >= 1 && config.maxIterations <= 1000) {
        validated.maxIterations = config.maxIterations;
      } else {
        console.error(
          `[EagConfigLoader] maxIterations 校验失败（期望 1-1000 的整数，实际为 ${config.maxIterations}），使用默认值`
        );
      }
    }
    // testTimeoutSec：正整数
    if (config.testTimeoutSec !== undefined) {
      if (Number.isInteger(config.testTimeoutSec) && config.testTimeoutSec > 0) {
        validated.testTimeoutSec = config.testTimeoutSec;
      } else {
        console.error(
          `[EagConfigLoader] testTimeoutSec 校验失败（期望正整数，实际为 ${config.testTimeoutSec}），使用默认值`
        );
      }
    }
    // consecutiveFailureAbort：正整数
    if (config.consecutiveFailureAbort !== undefined) {
      if (Number.isInteger(config.consecutiveFailureAbort) && config.consecutiveFailureAbort > 0) {
        validated.consecutiveFailureAbort = config.consecutiveFailureAbort;
      } else {
        console.error(
          `[EagConfigLoader] consecutiveFailureAbort 校验失败（期望正整数，实际为 ${config.consecutiveFailureAbort}），使用默认值`
        );
      }
    }
    // maxTokens：正整数
    if (config.maxTokens !== undefined) {
      if (Number.isInteger(config.maxTokens) && config.maxTokens > 0) {
        validated.maxTokens = config.maxTokens;
      } else {
        console.error(`[EagConfigLoader] maxTokens 校验失败（期望正整数，实际为 ${config.maxTokens}），使用默认值`);
      }
    }
    // confirmation：取值 smart / always-ask / fail-closed
    if (config.confirmation !== undefined) {
      const validConfirmations = ["smart", "always-ask", "fail-closed"];
      if (validConfirmations.includes(config.confirmation)) {
        validated.confirmation = config.confirmation;
      } else {
        console.error(
          `[EagConfigLoader] confirmation 校验失败（期望 smart | always-ask | fail-closed，实际为 ${config.confirmation}），使用默认值`
        );
      }
    }
    // initialLoop：取值 coding / testing / reviewing / refactoring
    if (config.initialLoop !== undefined) {
      const validLoops = ["coding", "testing", "reviewing", "refactoring"];
      if (validLoops.includes(config.initialLoop)) {
        validated.initialLoop = config.initialLoop;
      } else {
        console.error(
          `[EagConfigLoader] initialLoop 校验失败（期望 coding | testing | reviewing | refactoring，实际为 ${config.initialLoop}），使用默认值`
        );
      }
    }
    // testCommand：非空字符串
    if (config.testCommand !== undefined) {
      if (typeof config.testCommand === "string" && config.testCommand.length > 0) {
        validated.testCommand = config.testCommand;
      } else {
        console.error(
          `[EagConfigLoader] testCommand 校验失败（期望非空字符串，实际为 ${config.testCommand}），使用默认值`
        );
      }
    }
    // stopWhen：字符串（可为空）
    if (config.stopWhen !== undefined) {
      if (typeof config.stopWhen === "string") {
        validated.stopWhen = config.stopWhen;
      } else {
        console.error(`[EagConfigLoader] stopWhen 校验失败（期望字符串，实际为 ${config.stopWhen}），使用默认值`);
      }
    }
    return Object.freeze(validated as unknown as EagConfig);
  }
}
