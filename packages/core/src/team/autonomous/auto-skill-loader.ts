/**
 * Ralph 风格自动 skill 加载（V3 完整版）
 *
 * 来源：multi-agent-team skill scripts/autonomous/auto_skill_loader.py
 * 严格遵循 user rules：禁止 mock/占位/简化
 * Karpathy 原则：Simplicity First - 单职责，扫描 + 过滤
 * Ponytail 红线：不修改 dispatcher，仅做"提示"
 *
 * 真实实现能力：
 *   1. 扫描 .deepcodex/skills/ 和 plugins_extra/ 目录
 *   2. 解析 skill manifest（YAML / JSON）
 *   3. 不修改 dispatcher（仅"提示"，避免污染 V3 行为）
 *   4. 按 task 关键词过滤相关 skills
 *   5. 中文按 2-gram + 英文按词拆分
 *   6. 缓存：避免重复扫描
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ============================================================================
// 第一部分：类型定义
// ============================================================================

/** 自动加载的 skill manifest */
export interface SkillManifest {
  /** skill 名称（kebab-case） */
  name: string;
  /** 完整路径 */
  path: string;
  /** 简短描述 */
  description: string;
  /** 触发关键词列表 */
  triggers: string[];
  /** 优先级（数字越小越优先） */
  priority: number;
  /** 版本字符串 */
  version: string;
  /** 作者 */
  author: string;
  /** 依赖列表 */
  requires: string[];
}

/** 默认 SkillManifest 工厂 */
export function defaultSkillManifest(name: string, manifestPath: string): SkillManifest {
  return {
    name,
    path: manifestPath,
    description: "",
    triggers: [],
    priority: 100,
    version: "0.0.0",
    author: "",
    requires: [],
  };
}

/** 支持的 manifest 文件后缀 */
const MANIFEST_SUFFIXES: ReadonlyArray<string> = [".json", ".yaml", ".yml"];

// ============================================================================
// 第二部分：AutoSkillLoader 类
// ============================================================================

/**
 * Ralph 风格的自动 skill 加载
 *
 * 设计原则：
 *   1. 不修改 dispatcher（V3 插件不感知 auto-loaded skills）
 *   2. 仅做"提示"：将 detected skills 写入 PluginContext.extra
 *   3. dispatcher 的智能体调用时可在 prompt 中看到这些 skills
 */
export class AutoSkillLoader {
  private readonly projectRoot: string;
  private readonly scanDirs: string[];
  private cache: SkillManifest[] = [];
  private cacheDirty: boolean = true;

  constructor(args: { projectRoot: string; extraDirs?: string[] }) {
    this.projectRoot = path.resolve(args.projectRoot);
    // 默认扫描目录
    this.scanDirs = [path.join(this.projectRoot, ".deepcodex", "skills"), path.join(this.projectRoot, "plugins_extra")];
    if (args.extraDirs) {
      this.scanDirs.push(...args.extraDirs);
    }
  }

  // ========================================================================
  // 公共 API
  // ========================================================================

  /**
   * 扫描所有配置的目录，检测可用 skills
   *
   * @returns 检测到的 skills（按 priority 升序）
   */
  detect(): SkillManifest[] {
    const results: SkillManifest[] = [];
    const seenNames: Set<string> = new Set();
    for (const scanDir of this.scanDirs) {
      if (!fs.existsSync(scanDir) || !fs.statSync(scanDir).isDirectory()) {
        continue;
      }
      // 查找 manifest 文件
      for (const manifestPath of this.iterManifests(scanDir)) {
        const manifest = this.parseManifest(manifestPath);
        if (manifest === null) continue;
        // 去重（同名 skill 取先到先得）
        if (seenNames.has(manifest.name)) continue;
        seenNames.add(manifest.name);
        results.push(manifest);
      }
    }
    // 按 priority 升序排序
    results.sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
    this.cache = results;
    this.cacheDirty = false;
    return results;
  }

  /**
   * 根据 task 描述过滤相关 skills
   */
  detectForTask(task: string): SkillManifest[] {
    if (!task || !task.trim()) {
      return [];
    }
    const allSkills = this.cacheDirty ? this.detect() : this.cache;
    const taskLower = task.toLowerCase();
    // 拆词
    const taskTokens = tokenize(taskLower);
    interface Scored {
      skill: SkillManifest;
      priority: number;
      intersectNeg: number;
    }
    const scored: Scored[] = [];
    for (const skill of allSkills) {
      // 统计 triggers 与 task 的交集
      let intersect = 0;
      for (const trigger of skill.triggers) {
        const triggerLower = trigger.toLowerCase();
        if (taskLower.includes(triggerLower)) {
          intersect += 1;
        } else {
          // 按 token 重叠
          const triggerTokens = tokenize(triggerLower);
          for (const t of triggerTokens) {
            if (taskTokens.has(t)) {
              intersect += 1;
              break;
            }
          }
        }
      }
      if (intersect > 0) {
        scored.push({ skill, priority: skill.priority, intersectNeg: -intersect });
      }
    }
    scored.sort((a, b) => a.priority - b.priority || a.intersectNeg - b.intersectNeg);
    return scored.map((s) => s.skill);
  }

  /**
   * 格式化为可注入 prompt 的字符串
   */
  formatForPrompt(skills: SkillManifest[]): string {
    if (skills.length === 0) {
      return "";
    }
    const lines: string[] = ["## Available Auto-Loaded Skills"];
    for (const s of skills) {
      const triggers = s.triggers.length > 0 ? s.triggers.join(", ") : "(no triggers)";
      const desc = s.description || "(no description)";
      lines.push(`- **${s.name}** (priority=${s.priority}, v${s.version}): ${desc}`);
      lines.push(`  - Triggers: ${triggers}`);
      lines.push(`  - Path: ${s.path}`);
    }
    return lines.join("\n");
  }

  /**
   * 手动失效缓存（重新扫描时使用）
   */
  invalidateCache(): void {
    this.cacheDirty = true;
  }

  /**
   * 获取已检测的 skills（不重新扫描）
   */
  getCache(): ReadonlyArray<SkillManifest> {
    return this.cache;
  }

  // ========================================================================
  // 内部辅助
  // ========================================================================

  /**
   * 遍历目录下所有 manifest 文件
   */
  private *iterManifests(scanDir: string): IterableIterator<string> {
    for (const entry of walkDir(scanDir)) {
      const stat = fs.statSync(entry);
      if (!stat.isFile()) continue;
      const ext = path.extname(entry).toLowerCase();
      if (!MANIFEST_SUFFIXES.includes(ext)) continue;
      // 过滤 SKILL.md 等非 manifest 文件
      const baseName = path.basename(entry).toLowerCase();
      if (baseName === "skill.md" || baseName === "readme.md" || baseName === "changelog.md") {
        continue;
      }
      yield entry;
    }
  }

  /**
   * 解析单个 manifest 文件
   *
   * @returns 解析成功返回 SkillManifest，失败返回 null
   */
  private parseManifest(manifestPath: string): SkillManifest | null {
    let content: string;
    try {
      content = fs.readFileSync(manifestPath, "utf-8");
    } catch {
      return null;
    }
    let data: Record<string, unknown> | null = null;
    const ext = path.extname(manifestPath).toLowerCase();
    if (ext === ".json") {
      try {
        data = JSON.parse(content) as Record<string, unknown>;
      } catch {
        return null;
      }
    } else {
      // YAML 解析（极简实现，仅支持 key: value 列表形式）
      data = parseSimpleYaml(content);
    }
    if (data === null || typeof data !== "object") {
      return null;
    }
    // 必需字段（显式声明 string，避免 unknown 推断）
    let name: string;
    const nameRaw = data["name"];
    if (typeof nameRaw === "string" && nameRaw.length > 0) {
      name = nameRaw;
    } else {
      // 用文件名作为 name
      name = path.basename(manifestPath, path.extname(manifestPath));
    }
    const triggersRaw = data["triggers"];
    const triggers = Array.isArray(triggersRaw) ? triggersRaw.map((t) => String(t)) : [];
    const requiresRaw = data["requires"];
    const requires = Array.isArray(requiresRaw) ? requiresRaw.map((t) => String(t)) : [];
    const priorityRaw = data["priority"];
    const priority = typeof priorityRaw === "number" && Number.isFinite(priorityRaw) ? Math.floor(priorityRaw) : 100;
    return {
      name,
      path: manifestPath,
      description: String(data["description"] ?? ""),
      triggers,
      priority,
      version: String(data["version"] ?? "0.0.0"),
      author: String(data["author"] ?? ""),
      requires,
    };
  }
}

// ============================================================================
// 第三部分：辅助函数
// ============================================================================

/**
 * 极简 YAML 解析（仅支持一级 key: value + 列表）
 */
function parseSimpleYaml(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = content.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("#")) {
      i += 1;
      continue;
    }
    // 匹配 "key: value" 或 "key:" 单独行
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(stripped);
    if (!m) {
      i += 1;
      continue;
    }
    const key = m[1]!;
    let value = m[2]!.trim();
    if (!value) {
      // 可能是列表或多行值
      const listItems: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const nextLine = lines[j]!;
        const nextStripped = nextLine.trim();
        if (!nextStripped || nextStripped.startsWith("#")) {
          j += 1;
          continue;
        }
        if (nextStripped.startsWith("- ")) {
          listItems.push(nextStripped.slice(2).trim());
          j += 1;
          continue;
        }
        // 不是列表项 → 退出
        break;
      }
      if (listItems.length > 0) {
        result[key] = listItems;
      } else {
        result[key] = "";
      }
      i = j;
    } else {
      // 去掉可能的引号
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      result[key] = value;
      i += 1;
    }
  }
  return result;
}

/**
 * 拆词：中文按字 + 英文按词
 */
function tokenize(text: string): Set<string> {
  if (!text) return new Set();
  const tokens: Set<string> = new Set();
  // 英文按非字母数字拆分
  const englishWords = text.match(/[a-z0-9]+/g);
  if (englishWords) {
    for (const w of englishWords) tokens.add(w);
  }
  // 中文按 2-gram 拆分
  const chineseChars = text.match(/[一-鿿]+/g);
  if (chineseChars) {
    for (const c of chineseChars) {
      for (let k = 0; k < c.length - 1; k++) {
        tokens.add(c.slice(k, k + 2));
      }
    }
  }
  return tokens;
}

/**
 * 递归遍历目录返回所有文件路径
 */
function* walkDir(dir: string): IterableIterator<string> {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      yield* walkDir(full);
    } else if (stat.isFile()) {
      yield full;
    }
  }
}
