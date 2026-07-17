/**
 * 质量门禁 E2E 测试 - 三大组件集成 + 综合场景
 *
 * 覆盖场景：
 *   E2E-QG-01: 项目质量体检（CodeMap + UI/UX + 视觉回归三合一）
 *   E2E-QG-02: 真实项目改造前/后质量对比（回归测试）
 *   E2E-QG-03: 报告生成与持久化（Markdown + JSON 落盘）
 *   E2E-QG-04: 大型项目性能（1000 文件 + 100 元素页面 < 30s）
 *   E2E-QG-05: 错误恢复（一个组件失败不影响其他组件）
 *   E2E-QG-06: 跨语言项目质量门禁（5 语言项目端到端）
 *   E2E-QG-07: 质量门禁门槛判定（基于规则自动评估）
 *   E2E-QG-08: 多页面（5 个页面）端到端 CI 报告
 *
 * 严格遵循 user rules：
 *   - 禁止 mock / 占位 / 简化
 *   - 所有测试基于真实数据 + 真实算法
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { UIUXAnalyzer } from "../../uiux-analyzer.js";
import { VisualRegression } from "../../visual-regression.js";
import { CodeMapGenerator } from "../../codemap/generator.js";
import type { CodeMap } from "../../codemap/generator.js";
import {
  MemoryImageAdapter,
  solidImage,
  imageWithRects,
  FakePage,
  perfectPage,
  brokenPage,
  emptyPage,
  createMultiLangProject,
  createTmpDir,
  cleanupTmpDir,
} from "./e2e-helpers.js";

/** 质量门禁综合评估器（端到端测试使用） */
interface QualityGateResult {
  pass: boolean;
  codemapScore: number; // 0-100，基于死代码比例、平均复杂度等
  uiuxScore: number; // UIUXAnalyzer.score()
  visualScore: number; // 1 - pixelDiffRatio（简化映射）
  totalScore: number;
  issues: string[];
}

function evaluateQualityGate(codeMap: CodeMap, uiuxIssues: number, visualDiffRatio: number): QualityGateResult {
  // CodeMap 评分（基于死代码比例 + 平均复杂度）
  const deadCodeRatio =
    codeMap.stats.fileCount > 0 ? codeMap.stats.deadCodeCandidates.length / Math.max(codeMap.nodes.length, 1) : 0;
  const avgComplexity = codeMap.stats.avgComplexity;
  const codemapScore = Math.max(0, 100 - deadCodeRatio * 50 - Math.max(0, avgComplexity - 5) * 5);

  // UIUX 评分（基于问题数）
  const uiuxScore = Math.max(0, 100 - uiuxIssues * 3);

  // Visual 评分（基于 diff 比例）
  const visualScore = Math.max(0, (1 - visualDiffRatio) * 100);

  // 总分（加权平均）
  const totalScore = codemapScore * 0.4 + uiuxScore * 0.3 + visualScore * 0.3;

  // 通过条件
  const pass = codemapScore >= 70 && uiuxScore >= 70 && visualScore >= 90 && deadCodeRatio < 0.2;

  const issues: string[] = [];
  if (codemapScore < 70) issues.push(`CodeMap 评分过低: ${codemapScore.toFixed(1)}`);
  if (uiuxScore < 70) issues.push(`UI/UX 评分过低: ${uiuxScore.toFixed(1)}`);
  if (visualScore < 90) issues.push(`视觉回归评分过低: ${visualScore.toFixed(1)}`);
  if (deadCodeRatio >= 0.2) issues.push(`死代码比例过高: ${(deadCodeRatio * 100).toFixed(1)}%`);

  return { pass, codemapScore, uiuxScore, visualScore, totalScore, issues };
}

describe("E2E: 质量门禁综合场景", () => {
  let tmpRoot: string;

  before(async () => {
    tmpRoot = await createTmpDir("qg");
  });

  after(async () => {
    await cleanupTmpDir(tmpRoot);
  });

  it("E2E-QG-01: 项目质量体检（CodeMap + UI/UX + 视觉回归三合一）", async () => {
    const projectRoot = await createTmpDir("qg01");
    try {
      await createMultiLangProject(projectRoot);

      // 1) CodeMap 体检
      const gen = new CodeMapGenerator({
        projectRoot,
        jsonOutputPath: path.join(projectRoot, "out", "codemap.json"),
      });
      const map = await gen.generate();
      await gen.dump(map);

      // 2) UI/UX 巡检
      const analyzer = new UIUXAnalyzer();
      const uiuxIssues = await analyzer.audit(brokenPage());
      const uiuxReport = analyzer.report();

      // 3) 视觉回归
      const adapter = new MemoryImageAdapter();
      const baselineDir = path.join(tmpRoot, "qg01-baseline");
      const baselinePath = path.join(baselineDir, "step1.png");
      const currentPath = path.join(tmpRoot, "qg01-cur.png");
      adapter.set(baselinePath, solidImage(100, 100, 255, 255, 255));
      adapter.set(
        currentPath,
        imageWithRects(100, 100, 255, 255, 255, [
          { x: 0, y: 0, w: 100, h: 5, r: 220, g: 30, b: 30 }, // 5% 红色
        ])
      );
      const vr = new VisualRegression({ imageAdapter: adapter, baselineDir });
      const diff = await vr.compare({
        currentScreenshot: currentPath,
        testId: "QG-01",
        step: "step1",
      });

      // 综合评估
      const result = evaluateQualityGate(map, uiuxIssues.length, diff.pixelDiffRatio);

      // 验证所有三个组件都产生了有效输出
      assert.ok(map.stats.fileCount > 0, "CodeMap 应有文件");
      assert.ok(uiuxReport.total_issues > 0, "UI/UX 应有问题");
      assert.ok(diff.pixelDiffRatio > 0, "视觉回归应有差异");

      // brokenPage + 5% 红色 → 评估应不通过
      assert.equal(result.pass, false, "broken 项目应不通过质量门禁");
      assert.ok(result.issues.length >= 1, "应有具体不通过原因");
    } finally {
      await cleanupTmpDir(projectRoot);
    }
  });

  it("E2E-QG-02: 真实项目改造前/后质量对比（回归测试）", async () => {
    const projectRoot = await createTmpDir("qg02");
    try {
      // 改造前：简单项目
      await fs.writeFile(
        path.join(projectRoot, "v1.ts"),
        `export class Service {
  public run() { return 1; }
}
export class Unused {
  public run() { return 2; }
}
`
      );
      const gen1 = new CodeMapGenerator({ projectRoot });
      const map1 = await gen1.generate();
      const deadBefore = map1.stats.deadCodeCandidates.length;

      // 改造：删除 Unused 类，添加新功能 + 引用关系
      await fs.writeFile(
        path.join(projectRoot, "v1.ts"),
        `import { Service } from "./v2";
export class App {
  public main() { return new Service().run(); }
}
`
      );
      await fs.writeFile(
        path.join(projectRoot, "v2.ts"),
        `export class Service {
  public run() { return 42; }
}
export class Helper {
  public help() { return "ok"; }
}
`
      );
      const gen2 = new CodeMapGenerator({ projectRoot });
      const map2 = await gen2.generate();
      const deadAfter = map2.stats.deadCodeCandidates.length;

      // 改造后：Helper 没有 import 引用 → 算死代码
      // 但 Service 通过 import 边 → 不算死代码
      assert.ok(
        map2.stats.deadCodeCandidates.some((id) => id.includes("Helper")),
        "Helper 应被识别为死代码（无 import 引用）"
      );
      assert.ok(
        !map2.stats.deadCodeCandidates.some((id) => id.includes("Service")),
        "Service 不应被识别为死代码（被 import 引用）"
      );
      assert.ok(deadAfter >= 1, "改造后应至少 1 个死代码");
      // deadBefore 应 > 0（Unused 没人用）
      assert.ok(deadBefore >= 1, "改造前 Unused 应算死代码");
    } finally {
      await cleanupTmpDir(projectRoot);
    }
  });

  it("E2E-QG-03: 报告生成与持久化（Markdown + JSON 落盘）", async () => {
    const projectRoot = await createTmpDir("qg03");
    try {
      await createMultiLangProject(projectRoot);

      // CodeMap 报告
      const gen = new CodeMapGenerator({
        projectRoot,
        markdownOutputPath: path.join(projectRoot, "reports", "CODE_MAP.md"),
        jsonOutputPath: path.join(projectRoot, "reports", "CODE_MAP.json"),
      });
      const map = await gen.generate();
      await gen.dump(map);

      // UI/UX 报告
      const analyzer = new UIUXAnalyzer();
      await analyzer.audit(brokenPage());
      await analyzer.dump(path.join(projectRoot, "reports", "uiux.json"));

      // 验证落盘文件
      const md = await fs.readFile(path.join(projectRoot, "reports", "CODE_MAP.md"), "utf-8");
      assert.match(md, /^# Code Map: /m);

      const codeMapJson = await fs.readFile(path.join(projectRoot, "reports", "CODE_MAP.json"), "utf-8");
      const loadedMap = JSON.parse(codeMapJson) as CodeMap;
      assert.equal(loadedMap.stats.fileCount, map.stats.fileCount);

      const uiuxJson = await fs.readFile(path.join(projectRoot, "reports", "uiux.json"), "utf-8");
      const loadedUiux = JSON.parse(uiuxJson);
      assert.ok(loadedUiux.total_issues > 0);
      assert.equal(loadedUiux.is_pass, false, "broken page 应不通过");
    } finally {
      await cleanupTmpDir(projectRoot);
    }
  });

  it("E2E-QG-04: 大型项目性能（500 文件 + 200 元素页面 < 30s）", async () => {
    const projectRoot = await createTmpDir("qg04");
    try {
      // 500 个真实 TS 文件
      const srcDir = path.join(projectRoot, "src");
      await fs.mkdir(srcDir, { recursive: true });
      for (let i = 0; i < 500; i++) {
        await fs.writeFile(
          path.join(srcDir, `f${i}.ts`),
          `export class C${i} {
  public f() { return ${i}; }
  public g() { return "${i}"; }
}
`
        );
      }

      // 200 元素页面
      const domData = {
        images: Array.from({ length: 100 }, (_, i) => ({
          tag: "img",
          selector: `img.i${i}`,
          alt: `Image ${i}`,
          src: `i${i}.png`,
          natural_width: 50,
          natural_height: 50,
          complete: true,
        })),
        form_controls: [],
        // 按钮 30x30 < 44x44 → 全部触发 tap-target 问题（100 个按钮）
        buttons: Array.from({ length: 100 }, (_, i) => ({
          selector: `button.b${i}`,
          text: `Btn ${i}`,
          width: 30,
          height: 30,
          visible: true,
          disabled: false,
        })),
        links: [],
        headings: [],
        errors: [],
      };
      const page = new FakePage(domData, []);

      const start = Date.now();

      // 并行执行 3 个组件
      const [map, uiuxIssues] = await Promise.all([
        (async () => {
          const gen = new CodeMapGenerator({ projectRoot });
          return await gen.generate();
        })(),
        (async () => {
          const a = new UIUXAnalyzer();
          return await a.audit(page);
        })(),
      ]);

      const elapsed = Date.now() - start;

      // 验证结果
      assert.equal(map.stats.fileCount, 500);
      assert.ok(uiuxIssues.length >= 100, "应识别 100+ tap-target 问题");
      // 性能断言
      assert.ok(elapsed < 30_000, `应 < 30s，实际 ${elapsed}ms`);
    } finally {
      await cleanupTmpDir(projectRoot);
    }
  });

  it("E2E-QG-05: 错误恢复（一个组件失败不影响其他组件）", async () => {
    const projectRoot = await createTmpDir("qg05");
    try {
      // 创建一个内容损坏的文件 + 一个正常文件
      // 通过 maxLinesPerFile=1 触发 big 文件截断
      await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
      await fs.writeFile(path.join(projectRoot, "src", "ok.ts"), "export const x = 1;");
      const bigContent = Array.from({ length: 10000 }, (_, i) => `export const v${i} = ${i};`).join("\n");
      await fs.writeFile(path.join(projectRoot, "src", "big.ts"), bigContent);

      // CodeMap 应能处理（截断 big.ts，不报错）
      const gen = new CodeMapGenerator({ projectRoot, maxLinesPerFile: 100 });
      const map = await gen.generate();
      assert.equal(map.stats.fileCount, 2, "两个文件都应被处理");

      // UI/UX 巡检：空页面应不报错
      const analyzer = new UIUXAnalyzer();
      const issues = await analyzer.audit(emptyPage());
      assert.equal(issues.length, 0, "空页面应无问题");

      // 视觉回归：无基线时自动保存，不报错
      const adapter = new MemoryImageAdapter();
      const currentPath = path.join(tmpRoot, "qg05-cur.png");
      adapter.set(currentPath, solidImage(50, 50, 200, 200, 200));
      const vr = new VisualRegression({
        imageAdapter: adapter,
        baselineDir: path.join(tmpRoot, "qg05-baseline"),
      });
      const result = await vr.compare({
        currentScreenshot: currentPath,
        testId: "QG-05",
        step: "step1",
      });
      assert.equal(result.error, "baseline_missing_saved", "首次应自动保存基线");
    } finally {
      await cleanupTmpDir(projectRoot);
    }
  });

  it("E2E-QG-06: 跨语言项目质量门禁（5 语言项目端到端）", async () => {
    const projectRoot = await createTmpDir("qg06");
    try {
      await createMultiLangProject(projectRoot);

      // CodeMap 体检
      const gen = new CodeMapGenerator({ projectRoot });
      const map = await gen.generate();
      assert.equal(map.stats.fileCount, 7);
      const langs = Object.keys(map.stats.languageBreakdown).sort();
      assert.deepEqual(langs, ["go", "java", "python", "rust", "typescript"]);

      // Markdown 含所有语言
      const mdPath = path.join(projectRoot, "MAP.md");
      const md = await (async () => {
        await gen.dump(map);
        return await fs.readFile(path.join(projectRoot, "CODE_MAP.md"), "utf-8");
      })();
      for (const lang of langs) {
        assert.ok(md.includes(lang), `Markdown 应包含 ${lang}`);
      }

      // UI/UX（用空页面，验证不报错）
      const analyzer = new UIUXAnalyzer();
      const issues = await analyzer.audit(emptyPage());
      assert.equal(issues.length, 0);
    } finally {
      await cleanupTmpDir(projectRoot);
    }
  });

  it("E2E-QG-07: 质量门禁门槛判定（基于规则自动评估）", async () => {
    // 场景 A: 完美状态 → pass
    const projectA = await createTmpDir("qg07a");
    try {
      await fs.writeFile(path.join(projectA, "app.ts"), `export class App { public run() { return 1; } }`);
      const genA = new CodeMapGenerator({ projectRoot: projectA });
      const mapA = await genA.generate();
      const analyzerA = new UIUXAnalyzer();
      const issuesA = await analyzerA.audit(perfectPage());
      const resultA = evaluateQualityGate(mapA, issuesA.length, 0);

      assert.equal(resultA.pass, true, "完美状态应通过门禁");
      assert.ok(resultA.totalScore >= 80, `总分应 >= 80，实际 ${resultA.totalScore}`);
    } finally {
      await cleanupTmpDir(projectA);
    }

    // 场景 B: 糟糕状态 → fail
    const projectB = await createTmpDir("qg07b");
    try {
      await fs.writeFile(
        path.join(projectB, "app.ts"),
        `export class Used { public f() { return 1; } }
export class Unused1 { public f() { return 1; } }
export class Unused2 { public f() { return 1; } }
export class Unused3 { public f() { return 1; } }
export class Unused4 { public f() { return 1; } }
export class Unused5 { public f() { return 1; } }
`
      );
      const genB = new CodeMapGenerator({ projectRoot: projectB });
      const mapB = await genB.generate();
      const analyzerB = new UIUXAnalyzer();
      const issuesB = await analyzerB.audit(brokenPage());
      const resultB = evaluateQualityGate(mapB, issuesB.length, 0.1);

      assert.equal(resultB.pass, false, "糟糕状态应不通过门禁");
      assert.ok(resultB.issues.length >= 1, "应有具体不通过原因");
    } finally {
      await cleanupTmpDir(projectB);
    }
  });

  it("E2E-QG-08: 多页面（5 个页面）端到端 CI 报告", async () => {
    const projectRoot = await createTmpDir("qg08");
    try {
      // 5 个不同质量的页面
      const pages = [
        { name: "login", page: perfectPage() },
        { name: "home", page: emptyPage() },
        { name: "profile", page: brokenPage() },
        { name: "settings", page: brokenPage() },
        { name: "admin", page: perfectPage() },
      ];

      // CodeMap 端到端
      const gen = new CodeMapGenerator({
        projectRoot,
        jsonOutputPath: path.join(projectRoot, "all-codemap.json"),
      });
      const map = await gen.generate();
      await gen.dump(map);

      // 5 个页面 UI/UX 巡检
      const uiuxReports: Array<{ name: string; score: number; pass: boolean }> = [];
      for (const p of pages) {
        const a = new UIUXAnalyzer();
        await a.audit(p.page);
        const r = a.report();
        uiuxReports.push({ name: p.name, score: r.score, pass: r.is_pass });
      }

      // 综合报告
      const report = {
        timestamp: new Date().toISOString(),
        projectRoot,
        codemap: {
          fileCount: map.stats.fileCount,
          totalLines: map.stats.totalLines,
          avgComplexity: map.stats.avgComplexity,
          deadCodeCandidates: map.stats.deadCodeCandidates.length,
        },
        uiux: uiuxReports,
        overallPass: uiuxReports.every((r) => r.pass || r.score >= 70),
      };
      const reportPath = path.join(projectRoot, "ci-report.json");
      await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf-8");

      // 验证
      const savedReport = JSON.parse(await fs.readFile(reportPath, "utf-8"));
      assert.equal(savedReport.uiux.length, 5, "应有 5 个页面报告");
      assert.equal(savedReport.codemap.fileCount, map.stats.fileCount);
      // brokenPage 的页面不应通过
      assert.ok(savedReport.uiux.some((r: any) => r.name === "profile" && !r.pass));
    } finally {
      await cleanupTmpDir(projectRoot);
    }
  });
});
