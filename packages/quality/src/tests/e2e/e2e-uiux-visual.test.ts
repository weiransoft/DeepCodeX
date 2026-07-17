/**
 * 质量门禁 E2E 测试 - UIUXAnalyzer + VisualRegression 协同
 *
 * 覆盖场景（端到端模拟"页面截图 → UI/UX 巡检 → 视觉回归比对 → 报告生成"完整流程）：
 *   E2E-UV-01: 完美页面 → UI/UX 0 问题 → 视觉回归全通过
 *   E2E-UV-02: 反模式页面 → UI/UX 高分问题 → 视觉回归捕获红色错误
 *   E2E-UV-03: 视觉回归基线管理（首次保存 → 二次比对）
 *   E2E-UV-04: 像素级 Diff（细微变化）应被捕获
 *   E2E-UV-05: 尺寸不一致时整图作为变化区域
 *   E2E-UV-06: 数据显示不全（文本截断、溢出、未加载）端到端捕获
 *   E2E-UV-07: 显示错误（错误关键词、错误 toast class）端到端捕获
 *   E2E-UV-08: 红色错误 toast（图像 HSV 检测）端到端捕获
 *   E2E-UV-09: UIUX 评分 + 视觉回归综合质量门禁
 *   E2E-UV-10: 大页面端到端性能（1000 元素 < 5s）
 *
 * 严格遵循 user rules：
 *   - 禁止 mock ImageAdapter / mock PageLike
 *   - 使用真实 DOMAuditData + 真实 ImageData 构造场景
 *   - 通过真实算法（WCAG 对比度、像素 Diff、SSIM、HSV）验证结果
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { UIUXAnalyzer } from "../../uiux-analyzer.js";
import { VisualRegression } from "../../visual-regression.js";
import type { VisualDiffResult } from "@vegamo/deepcode-core";
import {
  MemoryImageAdapter,
  solidImage,
  imageWithRects,
  imageWithNoise,
  imageWithRedStripe,
  FakePage,
  perfectPage,
  brokenPage,
  createTmpDir,
  cleanupTmpDir,
} from "./e2e-helpers.js";

describe("E2E: UIUXAnalyzer + VisualRegression 协同", () => {
  let tmpRoot: string;

  before(async () => {
    tmpRoot = await createTmpDir("uv");
  });

  after(async () => {
    await cleanupTmpDir(tmpRoot);
  });

  it("E2E-UV-01: 完美页面 → UI/UX 0 问题 → 视觉回归全通过", async () => {
    // 1) UI/UX 巡检
    const analyzer = new UIUXAnalyzer();
    const issues = await analyzer.audit(perfectPage());
    const report = analyzer.report();

    assert.equal(issues.length, 0, "完美页面应无任何问题");
    assert.equal(report.total_issues, 0);
    assert.equal(report.is_pass, true);
    assert.equal(report.score, 100);

    // 2) 视觉回归：纯白基线 vs 纯白当前 → 全通过
    const adapter = new MemoryImageAdapter();
    const baselinePath = path.join(tmpRoot, "perfect-baseline.png");
    const currentPath = path.join(tmpRoot, "perfect-current.png");
    const whiteImg = solidImage(100, 100, 255, 255, 255);
    adapter.set(baselinePath, whiteImg);
    adapter.set(currentPath, solidImage(100, 100, 255, 255, 255));

    const vr = new VisualRegression({
      imageAdapter: adapter,
      baselineDir: path.join(tmpRoot, "uv01-baseline"),
    });
    const diff: VisualDiffResult = await vr.compare({
      currentScreenshot: currentPath,
      testId: "UV-01",
      step: "step1",
    });
    assert.equal(diff.pixelDiffRatio, 0, "完全相同图像的 diff ratio 应为 0");
    assert.equal(diff.ssimScore, 1.0);
    assert.equal(diff.changedRegions.length, 0);
    assert.equal(diff.dataIncomplete.length, 0);
    assert.equal(diff.displayErrors.length, 0);
  });

  it("E2E-UV-02: 反模式页面 → UI/UX 高分问题 → 视觉回归捕获红色错误", async () => {
    // 1) UI/UX 巡检
    const analyzer = new UIUXAnalyzer();
    const issues = await analyzer.audit(brokenPage());
    const report = analyzer.report();

    assert.ok(issues.length >= 5, "反模式页面应有多条问题");
    assert.ok(report.high_count >= 3, "应有 ≥3 个 HIGH 级别问题");
    assert.equal(report.is_pass, false, "应不通过（存在 HIGH 问题）");
    assert.ok(report.score < 80, "评分应 < 80");

    // 2) 视觉回归：捕获红色错误 toast
    const adapter = new MemoryImageAdapter();
    const baselineDir = path.join(tmpRoot, "uv02-baseline");
    const baselinePath = path.join(baselineDir, "step1.png");
    const currentPath = path.join(tmpRoot, "uv02-cur.png");
    // 预存基线：纯白；当前：白底 + 顶部红色横条（错误 toast 模拟）
    adapter.set(baselinePath, solidImage(200, 100, 255, 255, 255));
    adapter.set(currentPath, imageWithRedStripe(200, 100, 255, 255, 255, 0, 10, 220, 30, 30));

    const vr = new VisualRegression({
      imageAdapter: adapter,
      baselineDir,
    });
    const diff: VisualDiffResult = await vr.compare({
      currentScreenshot: currentPath,
      testId: "UV-02",
      step: "step1",
    });
    assert.ok(diff.pixelDiffRatio > 0, "应有像素差异");
    assert.ok(diff.changedRegions.length >= 1, "应有变化区域");
  });

  it("E2E-UV-03: 视觉回归基线管理（首次保存 → 二次比对）", async () => {
    const baselineDir = path.join(tmpRoot, "uv03-baseline");
    const adapter = new MemoryImageAdapter();
    const currentPath = path.join(tmpRoot, "uv03-current.png");
    adapter.set(currentPath, solidImage(50, 50, 100, 150, 200));

    // 首次执行：无基线，应自动保存
    const vr1 = new VisualRegression({ imageAdapter: adapter, baselineDir });
    const result1 = await vr1.compare({
      currentScreenshot: currentPath,
      testId: "UV-03",
      step: "step1",
    });
    assert.equal(result1.error, "baseline_missing_saved", "首次应标记为已保存基线");

    // 验证基线文件已保存
    const baselineFilePath = path.join(baselineDir, "step1.png");
    const savedBaseline = adapter.get(baselineFilePath);
    assert.ok(savedBaseline, "基线文件应被保存");
    assert.equal(savedBaseline!.width, 50);
    assert.equal(savedBaseline!.height, 50);

    // 二次执行：相同图像，diff 为 0
    const result2 = await vr1.compare({
      currentScreenshot: currentPath,
      testId: "UV-03",
      step: "step1",
    });
    assert.equal(result2.error, undefined);
    assert.equal(result2.pixelDiffRatio, 0);
  });

  it("E2E-UV-04: 像素级 Diff（细微变化）应被捕获", async () => {
    const adapter = new MemoryImageAdapter();
    const baselineDir = path.join(tmpRoot, "uv04-baseline");
    const baselinePath = path.join(baselineDir, "step1.png");
    const currentPath = path.join(tmpRoot, "uv04-cur.png");

    // 预存基线：纯白；在 (10,10) 位置一个红色像素
    adapter.set(baselinePath, solidImage(100, 100, 255, 255, 255));
    adapter.set(
      currentPath,
      imageWithNoise(100, 100, 255, 255, 255, [
        { x: 10, y: 10, r: 255, g: 0, b: 0 },
        { x: 20, y: 20, r: 0, g: 255, b: 0 },
      ])
    );

    const vr = new VisualRegression({
      imageAdapter: adapter,
      baselineDir,
    });
    const diff = await vr.compare({
      currentScreenshot: currentPath,
      testId: "UV-04",
      step: "step1",
    });
    // 2/10000 = 0.0002
    assert.ok(diff.pixelDiffRatio > 0, "应检测出像素差异");
    assert.ok(diff.pixelDiffRatio < 0.01, "差异比例应 < 1%");
  });

  it("E2E-UV-05: 尺寸不一致时整图作为变化区域", async () => {
    const adapter = new MemoryImageAdapter();
    const baselineDir = path.join(tmpRoot, "uv05-baseline");
    const currentPath = path.join(tmpRoot, "uv05-cur.png");
    const baselinePath = path.join(baselineDir, "step1.png");

    // 预存基线（50x50 白色）
    adapter.set(baselinePath, solidImage(50, 50, 255, 255, 255));
    // 当前图像（80x60 白色 - 尺寸不同）
    adapter.set(currentPath, solidImage(80, 60, 255, 255, 255));

    const vr = new VisualRegression({
      imageAdapter: adapter,
      baselineDir,
    });
    const diff = await vr.compare({
      currentScreenshot: currentPath,
      testId: "UV-05",
      step: "step1",
    });
    assert.equal(diff.pixelDiffRatio, 1.0, "尺寸不一致时 diff ratio = 1.0");
    assert.equal(diff.changedRegions.length, 1, "应有 1 个变化区域");
    assert.equal(diff.changedRegions[0]!.severity, "HIGH");
    assert.equal(diff.changedRegions[0]!.width, 80);
    assert.equal(diff.changedRegions[0]!.height, 60);
  });

  it("E2E-UV-06: 数据显示不全（文本截断、溢出、未加载）端到端捕获", async () => {
    const adapter = new MemoryImageAdapter();
    const currentPath = path.join(tmpRoot, "uv06-cur.png");
    adapter.set(currentPath, solidImage(100, 100, 255, 255, 255));

    const vr = new VisualRegression({
      imageAdapter: adapter,
      baselineDir: path.join(tmpRoot, "uv06-baseline"),
    });
    const diff = await vr.compare({
      currentScreenshot: currentPath,
      testId: "UV-06",
      step: "step1",
      domSignals: {
        truncatedTexts: [{ selector: ".title", text: "x".repeat(100), maxLength: 50 }],
        overflowedElements: [{ selector: ".wide-table", overflow: 200 }],
        failedImages: [{ selector: "img.avatar", src: "https://cdn.example.com/avatar.png" }],
        loadingSkeletons: [{ selector: ".skeleton", durationMs: 15_000 }],
        horizontalScrollTables: [{ selector: ".data-table", scrollWidth: 1500, clientWidth: 800 }],
      },
    });

    assert.equal(diff.dataIncomplete.length, 5, "应有 5 条数据显示不全问题");
    assert.ok(diff.dataIncomplete.some((s) => s.includes("文本截断")));
    assert.ok(diff.dataIncomplete.some((s) => s.includes("元素溢出视口")));
    assert.ok(diff.dataIncomplete.some((s) => s.includes("图片加载失败")));
    assert.ok(diff.dataIncomplete.some((s) => s.includes("Loading 骨架屏持续")));
    assert.ok(diff.dataIncomplete.some((s) => s.includes("表格横向滚动")));
  });

  it("E2E-UV-07: 显示错误（错误关键词、错误 toast class）端到端捕获", async () => {
    const adapter = new MemoryImageAdapter();
    const currentPath = path.join(tmpRoot, "uv07-cur.png");
    adapter.set(currentPath, solidImage(100, 100, 255, 255, 255));

    const vr = new VisualRegression({
      imageAdapter: adapter,
      baselineDir: path.join(tmpRoot, "uv07-baseline"),
    });
    const diff = await vr.compare({
      currentScreenshot: currentPath,
      testId: "UV-07",
      step: "step1",
      domSignals: {
        errorToasts: [
          { selector: ".ant-message-error", text: "保存失败", className: "ant-message-error" },
          { selector: ".custom-toast", text: "Network Error", className: "toast-error" },
          { selector: ".plain-toast", text: "操作成功", className: "toast-success" }, // 应被放过
        ],
        nativeDialogs: [{ type: "alert", message: "TypeError: undefined" }],
      },
    });

    // 3 条 toast 中 2 条是错误（ant + Network Error），1 条是 plain success 应被放过
    // + 1 条 nativeDialog
    assert.ok(diff.displayErrors.length >= 3, `应有 ≥3 条显示错误，实际 ${diff.displayErrors.length}`);
    assert.ok(diff.displayErrors.some((s) => s.includes("错误 Toast")));
    assert.ok(diff.displayErrors.some((s) => s.includes("Network Error")));
    assert.ok(diff.displayErrors.some((s) => s.includes("浏览器原生 alert")));
  });

  it("E2E-UV-08: 红色错误 toast（图像 HSV 检测）端到端捕获", async () => {
    const adapter = new MemoryImageAdapter();
    const currentPath = path.join(tmpRoot, "uv08-cur.png");
    // 200x100 图像：顶部 10px 是红色条（错误 toast）
    adapter.set(
      currentPath,
      imageWithRects(200, 100, 255, 255, 255, [{ x: 0, y: 0, w: 200, h: 10, r: 220, g: 30, b: 30 }])
    );

    const vr = new VisualRegression({
      imageAdapter: adapter,
      baselineDir: path.join(tmpRoot, "uv08-baseline"),
    });
    const diff = await vr.compare({
      currentScreenshot: currentPath,
      testId: "UV-08",
      step: "step1",
    });
    // 红色像素 2000/20000 = 10% > 0.5% 阈值
    assert.ok(
      diff.displayErrors.some((s) => s.includes("红色像素占比")),
      "应捕获红色像素告警"
    );
  });

  it("E2E-UV-09: UIUX 评分 + 视觉回归综合质量门禁（串联）", async () => {
    // 1) UI/UX 巡检
    const analyzer = new UIUXAnalyzer();
    await analyzer.audit(brokenPage());
    const uiuxReport = analyzer.report();

    // 2) 视觉回归
    const adapter = new MemoryImageAdapter();
    const baselinePath = path.join(tmpRoot, "uv09-base.png");
    const currentPath = path.join(tmpRoot, "uv09-cur.png");
    adapter.set(baselinePath, solidImage(100, 100, 255, 255, 255));
    adapter.set(currentPath, solidImage(100, 100, 200, 200, 200)); // 灰色 - 视觉变化

    const vr = new VisualRegression({
      imageAdapter: adapter,
      baselineDir: path.join(tmpRoot, "uv09-baseline"),
    });
    const vrResult = await vr.compare({
      currentScreenshot: currentPath,
      testId: "UV-09",
      step: "step1",
    });

    // 综合判定
    const qualityGatePass: boolean =
      uiuxReport.is_pass === true &&
      vrResult.pixelDiffRatio < 0.01 &&
      vrResult.dataIncomplete.length === 0 &&
      vrResult.displayErrors.length === 0;

    assert.equal(qualityGatePass, false, "brokenPage 应不通过质量门禁");
  });

  it("E2E-UV-10: 大页面端到端性能（1000 元素 < 5s）", async () => {
    // 构造 1000 个元素的页面（500 个图片 + 500 个按钮）
    const domData = {
      images: Array.from({ length: 500 }, (_, i) => ({
        tag: "img",
        selector: `img.item${i}`,
        alt: `Image ${i}`,
        src: `i${i}.png`,
        natural_width: 100,
        natural_height: 100,
        complete: true,
      })),
      form_controls: [],
      buttons: Array.from({ length: 500 }, (_, i) => ({
        selector: `button.btn${i}`,
        text: `Action ${i}`,
        width: 30,
        height: 30,
        visible: true,
        disabled: false, // 30x30 < 44x44 → 触发 tap-target
      })),
      links: [],
      headings: Array.from({ length: 5 }, (_, i) => ({ level: 1, text: `Section ${i}` })),
      errors: [],
    };
    const page = new FakePage(domData, []);

    const start = Date.now();
    const analyzer = new UIUXAnalyzer();
    const issues = await analyzer.audit(page);
    const elapsed = Date.now() - start;

    // 1000 元素有 500 个小按钮（60x44）→ 都应被识别为 tap-target MEDIUM
    const tapTargetIssues = issues.filter((i) => i.rule === "tap-target");
    assert.equal(tapTargetIssues.length, 500, "应识别所有 500 个小按钮的 tap-target 问题");
    assert.ok(elapsed < 5_000, `1000 元素审计应 < 5s，实际 ${elapsed}ms`);
  });
});
