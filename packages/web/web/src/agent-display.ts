/**
 * 智能体显示名（web 展示层唯一来源）
 *
 * ## 为什么需要这一层
 *
 * 智能体的 `name` 是**技术标识**，不是给人看的：它必须 kebab-case、全小写，
 * 因为它同时是 `~/.deepcode/skills/<name>/` 的目录名、`@name` 提及的 token、
 * `/team dispatch --role` 的角色 id。把它改成中文会直接打断这三条链路。
 *
 * 中文名在 SKILL.md 的 frontmatter `role` 里（如
 * `role: "产品经理（业务需求分析）"`）。因此展示层做一次「技术标识 → 中文名」
 * 的翻译，**标识本身一律不动**。
 *
 * ## 括注剥离规则
 *
 * 预置数据的 `role` 有两种形态：
 * - `产品经理（Product Manager）` —— 括注是英文名，纯冗余 → 剥成「产品经理」
 * - `产品经理（业务需求分析）` —— 括注是业务限定，有信息量 → 原样保留
 *
 * 判据是「括注里有没有中日韩字符」，不是「是不是 ASCII」：后者会把
 * `SEO 专家（搜索引擎优化）` 误判（全角括号+中文）、把 `Agent 编排架构工程师`
 * 这类混排名字判错。
 *
 * @module agent-display
 */

/** 展示所需的最小字段集（`CapabilitySkill` 结构上直接兼容） */
export interface AgentDisplaySource {
  /** 技术标识（kebab-case，@ 提及与目录名同源） */
  name: string;
  /** frontmatter `role`：中文角色身份；缺省时回退 name */
  role?: string;
}

/** 中日韩字符（用于判断括注是否携带中文信息） */
const CJK_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;

/**
 * 剥离纯拉丁括注
 *
 * @param text 原始 role 文本
 * @returns 剥离后的文本；无括注 / 括注含中文 / 剥离后为空时原样返回
 */
function stripLatinNote(text: string): string {
  const matched = text.match(/^(.*?)\s*[（(]\s*([^（）()]*?)\s*[）)]\s*$/);
  if (matched === null) return text;
  const head = matched[1].trim();
  const note = matched[2];
  // 剥离后会变空（role 只有括注）→ 保留原样，避免显示空名
  if (head === "") return text;
  // 中文括注是有效限定，保留
  if (CJK_PATTERN.test(note)) return text;
  return head;
}

/**
 * 智能体中文显示名
 *
 * @param agent 能力条目（至少含 name；预置/自建智能体带 role）
 * @returns 有 role 时用 role（剥纯拉丁括注），否则回退技术标识
 *
 * @example
 * agentDisplayName({ name: "domain-product-manager", role: "产品经理（业务需求分析）" })
 * // => "产品经理（业务需求分析）"
 * agentDisplayName({ name: "product-manager", role: "产品经理（Product Manager）" })
 * // => "产品经理"
 * agentDisplayName({ name: "code-reviewer" })
 * // => "code-reviewer"
 */
export function agentDisplayName(agent: AgentDisplaySource): string {
  const role = (agent.role ?? "").trim();
  if (role === "") return agent.name;
  return stripLatinNote(role);
}

/**
 * 智能体技术标识的展示形式（`@name`）
 *
 * 中文名之外必须让用户看得到 token：`@` 补全插入的就是它，
 * 用户后续要手动输入也只能用它。两者同时出现才算「看得懂也用得上」。
 *
 * @param agent 能力条目
 * @returns `@` + 技术标识
 */
export function agentMentionHint(agent: AgentDisplaySource): string {
  return `@${agent.name}`;
}
