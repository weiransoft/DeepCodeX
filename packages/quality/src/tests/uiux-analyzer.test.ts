/**
 * UIUXAnalyzer 单元测试
 *
 * 覆盖：4 大检测维度（a11y / interaction / ux antipatterns）+ 评分 + 报告
 *
 * 严格遵循 user rules：不使用 mock，所有测试基于真实规则与样本数据
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { UIUXAnalyzer } from "../uiux-analyzer.js";
import type { PageLike, DOMAuditData, ContrastSample } from "../uiux-analyzer.js";

/** 测试用 PageLike 实现（不依赖 Playwright） */
class FakePage implements PageLike {
  constructor(
    private readonly domData: DOMAuditData,
    private readonly contrastSamples: ContrastSample[],
    private readonly domShouldFail: boolean = false,
    private readonly contrastShouldFail: boolean = false
  ) {}

  async evaluateDOM(): Promise<DOMAuditData> {
    if (this.domShouldFail) throw new Error("DOM evaluate failed");
    return this.domData;
  }

  async evaluateContrast(): Promise<ContrastSample[]> {
    if (this.contrastShouldFail) throw new Error("contrast evaluate failed");
    return this.contrastSamples;
  }
}

describe("UIUXAnalyzer", () => {
  describe("A11y 检测", () => {
    it("应检测缺少 alt 属性的图片", async () => {
      const analyzer = new UIUXAnalyzer();
      const page = new FakePage(
        {
          images: [
            {
              tag: "img",
              selector: "img.banner",
              alt: null,
              src: "a.png",
              natural_width: 100,
              natural_height: 100,
              complete: true,
            },
          ],
          form_controls: [],
          buttons: [],
          links: [],
          headings: [],
          errors: [],
        },
        []
      );
      const issues = await analyzer.audit(page);
      const imgAlt = issues.find((i) => i.rule === "img-alt");
      assert.ok(imgAlt, "应包含 img-alt 规则的问题");
      assert.equal(imgAlt!.severity, "MEDIUM");
      assert.equal(imgAlt!.category, "a11y");
      assert.equal(imgAlt!.element, "img.banner");
    });

    it("应检测加载失败的图片 (naturalWidth=0)", async () => {
      const analyzer = new UIUXAnalyzer();
      const page = new FakePage(
        {
          images: [
            {
              tag: "img",
              selector: "img.broken",
              alt: "x",
              src: "x.png",
              natural_width: 0,
              natural_height: 0,
              complete: false,
            },
          ],
          form_controls: [],
          buttons: [],
          links: [],
          headings: [],
          errors: [],
        },
        []
      );
      const issues = await analyzer.audit(page);
      const imgLoaded = issues.find((i) => i.rule === "img-loaded");
      assert.ok(imgLoaded, "应包含 img-loaded 规则");
      assert.match(imgLoaded!.message, /图片加载失败/);
    });

    it("应检测缺少 label 的表单控件", async () => {
      const analyzer = new UIUXAnalyzer();
      const page = new FakePage(
        {
          images: [],
          form_controls: [
            {
              tag: "input",
              type: "text",
              id: "email",
              name: "email",
              selector: "input#email",
              has_label: false,
              has_aria_label: false,
              has_aria_labelledby: false,
              required: true,
              placeholder: "请输入邮箱",
            },
          ],
          buttons: [],
          links: [],
          headings: [],
          errors: [],
        },
        []
      );
      const issues = await analyzer.audit(page);
      const label = issues.find((i) => i.rule === "form-label");
      assert.ok(label);
      assert.equal(label!.severity, "HIGH");
    });

    it("应放过已有 label 的表单控件", async () => {
      const analyzer = new UIUXAnalyzer();
      const page = new FakePage(
        {
          images: [],
          form_controls: [
            {
              tag: "input",
              type: "text",
              id: "ok",
              name: "ok",
              selector: "input#ok",
              has_label: true,
              has_aria_label: false,
              has_aria_labelledby: false,
              required: false,
              placeholder: "",
            },
          ],
          buttons: [],
          links: [],
          headings: [],
          errors: [],
        },
        []
      );
      const issues = await analyzer.audit(page);
      assert.equal(
        issues.find((i) => i.rule === "form-label"),
        undefined
      );
    });

    it("应放过 submit 按钮（无需 label）", async () => {
      const analyzer = new UIUXAnalyzer();
      const page = new FakePage(
        {
          images: [],
          form_controls: [
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
          buttons: [],
          links: [],
          headings: [],
          errors: [],
        },
        []
      );
      const issues = await analyzer.audit(page);
      assert.equal(
        issues.find((i) => i.rule === "form-label"),
        undefined
      );
    });

    it("应检测文本对比度不足（低对比度）", async () => {
      const analyzer = new UIUXAnalyzer();
      const page = new FakePage({ images: [], form_controls: [], buttons: [], links: [], headings: [], errors: [] }, [
        { text: "hello", color: "#cccccc", background: "#dddddd", font_size: 14, font_weight: 400, selector: "p" },
      ]);
      const issues = await analyzer.audit(page);
      const contrast = issues.find((i) => i.rule === "color-contrast");
      assert.ok(contrast, "应检测出对比度问题");
      assert.equal(contrast!.category, "a11y");
      assert.match(contrast!.message, /WCAG AA/);
      assert.ok(contrast!.metric);
      assert.ok((contrast!.metric as Record<string, number>).ratio! < 4.5);
    });

    it("应放过大字体低对比度（按大文本标准 3:1）", async () => {
      const analyzer = new UIUXAnalyzer();
      const page = new FakePage({ images: [], form_controls: [], buttons: [], links: [], headings: [], errors: [] }, [
        { text: "hello", color: "#888888", background: "#ffffff", font_size: 24, font_weight: 400, selector: "h2" },
      ]);
      const issues = await analyzer.audit(page);
      // 24px 大文本 + #888/#fff 对比度约 5.9:1，应该通过
      assert.equal(
        issues.find((i) => i.rule === "color-contrast"),
        undefined
      );
    });

    it("应检测标题跳级（h1→h3）", async () => {
      const analyzer = new UIUXAnalyzer();
      const page = new FakePage(
        {
          images: [],
          form_controls: [],
          buttons: [],
          links: [],
          headings: [
            { level: 1, text: "A" },
            { level: 3, text: "B" },
          ],
          errors: [],
        },
        []
      );
      const issues = await analyzer.audit(page);
      const skip = issues.find((i) => i.rule === "heading-skip");
      assert.ok(skip);
      assert.equal(skip!.severity, "LOW");
      assert.match(skip!.message, /跳级/);
    });

    it("应检测多个 h1", async () => {
      const analyzer = new UIUXAnalyzer();
      const page = new FakePage(
        {
          images: [],
          form_controls: [],
          buttons: [],
          links: [],
          headings: [
            { level: 1, text: "A" },
            { level: 1, text: "B" },
          ],
          errors: [],
        },
        []
      );
      const issues = await analyzer.audit(page);
      const multi = issues.find((i) => i.rule === "heading-multiple-h1");
      assert.ok(multi);
      assert.equal(multi!.severity, "LOW");
    });
  });

  describe("交互质量检测", () => {
    it("应放过足够大的按钮", async () => {
      const analyzer = new UIUXAnalyzer();
      const page = new FakePage(
        {
          images: [],
          form_controls: [],
          buttons: [{ selector: "button.ok", text: "OK", width: 100, height: 44, visible: true, disabled: false }],
          links: [],
          headings: [],
          errors: [],
        },
        []
      );
      const issues = await analyzer.audit(page);
      assert.equal(
        issues.find((i) => i.rule === "tap-target"),
        undefined
      );
    });

    it("应放过 disabled 按钮（不需要大尺寸）", async () => {
      const analyzer = new UIUXAnalyzer();
      const page = new FakePage(
        {
          images: [],
          form_controls: [],
          buttons: [{ selector: "button.dis", text: "x", width: 20, height: 20, visible: true, disabled: true }],
          links: [],
          headings: [],
          errors: [],
        },
        []
      );
      const issues = await analyzer.audit(page);
      assert.equal(
        issues.find((i) => i.rule === "tap-target"),
        undefined
      );
    });

    it("应放过宽度 = 0 的按钮（视为不可见）", async () => {
      const analyzer = new UIUXAnalyzer();
      const page = new FakePage(
        {
          images: [],
          form_controls: [],
          buttons: [{ selector: "button.hidden", text: "x", width: 0, height: 0, visible: false, disabled: false }],
          links: [],
          headings: [],
          errors: [],
        },
        []
      );
      const issues = await analyzer.audit(page);
      assert.equal(
        issues.find((i) => i.rule === "tap-target"),
        undefined
      );
    });

    it("应检测无文字的按钮", async () => {
      const analyzer = new UIUXAnalyzer();
      const page = new FakePage(
        {
          images: [],
          form_controls: [],
          buttons: [{ selector: "button.empty", text: "", width: 100, height: 44, visible: true, disabled: false }],
          links: [],
          headings: [],
          errors: [],
        },
        []
      );
      const issues = await analyzer.audit(page);
      const noText = issues.find((i) => i.rule === "button-text");
      assert.ok(noText);
      assert.equal(noText!.severity, "HIGH");
    });

    it("应放过锚点链接（无 text）", async () => {
      const analyzer = new UIUXAnalyzer();
      const page = new FakePage(
        {
          images: [],
          form_controls: [],
          buttons: [],
          links: [{ selector: "a.top", text: "", href: "#top", target: null }],
          headings: [],
          errors: [],
        },
        []
      );
      const issues = await analyzer.audit(page);
      assert.equal(
        issues.find((i) => i.rule === "link-text"),
        undefined
      );
    });
  });

  describe("UX 反模式检测", () => {
    it("应检测 div+onclick 反模式", async () => {
      const analyzer = new UIUXAnalyzer();
      const page = new FakePage(
        {
          images: [],
          form_controls: [],
          buttons: [],
          links: [],
          headings: [],
          errors: [{ type: "inline_onclick", count: 3 }],
        },
        []
      );
      const issues = await analyzer.audit(page);
      const antip = issues.find((i) => i.rule === "inline-onclick");
      assert.ok(antip);
      assert.match(antip!.message, /3 个/);
    });

    it("应放过 count=0 的内联 onclick", async () => {
      const analyzer = new UIUXAnalyzer();
      const page = new FakePage(
        {
          images: [],
          form_controls: [],
          buttons: [],
          links: [],
          headings: [],
          errors: [{ type: "inline_onclick", count: 0 }],
        },
        []
      );
      const issues = await analyzer.audit(page);
      assert.equal(
        issues.find((i) => i.rule === "inline-onclick"),
        undefined
      );
    });
  });

  describe("对比度计算", () => {
    it("应正确计算白底黑字对比度（21:1）", () => {
      const analyzer = new UIUXAnalyzer();
      const ratio = analyzer.calcContrast("rgb(0, 0, 0)", "rgb(255, 255, 255)");
      assert.ok(ratio !== null);
      // WCAG 公式：(1 + 0.05) / (0 + 0.05) = 21
      assert.ok(Math.abs(ratio! - 21) < 0.5);
    });

    it("应正确解析 #ffffff 十六进制颜色", () => {
      const analyzer = new UIUXAnalyzer();
      const result = analyzer.parseColor("#ffffff");
      assert.deepEqual(result, [255, 255, 255, 1.0]);
    });

    it("应正确解析 #abc 短格式十六进制", () => {
      const analyzer = new UIUXAnalyzer();
      const result = analyzer.parseColor("#abc");
      assert.deepEqual(result, [0xaa, 0xbb, 0xcc, 1.0]);
    });

    it("应正确解析 rgba(r, g, b, a)", () => {
      const analyzer = new UIUXAnalyzer();
      const result = analyzer.parseColor("rgba(100, 150, 200, 0.8)");
      assert.deepEqual(result, [100, 150, 200, 0.8]);
    });

    it("应放过透明背景对比度计算", () => {
      const analyzer = new UIUXAnalyzer();
      const ratio = analyzer.calcContrast("rgb(0,0,0)", "rgba(0,0,0,0)");
      assert.equal(ratio, null);
    });

    it("应放过无法解析的颜色", () => {
      const analyzer = new UIUXAnalyzer();
      assert.equal(analyzer.calcContrast("not-a-color", "#fff"), null);
    });
  });

  describe("评分与报告", () => {
    it("无问题时 score = 100, is_pass = true", () => {
      const analyzer = new UIUXAnalyzer();
      const report = analyzer.report();
      assert.equal(report.score, 100);
      assert.equal(report.is_pass, true);
      assert.equal(report.total_issues, 0);
    });

    it("HIGH 扣 5 分", () => {
      const analyzer = new UIUXAnalyzer();
      analyzer.issues.push({
        category: "a11y",
        severity: "HIGH",
        rule: "x",
        element: "y",
        message: "z",
        fix: "f",
      });
      assert.equal(analyzer.score(), 95);
    });

    it("MEDIUM 扣 2 分", () => {
      const analyzer = new UIUXAnalyzer();
      analyzer.issues.push({
        category: "a11y",
        severity: "MEDIUM",
        rule: "x",
        element: "y",
        message: "z",
        fix: "f",
      });
      assert.equal(analyzer.score(), 98);
    });

    it("LOW 扣 1 分", () => {
      const analyzer = new UIUXAnalyzer();
      analyzer.issues.push({
        category: "ux",
        severity: "LOW",
        rule: "x",
        element: "y",
        message: "z",
        fix: "f",
      });
      assert.equal(analyzer.score(), 99);
    });

    it("is_pass 在有 HIGH 问题时为 false", () => {
      const analyzer = new UIUXAnalyzer();
      analyzer.issues.push({
        category: "a11y",
        severity: "HIGH",
        rule: "x",
        element: "y",
        message: "z",
        fix: "f",
      });
      assert.equal(analyzer.report().is_pass, false);
    });

    it("分项计数应正确", () => {
      const analyzer = new UIUXAnalyzer();
      analyzer.issues.push(
        { category: "a11y", severity: "HIGH", rule: "a", element: "x", message: "m", fix: "f" },
        { category: "a11y", severity: "MEDIUM", rule: "b", element: "x", message: "m", fix: "f" },
        { category: "ux", severity: "LOW", rule: "c", element: "x", message: "m", fix: "f" }
      );
      const report = analyzer.report();
      assert.equal(report.high_count, 1);
      assert.equal(report.medium_count, 1);
      assert.equal(report.low_count, 1);
    });
  });

  describe("失败安全", () => {
    it("DOM 探针失败时不影响其他检查", async () => {
      const analyzer = new UIUXAnalyzer();
      const page = new FakePage(
        { images: [], form_controls: [], buttons: [], links: [], headings: [], errors: [] },
        [{ text: "x", color: "#fff", background: "#fff", font_size: 14, font_weight: 400, selector: "p" }],
        true // DOM 失败
      );
      const issues = await analyzer.audit(page);
      // 对比度检查仍然执行
      assert.ok(issues.find((i) => i.rule === "color-contrast"));
    });

    it("对比度采样失败时不影响其他检查", async () => {
      const analyzer = new UIUXAnalyzer();
      const page = new FakePage(
        {
          images: [
            { tag: "img", selector: "i", alt: null, src: "a", natural_width: 1, natural_height: 1, complete: true },
          ],
          form_controls: [],
          buttons: [],
          links: [],
          headings: [],
          errors: [],
        },
        [],
        false,
        true // 对比度失败
      );
      const issues = await analyzer.audit(page);
      // img-alt 检查仍然执行
      assert.ok(issues.find((i) => i.rule === "img-alt"));
    });
  });

  describe("WCAG 阈值常量", () => {
    it("AA_NORMAL 应为 4.5", () => {
      assert.equal(UIUXAnalyzer.CONTRAST_AA_NORMAL, 4.5);
    });
    it("AA_LARGE 应为 3.0", () => {
      assert.equal(UIUXAnalyzer.CONTRAST_AA_LARGE, 3.0);
    });
    it("MIN_TAP_TARGET 应为 44", () => {
      assert.equal(UIUXAnalyzer.MIN_TAP_TARGET, 44);
    });
  });
});
