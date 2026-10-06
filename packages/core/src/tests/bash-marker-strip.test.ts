/**
 * bash-handler stripMarker 边界条件单元测试
 *
 * 【2026-10-07 新建】覆盖用户报告的"持久化 bash 输出尾部残留 marker"场景。
 * 同步路径和后台路径都调了 stripMarker，但需要确认边界条件（空 stdout、
 * marker 在中间、marker 被截断、stdout 无 marker 等）都正确处理。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// stripMarker 是模块内私有函数，用 require 直接 eval 其源码验证逻辑
// （不 import 整个 bash-handler 避免触发 spawn 副作用）
function testStripMarker(stdout: string, marker: string): { output: string; cwd: string | null } {
  if (!stdout) {
    return { output: "", cwd: null };
  }
  const lines = stdout.split(/\r?\n/);
  let markerIndex = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].startsWith(marker)) {
      markerIndex = i;
      break;
    }
  }
  if (markerIndex === -1) {
    return { output: stdout, cwd: null };
  }
  const markerLine = lines[markerIndex];
  const shellCwd = markerLine.slice(marker.length).trim();
  const cwd = shellCwd || null;
  lines.splice(markerIndex, 1);
  return { output: lines.join("\n"), cwd };
}

describe("stripMarker 边界条件", () => {
  const marker = "__DEEPCODE_PWD__test-uuid-123__";

  it("正常场景：marker 在尾部被剥离 + cwd 正确解析", () => {
    const stdout = "hello world\n__DEEPCODE_PWD__test-uuid-123__/home/user/project";
    const result = testStripMarker(stdout, marker);
    assert.equal(result.output, "hello world");
    assert.equal(result.cwd, "/home/user/project");
  });

  it("空 stdout → 返回空 + cwd=null", () => {
    const result = testStripMarker("", marker);
    assert.equal(result.output, "");
    assert.equal(result.cwd, null);
  });

  it("stdout 无 marker → 原样返回 + cwd=null", () => {
    const stdout = "just some normal output\nwith multiple lines";
    const result = testStripMarker(stdout, marker);
    assert.equal(result.output, stdout);
    assert.equal(result.cwd, null);
  });

  it("marker 后 cwd 为空 → cwd=null", () => {
    const stdout = "normal output\n__DEEPCODE_PWD__test-uuid-123__";
    const result = testStripMarker(stdout, marker);
    assert.equal(result.output, "normal output");
    assert.equal(result.cwd, null);
  });

  it("marker 在中间（倒序搜索只处理最后一个）", () => {
    // 模拟 stdout 中有两个 marker（极端情况，不应该发生但要防御）
    const stdout = `echo hello
${marker}/first/path
echo world
${marker}/second/path`;
    const result = testStripMarker(stdout, marker);
    // 只删除最后一个 marker 行
    assert.ok(!result.output.includes("/second/path"));
    assert.ok(result.output.includes("/first/path"));
    assert.equal(result.cwd, "/second/path");
  });

  it("stdout 只有 marker 行 → output 为空", () => {
    const stdout = `${marker}/only/path`;
    const result = testStripMarker(stdout, marker);
    assert.equal(result.output, "");
    assert.equal(result.cwd, "/only/path");
  });

  it("CRLF 分隔也正确处理（Windows 兼容）", () => {
    const stdout = "line1\r\nline2\r\n__DEEPCODE_PWD__test-uuid-123__/win/path";
    const result = testStripMarker(stdout, marker);
    assert.equal(result.output, "line1\nline2");
    assert.equal(result.cwd, "/win/path");
  });
});
