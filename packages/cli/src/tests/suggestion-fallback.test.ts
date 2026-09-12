import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AUTO_EXECUTABLE_COMMAND_KINDS,
  AUTO_EXECUTABLE_EAG_COMMANDS,
  extractAutoExecutableEagCommandName,
  extractSuggestedCommandText,
} from "../ui";

// 建议循环客户端兜底（2026-09-03）：回合收尾"建议执行 /xxx"命令提取的单元测试

test("extractSuggestedCommandText extracts plain suggestion", () => {
  assert.equal(extractSuggestedCommandText("根据分析，建议执行 /review 来完成代码审查"), "/review");
});

test("extractSuggestedCommandText extracts suggestion with ascii args", () => {
  // ASCII 参数 token 跟随命令名一起捕获
  assert.equal(extractSuggestedCommandText("建议执行 /team dispatch backend-task"), "/team dispatch backend-task");
});

test("extractSuggestedCommandText extracts suggestion without space", () => {
  assert.equal(extractSuggestedCommandText("建议执行/review"), "/review");
});

test("extractSuggestedCommandText extracts backtick-wrapped command", () => {
  // 模型常用反引号包裹命令，连接窗口容忍反引号
  assert.equal(extractSuggestedCommandText("建议执行 `/review`"), "/review");
});

test("extractSuggestedCommandText stops args at chinese prose", () => {
  // 中文散文不属于命令参数，只捕获命令名
  assert.equal(extractSuggestedCommandText("建议执行 /review 检查登录模块"), "/review");
});

test("extractSuggestedCommandText skips negated template echo (严禁)", () => {
  // F3 审查模板中的约束文本被模型转述时，"建议执行 /review"前带"严禁"，不是建议
  assert.equal(extractSuggestedCommandText('我已遵守约束：严禁回复"建议执行 /review 或任何斜杠命令"'), null);
});

test("extractSuggestedCommandText skips negated template echo (不会)", () => {
  assert.equal(extractSuggestedCommandText('我不会再说"建议执行 /review"了'), null);
});

test("extractSuggestedCommandText prefers last non-negated occurrence", () => {
  // 前一次是否定语境（模板转述），后一次是真实建议——应命中最后一次
  assert.equal(
    extractSuggestedCommandText('严禁回复"建议执行 /quality-check"。根据任务需要，建议执行 /review'),
    "/review"
  );
});

test("extractSuggestedCommandText returns null when no pattern", () => {
  assert.equal(extractSuggestedCommandText("代码审查已完成，共发现 3 个问题。"), null);
  assert.equal(extractSuggestedCommandText("可以执行 /review"), null);
});

test("extractSuggestedCommandText returns null for empty or non-string input", () => {
  assert.equal(extractSuggestedCommandText(""), null);
});

test("extractSuggestedCommandText ignores non-letter command names", () => {
  // 命令名必须字母开头（与 BUILTIN_SLASH_COMMANDS 命名一致）
  assert.equal(extractSuggestedCommandText("建议执行 /123"), null);
});

test("extractSuggestedCommandText respects 12-char connector window", () => {
  // "执行"与"/"之间最多 12 个非换行非斜杠字符
  assert.equal(extractSuggestedCommandText("建议执行一二三四五六七八九十一二/review"), "/review");
  assert.equal(extractSuggestedCommandText("建议执行一二三四五六七八九十一二三/review"), null);
});

test("extractSuggestedCommandText is stateless across calls", () => {
  // /g 正则带 lastIndex 状态，连续调用不得互相影响
  const text = "建议执行 /review";
  assert.equal(extractSuggestedCommandText(text), "/review");
  assert.equal(extractSuggestedCommandText(text), "/review");
  assert.equal(extractSuggestedCommandText("无建议文本"), null);
  assert.equal(extractSuggestedCommandText(text), "/review");
});

test("extractSuggestedCommandText extraction is purely textual (validation is caller's job)", () => {
  // 提取层不做白名单校验：非任务类命令（如 /exit）也能被提取出来，
  // 由 App.tsx 的 parseSlashCommandKind + AUTO_EXECUTABLE_COMMAND_KINDS 二次拦截
  assert.equal(extractSuggestedCommandText("建议执行 /exit"), "/exit");
});

test("AUTO_EXECUTABLE_COMMAND_KINDS contains only task-execution kinds", () => {
  // 任务执行类：允许自动执行
  assert.ok(AUTO_EXECUTABLE_COMMAND_KINDS.has("review"));
  assert.ok(AUTO_EXECUTABLE_COMMAND_KINDS.has("quality-check"));
  assert.ok(AUTO_EXECUTABLE_COMMAND_KINDS.has("team"));
  // 会话控制/销毁类、进程控制类、循环风险类、信息展示类：严禁自动执行
  for (const kind of ["exit", "new", "resume", "undo", "cancel", "bg", "fg", "pause", "continue", "help"]) {
    assert.ok(!AUTO_EXECUTABLE_COMMAND_KINDS.has(kind), `${kind} 不得在自动执行白名单中`);
  }
});

// ============================================================================
// F9-v2（2026-09-12）：引号中文参数捕获 + EAG 命令白名单
// 日志铁证：建议器输出"建议启动 /eag-autonomous --goal '从本机 46 导出...'"时，
// 旧正则在引号处截断导致 --goal 中文值丢失、兜底全程静默。
// ============================================================================

test("extractSuggestedCommandText captures single-quoted chinese args", () => {
  // 单引号包裹的中文参数（含空格）完整捕获，不截断
  assert.equal(
    extractSuggestedCommandText("建议启动 /eag-autonomous --goal '从本机 46 导出数据库到 43'"),
    "/eag-autonomous --goal '从本机 46 导出数据库到 43'"
  );
});

test("extractSuggestedCommandText captures double-quoted chinese args", () => {
  // 双引号形式与单引号同构
  assert.equal(
    extractSuggestedCommandText('建议启动 /eag-autonomous --goal "从本机 46 导出数据库到 43 采用全量覆盖"'),
    '/eag-autonomous --goal "从本机 46 导出数据库到 43 采用全量覆盖"'
  );
});

test("extractSuggestedCommandText captures mixed quoted and ascii args", () => {
  // 引号参数后可继续跟 ASCII token 参数（如 --max-iterations 10）
  assert.equal(
    extractSuggestedCommandText("建议启动 /eag-autonomous --goal '同步数据库' --max-iterations 10"),
    "/eag-autonomous --goal '同步数据库' --max-iterations 10"
  );
});

test("extractSuggestedCommandText unmatched quote falls back to ascii token", () => {
  // 未闭合引号不满足引号模式，回退 ASCII token 捕获（--goal 后中文值不属于参数）
  assert.equal(extractSuggestedCommandText("建议启动 /eag-autonomous --goal"), "/eag-autonomous --goal");
});

test("extractSuggestedCommandText quoted args do not leak chinese prose", () => {
  // 命令名后紧跟中文散文（无引号）仍不视为参数，仅捕获命令名
  assert.equal(extractSuggestedCommandText("建议启动 /eag-autonomous 来完成这次同步"), "/eag-autonomous");
});

test("extractAutoExecutableEagCommandName accepts whitelisted eag command with args", () => {
  // 白名单内 EAG 命令 + 完整参数：返回命令名
  assert.equal(
    extractAutoExecutableEagCommandName("/eag-autonomous --goal '同步数据库' --max-iterations 10"),
    "eag-autonomous"
  );
});

test("extractAutoExecutableEagCommandName rejects non-whitelisted eag commands", () => {
  // 熔断/查询/复杂参数类 EAG 命令：严禁自动执行
  assert.equal(extractAutoExecutableEagCommandName("/eag-autonomous-stop"), null);
  assert.equal(extractAutoExecutableEagCommandName("/eag-autonomous-status"), null);
  assert.equal(extractAutoExecutableEagCommandName("/eag-graph --graph-file x.json"), null);
  assert.equal(extractAutoExecutableEagCommandName("/eag-design --spec y.yaml"), null);
});

test("extractAutoExecutableEagCommandName rejects non-eag and malformed input", () => {
  // 内置命令体系内的命令：不属于 EAG 白名单（走 AUTO_EXECUTABLE_COMMAND_KINDS 通道）
  assert.equal(extractAutoExecutableEagCommandName("/review"), null);
  // 非 "/" 开头、空字符串、纯 "/"：均拒绝
  assert.equal(extractAutoExecutableEagCommandName("eag-autonomous"), null);
  assert.equal(extractAutoExecutableEagCommandName(""), null);
  assert.equal(extractAutoExecutableEagCommandName("/"), null);
});

test("AUTO_EXECUTABLE_EAG_COMMANDS contains only eag-autonomous", () => {
  // 保守收录：仅 eag-autonomous（建议器 suggest_autonomous 的标准产出）
  assert.ok(AUTO_EXECUTABLE_EAG_COMMANDS.has("eag-autonomous"));
  // 熔断/状态查询/需复杂参数的命令不得进入白名单
  for (const name of ["eag-autonomous-stop", "eag-autonomous-status", "eag-graph", "eag-design", "eag-build"]) {
    assert.ok(!AUTO_EXECUTABLE_EAG_COMMANDS.has(name), `${name} 不得在 EAG 自动执行白名单中`);
  }
});
