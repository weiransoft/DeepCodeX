/**
 * Windows 兼容性回归测试（2026-11-01）
 *
 * 背景：本仓库长期只在 macOS/Linux 上开发，大量安全护栏以 POSIX 路径与
 * POSIX 命令为前提实现。审计发现三处"看着在防护、Windows 上实际失效"的问题：
 *
 * 1. G-A1a 路径牢笼：绝对路径 token 只匹配 "/" 开头，系统敏感前缀只有 POSIX，
 *    → `del C:\Windows\...` 既不出现在 token 列表里，也不命中任何前缀。
 * 2. G-A2a/A2b 危险命令：黑名单 100% 是 Unix 命令，
 *    → `format C:`、`rd /s /q`、`Remove-Item -Recurse -Force` 全部漏网。
 * 3. 平台前缀比较用 `prefix + "/"`：Windows 上 path.resolve 产出反斜杠，
 *    → 临时目录、只读白名单的前缀校验恒为 false。
 *
 * 本文件用可注入 platform 的纯函数逐个钉住这些行为，保证在 macOS/Linux CI
 * 上也能验证 Windows 语义。
 *
 * 测试约定（遵循项目规则）：
 * - node:test + node:assert/strict，不使用 mock 框架
 * - 每组断言同时给阳性（Windows 写法被拦）与阴性（POSIX 语义未被破坏）对照
 *
 * @module core/tests/windows-compat
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { EnvBoundaryGuard, DangerousCommandGuard, findPathJailViolation, isSameOrUnderPath } from "../eag/p5/index";
import type { GuardContext, TaskCard } from "../eag/p5/index";
import { CommandSafety } from "../v2/approval/command-safety";
import { classifyFilePermissionScope } from "../common/permissions";
import { resolveNotifySpawnPlan } from "../common/notify";
import { clearSessionState, fileStateKey, getFileState, getFileVersion, recordFileState } from "../common/state";
import {
  findWindowsPathIssue,
  validateWindowsFileToolPath,
  WINDOWS_MAX_PATH,
  WINDOWS_RESERVED_DEVICE_NAMES,
} from "../common/windows-path-rules";
import * as os from "node:os";
import * as path from "node:path";

// ============================================================================
// 测试辅助
// ============================================================================

function createContext(overrides: Partial<GuardContext> = {}): GuardContext {
  return {
    runId: "win-compat-run-001",
    iterIndex: 1,
    stage: "dev",
    loopType: "coding",
    projectRoot: "/tmp/test-project",
    worktreePath: "/tmp/test-project",
    confirmationCardAccepted: true,
    emergencyStopRequested: false,
    loopGuardConfig: Object.freeze({
      maxIterations: 50,
      maxTokens: 200_000,
      maxConsecutiveFailures: 3,
    }),
    ...overrides,
  };
}

function createTaskCard(overrides: Partial<TaskCard> = {}): TaskCard {
  return {
    id: "T-WIN-001",
    title: "Windows 兼容测试任务",
    requirementId: "F-WIN-001",
    dependencies: [],
    acceptanceCriteria: ["npm test 通过"],
    status: "in-progress",
    declaredSymbols: [],
    declaredFiles: ["src/a.ts"],
    declaredDeletions: [],
    ...overrides,
  };
}

// ============================================================================
// 1. 路径比较基建：isSameOrUnderPath
// ============================================================================

test("W1. isSameOrUnderPath：Windows 反斜杠前缀不再漏判", () => {
  // 旧实现 startsWith(root + "/") 在 Windows 上恒 false，这里钉住修复
  assert.equal(isSameOrUnderPath("C:\\proj\\src\\a.ts", "C:\\proj", "win32"), true);
  assert.equal(isSameOrUnderPath("C:\\proj", "C:\\proj", "win32"), true);
  // 大小写不敏感（NTFS 默认语义）
  assert.equal(isSameOrUnderPath("c:\\PROJ\\src\\a.ts", "C:\\Proj", "win32"), true);
  // 分隔符混写
  assert.equal(isSameOrUnderPath("C:/proj/src/a.ts", "C:\\proj", "win32"), true);
});

test("W2. isSameOrUnderPath：前缀相似但不是子树 → false（防 /tmp 匹配 /tmpx）", () => {
  assert.equal(isSameOrUnderPath("C:\\proj2\\a.ts", "C:\\proj", "win32"), false);
  assert.equal(isSameOrUnderPath("/tmp/x", "/tmpx", "linux"), false);
  assert.equal(isSameOrUnderPath("/tmp/x", "/tmp", "linux"), true);
  // POSIX 下大小写敏感
  assert.equal(isSameOrUnderPath("/TMP/x", "/tmp", "linux"), false);
});

// ============================================================================
// 2. G-A1a 路径牢笼在 Windows 上必须真的生效
// ============================================================================

test("W3. findPathJailViolation：Windows 系统目录写入被判违规", () => {
  const cases = [
    "del C:\\Windows\\System32\\drivers\\etc\\hosts",
    "cmd /c rd /s /q C:\\Program Files\\app",
    "copy payload.exe C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\x.exe",
    'powershell -Command "Set-Content C:\\Windows\\win.ini x"',
  ];
  for (const command of cases) {
    const violation = findPathJailViolation(command, "D:\\work\\proj", "D:\\work\\proj", "win32");
    assert.equal(violation?.kind, "sensitive-directory", `应判为系统敏感目录：${command}`);
  }
});

test("W4. findPathJailViolation：Windows 盘符大小写不能绕过（NTFS 大小写不敏感）", () => {
  const violation = findPathJailViolation("del c:\\windows\\temp\\x.txt", "D:\\work\\proj", "D:\\work\\proj", "win32");
  assert.equal(violation?.kind, "sensitive-directory");
});

test("W5. findPathJailViolation：项目外绝对路径被判违规，项目内放行", () => {
  const outside = findPathJailViolation(
    "copy D:\\secrets\\id_rsa .\\stolen",
    "D:\\work\\proj",
    "D:\\work\\proj",
    "win32"
  );
  assert.equal(outside?.kind, "outside-project-root");

  const inside = findPathJailViolation(
    "node D:\\work\\proj\\scripts\\build.js",
    "D:\\work\\proj",
    "D:\\work\\proj",
    "win32"
  );
  assert.equal(inside, null, "项目内路径必须放行");
});

test("W6. findPathJailViolation：盘符根目录等价于 POSIX 的 /", () => {
  const violation = findPathJailViolation("rd /s /q C:\\", "D:\\work\\proj", "D:\\work\\proj", "win32");
  assert.equal(violation?.kind, "sensitive-directory");
});

test("W7. findPathJailViolation：Git Bash 风格 /c/Windows 需先转盘符再判定", () => {
  const violation = findPathJailViolation(
    "cat /c/Windows/System32/config/SAM",
    "D:\\work\\proj",
    "D:\\work\\proj",
    "win32"
  );
  assert.equal(violation?.kind, "sensitive-directory");
});

test("W8. findPathJailViolation：Windows 临时目录（%TEMP%）写入放行", () => {
  const tempRoot = "C:\\Users\\dev\\AppData\\Local\\Temp";
  const tempFile = `${tempRoot}\\deepcode-w8-probe.txt`;
  const violation = findPathJailViolation(`node "${tempFile}"`, "D:\\work\\proj", "D:\\work\\proj", "win32", {
    tempRoots: [tempRoot],
  });
  assert.equal(violation, null, `临时目录应放行：${tempFile}`);

  // 阴性对照：临时目录之外仍要判越界
  const outside = findPathJailViolation(
    `node "C:\\Users\\dev\\Desktop\\a.txt"`,
    "D:\\work\\proj",
    "D:\\work\\proj",
    "win32",
    {
      tempRoots: [tempRoot],
    }
  );
  assert.equal(outside?.kind, "outside-project-root");
});

test("W9. findPathJailViolation：POSIX 语义未被破坏（阴性对照）", () => {
  // 原有 POSIX 行为必须逐条保持
  assert.equal(
    findPathJailViolation("cat /etc/passwd > ./leaked.txt", "/tmp/test-project", "/tmp/test-project", "linux")?.kind,
    "sensitive-directory"
  );
  assert.equal(
    findPathJailViolation("cp /home/user/.ssh/id_rsa .", "/tmp/test-project", "/tmp/test-project", "linux")?.kind,
    "sensitive-directory"
  );
  assert.equal(findPathJailViolation("node src/index.ts", "/tmp/test-project", "/tmp/test-project", "linux"), null);
  // /dev/null 等设备必须继续放行
  assert.equal(
    findPathJailViolation("npm test > /dev/null 2>&1", "/tmp/test-project", "/tmp/test-project", "linux"),
    null
  );
});

test("W10. EnvBoundaryGuard：Windows 系统目录命令端到端 DENY（G-A1a）", () => {
  const guard = new EnvBoundaryGuard();
  const verdict = guard.check(
    createContext({
      pendingCommand: "cmd /c del /s /q C:\\Windows\\System32\\LogFiles",
      projectRoot: "/tmp/test-project",
      worktreePath: "/tmp/test-project",
    })
  );
  assert.equal(verdict.decision, "DENY");
  assert.equal(verdict.ruleId, "G-A1a");
});

test("W11. EnvBoundaryGuard：%USERPROFILE% 等价于 ~ / $HOME 被拒", () => {
  const guard = new EnvBoundaryGuard();
  const verdict = guard.check(
    createContext({
      pendingCommand: "copy %USERPROFILE%\\.ssh\\id_rsa .\\leaked",
      projectRoot: "/tmp/test-project",
      worktreePath: "/tmp/test-project",
    })
  );
  assert.equal(verdict.decision, "DENY");
  assert.equal(verdict.ruleId, "G-A1a");
});

test("W12. EnvBoundaryGuard：Windows 风格 ..\\ 外溢被拒", () => {
  const guard = new EnvBoundaryGuard();
  const verdict = guard.check(
    createContext({
      pendingCommand: "copy ..\\..\\..\\secrets.txt .\\x",
      projectRoot: "/tmp/test-project",
      worktreePath: "/tmp/test-project",
    })
  );
  assert.equal(verdict.decision, "DENY");
  assert.equal(verdict.ruleId, "G-A1a");
});

test("W13. EnvBoundaryGuard：PowerShell $env: 写受保护变量被拒（G-A1b）", () => {
  const guard = new EnvBoundaryGuard();
  // 用不含绝对路径的命令，隔离出 G-A1b 这一条规则
  const powerShell = guard.check(
    createContext({
      pendingCommand: 'powershell -NoProfile -Command "$env:PATH = x"',
      projectRoot: "/tmp/test-project",
      worktreePath: "/tmp/test-project",
    })
  );
  assert.equal(powerShell.decision, "DENY");
  assert.equal(powerShell.ruleId, "G-A1b");

  // 大小写混写同样命中（Windows 环境变量名大小写不敏感）
  const mixedCase = guard.check(
    createContext({
      pendingCommand: "set Path=x",
      projectRoot: "/tmp/test-project",
      worktreePath: "/tmp/test-project",
    })
  );
  assert.equal(mixedCase.decision, "DENY");
  assert.equal(mixedCase.ruleId, "G-A1b");
});

test("W14. EnvBoundaryGuard：普通 Windows 命令不被误伤（阴性对照）", () => {
  const guard = new EnvBoundaryGuard();
  for (const command of ["npm test", "git status --porcelain", "node --version"]) {
    const verdict = guard.check(
      createContext({
        pendingCommand: command,
        projectRoot: "/tmp/test-project",
        worktreePath: "/tmp/test-project",
      })
    );
    assert.notEqual(verdict.ruleId, "G-A1a", `不应触发路径牢笼：${command}`);
  }
});

// ============================================================================
// 3. G-A2a / G-A2b：Windows 破坏性命令必须进黑名单
// ============================================================================

test("W15. DangerousCommandGuard：Windows 灾难性命令 DENY（G-A2a）", () => {
  const guard = new DangerousCommandGuard();
  const commands = [
    "format C: /q",
    "cmd /c format D:",
    "rd /s /q C:\\Users\\dev",
    "rmdir /s /q node_modules",
    "del /s /q C:\\work",
    "del C:\\*",
    'powershell -Command "Remove-Item -Recurse -Force C:\\work"',
    "diskpart /s script.txt",
    "vssadmin delete shadows /all /quiet",
    "bcdedit /set {default} safeboot minimal",
    "cipher /w:C",
    "reg delete HKLM\\Software\\Microsoft /f",
    "taskkill /F /IM lsass.exe",
    "powershell -EncodedCommand ZQBjAGgAbwA=",
  ];
  for (const command of commands) {
    const verdict = guard.check(
      createContext({
        pendingCommand: command,
        currentTaskCard: createTaskCard(),
      })
    );
    assert.equal(verdict.decision, "DENY", `应被 G-A2a 永禁：${command}`);
    assert.equal(verdict.ruleId, "G-A2a");
  }
});

test("W16. DangerousCommandGuard：常规 Windows 清理动作不被 G-A2a 误杀（阴性对照）", () => {
  const guard = new DangerousCommandGuard();
  // del /f 单文件 = rm -f 粒度，不应触发"永禁"
  const verdict = guard.check(
    createContext({
      pendingCommand: "del /f build\\tmp.txt",
      currentTaskCard: createTaskCard({ declaredDeletions: ["build\\tmp.txt"] }),
    })
  );
  assert.notEqual(verdict.ruleId, "G-A2a", "del /f 单文件不应被永禁");
});

test("W17. DangerousCommandGuard：Windows 删除动作进入 G-A2b 分级（未声明 → ASK）", () => {
  const guard = new DangerousCommandGuard();
  const verdict = guard.check(
    createContext({
      pendingCommand: "del src\\legacy\\old.ts",
      currentTaskCard: createTaskCard({ declaredDeletions: [] }),
    })
  );
  assert.equal(verdict.decision, "ASK");
  assert.equal(verdict.ruleId, "G-A2b");
});

test("W18. DangerousCommandGuard：Windows 删除在 declaredDeletions 内 → PASS", () => {
  const guard = new DangerousCommandGuard();
  const verdict = guard.check(
    createContext({
      pendingCommand: "del src\\legacy\\old.ts",
      currentTaskCard: createTaskCard({ declaredDeletions: ["src\\legacy\\old.ts"] }),
    })
  );
  assert.equal(verdict.decision, "PASS");
});

// ============================================================================
// 4. V2 CommandSafety：Windows 黑名单
// ============================================================================

test("W19. CommandSafety：cmd /c 包裹的 Windows 破坏命令命中黑名单", () => {
  const safety = new CommandSafety();
  const blocked = [
    'cmd /c "rd /s /q C:\\work"',
    "format E:",
    "del /s /q node_modules",
    'powershell -Command "Remove-Item -Recurse -Force C:\\data"',
    "vssadmin delete shadows /all",
    "reg delete HKEY_LOCAL_MACHINE\\Software /f",
  ];
  for (const command of blocked) {
    assert.equal(safety.isBlacklisted(command), true, `应命中黑名单：${command}`);
  }
});

test("W20. CommandSafety：常规命令不误报（阴性对照）", () => {
  const safety = new CommandSafety();
  for (const command of ["npm test", "git status", "node build.js", "del build\\tmp.txt", "dir"]) {
    assert.equal(safety.isBlacklisted(command), false, `不应命中黑名单：${command}`);
  }
});

// ============================================================================
// 5. 权限分级：Windows 临时目录不再被判 out-cwd
// ============================================================================

test("W21. classifyFilePermissionScope：os.tmpdir() 下的文件属 tmp 作用域", () => {
  const projectRoot = path.join(os.tmpdir(), "deepcode-win-scope-proj");
  const tempFile = path.join(os.tmpdir(), "deepcode-win-scope-file.txt");
  const scope = classifyFilePermissionScope(projectRoot, tempFile, "write");
  assert.equal(scope, "write-in-tmp", "临时目录写入应判 write-in-tmp（不再每次弹审批）");
});

test("W22. classifyFilePermissionScope：项目内路径仍判 in-cwd（阴性对照）", () => {
  const projectRoot = path.join(os.tmpdir(), "deepcode-win-scope-proj2");
  const inside = path.join(projectRoot, "src", "a.ts");
  assert.equal(classifyFilePermissionScope(projectRoot, inside, "read"), "read-in-cwd");
});

// ============================================================================
// 6. 通知脚本：Windows 上 .sh 需经 Git Bash 启动
// ============================================================================

test("W23. resolveNotifySpawnPlan：Windows 下 .sh 脚本走 Git Bash", () => {
  const plan = resolveNotifySpawnPlan("C:\\scripts\\notify.sh", "win32", () => "C:\\Program Files\\Git\\bin\\bash.exe");
  assert.equal(plan.command, "C:\\Program Files\\Git\\bin\\bash.exe");
  assert.deepEqual(plan.args, ["C:\\scripts\\notify.sh"]);
});

test("W24. resolveNotifySpawnPlan：Windows 下 .exe 直接启动，不绕 bash", () => {
  const plan = resolveNotifySpawnPlan("C:\\tools\\notify.exe", "win32", () => "C:\\Program Files\\Git\\bin\\bash.exe");
  assert.equal(plan.command, "C:\\tools\\notify.exe");
  assert.deepEqual(plan.args, []);
});

test("W25. resolveNotifySpawnPlan：未安装 Git Bash 时退回直接 spawn（不抛异常）", () => {
  const plan = resolveNotifySpawnPlan("C:\\scripts\\notify.sh", "win32", () => {
    throw new Error("Git Bash not found");
  });
  assert.equal(plan.command, "C:\\scripts\\notify.sh");
});

test("W26. resolveNotifySpawnPlan：POSIX 平台行为不变（阴性对照）", () => {
  const plan = resolveNotifySpawnPlan("/usr/local/bin/notify.sh", "darwin", () => "/bin/bash");
  assert.equal(plan.command, "/usr/local/bin/notify.sh");
  assert.deepEqual(plan.args, []);
});

// ============================================================================
// 7. Windows 文件路径规则：保留设备名 / 非法字符 / 尾随点空格 / MAX_PATH
// ============================================================================

test("W27. findWindowsPathIssue：保留设备名一律拒绝（CON/NUL/COM1/LPT9）", () => {
  const cases = ["C:\\work\\CON", "C:\\work\\nul.txt", "D:\\a\\com1.log", "C:\\x\\lpt9", "C:\\work\\AUX.tar.gz"];
  for (const filePath of cases) {
    const issue = findWindowsPathIssue(filePath, { platform: "win32" });
    assert.equal(issue?.code, "reserved-device-name", `应判为保留设备名：${filePath}`);
  }
  // 保留名列表本身要覆盖经典设备名
  for (const name of ["CON", "PRN", "AUX", "NUL", "COM1", "LPT9"]) {
    assert.equal(WINDOWS_RESERVED_DEVICE_NAMES.has(name), true, `保留名列表缺少 ${name}`);
  }
});

test("W28. findWindowsPathIssue：保留名大小写混写 + 尾随空格同样命中", () => {
  for (const filePath of ["C:\\work\\Con", "C:\\work\\nUl", "C:\\work\\CON ", "C:\\work\\Com1.txt"]) {
    assert.equal(
      findWindowsPathIssue(filePath, { platform: "win32" })?.code,
      "reserved-device-name",
      `应判为保留设备名：${filePath}`
    );
  }
});

test("W29. findWindowsPathIssue：形似保留名的普通文件名不受影响（阴性对照）", () => {
  const allowed = [
    "C:\\work\\console.ts",
    "C:\\work\\nullable.ts",
    "C:\\work\\com10.log",
    "C:\\work\\CONSOLE\\a.ts",
    "C:\\work\\common\\aux-helper.ts",
    "C:\\work\\lpt.txt",
  ];
  for (const filePath of allowed) {
    assert.equal(findWindowsPathIssue(filePath, { platform: "win32" }), null, `不应误伤：${filePath}`);
  }
});

test("W30. findWindowsPathIssue：非法字符与盘符冒号区分对待", () => {
  for (const filePath of [
    "C:\\work\\a<b.ts",
    "C:\\work\\a>b.ts",
    "C:\\work\\a|b.ts",
    "C:\\work\\a?b.ts",
    "C:\\work\\a*b.ts",
    'C:\\work\\a"b.ts',
    "C:\\work\\a:b.ts",
    "C:\\work\\a\u0001b.ts",
  ]) {
    assert.equal(
      findWindowsPathIssue(filePath, { platform: "win32" })?.code,
      "invalid-character",
      `应判为非法字符：${JSON.stringify(filePath)}`
    );
  }
  // 盘符位置的冒号是合法结构，不能误判
  assert.equal(findWindowsPathIssue("C:\\work\\a.ts", { platform: "win32" }), null);
});

test("W31. findWindowsPathIssue：尾随点/空格会被 Win32 静默裁剪，必须拒绝", () => {
  for (const filePath of ["C:\\work\\foo.", "C:\\work\\foo ", "C:\\work\\bar.ts.", "C:\\work\\baz.. "]) {
    assert.equal(
      findWindowsPathIssue(filePath, { platform: "win32" })?.code,
      "trailing-dot-or-space",
      `应判为尾随点/空格：${JSON.stringify(filePath)}`
    );
  }
  // 中间的点、前导空格都是合法文件名
  assert.equal(findWindowsPathIssue("C:\\work\\foo.bar.baz", { platform: "win32" }), null);
  assert.equal(findWindowsPathIssue("C:\\work\\ leading.txt", { platform: "win32" }), null);
});

test("W32. findWindowsPathIssue：MAX_PATH 260 拒绝，\\\\?\\ 前缀放行", () => {
  const base = "C:\\work\\";
  const nearLimit = base + "a".repeat(WINDOWS_MAX_PATH - 1 - base.length);
  assert.equal(nearLimit.length, WINDOWS_MAX_PATH - 1);
  assert.equal(findWindowsPathIssue(nearLimit, { platform: "win32" }), null, "259 字符应放行");

  const tooLong = base + "a".repeat(WINDOWS_MAX_PATH - base.length);
  assert.equal(tooLong.length, WINDOWS_MAX_PATH);
  assert.equal(findWindowsPathIssue(tooLong, { platform: "win32" })?.code, "path-too-long");

  // 显式使用扩展长度前缀 = 用户主动开启长路径，跳过长度限制
  assert.equal(findWindowsPathIssue(`\\\\?\\${tooLong}`, { platform: "win32" }), null);
});

test("W33. findWindowsPathIssue：\\\\.\\ 设备命名空间直接拒绝", () => {
  for (const filePath of ["\\\\.\\PhysicalDrive0", "\\\\.\\C:\\Windows\\a.txt"]) {
    assert.equal(
      findWindowsPathIssue(filePath, { platform: "win32" })?.code,
      "device-namespace",
      `应判为设备命名空间：${filePath}`
    );
  }
});

test("W34. findWindowsPathIssue：非 Windows 平台完全跳过校验（阴性对照）", () => {
  // POSIX 上 `CON` / `a<b` 都是合法文件名，不能被 Windows 规则误杀
  assert.equal(findWindowsPathIssue("C:\\work\\CON", { platform: "linux" }), null);
  assert.equal(findWindowsPathIssue("/tmp/a<b.ts", { platform: "darwin" }), null);
  assert.equal(findWindowsPathIssue("/tmp/foo.", { platform: "linux" }), null);
});

test("W35. validateWindowsFileToolPath：返回带错误码的一行说明供工具层直接回显", () => {
  const message = validateWindowsFileToolPath("C:\\work\\CON", { platform: "win32" });
  assert.ok(message, "Windows 上必须返回错误说明");
  assert.match(message, /\[reserved-device-name\]/);
  assert.match(message, /CON/);
  // 正常路径在 Windows 上返回 null
  assert.equal(validateWindowsFileToolPath("C:\\work\\normal.ts", { platform: "win32" }), null);
  // 非 Windows 平台不拦截（工具层用默认平台调用，POSIX 机器上必须无副作用）
  assert.equal(validateWindowsFileToolPath("C:\\work\\CON", { platform: "linux" }), null);
});

// ============================================================================
// 8. 文件状态键：Windows 大小写折叠，避免同一文件两条记录
// ============================================================================

test("W36. fileStateKey：win32 折叠大小写，POSIX 保持敏感", () => {
  assert.equal(fileStateKey("C:\\Work\\A.ts", "win32"), fileStateKey("c:\\work\\a.ts", "win32"));
  assert.notEqual(fileStateKey("/tmp/A.ts", "linux"), fileStateKey("/tmp/a.ts", "linux"));
  // 分隔符归一后仍是同一键（Windows 上 / 与 \ 等价）
  assert.equal(fileStateKey("C:/work/A.ts", "win32"), fileStateKey("C:\\work\\a.ts", "win32"));
});

test("W37. recordFileState：win32 上不同大小写拼写归为一条记录且版本号累加", () => {
  const sessionId = "win-case-fold-session";
  clearSessionState(sessionId);

  recordFileState(
    sessionId,
    { filePath: "C:\\work\\Foo.ts", content: "first", timestamp: 1 },
    { incrementVersion: true, platform: "win32" }
  );
  recordFileState(
    sessionId,
    { filePath: "c:\\WORK\\foo.ts", content: "second", timestamp: 2 },
    { incrementVersion: true, platform: "win32" }
  );

  const state = getFileState(sessionId, "C:\\Work\\FOO.TS", "win32");
  assert.ok(state, "任意大小写拼写都应命中同一记录");
  assert.equal(state?.content, "second");
  assert.equal(state?.version, 2, "两次写入应累加为版本 2（旧实现会各自记版本 1）");
  // 展示/落盘用的 filePath 保持原样大小写，不能被折叠成小写
  // （win32 归一化只统一分隔符，不改变字母大小写）
  assert.equal(state?.filePath, "c:\\WORK\\foo.ts");
  assert.equal(getFileVersion(sessionId, "C:\\WORK\\FOO.TS", "win32"), 2);

  clearSessionState(sessionId);
});

test("W38. recordFileState：POSIX 保持大小写敏感，两条路径各记一条（阴性对照）", () => {
  const sessionId = "posix-case-session";
  clearSessionState(sessionId);

  recordFileState(sessionId, { filePath: "/tmp/Foo.ts", content: "a", timestamp: 1 }, { platform: "linux" });
  recordFileState(sessionId, { filePath: "/tmp/foo.ts", content: "b", timestamp: 2 }, { platform: "linux" });

  assert.equal(getFileState(sessionId, "/tmp/Foo.ts", "linux")?.content, "a");
  assert.equal(getFileState(sessionId, "/tmp/foo.ts", "linux")?.content, "b");
  assert.equal(getFileState(sessionId, "/tmp/FOO.ts", "linux"), null);

  clearSessionState(sessionId);
});
