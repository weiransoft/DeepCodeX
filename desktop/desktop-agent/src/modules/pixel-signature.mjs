/**
 * 像素签名 —— 树指认不了目标时，唯一还剩下的「动作有没有生效」的证据。
 *
 * 背景（报告 §3.10）：任务管理器 / 字符映射表 / 系统信息 / 磁盘清理四家实测为
 * `sparse`——窗口有、树非空，但没有任何可按名字定位的可操作节点。这类应用走
 * 视觉兜底，而视觉兜底的动作**在树上看不出变化**：Verifier 的 `observeState`
 * 复观察拿到的是同一棵树，`expectChange` 恒为 false，于是每次点击都被判
 * `verify-failed`。换句话说，没有像素证据，视觉兜底只有「能点」没有「能验」。
 *
 * 实现选择：
 * - 桥侧把窗口缩到 64×64 灰度（4096 字节）再回传，而不是回传整张 PNG：
 *   一步动作要取两次状态，PNG 上桥是几十到几百 KB × 2 的 stdio 往返，
 *   灰度网格只要 5.5 KB base64，且比较是纯算术。
 * - 判定用「差异格数占比」而不是逐像素相等：闪烁的光标、抗锯齿、悬停高亮
 *   都会让少数格子变化，逐像素相等会把它们全判成「变了」，产生假阳性——
 *   而假阳性比假阴性危险得多（会让人以为动作生效了）。
 */

import { ErrorCode, AgentError } from "../errors.mjs";

/** 网格边长：64×64 对「标签页切换 / 对话框弹出 / 列表重排」足够灵敏 */
export const SIGNATURE_GRID = 64;
export const SIGNATURE_CELLS = SIGNATURE_GRID * SIGNATURE_GRID;

/**
 * 解码签名。接受 base64 字符串或已解码的 Uint8Array/Buffer。
 * @returns {Uint8Array}
 */
export function decodeSignature(input) {
  if (input instanceof Uint8Array) return input;
  if (typeof input === "string") return new Uint8Array(Buffer.from(input, "base64"));
  return new Uint8Array(0);
}

/** 编码签名（桥侧用 .NET 做同样的事；这里给 mock 与单测用） */
export function encodeSignature(gray) {
  return Buffer.from(gray).toString("base64");
}

/**
 * 比较两个签名的差异。
 *
 * @param {string|Uint8Array} before
 * @param {string|Uint8Array} after
 * @param {{cellDelta?:number, changedRatio?:number}} options
 *   cellDelta —— 单格灰度差超过它才算「变了」（挡住编码噪声）
 *   changedRatio —— 变化格数占比超过它才判定整体变化（挡住光标闪烁）
 * @returns {{changed:boolean, changedCells:number, ratio:number, cells:number, maxDelta:number, verdict:string}}
 */
export function diffSignatures(before, after, { cellDelta = 6, changedRatio = 0.02 } = {}) {
  const a = decodeSignature(before);
  const b = decodeSignature(after);
  if (a.length === 0 || b.length === 0) {
    throw new AgentError(ErrorCode.INVALID_ARGUMENT, "像素签名为空，无法比较", {
      hint: "确认桥侧 pixelSignature 可用且未被策略关闭",
    });
  }
  if (a.length !== b.length) {
    throw new AgentError(ErrorCode.INVALID_ARGUMENT, `像素签名长度不一致（${a.length} vs ${b.length}），疑似网格尺寸变更`, {
      hint: `两侧应同为 ${SIGNATURE_CELLS} 字节（${SIGNATURE_GRID}×${SIGNATURE_GRID}）`,
    });
  }

  let changedCells = 0;
  let maxDelta = 0;
  for (let i = 0; i < a.length; i += 1) {
    const d = Math.abs(a[i] - b[i]);
    if (d > maxDelta) maxDelta = d;
    if (d > cellDelta) changedCells += 1;
  }
  const ratio = changedCells / a.length;
  const changed = ratio > changedRatio;

  let verdict;
  if (changed) verdict = "layout-changed";
  else if (changedCells === 0) verdict = "identical";
  else verdict = "within-noise"; // 有零星格子动了（光标/抗锯齿），不算变化

  return { changed, changedCells, ratio, cells: a.length, maxDelta, verdict };
}
