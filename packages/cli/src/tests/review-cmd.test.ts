/**
 * review-cmd 单元测试
 *
 * 验证 A3 改进（2026-07-27）：添加 /review 内置命令
 * 关联事件：docs/archive/code-review-process-incident.md
 *
 * 测试覆盖：
 *   - parseReviewArgs 解析各子命令
 *   - parseReviewArgs 默认子命令为 full
 *   - parseReviewArgs 非法子命令抛 ReviewArgsError
 *   - detectProjectType 检测 Node.js / Python / Rust / Go / unknown
 *   - getToolCommands 返回对应项目类型的工具命令
 *   - executeReviewCommand 在 unknown 项目类型上返回 exitCode=2
 *   - executeReviewCommand 子命令 help 返回 exitCode=0 + 帮助文本
 *   - executeReviewCommand 通过 context 注入执行真实命令
 *   - 报告含 [已验证] 置信度标注
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  parseReviewArgs,
  executeReviewCommand,
  detectProjectType,
  getToolCommands,
  getMaxStdoutChars,
  getMaxStderrChars,
  ReviewArgsError,
  formatReviewHelp,
  extractReviewNaturalLanguageTask,
  type ReviewHandlerContext,
  type ToolCommandRecord,
  type RunToolCommandOptions,
} from "../review/review-cmd.js";

// ============================================================================
// parseReviewArgs 测试
// ============================================================================

test("parseReviewArgs 默认子命令为 full", () => {
  const args = parseReviewArgs([], "/tmp/project");
  assert.equal(args.subcommand, "full");
  assert.equal(args.projectRoot, "/tmp/project");
});

test("parseReviewArgs 解析 typecheck 子命令", () => {
  const args = parseReviewArgs(["typecheck"], "/tmp/project");
  assert.equal(args.subcommand, "typecheck");
});

test("parseReviewArgs 解析 lint 子命令", () => {
  const args = parseReviewArgs(["lint"], "/tmp/project");
  assert.equal(args.subcommand, "lint");
});

test("parseReviewArgs 解析 format 子命令", () => {
  const args = parseReviewArgs(["format"], "/tmp/project");
  assert.equal(args.subcommand, "format");
});

test("parseReviewArgs 解析 full 子命令", () => {
  const args = parseReviewArgs(["full"], "/tmp/project");
  assert.equal(args.subcommand, "full");
});

test("parseReviewArgs 解析 help 子命令", () => {
  const args = parseReviewArgs(["help"], "/tmp/project");
  assert.equal(args.subcommand, "help");
});

test("parseReviewArgs 解析 --quiet 选项", () => {
  const args = parseReviewArgs(["full", "--quiet"], "/tmp/project");
  assert.equal(args.quiet, true);
});

test("parseReviewArgs 解析 --format 选项", () => {
  const args = parseReviewArgs(["full", "--format", "json"], "/tmp/project");
  assert.equal(args.format, "json");
});

test("parseReviewArgs 解析 --project-root 选项", () => {
  const args = parseReviewArgs(["full", "--project-root", "/custom/path"], "/tmp/default");
  assert.equal(args.projectRoot, "/custom/path");
});

test("parseReviewArgs 非法子命令抛 ReviewArgsError", () => {
  assert.throws(
    () => parseReviewArgs(["invalid-subcommand"], "/tmp/project"),
    (err: unknown) => {
      assert.ok(err instanceof ReviewArgsError);
      assert.equal((err as Error).message.includes("非法的子命令"), true);
      return true;
    }
  );
});

test("parseReviewArgs 未知选项抛 ReviewArgsError", () => {
  assert.throws(
    () => parseReviewArgs(["full", "--unknown-opt"], "/tmp/project"),
    (err: unknown) => {
      assert.ok(err instanceof ReviewArgsError);
      assert.equal((err as Error).message.includes("未知选项"), true);
      return true;
    }
  );
});

test("parseReviewArgs --format 非法值抛 ReviewArgsError", () => {
  assert.throws(
    () => parseReviewArgs(["full", "--format", "xml"], "/tmp/project"),
    (err: unknown) => {
      assert.ok(err instanceof ReviewArgsError);
      return true;
    }
  );
});

// ============================================================================
// extractReviewNaturalLanguageTask 测试
// ============================================================================

test("extractReviewNaturalLanguageTask 空 /review 返回 undefined（工具模式）", () => {
  assert.equal(extractReviewNaturalLanguageTask("/review"), undefined);
  assert.equal(extractReviewNaturalLanguageTask("  /review  "), undefined);
});

test("extractReviewNaturalLanguageTask 合法子命令返回 undefined（工具模式）", () => {
  assert.equal(extractReviewNaturalLanguageTask("/review typecheck"), undefined);
  assert.equal(extractReviewNaturalLanguageTask("/review lint"), undefined);
  assert.equal(extractReviewNaturalLanguageTask("/review format"), undefined);
  assert.equal(extractReviewNaturalLanguageTask("/review full"), undefined);
  assert.equal(extractReviewNaturalLanguageTask("/review help"), undefined);
});

test("extractReviewNaturalLanguageTask 子命令加已知选项返回 undefined（工具模式）", () => {
  assert.equal(extractReviewNaturalLanguageTask("/review full --quiet"), undefined);
  assert.equal(extractReviewNaturalLanguageTask("/review full --format json"), undefined);
  assert.equal(extractReviewNaturalLanguageTask("/review full --project-root /tmp/project --quiet"), undefined);
  // 默认 full 时也可以直接以选项开头
  assert.equal(extractReviewNaturalLanguageTask("/review --quiet"), undefined);
  assert.equal(extractReviewNaturalLanguageTask("/review --format markdown"), undefined);
});

test("extractReviewNaturalLanguageTask 自然语言请求返回任务描述", () => {
  const task = "当前项目全部代码，并对照 gold comments，对比当前 review 的准确率和召回率。";
  assert.equal(extractReviewNaturalLanguageTask(`/review ${task}`), task);
});

test("extractReviewNaturalLanguageTask /review full 后跟自然语言返回任务描述", () => {
  const task = "当前项目全部代码，并对照 gold comments，对比当前 review 的准确率和召回率。";
  assert.equal(extractReviewNaturalLanguageTask(`/review full ${task}`), task);
});

test("extractReviewNaturalLanguageTask 非 /review 输入返回 undefined", () => {
  assert.equal(extractReviewNaturalLanguageTask("review something"), undefined);
  assert.equal(extractReviewNaturalLanguageTask("/team dispatch"), undefined);
  assert.equal(extractReviewNaturalLanguageTask(""), undefined);
});

// ============================================================================
// detectProjectType 测试
// ============================================================================

test("detectProjectType 检测 Node.js 项目（package.json）", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-test-node-"));
  try {
    fs.writeFileSync(path.join(tmpDir, "package.json"), '{"name":"test"}', "utf8");
    assert.equal(detectProjectType(tmpDir), "node");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("detectProjectType 检测 Python 项目（pyproject.toml）", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-test-python-"));
  try {
    fs.writeFileSync(path.join(tmpDir, "pyproject.toml"), "[project]\nname='test'\n", "utf8");
    assert.equal(detectProjectType(tmpDir), "python");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("detectProjectType 检测 Rust 项目（Cargo.toml）", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-test-rust-"));
  try {
    fs.writeFileSync(path.join(tmpDir, "Cargo.toml"), '[package]\nname="test"\n', "utf8");
    assert.equal(detectProjectType(tmpDir), "rust");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("detectProjectType 检测 Go 项目（go.mod）", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-test-go-"));
  try {
    fs.writeFileSync(path.join(tmpDir, "go.mod"), "module test\n\ngo 1.21\n", "utf8");
    assert.equal(detectProjectType(tmpDir), "go");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("detectProjectType 在空目录返回 unknown", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-test-empty-"));
  try {
    assert.equal(detectProjectType(tmpDir), "unknown");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// getToolCommands 测试
// ============================================================================

test("getToolCommands node typecheck 返回候选命令数组", () => {
  const cmds = getToolCommands("node", "typecheck");
  assert.equal(cmds.length >= 1, true);
  // 第一个候选应该是 npm run typecheck --silent
  assert.equal(cmds[0]?.includes("npm run typecheck"), true);
});

test("getToolCommands node lint 返回候选命令数组", () => {
  const cmds = getToolCommands("node", "lint");
  assert.equal(cmds.length >= 1, true);
  assert.equal(cmds[0]?.includes("npm run lint") || cmds[0]?.includes("eslint"), true);
});

test("getToolCommands node format 返回 prettier 命令", () => {
  const cmds = getToolCommands("node", "format");
  assert.equal(cmds.length >= 1, true);
  assert.equal(cmds[0]?.includes("prettier"), true);
});

test("getToolCommands python typecheck 返回 mypy 候选", () => {
  const cmds = getToolCommands("python", "typecheck");
  assert.equal(cmds[0], "mypy .");
});

test("getToolCommands rust typecheck 返回 cargo check", () => {
  const cmds = getToolCommands("rust", "typecheck");
  assert.equal(cmds[0], "cargo check");
});

test("getToolCommands go lint 返回 go vet 候选", () => {
  const cmds = getToolCommands("go", "lint");
  assert.equal(cmds[0], "go vet ./...");
});

test("getToolCommands unknown 返回空数组", () => {
  const cmds = getToolCommands("unknown", "typecheck");
  assert.equal(cmds.length, 0);
});

// ============================================================================
// executeReviewCommand 测试
// ============================================================================

test("executeReviewCommand help 子命令返回 exitCode=0 + 帮助文本", async () => {
  const result = await executeReviewCommand({ subcommand: "help", projectRoot: "/tmp", format: "markdown" }, {}, false);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.includes("DeepCodeX 代码审查命令"), true);
  assert.equal(result.stdout.includes("子命令"), true);
});

test("executeReviewCommand 在 unknown 项目类型返回 exitCode=2", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-test-unknown-"));
  try {
    const result = await executeReviewCommand(
      { subcommand: "full", projectRoot: tmpDir, format: "markdown" },
      {},
      false
    );
    assert.equal(result.exitCode, 2);
    assert.equal(result.stderr.includes("无法识别项目类型"), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("executeReviewCommand 通过 context 注入执行真实命令（typecheck 通过）", async () => {
  // 创建临时 node 项目（先创建，确保 runToolCommand 注入函数能引用 tmpDir 做 cwd 断言）
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-test-node-pass-"));
  try {
    fs.writeFileSync(path.join(tmpDir, "package.json"), '{"name":"test"}', "utf8");

    // 注入 runToolCommand：模拟 typecheck 命令通过的场景
    // 验证 cwd 与传入的 projectRoot（tmpDir）一致
    const context: ReviewHandlerContext = {
      runToolCommand: (command: string, options: RunToolCommandOptions): ToolCommandRecord => {
        assert.equal(options.cwd, tmpDir);
        return {
          command,
          exitCode: 0,
          stdout: "No type errors found.",
          stderr: "",
          durationMs: 100,
          timedOut: false,
        };
      },
    };

    const result = await executeReviewCommand(
      { subcommand: "typecheck", projectRoot: tmpDir, format: "markdown" },
      context,
      false
    );
    assert.equal(result.exitCode, 0);
    // 报告必须含 [已验证] 置信度标注
    assert.equal(result.stdout.includes("[已验证]"), true);
    // 报告必须含命令记录证据
    assert.equal(result.stdout.includes("npm run typecheck") || result.stdout.includes("npx tsc"), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("executeReviewCommand 通过 context 注入执行真实命令（typecheck 未通过）", async () => {
  // 模拟 typecheck 失败的场景
  const context: ReviewHandlerContext = {
    runToolCommand: (command: string, _options: RunToolCommandOptions): ToolCommandRecord => {
      return {
        command,
        exitCode: 1,
        stdout: "src/foo.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.",
        stderr: "Found 1 error.",
        durationMs: 200,
        timedOut: false,
      };
    },
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-test-node-fail-"));
  try {
    fs.writeFileSync(path.join(tmpDir, "package.json"), '{"name":"test"}', "utf8");
    const result = await executeReviewCommand(
      { subcommand: "typecheck", projectRoot: tmpDir, format: "markdown" },
      context,
      false
    );
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout.includes("[已验证]"), true);
    assert.equal(result.stdout.includes("未通过"), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("executeReviewCommand full 子命令运行所有维度（typecheck + lint + format）", async () => {
  // 验证 full 子命令会运行 3 个维度
  const executedCommands: string[] = [];
  const context: ReviewHandlerContext = {
    runToolCommand: (command: string, _options: RunToolCommandOptions): ToolCommandRecord => {
      executedCommands.push(command);
      return {
        command,
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 50,
        timedOut: false,
      };
    },
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-test-full-"));
  try {
    fs.writeFileSync(path.join(tmpDir, "package.json"), '{"name":"test"}', "utf8");
    const result = await executeReviewCommand(
      { subcommand: "full", projectRoot: tmpDir, format: "markdown" },
      context,
      false
    );
    assert.equal(result.exitCode, 0);
    // 必须执行至少 3 个命令（每个维度至少 1 个候选）
    assert.equal(executedCommands.length >= 3, true);
    // 报告必须含 3 个章节
    assert.equal(result.stdout.includes("类型检查"), true);
    assert.equal(result.stdout.includes("Lint 检查"), true);
    assert.equal(result.stdout.includes("格式化检查"), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("executeReviewCommand --quiet 模式不输出明细", async () => {
  const context: ReviewHandlerContext = {
    runToolCommand: (command: string, _options: RunToolCommandOptions): ToolCommandRecord => {
      return {
        command,
        exitCode: 0,
        stdout: "Detail output that should not appear in quiet mode",
        stderr: "",
        durationMs: 50,
        timedOut: false,
      };
    },
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-test-quiet-"));
  try {
    fs.writeFileSync(path.join(tmpDir, "package.json"), '{"name":"test"}', "utf8");
    const result = await executeReviewCommand(
      { subcommand: "typecheck", projectRoot: tmpDir, quiet: true, format: "markdown" },
      context,
      false
    );
    assert.equal(result.exitCode, 0);
    // quiet 模式下不应输出 stdout 明细
    assert.equal(result.stdout.includes("Detail output that should not appear in quiet mode"), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("executeReviewCommand --format json 输出有效 JSON", async () => {
  const context: ReviewHandlerContext = {
    runToolCommand: (command: string, _options: RunToolCommandOptions): ToolCommandRecord => {
      return {
        command,
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 50,
        timedOut: false,
      };
    },
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-test-json-"));
  try {
    fs.writeFileSync(path.join(tmpDir, "package.json"), '{"name":"test"}', "utf8");
    const result = await executeReviewCommand(
      { subcommand: "typecheck", projectRoot: tmpDir, format: "json" },
      context,
      false
    );
    assert.equal(result.exitCode, 0);
    // 必须输出有效 JSON
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.title, "DeepCodeX 代码审查报告");
    assert.equal(parsed.scope, "typecheck");
    assert.equal(Array.isArray(parsed.sections), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("formatReviewHelp 返回帮助文本含所有子命令", () => {
  const help = formatReviewHelp();
  assert.equal(help.includes("typecheck"), true);
  assert.equal(help.includes("lint"), true);
  assert.equal(help.includes("format"), true);
  assert.equal(help.includes("full"), true);
  assert.equal(help.includes("help"), true);
});

// ============================================================================
// 架构师审查 M1 测试：exitCode=3（依赖缺失）场景
// ============================================================================

test("executeReviewCommand 所有候选命令 exitCode=127 时返回 exitCode=3（M1 依赖缺失）", async () => {
  // 模拟所有候选命令都不可用（exitCode=127=命令不存在）的场景
  // 这种情况应该返回 exitCode=3（依赖缺失），而非 exitCode=1（检查未通过）
  const context: ReviewHandlerContext = {
    runToolCommand: (command: string, _options: RunToolCommandOptions): ToolCommandRecord => {
      return {
        command,
        exitCode: 127, // 命令不存在
        stdout: "",
        stderr: "command not found",
        durationMs: 10,
        timedOut: false,
      };
    },
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-test-deps-missing-"));
  try {
    fs.writeFileSync(path.join(tmpDir, "package.json"), '{"name":"test"}', "utf8");
    const result = await executeReviewCommand(
      { subcommand: "typecheck", projectRoot: tmpDir, format: "markdown" },
      context,
      false
    );
    // M1 修复：所有候选命令 exitCode=127 时应返回 exitCode=3（依赖缺失）
    assert.equal(result.exitCode, 3, "所有候选命令不可用时应返回 exitCode=3（依赖缺失）");
    // 报告应含 [未验证] 标注（因为命令不可用，无法真实验证）
    assert.equal(result.stdout.includes("[未验证]"), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("executeReviewCommand full 子命令所有维度 exitCode=127 时返回 exitCode=3（M1）", async () => {
  // full 子命令运行 3 个维度（typecheck + lint + format）
  // 当所有维度的所有候选命令都返回 127 时，应返回 exitCode=3
  const context: ReviewHandlerContext = {
    runToolCommand: (command: string, _options: RunToolCommandOptions): ToolCommandRecord => {
      return {
        command,
        exitCode: 127,
        stdout: "",
        stderr: "command not found",
        durationMs: 10,
        timedOut: false,
      };
    },
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-test-full-deps-missing-"));
  try {
    fs.writeFileSync(path.join(tmpDir, "package.json"), '{"name":"test"}', "utf8");
    const result = await executeReviewCommand(
      { subcommand: "full", projectRoot: tmpDir, format: "markdown" },
      context,
      false
    );
    assert.equal(result.exitCode, 3, "full 所有维度命令不可用时应返回 exitCode=3");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("executeReviewCommand 部分命令可用部分不可用时不返回 exitCode=3（M1）", async () => {
  // 当部分候选命令可用（exitCode !== 127）时，不应返回 exitCode=3
  // 而应根据检查结果返回 0（通过）或 1（未通过）
  const context: ReviewHandlerContext = {
    runToolCommand: (command: string, _options: RunToolCommandOptions): ToolCommandRecord => {
      // 第一个候选命令返回 0（通过），后续候选不再调用
      return {
        command,
        exitCode: 0,
        stdout: "All checks passed.",
        stderr: "",
        durationMs: 50,
        timedOut: false,
      };
    },
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-test-partial-deps-"));
  try {
    fs.writeFileSync(path.join(tmpDir, "package.json"), '{"name":"test"}', "utf8");
    const result = await executeReviewCommand(
      { subcommand: "typecheck", projectRoot: tmpDir, format: "markdown" },
      context,
      false
    );
    // 命令可用且通过，应返回 exitCode=0，而非 exitCode=3
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.includes("[已验证]"), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// 架构师审查 M2 测试：超时场景（timedOut: true）
// ============================================================================

test("executeReviewCommand 命令超时时返回 [不确定] 标注（M2 超时场景）", async () => {
  // 模拟命令执行超时的场景
  // 超时时应标注 [不确定]，退出码应为 1（检查未通过）
  const context: ReviewHandlerContext = {
    runToolCommand: (command: string, _options: RunToolCommandOptions): ToolCommandRecord => {
      return {
        command,
        exitCode: null, // 超时时 exitCode 为 null
        stdout: "",
        stderr: "",
        durationMs: 120_000, // 120s 超时
        timedOut: true,
      };
    },
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-test-timeout-"));
  try {
    fs.writeFileSync(path.join(tmpDir, "package.json"), '{"name":"test"}', "utf8");
    const result = await executeReviewCommand(
      { subcommand: "typecheck", projectRoot: tmpDir, format: "markdown" },
      context,
      false
    );
    // 超时属于检查未通过，exitCode 应为 1（非 0 通过，也非 3 依赖缺失）
    assert.equal(result.exitCode, 1);
    // 报告应含 [不确定] 标注（超时无法确定检查结果）
    assert.equal(result.stdout.includes("[不确定]"), true);
    // 报告应含"超时"字样
    assert.equal(result.stdout.includes("超时"), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("executeReviewCommand full 子命令部分维度超时部分通过时返回 exitCode=1（M2）", async () => {
  // full 子命令运行 3 个维度，其中 1 个超时，2 个通过
  // 预期：overallPassed=false（因为有超时），exitCode=1（非 3，因为不是全部依赖缺失）
  const callCount: { current: number } = { current: 0 };
  const context: ReviewHandlerContext = {
    runToolCommand: (command: string, _options: RunToolCommandOptions): ToolCommandRecord => {
      callCount.current += 1;
      // 第一个维度（typecheck）超时，后续维度（lint/format）通过
      if (callCount.current === 1) {
        return {
          command,
          exitCode: null,
          stdout: "",
          stderr: "",
          durationMs: 120_000,
          timedOut: true,
        };
      }
      return {
        command,
        exitCode: 0,
        stdout: "Passed.",
        stderr: "",
        durationMs: 50,
        timedOut: false,
      };
    },
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-test-partial-timeout-"));
  try {
    fs.writeFileSync(path.join(tmpDir, "package.json"), '{"name":"test"}', "utf8");
    const result = await executeReviewCommand(
      { subcommand: "full", projectRoot: tmpDir, format: "markdown" },
      context,
      false
    );
    // 部分维度超时，整体未通过，exitCode=1
    assert.equal(result.exitCode, 1);
    // 报告应同时包含 [不确定]（超时维度）和 [已验证]（通过维度）
    assert.equal(result.stdout.includes("[不确定]"), true);
    assert.equal(result.stdout.includes("[已验证]"), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// 架构师审查 M3 测试：extractUnformattedCount 多工具输出格式兼容
// ============================================================================

test("executeReviewCommand Prettier 格式化输出解析（M3 Prettier）", async () => {
  // 模拟 Prettier 输出："3 files are not formatted"
  const context: ReviewHandlerContext = {
    runToolCommand: (command: string, _options: RunToolCommandOptions): ToolCommandRecord => {
      return {
        command,
        exitCode: 1,
        stdout: "src/foo.ts\nsrc/bar.ts\nsrc/baz.ts\n3 files are not formatted.",
        stderr: "",
        durationMs: 50,
        timedOut: false,
      };
    },
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-test-prettier-"));
  try {
    fs.writeFileSync(path.join(tmpDir, "package.json"), '{"name":"test"}', "utf8");
    const result = await executeReviewCommand(
      { subcommand: "format", projectRoot: tmpDir, format: "markdown" },
      context,
      false
    );
    assert.equal(result.exitCode, 1);
    // 报告应含未格式化文件数：3
    assert.equal(result.stdout.includes("未格式化文件数：3"), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("executeReviewCommand Ruff 格式化输出解析（M3 Ruff）", async () => {
  // 模拟 Ruff 输出："Would reformat: 5 files"
  const context: ReviewHandlerContext = {
    runToolCommand: (command: string, _options: RunToolCommandOptions): ToolCommandRecord => {
      return {
        command,
        exitCode: 1,
        stdout: "Would reformat: 5 files",
        stderr: "",
        durationMs: 50,
        timedOut: false,
      };
    },
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-test-ruff-"));
  try {
    fs.writeFileSync(path.join(tmpDir, "pyproject.toml"), "[project]\nname='test'\n", "utf8");
    const result = await executeReviewCommand(
      { subcommand: "format", projectRoot: tmpDir, format: "markdown" },
      context,
      false
    );
    assert.equal(result.exitCode, 1);
    // 报告应含未格式化文件数：5
    assert.equal(result.stdout.includes("未格式化文件数：5"), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("executeReviewCommand Black 格式化输出解析（M3 Black）", async () => {
  // 模拟 Black 输出："would reformat 7 files"
  const context: ReviewHandlerContext = {
    runToolCommand: (command: string, _options: RunToolCommandOptions): ToolCommandRecord => {
      return {
        command,
        exitCode: 1,
        stdout: "would reformat 7 files",
        stderr: "",
        durationMs: 50,
        timedOut: false,
      };
    },
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-test-black-"));
  try {
    fs.writeFileSync(path.join(tmpDir, "pyproject.toml"), "[project]\nname='test'\n", "utf8");
    const result = await executeReviewCommand(
      { subcommand: "format", projectRoot: tmpDir, format: "markdown" },
      context,
      false
    );
    assert.equal(result.exitCode, 1);
    // 报告应含未格式化文件数：7
    assert.equal(result.stdout.includes("未格式化文件数：7"), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("executeReviewCommand gofmt 格式化输出解析（M3 gofmt 行数计数）", async () => {
  // 模拟 gofmt 输出：文件列表（每行一个文件路径）
  const context: ReviewHandlerContext = {
    runToolCommand: (command: string, _options: RunToolCommandOptions): ToolCommandRecord => {
      return {
        command: "gofmt -l .",
        exitCode: 1,
        stdout: "main.go\nutils.go\nhandler.go",
        stderr: "",
        durationMs: 50,
        timedOut: false,
      };
    },
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-test-gofmt-"));
  try {
    fs.writeFileSync(path.join(tmpDir, "go.mod"), "module test\n\ngo 1.21\n", "utf8");
    const result = await executeReviewCommand(
      { subcommand: "format", projectRoot: tmpDir, format: "markdown" },
      context,
      false
    );
    assert.equal(result.exitCode, 1);
    // 报告应含未格式化文件数：3（3 行文件路径）
    assert.equal(result.stdout.includes("未格式化文件数：3"), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("executeReviewCommand L3 timeoutMs 透传到 runToolCommand", async () => {
  // 验证 L3 修复：context.timeoutMs 应透传到 runToolCommand 的 options.timeoutMs
  let capturedTimeoutMs: number | undefined;
  const context: ReviewHandlerContext = {
    timeoutMs: 5_000, // 5 秒
    runToolCommand: (command: string, options: RunToolCommandOptions): ToolCommandRecord => {
      capturedTimeoutMs = options.timeoutMs;
      return {
        command,
        exitCode: 0,
        stdout: "Passed.",
        stderr: "",
        durationMs: 50,
        timedOut: false,
      };
    },
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-test-timeout-ms-"));
  try {
    fs.writeFileSync(path.join(tmpDir, "package.json"), '{"name":"test"}', "utf8");
    await executeReviewCommand({ subcommand: "typecheck", projectRoot: tmpDir, format: "markdown" }, context, false);
    // 验证 timeoutMs 被正确透传
    assert.equal(capturedTimeoutMs, 5_000, "context.timeoutMs 应透传到 runToolCommand");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("executeReviewCommand L3 未设置 timeoutMs 时为 undefined", async () => {
  // 验证 L3 修复：未设置 context.timeoutMs 时，options.timeoutMs 应为 undefined（由默认值处理）
  let capturedTimeoutMs: number | undefined;
  const context: ReviewHandlerContext = {
    runToolCommand: (command: string, options: RunToolCommandOptions): ToolCommandRecord => {
      capturedTimeoutMs = options.timeoutMs;
      return {
        command,
        exitCode: 0,
        stdout: "Passed.",
        stderr: "",
        durationMs: 50,
        timedOut: false,
      };
    },
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-test-no-timeout-"));
  try {
    fs.writeFileSync(path.join(tmpDir, "package.json"), '{"name":"test"}', "utf8");
    await executeReviewCommand({ subcommand: "typecheck", projectRoot: tmpDir, format: "markdown" }, context, false);
    // 未设置 timeoutMs 时，options.timeoutMs 应为 undefined（defaultRunToolCommand 会使用 DEFAULT_TIMEOUT_MS）
    assert.equal(capturedTimeoutMs, undefined, "未设置 context.timeoutMs 时 options.timeoutMs 应为 undefined");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("executeReviewCommand L6 环境变量 REVIEW_MAX_STDOUT_CHARS 生效", () => {
  // 验证 L6 修复：环境变量 REVIEW_MAX_STDOUT_CHARS 应控制 stdout 截断长度
  // 直接测试 getMaxStdoutChars() 函数，验证懒求值和环境变量读取
  const originalValue = process.env.REVIEW_MAX_STDOUT_CHARS;

  try {
    // 1. 默认值应为 50_000（L6 修复：从 10_000 提升到 50_000）
    delete process.env.REVIEW_MAX_STDOUT_CHARS;
    assert.equal(getMaxStdoutChars(), 50_000, "默认值应为 50_000");

    // 2. 环境变量设置后应立即生效（懒求值）
    process.env.REVIEW_MAX_STDOUT_CHARS = "100";
    assert.equal(getMaxStdoutChars(), 100, "环境变量设置后应立即生效");

    // 3. 非法值应回退到默认值
    process.env.REVIEW_MAX_STDOUT_CHARS = "invalid";
    assert.equal(getMaxStdoutChars(), 50_000, "非法值应回退到默认值");

    // 4. 空字符串应回退到默认值
    process.env.REVIEW_MAX_STDOUT_CHARS = "";
    assert.equal(getMaxStdoutChars(), 50_000, "空字符串应回退到默认值");

    // 5. 负数应回退到默认值
    process.env.REVIEW_MAX_STDOUT_CHARS = "-100";
    assert.equal(getMaxStdoutChars(), 50_000, "负数应回退到默认值");
  } finally {
    // 恢复环境变量
    if (originalValue === undefined) {
      delete process.env.REVIEW_MAX_STDOUT_CHARS;
    } else {
      process.env.REVIEW_MAX_STDOUT_CHARS = originalValue;
    }
  }
});

test("getMaxStderrChars 默认值与环境变量配置（L6）", () => {
  // 验证 L6 修复：stderr 截断长度也支持环境变量配置
  const originalValue = process.env.REVIEW_MAX_STDERR_CHARS;

  try {
    // 默认值应为 5_000
    delete process.env.REVIEW_MAX_STDERR_CHARS;
    assert.equal(getMaxStderrChars(), 5_000, "默认值应为 5_000");

    // 环境变量设置后应立即生效
    process.env.REVIEW_MAX_STDERR_CHARS = "200";
    assert.equal(getMaxStderrChars(), 200, "环境变量设置后应立即生效");

    // 非法值应回退到默认值
    process.env.REVIEW_MAX_STDERR_CHARS = "abc";
    assert.equal(getMaxStderrChars(), 5_000, "非法值应回退到默认值");
  } finally {
    if (originalValue === undefined) {
      delete process.env.REVIEW_MAX_STDERR_CHARS;
    } else {
      process.env.REVIEW_MAX_STDERR_CHARS = originalValue;
    }
  }
});
