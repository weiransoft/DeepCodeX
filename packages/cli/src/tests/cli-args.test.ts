import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCliArgs } from "../cli-args";

// ── parseCliArgs: basic parsing ──────────────────────────────────────────────

test("parseCliArgs returns prompt after -p", () => {
  const r = parseCliArgs(["-p", "hello world"]);
  assert.ok(!("message" in r));
  assert.equal(r.prompt, "hello world");
});

test("parseCliArgs returns prompt after --prompt", () => {
  const r = parseCliArgs(["--prompt", "hello world"]);
  assert.ok(!("message" in r));
  assert.equal(r.prompt, "hello world");
});

test("parseCliArgs returns undefined prompt when -p is not present", () => {
  const r = parseCliArgs(["--resume"]);
  assert.ok(!("message" in r));
  assert.equal(r.prompt, undefined);
});

test("parseCliArgs returns session ID after --resume", () => {
  const r = parseCliArgs(["--resume", "0a5cb7a5-c39d-4c39-a11b-05f8b22b8df6"]);
  assert.ok(!("message" in r));
  assert.equal(r.resume, "0a5cb7a5-c39d-4c39-a11b-05f8b22b8df6");
});

test("parseCliArgs returns true when --resume has no value", () => {
  const r = parseCliArgs(["--resume"]);
  assert.ok(!("message" in r));
  assert.equal(r.resume, true);
});

test("parseCliArgs returns undefined resume when not present", () => {
  const r = parseCliArgs(["-p", "test"]);
  assert.ok(!("message" in r));
  assert.equal(r.resume, undefined);
});

test("parseCliArgs returns defaults for empty args", () => {
  const r = parseCliArgs([]);
  assert.ok(!("message" in r));
  assert.equal(r.prompt, undefined);
  assert.equal(r.resume, undefined);
  assert.equal(r.version, false);
  assert.equal(r.help, false);
});

// ── parseCliArgs: -r alias ───────────────────────────────────────────────────

test("parseCliArgs returns session ID after -r", () => {
  const r = parseCliArgs(["-r", "0a5cb7a5-c39d-4c39-a11b-05f8b22b8df6"]);
  assert.ok(!("message" in r));
  assert.equal(r.resume, "0a5cb7a5-c39d-4c39-a11b-05f8b22b8df6");
});

test("parseCliArgs returns true when -r has no value", () => {
  const r = parseCliArgs(["-r"]);
  assert.ok(!("message" in r));
  assert.equal(r.resume, true);
});

test("parseCliArgs handles -r <id> combined with -p", () => {
  const r = parseCliArgs(["-r", "session-123", "-p", "hello"]);
  assert.ok(!("message" in r));
  assert.equal(r.resume, "session-123");
  assert.equal(r.prompt, "hello");
});

test("parseCliArgs rejects bare -r with -p", () => {
  const r = parseCliArgs(["-r", "-p", "hello"]);
  assert.ok("message" in r);
  assert.match(r.message, /Cannot use --resume/);
});

// ── parseCliArgs: --version / --help ─────────────────────────────────────────

test("parseCliArgs detects --version", () => {
  const r = parseCliArgs(["--version"]);
  assert.ok(!("message" in r));
  assert.equal(r.version, true);
  assert.equal(r.help, false);
});

test("parseCliArgs detects -v", () => {
  const r = parseCliArgs(["-v"]);
  assert.ok(!("message" in r));
  assert.equal(r.version, true);
});

test("parseCliArgs detects --help", () => {
  const r = parseCliArgs(["--help"]);
  assert.ok(!("message" in r));
  assert.equal(r.help, true);
  assert.equal(r.version, false);
});

test("parseCliArgs detects -h", () => {
  const r = parseCliArgs(["-h"]);
  assert.ok(!("message" in r));
  assert.equal(r.help, true);
});

test("parseCliArgs version and help are false when not passed", () => {
  const r = parseCliArgs(["-p", "hello"]);
  assert.ok(!("message" in r));
  assert.equal(r.version, false);
  assert.equal(r.help, false);
});

test("parseCliArgs handles -v combined with -r (both flags set)", () => {
  const r = parseCliArgs(["-v", "-r", "abc"]);
  assert.ok(!("message" in r));
  assert.equal(r.version, true);
  assert.equal(r.resume, "abc");
});

// ── parseCliArgs: combined usage ─────────────────────────────────────────────

test("parseCliArgs handles --resume <id> combined with -p", () => {
  const r = parseCliArgs(["--resume", "session-123", "-p", "hello"]);
  assert.ok(!("message" in r));
  assert.equal(r.resume, "session-123");
  assert.equal(r.prompt, "hello");
});

test("parseCliArgs handles -p before --resume <id>", () => {
  const r = parseCliArgs(["-p", "hello", "--resume", "session-123"]);
  assert.ok(!("message" in r));
  assert.equal(r.resume, "session-123");
  assert.equal(r.prompt, "hello");
});

// ── parseCliArgs: validation ─────────────────────────────────────────────────

test("parseCliArgs rejects bare --resume with -p", () => {
  const r = parseCliArgs(["--resume", "-p", "hello"]);
  assert.ok("message" in r);
  assert.match(r.message, /Cannot use --resume/);
});

test("parseCliArgs rejects -p with bare --resume (reversed order)", () => {
  const r = parseCliArgs(["-p", "hello", "--resume"]);
  assert.ok("message" in r);
  assert.match(r.message, /Cannot use --resume/);
});

test("parseCliArgs rejects unknown flags in strict mode", () => {
  const r = parseCliArgs(["--unknown-flag"]);
  assert.ok("message" in r);
  assert.match(r.message, /Unknown argument/);
});

test("parseCliArgs rejects empty -p value", () => {
  const r = parseCliArgs(["-p", ""]);
  assert.ok("message" in r);
  assert.match(r.message, /non-empty/);
});

test("parseCliArgs --version takes precedence over --help", () => {
  const r = parseCliArgs(["--version", "--help"]);
  assert.ok(!("message" in r));
  assert.equal(r.version, true);
  assert.equal(r.help, true);
});
