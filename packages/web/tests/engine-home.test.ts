/**
 * 引擎数据家目录与用户级技能扫描隔离（2026-11-02 接线审查 D4）。
 *
 * ## 问题
 *
 * 「用户级」技能/智能体的扫描根原先一律取 `os.homedir()`。Web 个人模式
 * （`personalOnly=true`，桌面默认）下每个用户的引擎数据根是
 * `<engineHomeRoot>/<userId>`，与进程家目录不是一回事，于是：
 * - 用户在 Web 里新建的智能体落在自己 homeRoot —— 列表和 @ 提及却扫进程家目录，看不到；
 * - 所有用户共享进程家目录下那一份技能/智能体 —— 多用户串号。
 *
 * ## 本文件锁什么
 *
 * 1. `engineHomeForUser` 的分支语义（personalOnly 开/关）；
 * 2. 行为级隔离：两个用户在各自 homeRoot 下建的技能，各自只扫得到自己的。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { engineHomeForUser } from "../src/engine-home";
import { listSkillsSafe } from "../src/api/capability-api";

/** 在指定 homeRoot 下写一个用户级技能，返回技能名 */
function writeUserSkill(homeRoot: string, name: string): string {
  const dir = path.join(homeRoot, ".deepcode", "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    ["---", `name: ${name}`, `description: ${name} 的说明`, "---", "", "正文", ""].join("\n"),
    "utf-8"
  );
  return name;
}

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("engineHomeForUser：personalOnly=true 时返回 <engineHomeRoot>/<userId>", () => {
  const root = createTempDir("deepcode-engine-home-");
  try {
    const home = engineHomeForUser({ personalOnly: true, engineHomeRoot: root }, "user-a");
    assert.equal(home, path.join(root, "user-a"));
    // 两个用户必须落到不同目录（隔离的本质）
    assert.notEqual(home, engineHomeForUser({ personalOnly: true, engineHomeRoot: root }, "user-b"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("engineHomeForUser：personalOnly=false 时回退进程家目录（与 CLI 同源）", () => {
  const home = engineHomeForUser({ personalOnly: false, engineHomeRoot: "/nonexistent/engine-root" }, "user-a");
  assert.equal(home, os.homedir());
});

test("用户级技能按 homeRoot 隔离：各自只扫到自己那一份", async () => {
  const engineRoot = createTempDir("deepcode-engine-root-");
  // projectRoot 必须是独立空目录：否则项目级根（<projectRoot>/.deepcode/skills）
  // 会覆盖到同名路径，测试就无法区分「靠 homeRoot 扫到」还是「靠 projectRoot 扫到」
  const emptyProject = createTempDir("deepcode-empty-project-");
  const userAHome = path.join(engineRoot, "user-a");
  const userBHome = path.join(engineRoot, "user-b");
  writeUserSkill(userAHome, "skill-user-a");
  writeUserSkill(userBHome, "skill-user-b");

  try {
    const homeA = engineHomeForUser({ personalOnly: true, engineHomeRoot: engineRoot }, "user-a");
    const homeB = engineHomeForUser({ personalOnly: true, engineHomeRoot: engineRoot }, "user-b");
    const [skillsA, skillsB] = await Promise.all([
      listSkillsSafe(emptyProject, homeA),
      listSkillsSafe(emptyProject, homeB),
    ]);
    const namesA = skillsA.map((item) => item.name);
    const namesB = skillsB.map((item) => item.name);

    assert.ok(namesA.includes("skill-user-a"), `user-a 应扫到自己的技能，实际：${namesA.join(",")}`);
    assert.equal(namesA.includes("skill-user-b"), false, "user-a 不得看到 user-b 的技能");
    assert.ok(namesB.includes("skill-user-b"), `user-b 应扫到自己的技能，实际：${namesB.join(",")}`);
    assert.equal(namesB.includes("skill-user-a"), false, "user-b 不得看到 user-a 的技能");
  } finally {
    fs.rmSync(engineRoot, { recursive: true, force: true });
    fs.rmSync(emptyProject, { recursive: true, force: true });
  }
});
