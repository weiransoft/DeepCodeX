/**
 * RollbackPlanWriter —— 回滚预案 YAML 文件读写器（EAG-P4 批次 14 Phase 3 TASK-14-3-4）
 *
 * 核心职责：
 * - writePlan：将 RollbackPlan 序列化为 YAML 文件（自实现简单 YAML emitter，不依赖外部 yaml 包）
 * - readPlan：从 YAML 文件反序列化为 RollbackPlan 对象（自实现简单 YAML parser）
 * - validatePlanFile：校验文件存在性 + 字段完整性 + steps 非空
 *
 * 设计原则（对齐 P-1~P-11）：
 * - 不可变优先：所有接口字段 readonly，数组 ReadonlyArray<T>，公开常量 Object.freeze，
 *   返回的 RollbackPlan 对象通过 Object.freeze 深冻结
 * - 零新增依赖：仅复用 node:* 内置模块（fs / path），不引入外部 yaml 包
 * - 真实实现：禁止 mock / 占位 / 简化，所有方法真实读写文件系统
 * - 中文详细注释：所有函数与关键逻辑必须有中文 JSDoc
 * - 安全原则：文件权限 0o600（仅 owner 可读写），避免敏感信息泄露
 *
 * YAML 格式设计（与 helm history --output yaml 风格一致）：
 * ```yaml
 * targetVersion: revision-5
 * rollbackCommand: kubectl rollout undo deployment/myapp -n default --to-revision=5
 * resources:
 *   - deployment/myapp
 *   - service/myapp
 * createdAt: 2026-07-21T10:00:00.000Z
 * runId: run-001
 * steps:
 *   - step: 1
 *     action: 执行 kubectl rollout undo
 *     command: kubectl rollout undo deployment/myapp -n default --to-revision=5
 *   - step: 2
 *     action: 等待 rollout 完成
 *     command: kubectl rollout status deployment/myapp -n default
 * ```
 *
 * 与 ROLLBACK_PLAN_SECTIONS（Markdown 5 章节）的关系：
 * - ROLLBACK_PLAN_SECTIONS 是 Markdown 格式回滚预案的章节定义（K-1 决策）
 * - RollbackPlan 是结构化的回滚预案数据，与 ROLLBACK_PLAN_SECTIONS 5 章节对齐：
 *   - targetVersion ↔ "目标版本号"
 *   - rollbackCommand ↔ "回滚命令"
 *   - resources ↔ "资源清单"
 *   - createdAt ↔ "创建时间戳"
 *   - runId ↔ "runId"
 * - steps 是 RollbackPlanWriter 新增的多步骤描述，Markdown 版本通过 generateRollbackPlan 生成单步骤
 *
 * 与 K8sRollbackManager / HelmRollbackManager 的关系：
 * - RollbackPlanWriter 是独立的读写器，不依赖 RollbackManager 实现
 * - K8sRollbackManager / HelmRollbackManager 内部的 generateRollbackPlan 方法生成 Markdown 格式
 * - RollbackPlanWriter 提供 YAML 格式读写能力，供后续 RollbackPlanChecker 校验使用
 *
 * 设计依据：
 * - EAG-P4 批次 14 任务清单 TASK-14-3-4 验收标准
 * - types.ts 中 RollbackPlan / RollbackPlanStep 类型定义
 * - 自实现 YAML emitter/parser（不引入外部 yaml 包，对齐零新增依赖原则）
 *
 * @module eag/devops/rollback-plan-writer
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { RollbackPlan, RollbackPlanStep } from "./types";

// ============================================================================
// 常量定义
// ============================================================================

/**
 * 文件权限：0o600（仅 owner 可读写）
 *
 * 取值理由：
 * - 回滚预案含目标版本号与命令等敏感信息
 * - 限制权限避免其他用户读取或篡改
 * - 与 K8sRollbackManager / HelmRollbackManager 的快照文件权限一致
 */
const FILE_MODE = 0o600;

/**
 * 目录权限：0o700（仅 owner 可访问）
 *
 * 取值理由：
 * - deploy 目录可能包含多个回滚预案文件
 * - 限制目录权限避免其他用户列举文件
 */
const DIR_MODE = 0o700;

/**
 * RollbackPlan 必填字段列表（用于 validatePlanFile 校验）
 *
 * 与 ROLLBACK_PLAN_SECTIONS 5 章节对齐，新增 steps 字段校验：
 * - targetVersion：目标版本号（非空字符串）
 * - rollbackCommand：回滚命令（非空字符串）
 * - resources：资源清单（数组，可为空数组但字段必须存在）
 * - createdAt：创建时间戳（非空字符串）
 * - runId：运行 ID（非空字符串）
 * - steps：回滚步骤列表（数组，必须非空）
 */
const REQUIRED_FIELDS = Object.freeze([
  "targetVersion",
  "rollbackCommand",
  "resources",
  "createdAt",
  "runId",
  "steps",
] as const) as ReadonlyArray<string>;

// ============================================================================
// YAML emitter（自实现，不依赖外部 yaml 包）
// ============================================================================

/**
 * YAML 字符串转义（自实现 emitter 的一部分）
 *
 * 处理规则（参考 YAML 1.2 规范简化版）：
 * - 空字符串：用 `""` 表示
 * - 含特殊字符（: # - [ ] { } , & * ! | > ' " % @ ` 或行首 ! & *）的字符串：用双引号包裹，并转义内部双引号与反斜杠
 * - 纯数字字符串（如 "123"）：用双引号包裹，避免被解析为数字
 * - 布尔值字符串（"true"/"false"/"null"/"yes"/"no"/"on"/"off"）：用双引号包裹，避免被解析为布尔值
 * - 其他字符串：直接输出（无需引号）
 *
 * @param value 待转义的字符串
 * @returns 转义后的 YAML 字符串（可能含双引号包裹）
 */
function escapeYamlString(value: string): string {
  // 空字符串特殊处理
  if (value === "") {
    return '""';
  }

  // 检测纯数字字符串（如 "123" / "1.5" / "-1"），用双引号包裹避免被解析为数字
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }

  // 检测 YAML 保留字（true/false/null/yes/no/on/off 等），用双引号包裹
  const lower = value.toLowerCase();
  if (["true", "false", "null", "yes", "no", "on", "off", "~"].includes(lower)) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }

  // 检测含特殊字符的字符串，需要用双引号包裹
  // 特殊字符列表：冒号后跟空格 / 行首 # / 行首 - / 行首 [ ] { } / 含换行 / 含双引号 / 含反斜杠
  if (
    value.includes(": ") ||
    value.startsWith("#") ||
    value.startsWith("- ") ||
    value.startsWith("[") ||
    value.startsWith("{") ||
    value.startsWith("!") ||
    value.startsWith("&") ||
    value.startsWith("*") ||
    value.startsWith("?") ||
    value.startsWith("|") ||
    value.startsWith(">") ||
    value.startsWith("@") ||
    value.startsWith("`") ||
    value.startsWith('"') ||
    value.startsWith("'") ||
    value.includes("\n") ||
    value.includes("\t") ||
    value.includes("\\") ||
    value.includes(' "') // 含双引号
  ) {
    // 用双引号包裹，转义内部双引号与反斜杠
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }

  // 普通字符串：直接输出
  return value;
}

/**
 * 缩进字符串生成（2 空格缩进）
 *
 * @param level 缩进层级（0=无缩进，1=2 空格，2=4 空格，以此类推）
 * @returns 缩进字符串（如 "    "）
 */
function indentStr(level: number): string {
  return "  ".repeat(level);
}

/**
 * 将 RollbackPlan 序列化为 YAML 字符串（自实现 emitter）
 *
 * 序列化规则：
 * - 顶层字段按固定顺序输出（targetVersion / rollbackCommand / resources / createdAt / runId / steps）
 * - 字符串字段使用 escapeYamlString 转义
 * - resources 数组使用 YAML 列表格式（"  - <value>"）
 * - steps 数组使用 YAML 列表格式，每项含 step / action / command 三个字段
 *
 * @param plan 待序列化的 RollbackPlan 对象
 * @returns YAML 字符串
 */
function serializeRollbackPlanToYaml(plan: RollbackPlan): string {
  const lines: string[] = [];

  // 顶层字段按固定顺序输出（与 ROLLBACK_PLAN_SECTIONS 5 章节对齐 + steps 字段）
  // 1. targetVersion
  lines.push(`targetVersion: ${escapeYamlString(plan.targetVersion)}`);

  // 2. rollbackCommand
  lines.push(`rollbackCommand: ${escapeYamlString(plan.rollbackCommand)}`);

  // 3. resources（数组）
  if (plan.resources.length === 0) {
    // 空数组用 "[]" 表示
    lines.push("resources: []");
  } else {
    lines.push("resources:");
    for (const resource of plan.resources) {
      lines.push(`${indentStr(1)}- ${escapeYamlString(resource)}`);
    }
  }

  // 4. createdAt
  lines.push(`createdAt: ${escapeYamlString(plan.createdAt)}`);

  // 5. runId
  lines.push(`runId: ${escapeYamlString(plan.runId)}`);

  // 6. steps（数组，必须非空）
  if (plan.steps.length === 0) {
    // 空数组用 "[]" 表示（实际 writePlan 会校验非空，此处兜底）
    lines.push("steps: []");
  } else {
    lines.push("steps:");
    for (const step of plan.steps) {
      lines.push(`${indentStr(1)}- step: ${step.step}`);
      lines.push(`${indentStr(2)}action: ${escapeYamlString(step.action)}`);
      lines.push(`${indentStr(2)}command: ${escapeYamlString(step.command)}`);
    }
  }

  // 末尾换行
  return lines.join("\n") + "\n";
}

// ============================================================================
// YAML parser（自实现，不依赖外部 yaml 包）
// ============================================================================

/**
 * YAML 字符串去除引号（自实现 parser 的一部分）
 *
 * 处理规则：
 * - 双引号包裹：去除双引号，反转义 \" 与 \\
 * - 单引号包裹：去除单引号，YAML 单引号字符串中 '' 表示一个单引号
 * - 无引号：直接返回原值
 *
 * @param value 待处理的字符串（可能是 "value" / 'value' / value 三种格式）
 * @returns 去除引号后的字符串
 */
function unescapeYamlString(value: string): string {
  const trimmed = value.trim();

  // 双引号包裹
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    const inner = trimmed.slice(1, -1);
    // 反转义 \" → " 与 \\ → \
    return inner.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }

  // 单引号包裹（YAML 单引号字符串中 '' 表示一个单引号）
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    const inner = trimmed.slice(1, -1);
    return inner.replace(/''/g, "'");
  }

  // 无引号
  return trimmed;
}

/**
 * 解析 YAML 行的 key: value（自实现 parser 的一部分）
 *
 * 匹配规则：
 * - 行格式："key: value" 或 "key:"（值为空）
 * - key 不含冒号
 * - value 可能为空、纯字符串、引号包裹字符串、列表项 "- value"
 *
 * @param line 单行 YAML 内容（如 "targetVersion: revision-5"）
 * @returns 含 key 与 value 的对象；不匹配时返回 null
 */
function parseYamlLine(line: string): { key: string; value: string } | null {
  // 跳过空行与注释
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }

  // 匹配 "key: value" 或 "key:"
  const match = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
  if (!match) {
    return null;
  }

  return {
    key: match[1],
    value: match[2] ?? "",
  };
}

/**
 * 从 YAML 字符串反序列化为 RollbackPlan 对象（自实现 parser）
 *
 * 解析规则（与 serializeRollbackPlanToYaml 对称）：
 * - 按行分割 YAML 字符串
 * - 顶层字段：targetVersion / rollbackCommand / resources / createdAt / runId / steps
 * - resources：解析为字符串数组
 * - steps：解析为 RollbackPlanStep 数组，每项含 step / action / command
 * - 字符串值使用 unescapeYamlString 去除引号
 *
 * 边界场景：
 * - 字段缺失：对应字段使用默认值（targetVersion="" / resources=[] / steps=[] 等）
 * - "resources: []" 解析为空数组
 * - "steps: []" 解析为空数组
 * - 未识别字段：忽略（向前兼容）
 *
 * @param yamlContent YAML 字符串
 * @returns RollbackPlan 对象（被 Object.freeze 冻结）
 */
function deserializeYamlToRollbackPlan(yamlContent: string): RollbackPlan {
  // 初始化字段默认值
  let targetVersion = "";
  let rollbackCommand = "";
  let resources: string[] = [];
  let createdAt = "";
  let runId = "";
  let steps: RollbackPlanStep[] = [];

  const lines = yamlContent.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const parsed = parseYamlLine(line);

    if (!parsed) {
      i++;
      continue;
    }

    const { key, value } = parsed;

    switch (key) {
      case "targetVersion": {
        targetVersion = unescapeYamlString(value);
        i++;
        break;
      }
      case "rollbackCommand": {
        rollbackCommand = unescapeYamlString(value);
        i++;
        break;
      }
      case "createdAt": {
        createdAt = unescapeYamlString(value);
        i++;
        break;
      }
      case "runId": {
        runId = unescapeYamlString(value);
        i++;
        break;
      }
      case "resources": {
        // 解析 resources 数组
        if (value === "[]") {
          // 空数组
          resources = [];
          i++;
        } else {
          // 列表项：后续缩进行 "  - <value>"
          const resourcesList: string[] = [];
          i++;
          while (i < lines.length) {
            const resLine = lines[i];
            // 检测列表项 "  - <value>" 或 "  -<value>"
            const listMatch = resLine.match(/^\s+-\s+(.*)$/);
            if (listMatch) {
              resourcesList.push(unescapeYamlString(listMatch[1]));
              i++;
            } else if (resLine.trim() === "" || resLine.trim().startsWith("#")) {
              // 空行或注释：跳过
              i++;
            } else {
              // 非列表项：resources 数组结束
              break;
            }
          }
          resources = resourcesList;
        }
        break;
      }
      case "steps": {
        // 解析 steps 数组
        if (value === "[]") {
          // 空数组
          steps = [];
          i++;
        } else {
          // 列表项：每个 step 是一个对象
          // 格式：
          //   - step: 1
          //     action: xxx
          //     command: yyy
          const stepsList: RollbackPlanStep[] = [];
          i++;
          while (i < lines.length) {
            const stepLine = lines[i];
            // 检测新 step 项（"  - step: N"）
            const stepMatch = stepLine.match(/^\s+-\s+step:\s*(\d+)\s*$/);
            if (stepMatch) {
              const stepNum = parseInt(stepMatch[1], 10);
              let action = "";
              let command = "";
              i++;

              // 读取 step 的 action 与 command（同为 2 级缩进）
              while (i < lines.length) {
                const attrLine = lines[i];
                // 检测同级属性（4 空格缩进的 "action:" / "command:"）
                const attrMatch = attrLine.match(/^\s{4}(action|command):\s*(.*)$/);
                if (attrMatch) {
                  if (attrMatch[1] === "action") {
                    action = unescapeYamlString(attrMatch[2]);
                  } else if (attrMatch[1] === "command") {
                    command = unescapeYamlString(attrMatch[2]);
                  }
                  i++;
                } else if (attrLine.trim() === "" || attrLine.trim().startsWith("#")) {
                  // 空行或注释：跳过
                  i++;
                } else {
                  // 非属性行：当前 step 项结束
                  break;
                }
              }

              stepsList.push({
                step: stepNum,
                action,
                command,
              });
            } else if (stepLine.trim() === "" || stepLine.trim().startsWith("#")) {
              // 空行或注释：跳过
              i++;
            } else {
              // 非 step 项：steps 数组结束
              break;
            }
          }
          steps = stepsList;
        }
        break;
      }
      default: {
        // 未识别字段：忽略（向前兼容）
        i++;
        break;
      }
    }
  }

  // 构造 RollbackPlan 对象并冻结（不可变优先）
  const plan: RollbackPlan = {
    targetVersion,
    rollbackCommand,
    resources: Object.freeze([...resources]) as ReadonlyArray<string>,
    createdAt,
    runId,
    steps: Object.freeze(
      steps.map((s) => Object.freeze({ ...s }) as RollbackPlanStep)
    ) as ReadonlyArray<RollbackPlanStep>,
  };

  return Object.freeze(plan) as RollbackPlan;
}

// ============================================================================
// RollbackPlanWriter 类
// ============================================================================

/**
 * RollbackPlanWriter 配置选项
 *
 * 字段说明：
 * - projectRoot：项目根目录（可选，用于拼接相对路径；未设置时使用 process.cwd() 兜底）
 *
 * 不可变优先：所有字段 readonly。
 */
export interface RollbackPlanWriterOptions {
  /** 项目根目录（可选，用于拼接相对路径；未设置时使用 process.cwd() 兜底） */
  readonly projectRoot?: string;
}

/**
 * RollbackPlanWriter —— 回滚预案 YAML 文件读写器
 *
 * 提供三个核心方法：
 * - writePlan：将 RollbackPlan 序列化为 YAML 文件（自实现 emitter，不依赖外部 yaml 包）
 * - readPlan：从 YAML 文件反序列化为 RollbackPlan 对象（自实现 parser）
 * - validatePlanFile：校验文件存在性 + 字段完整性 + steps 非空
 *
 * 不可变优先：
 * - 返回的 RollbackPlan 对象通过 Object.freeze 深冻结
 * - 构造函数 Object.freeze 冻结实例，防止运行时修改配置
 * - 所有 readonly 字段
 *
 * 安全原则：
 * - 文件权限 0o600（仅 owner 可读写）
 * - 目录权限 0o700（仅 owner 可访问）
 *
 * 使用方式：
 *   const writer = new RollbackPlanWriter({ projectRoot: "/path/to/project" });
 *   const filePath = await writer.writePlan(plan, "rollback-plan-run-001.yaml");
 *   const readBack = await writer.readPlan(filePath);
 *   const validation = await writer.validatePlanFile(filePath);
 */
export class RollbackPlanWriter {
  /** 项目根目录（用于拼接相对路径；未设置时使用 process.cwd() 兜底） */
  public readonly projectRoot?: string;

  /**
   * 构造函数
   *
   * @param options 配置选项（含可选 projectRoot）
   */
  constructor(options?: RollbackPlanWriterOptions) {
    this.projectRoot = options?.projectRoot;
    // 冻结实例：防止运行时修改配置（对齐 P-1 不可变优先原则）
    Object.freeze(this);
  }

  /**
   * 将 RollbackPlan 序列化为 YAML 文件
   *
   * 执行流程：
   * 1. 校验 plan.steps 非空（steps 是回滚预案的核心，必须至少有 1 个步骤）
   * 2. 校验必填字段非空（targetVersion / rollbackCommand / createdAt / runId）
   * 3. 解析文件路径（相对路径基于 projectRoot 解析）
   * 4. 创建父目录（recursive: true，mode 0o700）
   * 5. 调用 serializeRollbackPlanToYaml 序列化为 YAML 字符串
   * 6. 写入文件（mode 0o600，避免敏感信息泄露）
   * 7. 返回文件绝对路径
   *
   * 错误处理：
   * - plan.steps 为空：抛出 Error（steps 是回滚预案的核心）
   * - plan 必填字段为空：抛出 Error（字段完整性校验）
   * - 文件写入失败：抛出 Error（含文件路径与原始错误信息）
   *
   * @param plan 待序列化的 RollbackPlan 对象
   * @param filePath 文件路径（绝对路径或相对路径；相对路径基于 projectRoot 解析）
   * @returns 文件绝对路径
   * @throws Error 当 plan.steps 为空、必填字段为空、或文件写入失败时抛出
   */
  async writePlan(plan: RollbackPlan, filePath: string): Promise<string> {
    // ---------- 步骤 1: 校验 plan.steps 非空 ----------
    if (!plan.steps || plan.steps.length === 0) {
      throw new Error(`RollbackPlan.steps 不能为空：回滚预案必须至少包含 1 个步骤（plan.runId=${plan.runId}）`);
    }

    // ---------- 步骤 2: 校验必填字段非空 ----------
    const fieldErrors: string[] = [];
    if (!plan.targetVersion) {
      fieldErrors.push("targetVersion 不能为空");
    }
    if (!plan.rollbackCommand) {
      fieldErrors.push("rollbackCommand 不能为空");
    }
    if (!plan.createdAt) {
      fieldErrors.push("createdAt 不能为空");
    }
    if (!plan.runId) {
      fieldErrors.push("runId 不能为空");
    }
    if (fieldErrors.length > 0) {
      throw new Error(`RollbackPlan 必填字段校验失败：${fieldErrors.join("； ")}`);
    }

    // ---------- 步骤 3: 解析文件路径 ----------
    // 相对路径基于 projectRoot 解析；projectRoot 未设置时使用 process.cwd() 兜底
    const baseDir = this.projectRoot ?? process.cwd();
    const absoluteFilePath = path.isAbsolute(filePath) ? filePath : path.resolve(baseDir, filePath);

    // ---------- 步骤 4: 创建父目录 ----------
    const parentDir = path.dirname(absoluteFilePath);
    try {
      fs.mkdirSync(parentDir, { recursive: true, mode: DIR_MODE });
    } catch (err) {
      throw new Error(`创建回滚预案文件父目录失败：${parentDir}（${(err as Error).message}）`);
    }

    // ---------- 步骤 5: 序列化为 YAML 字符串 ----------
    const yamlContent = serializeRollbackPlanToYaml(plan);

    // ---------- 步骤 6: 写入文件 ----------
    try {
      fs.writeFileSync(absoluteFilePath, yamlContent, {
        encoding: "utf8",
        mode: FILE_MODE,
      });
    } catch (err) {
      throw new Error(`写入回滚预案文件失败：${absoluteFilePath}（${(err as Error).message}）`);
    }

    // ---------- 步骤 7: 返回文件绝对路径 ----------
    return absoluteFilePath;
  }

  /**
   * 从 YAML 文件反序列化为 RollbackPlan 对象
   *
   * 执行流程：
   * 1. 解析文件路径（相对路径基于 projectRoot 解析）
   * 2. 读取文件内容（utf8 编码）
   * 3. 调用 deserializeYamlToRollbackPlan 反序列化为 RollbackPlan 对象
   * 4. 返回 RollbackPlan 对象（被 Object.freeze 冻结）
   *
   * 错误处理：
   * - 文件不存在：抛出 Error（含文件路径）
   * - 文件读取失败：抛出 Error（含文件路径与原始错误信息）
   * - YAML 解析失败：不抛异常，缺失字段使用默认值（向前兼容）
   *
   * @param filePath 文件路径（绝对路径或相对路径；相对路径基于 projectRoot 解析）
   * @returns RollbackPlan 对象，被 Object.freeze 冻结
   * @throws Error 当文件不存在或读取失败时抛出
   */
  async readPlan(filePath: string): Promise<RollbackPlan> {
    // ---------- 步骤 1: 解析文件路径 ----------
    const baseDir = this.projectRoot ?? process.cwd();
    const absoluteFilePath = path.isAbsolute(filePath) ? filePath : path.resolve(baseDir, filePath);

    // ---------- 步骤 2: 读取文件内容 ----------
    let yamlContent: string;
    try {
      yamlContent = fs.readFileSync(absoluteFilePath, { encoding: "utf8" });
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === "ENOENT") {
        // 文件不存在：抛出明确的错误
        throw new Error(`回滚预案文件不存在：${absoluteFilePath}`);
      }
      // 其他读取错误：抛出含原始错误信息的 Error
      throw new Error(`读取回滚预案文件失败：${absoluteFilePath}（${error.message}）`);
    }

    // ---------- 步骤 3: 反序列化为 RollbackPlan 对象 ----------
    const plan = deserializeYamlToRollbackPlan(yamlContent);

    // ---------- 步骤 4: 返回 RollbackPlan 对象（已冻结） ----------
    return plan;
  }

  /**
   * 校验回滚预案文件存在性 + 字段完整性 + steps 非空
   *
   * 执行流程：
   * 1. 解析文件路径（相对路径基于 projectRoot 解析）
   * 2. 校验文件存在性（fs.existsSync）
   * 3. 文件不存在时返回 { exists: false, valid: false, failures: [...] }
   * 4. 文件存在时读取并解析为 RollbackPlan
   * 5. 校验必填字段完整性（targetVersion / rollbackCommand / resources / createdAt / runId / steps）
   * 6. 校验 steps 非空
   * 7. 返回校验结果（含 exists / valid / failures 字段）
   *
   * 校验规则：
   * - 文件不存在：exists=false, valid=false, failures=["文件不存在：<path>"]
   * - 文件存在但字段缺失：exists=true, valid=false, failures 含缺失字段列表
   * - 文件存在但 steps 为空：exists=true, valid=false, failures=["steps 不能为空"]
   * - 全部校验通过：exists=true, valid=true, failures=[]
   *
   * @param filePath 文件路径（绝对路径或相对路径；相对路径基于 projectRoot 解析）
   * @returns 校验结果，被 Object.freeze 冻结
   */
  async validatePlanFile(filePath: string): Promise<{
    readonly exists: boolean;
    readonly valid: boolean;
    readonly filePath: string;
    readonly failures: ReadonlyArray<string>;
  }> {
    // ---------- 步骤 1: 解析文件路径 ----------
    const baseDir = this.projectRoot ?? process.cwd();
    const absoluteFilePath = path.isAbsolute(filePath) ? filePath : path.resolve(baseDir, filePath);

    // ---------- 步骤 2: 校验文件存在性 ----------
    if (!fs.existsSync(absoluteFilePath)) {
      // 文件不存在：返回校验失败结果
      return Object.freeze({
        exists: false,
        valid: false,
        filePath: absoluteFilePath,
        failures: Object.freeze([`回滚预案文件不存在：${absoluteFilePath}`]) as ReadonlyArray<string>,
      });
    }

    // ---------- 步骤 3: 读取并解析文件 ----------
    let plan: RollbackPlan;
    try {
      const yamlContent = fs.readFileSync(absoluteFilePath, { encoding: "utf8" });
      plan = deserializeYamlToRollbackPlan(yamlContent);
    } catch (err) {
      // 文件读取或解析失败：返回校验失败结果
      return Object.freeze({
        exists: true,
        valid: false,
        filePath: absoluteFilePath,
        failures: Object.freeze([`回滚预案文件解析失败：${(err as Error).message}`]) as ReadonlyArray<string>,
      });
    }

    // ---------- 步骤 4: 校验必填字段完整性 ----------
    // 通过 REQUIRED_FIELDS 常量做通用字段存在性循环校验（字段必须在 plan 对象上存在）
    const failures: string[] = [];
    const planRecord = plan as unknown as Record<string, unknown>;
    for (const field of REQUIRED_FIELDS) {
      if (!(field in planRecord)) {
        failures.push(`${field} 字段缺失`);
      }
    }

    // 校验每个必填字段的具体值
    if (!plan.targetVersion) {
      failures.push("targetVersion 字段为空");
    }
    if (!plan.rollbackCommand) {
      failures.push("rollbackCommand 字段为空");
    }
    // resources 字段必须存在（数组，可为空数组但字段必须存在）
    // 由于 deserializeYamlToRollbackPlan 总是返回 resources 数组（默认空数组），
    // 此处无需检查字段存在性，只需检查数组是否被正确解析（始终为 true）
    if (!Array.isArray(plan.resources)) {
      failures.push("resources 字段非数组");
    }
    if (!plan.createdAt) {
      failures.push("createdAt 字段为空");
    }
    if (!plan.runId) {
      failures.push("runId 字段为空");
    }
    // steps 字段必须存在且为非空数组
    if (!Array.isArray(plan.steps)) {
      failures.push("steps 字段非数组");
    } else if (plan.steps.length === 0) {
      failures.push("steps 字段为空数组，回滚预案必须至少包含 1 个步骤");
    }

    // ---------- 步骤 5: 返回校验结果 ----------
    const isValid = failures.length === 0;
    return Object.freeze({
      exists: true,
      valid: isValid,
      filePath: absoluteFilePath,
      failures: Object.freeze(failures) as ReadonlyArray<string>,
    });
  }
}
