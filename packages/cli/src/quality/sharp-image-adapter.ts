/**
 * SharpImageAdapter - ImageAdapter 接口的 sharp 实现（生产级，非 mock）
 *
 * 用途：在 CLI 终端环境中为 VisualRegression 提供 ImageAdapter 抽象的真实实现。
 *      使用 sharp 库（基于 libvips）实现 PNG/JPEG/WebP 图像的
 *      加载、保存、复制、尺寸查询。
 *
 * 设计原则：
 *   - 真实生产实现：通过 sharp 库真实地读取/写入图像文件的像素数据。
 *   - 懒加载：sharp 通过 dynamic import("sharp") 懒加载，未安装时不影响 CLI 启动。
 *   - 降级安全：sharp 未安装时由 create() 抛出可识别错误，调用方捕获后返回 exitCode=3，
 *     不影响 codemap / uiux 子命令。
 *   - optionalDependencies：sharp 声明在 packages/cli/package.json 的 optionalDependencies 中，
 *     用户可选择不安装（如不需要 visual 子命令的场景）。
 *
 * @module cli/quality/sharp-image-adapter
 */

import type { ImageAdapter, ImageData } from "@deepcodex/quality";

// ============================================================================
// 错误类型
// ============================================================================

/**
 * SharpImageAdapter 相关的错误类
 *
 * 调用方通过 err.code 字段区分错误场景：
 *   - SHARP_NOT_INSTALLED：sharp 库未安装（exitCode=3）
 *   - IMAGE_LOAD_FAILED：图像加载失败（exitCode=4）
 *   - IMAGE_SAVE_FAILED：图像保存失败（exitCode=4）
 *   - IMAGE_COPY_FAILED：图像复制失败（exitCode=4）
 *   - IMAGE_SIZE_FAILED：获取图像尺寸失败（exitCode=4）
 */
export class SharpImageAdapterError extends Error {
  /** 错误代码（用于调用方区分场景） */
  readonly code:
    | "SHARP_NOT_INSTALLED"
    | "IMAGE_LOAD_FAILED"
    | "IMAGE_SAVE_FAILED"
    | "IMAGE_COPY_FAILED"
    | "IMAGE_SIZE_FAILED";

  constructor(
    code: "SHARP_NOT_INSTALLED" | "IMAGE_LOAD_FAILED" | "IMAGE_SAVE_FAILED" | "IMAGE_COPY_FAILED" | "IMAGE_SIZE_FAILED",
    message: string
  ) {
    super(message);
    this.name = "SharpImageAdapterError";
    this.code = code;
  }
}

// ============================================================================
// SharpImageAdapter 主类
// ============================================================================

/**
 * ImageAdapter 接口的 sharp 实现
 *
 * sharp 库通过 dynamic import 懒加载，避免在 CLI 启动时引入 native 依赖。
 * 实例化时必须通过 create() 异步工厂方法，确保 sharp 已成功加载。
 *
 * 用法：
 *   const adapter = await SharpImageAdapter.create();
 *   const img = await adapter.load("./screenshot.png");
 *   const size = await adapter.getSize("./screenshot.png");
 *
 * 失败场景：
 *   - sharp 未安装：create() 抛出 SharpImageAdapterError(code=SHARP_NOT_INSTALLED)
 *   - 图像文件不存在：load() / getSize() 抛出 SharpImageAdapterError(code=IMAGE_LOAD_FAILED / IMAGE_SIZE_FAILED)
 *   - 写入路径不可写：save() 抛出 SharpImageAdapterError(code=IMAGE_SAVE_FAILED)
 */
export class SharpImageAdapter implements ImageAdapter {
  /**
   * sharp 构造函数（SharpConstructor 类型）
   *
   * sharp 0.35.x 使用 ES module 导出：`export const sharp: SharpConstructor` 和 `export default sharp`。
   * 我们只持有 SharpConstructor，而不是整个模块。
   */
  private readonly sharp: typeof import("sharp").sharp;

  /**
   * 私有构造函数（使用 create() 异步工厂方法构造）
   *
   * @param sharpConstructor 已加载的 sharp SharpConstructor 实例
   */
  private constructor(sharpConstructor: typeof import("sharp").sharp) {
    this.sharp = sharpConstructor;
  }

  /**
   * 异步构造 SharpImageAdapter
   *
   * 通过 dynamic import("sharp") 懒加载 sharp 库。
   * 失败时抛出 SharpImageAdapterError(code=SHARP_NOT_INSTALLED)，
   * 调用方捕获后返回 exitCode=3 + 明确安装指引。
   *
   * @returns SharpImageAdapter 实例
   * @throws {SharpImageAdapterError} sharp 未安装或加载失败
   */
  static async create(): Promise<SharpImageAdapter> {
    let sharpConstructor: typeof import("sharp").sharp;
    try {
      // dynamic import 懒加载 sharp
      // 当 sharp 在 optionalDependencies 中且未安装时，import() 会抛出 MODULE_NOT_FOUND
      // sharp 0.35.x 使用 ES module 导出：`export const sharp: SharpConstructor` 和 `export default sharp`
      const imported = await import("sharp");
      // sharp 0.35.x 同时提供 named export 和 default export
      // 优先使用 default（兼容性更好）
      sharpConstructor =
        (imported as { default?: typeof import("sharp").sharp }).default ??
        (imported as unknown as typeof import("sharp").sharp);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      throw new SharpImageAdapterError(
        "SHARP_NOT_INSTALLED",
        `sharp 库未安装或加载失败：${errMsg}\n` +
          `视觉回归子命令需要 sharp 依赖：请在 packages/cli 目录执行 \`npm install sharp\` 或 \`npm install --include=optional sharp\``
      );
    }
    return new SharpImageAdapter(sharpConstructor);
  }

  /**
   * 加载图像到内存
   *
   * 实现 ImageAdapter.load() 接口方法。
   * 使用 sharp 读取图像文件并解析为 RGBA 像素数组。
   *
   * @param path 图像文件路径
   * @returns ImageData 对象（width / height / pixels）
   * @throws {SharpImageAdapterError} 图像加载失败
   */
  async load(path: string): Promise<ImageData> {
    try {
      // 获取图像元数据
      const metadata = await this.sharp(path).metadata();
      const width = metadata.width ?? 0;
      const height = metadata.height ?? 0;
      if (width === 0 || height === 0) {
        throw new SharpImageAdapterError(
          "IMAGE_LOAD_FAILED",
          `图像尺寸无效: ${path} (width=${width}, height=${height})`
        );
      }
      // 提取 RGBA 像素数据（确保 4 通道）
      const { data } = await this.sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      return {
        width,
        height,
        // 将 Buffer 转换为 Uint8ClampedArray（与 ImageData.pixels 类型一致）
        pixels: new Uint8ClampedArray(data),
      };
    } catch (err) {
      // 已是 SharpImageAdapterError 时直接抛出
      if (err instanceof SharpImageAdapterError) {
        throw err;
      }
      throw new SharpImageAdapterError(
        "IMAGE_LOAD_FAILED",
        `加载图像失败: ${path} - ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * 获取图像尺寸
   *
   * 实现 ImageAdapter.getSize() 接口方法。
   * 使用 sharp 读取图像元数据，不加载完整像素数据（性能更优）。
   *
   * @param path 图像文件路径
   * @returns 包含 width 和 height 的对象
   * @throws {SharpImageAdapterError} 获取尺寸失败
   */
  async getSize(path: string): Promise<{ width: number; height: number }> {
    try {
      const metadata = await this.sharp(path).metadata();
      const width = metadata.width ?? 0;
      const height = metadata.height ?? 0;
      if (width === 0 || height === 0) {
        throw new SharpImageAdapterError(
          "IMAGE_SIZE_FAILED",
          `图像尺寸无效: ${path} (width=${width}, height=${height})`
        );
      }
      return { width, height };
    } catch (err) {
      if (err instanceof SharpImageAdapterError) {
        throw err;
      }
      throw new SharpImageAdapterError(
        "IMAGE_SIZE_FAILED",
        `获取图像尺寸失败: ${path} - ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * 保存图像到文件
   *
   * 实现 ImageAdapter.save() 接口方法。
   * 将 ImageData（RGBA 像素数组）写入 PNG 文件。
   *
   * @param path 输出文件路径
   * @param data ImageData 对象（width / height / pixels）
   * @throws {SharpImageAdapterError} 图像保存失败
   */
  async save(path: string, data: ImageData): Promise<void> {
    try {
      // 将 Uint8ClampedArray 转换为 Buffer
      const buffer = Buffer.from(data.pixels);
      // 自动创建父目录（sharp.toFile 不会自动创建目录，否则会抛出 ENOENT）
      const nodePath = await import("node:path");
      const nodeFs = await import("node:fs/promises");
      await nodeFs.mkdir(nodePath.dirname(path), { recursive: true });
      // 使用 sharp 从原始像素数据构造图像并输出为 PNG
      await this.sharp(buffer, {
        raw: {
          width: data.width,
          height: data.height,
          channels: 4, // RGBA
        },
      })
        .png()
        .toFile(path);
    } catch (err) {
      throw new SharpImageAdapterError(
        "IMAGE_SAVE_FAILED",
        `保存图像失败: ${path} - ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * 复制图像文件
   *
   * 实现 ImageAdapter.copy() 接口方法。
   * 使用 Node.js 原生 fs.copyFile 实现，不依赖 sharp 的图像处理能力。
   *
   * @param src 源文件路径
   * @param dst 目标文件路径
   * @throws {SharpImageAdapterError} 图像复制失败
   */
  async copy(src: string, dst: string): Promise<void> {
    try {
      // 使用 Node.js 原生 fs 模块复制文件（性能优于 sharp 中转）
      const fs = await import("node:fs/promises");
      const nodePath = await import("node:path");
      // 确保目标目录存在
      await fs.mkdir(nodePath.dirname(dst), { recursive: true });
      await fs.copyFile(src, dst);
    } catch (err) {
      throw new SharpImageAdapterError(
        "IMAGE_COPY_FAILED",
        `复制图像失败: ${src} → ${dst} - ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
