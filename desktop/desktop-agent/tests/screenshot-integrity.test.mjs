/**
 * 截图结果完整性：桥/后端失败必须显式报错，绝不能变成「ok:true 但没像素」。
 *
 * 发现过程：真机验证里 activate 置前台失败，桥回了 ACTION_DENIED，但
 * windows.mjs 的 _callBridge 默认不抛、perception 又只挑固定字段构造返回值，
 * 于是模型收到 `{ok:true, frame:null}` 的空壳——不报错、却会把坐标点偏。
 * 这类「成功但没数据」比失败更危险，所以两边都修并在这里锁住。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { DesktopAgent } from "../src/agent.mjs";
import { createMockBackend } from "../src/backends/mock.mjs";
import { defaultPolicy } from "../src/modules/policy-guard.mjs";

function agentWithShot(shot) {
  const backend = createMockBackend();
  backend.screenshot = async () => shot;
  const policy = {
    ...defaultPolicy(),
    enabled: true,
    permissionMode: "auto",
    allowScreenshot: true,
    allowedApps: [{ appId: "notepad", always: true, scopes: ["read", "write"] }],
  };
  return new DesktopAgent({ backend, policy, limits: policy });
}

const call = (agent, includeImage = true) =>
  agent.callTool("desktop_screenshot", { appId: "notepad", reason: "integrity", includeImage });

const goodShot = () => ({
  ok: true,
  mimeType: "image/png",
  width: 320,
  height: 240,
  bytes: 70,
  base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  rect: { x: 10, y: 20, width: 320, height: 240 },
});

test("正常截图仍然成功，且帧与尺寸可用（回归）", async () => {
  const r = await call(agentWithShot(goodShot()));
  assert.equal(r.ok, true);
  assert.equal(r.width, 320);
  assert.equal(r.height, 240);
  assert.equal(r.frame?.width, 320); // 坐标帧必须随截图一起回来
  assert.equal(r.frame?.scaleX, 1);
  assert.equal(typeof r.base64, "string");
});

test("桥回 ACTION_DENIED → 工具结果必须是显式失败，不能是 ok:true 空壳", async () => {
  const shot = {
    ok: false,
    code: "ACTION_DENIED",
    message: "无法把目标窗口置前台，截图像素可能是别的窗口",
    hint: "等目标窗口可见后重试",
    persisted: false,
    untrusted: true,
  };
  const r = await call(agentWithShot(shot));
  assert.equal(r.ok, false);
  assert.equal(r.code, "ACTION_DENIED");
  assert.match(r.message, /置前台/);
  assert.equal(r.frame, undefined, "失败结果不能带坐标帧");
  assert.equal(r.snapHint, undefined);
});

test("后端返回空壳 {} → 抛 OBSERVATION_FAILED，不伪造成功", async () => {
  const r = await call(agentWithShot({}));
  assert.equal(r.ok, false);
  assert.equal(r.code, "OBSERVATION_FAILED");
  assert.match(r.message, /缺少尺寸/);
});

test("请求了像素但后端没回 base64 → 显式失败", async () => {
  const shot = goodShot();
  delete shot.base64;
  const r = await call(agentWithShot(shot), true);
  assert.equal(r.ok, false);
  assert.equal(r.code, "OBSERVATION_FAILED");
  assert.match(r.message, /未回传 base64/);
});

test("没请求像素时，只有尺寸元数据是合法路径", async () => {
  const shot = goodShot();
  delete shot.base64;
  const r = await call(agentWithShot(shot), false);
  assert.equal(r.ok, true);
  assert.equal(r.width, 320);
  assert.equal(r.base64, undefined);
});
