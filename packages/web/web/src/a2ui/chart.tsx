/**
 * A2UI Chart 组件：纯 SVG 实现柱状图 / 折线图 / 饼图（零第三方依赖）。
 *
 * 设计要点（任务 R9 / 设计文档 §3.7）：
 * - 轴 / 刻度 / 图例齐全；每个图形元素带 <title> 原生 tooltip；
 * - 颜色使用 CSS 变量（--a2ui-chart-N），深浅主题自动适配（见 a2ui.css）；
 * - 边界不崩溃：空数据、单点、全等值、超大值、非有限数值均做兜底。
 */
import type { A2uiChartSeries, A2uiChartSpec } from "./types";

/** ChartView 组件属性 */
export interface ChartViewProps {
  /** 图表规格（来自 parser 或任意标准 A2UI surface 的 Chart 原语） */
  spec: A2uiChartSpec;
}

/** 画布逻辑尺寸（viewBox 固定，CSS 拉伸自适应容器宽度） */
const W = 640;
const H = 360;

/** 图表配色变量名列表（a2ui.css 中定义，按系列序号循环取用） */
const COLOR_VARS = [
  "var(--a2ui-chart-1)",
  "var(--a2ui-chart-2)",
  "var(--a2ui-chart-3)",
  "var(--a2ui-chart-4)",
  "var(--a2ui-chart-5)",
  "var(--a2ui-chart-6)",
];

/** 取第 i 个系列的填充色（深浅主题由 CSS 变量决定） */
function seriesColor(i: number): string {
  return COLOR_VARS[i % COLOR_VARS.length];
}

/**
 * 数值格式化：中文习惯单位（万 / 亿），避免轴标签过长。
 * 非有限数一律按 0 显示（防御性兜底，不抛异常）。
 */
function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const abs = Math.abs(n);
  if (abs >= 1e8) return `${round2(n / 1e8)}亿`;
  if (abs >= 1e4) return `${round2(n / 1e4)}万`;
  return `${round2(n)}`;
}

/** 保留最多 2 位小数并去掉多余的 0 */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * 生成"好看"的刻度序列：步长取 1/2/5 × 10^k，覆盖 [min,max] 并向外取整。
 * min === max（全等值/单点）时自动扩展区间，保证可画。
 */
function niceTicks(min: number, max: number, count = 5): number[] {
  // 防御：非有限输入回退到平凡区间
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) {
    const d = Math.abs(min) > 0 ? Math.abs(min) : 1;
    min -= d * 0.5;
    max += d * 0.5;
  }
  const span = max - min;
  const rawStep = span / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  // 在 1/2/5/10 中选择不小于 norm 的最小步长系数
  const factor = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  const step = factor * mag;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  // 浮点累加的容差处理：终点加 step*1e-9 防止漏采最后一个刻度
  for (let v = start; v <= end + step * 1e-9; v += step) {
    ticks.push(Math.round(v * 1e9) / 1e9);
  }
  return ticks.length >= 2 ? ticks : [start, start + step];
}

/** 防御性归一系列数据：拷贝并保证每项为有限数（非法值归 0） */
function sanitizeSeriesData(s: A2uiChartSeries): number[] {
  return s.data.map((v) => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
  });
}

/** 判断整个图表是否没有任何可绘制数据 */
function isEmptySpec(spec: A2uiChartSpec): boolean {
  if (!Array.isArray(spec.series) || spec.series.length === 0) return true;
  return spec.series.every((s) => !Array.isArray(s.data) || s.data.length === 0);
}

/** 取类目标签：优先 spec.labels，缺省时生成 "项 1 / 项 2 / ..." */
function categoryLabels(spec: A2uiChartSpec, count: number): string[] {
  const labels: string[] = [];
  for (let i = 0; i < count; i++) {
    const l = spec.labels?.[i];
    labels.push(typeof l === "string" && l.length > 0 ? l : `项 ${i + 1}`);
  }
  return labels;
}

/** 取系列名：缺省时生成 "系列 1 / 系列 2 / ..." */
function seriesName(s: A2uiChartSeries, i: number): string {
  return typeof s.name === "string" && s.name.length > 0 ? s.name : `系列 ${i + 1}`;
}

/** 空数据占位：居中灰字，不抛错不崩溃 */
function EmptyHint({ text }: { text: string }) {
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" className="a2ui-chart">
      <text x={W / 2} y={H / 2} textAnchor="middle" className="a2ui-chart-empty">
        {text}
      </text>
    </svg>
  );
}

/** 图表标题 + 图例（柱状/折线共用；饼图图例自绘在右侧） */
function ChartTitle({ title }: { title?: string }) {
  if (!title) return null;
  return (
    <text x={W / 2} y={22} textAnchor="middle" className="a2ui-chart-title">
      {title}
    </text>
  );
}

/**
 * 柱状图：多系列分组柱；y 轴刻度 + 网格线 + 横轴类目标签 + 柱顶值标签。
 * 值可正可负（0 基线自适应）；类目过多时横轴标签抽稀防止重叠；
 * 柱数极多（>400）时省略值标签以保证渲染性能与可读性。
 */
function BarChart({ spec }: { spec: A2uiChartSpec }) {
  const series = spec.series.map((s, i) => ({ name: seriesName(s, i), data: sanitizeSeriesData(s), i }));
  const catCount = Math.max(...series.map((s) => s.data.length), 1);
  const labels = categoryLabels(spec, catCount);

  // 汇总全部数值求值域（含 0 基线）
  const all = series.flatMap((s) => s.data);
  const dataMax = all.length > 0 ? Math.max(...all) : 0;
  const dataMin = all.length > 0 ? Math.min(...all) : 0;
  const ticks = niceTicks(Math.min(0, dataMin), Math.max(0, dataMax), 5);
  const tMin = ticks[0];
  const tMax = ticks[ticks.length - 1];

  // 绘图区边距：左侧留刻度文本宽度，底部留类目标签与图例
  const padL = 52;
  const padR = 16;
  const hasLegend = series.length > 1;
  const plotTop = 36;
  const plotBottom = H - (hasLegend ? 56 : 34);
  const plotW = W - padL - padR;
  const plotH = plotBottom - plotTop;

  /** 值 → y 像素坐标（线性映射到刻度区间） */
  const yOf = (v: number) => plotBottom - ((v - tMin) / (tMax - tMin || 1)) * plotH;
  const y0 = Math.min(Math.max(yOf(0), plotTop), plotBottom); // 0 基线（负值时位于中部）

  const groupW = plotW / catCount;
  const barW = Math.min((groupW * 0.7) / series.length, 42);
  const totalBars = catCount * series.length;

  // 横轴标签抽稀：估算可用宽度不足时每隔 n 个显示一个
  const labelStride = Math.max(1, Math.ceil((catCount * 34) / plotW));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={spec.title ?? "柱状图"} className="a2ui-chart">
      <ChartTitle title={spec.title} />
      {/* y 轴刻度 + 横向网格线 */}
      {ticks.map((t) => (
        <g key={`tick-${t}`}>
          <line x1={padL} x2={W - padR} y1={yOf(t)} y2={yOf(t)} className="a2ui-chart-grid" />
          <text x={padL - 6} y={yOf(t) + 3} textAnchor="end" className="a2ui-chart-axis">
            {fmtNum(t)}
          </text>
        </g>
      ))}
      {/* 分组柱体：每个柱子带 <title> 原生 tooltip */}
      {series.map((s, si) =>
        s.data.map((v, ci) => {
          const x = padL + ci * groupW + (groupW - barW * series.length) / 2 + si * barW;
          const yv = yOf(v);
          const top = Math.min(yv, y0);
          const h = Math.max(Math.abs(yv - y0), 1); // 高度下限 1px，保证零值可见
          return (
            <rect
              key={`${si}-${ci}`}
              x={x}
              y={top}
              width={Math.max(barW - 1, 1)}
              height={h}
              fill={seriesColor(si)}
              rx={2}
            >
              <title>{`${labels[ci]} · ${s.name}：${fmtNum(v)}`}</title>
            </rect>
          );
        })
      )}
      {/* 柱顶值标签（柱数可控时绘制，防止海量文本节点） */}
      {totalBars <= 400 &&
        series.map((s, si) =>
          s.data.map((v, ci) => {
            const x = padL + ci * groupW + (groupW - barW * series.length) / 2 + si * barW + barW / 2;
            const yv = yOf(v);
            // 正值：标签在柱顶上方；负值：标签在柱底下方（柱底即 yv）
            const labelY = v >= 0 ? yv - 4 : yv + 12;
            return (
              <text key={`lbl-${si}-${ci}`} x={x} y={labelY} textAnchor="middle" className="a2ui-chart-value">
                {fmtNum(v)}
              </text>
            );
          })
        )}
      {/* 横轴类目标签 */}
      {labels.map((l, ci) =>
        ci % labelStride === 0 ? (
          <text
            key={`cat-${ci}`}
            x={padL + ci * groupW + groupW / 2}
            y={plotBottom + 14}
            textAnchor="middle"
            className="a2ui-chart-axis"
          >
            {l.length > 8 ? `${l.slice(0, 7)}…` : l}
          </text>
        ) : null
      )}
      {/* x 轴基线 */}
      <line x1={padL} x2={W - padR} y1={plotBottom} y2={plotBottom} className="a2ui-chart-axisline" />
      {/* 图例（多系列时显示） */}
      {hasLegend &&
        series.map((s, si) => (
          <g key={`lg-${si}`} transform={`translate(${padL + si * 110}, ${H - 18})`}>
            <rect width={10} height={10} rx={2} fill={seriesColor(si)} />
            <text x={14} y={9} className="a2ui-chart-legend">
              {s.name}
            </text>
          </g>
        ))}
    </svg>
  );
}

/**
 * 折线图：折线 + 圆点标记；y 轴刻度 + 网格 + 横轴类目 + 图例。
 * 单点系列退化为单个圆点（polyline 至少两点，单点单独绘制）。
 */
function LineChart({ spec }: { spec: A2uiChartSpec }) {
  const series = spec.series.map((s, i) => ({ name: seriesName(s, i), data: sanitizeSeriesData(s), i }));
  const catCount = Math.max(...series.map((s) => s.data.length), 1);
  const labels = categoryLabels(spec, catCount);

  const all = series.flatMap((s) => s.data);
  const ticks = niceTicks(all.length > 0 ? Math.min(...all) : 0, all.length > 0 ? Math.max(...all) : 1, 5);
  const tMin = ticks[0];
  const tMax = ticks[ticks.length - 1];

  const padL = 52;
  const padR = 16;
  const hasLegend = series.length > 1;
  const plotTop = 36;
  const plotBottom = H - (hasLegend ? 56 : 34);
  const plotW = W - padL - padR;
  const plotH = plotBottom - plotTop;

  /** 值 → y 像素 */
  const yOf = (v: number) => plotBottom - ((v - tMin) / (tMax - tMin || 1)) * plotH;
  /** 类目索引 → x 像素（首尾留半格边距） */
  const xOf = (ci: number) => padL + (catCount <= 1 ? plotW / 2 : (ci / (catCount - 1)) * plotW);

  const labelStride = Math.max(1, Math.ceil((catCount * 34) / plotW));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={spec.title ?? "折线图"} className="a2ui-chart">
      <ChartTitle title={spec.title} />
      {/* 刻度与网格 */}
      {ticks.map((t) => (
        <g key={`tick-${t}`}>
          <line x1={padL} x2={W - padR} y1={yOf(t)} y2={yOf(t)} className="a2ui-chart-grid" />
          <text x={padL - 6} y={yOf(t) + 3} textAnchor="end" className="a2ui-chart-axis">
            {fmtNum(t)}
          </text>
        </g>
      ))}
      {/* 折线与数据点 */}
      {series.map((s, si) => {
        const pts = s.data.map((v, ci) => `${xOf(ci)},${yOf(v)}`).join(" ");
        return (
          <g key={`ln-${si}`}>
            {s.data.length >= 2 && <polyline points={pts} fill="none" stroke={seriesColor(si)} strokeWidth={2} />}
            {s.data.map((v, ci) => (
              <circle key={`pt-${si}-${ci}`} cx={xOf(ci)} cy={yOf(v)} r={3.5} fill={seriesColor(si)}>
                <title>{`${labels[ci]} · ${s.name}：${fmtNum(v)}`}</title>
              </circle>
            ))}
          </g>
        );
      })}
      {/* 横轴类目标签 */}
      {labels.map((l, ci) =>
        ci % labelStride === 0 ? (
          <text key={`cat-${ci}`} x={xOf(ci)} y={plotBottom + 14} textAnchor="middle" className="a2ui-chart-axis">
            {l.length > 8 ? `${l.slice(0, 7)}…` : l}
          </text>
        ) : null
      )}
      {/* x 轴基线 */}
      <line x1={padL} x2={W - padR} y1={plotBottom} y2={plotBottom} className="a2ui-chart-axisline" />
      {/* 图例 */}
      {hasLegend &&
        series.map((s, si) => (
          <g key={`lg-${si}`} transform={`translate(${padL + si * 110}, ${H - 18})`}>
            <rect width={10} height={10} rx={2} fill={seriesColor(si)} />
            <text x={14} y={9} className="a2ui-chart-legend">
              {s.name}
            </text>
          </g>
        ))}
    </svg>
  );
}

/**
 * 计算饼图扇区路径（SVG arc）。
 * @param cx 圆心 x
 * @param cy 圆心 y
 * @param r  半径
 * @param a0 起始角（弧度）
 * @param a1 终止角（弧度，> a0）
 */
function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  // 整圆（100% 单扇区）：两段半圆弧拼接，直接画圆
  if (a1 - a0 >= Math.PI * 2 - 1e-9) {
    return `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx - 0.01} ${cy - r} Z`;
  }
  const x0 = cx + r * Math.cos(a0);
  const y0 = cy + r * Math.sin(a0);
  const x1 = cx + r * Math.cos(a1);
  const y1 = cy + r * Math.sin(a1);
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M ${cx} ${cy} L ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} Z`;
}

/**
 * 饼图：扇区 + 百分比标注 + 右侧图例。
 * 负值按 0 处理（饼图无负半径语义，做显式钳制而非崩溃）；
 * 多系列时仅渲染第一系列，并在图例下方给出提示（不静默丢弃）。
 */
function PieChart({ spec }: { spec: A2uiChartSpec }) {
  const first = spec.series[0];
  const data = sanitizeSeriesData(first).map((v) => Math.max(v, 0));
  const total = data.reduce((a, b) => a + b, 0);
  const labels = categoryLabels(spec, data.length);
  const multiSeriesHint = spec.series.length > 1 ? `（共 ${spec.series.length} 个系列，饼图仅展示第 1 个）` : "";

  // 全为 0：无有效占比 → 空态
  if (total <= 0) {
    return <EmptyHint text="暂无有效数据" />;
  }

  const cx = W * 0.34;
  const cy = H / 2 + 8;
  const r = Math.min(W * 0.26, H * 0.36);

  // 累计角度生成扇区
  let acc = -Math.PI / 2; // 从正上方开始
  const slices = data.map((v, i) => {
    const frac = v / total;
    const a0 = acc;
    const a1 = acc + frac * Math.PI * 2;
    acc = a1;
    // 扇区中点角（用于放置百分比标签）
    const mid = (a0 + a1) / 2;
    return { i, v, frac, path: arcPath(cx, cy, r, a0, a1), mid };
  });

  // 图例布局：右侧纵向列表（每行色块 + 名称 + 数值/占比）
  const legendX = W * 0.62;
  const legendTop = Math.max(40, cy - slices.length * 12);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={spec.title ?? "饼图"} className="a2ui-chart">
      <ChartTitle title={spec.title} />
      {slices.map((s) => (
        <path key={s.i} d={s.path} fill={seriesColor(s.i)} stroke="var(--a2ui-surface)" strokeWidth={1}>
          <title>{`${labels[s.i]}：${fmtNum(s.v)}（${Math.round(s.frac * 1000) / 10}%）`}</title>
        </path>
      ))}
      {/* 百分比标注：占比 >= 5% 的扇区才放置，避免小扇区文字溢出 */}
      {slices.map((s) =>
        s.frac >= 0.05 ? (
          <text
            key={`pl-${s.i}`}
            x={cx + r * 0.62 * Math.cos(s.mid)}
            y={cy + r * 0.62 * Math.sin(s.mid) + 3}
            textAnchor="middle"
            className="a2ui-chart-pct"
          >
            {Math.round(s.frac * 100)}%
          </text>
        ) : null
      )}
      {/* 图例 */}
      {slices.map((s, k) => (
        <g key={`lg-${s.i}`} transform={`translate(${legendX}, ${legendTop + k * 22})`}>
          <rect width={10} height={10} rx={2} fill={seriesColor(s.i)} />
          <text x={14} y={9} className="a2ui-chart-legend">
            {`${labels[s.i]} · ${fmtNum(s.v)}（${Math.round(s.frac * 1000) / 10}%）`}
          </text>
        </g>
      ))}
      {multiSeriesHint !== "" && (
        <text x={legendX} y={H - 14} className="a2ui-chart-hint">
          {multiSeriesHint}
        </text>
      )}
    </svg>
  );
}

/**
 * ChartView：按 spec.type 分发到具体 SVG 实现。
 * 未知类型不会出现（parser 已校验），但标准 A2UI surface 可能来自外部，
 * 故仍兜底为空态提示，绝不抛异常。
 */
export function ChartView({ spec }: ChartViewProps) {
  if (isEmptySpec(spec)) {
    return <EmptyHint text="暂无数据" />;
  }
  switch (spec.type) {
    case "bar":
      return <BarChart spec={spec} />;
    case "line":
      return <LineChart spec={spec} />;
    case "pie":
      return <PieChart spec={spec} />;
    default:
      return <EmptyHint text={`暂不支持的图表类型：${String((spec as { type?: unknown }).type)}`} />;
  }
}
