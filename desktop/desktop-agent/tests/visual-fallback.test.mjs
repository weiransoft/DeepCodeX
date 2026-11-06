/**
 * 视觉兜底回归（P2 第 5 项）。
 *
 * 报告 §3.10 的覆盖率矩阵里，任务管理器 / 字符映射表 / 系统信息 / 磁盘清理四家
 * 实测为 `sparse`——树非空但没有任何可按名字定位的可操作节点，只能视觉兜底。
 * 但「视觉兜底」在真机上一直缺两条腿，这里逐条锁死：
 *
 * 1. **坐标帧**：模型给的是截图里的像素坐标，不是屏幕坐标。少了原点与缩放换算，
 *    点下去整块偏移一个窗口原点——不是点不准，是点到别的窗口上（R4 不可逆）。
 * 2. **像素验效**：这类应用点击前后树完全一样，只靠结构证据每步都会被判
 *    verify-failed。没有像素证据，「能点」但「不能验」，等于没闭环。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { DesktopAgent } from "../src/agent.mjs";
import { createMockBackend } from "../src/backends/mock.mjs";
import { defaultPolicy } from "../src/modules/policy-guard.mjs";
import { ErrorCode } from "../src/errors.mjs";
import { frameFromShot, frameContains, resolveClickPoint } from "../src/modules/coords.mjs";
import { diffSignatures, encodeSignature, SIGNATURE_CELLS } from "../src/modules/pixel-signature.mjs";

function makeAgent({ rect } = {}) {
  const backend = createMockBackend(rect ? { rect } : undefined);
  const policy = {
    ...defaultPolicy(),
    enabled: true,
    permissionMode: "auto",
    allowedApps: [
      { appId: "notepad", always: true, scopes: ["read", "write"] },
      { appId: "canvas-app", always: true, scopes: ["read", "write"] },
    ],
    deniedApps: [],
    allowCoordinateInput: true,
    allowScreenshot: true,
  };
  return { backend, agent: new DesktopAgent({ backend, policy, limits: policy }) };
}

const flat = (v) => new Uint8Array(SIGNATURE_CELLS).fill(v);

/* ── 坐标帧 ─────────────────────────────────────────────────────────── */

test("坐标帧：图像尺寸与窗口矩形不等时给出缩放比（高 DPI 的常态）", () => {
  const f = frameFromShot({ rect: { x: 200, y: 120, width: 1000, height: 700 }, width: 1250, height: 875 });
  assert.equal(f.x, 200);
  assert.equal(f.y, 120);
  assert.equal(f.scaleX, 1.25);
  assert.equal(f.scaleY, 1.25);
  // 没有 rect 就没有帧——不能拿图像尺寸冒充窗口位置
  assert.equal(frameFromShot({ width: 800, height: 600 }), null);
  assert.equal(frameFromShot({ rect: { x: 0, y: 0, width: 0, height: 0 } }), null);
});

test("窗口坐标 → 屏幕坐标：先加原点、再除缩放，顺序错了就整体偏移", () => {
  const shot = { rect: { x: 200, y: 120, width: 1000, height: 700 }, width: 1250, height: 875 };
  const p = resolveClickPoint({ x: 250, y: 125, frame: "window", shot });
  assert.equal(p.x, 400, "200 + 250/1.25");
  assert.equal(p.y, 220, "120 + 125/1.25");
  assert.equal(p.converted, true);
  assert.equal(p.boundsChecked, true);
});

test("窗口坐标但没有截图：明确拒绝，而不是把图像坐标当屏幕坐标点下去", () => {
  assert.throws(
    () => resolveClickPoint({ x: 10, y: 10, frame: "window", shot: null }),
    (err) => err.code === ErrorCode.OBSERVATION_FAILED && /截图/.test(err.message)
  );
});

test("越界坐标：拒绝点击（宁可这次不点，也不点到别的窗口）", () => {
  const shot = { rect: { x: 200, y: 120, width: 1000, height: 700 }, width: 1000, height: 700 };
  assert.throws(
    () => resolveClickPoint({ x: 1200, y: 10, frame: "window", shot }),
    (err) =>
      err.code === ErrorCode.ACTION_DENIED &&
      /窗口外/.test(err.message) &&
      err.details.windowRect.width === 1000
  );
  // 弹出菜单确实落在窗口外时，显式放行是唯一出口
  const allowed = resolveClickPoint({ x: 1200, y: 10, frame: "window", shot, allowOutside: true });
  assert.equal(allowed.x, 1400);
});

test("屏幕坐标模式不再换算，但仍复核边界", () => {
  const shot = { rect: { x: 200, y: 120, width: 1000, height: 700 }, width: 1000, height: 700 };
  const p = resolveClickPoint({ x: 300, y: 200, frame: "screen", shot });
  assert.equal(p.x, 300);
  assert.equal(p.converted, false);
  assert.throws(
    () => resolveClickPoint({ x: 5, y: 5, frame: "screen", shot }),
    (err) => err.code === ErrorCode.ACTION_DENIED
  );
  // 帧未知时无法复核，如实标注 boundsChecked=false，不假装校验过
  const unchecked = resolveClickPoint({ x: 5, y: 5, frame: "screen", shot: null });
  assert.equal(unchecked.boundsChecked, false);
});

test("frameContains 的容差按屏幕单位算", () => {
  const f = frameFromShot({ rect: { x: 10, y: 10, width: 100, height: 100 }, width: 100, height: 100 });
  assert.equal(frameContains(f, 10, 10), true);
  assert.equal(frameContains(f, 8, 10), true, "默认容差 2");
  assert.equal(frameContains(f, 5, 10), false);
});

/* ── 像素签名 ───────────────────────────────────────────────────────── */

test("像素签名：同一张图判无变化", () => {
  const d = diffSignatures(encodeSignature(flat(120)), encodeSignature(flat(120)));
  assert.equal(d.changed, false);
  assert.equal(d.verdict, "identical");
  assert.equal(d.ratio, 0);
});

test("像素签名：光标闪烁那点变化不算变化（否则每步都假阳性）", () => {
  const a = flat(120);
  const b = new Uint8Array(a);
  for (const i of [100, 101, 102, 103]) b[i] = 220;
  const d = diffSignatures(a, b);
  assert.equal(d.changed, false);
  assert.equal(d.verdict, "within-noise");
  assert.equal(d.changedCells, 4);
  assert.equal(d.maxDelta, 100, "单格差异仍然如实报出来，便于诊断");
});

test("像素签名：整块换页/弹框算变化", () => {
  const a = flat(120);
  const b = new Uint8Array(a);
  for (let i = 0; i < 600; i += 1) b[i] = 30;
  const d = diffSignatures(a, b);
  assert.equal(d.changed, true);
  assert.equal(d.verdict, "layout-changed");
  assert.ok(d.ratio > 0.02);
});

test("像素签名长度不一致：报错而不是静默判「没变」", () => {
  assert.throws(
    () => diffSignatures(encodeSignature(flat(10)), encodeSignature(new Uint8Array(16).fill(10))),
    (err) => err.code === ErrorCode.INVALID_ARGUMENT
  );
  assert.throws(
    () => diffSignatures("", ""),
    (err) => err.code === ErrorCode.INVALID_ARGUMENT
  );
});

/* ── 端到端：截图 → 换算 → 吸附 → 点击 → 像素验效 ─────────────────── */

test("截图回传坐标帧，且只有显式要求才带回像素", async () => {
  const { agent } = makeAgent({ rect: { x: 200, y: 120, width: 1000, height: 700 } });
  await agent.callTool("desktop_snapshot", { appId: "notepad", maxDepth: 4 });

  const meta = await agent.callTool("desktop_screenshot", { appId: "notepad", reason: "test" });
  assert.equal(meta.ok, true);
  assert.deepEqual(meta.frame, {
    x: 200,
    y: 120,
    width: 1000,
    height: 700,
    imageWidth: 1000,
    imageHeight: 700,
    scaleX: 1,
    scaleY: 1,
  });
  assert.equal(meta.base64, undefined, "默认不回传像素：几百 KB 的 base64 不该出现在默认返回里");

  const withPixels = await agent.callTool("desktop_screenshot", {
    appId: "notepad",
    reason: "test",
    includeImage: true,
  });
  assert.equal(typeof withPixels.base64, "string");
  assert.ok(withPixels.base64.length > 0);
});

test("按窗口坐标点击：真的加上了窗口原点，报告里能看见换算结果", async () => {
  const { agent, backend } = makeAgent({ rect: { x: 200, y: 120, width: 1000, height: 700 } });
  await agent.callTool("desktop_snapshot", { appId: "notepad", maxDepth: 4 });
  await agent.callTool("desktop_screenshot", { appId: "notepad", reason: "test" });

  const res = await agent.callTool("desktop_click_xy", { appId: "notepad", x: 250, y: 125 });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.action.converted, true);
  assert.deepEqual(res.action.resolved, { x: 450, y: 245 }, "图像 (250,125) + 原点 (200,120)");
  assert.equal(backend.state.clicks, 1);
});

test("没有截图就按窗口坐标点击：如实失败，提示先截图", async () => {
  const { agent, backend } = makeAgent();
  await agent.callTool("desktop_snapshot", { appId: "notepad", maxDepth: 4 });
  const res = await agent.callTool("desktop_click_xy", { appId: "notepad", x: 10, y: 10 });
  assert.equal(res.ok, false);
  assert.equal(res.code, ErrorCode.OBSERVATION_FAILED);
  assert.match(res.message, /截图/);
  assert.equal(backend.state.clicks, 0, "拒绝了就不该真的点下去");
});

test("越界坐标在工具层就被拒绝，不落到底层输入 API", async () => {
  const { agent, backend } = makeAgent({ rect: { x: 200, y: 120, width: 1000, height: 700 } });
  await agent.callTool("desktop_snapshot", { appId: "notepad", maxDepth: 4 });
  await agent.callTool("desktop_screenshot", { appId: "notepad", reason: "test" });
  const res = await agent.callTool("desktop_click_xy", { appId: "notepad", x: 5000, y: 10 });
  assert.equal(res.ok, false);
  assert.equal(res.code, ErrorCode.ACTION_DENIED);
  assert.equal(backend.state.clicks, 0);
});

test("稀疏界面：吸附不到元素时如实标 blind，仍然允许点（这是视觉兜底的本义）", async () => {
  const { agent } = makeAgent();
  const s = await agent.callTool("desktop_snapshot", { appId: "canvas-app", maxDepth: 4 });
  assert.equal(s.tree.length, 0, "canvas-app 是空树：与 taskmgr / msinfo32 同类的极端稀疏");
  await agent.callTool("desktop_screenshot", { appId: "canvas-app", reason: "empty-tree" });

  const res = await agent.callTool("desktop_click_xy", { appId: "canvas-app", x: 100, y: 100 });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.action.blind, true, "没有可吸附节点就是盲点，必须显式标出来");
  assert.equal(res.action.snapped, null);
});

test("视觉验效：树没变但像素变了，判为已验证（结构与像素双证据）", async () => {
  const { agent } = makeAgent();
  await agent.callTool("desktop_snapshot", { appId: "notepad", maxDepth: 4 });
  await agent.callTool("desktop_screenshot", { appId: "notepad", reason: "test" });
  const res = await agent.callTool("desktop_click_xy", { appId: "notepad", x: 100, y: 80 });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.verification.evidence, "tree+pixels");
  assert.equal(typeof res.verification.pixelChanged, "boolean");
});

test("视觉验效：点了但界面没变 → verify-failed，不把「说成功」当成功", async () => {
  const { agent, backend } = makeAgent();
  await agent.callTool("desktop_snapshot", { appId: "notepad", maxDepth: 4 });
  await agent.callTool("desktop_screenshot", { appId: "notepad", reason: "test" });
  backend.faults.silentClick = true;

  const res = await agent.callTool("desktop_click_xy", { appId: "notepad", x: 100, y: 80 });
  assert.equal(res.ok, false);
  assert.equal(res.code, ErrorCode.VERIFY_FAILED);
  assert.equal(res.verification.changed, false);
  assert.equal(res.verification.pixelChanged, false, "像素证据也必须说没变，而不是退回 null");
  assert.ok(res.attempts >= 2, "应有界重试而不是一次就放弃");
});

test("视觉验效：基线自己还在动时，不用像素下结论（退回结构证据）", async () => {
  const { agent, backend } = makeAgent();
  await agent.callTool("desktop_snapshot", { appId: "notepad", maxDepth: 4 });
  await agent.callTool("desktop_screenshot", { appId: "notepad", reason: "test" });
  // 界面还在渲染/动画：每次取签名都不一样。此时动作前后的像素差**无法归因**，
  // 硬要判就会把动画当成「动作生效」（假阳性）。
  backend.faults.signatureJitter = true;

  const res = await agent.callTool("desktop_click_xy", { appId: "notepad", x: 100, y: 80 });
  assert.equal(res.verification.evidence, "tree", "不稳定基线下只能用结构证据");
  assert.equal(res.verification.pixelChanged, null);
  assert.equal(res.verification.pixelNote, "unstable-baseline");
});
