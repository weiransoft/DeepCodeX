/**
 * CodeMapGenerator 单元测试
 *
 * 覆盖：多语言解析、依赖提取、复杂度评估、死代码检测、Markdown 输出
 *
 * 严格遵循 user rules：不使用 mock，所有测试基于真实文件系统
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { CodeMapGenerator } from "../../codemap/generator.js";

describe("CodeMapGenerator", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codemap-test-"));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("基本扫描", () => {
    it("应扫描空目录并返回空地图", async () => {
      const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "codemap-empty-"));
      const gen = new CodeMapGenerator({ projectRoot: emptyDir });
      const map = await gen.generate();
      assert.equal(map.stats.fileCount, 0);
      assert.equal(map.nodes.length, 0);
      await fs.rm(emptyDir, { recursive: true, force: true });
    });

    it("应跳过 node_modules", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codemap-nm-"));
      await fs.mkdir(path.join(dir, "node_modules", "x"), { recursive: true });
      await fs.writeFile(path.join(dir, "node_modules", "x", "skip.ts"), "export const x = 1;");
      await fs.writeFile(path.join(dir, "main.ts"), "export const y = 2;");
      const gen = new CodeMapGenerator({ projectRoot: dir });
      const map = await gen.generate();
      const relativePaths = map.nodes.filter((n) => n.kind === "file").map((n) => n.relativePath);
      assert.ok(relativePaths.includes("main.ts"));
      assert.ok(!relativePaths.some((p) => p.includes("node_modules")));
      await fs.rm(dir, { recursive: true, force: true });
    });

    it("应仅分析配置中的扩展名", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codemap-ext-"));
      await fs.writeFile(path.join(dir, "a.ts"), "export const a = 1;");
      await fs.writeFile(path.join(dir, "b.md"), "# Title");
      const gen = new CodeMapGenerator({ projectRoot: dir });
      const map = await gen.generate();
      const filePaths = map.nodes.filter((n) => n.kind === "file").map((n) => n.relativePath);
      assert.equal(filePaths.length, 1);
      assert.equal(filePaths[0], "a.ts");
      await fs.rm(dir, { recursive: true, force: true });
    });
  });

  describe("TypeScript / JavaScript 解析", () => {
    it("应提取 import 边", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codemap-ts-"));
      await fs.writeFile(
        path.join(dir, "a.ts"),
        `
import { x } from "./b.js";
import "lodash";
export const a = x;
      `
      );
      await fs.writeFile(path.join(dir, "b.ts"), `export const x = 1;`);
      const gen = new CodeMapGenerator({ projectRoot: dir });
      const map = await gen.generate();
      const importEdges = map.edges.filter((e) => e.kind === "imports");
      assert.ok(importEdges.length >= 2, "应至少有 2 条 import 边");
    });

    it("应提取顶层 const/let/var 节点", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codemap-ts-"));
      await fs.writeFile(
        path.join(dir, "a.ts"),
        `
export const LOW = 1;
const MAX_COUNT = 100;
let name = "x";
      `
      );
      const gen = new CodeMapGenerator({ projectRoot: dir });
      const map = await gen.generate();
      const consts = map.nodes.filter((n) => n.kind === "constant");
      const vars = map.nodes.filter((n) => n.kind === "variable");
      assert.ok(consts.length >= 2, "应有 2 个常量");
      assert.ok(vars.length >= 1, "应有 1 个变量");
    });

    it("应提取 function 节点并计算复杂度", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codemap-ts-"));
      await fs.writeFile(
        path.join(dir, "a.ts"),
        `
/** 简单函数 */
export function simple() {
  return 1;
}

/** 复杂函数 */
export function complex(x: number) {
  if (x > 0) {
    if (x > 10) return 2;
    return 1;
  } else if (x < 0) {
    return -1;
  }
  return 0;
}
      `
      );
      const gen = new CodeMapGenerator({ projectRoot: dir });
      const map = await gen.generate();
      const fns = map.nodes.filter((n) => n.kind === "function" && n.name !== "constructor");
      const simple = fns.find((f) => f.name === "simple");
      const complexFn = fns.find((f) => f.name === "complex");
      assert.ok(simple);
      assert.ok(complexFn);
      assert.equal(simple!.complexity, 1, "简单函数复杂度 = 1");
      assert.ok(complexFn!.complexity >= 4, "复杂函数复杂度 >= 4");
      assert.match(simple!.docstring, /简单函数/);
    });

    it("应提取 class 节点与方法", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codemap-ts-"));
      await fs.writeFile(
        path.join(dir, "a.ts"),
        `
export class Foo extends Bar implements IQuack {
  public name: string = "x";
  constructor() { this.name = "y"; }
  public greet(): string {
    if (this.name) return "hi";
    return "bye";
  }
}
      `
      );
      const gen = new CodeMapGenerator({ projectRoot: dir });
      const map = await gen.generate();
      const cls = map.nodes.find((n) => n.kind === "class" && n.name === "Foo");
      const method = map.nodes.find((n) => n.kind === "method" && n.name === "greet");
      assert.ok(cls, "应找到 Foo class");
      assert.ok(method, "应找到 greet method");
      assert.equal(method!.parentId, "class::a.ts::Foo");
      // extends 边
      const ext = map.edges.find((e) => e.kind === "extends" && e.from.includes("Bar"));
      assert.ok(ext, "应找到 extends 边");
    });

    it("应提取 interface 节点", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codemap-ts-"));
      await fs.writeFile(
        path.join(dir, "a.ts"),
        `
export interface IUser {
  id: string;
  name: string;
}
      `
      );
      const gen = new CodeMapGenerator({ projectRoot: dir });
      const map = await gen.generate();
      const iface = map.nodes.find((n) => n.kind === "interface" && n.name === "IUser");
      assert.ok(iface);
    });
  });

  describe("Python 解析", () => {
    it("应提取 def 节点", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codemap-py-"));
      await fs.writeFile(
        path.join(dir, "a.py"),
        `
def hello():
    return 1

async def fetch():
    return 2
      `
      );
      const gen = new CodeMapGenerator({ projectRoot: dir });
      const map = await gen.generate();
      const fns = map.nodes.filter((n) => n.kind === "function");
      const names = fns.map((f) => f.name);
      assert.ok(names.includes("hello"));
      assert.ok(names.includes("fetch"));
    });

    it("应提取 class 节点与基类边", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codemap-py-"));
      await fs.writeFile(
        path.join(dir, "a.py"),
        `
class Animal:
    def speak(self):
        pass

class Dog(Animal):
    def speak(self):
        return "woof"
      `
      );
      const gen = new CodeMapGenerator({ projectRoot: dir });
      const map = await gen.generate();
      const dog = map.nodes.find((n) => n.kind === "class" && n.name === "Dog");
      const ext = map.edges.find((e) => e.kind === "extends" && e.to.includes("Dog"));
      assert.ok(dog);
      assert.ok(ext);
    });

    it("应提取 import 边", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codemap-py-"));
      await fs.writeFile(
        path.join(dir, "a.py"),
        `
import os
from typing import List
      `
      );
      const gen = new CodeMapGenerator({ projectRoot: dir });
      const map = await gen.generate();
      const importEdges = map.edges.filter((e) => e.kind === "imports");
      assert.ok(importEdges.length >= 2);
    });
  });

  describe("Java 解析", () => {
    it("应提取 class / interface / import", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codemap-java-"));
      await fs.writeFile(
        path.join(dir, "A.java"),
        `
package com.example;
import java.util.List;

public class A extends B implements IHello {
  public void greet() {
    if (true) System.out.println("hi");
  }
}
      `
      );
      const gen = new CodeMapGenerator({ projectRoot: dir });
      const map = await gen.generate();
      const cls = map.nodes.find((n) => n.kind === "class" && n.name === "A");
      const method = map.nodes.find((n) => n.kind === "method" && n.name === "greet");
      const ext = map.edges.find((e) => e.kind === "extends" && e.to.includes("A"));
      const imp = map.edges.find((e) => e.kind === "imports" && e.from.includes("List"));
      assert.ok(cls);
      assert.ok(method);
      assert.ok(ext);
      assert.ok(imp);
    });
  });

  describe("Go 解析", () => {
    it("应提取 func 和 import block", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codemap-go-"));
      await fs.writeFile(
        path.join(dir, "main.go"),
        `
package main

import (
  "fmt"
  "os"
)

func main() {
  fmt.Println("hi")
  if os.Args != nil {
    fmt.Println("args")
  }
}
      `
      );
      const gen = new CodeMapGenerator({ projectRoot: dir });
      const map = await gen.generate();
      const fn = map.nodes.find((n) => n.name === "main" && (n.kind === "function" || n.kind === "method"));
      const imports = map.edges.filter((e) => e.kind === "imports");
      assert.ok(fn);
      assert.ok(imports.length >= 2);
    });

    it("应识别 method (带 receiver)", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codemap-go-"));
      await fs.writeFile(
        path.join(dir, "t.go"),
        `
package t
type Foo struct {}
func (f *Foo) Bar() { return }
      `
      );
      const gen = new CodeMapGenerator({ projectRoot: dir });
      const map = await gen.generate();
      const method = map.nodes.find((n) => n.kind === "method" && n.name === "Bar");
      const cls = map.nodes.find((n) => n.kind === "class" && n.name === "Foo");
      assert.ok(method);
      assert.ok(cls);
    });
  });

  describe("Rust 解析", () => {
    it("应提取 fn, struct, trait", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codemap-rs-"));
      await fs.writeFile(
        path.join(dir, "lib.rs"),
        `
use std::collections::HashMap;

pub struct User {
  pub name: String,
}

pub trait Greet {
  fn greet(&self) -> String;
}

impl Greet for User {
  fn greet(&self) -> String {
    if self.name.is_empty() { return "anon".to_string(); }
    self.name.clone()
  }
}
      `
      );
      const gen = new CodeMapGenerator({ projectRoot: dir });
      const map = await gen.generate();
      const userStruct = map.nodes.find((n) => n.kind === "class" && n.name === "User");
      const greetTrait = map.nodes.find((n) => n.kind === "interface" && n.name === "Greet");
      const method = map.nodes.find((n) => n.kind === "method" && n.name === "greet");
      const useEdge = map.edges.find((e) => e.kind === "imports" && e.from.includes("HashMap"));
      assert.ok(userStruct);
      assert.ok(greetTrait);
      assert.ok(method);
      assert.ok(useEdge);
    });
  });

  describe("统计与死代码", () => {
    it("语言分布应正确", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codemap-stats-"));
      await fs.writeFile(path.join(dir, "a.ts"), "export const a = 1;");
      await fs.writeFile(path.join(dir, "b.py"), "a = 1");
      await fs.writeFile(path.join(dir, "c.go"), "package c");
      const gen = new CodeMapGenerator({ projectRoot: dir });
      const map = await gen.generate();
      assert.equal(map.stats.languageBreakdown["typescript"], 1);
      assert.equal(map.stats.languageBreakdown["python"], 1);
      assert.equal(map.stats.languageBreakdown["go"], 1);
    });

    it("节点类型分布应正确", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codemap-stats-"));
      await fs.writeFile(
        path.join(dir, "a.ts"),
        `
export class Foo { public bar() { return 1; } }
export function baz() { return 2; }
export interface I { x: number; }
export const X = 1;
      `
      );
      const gen = new CodeMapGenerator({ projectRoot: dir });
      const map = await gen.generate();
      assert.ok(map.stats.nodesByKind["class"] >= 1);
      assert.ok(map.stats.nodesByKind["function"] >= 1);
      assert.ok(map.stats.nodesByKind["interface"] >= 1);
      assert.ok(map.stats.nodesByKind["constant"] >= 1);
    });

    it("复杂度 Top10 应按降序排列", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codemap-cx-"));
      await fs.writeFile(
        path.join(dir, "a.ts"),
        `
export function simple() { return 1; }
export function medium(x: number) {
  if (x > 0) return 1;
  if (x < 0) return -1;
  return 0;
}
      `
      );
      const gen = new CodeMapGenerator({ projectRoot: dir });
      const map = await gen.generate();
      assert.ok(map.stats.topComplexNodes.length >= 2);
      // 第一个应该 >= 第二个
      assert.ok(map.stats.topComplexNodes[0]!.complexity >= map.stats.topComplexNodes[1]!.complexity);
    });

    it("死代码候选应包含无入边的类/函数", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codemap-dead-"));
      await fs.writeFile(
        path.join(dir, "a.ts"),
        `
export class Used { public f() { return 1; } }
export class Unused { public f() { return 1; } }
export function caller() {
  const u = new Used();
  return u.f();
}
      `
      );
      const gen = new CodeMapGenerator({ projectRoot: dir });
      const map = await gen.generate();
      const deadIds = map.stats.deadCodeCandidates;
      assert.ok(
        deadIds.some((id) => id.includes("Unused")),
        "Unused 类应被识别为死代码候选"
      );
    });
  });

  describe("Markdown 输出", () => {
    it("应生成包含概览的 Markdown", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codemap-md-"));
      await fs.writeFile(path.join(dir, "a.ts"), "export const x = 1;");
      const gen = new CodeMapGenerator({ projectRoot: dir });
      const map = await gen.generate();
      const md = gen.toMarkdown(map);
      assert.match(md, /^# Code Map: /m);
      assert.match(md, /## 语言分布/);
      assert.match(md, /## 节点分布/);
    });
  });

  describe("dump", () => {
    it("应生成 Markdown 与 JSON 文件", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codemap-dump-"));
      await fs.writeFile(path.join(dir, "a.ts"), "export const x = 1;");
      const mdPath = path.join(dir, "out.md");
      const jsonPath = path.join(dir, "out.json");
      const gen = new CodeMapGenerator({
        projectRoot: dir,
        markdownOutputPath: mdPath,
        jsonOutputPath: jsonPath,
      });
      const map = await gen.generate();
      await gen.dump(map);
      const md = await fs.readFile(mdPath, "utf-8");
      const json = JSON.parse(await fs.readFile(jsonPath, "utf-8"));
      assert.ok(md.length > 0);
      assert.equal(json.projectName, path.basename(dir));
    });
  });

  describe("错误处理", () => {
    it("单文件分析失败不影响其他文件", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codemap-err-"));
      await fs.writeFile(path.join(dir, "a.ts"), "export const a = 1;");
      await fs.writeFile(path.join(dir, "b.ts"), "this is not valid {{{ ts code but still readable");
      const gen = new CodeMapGenerator({ projectRoot: dir });
      const map = await gen.generate();
      // 两个文件都应被处理（即使解析失败）
      assert.ok(map.stats.fileCount >= 1);
    });

    it("maxFiles 限制应生效", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codemap-max-"));
      for (let i = 0; i < 10; i++) {
        await fs.writeFile(path.join(dir, `f${i}.ts`), `export const x${i} = ${i};`);
      }
      const gen = new CodeMapGenerator({ projectRoot: dir, maxFiles: 3 });
      const map = await gen.generate();
      assert.ok(map.stats.fileCount <= 3);
    });
  });

  describe("语言识别", () => {
    it("应将 .ts 识别为 typescript", () => {
      // 静态方法通过 prototype 访问
      const lang = (CodeMapGenerator as unknown as { langOfExt(ext: string): string }).langOfExt(".ts");
      assert.equal(lang, "typescript");
    });
    it("应将 .py 识别为 python", () => {
      const lang = (CodeMapGenerator as unknown as { langOfExt(ext: string): string }).langOfExt(".py");
      assert.equal(lang, "python");
    });
    it("应将 .rs 识别为 rust", () => {
      const lang = (CodeMapGenerator as unknown as { langOfExt(ext: string): string }).langOfExt(".rs");
      assert.equal(lang, "rust");
    });
  });
});
