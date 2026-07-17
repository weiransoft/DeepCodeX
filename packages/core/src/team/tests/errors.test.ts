/**
 * Team 模块错误类型测试
 *
 * 验证 errors.ts 的 TeamError 派生类层级和结构化字段
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ErrorCode,
  TeamError,
  DropInFileNotFoundError,
  DropInSpecFailedError,
  DropInExecFailedError,
  DropInNoPluginError,
  DropInDuplicateNameError,
  DropInConstructFailedError,
  DropInPathAbsoluteError,
  DropInPathOutsideRootError,
  DropInPathNotDirError,
  DropInPathCreateFailedError,
  PluginNameInvalidError,
  PluginPriorityDuplicateError,
  PluginMutexSelfError,
  PluginMutexUnknownError,
  PluginMutexAsymmetricError,
  PluginNotRegisteredError,
  PluginAlreadyRegisteredError,
  DispatcherCircularDependencyError,
  DispatcherMissingDependencyError,
  ReloadGuardBusyError,
  ReloadPartialFailureError,
  ReloadRollbackFailedError,
} from "../errors.js";

test("TeamError captures code, context, timestamp", () => {
  const err = new TeamError(ErrorCode.CONFIG_INVALID, "test", { context: { k: "v" } });
  assert.equal(err.code, "CONFIG_INVALID");
  assert.equal(err.message, "test");
  assert.deepEqual(err.context, { k: "v" });
  assert.ok(err.timestamp);
});

test("TeamError.toInfo serializes full structure", () => {
  const cause = new Error("inner");
  const err = new TeamError(ErrorCode.CONFIG_INVALID, "outer", { cause });
  const info = err.toInfo();
  assert.equal(info.code, "CONFIG_INVALID");
  assert.equal(info.message, "outer");
  assert.equal(info.cause, "inner");
  assert.ok(info.stack);
});

test("DropInFileNotFoundError carries path context", () => {
  const err = new DropInFileNotFoundError("/tmp/missing.js");
  assert.equal(err.code, "DROP_IN_FILE_NOT_FOUND");
  assert.equal(err.context["path"], "/tmp/missing.js");
  assert.ok(err.message.includes("/tmp/missing.js"));
});

test("DropInSpecFailedError includes reason", () => {
  const err = new DropInSpecFailedError("/tmp/x.js", "Invalid spec");
  assert.equal(err.code, "DROP_IN_SPEC_FAILED");
  assert.equal(err.context["reason"], "Invalid spec");
});

test("DropInExecFailedError wraps original error", () => {
  const inner = new SyntaxError("Unexpected token");
  const err = new DropInExecFailedError("/tmp/x.js", inner);
  assert.equal(err.code, "DROP_IN_EXEC_FAILED");
  assert.equal(err.cause, inner);
  assert.ok(err.message.includes("SyntaxError"));
});

test("DropInNoPluginError has path context", () => {
  const err = new DropInNoPluginError("/tmp/x.js");
  assert.equal(err.code, "DROP_IN_NO_PLUGIN");
  assert.equal(err.context["path"], "/tmp/x.js");
});

test("DropInDuplicateNameError lists duplicates", () => {
  const err = new DropInDuplicateNameError("/tmp/x.js", ["foo", "bar"]);
  assert.equal(err.code, "DROP_IN_DUPLICATE_NAME");
  assert.deepEqual(err.context["duplicates"], ["foo", "bar"]);
});

test("DropInConstructFailedError includes class name", () => {
  const err = new DropInConstructFailedError("/tmp/x.js", "FooPlugin", "boom");
  assert.equal(err.code, "DROP_IN_CONSTRUCT_FAILED");
  assert.equal(err.context["className"], "FooPlugin");
});

test("DropInPathAbsoluteError rejects absolute path", () => {
  const err = new DropInPathAbsoluteError("/absolute");
  assert.equal(err.code, "DROP_IN_PATH_ABSOLUTE");
});

test("DropInPathOutsideRootError carries both paths", () => {
  const err = new DropInPathOutsideRootError("/abs/path", "/root");
  assert.equal(err.code, "DROP_IN_PATH_OUTSIDE_ROOT");
  assert.equal(err.context["absolutePath"], "/abs/path");
  assert.equal(err.context["projectRoot"], "/root");
});

test("DropInPathNotDirError has absolute path", () => {
  const err = new DropInPathNotDirError("/abs");
  assert.equal(err.code, "DROP_IN_PATH_NOT_DIR");
});

test("DropInPathCreateFailedError includes reason", () => {
  const cause = new Error("EACCES");
  const err = new DropInPathCreateFailedError("/abs", "permission denied", cause);
  assert.equal(err.code, "DROP_IN_PATH_CREATE_FAILED");
  assert.equal(err.cause, cause);
});

test("PluginNameInvalidError carries name and reason", () => {
  const err = new PluginNameInvalidError("BadName", "uppercase not allowed");
  assert.equal(err.code, "PLUGIN_NAME_INVALID");
  assert.equal(err.context["name"], "BadName");
});

test("PluginPriorityDuplicateError reports conflict", () => {
  const err = new PluginPriorityDuplicateError(10, "a", "b");
  assert.equal(err.code, "PLUGIN_PRIORITY_DUPLICATE");
  assert.equal(err.context["existingName"], "a");
  assert.equal(err.context["newName"], "b");
});

test("PluginMutexSelfError indicates self-reference", () => {
  const err = new PluginMutexSelfError("foo");
  assert.equal(err.code, "PLUGIN_MUTEX_SELF");
  assert.equal(err.context["name"], "foo");
});

test("PluginMutexUnknownError lists available plugins", () => {
  const err = new PluginMutexUnknownError("foo", "bar", ["a", "b"]);
  assert.equal(err.code, "PLUGIN_MUTEX_UNKNOWN");
  assert.deepEqual(err.context["available"], ["a", "b"]);
});

test("PluginMutexAsymmetricError points to both", () => {
  const err = new PluginMutexAsymmetricError("a", "b");
  assert.equal(err.code, "PLUGIN_MUTEX_ASYMMETRIC");
});

test("PluginNotRegisteredError has name", () => {
  const err = new PluginNotRegisteredError("x");
  assert.equal(err.code, "PLUGIN_NOT_REGISTERED");
});

test("PluginAlreadyRegisteredError mentions hot_reload", () => {
  const err = new PluginAlreadyRegisteredError("x");
  assert.equal(err.code, "PLUGIN_ALREADY_REGISTERED");
  assert.ok(err.message.includes("hot_reload"));
});

test("DispatcherCircularDependencyError lists cycle", () => {
  const err = new DispatcherCircularDependencyError(["a", "b", "a"]);
  assert.equal(err.code, "DISPATCHER_CIRCULAR_DEPENDENCY");
  assert.deepEqual(err.context["cycle"], ["a", "b", "a"]);
});

test("DispatcherMissingDependencyError points to goal/dep", () => {
  const err = new DispatcherMissingDependencyError("g1", "missing");
  assert.equal(err.code, "DISPATCHER_MISSING_DEPENDENCY");
  assert.equal(err.context["goalId"], "g1");
  assert.equal(err.context["missingDep"], "missing");
});

test("ReloadGuardBusyError carries operation and holder", () => {
  const err = new ReloadGuardBusyError("op1", "holder1");
  assert.equal(err.code, "RELOAD_GUARD_BUSY");
});

test("ReloadPartialFailureError lists failed plugins", () => {
  const err = new ReloadPartialFailureError("f.js", 1, 2, ["a", "b"]);
  assert.equal(err.code, "RELOAD_PARTIAL_FAILURE");
  assert.deepEqual(err.context["failures"], ["a", "b"]);
});

test("ReloadRollbackFailedError lists lost plugins", () => {
  const err = new ReloadRollbackFailedError("f.js", ["x", "y"]);
  assert.equal(err.code, "RELOAD_ROLLBACK_FAILED");
  assert.deepEqual(err.context["lostPlugins"], ["x", "y"]);
});

test("All TeamError instances have timestamp", () => {
  const err = new TeamError(ErrorCode.CONFIG_INVALID, "x");
  assert.match(err.timestamp, /^\d{4}-\d{2}-\d{2}T/);
});

test("toJSON produces valid JSON", () => {
  const err = new TeamError(ErrorCode.CONFIG_INVALID, "x");
  const json = err.toJSON();
  const parsed = JSON.parse(json);
  assert.equal(parsed.code, "CONFIG_INVALID");
});
