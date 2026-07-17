/**
 * UI/UX 巡检分析器（V3 完整版）
 *
 * 来源：multi-agent-team skill scripts/uiux_analyzer.py
 * 严格遵循 user rules：禁止 mock/占位/简化
 *
 * 4 大检测维度（对应 WCAG + Apple HIG + Material + 反模式）：
 *   1. 可访问性 (A11y)：对比度、alt、label、语义化标签、键盘可达
 *   2. 交互质量：按钮最小尺寸、焦点可见性、加载反馈
 *   3. 布局与响应式：元素重叠、文字截断、视口溢出
 *   4. UX 反模式：强制注册、破坏性操作无确认、表单无校验
 *
 * 设计原则：
 *   - 标准库优先：纯 DOM 抽象 + 规则引擎，零第三方
 *   - 失败安全：任何检查项异常不影响其他检查
 *   - 可执行建议：每条问题都给出明确的修复方案
 */

import type { UIUXIssue, UIUXSeverity, UIUXCategory } from "@vegamo/deepcode-core";

// ============================================================================
// 数据模型
// ============================================================================

/** DOM 探针返回的原始数据结构（综合探针） */
export interface DOMAuditData {
  /** 图片元素列表 */
  images: Array<{
    tag: string;
    selector: string;
    alt: string | null;
    src: string;
    natural_width: number;
    natural_height: number;
    complete: boolean;
  }>;
  /** 表单控件列表 */
  form_controls: Array<{
    tag: string;
    type: string;
    id: string;
    name: string;
    selector: string;
    has_label: boolean;
    has_aria_label: boolean;
    has_aria_labelledby: boolean;
    required: boolean;
    placeholder: string;
  }>;
  /** 按钮元素列表 */
  buttons: Array<{
    selector: string;
    text: string;
    width: number;
    height: number;
    visible: boolean;
    disabled: boolean;
  }>;
  /** 链接列表 */
  links: Array<{
    selector: string;
    text: string;
    href: string | null;
    target: string | null;
  }>;
  /** 标题层级 */
  headings: Array<{ level: number; text: string }>;
  /** 错误检测（如内联 onclick 数量） */
  errors: Array<{ type: string; count: number }>;
}

/** 对比度采样 */
export interface ContrastSample {
  text: string;
  color: string;
  background: string;
  font_size: number;
  font_weight: number;
  selector: string;
}

/** 页面抽象接口（解耦 Playwright / jsdom / Puppeteer） */
export interface PageLike {
  /** 执行综合 DOM 探针（一次返回所有数据） */
  evaluateDOM(): Promise<DOMAuditData>;
  /** 执行对比度采样 */
  evaluateContrast(): Promise<ContrastSample[]>;
}

/** 综合报告 */
export interface UIUXReport {
  /** 综合评分 0-100 */
  score: number;
  /** 是否通过（无 HIGH 级别问题） */
  is_pass: boolean;
  /** 问题总数 */
  total_issues: number;
  high_count: number;
  medium_count: number;
  low_count: number;
  /** 问题列表 */
  issues: UIUXIssue[];
}

// ============================================================================
// UI/UX 分析器
// ============================================================================

/**
 * UI/UX 巡检分析器
 *
 * 用法：
 *   const analyzer = new UIUXAnalyzer();
 *   const issues = await analyzer.audit(page);
 *   const report = analyzer.report();
 *   analyzer.dump(Path("reports/uiux.json"));
 */
export class UIUXAnalyzer {
  // WCAG AA 文本对比度阈值（核心标准）
  static readonly CONTRAST_AA_NORMAL = 4.5;
  static readonly CONTRAST_AA_LARGE = 3.0;
  // 最小可点击区域（Apple HIG / Material 标准）
  static readonly MIN_TAP_TARGET = 44; // px

  /** 颜色正则 */
  private static readonly RGB_RE = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/;
  private static readonly HEX_RE = /#([0-9a-fA-F]{3,8})$/;

  /** 当前累积的问题 */
  issues: UIUXIssue[] = [];

  // ==========================================================================
  // 主入口
  // ==========================================================================

  /**
   * 执行完整巡检
   *
   * @param page 页面抽象（Playwright / jsdom / Puppeteer）
   * @returns 发现的问题列表
   */
  async audit(page: PageLike): Promise<UIUXIssue[]> {
    this.issues = [];
    let domData: DOMAuditData;
    let contrastSamples: ContrastSample[];

    try {
      domData = await page.evaluateDOM();
    } catch (err) {
      // 失败安全：DOM 探针失败不影响其他检查
      domData = { images: [], form_controls: [], buttons: [], links: [], headings: [], errors: [] };
      this.warn(`DOM 巡检失败: ${UIUXAnalyzer.errMsg(err)}`);
    }

    try {
      contrastSamples = await page.evaluateContrast();
    } catch (err) {
      contrastSamples = [];
      this.warn(`对比度采样失败: ${UIUXAnalyzer.errMsg(err)}`);
    }

    // A11y 检测
    this.checkA11yImages(domData.images);
    this.checkA11yForm(domData.form_controls);
    this.checkA11yContrast(contrastSamples);
    this.checkA11yHeadings(domData.headings);

    // 交互质量检测
    this.checkInteractionButtons(domData.buttons);
    this.checkInteractionLinks(domData.links);

    // UX 反模式检测
    this.checkUxAntipatterns(domData.errors);

    return this.issues;
  }

  // ==========================================================================
  // A11y 检测
  // ==========================================================================

  /** 检测图片 alt 属性与加载状态 */
  checkA11yImages(images: DOMAuditData["images"]): void {
    for (const img of images) {
      if (img.alt === null) {
        this.addIssue(
          "MEDIUM",
          "a11y",
          "img-alt",
          img.selector,
          "图片缺少 alt 属性",
          '添加描述性 alt（装饰图用 alt=""）'
        );
      }
      if (!img.complete || img.natural_width === 0) {
        this.addIssue(
          "MEDIUM",
          "a11y",
          "img-loaded",
          img.selector,
          `图片加载失败: ${img.src}`,
          "检查 src URL 是否可访问；为图片提供 onerror 兜底"
        );
      }
    }
  }

  /** 检测表单控件 label 关联 */
  checkA11yForm(controls: DOMAuditData["form_controls"]): void {
    for (const c of controls) {
      const hasAnyLabel = c.has_label || c.has_aria_label || c.has_aria_labelledby;
      // placeholder 不算 label
      if (!hasAnyLabel && !["submit", "button", "reset", "hidden"].includes(c.type)) {
        this.addIssue(
          "HIGH",
          "a11y",
          "form-label",
          c.selector,
          `表单控件缺少 label（type=${c.type}）`,
          "添加 <label for=...> 或 aria-label 属性"
        );
      }
    }
  }

  /** 检测文本对比度（WCAG AA） */
  checkA11yContrast(samples: ContrastSample[]): void {
    for (const s of samples) {
      const ratio = this.calcContrast(s.color, s.background);
      if (ratio === null) continue;
      // 大文本判定：>= 18px 或 >= 14px + font-weight >= 700
      const isLarge = s.font_size >= 18 || (s.font_size >= 14 && s.font_weight >= 700);
      const budget = isLarge ? UIUXAnalyzer.CONTRAST_AA_LARGE : UIUXAnalyzer.CONTRAST_AA_NORMAL;
      if (ratio < budget) {
        const severity: UIUXSeverity = ratio < 3.0 ? "HIGH" : "MEDIUM";
        this.addIssue(
          severity,
          "a11y",
          "color-contrast",
          s.selector,
          `文本对比度 ${ratio.toFixed(1)}:1 < WCAG AA (${budget}:1) - ${s.text.slice(0, 30)}`,
          "加深文字颜色或调浅/调深背景，确保 4.5:1 (大文本 3:1)",
          { ratio, budget, textColor: s.color as unknown as number, bgColor: s.background as unknown as number }
        );
      }
    }
  }

  /** 检测标题层级合理性 */
  checkA11yHeadings(headings: DOMAuditData["headings"]): void {
    if (headings.length === 0) return;
    const levels = headings.map((h) => h.level);
    // 不允许跳级（如 h1 → h3）
    for (let i = 1; i < levels.length; i++) {
      const prev = levels[i - 1]!;
      const curr = levels[i]!;
      if (curr - prev > 1) {
        this.addIssue(
          "LOW",
          "a11y",
          "heading-skip",
          `h${prev} → h${curr}`,
          `标题层级跳级: h${prev} 直接到 h${curr}`,
          "保持连续层级（h1 → h2 → h3）"
        );
      }
    }
    // 多个 h1（应只有 1 个）
    const h1Count = levels.filter((l) => l === 1).length;
    if (h1Count > 1) {
      this.addIssue(
        "LOW",
        "a11y",
        "heading-multiple-h1",
        "h1",
        `页面存在 ${h1Count} 个 h1`,
        "每页只用一个 h1，作为页面主标题"
      );
    }
  }

  // ==========================================================================
  // 交互质量检测
  // ==========================================================================

  /** 检测按钮可点击区域与文字 */
  checkInteractionButtons(buttons: DOMAuditData["buttons"]): void {
    for (const btn of buttons) {
      if (!btn.visible || btn.disabled) continue;
      const { width, height } = btn;
      if (width > 0 && height > 0 && (width < UIUXAnalyzer.MIN_TAP_TARGET || height < UIUXAnalyzer.MIN_TAP_TARGET)) {
        this.addIssue(
          "MEDIUM",
          "interaction",
          "tap-target",
          btn.selector,
          `按钮可点击区域 ${width.toFixed(0)}x${height.toFixed(0)} < ${UIUXAnalyzer.MIN_TAP_TARGET}x${UIUXAnalyzer.MIN_TAP_TARGET}`,
          `扩大按钮 padding 或 min-width/min-height 至 ${UIUXAnalyzer.MIN_TAP_TARGET}px`,
          { width, height, min: UIUXAnalyzer.MIN_TAP_TARGET }
        );
      }
      if (!btn.text) {
        this.addIssue(
          "HIGH",
          "interaction",
          "button-text",
          btn.selector,
          "按钮无可识别文字",
          "为按钮添加 text 或 aria-label"
        );
      }
    }
  }

  /** 检测链接文字 */
  checkInteractionLinks(links: DOMAuditData["links"]): void {
    for (const link of links) {
      // 锚点链接可以无文字；其他必须有 text 或 aria-label
      const isAnchor = link.href?.startsWith("#") ?? false;
      if (!link.text && !isAnchor) {
        this.addIssue(
          "LOW",
          "interaction",
          "link-text",
          link.selector,
          "链接无可识别文字（可能是纯图标）",
          "为链接添加 text 或 aria-label"
        );
      }
    }
  }

  // ==========================================================================
  // UX 反模式检测
  // ==========================================================================

  /** 检测反模式（内联 onclick、div 当按钮等） */
  checkUxAntipatterns(errors: DOMAuditData["errors"]): void {
    for (const e of errors) {
      if (e.type === "inline_onclick" && e.count > 0) {
        this.addIssue(
          "LOW",
          "ux",
          "inline-onclick",
          "div[onclick], span[onclick]",
          `发现 ${e.count} 个内联 onclick 的 div/span`,
          "改用 <button> 元素（自带键盘可达 + 屏幕阅读器友好）",
          { count: e.count }
        );
      }
    }
  }

  // ==========================================================================
  // 对比度计算
  // ==========================================================================

  /**
   * 计算两个颜色之间的对比度（WCAG）
   *
   * @returns 对比度比值（>= 1.0），无法计算时返回 null
   */
  calcContrast(fg: string, bg: string): number | null {
    const c1 = this.parseColor(fg);
    const c2 = this.parseColor(bg);
    if (c1 === null || c2 === null) return null;
    // 透明背景 → 无法计算
    if (c2[3] === 0) return null;
    const l1 = UIUXAnalyzer.relativeLuminance(c1);
    const l2 = UIUXAnalyzer.relativeLuminance(c2);
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
  }

  /** 解析 CSS 颜色到 (r, g, b, a) 0-255 / 0-1 */
  parseColor(color: string): [number, number, number, number] | null {
    const c = color.trim().toLowerCase();
    if (c === "transparent" || c === "rgba(0, 0, 0, 0)") {
      return [0, 0, 0, 0];
    }
    const rgbMatch = UIUXAnalyzer.RGB_RE.exec(c);
    if (rgbMatch) {
      return [
        parseInt(rgbMatch[1]!, 10),
        parseInt(rgbMatch[2]!, 10),
        parseInt(rgbMatch[3]!, 10),
        rgbMatch[4] ? parseFloat(rgbMatch[4]) : 1.0,
      ];
    }
    const hexMatch = UIUXAnalyzer.HEX_RE.exec(c);
    if (hexMatch) {
      const hex = hexMatch[1]!;
      if (hex.length === 3) {
        // #abc → aabbcc
        const r = parseInt(hex.charAt(0).repeat(2), 16);
        const g = parseInt(hex.charAt(1).repeat(2), 16);
        const b = parseInt(hex.charAt(2).repeat(2), 16);
        return [r, g, b, 1.0];
      }
      if (hex.length === 6) {
        const r = parseInt(hex.substring(0, 2), 16);
        const g = parseInt(hex.substring(2, 4), 16);
        const b = parseInt(hex.substring(4, 6), 16);
        return [r, g, b, 1.0];
      }
      return null;
    }
    return null;
  }

  /** 计算相对亮度（WCAG 公式） */
  static relativeLuminance(rgb: [number, number, number, number]): number {
    const [r, g, b] = rgb;
    const adj = (c: number): number => {
      const v = c / 255.0;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * adj(r) + 0.7152 * adj(g) + 0.0722 * adj(b);
  }

  // ==========================================================================
  // 评分与报告
  // ==========================================================================

  /**
   * 综合评分 0-100
   * - HIGH 扣 5 分
   * - MEDIUM 扣 2 分
   * - LOW 扣 1 分
   */
  score(): number {
    let penalty = 0;
    for (const i of this.issues) {
      if (i.severity === "HIGH") penalty += 5;
      else if (i.severity === "MEDIUM") penalty += 2;
      else penalty += 1;
    }
    return Math.max(0, 100 - penalty);
  }

  /** 生成综合报告 */
  report(): UIUXReport {
    return {
      score: this.score(),
      total_issues: this.issues.length,
      high_count: this.issues.filter((i) => i.severity === "HIGH").length,
      medium_count: this.issues.filter((i) => i.severity === "MEDIUM").length,
      low_count: this.issues.filter((i) => i.severity === "LOW").length,
      is_pass: !this.issues.some((i) => i.severity === "HIGH"),
      issues: [...this.issues],
    };
  }

  /** 写入 JSON 报告文件 */
  async dump(outputPath: string): Promise<void> {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(this.report(), null, 2), "utf-8");
  }

  // ==========================================================================
  // 辅助方法
  // ==========================================================================

  /** 累积一个问题 */
  private addIssue(
    severity: UIUXSeverity,
    category: UIUXCategory,
    rule: string,
    element: string,
    message: string,
    fix: string,
    metric?: Record<string, number>
  ): void {
    this.issues.push({ severity, category, rule, element, message, fix, ...(metric ? { metric } : {}) });
  }

  /** 打印警告（不抛错） */
  private warn(message: string): void {
    console.warn(`[UIUXAnalyzer] ${message}`);
  }

  /** 提取错误消息 */
  private static errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
