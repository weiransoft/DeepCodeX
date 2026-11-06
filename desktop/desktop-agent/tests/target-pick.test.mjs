/**
 * 写入落点选择测试。
 *
 * 这些不是虚构的树：Excel 的公式栏/网格尺寸、Word 的 Document 与页面 Edit、
 * 记事本的整块 Edit 都来自真机实测的 UIA 结构（见 reports/p2-multi-app.json）。
 * 第一条是回归用例——它对应的真实故障是「粘贴成功、保存成功、磁盘没变」。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { pickTarget, flattenNodes, EDITABLE_ROLES, CHROME_NAME } from "../src/modules/target-pick.mjs";

const node = (role, name, width, height, children = []) => ({
  role,
  name,
  rect: { x: 0, y: 0, width, height },
  children,
});

test("Excel：选网格而不是公式栏（面积优先，角色名会骗人）", () => {
  const tree = [
    node("Window", "sheet - Excel", 1900, 1000, [
      node("Edit", "编辑栏", 1482, 77),
      node("Pane", "工作表", 1366, 497, [node("DataGrid", "网格", 1327, 497)]),
      node("Pane", "Ribbon", 1894, 357),
    ]),
  ];
  const picked = pickTarget(tree);
  assert.equal(picked.role, "DataGrid");
  assert.equal(picked.name, "网格");
});

test("记事本：整块 Edit 就是落点", () => {
  const tree = [node("Window", "a.txt - 记事本", 1200, 800, [node("Edit", "文本编辑器", 1180, 700)])];
  assert.equal(pickTarget(tree).role, "Edit");
});

test("Word：Document 的面积大于「页面 1 内容」Edit 时选 Document", () => {
  const tree = [
    node("Window", "doc - Word", 1900, 1000, [
      node("Document", "doc.txt - 最后由用户保存", 1860, 675, [
        node("Custom", "页面 1", 900, 640, [node("Edit", "页面 1 内容", 860, 600)]),
      ]),
    ]),
  ];
  const picked = pickTarget(tree);
  assert.equal(picked.role, "Document");
});

test("名字是界面部件的节点即使角色是 Edit 也排除", () => {
  for (const name of ["编辑栏", "搜索框", "Ribbon", "Formula Bar", "Address Bar"]) {
    assert.ok(CHROME_NAME.test(name), `${name} 应被识别为界面部件`);
  }
  const tree = [
    node("Window", "w", 1900, 1000, [
      node("Edit", "搜索框", 300, 30),
      node("Edit", "编辑栏", 900, 40),
      node("Pane", "主体", 1800, 900, [node("Document", "正文", 1700, 880)]),
    ]),
  ];
  assert.equal(pickTarget(tree).name, "正文");
});

test("没有可编辑容器时退到最大的容器，而不是随便第一个节点", () => {
  const tree = [
    node("Window", "explorer", 1200, 800, [
      node("Pane", "导航窗格", 220, 700),
      node("Pane", "文件列表", 900, 700),
    ]),
  ];
  assert.equal(pickTarget(tree).name, "文件列表");
});

test("尺寸缺失的节点不能当落点（避免点到不可见元素）", () => {
  const tree = [
    node("Window", "w", 1200, 800, [
      { role: "Edit", name: "幽灵", rect: { width: 0, height: 0 }, children: [] },
      node("Pane", "主体", 1100, 700),
    ]),
  ];
  assert.equal(pickTarget(tree).name, "主体");
});

test("空树返回 null（调用方据此拒绝盲点）", () => {
  assert.equal(pickTarget([]), null);
  assert.equal(pickTarget(undefined), null);
});

test("flattenNodes 保留深度优先顺序，角色清单覆盖四类编辑面", () => {
  const tree = [node("Window", "w", 10, 10, [node("Pane", "p", 5, 5, [node("Edit", "e", 5, 5)])])];
  assert.deepEqual(
    flattenNodes(tree).map((n) => n.role),
    ["Window", "Pane", "Edit"],
  );
  for (const role of ["Edit", "Document", "TextArea", "DataGrid"]) assert.ok(EDITABLE_ROLES.includes(role));
});
