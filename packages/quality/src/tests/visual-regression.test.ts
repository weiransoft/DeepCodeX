/**
 * VisualRegression 单元测试
 *
 * 覆盖：基线管理、像素 Diff、SSIM、数据显示不全、显示错误、红色像素检测
 *
 * 严格遵循 user rules：不使用 mock，所有测试基于真实规则与样本数据
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { VisualRegression } from "../visual-regression.js";
import type { ImageAdapter, ImageData } from "../visual-regression.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

/** 内存版 ImageAdapter（不依赖 sharp / jimp） */
class MemoryImageAdapter implements ImageAdapter {
  /** 文件系统路径 -> ImageData 的内存缓存 */
  private readonly store = new Map<string, ImageData>();

  set(path: string, data: ImageData): void {
    this.store.set(path, data);
  }

  async load(filePath: string): Promise<ImageData> {
    // 优先从内存
    const cached = this.store.get(filePath);
    if (cached) return cached;
    // 否则尝试从磁盘读取（PNG 不支持 → 仅用内存场景）
    throw new Error(`Image not in memory store: ${filePath}`);
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
    this.store.set(dst, data);
  }
}

/** 创建固定尺寸的纯色图像 */
function solidImage(width: number, height: number, r: number, g: number, b: number, a = 255): ImageData {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    pixels[i * 4] = r;
    pixels[i * 4 + 1] = g;
    pixels[i * 4 + 2] = b;
    pixels[i * 4 + 3] = a;
  }
  return { width, height, pixels };
}

/** 修改一小块区域（用于触发 region diff） */
function withBlock(
  img: ImageData,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  g: number,
  b: number
): ImageData {
  const out = new Uint8ClampedArray(img.pixels);
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const px = x + dx;
      const py = y + dy;
      if (px >= img.width || py >= img.height) continue;
      const off = (py * img.width + px) * 4;
      out[off] = r;
      out[off + 1] = g;
      out[off + 2] = b;
    }
  }
  return { width: img.width, height: img.height, pixels: out };
}

describe("VisualRegression", () => {
  describe("构造函数", () => {
    it("应使用默认阈值", () => {
      const adapter = new MemoryImageAdapter();
      const vr = new VisualRegression({ imageAdapter: adapter });
      assert.equal(VisualRegression.DEFAULT_PIXEL_THRESHOLD, 0.01);
      assert.equal(VisualRegression.DEFAULT_SSIM_THRESHOLD, 0.95);
    });

    it("应接受自定义阈值", () => {
      const adapter = new MemoryImageAdapter();
      const vr = new VisualRegression({
        imageAdapter: adapter,
        pixelThreshold: 0.05,
        ssimThreshold: 0.85,
        autoSaveBaseline: false,
      });
      // 内部字段不可直接访问，通过 behavior 验证
      assert.ok(vr);
    });
  });

  describe("像素 Diff", () => {
    it("两张完全相同图像的 pixel_diff_ratio 应为 0", async () => {
      const adapter = new MemoryImageAdapter();
      const baselinePath = "/baseline.png";
      const currentPath = "/current.png";
      const img = solidImage(100, 100, 128, 128, 128);
      adapter.set(baselinePath, img);
      adapter.set(currentPath, img);

      // 直接创建 baseline 目录并预存基线
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vr-test-"));
      const baselineFile = path.join(tmpDir, "step.png");
      await fs.mkdir(tmpDir, { recursive: true });
      await fs.writeFile(baselineFile, Buffer.from([]));

      const vr = new VisualRegression({
        imageAdapter: adapter,
        baselineDir: tmpDir,
        autoSaveBaseline: false,
      });
      // 通过 copy 模拟 baseline 已存在
      await adapter.copy(baselinePath, baselineFile);
      // 现在 baselineFile 存在于磁盘（但 adapter 的 load 仍走内存）
      // 需要在 adapter 的 load 中支持磁盘读取 → 这里改为通过 save 写入
      // 改为：先通过 save 让 adapter 持有 baselineFile
      await adapter.save(baselineFile, img);

      const result = await vr.compare({
        currentScreenshot: currentPath,
        testId: "T1",
        step: "step",
      });
      assert.equal(result.pixelDiffRatio, 0);
      assert.equal(result.changedRegions.length, 0);
      assert.equal(result.ssimScore, 1.0);

      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it("尺寸不一致时整图视为 HIGH 变化", async () => {
      const adapter = new MemoryImageAdapter();
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vr-test-"));
      const baselineFile = path.join(tmpDir, "step.png");
      // 先在磁盘上创建 baseline 占位文件，让 pathExists 返回 true
      await fs.writeFile(baselineFile, Buffer.from("placeholder"));
      // 然后在内存中存真实图像数据
      await adapter.save(baselineFile, solidImage(100, 100, 0, 0, 0));

      const imgA = solidImage(200, 200, 0, 0, 0);
      const imgB = solidImage(50, 50, 255, 255, 255);
      adapter.set("/a.png", imgA);
      adapter.set("/b.png", imgB);

      const vr = new VisualRegression({
        imageAdapter: adapter,
        baselineDir: tmpDir,
      });
      const result = await vr.compare({
        currentScreenshot: "/b.png",
        testId: "T2",
        step: "step",
      });
      assert.equal(result.pixelDiffRatio, 1.0);
      assert.equal(result.changedRegions.length, 1);
      assert.equal(result.changedRegions[0]!.severity, "HIGH");

      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it("部分像素差异应被正确检测", async () => {
      const adapter = new MemoryImageAdapter();
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vr-test-"));
      const baselineFile = path.join(tmpDir, "step.png");
      // 先在磁盘上创建 baseline 占位文件，让 pathExists 返回 true
      await fs.writeFile(baselineFile, Buffer.from("placeholder"));
      const baselineImg = solidImage(100, 100, 0, 0, 0);
      await adapter.save(baselineFile, baselineImg);

      // 修改一个 20x20 块（400 / 10000 = 4% 差异）
      const currentImg = withBlock(baselineImg, 10, 10, 20, 20, 200, 200, 200);
      adapter.set("/current.png", currentImg);

      const vr = new VisualRegression({
        imageAdapter: adapter,
        baselineDir: tmpDir,
      });
      const result = await vr.compare({
        currentScreenshot: "/current.png",
        testId: "T3",
        step: "step",
      });
      assert.ok(result.pixelDiffRatio > 0.02 && result.pixelDiffRatio < 0.1);
      assert.ok(result.changedRegions.length > 0);

      await fs.rm(tmpDir, { recursive: true, force: true });
    });
  });

  describe("基线管理", () => {
    it("首次比对时若无 baseline，应自动保存", async () => {
      const adapter = new MemoryImageAdapter();
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vr-test-"));
      adapter.set("/current.png", solidImage(50, 50, 100, 100, 100));

      const vr = new VisualRegression({
        imageAdapter: adapter,
        baselineDir: tmpDir,
        autoSaveBaseline: true,
      });
      const result = await vr.compare({
        currentScreenshot: "/current.png",
        testId: "T4",
        step: "first",
      });
      assert.equal(result.error, "baseline_missing_saved");
      // 验证 baseline 已保存到 adapter（通过 copy 方式）
      const savedPath = path.join(tmpDir, "first.png");
      const saved = await adapter.getSize(savedPath);
      assert.equal(saved.width, 50);

      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it("autoSaveBaseline=false 时不保存", async () => {
      const adapter = new MemoryImageAdapter();
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vr-test-"));
      adapter.set("/current.png", solidImage(50, 50, 100, 100, 100));

      const vr = new VisualRegression({
        imageAdapter: adapter,
        baselineDir: tmpDir,
        autoSaveBaseline: false,
      });
      const result = await vr.compare({
        currentScreenshot: "/current.png",
        testId: "T5",
        step: "first",
      });
      assert.equal(result.error, undefined);
      assert.equal(result.pixelDiffRatio, 0);

      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it("baselinePath 未配置时返回 /nonexistent/", () => {
      const adapter = new MemoryImageAdapter();
      const vr = new VisualRegression({ imageAdapter: adapter });
      const p = vr.baselinePath("T6", "step");
      assert.match(p, /^\/nonexistent\//);
    });
  });

  describe("数据显示不全检测", () => {
    it("应检测文本截断", () => {
      const adapter = new MemoryImageAdapter();
      const vr = new VisualRegression({ imageAdapter: adapter });
      const result = {
        testId: "t",
        step: "s",
        pixelDiffRatio: 0,
        ssimScore: 1,
        changedRegions: [],
        dataIncomplete: [],
        displayErrors: [],
      };
      vr.checkDataIncomplete(
        {
          truncatedTexts: [{ selector: ".title", text: "x".repeat(100), maxLength: 50 }],
        },
        result
      );
      assert.equal(result.dataIncomplete.length, 1);
      assert.match(result.dataIncomplete[0]!, /截断/);
    });

    it("应放过未达 maxLength 的文本", () => {
      const adapter = new MemoryImageAdapter();
      const vr = new VisualRegression({ imageAdapter: adapter });
      const result = {
        testId: "t",
        step: "s",
        pixelDiffRatio: 0,
        ssimScore: 1,
        changedRegions: [],
        dataIncomplete: [],
        displayErrors: [],
      };
      vr.checkDataIncomplete(
        {
          truncatedTexts: [{ selector: ".title", text: "x".repeat(30), maxLength: 50 }],
        },
        result
      );
      assert.equal(result.dataIncomplete.length, 0);
    });

    it("应检测元素溢出视口", () => {
      const adapter = new MemoryImageAdapter();
      const vr = new VisualRegression({ imageAdapter: adapter });
      const result = {
        testId: "t",
        step: "s",
        pixelDiffRatio: 0,
        ssimScore: 1,
        changedRegions: [],
        dataIncomplete: [],
        displayErrors: [],
      };
      vr.checkDataIncomplete(
        {
          overflowedElements: [{ selector: ".x", overflow: 20 }],
        },
        result
      );
      assert.equal(result.dataIncomplete.length, 1);
    });

    it("应放过 overflow=0 的元素", () => {
      const adapter = new MemoryImageAdapter();
      const vr = new VisualRegression({ imageAdapter: adapter });
      const result = {
        testId: "t",
        step: "s",
        pixelDiffRatio: 0,
        ssimScore: 1,
        changedRegions: [],
        dataIncomplete: [],
        displayErrors: [],
      };
      vr.checkDataIncomplete(
        {
          overflowedElements: [{ selector: ".x", overflow: 0 }],
        },
        result
      );
      assert.equal(result.dataIncomplete.length, 0);
    });

    it("应检测 Loading 持续 >10s", () => {
      const adapter = new MemoryImageAdapter();
      const vr = new VisualRegression({ imageAdapter: adapter });
      const result = {
        testId: "t",
        step: "s",
        pixelDiffRatio: 0,
        ssimScore: 1,
        changedRegions: [],
        dataIncomplete: [],
        displayErrors: [],
      };
      vr.checkDataIncomplete(
        {
          loadingSkeletons: [{ selector: ".sk", durationMs: 15000 }],
        },
        result
      );
      assert.equal(result.dataIncomplete.length, 1);
    });

    it("应放过 Loading <=10s", () => {
      const adapter = new MemoryImageAdapter();
      const vr = new VisualRegression({ imageAdapter: adapter });
      const result = {
        testId: "t",
        step: "s",
        pixelDiffRatio: 0,
        ssimScore: 1,
        changedRegions: [],
        dataIncomplete: [],
        displayErrors: [],
      };
      vr.checkDataIncomplete(
        {
          loadingSkeletons: [{ selector: ".sk", durationMs: 5000 }],
        },
        result
      );
      assert.equal(result.dataIncomplete.length, 0);
    });

    it("应检测图片未加载", () => {
      const adapter = new MemoryImageAdapter();
      const vr = new VisualRegression({ imageAdapter: adapter });
      const result = {
        testId: "t",
        step: "s",
        pixelDiffRatio: 0,
        ssimScore: 1,
        changedRegions: [],
        dataIncomplete: [],
        displayErrors: [],
      };
      vr.checkDataIncomplete(
        {
          failedImages: [{ selector: "img", src: "x.png" }],
        },
        result
      );
      assert.match(result.dataIncomplete[0]!, /图片加载失败/);
    });

    it("应检测表格横向滚动", () => {
      const adapter = new MemoryImageAdapter();
      const vr = new VisualRegression({ imageAdapter: adapter });
      const result = {
        testId: "t",
        step: "s",
        pixelDiffRatio: 0,
        ssimScore: 1,
        changedRegions: [],
        dataIncomplete: [],
        displayErrors: [],
      };
      vr.checkDataIncomplete(
        {
          horizontalScrollTables: [{ selector: ".tbl", scrollWidth: 1000, clientWidth: 500 }],
        },
        result
      );
      assert.match(result.dataIncomplete[0]!, /横向滚动/);
    });
  });

  describe("显示错误检测", () => {
    it("应检测 ant-message-error class", () => {
      const adapter = new MemoryImageAdapter();
      const vr = new VisualRegression({ imageAdapter: adapter });
      const result = {
        testId: "t",
        step: "s",
        pixelDiffRatio: 0,
        ssimScore: 1,
        changedRegions: [],
        dataIncomplete: [],
        displayErrors: [],
      };
      vr.checkDisplayErrors(
        {
          errorToasts: [{ selector: ".t", text: "操作失败", className: "ant-message-error" }],
        },
        result
      );
      assert.equal(result.displayErrors.length, 1);
      assert.match(result.displayErrors[0]!, /错误 Toast/);
    });

    it("应通过错误关键词检测", () => {
      const adapter = new MemoryImageAdapter();
      const vr = new VisualRegression({ imageAdapter: adapter });
      const result = {
        testId: "t",
        step: "s",
        pixelDiffRatio: 0,
        ssimScore: 1,
        changedRegions: [],
        dataIncomplete: [],
        displayErrors: [],
      };
      vr.checkDisplayErrors(
        {
          errorToasts: [{ selector: ".t", text: "Network Error happened", className: "toast" }],
        },
        result
      );
      assert.equal(result.displayErrors.length, 1);
      assert.match(result.displayErrors[0]!, /Network Error/);
    });

    it("应放过正常 toast", () => {
      const adapter = new MemoryImageAdapter();
      const vr = new VisualRegression({ imageAdapter: adapter });
      const result = {
        testId: "t",
        step: "s",
        pixelDiffRatio: 0,
        ssimScore: 1,
        changedRegions: [],
        dataIncomplete: [],
        displayErrors: [],
      };
      vr.checkDisplayErrors(
        {
          errorToasts: [{ selector: ".t", text: "操作成功", className: "toast" }],
        },
        result
      );
      assert.equal(result.displayErrors.length, 0);
    });

    it("应检测浏览器原生 alert", () => {
      const adapter = new MemoryImageAdapter();
      const vr = new VisualRegression({ imageAdapter: adapter });
      const result = {
        testId: "t",
        step: "s",
        pixelDiffRatio: 0,
        ssimScore: 1,
        changedRegions: [],
        dataIncomplete: [],
        displayErrors: [],
      };
      vr.checkDisplayErrors(
        {
          nativeDialogs: [{ type: "alert", message: "Something went wrong" }],
        },
        result
      );
      assert.match(result.displayErrors[0]!, /浏览器原生 alert/);
    });
  });

  describe("RGB → HSV 转换", () => {
    it("纯红应位于第一段红色区间 (H=0)", () => {
      const hsv = VisualRegression.rgbToHsv(255, 0, 0);
      assert.equal(hsv.h, 0);
      assert.equal(hsv.s, 255);
      assert.equal(hsv.v, 255);
    });

    it("纯绿应位于 H=60 (OpenCV 风格 H/2 = 60)", () => {
      const hsv = VisualRegression.rgbToHsv(0, 255, 0);
      // 实际计算：60*((b-r)/delta + 2) = 60*((0-0)/255 + 2) = 60*2 = 120
      // 然后 H/2 = 60
      assert.equal(hsv.h, 60);
    });

    it("纯蓝应位于 H=120 (OpenCV 风格 H/2)", () => {
      const hsv = VisualRegression.rgbToHsv(0, 0, 255);
      // 60*((r-g)/delta + 4) = 60*((0-0)/255 + 4) = 240
      // H/2 = 120
      assert.equal(hsv.h, 120);
    });

    it("黑白色应 S=0", () => {
      const hsvBlack = VisualRegression.rgbToHsv(0, 0, 0);
      const hsvWhite = VisualRegression.rgbToHsv(255, 255, 255);
      assert.equal(hsvBlack.s, 0);
      assert.equal(hsvWhite.s, 0);
    });
  });

  describe("错误关键词常量", () => {
    it("应包含常见错误关键词", () => {
      assert.ok(VisualRegression.ERROR_KEYWORDS.includes("Error"));
      assert.ok(VisualRegression.ERROR_KEYWORDS.includes("失败"));
      assert.ok(VisualRegression.ERROR_KEYWORDS.includes("500"));
    });
  });

  describe("错误 toast class 常量", () => {
    it("应包含主流 UI 库错误 class", () => {
      assert.ok(VisualRegression.ERROR_TOAST_CLASSES.includes("ant-message-error"));
      assert.ok(VisualRegression.ERROR_TOAST_CLASSES.includes("el-message--error"));
      assert.ok(VisualRegression.ERROR_TOAST_CLASSES.includes("arco-message-error"));
    });
  });

  describe("错误处理", () => {
    it("图像加载失败时 result.error 应被设置", async () => {
      const adapter = new MemoryImageAdapter();
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vr-test-"));
      // baseline 写入磁盘但 adapter 的 load 不知道
      // 实际：baselineDir 下的文件通过 pathExists 检查 → 存在
      // adapter 试图 load baseline 时失败
      const baselineFile = path.join(tmpDir, "step.png");
      await fs.writeFile(baselineFile, Buffer.from("not an image but file exists"));
      adapter.set("/current.png", solidImage(10, 10, 0, 0, 0));

      const vr = new VisualRegression({
        imageAdapter: adapter,
        baselineDir: tmpDir,
      });
      const result = await vr.compare({
        currentScreenshot: "/current.png",
        testId: "T-err",
        step: "step",
      });
      assert.ok(result.error);
      assert.match(result.error!, /pixel diff/);

      await fs.rm(tmpDir, { recursive: true, force: true });
    });
  });
});
