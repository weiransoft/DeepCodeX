/**
 * file-backed-page-like 单元测试
 *
 * 测试范围：
 *   - A. fromFile: 完整结构 { domAuditData, contrastSamples } 加载
 *   - B. fromFile: 仅 DOMAuditData 结构加载（contrastSamples 默认空数组）
 *   - C. fromFile: contrastFile 单独提供时覆盖 domFile 中的 contrastSamples
 *   - D. fromFile: 错误场景（文件不存在 / JSON 解析失败 / Schema 校验失败）
 *   - E. evaluateDOM / evaluateContrast: 返回加载的数据
 *   - F. resolveDomFilePath: 相对路径解析
 *
 * 测试约定（遵循项目规则）：
 *   - 使用 node:test + node:assert/strict
 *   - 禁止使用 mock 框架：使用真实的临时目录与真实文件 I/O
 *   - 每个测试用例独立隔离：独立临时目录 + after 统一清理
 *   - 真实构造 DOMAuditData / ContrastSample JSON 文件
 *
 * @module cli/tests/file-backed-page-like
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FileBackedPageLike, FileBackedPageLikeError, resolveDomFilePath } from "../quality/file-backed-page-like";
import type { DOMAuditData, ContrastSample } from "@deepcodex/quality";

// ============================================================================
// 测试基础设施：临时目录管理
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `quality-fbp-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

/**
 * 写入 JSON 文件并返回绝对路径
 *
 * @param dir 目录
 * @param filename 文件名
 * @param data 数据对象
 * @returns 文件绝对路径
 */
async function writeJsonFile(dir: string, filename: string, data: unknown): Promise<string> {
  const filePath = path.join(dir, filename);
  await fs.writeFile(filePath, JSON.stringify(data), "utf-8");
  return filePath;
}

/**
 * 写入原始文本文件（用于构造非法 JSON 测试场景）
 *
 * @param dir 目录
 * @param filename 文件名
 * @param content 文本内容
 * @returns 文件绝对路径
 */
async function writeTextFile(dir: string, filename: string, content: string): Promise<string> {
  const filePath = path.join(dir, filename);
  await fs.writeFile(filePath, content, "utf-8");
  return filePath;
}

// 测试结束后清理所有临时目录
after(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// 测试 Fixtures：真实 DOMAuditData 与 ContrastSample
// ============================================================================

/**
 * 构造一个最小但完整的 DOMAuditData 对象
 *
 * 包含 6 个必需字段（images/form_controls/buttons/links/headings/errors），
 * 每个字段为空数组（满足 Schema 校验：必须是数组）。
 */
function makeMinimalDOMAuditData(): DOMAuditData {
  return {
    images: [],
    form_controls: [],
    buttons: [],
    links: [],
    headings: [],
    errors: [],
  };
}

/**
 * 构造一个含真实数据的 DOMAuditData 对象
 *
 * 包含 1 张图片（无 alt，触发 a11y 问题）、1 个表单控件、1 个按钮等。
 */
function makeRealisticDOMAuditData(): DOMAuditData {
  return {
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
    ],
    buttons: [{ selector: "button.submit", text: "提交", width: 120, height: 44, visible: true, disabled: false }],
    links: [{ selector: "a.help", text: "查看帮助", href: "/help", target: null }],
    headings: [{ level: 1, text: "登录" }],
    errors: [],
  };
}

/**
 * 构造一个真实 ContrastSample 数组
 *
 * 包含 1 条低对比度采样（font_size=14, color=#ccc, background=#fff）。
 */
function makeRealisticContrastSamples(): ContrastSample[] {
  return [
    {
      text: "灰色文字",
      color: "#cccccc",
      background: "#ffffff",
      font_size: 14,
      font_weight: 400,
      selector: "p.muted",
    },
  ];
}

// ============================================================================
// A. fromFile: 完整结构 { domAuditData, contrastSamples } 加载
// ============================================================================

test("fromFile: 完整结构 JSON 加载成功，evaluateDOM 返回 domAuditData", async () => {
  const dir = await createTmpDir("full-struct");
  const domData = makeRealisticDOMAuditData();
  const contrastSamples = makeRealisticContrastSamples();
  const domFile = await writeJsonFile(dir, "dom.json", {
    domAuditData: domData,
    contrastSamples,
  });

  const page = await FileBackedPageLike.fromFile(domFile);
  const evaluatedDom = await page.evaluateDOM();
  assert.deepEqual(evaluatedDom, domData);
  // 验证返回的是真实数据（非空数组）
  assert.equal(evaluatedDom.images.length, 1);
  assert.equal(evaluatedDom.images[0]!.selector, "img.hero");
});

test("fromFile: 完整结构 JSON 加载成功，evaluateContrast 返回 contrastSamples", async () => {
  const dir = await createTmpDir("full-struct-contrast");
  const domData = makeRealisticDOMAuditData();
  const contrastSamples = makeRealisticContrastSamples();
  const domFile = await writeJsonFile(dir, "dom.json", {
    domAuditData: domData,
    contrastSamples,
  });

  const page = await FileBackedPageLike.fromFile(domFile);
  const evaluatedContrast = await page.evaluateContrast();
  assert.deepEqual(evaluatedContrast, contrastSamples);
  assert.equal(evaluatedContrast.length, 1);
  assert.equal(evaluatedContrast[0]!.selector, "p.muted");
});

// ============================================================================
// B. fromFile: 仅 DOMAuditData 结构加载（contrastSamples 默认空数组）
// ============================================================================

test("fromFile: 仅 DOMAuditData 结构加载时 contrastSamples 默认为空数组", async () => {
  const dir = await createTmpDir("dom-only");
  const domData = makeMinimalDOMAuditData();
  const domFile = await writeJsonFile(dir, "dom.json", domData);

  const page = await FileBackedPageLike.fromFile(domFile);
  const evaluatedDom = await page.evaluateDOM();
  const evaluatedContrast = await page.evaluateContrast();
  assert.deepEqual(evaluatedDom, domData);
  assert.deepEqual(evaluatedContrast, []);
  assert.equal(evaluatedContrast.length, 0);
});

// ============================================================================
// C. fromFile: contrastFile 单独提供时覆盖 domFile 中的 contrastSamples
// ============================================================================

test("fromFile: contrastFile 单独提供时覆盖 domFile 中的 contrastSamples", async () => {
  const dir = await createTmpDir("contrast-override");
  const domData = makeMinimalDOMAuditData();
  // domFile 中包含 1 条 contrastSamples
  const domFileContrastSamples = makeRealisticContrastSamples();
  const domFile = await writeJsonFile(dir, "dom.json", {
    domAuditData: domData,
    contrastSamples: domFileContrastSamples,
  });

  // contrastFile 包含 2 条不同的 contrastSamples（覆盖 domFile 中的）
  const contrastFileSamples: ContrastSample[] = [
    {
      text: "外部对比度文件 - 条目 1",
      color: "#000000",
      background: "#ffffff",
      font_size: 16,
      font_weight: 700,
      selector: "h1.title",
    },
    {
      text: "外部对比度文件 - 条目 2",
      color: "#666666",
      background: "#f5f5f5",
      font_size: 12,
      font_weight: 400,
      selector: "span.small",
    },
  ];
  const contrastFile = await writeJsonFile(dir, "contrast.json", contrastFileSamples);

  const page = await FileBackedPageLike.fromFile(domFile, contrastFile);
  const evaluatedContrast = await page.evaluateContrast();
  // 应返回 contrastFile 中的数据，而非 domFile 中的
  assert.deepEqual(evaluatedContrast, contrastFileSamples);
  assert.equal(evaluatedContrast.length, 2);
  assert.equal(evaluatedContrast[0]!.selector, "h1.title");
});

test("fromFile: contrastFile 支持 { contrastSamples: [...] } 包装结构", async () => {
  const dir = await createTmpDir("contrast-wrapped");
  const domData = makeMinimalDOMAuditData();
  const domFile = await writeJsonFile(dir, "dom.json", domData);
  const samples = makeRealisticContrastSamples();
  const contrastFile = await writeJsonFile(dir, "contrast.json", { contrastSamples: samples });

  const page = await FileBackedPageLike.fromFile(domFile, contrastFile);
  const evaluatedContrast = await page.evaluateContrast();
  assert.deepEqual(evaluatedContrast, samples);
});

// ============================================================================
// D. fromFile: 错误场景
// ============================================================================

test("fromFile: domFile 不存在时抛出 FILE_NOT_FOUND 错误", async () => {
  const dir = await createTmpDir("dom-missing");
  const nonExistentFile = path.join(dir, "non-existent.json");

  await assert.rejects(
    () => FileBackedPageLike.fromFile(nonExistentFile),
    (err: unknown) => {
      assert.ok(err instanceof FileBackedPageLikeError);
      assert.equal(err.code, "FILE_NOT_FOUND");
      assert.ok(err.message.includes("DOM 数据文件不存在"));
      assert.ok(err.message.includes(nonExistentFile));
      return true;
    }
  );
});

test("fromFile: domFile 是非法 JSON 时抛出 PARSE_ERROR 错误", async () => {
  const dir = await createTmpDir("dom-parse-err");
  const domFile = await writeTextFile(dir, "dom.json", "{ this is not valid json,,, }");

  await assert.rejects(
    () => FileBackedPageLike.fromFile(domFile),
    (err: unknown) => {
      assert.ok(err instanceof FileBackedPageLikeError);
      assert.equal(err.code, "PARSE_ERROR");
      assert.ok(err.message.includes("JSON 解析失败"));
      return true;
    }
  );
});

test("fromFile: domFile 缺失必需字段时抛出 SCHEMA_ERROR 错误", async () => {
  const dir = await createTmpDir("dom-schema-missing");
  // 缺失 buttons / links / headings / errors 字段
  const incompleteData = { images: [], form_controls: [] };
  const domFile = await writeJsonFile(dir, "dom.json", incompleteData);

  await assert.rejects(
    () => FileBackedPageLike.fromFile(domFile),
    (err: unknown) => {
      assert.ok(err instanceof FileBackedPageLikeError);
      assert.equal(err.code, "SCHEMA_ERROR");
      assert.ok(err.message.includes("缺失字段"));
      // 应列出缺失的字段名
      assert.ok(err.message.includes("buttons"));
      assert.ok(err.message.includes("links"));
      assert.ok(err.message.includes("headings"));
      assert.ok(err.message.includes("errors"));
      return true;
    }
  );
});

test("fromFile: domFile 必需字段非数组时抛出 SCHEMA_ERROR 错误", async () => {
  const dir = await createTmpDir("dom-schema-nonarray");
  // images 是字符串而非数组
  const invalidData = {
    images: "not-an-array",
    form_controls: [],
    buttons: [],
    links: [],
    headings: [],
    errors: [],
  };
  const domFile = await writeJsonFile(dir, "dom.json", invalidData);

  await assert.rejects(
    () => FileBackedPageLike.fromFile(domFile),
    (err: unknown) => {
      assert.ok(err instanceof FileBackedPageLikeError);
      assert.equal(err.code, "SCHEMA_ERROR");
      assert.ok(err.message.includes("非数组字段"));
      assert.ok(err.message.includes("images"));
      return true;
    }
  );
});

test("fromFile: domFile 是数组而非对象时抛出 SCHEMA_ERROR 错误", async () => {
  const dir = await createTmpDir("dom-array");
  const domFile = await writeJsonFile(dir, "dom.json", [1, 2, 3]);

  await assert.rejects(
    () => FileBackedPageLike.fromFile(domFile),
    (err: unknown) => {
      assert.ok(err instanceof FileBackedPageLikeError);
      assert.equal(err.code, "SCHEMA_ERROR");
      assert.ok(err.message.includes("应为对象"));
      return true;
    }
  );
});

test("fromFile: domFile 是 null 时抛出 SCHEMA_ERROR 错误", async () => {
  const dir = await createTmpDir("dom-null");
  const domFile = await writeTextFile(dir, "dom.json", "null");

  await assert.rejects(
    () => FileBackedPageLike.fromFile(domFile),
    (err: unknown) => {
      assert.ok(err instanceof FileBackedPageLikeError);
      assert.equal(err.code, "SCHEMA_ERROR");
      return true;
    }
  );
});

test("fromFile: domFile 中 contrastSamples 包含缺失字段的记录时抛出 SCHEMA_ERROR", async () => {
  const dir = await createTmpDir("contrast-schema-missing");
  const domData = makeMinimalDOMAuditData();
  // contrastSamples 第一条记录缺失 color / background / font_size 等字段
  const incompleteContrastSamples = [{ text: "缺字段", selector: "p" }];
  const domFile = await writeJsonFile(dir, "dom.json", {
    domAuditData: domData,
    contrastSamples: incompleteContrastSamples,
  });

  await assert.rejects(
    () => FileBackedPageLike.fromFile(domFile),
    (err: unknown) => {
      assert.ok(err instanceof FileBackedPageLikeError);
      assert.equal(err.code, "SCHEMA_ERROR");
      assert.ok(err.message.includes("第 1 条记录缺失字段"));
      // 应列出缺失的字段
      assert.ok(err.message.includes("color"));
      assert.ok(err.message.includes("background"));
      assert.ok(err.message.includes("font_size"));
      assert.ok(err.message.includes("font_weight"));
      return true;
    }
  );
});

test("fromFile: domFile 中 contrastSamples 是非数组时抛出 SCHEMA_ERROR", async () => {
  const dir = await createTmpDir("contrast-nonarray");
  const domData = makeMinimalDOMAuditData();
  const domFile = await writeJsonFile(dir, "dom.json", {
    domAuditData: domData,
    contrastSamples: "not-an-array",
  });

  await assert.rejects(
    () => FileBackedPageLike.fromFile(domFile),
    (err: unknown) => {
      assert.ok(err instanceof FileBackedPageLikeError);
      assert.equal(err.code, "SCHEMA_ERROR");
      assert.ok(err.message.includes("应为数组"));
      return true;
    }
  );
});

test("fromFile: contrastFile 不存在时抛出 FILE_NOT_FOUND 错误", async () => {
  const dir = await createTmpDir("contrast-missing");
  const domData = makeMinimalDOMAuditData();
  const domFile = await writeJsonFile(dir, "dom.json", domData);
  const nonExistentContrastFile = path.join(dir, "non-existent-contrast.json");

  await assert.rejects(
    () => FileBackedPageLike.fromFile(domFile, nonExistentContrastFile),
    (err: unknown) => {
      assert.ok(err instanceof FileBackedPageLikeError);
      assert.equal(err.code, "FILE_NOT_FOUND");
      assert.ok(err.message.includes("对比度采样文件不存在"));
      return true;
    }
  );
});

test("fromFile: contrastFile 是非法 JSON 时抛出 PARSE_ERROR 错误", async () => {
  const dir = await createTmpDir("contrast-parse-err");
  const domData = makeMinimalDOMAuditData();
  const domFile = await writeJsonFile(dir, "dom.json", domData);
  const contrastFile = await writeTextFile(dir, "contrast.json", "not a json");

  await assert.rejects(
    () => FileBackedPageLike.fromFile(domFile, contrastFile),
    (err: unknown) => {
      assert.ok(err instanceof FileBackedPageLikeError);
      assert.equal(err.code, "PARSE_ERROR");
      assert.ok(err.message.includes("对比度采样文件 JSON 解析失败"));
      return true;
    }
  );
});

// ============================================================================
// E. evaluateDOM / evaluateContrast 返回数据的一致性
// ============================================================================

test("evaluateDOM / evaluateContrast: 多次调用返回一致的数据（不可变语义）", async () => {
  const dir = await createTmpDir("immutable");
  const domData = makeRealisticDOMAuditData();
  const contrastSamples = makeRealisticContrastSamples();
  const domFile = await writeJsonFile(dir, "dom.json", {
    domAuditData: domData,
    contrastSamples,
  });

  const page = await FileBackedPageLike.fromFile(domFile);
  // 多次调用 evaluateDOM 与 evaluateContrast，验证返回一致
  const dom1 = await page.evaluateDOM();
  const dom2 = await page.evaluateDOM();
  assert.deepEqual(dom1, dom2);

  const contrast1 = await page.evaluateContrast();
  const contrast2 = await page.evaluateContrast();
  assert.deepEqual(contrast1, contrast2);
});

test("FileBackedPageLikeError: 错误对象包含正确的 name 与 code", async () => {
  const dir = await createTmpDir("error-name");
  const nonExistentFile = path.join(dir, "non-existent.json");
  try {
    await FileBackedPageLike.fromFile(nonExistentFile);
    assert.fail("应抛出错误");
  } catch (err) {
    assert.ok(err instanceof FileBackedPageLikeError);
    assert.equal(err.name, "FileBackedPageLikeError");
    assert.equal(err.code, "FILE_NOT_FOUND");
    // 验证 Error 基类字段
    assert.ok(err.message.length > 0);
    assert.ok(err instanceof Error);
  }
});

// ============================================================================
// F. resolveDomFilePath 测试
// ============================================================================

test("resolveDomFilePath: 绝对路径直接返回", () => {
  const absPath = path.join(os.tmpdir(), "abs-dom.json");
  const resolved = resolveDomFilePath(absPath);
  assert.equal(resolved, absPath);
});

test("resolveDomFilePath: 相对路径基于 cwd 解析为绝对路径", () => {
  const relativePath = "dom.json";
  const resolved = resolveDomFilePath(relativePath);
  const expected = path.resolve(process.cwd(), relativePath);
  assert.equal(resolved, expected);
  // 验证结果是绝对路径
  assert.ok(path.isAbsolute(resolved));
});

test("resolveDomFilePath: 子目录相对路径正确解析", () => {
  const relativePath = path.join("tests", "fixtures", "dom.json");
  const resolved = resolveDomFilePath(relativePath);
  const expected = path.resolve(process.cwd(), relativePath);
  assert.equal(resolved, expected);
});

// ============================================================================
// 真实文件 I/O 集成：使用 nodeFs 直接验证文件存在性（避免 mock）
// ============================================================================

test("fromFile: 加载真实磁盘文件后，文件仍可被 node:fs 读取（验证未使用 mock）", async () => {
  const dir = await createTmpDir("real-io");
  const domData = makeMinimalDOMAuditData();
  const domFile = await writeJsonFile(dir, "dom.json", domData);

  // 通过 node:fs 直接读取文件，验证文件真实存在
  assert.ok(nodeFs.existsSync(domFile));
  const fileContent = nodeFs.readFileSync(domFile, "utf-8");
  const parsed = JSON.parse(fileContent);
  assert.deepEqual(parsed, domData);

  // 通过 FileBackedPageLike 加载，验证与直接读取一致
  const page = await FileBackedPageLike.fromFile(domFile);
  const evaluatedDom = await page.evaluateDOM();
  assert.deepEqual(evaluatedDom, parsed);
});
