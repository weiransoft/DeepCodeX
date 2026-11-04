/**
 * 分词器 —— Super Agent 内核自带的最小分词实现
 *
 * ## 为什么内联而不是复用 `team/workflows/semantic-embedder.ts`
 *
 * `team/workflows/semantic-embedder.ts:103-142` 的 `tokenize` 本身是纯函数
 * （函数体零依赖；文件顶部的 `node:crypto` 是**文件级** import，服务于同文件
 * 其他 embedder 实现，与 `tokenize` 无关）。
 *
 * 但直接 import 该文件会撞上 Super Agent 内核的 eslint 门禁
 * （`eslint.config.mjs:250` 禁 `../../team/*`）——而绕过门禁去 import
 * `v2/integration/v1-adapters` 的 barrel 更糟：barrel 的 re-export 会让
 * 整个依赖树（含 `node:fs` / `node:child_process`）在链接期被求值。
 *
 * 因此这里**内联函数体**（36 行），保持算法与源实现一致。
 *
 * ## 算法
 *
 * - 英文/数字：连续字符为一个 token
 * - 中文（Unicode 4E00–9FFF）：逐字切分
 * - 标点/空白/emoji：忽略
 * - 不去重（保留频率信息）
 *
 * @module super-agent/domain/tokenize
 */

/**
 * 切分文本为 token 列表
 *
 * @param text 输入文本
 * @returns token 列表（保持出现顺序，不去重）
 */
export function tokenize(text: string): string[] {
  if (!text) {
    return [];
  }
  const lower = text.toLowerCase();
  // 简化的中英文分词：
  // - 英文/数字作为一个 token
  // - 中文字符（Unicode 4E00-9FFF）每个字作为一个 token
  // 其他字符（标点、空格、emoji）忽略
  const tokens: string[] = [];
  let buffer = "";
  for (const ch of lower) {
    const code = ch.codePointAt(0) ?? 0;
    if ((code >= 0x30 && code <= 0x39) || (code >= 0x61 && code <= 0x7a)) {
      // 数字或英文小写字母：累积
      buffer += ch;
    } else if (code >= 0x4e00 && code <= 0x9fff) {
      // 中文字符：先 flush buffer，再加入单字
      if (buffer.length > 0) {
        tokens.push(buffer);
        buffer = "";
      }
      tokens.push(ch);
    } else {
      // 其他字符（标点、空格等）：flush buffer
      if (buffer.length > 0) {
        tokens.push(buffer);
        buffer = "";
      }
    }
  }
  if (buffer.length > 0) {
    tokens.push(buffer);
  }
  return tokens;
}
