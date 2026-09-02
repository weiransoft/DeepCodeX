import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDisableExtglobCommand,
  // fork 保留：buildShellEnv 敏感环境变量过滤
  buildShellEnv,
  buildShellInitCommand,
  getShellKind,
  posixPathToWindowsPath,
  resolveWindowsGitBashPath,
  rewriteWindowsNullRedirect,
  windowsPathToPosixPath,
} from "../common/shell-utils";
import { isAbsoluteFilePath, normalizeFilePath } from "../common/state";

test("Windows paths convert to Git Bash POSIX paths", () => {
  assert.equal(windowsPathToPosixPath("C:\\Users\\foo"), "/c/Users/foo");
  assert.equal(windowsPathToPosixPath("d:\\IdeaProjects\\guesswho-api"), "/d/IdeaProjects/guesswho-api");
  assert.equal(windowsPathToPosixPath("\\\\server\\share\\dir"), "//server/share/dir");
});

test("Git Bash POSIX paths convert to native Windows paths", () => {
  assert.equal(posixPathToWindowsPath("/c/Users/foo"), "C:\\Users\\foo");
  assert.equal(posixPathToWindowsPath("/cygdrive/d/IdeaProjects/guesswho-api"), "D:\\IdeaProjects\\guesswho-api");
  assert.equal(posixPathToWindowsPath("//server/share/dir"), "\\\\server\\share\\dir");
});

test("Windows nul redirects are rewritten for POSIX bash", () => {
  assert.equal(rewriteWindowsNullRedirect("cmd >nul"), "cmd >/dev/null");
  assert.equal(rewriteWindowsNullRedirect("cmd 2>NUL && next"), "cmd 2>/dev/null && next");
  assert.equal(rewriteWindowsNullRedirect("cmd &>nul\nnext"), "cmd &>/dev/null\nnext");
  assert.equal(rewriteWindowsNullRedirect("echo nullable"), "echo nullable");
});

test("Shell kind detection supports Windows bash.exe paths", () => {
  assert.equal(getShellKind("C:\\Program Files\\Git\\bin\\bash.exe"), "bash");
  assert.equal(getShellKind("/bin/zsh"), "zsh");
  assert.equal(
    buildDisableExtglobCommand("C:\\Program Files\\Git\\bin\\bash.exe"),
    "shopt -u extglob 2>/dev/null || true"
  );
  assert.equal(buildDisableExtglobCommand("/bin/zsh"), "setopt NO_EXTENDED_GLOB 2>/dev/null || true");
});

test("Shell init commands suppress startup file output", () => {
  assert.equal(
    buildShellInitCommand("/bin/zsh"),
    'ZSHRC="${ZDOTDIR:-$HOME}/.zshrc"; if [ -f "$ZSHRC" ]; then { . "$ZSHRC"; } >/dev/null 2>&1; fi'
  );
  assert.equal(
    buildShellInitCommand("/bin/bash"),
    'BASHRC="${BASH_ENV:-$HOME/.bashrc}"; if [ -f "$BASHRC" ]; then { . "$BASHRC"; } >/dev/null 2>&1; fi'
  );
  assert.equal(buildShellInitCommand("/bin/fish"), null);
});

test("Windows Git Bash detection prefers bash.exe from PATH", () => {
  const bashPath = "D:\\Tools\\Git\\bin\\bash.exe";
  const resolved = resolveWindowsGitBashPath({
    findExecutableCandidates: (executable) => (executable === "bash" ? [bashPath] : []),
    findGitExecPath: () => null,
    existsSync: (candidate) => candidate === bashPath,
  });

  assert.equal(resolved, bashPath);
});

test("Windows Git Bash detection derives bash.exe from git exec path", () => {
  const bashPath = "D:\\Tools\\Git\\bin\\bash.exe";
  const resolved = resolveWindowsGitBashPath({
    findExecutableCandidates: () => [],
    findGitExecPath: () => "D:/Tools/Git/mingw64/libexec/git-core",
    existsSync: (candidate) => candidate === bashPath,
  });

  assert.equal(resolved, bashPath);
});

test("Windows Git Bash detection derives bash.exe from git.exe candidates", () => {
  const bashPath = "D:\\Tools\\Git\\bin\\bash.exe";
  const resolved = resolveWindowsGitBashPath({
    findExecutableCandidates: (executable) => (executable === "git" ? ["D:\\Tools\\Git\\cmd\\git.exe"] : []),
    findGitExecPath: () => null,
    existsSync: (candidate) => candidate === bashPath,
  });

  assert.equal(resolved, bashPath);
});

test("Windows Git Bash detection skips WSL System32 bash.exe in PATH results", () => {
  // When WSL1 is enabled on older Windows 10, C:\Windows\System32\bash.exe
  // appears in PATH. That launcher would execute commands inside the Linux
  // distro instead of the Windows host, breaking all tool invocations.
  // The PATH bash strategy should ignore it and fall through.
  const system32Bash = "C:\\Windows\\System32\\bash.exe";
  const gitBash = "D:\\Tools\\Git\\bin\\bash.exe";
  const resolved = resolveWindowsGitBashPath({
    findExecutableCandidates: (executable) =>
      executable === "bash" ? [system32Bash] : executable === "git" ? ["D:\\Tools\\Git\\cmd\\git.exe"] : [],
    findGitExecPath: () => null,
    existsSync: (candidate) => candidate === gitBash,
  });

  assert.equal(resolved, gitBash);
});

test("File tool path normalization converts Git Bash drive paths on Windows", () => {
  assert.equal(
    normalizeFilePath("/d/IdeaProjects/guesswho-api/API_DOCUMENTATION.md", "win32"),
    "D:\\IdeaProjects\\guesswho-api\\API_DOCUMENTATION.md"
  );
  assert.equal(normalizeFilePath("/cygdrive/c/Users/foo/file.txt", "win32"), "C:\\Users\\foo\\file.txt");
  assert.equal(normalizeFilePath("/dev/null", "win32"), "\\dev\\null");
});

test("File tool absolute checks accept Git Bash drive paths but reject root-relative POSIX paths on Windows", () => {
  assert.equal(isAbsoluteFilePath("/d/IdeaProjects/guesswho-api/API_DOCUMENTATION.md", "win32"), true);
  assert.equal(isAbsoluteFilePath("D:/IdeaProjects/guesswho-api/API_DOCUMENTATION.md", "win32"), true);
  assert.equal(isAbsoluteFilePath("/dev/null", "win32"), false);
  assert.equal(isAbsoluteFilePath("./API_DOCUMENTATION.md", "win32"), false);
});

// fork 保留用例：buildShellEnv 敏感环境变量过滤（黑名单 + 白名单）

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const original: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    original[key] = process.env[key];
    if (overrides[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("buildShellEnv 过滤 API_KEY 等敏感环境变量", () => {
  const env = withEnv(
    {
      API_KEY: "sk-secret",
      LLM_API_KEY: "sk-llm",
      ANTHROPIC_API_KEY: "sk-ant",
      OPENAI_API_KEY: "sk-openai",
      SECRET_TOKEN: "token",
      PASSWORD: "pwd",
      PRIVATE_KEY: "key",
      SSH_AUTH_SOCK: "/tmp/ssh",
      DEEPCODE_DEBUG: "1",
    },
    () => buildShellEnv("/bin/bash")
  );

  assert.equal(env.API_KEY, undefined);
  assert.equal(env.LLM_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.SECRET_TOKEN, undefined);
  assert.equal(env.PASSWORD, undefined);
  assert.equal(env.PRIVATE_KEY, undefined);
  assert.equal(env.SSH_AUTH_SOCK, undefined);
  assert.equal(env.DEEPCODE_DEBUG, undefined);
});

test("buildShellEnv 保留 PATH/HOME/USER/SHELL 等基础变量", () => {
  const env = withEnv(
    {
      PATH: "/usr/bin:/bin",
      HOME: "/home/user",
      USER: "user",
      SHELL: "/bin/zsh",
    },
    () => buildShellEnv("/bin/bash")
  );

  assert.equal(env.PATH, "/usr/bin:/bin");
  assert.equal(env.HOME, "/home/user");
  assert.equal(env.USER, "user");
  assert.equal(env.SHELL, "/bin/bash");
});

test("buildShellEnv 黑名单优先于 extraEnv", () => {
  const env = buildShellEnv("/bin/bash", { API_KEY: "sk-extra", PATH: "/extra" });
  assert.equal(env.API_KEY, undefined);
  assert.equal(env.PATH, "/extra");
});
