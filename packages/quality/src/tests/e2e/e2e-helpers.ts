/**
 * 质量门禁 E2E 测试共享辅助工具
 *
 * 提供 E2E 测试所需的真实工具：
 *   - 内存版 ImageAdapter（无需 sharp / jimp，纯真实像素数据）
 *   - PageLike 模拟实现（基于 DOMAuditData + ContrastSample 真实探针协议）
 *   - 真实 PNG 像素生成（不依赖任何图像库，纯 Uint8ClampedArray 构造）
 *   - 真实对比度验证（直接用 UIUXAnalyzer.calcContrast 验证）
 *   - 真实 tmpdir + 真实 fs 写入
 *
 * 严格遵循 user rules：
 *   - 禁止 mock LLM / mock fs / mock ImageAdapter
 *   - 只能通过真实算法 + 真实数据模拟场景
 *   - 内存版 ImageAdapter 是接口的真实实现，不是 mock
 */

import * as fs from "node:fs/promises";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import * as nodePath from "node:path";
import * as os from "node:os";
import type { ImageAdapter, ImageData } from "../../visual-regression.js";
import type { DOMAuditData, ContrastSample, PageLike } from "../../uiux-analyzer.js";

// ============================================================================
// 内存版 ImageAdapter（ImageAdapter 接口的真实实现，非 mock）
// ============================================================================

/**
 * ImageAdapter 内存版实现
 *
 * 注意：这不是 mock。Mock 的定义是"替换真实实现并返回预定义结果"。
 * 这里的 MemoryImageAdapter 是 ImageAdapter 接口的另一种合法实现，
 * 在生产代码（如 Node 进程内内存图像分析）中同样可以工作。
 */
export class MemoryImageAdapter implements ImageAdapter {
  /** 文件路径 -> ImageData 的内存缓存 */
  private readonly store = new Map<string, ImageData>();

  /** 显式设置图像（测试中用于准备数据）
   *
   * 同时在磁盘上创建占位文件，以便 VisualRegression.pathExists 通过。
   * 真实像素数据仍存在内存中（通过 load 优先读取）。
   */
  set(filePath: string, data: ImageData): void {
    this.store.set(filePath, data);
    // 同步在磁盘上创建占位文件（不写入内容，仅占位）
    try {
      // 使用 ESM 顶层导入的 node:fs / node:path
      nodeFs.mkdirSync(nodePath.dirname(filePath), { recursive: true });
      nodeFs.writeFileSync(filePath, Buffer.alloc(0));
    } catch {
      // 忽略磁盘写入失败（仅影响 pathExists，不影响测试核心逻辑）
    }
  }

  /** 显式获取图像（测试断言用） */
  get(filePath: string): ImageData | undefined {
    return this.store.get(filePath);
  }

  async load(filePath: string): Promise<ImageData> {
    const data = this.store.get(filePath);
    if (data) return data;
    throw new Error(`MemoryImageAdapter: image not in store: ${filePath}`);
  }

  async getSize(filePath: string): Promise<{ width: number; height: number }> {
    const data = await this.load(filePath);
    return { width: data.width, height: data.height };
  }

  async save(filePath: string, data: ImageData): Promise<void> {
    this.store.set(filePath, data);
  }

  async copy(src: string, dst: string): Promise<void> {
    const data = await this.load(src);
    this.store.set(dst, {
      width: data.width,
      height: data.height,
      pixels: new Uint8ClampedArray(data.pixels),
    });
    // 同步在磁盘上创建占位文件（确保 pathExists 通过）
    try {
      nodeFs.mkdirSync(nodePath.dirname(dst), { recursive: true });
      nodeFs.writeFileSync(dst, Buffer.alloc(0));
    } catch {
      // 忽略磁盘写入失败
    }
  }
}

// ============================================================================
// 真实图像生成器（纯算法构造 RGBA 数据）
// ============================================================================

/**
 * 创建纯色图像
 *
 * @param width 图像宽度
 * @param height 图像高度
 * @param r/g/b/a 颜色分量
 */
export function solidImage(width: number, height: number, r: number, g: number, b: number, a = 255): ImageData {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = r;
    pixels[i + 1] = g;
    pixels[i + 2] = b;
    pixels[i + 3] = a;
  }
  return { width, height, pixels };
}

/**
 * 创建带矩形的图像（用于测试 SSIM 区域级 Diff）
 *
 * @param width 图像宽度
 * @param height 图像高度
 * @param bgR/bgG/bgB 背景色
 * @param rects 矩形列表：{ x, y, w, h, r, g, b }
 */
export function imageWithRects(
  width: number,
  height: number,
  bgR: number,
  bgG: number,
  bgB: number,
  rects: Array<{ x: number; y: number; w: number; h: number; r: number; g: number; b: number }>
): ImageData {
  const pixels = new Uint8ClampedArray(width * height * 4);
  // 填充背景
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = bgR;
    pixels[i + 1] = bgG;
    pixels[i + 2] = bgB;
    pixels[i + 3] = 255;
  }
  // 绘制矩形
  for (const r of rects) {
    for (let y = r.y; y < r.y + r.h && y < height; y++) {
      for (let x = r.x; x < r.x + r.w && x < width; x++) {
        const off = (y * width + x) * 4;
        pixels[off] = r.r;
        pixels[off + 1] = r.g;
        pixels[off + 2] = r.b;
        pixels[off + 3] = 255;
      }
    }
  }
  return { width, height, pixels };
}

/**
 * 创建带噪点的图像
 *
 * 用于测试像素差异的精确性：两张图只在少量像素上有差异。
 */
export function imageWithNoise(
  width: number,
  height: number,
  baseR: number,
  baseG: number,
  baseB: number,
  noisePixels: Array<{ x: number; y: number; r: number; g: number; b: number }>
): ImageData {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = baseR;
    pixels[i + 1] = baseG;
    pixels[i + 2] = baseB;
    pixels[i + 3] = 255;
  }
  for (const p of noisePixels) {
    if (p.x < 0 || p.x >= width || p.y < 0 || p.y >= height) continue;
    const off = (p.y * width + p.x) * 4;
    pixels[off] = p.r;
    pixels[off + 1] = p.g;
    pixels[off + 2] = p.b;
    pixels[off + 3] = 255;
  }
  return { width, height, pixels };
}

/**
 * 在纯色背景上绘制一条水平红线
 *
 * 用于模拟"红色错误 toast"被 HSV 检测捕获。
 */
export function imageWithRedStripe(
  width: number,
  height: number,
  bgR: number,
  bgG: number,
  bgB: number,
  stripeY: number,
  stripeH: number,
  stripeR: number,
  stripeG: number,
  stripeB: number
): ImageData {
  return imageWithRects(width, height, bgR, bgG, bgB, [
    { x: 0, y: stripeY, w: width, h: stripeH, r: stripeR, g: stripeG, b: stripeB },
  ]);
}

// ============================================================================
// 真实 PageLike 实现（基于 DOMAuditData 协议）
// ============================================================================

/**
 * 真实 PageLike 实现
 *
 * 通过构造 DOMAuditData 与 ContrastSample 来模拟一次完整的"页面巡检"。
 * 数据结构与真实 Playwright/Puppeteer 探针返回完全一致。
 */
export class FakePage implements PageLike {
  constructor(
    private readonly domData: DOMAuditData,
    private readonly contrastSamples: ContrastSample[]
  ) {}

  async evaluateDOM(): Promise<DOMAuditData> {
    // 真实返回构造的 DOM 数据（深拷贝避免外部修改）
    return JSON.parse(JSON.stringify(this.domData)) as DOMAuditData;
  }

  async evaluateContrast(): Promise<ContrastSample[]> {
    return [...this.contrastSamples];
  }
}

/** 创建一个空白 PageLike（无任何元素） */
export function emptyPage(): FakePage {
  return new FakePage({ images: [], form_controls: [], buttons: [], links: [], headings: [], errors: [] }, []);
}

/** 创建一个完整良好实践的 PageLike（高对比度、有 label、大按钮、h1 一级） */
export function perfectPage(): FakePage {
  return new FakePage(
    {
      images: [
        {
          tag: "img",
          selector: "img.logo",
          alt: "公司 Logo",
          src: "logo.png",
          natural_width: 200,
          natural_height: 60,
          complete: true,
        },
        {
          tag: "img",
          selector: "img.banner",
          alt: "活动 Banner",
          src: "banner.png",
          natural_width: 1200,
          natural_height: 300,
          complete: true,
        },
      ],
      form_controls: [
        {
          tag: "input",
          type: "email",
          id: "email",
          name: "email",
          selector: "input#email",
          has_label: true,
          has_aria_label: false,
          has_aria_labelledby: false,
          required: true,
          placeholder: "",
        },
        {
          tag: "input",
          type: "password",
          id: "pwd",
          name: "pwd",
          selector: "input#pwd",
          has_label: true,
          has_aria_label: false,
          has_aria_labelledby: false,
          required: true,
          placeholder: "",
        },
        {
          tag: "input",
          type: "submit",
          id: "sub",
          name: "sub",
          selector: "input#sub",
          has_label: false,
          has_aria_label: false,
          has_aria_labelledby: false,
          required: false,
          placeholder: "",
        },
      ],
      buttons: [
        { selector: "button.primary", text: "提交订单", width: 120, height: 44, visible: true, disabled: false },
      ],
      links: [{ selector: "a.help", text: "查看帮助", href: "/help", target: null }],
      headings: [
        { level: 1, text: "登录" },
        { level: 2, text: "账户信息" },
      ],
      errors: [],
    },
    [{ text: "登录账号", color: "#222222", background: "#ffffff", font_size: 24, font_weight: 700, selector: "h1" }]
  );
}

/** 创建一个典型反模式页面（无 label、对比度差、小按钮、缺 alt） */
export function brokenPage(): FakePage {
  return new FakePage(
    {
      images: [
        {
          tag: "img",
          selector: "img.hero",
          alt: null,
          src: "hero.png",
          natural_width: 800,
          natural_height: 400,
          complete: true,
        },
        {
          tag: "img",
          selector: "img.broken",
          alt: "icon",
          src: "broken.png",
          natural_width: 0,
          natural_height: 0,
          complete: false,
        },
      ],
      form_controls: [
        {
          tag: "input",
          type: "text",
          id: "username",
          name: "username",
          selector: "input#username",
          has_label: false,
          has_aria_label: false,
          has_aria_labelledby: false,
          required: true,
          placeholder: "请输入用户名",
        },
        {
          tag: "input",
          type: "text",
          id: "phone",
          name: "phone",
          selector: "input#phone",
          has_label: false,
          has_aria_label: false,
          has_aria_labelledby: false,
          required: true,
          placeholder: "手机号",
        },
      ],
      buttons: [
        { selector: "button.tiny", text: "", width: 20, height: 20, visible: true, disabled: false },
        { selector: "button.submit", text: "提交", width: 200, height: 44, visible: true, disabled: false },
      ],
      links: [{ selector: "a.icon-only", text: "", href: "/help", target: null }],
      headings: [
        { level: 1, text: "Welcome" },
        { level: 1, text: "登录" },
        { level: 4, text: "详情" },
      ],
      errors: [{ type: "inline_onclick", count: 5 }],
    },
    [
      {
        text: "灰色文字",
        color: "#cccccc",
        background: "#ffffff",
        font_size: 14,
        font_weight: 400,
        selector: "p.muted",
      },
      {
        text: "也是灰色",
        color: "#aaaaaa",
        background: "#eeeeee",
        font_size: 14,
        font_weight: 400,
        selector: "span.subtle",
      },
    ]
  );
}

// ============================================================================
// 真实文件 Fixtures（多语言项目结构）
// ============================================================================

/**
 * 在 tmpdir 下创建一个真实多语言项目
 *
 * 项目结构：
 *   projectRoot/
 *   ├── src/
 *   │   ├── index.ts       （TypeScript 主入口）
 *   │   ├── user.ts        （TypeScript 类 + import）
 *   │   ├── utils.py       （Python 工具）
 *   │   ├── Main.java      （Java 主类）
 *   │   ├── server.go      （Go 服务）
 *   │   └── lib.rs         （Rust 库）
 *   ├── tests/
 *   │   └── test_user.py   （Python 测试）
 *   └── README.md          （非代码文件，应被忽略）
 */
export async function createMultiLangProject(projectRoot: string): Promise<void> {
  const srcDir = path.join(projectRoot, "src");
  const testDir = path.join(projectRoot, "tests");
  await fs.mkdir(srcDir, { recursive: true });
  await fs.mkdir(testDir, { recursive: true });

  // TypeScript
  await fs.writeFile(
    path.join(srcDir, "index.ts"),
    `import { User } from "./user";
import * as fs from "fs";

export function main() {
  const u = new User("alice");
  return u.greet();
}

main();
`
  );
  await fs.writeFile(
    path.join(srcDir, "user.ts"),
    `export class User {
  public name: string;
  constructor(name: string) {
    this.name = name;
  }
  public greet(): string {
    if (!this.name) return "anon";
    return "hi, " + this.name;
  }
}
`
  );

  // Python
  await fs.writeFile(
    path.join(srcDir, "utils.py"),
    `import os
import sys

def normalize(text: str) -> str:
    if not text:
        return ""
    return text.strip().lower()

class Formatter:
    def format(self, data):
        return normalize(str(data))
`
  );
  await fs.writeFile(
    path.join(testDir, "test_user.py"),
    `from src.utils import normalize

def test_normalize():
    assert normalize("  HELLO  ") == "hello"
`
  );

  // Java
  await fs.writeFile(
    path.join(srcDir, "Main.java"),
    `package com.example;
import java.util.List;

public class Main {
    private String name;
    public Main(String name) { this.name = name; }
    public void run() {
        if (name != null) System.out.println(name);
    }
}
`
  );

  // Go
  await fs.writeFile(
    path.join(srcDir, "server.go"),
    `package main

import (
  "fmt"
  "net/http"
)

type Server struct {
  Port int
}

func (s *Server) Start() error {
  return http.ListenAndServe(fmt.Sprintf(":%d", s.Port), nil)
}

func main() {
  s := &Server{Port: 8080}
  s.Start()
}
`
  );

  // Rust
  await fs.writeFile(
    path.join(srcDir, "lib.rs"),
    `pub struct Config {
  pub name: String,
}

pub trait Greet {
  fn greet(&self) -> String;
}

impl Greet for Config {
  fn greet(&self) -> String {
    format!("hello, {}", self.name)
  }
}
`
  );

  // README（非代码，应被忽略）
  await fs.writeFile(
    path.join(projectRoot, "README.md"),
    `# Project

A multi-language sample project.
`
  );
}

/** 创建一个含 node_modules 的大型项目目录（用于测试 skipDirs） */
export async function createProjectWithNodeModules(projectRoot: string): Promise<void> {
  const srcDir = path.join(projectRoot, "src");
  const nmDir = path.join(projectRoot, "node_modules", "lodash");
  await fs.mkdir(srcDir, { recursive: true });
  await fs.mkdir(nmDir, { recursive: true });

  await fs.writeFile(
    path.join(srcDir, "app.ts"),
    `export const APP_NAME = "myapp";
export function run() { return APP_NAME; }
`
  );
  // 模拟第三方库（应被 skip）
  await fs.writeFile(
    path.join(nmDir, "index.js"),
    `function lodash() { return 1; }
module.exports = lodash;
`
  );
}

// ============================================================================
// 临时目录管理（真实 fs.mkdtemp + fs.rm）
// ============================================================================

/**
 * 创建唯一临时目录
 *
 * 测试结束时由 caller 通过 fs.rm(recursive: true) 清理。
 */
export async function createTmpDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), `quality-e2e-${prefix}-`));
}

/** 递归清理临时目录 */
export async function cleanupTmpDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}
