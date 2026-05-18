import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  filterFileMentionItems,
  formatFileMentionPath,
  getCurrentFileMentionToken,
  replaceCurrentFileMentionToken,
  scanFileMentionItems,
  type FileMentionItem,
} from "../ui/fileMentions";

test("getCurrentFileMentionToken detects bare @file tokens under the cursor", () => {
  assert.deepEqual(getCurrentFileMentionToken({ text: "review @src/app.ts please", cursor: 10 }), {
    query: "src/app.ts",
    start: 7,
    end: 18,
    quoted: false,
  });
  assert.deepEqual(getCurrentFileMentionToken({ text: "@", cursor: 1 }), {
    query: "",
    start: 0,
    end: 1,
    quoted: false,
  });
  assert.equal(getCurrentFileMentionToken({ text: "foo@bar", cursor: 7 }), null);
});

test("getCurrentFileMentionToken supports quoted paths with spaces", () => {
  assert.deepEqual(getCurrentFileMentionToken({ text: 'open @"docs/my file.md"', cursor: 22 }), {
    query: "docs/my file.md",
    start: 5,
    end: 23,
    quoted: true,
  });
  assert.deepEqual(getCurrentFileMentionToken({ text: 'open @"docs/my', cursor: 14 }), {
    query: "docs/my",
    start: 5,
    end: 14,
    quoted: true,
  });
  assert.equal(getCurrentFileMentionToken({ text: 'open @"docs/my file.md" now', cursor: 24 }), null);
});

test("formatFileMentionPath quotes only paths that need it", () => {
  assert.equal(formatFileMentionPath("src/App.tsx"), "@src/App.tsx");
  assert.equal(formatFileMentionPath("docs/my file.md"), '@"docs/my file.md"');
  assert.equal(formatFileMentionPath('docs/a"b.md'), '@"docs/a\\"b.md"');
});

test("replaceCurrentFileMentionToken inserts a trailing-space mention", () => {
  const state = { text: "read @sr then", cursor: 8 };
  const token = getCurrentFileMentionToken(state);
  assert.ok(token);
  assert.deepEqual(replaceCurrentFileMentionToken(state, token, "src/index.ts"), {
    text: "read @src/index.ts then",
    cursor: 19,
  });

  const quotedState = { text: 'read @"doc', cursor: 10 };
  const quotedToken = getCurrentFileMentionToken(quotedState);
  assert.ok(quotedToken);
  assert.deepEqual(replaceCurrentFileMentionToken(quotedState, quotedToken, "docs/my file.md"), {
    text: 'read @"docs/my file.md" ',
    cursor: 24,
  });
});

test("filterFileMentionItems prioritizes prefix and basename matches", () => {
  const items: FileMentionItem[] = [
    { path: "src/PromptInput.tsx", type: "file" },
    { path: "docs/prompt guide.md", type: "file" },
    { path: "templates/prompts/init.md", type: "file" },
  ];

  assert.deepEqual(
    filterFileMentionItems(items, "prompt").map((item) => item.path),
    ["docs/prompt guide.md", "src/PromptInput.tsx", "templates/prompts/init.md"]
  );
});

test("scanFileMentionItems returns relative slash-separated files and directories", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-file-mentions-"));
  try {
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "index.ts"), "");
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.writeFileSync(path.join(root, "node_modules", "ignored.js"), "");

    assert.deepEqual(
      scanFileMentionItems(root).map((item) => item.path),
      ["node_modules/", "node_modules/ignored.js", "src/", "src/index.ts"]
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("scanFileMentionItems respects project gitignore patterns inside git repositories", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-file-mentions-"));
  try {
    fs.mkdirSync(path.join(root, ".git"));
    fs.mkdirSync(path.join(root, ".mypy_cache"), { recursive: true });
    fs.writeFileSync(path.join(root, ".mypy_cache", "ignored.json"), "");
    fs.mkdirSync(path.join(root, "tmp"));
    fs.writeFileSync(path.join(root, "tmp", "ignored.txt"), "");
    fs.mkdirSync(path.join(root, "docs"));
    fs.writeFileSync(path.join(root, "docs", "guide.md"), "");
    fs.writeFileSync(path.join(root, ".gitignore"), ".mypy_cache/\ntmp/\n");

    assert.deepEqual(
      scanFileMentionItems(root).map((item) => item.path),
      ["docs/", "docs/guide.md", ".gitignore"]
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("scanFileMentionItems ignores gitignore files outside git repositories", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-file-mentions-"));
  try {
    fs.mkdirSync(path.join(root, "tmp"));
    fs.writeFileSync(path.join(root, "tmp", "visible.txt"), "");
    fs.writeFileSync(path.join(root, ".gitignore"), "tmp/\n");

    assert.deepEqual(
      scanFileMentionItems(root).map((item) => item.path),
      ["tmp/", "tmp/visible.txt", ".gitignore"]
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("scanFileMentionItems applies parent and nested ignore files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-file-mentions-"));
  try {
    fs.mkdirSync(path.join(root, ".git"));
    fs.writeFileSync(path.join(root, ".gitignore"), "ignored-from-parent/\n");
    fs.mkdirSync(path.join(root, "sub", "ignored-from-parent"), { recursive: true });
    fs.writeFileSync(path.join(root, "sub", "ignored-from-parent", "hidden.txt"), "");
    fs.mkdirSync(path.join(root, "sub", "nested", "ignored-from-nested"), { recursive: true });
    fs.writeFileSync(path.join(root, "sub", "nested", ".gitignore"), "ignored-from-nested/\n");
    fs.writeFileSync(path.join(root, "sub", "nested", "ignored-from-nested", "hidden.txt"), "");
    fs.writeFileSync(path.join(root, "sub", "nested", "visible.txt"), "");

    assert.deepEqual(
      scanFileMentionItems(path.join(root, "sub")).map((item) => item.path),
      ["nested/", "nested/.gitignore", "nested/visible.txt"]
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
