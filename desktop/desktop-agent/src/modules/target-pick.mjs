/**
 * 写入落点选择（从「可写面积」出发，而不是从「角色名」出发）。
 *
 * 这条规则吃过一次真机教训：Excel 的 UIA 树里同时存在
 *   · `Edit 编辑栏`（公式栏，1482×77）
 *   · `DataGrid 网格`（工作表，1327×497）
 * 按「Edit 优先」的常见直觉会选到公式栏，于是粘贴返回 ok、Ctrl+S 返回 ok，
 * 单元格却没有提交，磁盘一个字节没变——一个全绿的假成功。
 * 落点是**用户真正会打字的那块面**，它通常就是面积最大的可编辑容器。
 */
export const EDITABLE_ROLES = ["Edit", "Document", "TextArea", "DataGrid", "Table", "Grid", "List"];

/** 名字明显是界面部件而非正文区的节点：即使角色是 Edit 也不能当落点 */
export const CHROME_NAME = /编辑栏|公式栏|地址栏|搜索框|功能区|Ribbon|Address bar|Formula|Search/i;

/** 最小可操作尺寸：宽高都不到 4px 的多半是装饰性节点 */
const MIN_SIDE = 4;

export function flattenNodes(nodes, out = []) {
  for (const n of nodes ?? []) {
    out.push(n);
    flattenNodes(n.children, out);
  }
  return out;
}

const areaOf = (n) => (n?.rect?.width ?? 0) * (n?.rect?.height ?? 0);
const hasSize = (n) => (n?.rect?.width ?? 0) >= MIN_SIDE && (n?.rect?.height ?? 0) >= MIN_SIDE;

/**
 * 选写入落点。
 *
 * @param {Array} tree 快照树（骨架或完整树均可）
 * @returns {object|null} 目标节点；`null` 表示这棵树里没有可用落点
 */
export function pickTarget(tree) {
  const flat = flattenNodes(tree).filter(hasSize);
  const editable = flat.filter((n) => EDITABLE_ROLES.includes(n.role) && !CHROME_NAME.test(String(n.name ?? "")));
  if (editable.length) return editable.sort((a, b) => areaOf(b) - areaOf(a))[0];
  // 没有可编辑容器（资源管理器列表、自绘面板）：退回容器角色，同样按面积取最大的
  for (const role of ["Pane", "ListItem", "Custom"]) {
    const hit = flat.filter((n) => n.role === role).sort((a, b) => areaOf(b) - areaOf(a))[0];
    if (hit) return hit;
  }
  return flat.sort((a, b) => areaOf(b) - areaOf(a))[0] ?? null;
}
