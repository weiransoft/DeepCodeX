/**
 * 用户身份模块单元测试（src/user-identity.ts，docs/dev/web-isolation.md §5.1）。
 *
 * 覆盖：userId 定长 hex、不同用户名不冲突、特殊字符用户名产出安全目录名
 * （防路径注入）、大小写敏感语义、buildAuthContext 字段保留。
 * 纯函数测试：无 IO、无 mock。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAuthContext, userIdFromUsername } from "../src/user-identity";

test("identity：userId 必须是 16 位小写 hex（定长、路径安全）", () => {
  for (const username of ["admin", "alice", "zhang.san@corp.example", "u".repeat(200)]) {
    const userId = userIdFromUsername(username);
    assert.match(userId, /^[0-9a-f]{16}$/, `用户名 ${username} 的 userId 必须为 16 位 hex（得到 ${userId}）`);
  }
});

test("identity：不同用户名必须派生不同 userId（隔离域不冲突）", () => {
  const seen = new Map<string, string>();
  for (const username of ["admin", "alice", "bob", "alice2", "管理员", "a b"]) {
    const userId = userIdFromUsername(username);
    assert.ok(!seen.has(userId), `userId 冲突：${username} 与 ${seen.get(userId)} 派生出相同标识`);
    seen.set(userId, username);
  }
});

test("identity：特殊字符用户名不得产生路径注入（输出恒为 hex）", () => {
  // 涵盖路径穿越、分隔符、通配符、控制字符、超长串等恶意形态
  const hostileNames = [
    "../../etc/passwd",
    "a/b?..\\",
    "..\\..\\windows",
    "user\x00null",
    "*",
    "%2e%2e%2f",
    " ".repeat(64),
  ];
  for (const username of hostileNames) {
    const userId = userIdFromUsername(username);
    assert.match(userId, /^[0-9a-f]{16}$/, `恶意用户名 ${JSON.stringify(username)} 仍必须产出 16 位 hex`);
    // 输出中不允许出现任何路径相关字符（双保险断言）
    assert.ok(
      !userId.includes(".") && !userId.includes("/") && !userId.includes("\\"),
      "userId 不得含路径分隔符或扩展名点号"
    );
  }
});

test("identity：同名用户派生结果必须稳定（幂等）", () => {
  const first = userIdFromUsername("stable-user");
  for (let i = 0; i < 3; i++) {
    assert.equal(userIdFromUsername("stable-user"), first, "同一用户名重复派生必须得到相同 userId");
  }
});

test("identity：大小写敏感（Alice 与 alice 为不同隔离域）", () => {
  assert.notEqual(
    userIdFromUsername("Alice"),
    userIdFromUsername("alice"),
    "LDAP uid 语义保留：大小写不折叠，派生结果必须不同"
  );
});

test("identity：buildAuthContext 应保留 JWT 载荷全部字段并附加 userId", () => {
  const payload = { sub: "admin", iat: 1700000000, exp: 1700003600 };
  const ctx = buildAuthContext(payload);
  assert.equal(ctx.sub, "admin", "sub 必须原样保留");
  assert.equal(ctx.iat, 1700000000, "iat 必须原样保留");
  assert.equal(ctx.exp, 1700003600, "exp 必须原样保留");
  assert.equal(ctx.userId, userIdFromUsername("admin"), "userId 必须与独立派生结果一致");
});
