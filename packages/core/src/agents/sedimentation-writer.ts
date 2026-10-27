/**
 * SedimentationWriter —— 沉淀物落盘器（T02，架构 §3）
 *
 * 职责：用户确认沉淀建议后，把草稿安全落盘为 SKILL.md（可被 SkillManager 现扫发现）。
 *
 * Q5 安全门槛（五条，全部有单测覆盖）：
 * 1. 仅接受 Draft 白名单字段（kind/name/description/role/content），其余一律丢弃；
 * 2. name 必须过 kebab-case（^[a-z0-9]+(?:-[a-z0-9]+)*$）；
 * 3. 目标目录限定 <home>/.deepcode/skills/<name>/（scope=user）或
 *    <projectRoot>/.deepcode/skills/<name>/（scope=project），resolve 后必须位于根内
 *    （路径牢笼防穿越；牢笼校验先于 kebab 校验执行，保证任何输入都先过牢笼）；
 * 4. 同名 SKILL.md 已存在 → duplicate-name 拒写（P1-3 再做修订草稿）；
 * 5. 全程 try/catch，io-error 不抛出、仅结构化日志，落盘失败绝不上抛中断会话。
 *
 * @module agents/sedimentation-writer
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import matter from "gray-matter";
import type { SedimentLogFn } from "../common/sediment-logger";

/** agent/skill 名称统一 kebab-case 校验（架构 §7 共享知识 #1） */
const KEBAB_CASE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 沉淀范围：user = ~/.deepcode/skills（默认），project = <projectRoot>/.deepcode/skills */
export type SedimentationScope = "user" | "project";

/** 沉淀草稿（LLM 产出 → 用户确认 → 本写入器落盘） */
export type SedimentationDraft = {
  /** 条目种类：skill 或 agent */
  kind: "skill" | "agent";
  /** 名称（kebab-case，落盘目录名） */
  name: string;
  /** 描述（必填非空，写入 frontmatter） */
  description: string;
  /** 角色身份（kind==="agent" 时必填，写入 frontmatter） */
  role?: string;
  /** Markdown 正文（SKILL.md frontmatter 之后的内容） */
  content: string;
};

/** 落盘结果（成功带路径；失败带中文原因，绝不抛出） */
export type WriteResult =
  | { ok: true; path: string }
  | {
      ok: false;
      reason: "invalid-name" | "invalid-frontmatter" | "path-escapes-root" | "duplicate-name" | "io-error";
      message: string;
    };

/** SedimentationWriter 依赖上下文（架构 §3 构造签名） */
export interface SedimentationWriterDeps {
  /** 项目根目录（scope=project 时落盘根） */
  projectRoot: string;
  /** 可选：结构化日志函数（缺省 console.warn 兜底；禁止打印对话原文与 PII） */
  log?: SedimentLogFn;
}

/**
 * SedimentationWriter —— 沉淀物落盘器
 */
export class SedimentationWriter {
  private readonly deps: SedimentationWriterDeps;
  private readonly log: SedimentLogFn;

  constructor(deps: SedimentationWriterDeps) {
    this.deps = deps;
    this.log =
      deps.log ??
      ((event) => {
        const message = typeof event.message === "string" ? event.message : JSON.stringify(event);
        console.warn(`[sedimentation-writer] ${message}`);
      });
  }

  /**
   * 安全落盘（五条安全门槛见文件头注释）。
   *
   * @param draft 沉淀草稿（额外未知字段一律丢弃）
   * @param scope 落盘范围（user / project）
   * @returns WriteResult（失败不抛出）
   */
  async write(draft: SedimentationDraft, scope: SedimentationScope): Promise<WriteResult> {
    try {
      // 门槛 1：白名单字段重构（未知字段丢弃，不进落盘文件）
      const safeDraft = this.pickWhitelist(draft);
      // 基本校验：description 必填非空；kind=agent 时 role 必填
      if (!safeDraft) {
        return {
          ok: false,
          reason: "invalid-frontmatter",
          message: "沉淀草稿非法：kind 必须为 skill 或 agent，description 必填非空",
        };
      }
      if (!safeDraft.description) {
        return {
          ok: false,
          reason: "invalid-frontmatter",
          message: "沉淀草稿非法：description 必填且不能为空",
        };
      }
      if (safeDraft.kind === "agent" && !safeDraft.role) {
        return {
          ok: false,
          reason: "invalid-frontmatter",
          message: "沉淀草稿非法：kind 为 agent 时 role 必填",
        };
      }
      if (scope !== "user" && scope !== "project") {
        return {
          ok: false,
          reason: "invalid-frontmatter",
          message: "沉淀落盘范围非法：scope 必须为 user 或 project",
        };
      }

      // 门槛 3（先于 kebab）：路径牢笼——resolve 后必须位于声明的扫描根内（防路径穿越）
      const rootDir = this.resolveScopeRoot(scope);
      const resolvedRoot = path.resolve(rootDir);
      const targetDir = path.resolve(resolvedRoot, safeDraft.name);
      if (targetDir !== resolvedRoot && !targetDir.startsWith(`${resolvedRoot}${path.sep}`)) {
        this.log({
          event: "sediment-write-rejected",
          reason: "path-escapes-root",
          name: safeDraft.name,
          message: `沉淀落盘被拒绝：目标路径越出牢笼（name「${safeDraft.name}」解析后不在 ${scope} 扫描根内）`,
        });
        return {
          ok: false,
          reason: "path-escapes-root",
          message: `沉淀落盘被拒绝：目标路径越出 ${scope} 扫描根（防路径穿越）`,
        };
      }

      // 门槛 2：kebab-case 校验
      if (!KEBAB_CASE_PATTERN.test(safeDraft.name)) {
        this.log({
          event: "sediment-write-rejected",
          reason: "invalid-name",
          name: safeDraft.name,
          message: `沉淀落盘被拒绝：name「${safeDraft.name}」必须为 kebab-case（小写字母/数字/连字符）`,
        });
        return {
          ok: false,
          reason: "invalid-name",
          message: "沉淀落盘被拒绝：name 必须为 kebab-case（小写字母/数字/连字符）",
        };
      }

      // 门槛 4：同名拒写（P1-3 再做修订草稿）
      const targetFile = path.join(targetDir, "SKILL.md");
      if (fs.existsSync(targetFile)) {
        this.log({
          event: "sediment-write-rejected",
          reason: "duplicate-name",
          name: safeDraft.name,
          message: `沉淀落盘被拒绝：同名条目已存在（${safeDraft.name}）`,
        });
        return {
          ok: false,
          reason: "duplicate-name",
          message: `沉淀落盘被拒绝：同名条目「${safeDraft.name}」已存在`,
        };
      }

      // 门槛 5：落盘（io 异常全部被外层 catch 捕获，降级为 io-error）
      const fileContent = matter.stringify(safeDraft.content, this.buildFrontmatter(safeDraft));
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(targetFile, fileContent, "utf8");
      this.log({
        event: "sediment-write-ok",
        scope,
        name: safeDraft.name,
        kind: safeDraft.kind,
        message: `沉淀落盘成功：${safeDraft.name} → ${targetFile}`,
      });
      return { ok: true, path: targetFile };
    } catch (error) {
      // 门槛 5：io-error 仅结构化日志，绝不上抛（落盘失败不影响会话）
      const message = error instanceof Error ? error.message : String(error);
      this.log({
        event: "sediment-write-io-error",
        message: `沉淀落盘 IO 失败（已降级，不影响会话）：${message}`,
      });
      return { ok: false, reason: "io-error", message: `沉淀落盘失败：${message}` };
    }
  }

  /**
   * 解析落盘根目录：scope=user → <home>/.deepcode/skills；scope=project → <projectRoot>/.deepcode/skills。
   */
  private resolveScopeRoot(scope: SedimentationScope): string {
    if (scope === "project") {
      return path.join(this.deps.projectRoot, ".deepcode", "skills");
    }
    return path.join(os.homedir(), ".deepcode", "skills");
  }

  /**
   * 白名单字段抽取：仅保留 kind/name/description/role/content，其余一律丢弃。
   *
   * 基本形态非法（draft 非对象 / kind 不合法 / name 非字符串）返回 undefined。
   */
  private pickWhitelist(
    draft: SedimentationDraft
  ): Pick<SedimentationDraft, "kind" | "name" | "description" | "role" | "content"> | undefined {
    if (!draft || typeof draft !== "object") {
      return undefined;
    }
    const kind = (draft as Record<string, unknown>).kind;
    if (kind !== "skill" && kind !== "agent") {
      return undefined;
    }
    const name = typeof draft.name === "string" ? draft.name.trim() : "";
    if (!name) {
      return undefined;
    }
    return {
      kind,
      name,
      description: typeof draft.description === "string" ? draft.description.trim() : "",
      // 仅 kind==="agent" 时保留 role（skill 落盘不写 role 字段）
      role: kind === "agent" && typeof draft.role === "string" && draft.role.trim() ? draft.role.trim() : undefined,
      content: typeof draft.content === "string" ? draft.content : "",
    };
  }

  /**
   * 构造 frontmatter（白名单字段，kind=agent 时含 type/role）。
   */
  private buildFrontmatter(
    safeDraft: NonNullable<ReturnType<SedimentationWriter["pickWhitelist"]>>
  ): Record<string, string> {
    const frontmatter: Record<string, string> = {
      name: safeDraft.name,
      description: safeDraft.description,
    };
    if (safeDraft.kind === "agent" && safeDraft.role) {
      frontmatter.type = "agent";
      frontmatter.role = safeDraft.role;
    }
    return frontmatter;
  }
}
