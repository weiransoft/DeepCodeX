/**
 * /eag-design 命令参数解析（EAG-P1 S3.2 接线批次）
 *
 * 本模块提供 `extractDesignLoopInputFromPrompt()` 独立函数，从命令字符串
 * `/eag-design --requirement <text> [--paradigm <id>]` 解析出 DesignLoopInput，
 * 使 /eag-design 摆脱对 messageParams.designLoopInput 预装配的单一依赖
 * （用户可直接在 CLI 内联输入参数触发 DESIGN Loop）。
 *
 * 设计依据（对齐 optimization-plan-20260819 S3.2 步骤 5 评审必改项）：
 * - 此前 parser 严格匹配裸 `/eag-design`，payload 完全依赖
 *   userPrompt.messageParams.designLoopInput 预装配（生产 CLI 无装配路径，
 *   导致命令永远 payload=null 不可用）
 * - 参照 /eag-autonomous 参数解析先例（extractEagAutonomousRequestFromPrompt）：
 *   messageParams 注入优先（UI 表单场景），CLI 内联参数回退（本模块）
 *
 * 命令格式：
 * - `/eag-design --requirement "作为订单管理员，我希望创建订单，以便跟踪订单状态"`
 * - `/eag-design --requirement "..." --paradigm cqrs-es`（锁定范式）
 *
 * 参数说明：
 * - --requirement：必填，非空字符串（原始业务需求，支持引号包裹含空格文本）
 * - --paradigm：可选，必须是 4 个合法范式 ID 之一（ddd-layered /
 *   clean-architecture / cqrs-es / microservice）；提供时构造
 *   ParadigmLockConfig（locked=true，命令行级锁定优先于项目级配置）
 *
 * @module eag/cli/eag-design-command
 */

import type { ParadigmId } from "../eak/types";
import { PARADIGM_IDS } from "../eak/types";
import type { DesignLoopInput } from "../design/design-models";

/**
 * 从 /eag-design 命令字符串解析 DesignLoopInput
 *
 * 算法（对齐 extractEagAutonomousRequestFromPrompt 模式）：
 * 1. 校验 prompt 为非空字符串
 * 2. 移除命令前缀 /eag-design（大小写不敏感）
 * 3. 用正则解析 --key value 形式参数（支持单/双引号包裹的值与裸值）
 * 4. 校验必填参数 --requirement（非空字符串）
 * 5. 校验可选参数 --paradigm（4 个合法范式 ID 之一）
 * 6. 装配 DesignLoopInput（--paradigm 提供时构造 ParadigmLockConfig）并冻结
 * 7. 任一校验失败抛 Error，错误信息含参数名与取值范围
 *
 * 不可变优先原则（§5.12.4 G-A6d）：
 * - 返回的 DesignLoopInput（含内嵌 paradigmLock）通过 Object.freeze 冻结
 *
 * @param prompt /eag-design 命令字符串（含命令前缀与参数）
 * @returns 冻结的 DesignLoopInput 对象
 * @throws {Error} 当 prompt 非字符串、命令前缀不匹配、必填参数缺失、
 *                 范式 ID 非法或出现未知参数时抛出
 */
export function extractDesignLoopInputFromPrompt(prompt: string): DesignLoopInput {
  // 步骤 1：校验 prompt 为非空字符串
  if (typeof prompt !== "string") {
    throw new Error("extractDesignLoopInputFromPrompt: prompt 必须为非空字符串");
  }
  const trimmed = prompt.trim();
  if (trimmed.length === 0) {
    throw new Error("extractDesignLoopInputFromPrompt: prompt 不能为空字符串");
  }

  // 步骤 2：移除命令前缀 /eag-design（大小写不敏感）
  const prefixMatch = /^\/eag-design(?:\s+|$)/i.exec(trimmed);
  if (!prefixMatch) {
    throw new Error(
      `extractDesignLoopInputFromPrompt: 命令前缀不匹配，期望以 /eag-design 开头（大小写不敏感），实际为: ${trimmed.slice(0, 50)}`
    );
  }
  const argsPart = trimmed.slice(prefixMatch[0].length).trim();

  // 无参数形式（裸 /eag-design）：无法内联构造输入，交由 messageParams 路径
  // （extractDesignLoopInput 仅在参数存在时回退调用本函数）
  if (argsPart.length === 0) {
    throw new Error(
      'extractDesignLoopInputFromPrompt: 缺少必填参数 --requirement（如 --requirement "作为订单管理员，我希望创建订单，以便跟踪订单状态"）'
    );
  }

  // 步骤 3：用正则解析 --key value 形式参数
  // 正则说明（与 extractEagAutonomousRequestFromPrompt 一致）：
  // - --([\w][\w-]*)                              匹配参数名 → 捕获组 1
  // - (?:[=\s]+                                   分隔符（= 或空白，至少一个）
  //   (?:"([^"]*)"                                双引号值 → 捕获组 2
  //   |'([^']*)'                                  单引号值 → 捕获组 3
  //   |(?!--)([^\s"']+)                           裸值（不以 -- 开头）→ 捕获组 4
  //   ))?                                         整个值组可选（支持 flag 形式）
  // - (?=\s|$)                                    前瞻断言：匹配结束位置必须是空白或字符串结尾
  const argPattern = /--([\w][\w-]*)(?:[=\s]+(?:"([^"]*)"|'([^']*)'|(?!--)([^\s"']+)))?(?=\s|$)/g;
  const args: Record<string, string | true> = {};

  // 重复参数首次匹配生效（后续覆盖被跳过）
  let match: RegExpExecArray | null;
  while ((match = argPattern.exec(argsPart)) !== null) {
    const key = match[1];
    // 三种值形式：双引号（match[2]）、单引号（match[3]）、裸值（match[4]）；均未匹配则为 flag（true）
    const value = match[2] ?? match[3] ?? match[4] ?? true;
    // 仅首次匹配生效（重复参数被跳过）
    if (!(key in args)) {
      args[key] = value;
    }
  }

  // 校验未知参数（仅允许 requirement / paradigm，防拼写错误静默失效）
  const ALLOWED_KEYS: ReadonlySet<string> = new Set(["requirement", "paradigm"]);
  for (const key of Object.keys(args)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(`extractDesignLoopInputFromPrompt: 未知参数 --${key}（仅支持 --requirement 与 --paradigm）`);
    }
  }

  // 步骤 4：校验必填参数 --requirement（非空字符串）
  const requirementRaw = args["requirement"];
  if (requirementRaw === undefined) {
    throw new Error(
      'extractDesignLoopInputFromPrompt: 缺少必填参数 --requirement（如 --requirement "作为订单管理员，我希望创建订单，以便跟踪订单状态"）'
    );
  }
  if (requirementRaw === true || String(requirementRaw).trim().length === 0) {
    throw new Error("extractDesignLoopInputFromPrompt: --requirement 必须提供非空值（原始业务需求文本）");
  }
  const rawRequirement = String(requirementRaw).trim();

  // 步骤 5：校验可选参数 --paradigm（4 个合法范式 ID 之一）
  const paradigmRaw = args["paradigm"];
  let paradigmLock: DesignLoopInput["paradigmLock"];
  if (paradigmRaw !== undefined) {
    if (paradigmRaw === true || String(paradigmRaw).trim().length === 0) {
      throw new Error(`extractDesignLoopInputFromPrompt: --paradigm 必须提供值（${PARADIGM_IDS.join(" / ")} 之一）`);
    }
    const paradigmId = String(paradigmRaw).trim();
    // 运行时校验范式 ID 合法性（PARADIGM_IDS 为冻结常量集合）
    if (!(PARADIGM_IDS as ReadonlyArray<string>).includes(paradigmId)) {
      throw new Error(
        `extractDesignLoopInputFromPrompt: --paradigm 值非法 "${paradigmId}"（必须是 ${PARADIGM_IDS.join(" / ")} 之一）`
      );
    }
    // 命令行级范式锁定（优先级高于项目级 .deepcode/eag.yml 配置，由调用方合并）
    paradigmLock = Object.freeze({
      locked: true,
      paradigmId: paradigmId as ParadigmId,
      reason: "命令行 --paradigm 参数锁定",
    });
  }

  // 步骤 6：装配并冻结 DesignLoopInput
  return Object.freeze({
    rawRequirement,
    ...(paradigmLock ? { paradigmLock } : {}),
  }) as DesignLoopInput;
}
