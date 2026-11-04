/**
 * 技能页签组件（SettingsDrawer「技能」）：已安装普通技能列表（只读发现）。
 *
 * 列表数据与引擎扫描同源（GET /api/capabilities 中 kind==="skill" 条目，
 * 与 @ 提及补全、system prompt 技能目录一致——「看到的」=「能加载的」）。
 *
 * ## 与「智能体」页签的分工（2026-11-04）
 *
 * 此前「技能」页签渲染的是 capabilities 全量——智能体条目也一并列出，
 * 与「智能体」页签内容重复（同一个 agent 出现在两个页签，用户以为是两拨东西）。
 * 现在两个页签按 `kind` 严格切分：技能页签只列 `kind==="skill"`，
 * 智能体页签只列 `kind==="agent"`，互不重叠。
 *
 * ## 中文展示
 *
 * 技能的技术标识（kebab-case 目录名 / @ 提及 token）保持不动，界面另给：
 * - 中文名称（`skillDisplayName`，内置中文目录）；
 * - @技术标识（用户手敲 @ 时要用的 token）；
 * - 中文功能简介（`skillDisplaySummary`）。
 */
import { skillDisplayName, skillDisplaySummary } from "../skill-display";
import type { CapabilitySkill } from "../api";

export interface SkillsPaneProps {
  /** 已安装的普通技能列表（capabilities kind==="skill"，父级负责加载与过滤） */
  skills: CapabilitySkill[];
}

/** 技能页签组件 */
export function SkillsPane({ skills }: SkillsPaneProps) {
  return (
    <div className="skills-list">
      <p className="skills-hint">
        技能由引擎自动扫描：项目级 .deepcode/skills、用户级 ~/.deepcode/skills 与内置技能； 对话输入 <code>@</code>{" "}
        可直接引用。MCP 插件在「MCP 服务」页签配置。
      </p>
      {skills.length === 0 && (
        <div className="skills-empty">未发现已安装技能（可将 SKILL.md 放入 ~/.deepcode/skills）</div>
      )}
      {skills.map((s) => (
        <div key={`${s.kind}-${s.name}`} className="skills-item">
          <div className="skills-item-head">
            <span className="mention-badge mention-badge-skill">技能</span>
            <span className="skills-item-name">{skillDisplayName(s)}</span>
            <span className="skills-item-id" title="在输入框输入该标识即可调用">
              @{s.name}
            </span>
          </div>
          {skillDisplaySummary(s) !== "" && <div className="skills-item-desc">{skillDisplaySummary(s)}</div>}
          <div className="skills-item-path" title={s.path}>
            {s.path}
          </div>
        </div>
      ))}
    </div>
  );
}
