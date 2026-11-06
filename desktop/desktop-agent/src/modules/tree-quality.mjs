/**
 * TreeQuality —— 按「实测树质量」判定通道，替代按进程名猜。
 *
 * 背景：分类器只能看进程名与窗口标题，猜不出 Electron 应用（各自有独立
 * 的 exe 名，进程名里没有 "electron"）。实测 `workbuddy` 只有 3 个节点、
 * `gameviewer` 28 个可操作节点里只有 2 个有名字——这类界面「按名字找目标」
 * 根本不成立，必须提前判定为需要视觉兜底，而不是等动作失败再重试。
 *
 * 因此质量判定放在观察之后：用真实树说话，判完再把结论回写给注册表，
 * 让后续 channelMatrix 反映实测结果，而不是启发式猜测。
 */

/**
 * 可操作角色（统一小写）：只有这些才值得让模型按名字点击。
 * 各平台命名不同（UIA `Button` / AX `AXButton` / DOM `button`），
 * 所以比较前统一小写并剥掉 `ax` 前缀，避免判定绑死在某一个后端。
 */
export const ACTIONABLE_ROLES = new Set([
  "button",
  "edit",
  "document",
  "menuitem",
  "listitem",
  "checkbox",
  "combobox",
  "hyperlink",
  "link",
  "radiobutton",
  "radio",
  "slider",
  "spinner",
  "tabitem",
  "tab",
  "treeitem",
  "splitbutton",
  "dataitem",
  "textbox",
  "textarea",
]);

/** 归一化角色名：小写 + 去 ax 前缀，兼容多后端 */
export function normalizeRole(role) {
  return String(role ?? "").toLowerCase().replace(/^ax/, "");
}

function flatten(nodes, out = []) {
  for (const n of nodes ?? []) {
    out.push(n);
    flatten(n.children, out);
  }
  return out;
}

/**
 * 评估一棵（骨架）树是否足以支撑「按名字定位」。
 *
 * 关键区分：**「没看到」不等于「没有」**。骨架只展开前几层，深度截断时
 * 可操作控件常常还在更深处（实测 taskmgr 在 depth=4 时全是 Pane，
 * 深处才是按钮/列表项）。因此当树被截断（complete=false）且当前层没找到
 * 目标时，结论是 `deferred`（需下钻），而不是 `sparse`（判死）。
 */
export function assessTree(tree, options = {}) {
  const { complete = true } = options;
  const nodes = flatten(tree);
  const nodeCount = nodes.length;
  const actionable = nodes.filter((n) => ACTIONABLE_ROLES.has(normalizeRole(n.role)));
  const named = nodes.filter((n) => typeof n.name === "string" && n.name.trim().length > 0);
  const namedActionable = actionable.filter(
    (n) => typeof n.name === "string" && n.name.trim().length > 0
  );
  // 有名字的可操作节点才是「模型能指认的目标」；ratio 用于区分
  // 「树很大但全是 Pane」（自绘界面典型形态）与「树小但目标清晰」。
  const namedRatio = nodeCount === 0 ? 0 : named.length / nodeCount;
  const threshold = options.minNamedActionable ?? 3;

  let verdict = "good";
  let reason = "有名字的可操作节点充足，可按名字定位";
  if (nodeCount === 0) {
    verdict = "empty";
    reason = "树为空（自绘 / Electron / 游戏），只能视觉兜底或拒绝";
  } else if (namedActionable.length === 0) {
    verdict = complete ? "sparse" : "deferred";
    reason = complete
      ? "整棵树都没有有名字的可操作节点，按名字定位不可行"
      : "当前深度未暴露可操作目标，树被截断，需下钻后再判定";
  } else if (namedActionable.length < threshold) {
    verdict = namedActionable.length > 0 && !complete ? "deferred" : "sparse";
    reason = `有名字的可操作节点仅 ${namedActionable.length} 个（阈值 ${threshold}），定位可靠性不足`;
  } else if (namedRatio < 0.35) {
    verdict = "sparse";
    reason = `命名节点占比仅 ${Math.round(namedRatio * 100)}%，多数节点是容器`;
  }

  return {
    nodeCount,
    actionableCount: actionable.length,
    namedCount: named.length,
    namedActionableCount: namedActionable.length,
    namedRatio: Math.round(namedRatio * 100) / 100,
    complete,
    verdict,
    reason,
  };
}

/** 通道建议：good → 走树；sparse/empty → 视觉兜底；deferred → 先下钻，别急着换通道 */
export function channelForQuality(quality) {
  if (!quality) return null;
  if (quality.verdict === "good") return "gui-a11y";
  if (quality.verdict === "deferred") return "gui-a11y";
  return "gui-visual";
}

/**
 * 判断一次快照「看全了没有」。
 *
 * 为什么不能直接用 `snapshot.truncated`：桥侧为了不撒谎，任何快照都回
 * `truncated: true`（它无法证明自己没漏），于是这个字段恒真、没有任何区分度。
 * 真正的信息在骨架节点上——`Copy-Skeleton` 只给**被剪掉孩子**的节点打
 * `truncated: true`，所以「没有任何节点带这个标记」才是「深度内确实看全了」。
 *
 * 另有一条独立的预算边界：节点数到达 `MaxNodes`（桥侧 1500）时，枚举会被
 * 提前掐断，即使每个节点都没被标记，也不能算完整。
 *
 * 这个区分直接决定产品行为：
 *  - complete=true  + 没有可操作节点 → 真的 sparse，该走视觉兜底或拒绝；
 *  - complete=false + 没有可操作节点 → 只是没看到，应该先下钻，别急着判死。
 */
export function treeCompleteness(snap, options = {}) {
  const maxNodes = options.maxNodes ?? 1500;
  const skeleton = flatten(snap?.tree ?? []);
  const cutNodes = skeleton.filter((n) => n?.truncated === true).length;
  // nodeCount 是桥侧实际枚举的节点总数（含骨架之外的两层），比 skeleton.length 更准
  const enumerated = Number.isFinite(snap?.nodeCount) ? snap.nodeCount : flatten(snap?.fullTree ?? snap?.tree ?? []).length;
  const budgetHit = enumerated >= maxNodes;
  const complete = cutNodes === 0 && !budgetHit;
  return {
    complete,
    cutNodes,
    enumerated,
    maxNodes,
    budgetHit,
    reason: complete
      ? "深度预算内没有未展开的子树"
      : budgetHit
        ? `节点数到达预算上限 ${maxNodes}，枚举被提前掐断`
        : `${cutNodes} 个节点在深度边界上仍有孩子，需下钻`,
  };
}

/**
 * 一次快照 → 树质量。把「完整度」与「质量」绑在一起判定，避免调用方
 * 各自用 nodeCount 猜一个 complete 出来（猜错的代价是把可下钻的应用判死）。
 */
export function assessSnapshot(snap, options = {}) {
  const completeness = treeCompleteness(snap, options);
  const quality = assessTree(snap?.fullTree ?? snap?.tree ?? [], {
    ...options,
    complete: completeness.complete,
  });
  return { ...quality, completeness };
}
