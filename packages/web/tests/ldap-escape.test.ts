/**
 * LDAP filter 转义与用户过滤构造单元测试（src/auth/ldap-service.ts 纯函数部分）。
 *
 * 覆盖 RFC 4515 五种特殊字符转义、组合转义、%s 占位替换、
 * 无占位复合 filter 的 AND 组合、空模板兜底。纯字符串运算，无 IO。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildUserFilter, escapeLdapFilterValue, LdapAuthError } from "../src/auth/ldap-service";

test("LDAP 转义：五种特殊字符逐一转义", () => {
  assert.equal(escapeLdapFilterValue("a\\b"), "a\\5cb", "反斜杠 → \\5c");
  assert.equal(escapeLdapFilterValue("a*b"), "a\\2ab", "星号 → \\2a");
  assert.equal(escapeLdapFilterValue("a(b"), "a\\28b", "左括号 → \\28");
  assert.equal(escapeLdapFilterValue("a)b"), "a\\29b", "右括号 → \\29");
  assert.equal(escapeLdapFilterValue("a\0b"), "a\\00b", "NUL → \\00");
});

test("LDAP 转义：普通字符原样保留", () => {
  assert.equal(escapeLdapFilterValue("alice@example.com"), "alice@example.com");
  assert.equal(escapeLdapFilterValue("user-01_x"), "user-01_x");
  assert.equal(escapeLdapFilterValue(""), "");
});

test("LDAP 转义：注入载荷全量转义（防 LDAP 注入核心用例）", () => {
  // 经典注入载荷：*)(uid=*))(|uid=* —— 全部特殊字符必须被转义为字面量
  const payload = "*)(uid=*))(|uid=*";
  const escaped = escapeLdapFilterValue(payload);
  // 精确期望：* → \2a、) → \29、( → \28，其余字符（含 |）原样保留
  assert.equal(escaped, "\\2a\\29\\28uid=\\2a\\29\\29\\28|uid=\\2a");
  // 转义后拼入 filter 不改变 filter 结构（括号已成字面量）
  assert.equal(buildUserFilter("(uid=%s)", payload), `(uid=${escaped})`);
});

test("LDAP 转义：多字符混合转义顺序正确（先 \\ 后其他）", () => {
  // "a\" 含反斜杠；逐字符期望：a → \5c → " 无
  assert.equal(escapeLdapFilterValue("a\\"), "a\\5c");
  // 反斜杠与星号相邻："\\*" 期望 "\5c\2a"
  assert.equal(escapeLdapFilterValue("\\*"), "\\5c\\2a");
});

test("buildUserFilter：%s 占位直接替换为转义值", () => {
  assert.equal(buildUserFilter("(uid=%s)", "alice"), "(uid=alice)");
  assert.equal(buildUserFilter("(sAMAccountName=%s)", "alice"), "(sAMAccountName=alice)");
  // 含特殊字符的用户名替换时已转义
  assert.equal(buildUserFilter("(uid=%s)", "li*si"), "(uid=li\\2asi)");
  // 多个占位全部替换
  assert.equal(buildUserFilter("(&(uid=%s)(cn=%s))", "bob"), "(&(uid=bob)(cn=bob))");
});

test("buildUserFilter：无占位复合 filter 剥外层括号后 AND 组合", () => {
  // 剥去最外层成对括号得 "&(...)...",再整体 AND 上 (uid=...)：
  // 产出为嵌套 AND 形式，与 qa-audit 同款算法一致，LDAP filter 语义完全等价
  const result = buildUserFilter("(&(objectClass=user)(!(objectClass=computer)))", "carol");
  assert.equal(result, "(&(&(objectClass=user)(!(objectClass=computer)))(uid=carol))");
});

test("buildUserFilter：空模板兜底为 (uid=%s)", () => {
  assert.equal(buildUserFilter("", "dave"), "(uid=dave)");
  assert.equal(buildUserFilter("   ", "dave"), "(uid=dave)");
});

test("LdapAuthError：统一文案且携带原始 cause", () => {
  const cause = new Error("connect timeout");
  const error = new LdapAuthError("LDAP 认证失败：用户名或密码错误", cause);
  assert.ok(error instanceof Error);
  assert.equal(error.name, "LdapAuthError");
  assert.equal(error.message, "LDAP 认证失败：用户名或密码错误");
  assert.equal(error.cause, cause, "cause 仅用于服务端日志");
});
