/**
 * memsearch-cli-e2e.test.ts — `deepcode memsearch` 真实子进程 E2E
 *
 * 用临时 fake memsearch 脚本替身（经 DEEPCODE_MEMSEARCH_BIN 注入）保证确定性，
 * 但 CLI 参数解析 → 路由 → 命令实现 → bridge spawn → JSON 解析 → 输出全是真实链路。
 */

import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI_PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

let tmpRoot: string;
let fakeBin: string;

const FAKE_SCRIPT = `#!/bin/sh
case "$1" in
  --version)
    echo "memsearch, version 0.4.23"
    exit 0 ;;
  search)
    cat <<'JSON'
[{"chunk_hash":"aaa111","content":"轨道 A 默认 4 轮；轨道 B 默认 6 轮","source":"/tmp/eag.md","heading":"无进展双轨熔断","heading_level":2,"start_line":6,"end_line":8,"score":0.9999}]
JSON
    exit 0 ;;
  expand)
    cat <<'JSON'
{"chunk_hash":"aaa111","source":"/tmp/eag.md","heading":"无进展双轨熔断","start_line":6,"end_line":8,"content":"## 无进展双轨熔断\\n完整章节"}
JSON
    exit 0 ;;
  stats)
    echo "Total indexed chunks: 4"
    exit 0 ;;
  index)
    echo "Indexed 4 chunks."
    exit 0 ;;
  *)
    echo "unsupported: $1" >&2
    exit 1 ;;
esac
`;

before(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "dcx-memsearch-cli-"));
  fakeBin = path.join(tmpRoot, "fake-memsearch.sh");
  writeFileSync(fakeBin, FAKE_SCRIPT, "utf8");
  chmodSync(fakeBin, 0o755);
});

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function runCli(
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {}
): { stdout: string; stderr: string; exitCode: number } {
  const cliPath = path.join(CLI_PACKAGE_ROOT, "src", "cli.tsx");
  const result = spawnSync("node", ["--import", "tsx", cliPath, "memsearch", ...args], {
    cwd: CLI_PACKAGE_ROOT,
    env: { ...process.env, DEEPCODE_MEMSEARCH_BIN: fakeBin, ...extraEnv },
    encoding: "utf-8",
    timeout: 90_000,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? -1,
  };
}

test("MC-01 help 子命令输出完整用法（含依赖安装提示）", () => {
  const r = runCli(["help"]);
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /deepcode memsearch <subcommand>/);
  assert.match(r.stdout, /uv tool install memsearch/);
});

test("MC-02 search --format json 输出可解析的结构化结果", () => {
  const r = runCli(["search", "无进展熔断", "--format", "json"]);
  assert.equal(r.exitCode, 0, `stderr=${r.stderr}`);
  const body = JSON.parse(r.stdout) as {
    ok: boolean;
    status: string;
    cliVersion: string;
    results: Array<{ chunk_hash: string; score: number; heading: string }>;
  };
  assert.equal(body.ok, true);
  assert.equal(body.status, "ok");
  assert.equal(body.cliVersion, "0.4.23");
  assert.equal(body.results[0].chunk_hash, "aaa111");
  assert.equal(body.results[0].heading, "无进展双轨熔断");
});

test("MC-03 search 默认摘要输出含排名 / hash / 预览", () => {
  const r = runCli(["search", "无进展熔断"]);
  assert.equal(r.exitCode, 0, `stderr=${r.stderr}`);
  assert.match(r.stdout, /# memsearch 检索/);
  assert.match(r.stdout, /1\. \[0\.9999\]/);
  assert.match(r.stdout, /hash: aaa111/);
});

test("MC-04 search 缺查询词 → exit 2 + stderr，不输出半成品", () => {
  const r = runCli(["search"]);
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, /需要查询文本/);
  assert.equal(r.stdout.trim(), "");
});

test("MC-05 expand / stats / index 三个子命令贯通", () => {
  const expand = runCli(["expand", "aaa111", "--format", "json"]);
  assert.equal(expand.exitCode, 0, `stderr=${expand.stderr}`);
  const expanded = JSON.parse(expand.stdout) as { expansion: { content: string } };
  assert.match(expanded.expansion.content, /完整章节/);

  const stats = runCli(["stats", "--format", "json"]);
  assert.equal(stats.exitCode, 0, `stderr=${stats.stderr}`);
  assert.equal((JSON.parse(stats.stdout) as { totalChunks: number }).totalChunks, 4);

  const index = runCli(["index", "/tmp/memory", "--format", "json"]);
  assert.equal(index.exitCode, 0, `stderr=${index.stderr}`);
  assert.equal((JSON.parse(index.stdout) as { indexedChunks: number }).indexedChunks, 4);
});

test("MC-06 未知子命令被 yargs choices 拒绝", () => {
  const r = runCli(["bogus", "query"]);
  assert.notEqual(r.exitCode, 0);
});

test("MC-07 CLI 调用失败时非零退出且 stderr 带具体 status，不伪造成功", () => {
  // 让 fake CLI 在 search 时失败：指向一个只应答 --version 的脚本
  const badBin = path.join(tmpRoot, "bad-memsearch.sh");
  writeFileSync(
    badBin,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "memsearch, version 0.4.23"; exit 0; fi\necho "upstream 401" >&2\nexit 1\n',
    "utf8"
  );
  chmodSync(badBin, 0o755);
  const r = runCli(["search", "任何查询", "--format", "json"], { DEEPCODE_MEMSEARCH_BIN: badBin });
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /\[memsearch\] error: memsearch 退出码 1/);
  assert.match(r.stderr, /upstream 401/);
  assert.equal(r.stdout.trim(), "", "失败时不得输出 JSON");
});
