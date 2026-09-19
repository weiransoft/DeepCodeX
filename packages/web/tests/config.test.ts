/**
 * Web 配置解析单元测试（src/config.ts）。
 *
 * 隔离策略：resolveWebSettings 的项目级配置读取 <projectRoot>/.deepcode/settings.json，
 * 测试以 mkdtemp 临时目录作为 projectRoot 注入受控 web 配置节；
 * 环境变量经参数注入（不污染 process.env）；本机用户级 settings.json 当前无 web 节，
 * 合并结果完全由测试控制。allowRoots/uploadDir 的 ~ 展开用例真实创建后清理。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { expandHomePath, resolveWebSettings, validateHost, validatePort } from "../src/config";

/** 本测试文件共享的临时项目根（每个用例独立子目录写入 settings.json） */
let baseTmp: string;

before(() => {
  baseTmp = mkdtempSync(path.join(tmpdir(), "deepcode-web-config-"));
});

after(() => {
  rmSync(baseTmp, { recursive: true, force: true });
  // 清理 ~ 展开用例创建的家目录残留
  rmSync(path.join(homedir(), ".deepcode-web-config-test-allowroot"), { recursive: true, force: true });
});

/**
 * 在独立临时项目根写入 .deepcode/settings.json 并解析配置。
 *
 * @param webNode settings.json 的 web 节内容（原样写入）
 * @param env 注入的环境变量（默认空）
 * @returns resolveWebSettings 解析结果
 */
function resolveWithProjectSettings(webNode: unknown, env: Record<string, string | undefined> = {}) {
  const projectRoot = mkdtempSync(path.join(baseTmp, "proj-"));
  if (webNode !== undefined) {
    mkdirSync(path.join(projectRoot, ".deepcode"), { recursive: true });
    writeFileSync(path.join(projectRoot, ".deepcode", "settings.json"), JSON.stringify({ web: webNode }), "utf8");
  }
  return resolveWebSettings(projectRoot, env);
}

test("config：空 web 节 + env 密钥 → 全部默认值归一", () => {
  const resolved = resolveWithProjectSettings({}, { DEEPCODE_WEB_JWT_SECRET: "env-secret" });

  assert.equal(resolved.enabled, false, "enabled 默认 false");
  assert.equal(resolved.host, "127.0.0.1");
  assert.equal(resolved.port, 3210);
  assert.deepEqual(resolved.allowRoots, []);
  assert.equal(resolved.maxUploadBytes, 50 * 1024 * 1024);
  assert.equal(resolved.auth.jwtSecret, "env-secret", "env 密钥注入生效");
  assert.equal(resolved.auth.sessionTtlSeconds, 28800);
  assert.deepEqual(resolved.auth.localUsers, []);
  assert.equal(resolved.ldap.enabled, false);
  assert.equal(resolved.ldap.port, 389, "useSsl=false 时默认端口 389");
  assert.equal(resolved.ldap.useSsl, false);
  assert.equal(resolved.ldap.userFilter, "(uid=%s)");
  assert.equal(resolved.ldap.timeoutMs, 10000);
  assert.deepEqual(resolved.ldap.attrs, {});
});

test("config：项目级配置完整归一 + useSsl 默认端口 636", () => {
  const resolved = resolveWithProjectSettings({
    enabled: true,
    host: "0.0.0.0",
    port: 8080,
    allowRoots: [],
    maxUploadBytes: 1024,
    auth: { jwtSecret: "settings-secret", sessionTtlSeconds: 60 },
    ldap: { enabled: true, server: "ldap.example.com", useSsl: true, baseDn: "dc=example,dc=com" },
  });

  assert.equal(resolved.enabled, true);
  assert.equal(resolved.host, "0.0.0.0");
  assert.equal(resolved.port, 8080);
  assert.equal(resolved.maxUploadBytes, 1024);
  assert.equal(resolved.auth.jwtSecret, "settings-secret");
  assert.equal(resolved.auth.sessionTtlSeconds, 60);
  assert.equal(resolved.ldap.enabled, true);
  assert.equal(resolved.ldap.server, "ldap.example.com");
  assert.equal(resolved.ldap.port, 636, "useSsl=true 且未显式配 port 时默认 636");
  assert.equal(resolved.ldap.baseDn, "dc=example,dc=com");
});

test("config：env DEEPCODE_WEB_JWT_SECRET 覆盖 settings 密钥；bindPassword 同理", () => {
  const resolved = resolveWithProjectSettings(
    {
      auth: { jwtSecret: "from-settings" },
      ldap: { bindPassword: "bind-from-settings" },
    },
    { DEEPCODE_WEB_JWT_SECRET: "from-env", DEEPCODE_WEB_LDAP_BIND_PASSWORD: "bind-from-env" }
  );

  assert.equal(resolved.auth.jwtSecret, "from-env", "env 密钥优先于 settings");
  assert.equal(resolved.ldap.bindPassword, "bind-from-env", "env bindPassword 优先于 settings");
});

test("config：jwtSecret 缺失（settings 与 env 均无）应 fail-fast", () => {
  assert.throws(() => resolveWithProjectSettings({}), /jwtSecret 未配置/);
  // env 密钥为空串同样视为缺失
  assert.throws(() => resolveWithProjectSettings({}, { DEEPCODE_WEB_JWT_SECRET: "" }), /jwtSecret 未配置/);
});

test("config：非法端口应 fail-fast（0/65536/非整数）", () => {
  for (const badPort of [0, 65536, 1.5, -1]) {
    assert.throws(() => resolveWithProjectSettings({ port: badPort }), /web\.port 配置非法/, `port=${badPort} 应拒绝`);
  }
});

test("config：非法 host（空串/含空白）应 fail-fast", () => {
  assert.throws(() => resolveWithProjectSettings({ host: "  " }), /web\.host 配置非法/);
  assert.throws(() => resolveWithProjectSettings({ host: "127.0.0.1 x" }), /web\.host 配置非法/);
});

test("config：maxUploadBytes / sessionTtlSeconds 非正数应 fail-fast", () => {
  assert.throws(() => resolveWithProjectSettings({ maxUploadBytes: 0 }), /maxUploadBytes 配置非法/);
  assert.throws(() => resolveWithProjectSettings({ maxUploadBytes: -5 }), /maxUploadBytes 配置非法/);
  assert.throws(
    () => resolveWithProjectSettings({ auth: { jwtSecret: "s", sessionTtlSeconds: 0 } }),
    /sessionTtlSeconds 配置非法/
  );
});

test("config：ldap.enabled=true 缺 server 或 baseDn 应 fail-fast", () => {
  // 注入合法 jwtSecret 以隔离被测校验项（jwtSecret 校验先于 ldap 校验触发）
  const env = { DEEPCODE_WEB_JWT_SECRET: "test-secret" };
  assert.throws(
    () => resolveWithProjectSettings({ ldap: { enabled: true, server: "ldap.example.com" } }, env),
    /server 与 web\.ldap\.baseDn/
  );
  assert.throws(
    () => resolveWithProjectSettings({ ldap: { enabled: true, baseDn: "dc=example,dc=com" } }, env),
    /server 与 web\.ldap\.baseDn/
  );
});

test("config：settings.json 非法 JSON 应报中文错误", () => {
  const projectRoot = mkdtempSync(path.join(baseTmp, "broken-"));
  mkdirSync(path.join(projectRoot, ".deepcode"), { recursive: true });
  writeFileSync(path.join(projectRoot, ".deepcode", "settings.json"), "{ not-json", "utf8");
  assert.throws(() => resolveWebSettings(projectRoot, {}), /不是合法 JSON/);
});

test("config：allowRoots ~ 展开为家目录绝对路径并尽力创建目录", () => {
  const target = "~/.deepcode-web-config-test-allowroot";
  // 注入合法 jwtSecret 以隔离被测校验项（jwtSecret 校验位于 allowRoots 展开之后仍会拦截返回）
  const resolved = resolveWithProjectSettings({ allowRoots: [target] }, { DEEPCODE_WEB_JWT_SECRET: "test-secret" });

  const expected = path.join(homedir(), ".deepcode-web-config-test-allowroot");
  assert.equal(resolved.allowRoots[0], expected, "~ 必须展开为家目录绝对路径");
  assert.ok(existsSync(expected), "解析时应尽力创建 allowRoot 目录");
});

test("config：expandHomePath 三种形态", () => {
  assert.equal(expandHomePath("~"), homedir());
  assert.equal(expandHomePath("~/sub/dir"), path.resolve(homedir(), "sub/dir"));
  assert.equal(expandHomePath("/tmp/./x/../y"), path.resolve("/tmp/y"), "非 ~ 路径经 resolve 归一");
});

test("config：validatePort / validateHost 直接校验行为", () => {
  assert.equal(validatePort(8080, "test"), 8080);
  assert.throws(() => validatePort(0, "test"), /必须是 1-65535 之间的整数/);
  assert.equal(validateHost(" localhost "), "localhost", "合法 host 去空白后通过");
  assert.throws(() => validateHost(""), /必须是非空且不含空白字符/);
});
