import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { getSystemPrompt, getTools } from "../prompt";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("getTools always includes WebSearch", () => {
  const names = getTools().map((tool) => tool.function.name);
  assert.equal(names.includes("WebSearch"), true);
});

test("getSystemPrompt always includes WebSearch docs", () => {
  const prompt = getSystemPrompt("/tmp/project");
  assert.equal(prompt.includes("## WebSearch"), true);
});

test("getSystemPrompt includes current date guidance", () => {
  const now = new Date();
  const expected = `今天是${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日。随着对话的进行，时间在流逝。`;
  const prompt = getSystemPrompt("/tmp/project");
  assert.equal(prompt.includes(expected), true);
});

test("getSystemPrompt renders Read docs for non-multimodal models", () => {
  const prompt = getSystemPrompt("/tmp/project", { model: "deepseek-chat" });
  assert.equal(prompt.includes("the current model is not multimodal"), true);
  assert.equal(prompt.includes("the contents are presented visually"), false);
});

test("runtime prompt assets live under templates", () => {
  assert.equal(fs.existsSync(path.join(repoRoot, "templates", "tools", "web-search.md")), true);
  assert.equal(fs.existsSync(path.join(repoRoot, "templates", "tools", "read.md.ejs")), true);
  assert.equal(fs.existsSync(path.join(repoRoot, "templates", "prompts", "init_command.md.ejs")), true);
  assert.equal(fs.existsSync(path.join(repoRoot, "templates", "tools", "read.md")), false);
  assert.equal(fs.existsSync(path.join(repoRoot, "docs", "tools")), false);
  assert.equal(fs.existsSync(path.join(repoRoot, "docs", "prompts")), false);
});
