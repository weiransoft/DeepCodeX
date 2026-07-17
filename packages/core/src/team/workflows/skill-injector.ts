/**
 * Skill Injector（V3 完整版）
 *
 * 来源：multi-agent-team skill scripts/dynamic_workflow/skill_injector.py
 * 严格遵循 user rules：禁止 mock/占位/简化
 *
 * 核心职责：
 *   1. 扫描 .deepcodex/skills/ 目录
 *   2. 解析 skill manifest（YAML/JSON）
 *   3. 按 task 关键词过滤相关 skills
 *   4. 注入到 context（不修改 dispatcher，仅追加）
 *
 * 设计约束：
 *   - 🔴 不修改 dispatcher：仅在 prompt 中追加 skill 提示
 *   - 🔴 标准库实现：仅使用 fs/path，不引入 yaml 依赖
 *   - 🔴 缓存：避免重复扫描
 */

// 显式 ESM 导入 node:fs 和 node:path，避免在 ESM 模块中使用 require 失败
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";

// ============================================================================
// 类型定义
// ============================================================================

/** 注入的 skill 条目 */
export interface InjectedSkill {
  name: string;
  description: string;
  triggers: string[];
  priority: number;
  version: string;
  manifest_path: string;
}

/** 注入结果 */
export interface InjectResult {
  matched_skills: InjectedSkill[];
  formatted_prompt_section: string;
  /** 触发的总 skill 数（包含被 dedup 的） */
  total_detected: number;
  /** 缓存命中 */
  cache_hit: boolean;
}

/** 默认 InjectResult 工厂 */
export function defaultInjectResult(): InjectResult {
  return {
    matched_skills: [],
    formatted_prompt_section: "",
    total_detected: 0,
    cache_hit: false,
  };
}

// ============================================================================
// 工具函数
// ============================================================================

/** 极简 YAML 解析（仅 key: value） */
function parseSimpleYaml(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = content.split(/\r?\n/);
  let currentListKey: string | null = null;
  for (const raw of lines) {
    const stripped = raw.trim();
    if (!stripped || stripped.startsWith("#")) continue;
    if (stripped.startsWith("- ") && currentListKey !== null) {
      const list = (result[currentListKey] as string[]) ?? [];
      list.push(
        stripped
          .slice(2)
          .trim()
          .replace(/^["']|["']$/g, "")
      );
      result[currentListKey] = list;
      continue;
    }
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(stripped);
    if (m === null) continue;
    const key = m[1]!;
    let value = m[2]!.trim();
    if (!value) {
      // 下一行可能是列表
      currentListKey = key;
      result[key] = [];
      continue;
    }
    currentListKey = null;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/** 中文 2-gram + 英文单词拆分 */
function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  const en = text.toLowerCase().match(/[a-z0-9]+/g);
  if (en !== null) {
    for (const w of en) tokens.add(w);
  }
  const zh = text.match(/[一-鿿]+/g);
  if (zh !== null) {
    for (const s of zh) {
      for (let k = 0; k < s.length - 1; k++) {
        tokens.add(s.slice(k, k + 2));
      }
    }
  }
  return tokens;
}

/** 递归遍历目录返回所有文件路径 */
function* walkDir(dir: string): IterableIterator<string> {
  const fs = nodeFs;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = `${dir}/${entry}`;
    let stat: import("node:fs").Stats;
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

// ============================================================================
// SkillInjector
// ============================================================================

/** SkillInjector 配置 */
export interface SkillInjectorConfig {
  projectRoot: string;
  extraDirs: string[];
  /** manifest 文件后缀 */
  manifestSuffixes: string[];
  /** 跳过的文件名（避免与 SKILL.md 等混淆） */
  skipFileNames: string[];
  /** 最大返回 skills 数 */
  maxMatched: number;
}

export class SkillInjector {
  private readonly config: SkillInjectorConfig;
  private cache: InjectedSkill[] = [];
  private cacheDirty: boolean = true;
  private readonly log: (level: string, message: string) => void;

  constructor(args: {
    projectRoot: string;
    extraDirs?: string[];
    maxMatched?: number;
    log?: (level: string, message: string) => void;
  }) {
    const path = nodePath;
    this.config = {
      projectRoot: path.resolve(args.projectRoot),
      extraDirs: args.extraDirs ?? [],
      manifestSuffixes: [".json", ".yaml", ".yml"],
      skipFileNames: ["skill.md", "readme.md", "changelog.md"],
      maxMatched: args.maxMatched ?? 10,
    };
    this.log =
      args.log ??
      ((l, m) => {
        if (l === "warn" || l === "error") console.warn(`[skill_injector] ${m}`);
      });
  }

  /** 扫描所有配置的目录，检测可用 skills */
  detect(): InjectedSkill[] {
    const fs = nodeFs;
    const path = nodePath;
    const results: InjectedSkill[] = [];
    const seen = new Set<string>();
    const scanDirs = [
      path.join(this.config.projectRoot, ".deepcodex", "skills"),
      path.join(this.config.projectRoot, "plugins_extra"),
      ...this.config.extraDirs,
    ];

    for (const scanDir of scanDirs) {
      if (!fs.existsSync(scanDir) || !fs.statSync(scanDir).isDirectory()) continue;
      for (const manifestPath of this.iterManifests(scanDir)) {
        const skill = this.parseManifest(manifestPath);
        if (skill === null) continue;
        if (seen.has(skill.name)) continue;
        seen.add(skill.name);
        results.push(skill);
      }
    }
    results.sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
    this.cache = results;
    this.cacheDirty = false;
    return results;
  }

  /** 根据 task 关键词过滤相关 skills */
  injectForTask(args: { task: string; maxMatched?: number }): InjectResult {
    if (!args.task || !args.task.trim()) {
      return { ...defaultInjectResult(), cache_hit: !this.cacheDirty };
    }
    const allSkills = this.cacheDirty ? this.detect() : this.cache;
    const taskLower = args.task.toLowerCase();
    const taskTokens = tokenize(taskLower);
    const limit = args.maxMatched ?? this.config.maxMatched;

    interface Scored {
      skill: InjectedSkill;
      priority: number;
      intersectNeg: number;
    }
    const scored: Scored[] = [];
    for (const skill of allSkills) {
      let intersect = 0;
      for (const trigger of skill.triggers) {
        const triggerLower = trigger.toLowerCase();
        if (taskLower.includes(triggerLower)) {
          intersect += 1;
        } else {
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
    const matched = scored.slice(0, limit).map((s) => s.skill);

    return {
      matched_skills: matched,
      formatted_prompt_section: this.formatForPrompt(matched),
      total_detected: allSkills.length,
      cache_hit: !this.cacheDirty,
    };
  }

  /** 格式化为可注入 prompt 的字符串 */
  formatForPrompt(skills: InjectedSkill[]): string {
    if (skills.length === 0) return "";
    const lines: string[] = ["## Auto-Injected Skills"];
    for (const s of skills) {
      const triggers = s.triggers.length > 0 ? s.triggers.join(", ") : "(no triggers)";
      const desc = s.description || "(no description)";
      lines.push(`- **${s.name}** (priority=${s.priority}, v${s.version}): ${desc}`);
      lines.push(`  - Triggers: ${triggers}`);
    }
    return lines.join("\n");
  }

  /** 失效缓存 */
  invalidateCache(): void {
    this.cacheDirty = true;
  }

  /** 获取缓存 */
  getCache(): ReadonlyArray<InjectedSkill> {
    return this.cache;
  }

  // 内部方法
  private *iterManifests(scanDir: string): IterableIterator<string> {
    for (const entry of walkDir(scanDir)) {
      const path = nodePath;
      const ext = path.extname(entry).toLowerCase();
      if (!this.config.manifestSuffixes.includes(ext)) continue;
      const baseName = path.basename(entry).toLowerCase();
      if (this.config.skipFileNames.includes(baseName)) continue;
      yield entry;
    }
  }

  private parseManifest(manifestPath: string): InjectedSkill | null {
    const fs = nodeFs;
    const path = nodePath;
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
      data = parseSimpleYaml(content);
    }
    if (data === null || typeof data !== "object") return null;

    const nameRaw = data["name"];
    const name =
      typeof nameRaw === "string" && nameRaw.length > 0
        ? nameRaw
        : path.basename(manifestPath, path.extname(manifestPath));
    const triggersRaw = data["triggers"];
    const triggers = Array.isArray(triggersRaw) ? triggersRaw.map((t) => String(t)) : [];
    const priorityRaw = data["priority"];
    const priority = typeof priorityRaw === "number" && Number.isFinite(priorityRaw) ? Math.floor(priorityRaw) : 100;
    return {
      name,
      manifest_path: manifestPath,
      description: String(data["description"] ?? ""),
      triggers,
      priority,
      version: String(data["version"] ?? "0.0.0"),
    };
  }
}

/** 创建默认 SkillInjector */
export function createDefaultInjector(args: { projectRoot: string; extraDirs?: string[] }): SkillInjector {
  return new SkillInjector(args);
}
