/**
 * GET /api/capabilities 的斜杠命令下发单测（2026-11-02 接线审查 D3）。
 *
 * ## 为什么要锁这条
 *
 * Web 曾经手写一份 `/team` 命令描述符，与 CLI 各维护一份——改一个子命令要改三处，
 * 漏改就变成「菜单里有、敲了静默降级」：模型配合演出一段看似成功的输出，
 * 比直接报错更危险。
 *
 * 现在服务端直接转发 core 的 `buildTeamCommandDescriptors()`。本测试断言的是
 * **同源**这件事本身：下发的条目与 core 描述符逐条对应（名称与顺序），而不是
 * 断言一份写死的清单——后者改完还得再改测试，等于把耦合换个地方放。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTeamCommandDescriptors } from "@vegamo/deepcode-core";
import { listCommandsSafe } from "../src/api/capability-api";

test("斜杠命令清单与 core 描述符同源（名称、顺序逐条对应）", () => {
  const commands = listCommandsSafe();
  const descriptors = buildTeamCommandDescriptors();

  assert.equal(commands.length, descriptors.length, "条目数必须与 core 描述符一致");
  assert.deepEqual(
    commands.map((item) => item.name),
    descriptors.map((item) => item.name),
    "名称与顺序必须一致"
  );
});

test("斜杠命令清单覆盖 /team 全体系（用户能在补全面板里看到每个子命令）", () => {
  const names = listCommandsSafe().map((item) => item.name);
  for (const expected of [
    "/team list",
    "/team match",
    "/team dispatch",
    "/team autonomous",
    "/team full-lifecycle",
    "/team auto",
  ]) {
    assert.ok(names.includes(expected), `缺少命令：${expected}`);
  }
});

test("命令条目字段完整：description 非空，有参数时原样下发", () => {
  const commands = listCommandsSafe();
  for (const item of commands) {
    assert.ok(item.description.trim() !== "", `${item.name} 缺少描述`);
  }
  const dispatch = commands.find((item) => item.name === "/team dispatch");
  assert.ok(dispatch);
  assert.ok(Array.isArray(dispatch.args) && dispatch.args.length > 0, "dispatch 必须带参数提示");
  assert.ok(dispatch.args?.some((arg) => arg.includes("--task")));
});
