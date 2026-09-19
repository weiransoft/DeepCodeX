/**
 * JWT 签发与校验单元测试（src/auth/jwt.ts）。
 *
 * 覆盖：签发/校验往返、过期拒绝、篡改拒绝、错密钥拒绝、非 HS256 算法拒绝、
 * 结构非法拒绝、缺 sub/exp 拒绝。全部使用 node:crypto 真实运算，无 mock。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { signJWT, verifyJWT } from "../src/auth/jwt";

const SECRET = "unit-test-secret";
const SECRET_OTHER = "another-secret";

test("JWT：签发后校验应往返成功并还原载荷", () => {
  const token = signJWT({ sub: "alice", displayName: "Alice", authSource: "local" }, SECRET, 60);
  const payload = verifyJWT(token, SECRET);

  assert.ok(payload, "有效 token 必须校验通过");
  assert.equal(payload!.sub, "alice");
  assert.equal(payload!.displayName, "Alice");
  assert.equal(payload!.authSource, "local");
  // iat/exp 时间关系：exp = iat + 60，且 iat 接近当前时间
  assert.equal(payload!.exp - payload!.iat, 60);
  const now = Math.floor(Date.now() / 1000);
  assert.ok(Math.abs(payload!.iat - now) <= 2, `iat 应接近当前时间（iat=${payload!.iat}, now=${now}）`);
});

test("JWT：过期 token 应被拒绝（exp <= now）", () => {
  // ttl 取 -1 秒：签发即过期（iat=now, exp=now-1）
  const token = signJWT({ sub: "bob" }, SECRET, -1);
  assert.equal(verifyJWT(token, SECRET), null, "过期 token 必须返回 null");
});

test("JWT：载荷被篡改应被拒绝（签名不匹配）", () => {
  const token = signJWT({ sub: "alice" }, SECRET, 60);
  const [headerB64, , signatureB64] = token.split(".");
  // 用同一密钥为伪造载荷重新签名无法通过——这里直接替换 payload 段（保留原签名）
  const forgedPayload = Buffer.from(JSON.stringify({ sub: "admin", iat: 1, exp: 9999999999 }), "utf8").toString(
    "base64url"
  );
  const forged = `${headerB64}.${forgedPayload}.${signatureB64}`;
  assert.equal(verifyJWT(forged, SECRET), null, "篡改载荷必须被签名校验拒绝");
});

test("JWT：密钥错误应被拒绝", () => {
  const token = signJWT({ sub: "alice" }, SECRET, 60);
  assert.equal(verifyJWT(token, SECRET_OTHER), null, "错密钥 token 必须返回 null");
});

test("JWT：header 算法替换为 none 应被拒绝", () => {
  // 手工构造 alg=none 的 token（攻击者常见手法）：签名用空密钥 HMAC 伪造
  const headerNone = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" }), "utf8").toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: "admin", iat: 1, exp: 9999999999 }), "utf8").toString("base64url");
  const body = `${headerNone}.${payload}`;
  const forgedSignature = createHmac("sha256", SECRET).update(body).digest("base64url");
  const forged = `${body}.${forgedSignature}`;
  assert.equal(verifyJWT(forged, SECRET), null, "非 HS256 算法必须被拒绝（防算法替换攻击）");
});

test("JWT：结构非法（段数错误/垃圾字符串）应返回 null 而非抛异常", () => {
  assert.equal(verifyJWT("not-a-jwt", SECRET), null);
  assert.equal(verifyJWT("a.b", SECRET), null);
  assert.equal(verifyJWT("a.b.c.d", SECRET), null);
  assert.equal(verifyJWT("", SECRET), null);
});

test("JWT：载荷缺 sub 或 exp 应被拒绝", () => {
  const SECRET_LOCAL = "payload-check-secret";
  // 缺 sub：手工拼三段（header 用真实 HS256 头，签名正确计算，仅载荷字段不全）
  const headerB64 = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" }), "utf8").toString("base64url");
  const missingSub = Buffer.from(JSON.stringify({ iat: 1, exp: 9999999999 }), "utf8").toString("base64url");
  const body1 = `${headerB64}.${missingSub}`;
  const token1 = `${body1}.${createHmac("sha256", SECRET_LOCAL).update(body1).digest("base64url")}`;
  assert.equal(verifyJWT(token1, SECRET_LOCAL), null, "缺 sub 必须拒绝");

  const missingExp = Buffer.from(JSON.stringify({ sub: "alice", iat: 1 }), "utf8").toString("base64url");
  const body2 = `${headerB64}.${missingExp}`;
  const token2 = `${body2}.${createHmac("sha256", SECRET_LOCAL).update(body2).digest("base64url")}`;
  assert.equal(verifyJWT(token2, SECRET_LOCAL), null, "缺 exp 必须拒绝");
});
