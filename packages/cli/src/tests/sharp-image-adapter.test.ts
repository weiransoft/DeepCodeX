/**
 * sharp-image-adapter 单元测试
 *
 * 测试范围：
 *   - A. SharpImageAdapter.create(): sharp 已安装时成功创建实例
 *   - B. SharpImageAdapter.save() + load(): ImageData 往返一致性
 *   - C. SharpImageAdapter.getSize(): 返回正确尺寸
 *   - D. SharpImageAdapter.copy(): 文件复制
 *   - E. 错误场景：文件不存在 / 无效路径
 *   - F. SharpImageAdapterError: 错误对象属性
 *
 * 测试约定（遵循项目规则）：
 *   - 使用 node:test + node:assert/strict
 *   - 禁止使用 mock 框架：使用真实的 sharp 库与真实文件 I/O
 *   - 每个测试用例独立隔离：独立临时目录 + after 统一清理
 *   - 真实生成 PNG 文件（通过 SharpImageAdapter.save() 自身，形成自洽的测试闭环）
 *   - 跳过条件：仅当 sharp 未安装时跳过相关测试（不是 mock，是真实环境检测）
 *
 * 注意：SHARP_NOT_INSTALLED 错误路径无法在 sharp 已安装的环境中测试，
 * 因为 SharpImageAdapter.create() 会成功。该路径由 quality-cmd.test.ts
 * 中的 createImageAdapter 注入测试覆盖（注入返回 null 的工厂函数）。
 *
 * @module cli/tests/sharp-image-adapter
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SharpImageAdapter, SharpImageAdapterError } from "../quality/sharp-image-adapter";
import type { ImageData } from "@deepcodex/quality";

// ============================================================================
// 测试基础设施：临时目录管理 + sharp 可用性检测
// ============================================================================

/** 临时目录集合（after 统一清理） */
const tempDirs: string[] = [];

/**
 * 创建唯一临时目录
 *
 * @param prefix 目录前缀（便于排查）
 * @returns 临时目录绝对路径
 */
async function createTmpDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `quality-sharp-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

// 测试结束后清理所有临时目录
after(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/**
 * sharp 是否可用（环境检测，非 mock）
 *
 * 使用顶层 await 执行 dynamic import("sharp") 检测，
 * 用于在 sharp 未安装时跳过依赖 sharp 的测试用例。
 * 顶层 await 确保检测在所有 test() 注册前完成。
 */
let sharpAvailable = false;
try {
  await import("sharp");
  sharpAvailable = true;
} catch {
  sharpAvailable = false;
}

// ============================================================================
// 测试 Fixtures：真实 ImageData 生成
// ============================================================================

/**
 * 创建一个纯色 ImageData（4 通道 RGBA）
 *
 * @param width 宽度
 * @param height 高度
 * @param r/g/b/a 颜色分量
 * @returns ImageData 对象
 */
function solidImageData(width: number, height: number, r: number, g: number, b: number, a: number = 255): ImageData {
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
 * 创建一个带矩形的 ImageData
 *
 * @param width 画布宽度
 * @param height 画布高度
 * @param bgR/bgG/bgB 背景色
 * @param rects 矩形列表
 * @returns ImageData 对象
 */
function imageDataWithRects(
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
  for (const rect of rects) {
    for (let y = rect.y; y < rect.y + rect.h && y < height; y++) {
      for (let x = rect.x; x < rect.x + rect.w && x < width; x++) {
        const off = (y * width + x) * 4;
        pixels[off] = rect.r;
        pixels[off + 1] = rect.g;
        pixels[off + 2] = rect.b;
        pixels[off + 3] = 255;
      }
    }
  }
  return { width, height, pixels };
}

// ============================================================================
// A. SharpImageAdapter.create() 测试
// ============================================================================

test("create: sharp 已安装时成功创建 SharpImageAdapter 实例", { skip: !sharpAvailable }, async () => {
  const adapter = await SharpImageAdapter.create();
  assert.ok(adapter instanceof SharpImageAdapter);
});

test("create: 多次调用 create() 返回独立的实例", { skip: !sharpAvailable }, async () => {
  const adapter1 = await SharpImageAdapter.create();
  const adapter2 = await SharpImageAdapter.create();
  assert.ok(adapter1 instanceof SharpImageAdapter);
  assert.ok(adapter2 instanceof SharpImageAdapter);
  // 验证是不同实例（不是缓存的单例）
  assert.notEqual(adapter1, adapter2);
});

// ============================================================================
// B. SharpImageAdapter.save() + load() 往返测试
// ============================================================================

test("save + load: 纯色图像往返保持像素一致", { skip: !sharpAvailable }, async () => {
  const dir = await createTmpDir("roundtrip-solid");
  const adapter = await SharpImageAdapter.create();
  const original = solidImageData(10, 10, 255, 0, 0); // 纯红
  const filePath = path.join(dir, "red.png");

  // 保存 → 重新加载 → 验证像素一致
  await adapter.save(filePath, original);
  assert.ok(nodeFs.existsSync(filePath), "PNG 文件应已写入磁盘");

  const loaded = await adapter.load(filePath);
  assert.equal(loaded.width, original.width);
  assert.equal(loaded.height, original.height);
  assert.equal(loaded.pixels.length, original.pixels.length);
  // 逐像素验证
  for (let i = 0; i < original.pixels.length; i++) {
    assert.equal(loaded.pixels[i], original.pixels[i], `像素 ${i} 应一致`);
  }
});

test("save + load: 带矩形图像往返保持像素一致", { skip: !sharpAvailable }, async () => {
  const dir = await createTmpDir("roundtrip-rects");
  const adapter = await SharpImageAdapter.create();
  const original = imageDataWithRects(
    50,
    50,
    255,
    255,
    255, // 白色背景
    [
      { x: 5, y: 5, w: 20, h: 10, r: 255, g: 0, b: 0 }, // 红色矩形
      { x: 30, y: 20, w: 15, h: 15, r: 0, g: 0, b: 255 }, // 蓝色矩形
    ]
  );
  const filePath = path.join(dir, "rects.png");

  await adapter.save(filePath, original);
  const loaded = await adapter.load(filePath);

  assert.equal(loaded.width, 50);
  assert.equal(loaded.height, 50);
  assert.equal(loaded.pixels.length, 50 * 50 * 4);

  // 验证矩形区域内的像素颜色
  // 红色矩形 (5,5) 应为 (255,0,0,255)
  const redPixelOffset = (5 * 50 + 5) * 4;
  assert.equal(loaded.pixels[redPixelOffset], 255, "R 分量");
  assert.equal(loaded.pixels[redPixelOffset + 1], 0, "G 分量");
  assert.equal(loaded.pixels[redPixelOffset + 2], 0, "B 分量");
  assert.equal(loaded.pixels[redPixelOffset + 3], 255, "A 分量");

  // 蓝色矩形 (30,20) 应为 (0,0,255,255)
  const bluePixelOffset = (20 * 50 + 30) * 4;
  assert.equal(loaded.pixels[bluePixelOffset], 0, "R 分量");
  assert.equal(loaded.pixels[bluePixelOffset + 1], 0, "G 分量");
  assert.equal(loaded.pixels[bluePixelOffset + 2], 255, "B 分量");
  assert.equal(loaded.pixels[bluePixelOffset + 3], 255, "A 分量");

  // 背景区域 (0,0) 应为 (255,255,255,255)
  const bgPixelOffset = 0;
  assert.equal(loaded.pixels[bgPixelOffset], 255);
  assert.equal(loaded.pixels[bgPixelOffset + 1], 255);
  assert.equal(loaded.pixels[bgPixelOffset + 2], 255);
  assert.equal(loaded.pixels[bgPixelOffset + 3], 255);
});

test("save: 自动创建父目录", { skip: !sharpAvailable }, async () => {
  const dir = await createTmpDir("save-mkdir");
  const adapter = await SharpImageAdapter.create();
  const data = solidImageData(5, 5, 0, 128, 0);
  const filePath = path.join(dir, "nested", "deep", "dir", "green.png");

  // 父目录不存在时 save() 应自动创建
  await adapter.save(filePath, data);
  assert.ok(nodeFs.existsSync(filePath));
});

// ============================================================================
// C. SharpImageAdapter.getSize() 测试
// ============================================================================

test("getSize: 返回正确的图像尺寸", { skip: !sharpAvailable }, async () => {
  const dir = await createTmpDir("getsize");
  const adapter = await SharpImageAdapter.create();
  const original = solidImageData(120, 80, 100, 150, 200);
  const filePath = path.join(dir, "sized.png");

  await adapter.save(filePath, original);
  const size = await adapter.getSize(filePath);
  assert.equal(size.width, 120);
  assert.equal(size.height, 80);
});

test("getSize: 1x1 像素图像返回正确尺寸", { skip: !sharpAvailable }, async () => {
  const dir = await createTmpDir("getsize-1x1");
  const adapter = await SharpImageAdapter.create();
  const original = solidImageData(1, 1, 0, 0, 0);
  const filePath = path.join(dir, "pixel.png");

  await adapter.save(filePath, original);
  const size = await adapter.getSize(filePath);
  assert.equal(size.width, 1);
  assert.equal(size.height, 1);
});

// ============================================================================
// D. SharpImageAdapter.copy() 测试
// ============================================================================

test("copy: 复制文件到新路径", { skip: !sharpAvailable }, async () => {
  const dir = await createTmpDir("copy");
  const adapter = await SharpImageAdapter.create();
  const original = solidImageData(20, 20, 128, 128, 128);
  const srcPath = path.join(dir, "src.png");
  const dstPath = path.join(dir, "dst.png");

  await adapter.save(srcPath, original);
  assert.ok(nodeFs.existsSync(srcPath));

  await adapter.copy(srcPath, dstPath);
  assert.ok(nodeFs.existsSync(dstPath), "目标文件应已创建");

  // 验证复制后的文件可被 load 加载，且像素与原文件一致
  const loadedFromDst = await adapter.load(dstPath);
  assert.equal(loadedFromDst.width, 20);
  assert.equal(loadedFromDst.height, 20);
  for (let i = 0; i < original.pixels.length; i++) {
    assert.equal(loadedFromDst.pixels[i], original.pixels[i]);
  }
});

test("copy: 自动创建目标父目录", { skip: !sharpAvailable }, async () => {
  const dir = await createTmpDir("copy-mkdir");
  const adapter = await SharpImageAdapter.create();
  const original = solidImageData(10, 10, 50, 100, 150);
  const srcPath = path.join(dir, "src.png");
  const dstPath = path.join(dir, "nested", "deep", "dst.png");

  await adapter.save(srcPath, original);
  await adapter.copy(srcPath, dstPath);
  assert.ok(nodeFs.existsSync(dstPath));
});

// ============================================================================
// E. 错误场景测试
// ============================================================================

test("load: 文件不存在时抛出 IMAGE_LOAD_FAILED 错误", { skip: !sharpAvailable }, async () => {
  const dir = await createTmpDir("load-missing");
  const adapter = await SharpImageAdapter.create();
  const nonExistentFile = path.join(dir, "non-existent.png");

  await assert.rejects(
    () => adapter.load(nonExistentFile),
    (err: unknown) => {
      assert.ok(err instanceof SharpImageAdapterError);
      assert.equal(err.code, "IMAGE_LOAD_FAILED");
      assert.ok(err.message.includes(nonExistentFile));
      return true;
    }
  );
});

test("load: 非 PNG 文件（文本文件）抛出 IMAGE_LOAD_FAILED 错误", { skip: !sharpAvailable }, async () => {
  const dir = await createTmpDir("load-text");
  const adapter = await SharpImageAdapter.create();
  const textFile = path.join(dir, "text.png");
  // 写入文本内容（不是有效的图像数据）
  await fs.writeFile(textFile, "this is not a png file", "utf-8");

  await assert.rejects(
    () => adapter.load(textFile),
    (err: unknown) => {
      assert.ok(err instanceof SharpImageAdapterError);
      assert.equal(err.code, "IMAGE_LOAD_FAILED");
      return true;
    }
  );
});

test("getSize: 文件不存在时抛出 IMAGE_SIZE_FAILED 错误", { skip: !sharpAvailable }, async () => {
  const dir = await createTmpDir("getsize-missing");
  const adapter = await SharpImageAdapter.create();
  const nonExistentFile = path.join(dir, "non-existent.png");

  await assert.rejects(
    () => adapter.getSize(nonExistentFile),
    (err: unknown) => {
      assert.ok(err instanceof SharpImageAdapterError);
      assert.equal(err.code, "IMAGE_SIZE_FAILED");
      assert.ok(err.message.includes(nonExistentFile));
      return true;
    }
  );
});

test("copy: 源文件不存在时抛出 IMAGE_COPY_FAILED 错误", { skip: !sharpAvailable }, async () => {
  const dir = await createTmpDir("copy-missing");
  const adapter = await SharpImageAdapter.create();
  const nonExistentSrc = path.join(dir, "non-existent.png");
  const dst = path.join(dir, "dst.png");

  await assert.rejects(
    () => adapter.copy(nonExistentSrc, dst),
    (err: unknown) => {
      assert.ok(err instanceof SharpImageAdapterError);
      assert.equal(err.code, "IMAGE_COPY_FAILED");
      assert.ok(err.message.includes(nonExistentSrc));
      return true;
    }
  );
});

// ============================================================================
// F. SharpImageAdapterError 属性测试
// ============================================================================

test("SharpImageAdapterError: 包含正确的 name 与 code 属性", () => {
  const err = new SharpImageAdapterError("SHARP_NOT_INSTALLED", "sharp 库未安装");
  assert.equal(err.name, "SharpImageAdapterError");
  assert.equal(err.code, "SHARP_NOT_INSTALLED");
  assert.equal(err.message, "sharp 库未安装");
  assert.ok(err instanceof Error);
});

test("SharpImageAdapterError: 支持所有错误代码", () => {
  const codes = [
    "SHARP_NOT_INSTALLED",
    "IMAGE_LOAD_FAILED",
    "IMAGE_SAVE_FAILED",
    "IMAGE_COPY_FAILED",
    "IMAGE_SIZE_FAILED",
  ] as const;
  for (const code of codes) {
    const err = new SharpImageAdapterError(code, `测试 ${code}`);
    assert.equal(err.code, code);
    assert.ok(err.message.includes(code) || err.message.includes("测试"));
  }
});

// ============================================================================
// 真实磁盘 I/O 验证：避免 mock 嫌疑
// ============================================================================

test("save: 写入的 PNG 文件可被 node:fs 读取且为有效 PNG 签名", { skip: !sharpAvailable }, async () => {
  const dir = await createTmpDir("real-png");
  const adapter = await SharpImageAdapter.create();
  const data = solidImageData(8, 8, 255, 128, 0);
  const filePath = path.join(dir, "real.png");

  await adapter.save(filePath, data);

  // 通过 node:fs 直接读取文件，验证文件真实存在
  assert.ok(nodeFs.existsSync(filePath));
  const fileBuffer = nodeFs.readFileSync(filePath);
  // PNG 文件签名：89 50 4E 47 0D 0A 1A 0A
  assert.equal(fileBuffer[0], 0x89);
  assert.equal(fileBuffer[1], 0x50); // 'P'
  assert.equal(fileBuffer[2], 0x4e); // 'N'
  assert.equal(fileBuffer[3], 0x47); // 'G'
  assert.equal(fileBuffer[4], 0x0d);
  assert.equal(fileBuffer[5], 0x0a);
  assert.equal(fileBuffer[6], 0x1a);
  assert.equal(fileBuffer[7], 0x0a);
});
