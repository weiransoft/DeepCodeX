import test from "node:test";
import assert from "node:assert/strict";

import { assessTree, channelForQuality, normalizeRole } from "../src/modules/tree-quality.mjs";
import { AppRegistry } from "../src/modules/app-registry.mjs";
import { Perception } from "../src/modules/perception.mjs";
import { createMockBackend } from "../src/backends/mock.mjs";
import { defaultPolicy } from "../src/modules/policy-guard.mjs";
import { DesktopAgent } from "../src/agent.mjs";

const node = (role, name, children = []) => ({ ref: `${role}-${name || "x"}`, role, name, children });

test("角色归一化：UIA / AX / DOM 三套命名都能识别", () => {
  assert.equal(normalizeRole("Button"), "button");
  assert.equal(normalizeRole("AXButton"), "button");
  assert.equal(normalizeRole("button"), "button");
  assert.equal(normalizeRole(undefined), "");
});

test("树质量：空树判 empty，即使节点很多但全是无名 Pane 判 sparse", () => {
  assert.equal(assessTree([]).verdict, "empty");

  // 自绘界面典型形态：树不小，但没有一个能指认的目标
  const panes = [node("Pane", "", [node("Pane", ""), node("Pane", "")]), node("Pane", "")];
  const r = assessTree(panes);
  assert.equal(r.verdict, "sparse");
  assert.equal(r.namedActionableCount, 0);
  assert.match(r.reason, /没有有名字的可操作节点/);
});

test("树质量：28 个可操作节点只有 2 个有名字 → sparse（gameviewer 实测形态）", () => {
  const children = [];
  for (let i = 0; i < 26; i += 1) children.push(node("Button", ""));
  children.push(node("Button", "开始"));
  children.push(node("Button", "设置"));
  const r = assessTree([node("Window", "游戏盒子", children)]);
  assert.equal(r.actionableCount, 28);
  assert.equal(r.namedActionableCount, 2);
  assert.equal(r.verdict, "sparse");
});

test("树质量：骨架被截断且当前层无目标 → deferred（待下钻），不判死也不换通道", () => {
  // 实测 taskmgr 在 depth=4 时全是 Pane，深处才是按钮：此时只能说「还没看到」
  const skeleton = [node("Window", "任务管理器", [node("Pane", ""), node("Pane", "")])];
  const deferred = assessTree(skeleton, { complete: false });
  assert.equal(deferred.verdict, "deferred");
  assert.equal(deferred.complete, false);
  assert.equal(channelForQuality(deferred), "gui-a11y", "deferred 不应改判视觉通道");

  // 同一棵树若已完整遍历（确无目标），才允许判 sparse
  assert.equal(assessTree(skeleton, { complete: true }).verdict, "sparse");
});

test("树质量：有名字的可操作节点充足判 good；小但目标清晰也算 good", () => {
  const good = assessTree([
    node("Window", "记事本", [
      node("Edit", "文本编辑器"),
      node("Button", "保存"),
      node("Button", "取消"),
      node("Text", "就绪"),
    ]),
  ]);
  assert.equal(good.verdict, "good");
  assert.equal(good.namedActionableCount, 3);

  assert.equal(channelForQuality(good), "gui-a11y");
  assert.equal(channelForQuality(assessTree([])), "gui-visual");
  assert.equal(channelForQuality(null), null);
});

test("注册表：实测树残缺会覆盖分类启发式，敏感分类仍保持 blocked", async () => {
  const registry = new AppRegistry(createMockBackend());
  const apps = [
    { appId: "workbuddy", pid: 100, hwnd: 5, title: "WorkBuddy", category: "unknown" },
    { appId: "bankclient", pid: 200, hwnd: 6, title: "网上银行", category: "finance-or-sensitive" },
  ];
  // 分类器猜的是 gui-a11y（unknown 默认），但实测只有 1 个节点、0 个可操作
  registry.noteTreeQuality(apps[0], assessTree([node("Pane", "")]));
  registry.noteTreeQuality(apps[1], assessTree([node("Pane", "")]));

  const matrix = await registry.channelMatrix(apps);
  const wb = matrix.find((a) => a.appId === "workbuddy");
  assert.equal(wb.channel, "gui-visual");
  assert.match(wb.reason, /实测树残缺/);
  assert.equal(wb.treeQuality.verdict, "sparse");

  // 敏感应用不因树残缺被「降级」成可操作通道
  assert.equal(matrix.find((a) => a.appId === "bankclient").channel, "blocked");
});

test("注册表：同进程多窗口按 hwnd 分别记录，互不覆盖", () => {
  const registry = new AppRegistry(createMockBackend());
  const folder = { appId: "explorer", pid: 8392, hwnd: 11, title: "Downloads", category: "productivity" };
  const desk = { appId: "explorer", pid: 8392, hwnd: 22, title: "Program Manager", category: "productivity" };

  registry.noteTreeQuality(folder, assessTree([node("Edit", "地址栏"), node("Button", "前进"), node("Button", "后退")]));
  registry.noteTreeQuality(desk, assessTree([node("Pane", "")]));

  assert.equal(registry.qualityFor(folder).verdict, "good");
  assert.equal(registry.qualityFor(desk).verdict, "sparse");
});

test("观察即测量：observe 回写树质量，并在返回值里带上 treeQuality", async () => {
  const seen = [];
  const perception = new Perception(createMockBackend(), {
    policy: { policy: defaultPolicy() },
    onQuality: (app, q) => seen.push([app.appId, q.verdict]),
  });
  const res = await perception.observe({ app: { appId: "notepad", pid: 1 }, maxDepth: 3 });
  assert.equal(res.ok, true);
  assert.equal(res.treeQuality.verdict, "good");
  assert.deepEqual(seen[0], ["notepad", "good"]);

  // 自绘应用空树 → empty，且给出换通道提示
  const empty = await perception.observe({ app: { appId: "canvas-app", pid: 2 }, maxDepth: 3 });
  assert.equal(empty.treeQuality.verdict, "empty");
  assert.equal(empty.emptyTree, true);
});

test("agent 层：观察过的残缺应用，desktop_list_apps 的通道判定随之改判", async () => {
  const agent = new DesktopAgent({ backend: createMockBackend(), policy: defaultPolicy() });
  // 用真实观察往注册表写入质量：canvas-app 的 mock 树是空的
  const app = await agent.registry.get("canvas-app", { refresh: true });
  await agent.perception.observe({ app, maxDepth: 3 });
  const list = await agent.callTool("desktop_list_apps", {});
  const hit = list.apps.find((a) => a.appId === "canvas-app");
  assert.equal(hit.channel, "gui-visual");
  assert.equal(hit.treeQuality.verdict, "empty");
});
