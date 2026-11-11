/**
 * EAG CLI 共享参数解析工具（eag-args）
 *
 * 背景（2026-10-14 事故追溯）：
 * - /eag-autonomous、/eag-design、/eag-graph、/eag-deploy 四条命令的参数解析
 *   各自内联了同一份 `--key value` 正则（历史重复副本共 4 处）。
 * - 旧正则的双引号值分支为 `"([^"]*)"`，**不支持值内转义引号 `\"`**：
 *   当参数值内部含双引号（如 `--goal "修复 hc_config.get(\"url\") 键名错位"`）时，
 *   `[^"]*` 会在第一个内嵌 `"` 处截断，闭引号后又不满足 `(?=\s|$)` 边界，
 *   整个值分支匹配失败后退化为 flag 形式（value=true），
 *   最终误报「缺少必填参数 --goal 或值为空」——命令看似正确却被拒绝。
 *
 * 本模块将解析逻辑收敛为单一实现：
 * - 双引号值分支改为 `"(?:\\.|[^"\\])*"`，允许 `\"` 等转义序列；
 *   取值后仅对 `\"`、`\'`、`\\` 三种序列做反转义（保守策略：
 *   未知转义如 `\d` 原样保留，避免破坏正则/路径文本）。
 * - 单引号值分支保持字面语义（不做任何反转义，对齐 shell 单引号约定）。
 * - 裸值分支与 flag 形式、首次匹配生效、`(?!--)` 负向前瞻等语义与旧实现完全一致。
 *
 * 语义约定（与旧内联实现保持一致，防止行为回归）：
 * - 值形式优先级：双引号 > 单引号 > 裸值；均不匹配则为 flag（true）
 * - 重复参数仅首次匹配生效（后续同名参数被跳过）
 * - `(?=\s|$)` 前瞻保证匹配边界清晰，避免值尾部粘连
 *
 * @module core/eag/cli/eag-args
 */

/**
 * `--key value` 形式参数的共享正则（global 标志，逐对提取）。
 *
 * 正则说明（相对旧版的唯一差异是双引号分支）：
 * - --([\w][\w-]*)                 参数名 → 捕获组 1
 * - (?:[=\s]+                      分隔符（= 或空白，至少一个，必须消费）
 *   "((?:\\[\s\S]|[^"\\])*)"       双引号值（支持 \" 等转义序列）→ 捕获组 2【本次修复点】
 *   |'([^']*)'                     单引号值（字面）→ 捕获组 3
 *   |(?!--)([^\s"']+)              裸值（不以 -- 开头）→ 捕获组 4
 *   )?                             整个值组可选（支持 flag 形式）
 * - (?=\s|$)                       前瞻断言：匹配结束位置必须是空白或字符串结尾
 */
const EAG_ARG_PATTERN_SOURCE = String.raw`--([\w][\w-]*)(?:[=\s]+(?:"((?:\\[\s\S]|[^"\\])*)"|'([^']*)'|(?!--)([^\s"']+)))?(?=\s|$)`;

/**
 * 对双引号值做保守反转义：仅还原 `\"`、`\'`、`\\` 三种序列，
 * 其余反斜杠序列（如 `\d`、`\n` 字面文本）原样保留，
 * 避免破坏 goal 描述中的正则表达式 / 路径 / 代码片段。
 */
function unescapeDoubleQuoted(raw: string): string {
  return raw.replace(/\\(["'\\])/g, "$1");
}

/**
 * argv 数组形态解析结果（T-025：规划器以 argv 数组下发指令的场景）。
 *
 * - command：首个非选项 token（子命令名，如 "compact" / "context"）
 * - flags：`--key value` / `--key` 解析出的参数表（与字符串形态同一取值语义）
 * - positional：command 之后未被选项吸收的裸 token 序列；
 *   当 command 之后没有任何裸 token 时，回退为 [command] 本身
 *   （保证调用方始终能在 positional 中读到命令词，兼容旧断言口径）
 */
export interface EagArgvParseResult {
  command: string;
  flags: Record<string, string | true>;
  positional: string[];
}

/**
 * 从 argv token 数组解析命令、选项与位置参数（T-025 新增重载）。
 *
 * 取值语义与字符串形态一致：`--key value` 吸收紧随其后的非 `--` token 为值；
 * 无值（后随另一选项或结束）记为 flag（true）；`--key=value` 内联值同样支持。
 *
 * @param argv 完整参数数组（含命令词）
 * @returns { command, flags, positional }
 */
function parseEagArgvTokens(argv: ReadonlyArray<string>): EagArgvParseResult {
  const tokens = argv.filter((t) => t.length > 0);
  const command = tokens[0] ?? "";
  const flags: Record<string, string | true> = {};
  const rest: string[] = [];

  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      const key = eq === -1 ? token.slice(2) : token.slice(2, eq);
      if (key.length === 0) continue;
      let value: string | true;
      if (eq !== -1) {
        value = token.slice(eq + 1);
      } else {
        const next = tokens[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          value = next;
          i += 1; // 吸收值 token，避免其混入 positional
        } else {
          value = true;
        }
      }
      if (!(key in flags)) flags[key] = value;
    } else {
      rest.push(token);
    }
  }

  return { command, flags, positional: rest.length > 0 ? rest : command.length > 0 ? [command] : [] };
}

/**
 * 从命令参数字符串中解析全部 `--key value` 参数对。
 *
 * @param argsPart 已剥离命令前缀的参数字符串
 * @returns 参数映射表：值为字符串（引号/裸值）或 true（flag 形式）；
 *          重复参数保留首次匹配
 */
export function parseEagArgs(argsPart: string): Record<string, string | true>;
/**
 * 从 argv token 数组解析命令、选项与位置参数（T-025 重载）。
 *
 * @param argv 完整参数数组（含命令词）
 * @returns { command, flags, positional }
 */
export function parseEagArgs(argv: ReadonlyArray<string>): EagArgvParseResult;
export function parseEagArgs(
  input: string | ReadonlyArray<string>
): Record<string, string | true> | EagArgvParseResult {
  // 用 typeof 而非 Array.isArray 做判别：Array.isArray 对 readonly string[] 的
  // false 分支收窄不彻底（TS 已知行为），typeof 能把两分支分别收窄为 string / readonly string[]
  if (typeof input === "string") {
    return parseEagArgString(input);
  }
  return parseEagArgvTokens(input);
}

function parseEagArgString(argsPart: string): Record<string, string | true> {
  const argPattern = new RegExp(EAG_ARG_PATTERN_SOURCE, "g");
  const args: Record<string, string | true> = {};

  let match: RegExpExecArray | null;
  while ((match = argPattern.exec(argsPart)) !== null) {
    const key = match[1];
    // 三种值形式：双引号（match[2]，需反转义）、单引号（match[3]，字面）、裸值（match[4]）；
    // 均未匹配则为 flag（true）
    const value = match[2] !== undefined ? unescapeDoubleQuoted(match[2]) : (match[3] ?? match[4] ?? true);
    // 仅首次匹配生效（重复参数被跳过，对齐设计文档"首次匹配生效"约定）
    if (!(key in args)) {
      args[key] = value;
    }
  }

  return args;
}
