# Micro Interaction（微交互场景）

共享契约：依次应用 `SKILL.md`、本场景文件、`templates/manifest.json`、所选 `templates/<id>/template.md`（若存在）与 `tokens/visual-tokens.md`。

## 何时进入本场景

用户意图涉及**局部可交互演示**：参数切换（不同配置/状态间切换看效果）、状态变化展示（前后对比、逐步）、数据筛选/排序（切换现有数据视角）、局部动画 demo（悬停效果、展开/折叠）、交互式对比（不同视图间标签切换）。

典型触发词：交互 demo、toggle、可点击、可操作、交互、demo、试一下。

**与数据可视化场景的区别**：数据可视化聚焦图表渲染；微交互聚焦用户可操作的 UI 片段。

## 何时拒绝

以下情况改用 Markdown 或静态可视化，不生成交互 widget：
- 内容无需用户交互即可完整传达
- 需多页导航（widget 环境不支持路由）
- 交互逻辑依赖外部 API 或实时数据源
- 需表单提交/持久化存储
- 交互概念 > 1 个独立控件组（复杂度溢出）

## 强制工作流

1. 确认一个局部交互比静态视觉或 Markdown 更清晰
2. 选定**唯一**控件概念
3. 输出前选择降级原语
4. 选 `explanation-panel`、`decision-cards`、`chart-card` 或 `node-flow` 作为在 JS 运行前仍有意义的静态结构
5. 应用 `tokens/visual-tokens.md` 的 token 化字体、间距、圆角后再加交互特定样式
6. 仅加增强该静态结构所需的最小脚本
7. 若交互需外部 API、持久化、路由或多个无关控件，不渲染 widget

### 核心约束：单一控件概念

每个 widget 仅含**一个**局部控件概念：
- 一个开关（开/关）
- 一个滑块（连续值调节）
- 一组标签（视图切换）
- 一个步进器（前进/后退）
- 一个筛选器（选/取消筛选）

不在同一 widget 组合多个独立交互概念。

### JavaScript 状态管理
- 用 widget 内部 JavaScript 管理局部状态（筛选、排序、切换、步进、高亮）
- 所有状态变化通过 DOM 操作反映，无框架依赖
- 状态存于闭包变量或 `data-*` 属性

### sendPrompt 使用规则

`window.sendPrompt('...')`
- **仅用于**：需模型推理的后续问题（如"解释此选项背后的详细原理"）
- **不用于**：本地 UI 行为（标签切换、展开/折叠、数据筛选）
- 判据：该操作结果是否需 LLM 介入？否 → 用本地 JS 处理

### 流式兼容
- **不用 `display:none` 隐藏内容** — 流式阶段所有内容须可见
- 初始状态须渲染为完全可见的 HTML（如步进器第一步、默认标签面板）
- 最终 `<script>` 块处理交互增强（渐进增强模式）
- 若 JS 不执行，widget 仍应显示有意义的静态内容

### 事件绑定规范

```javascript
// 正确：在最终 script 块统一绑定
const root = document.querySelector('[data-dynamic-ui-widget][data-template="..."]:not([data-mounted])');
root.querySelectorAll('[data-action]').forEach(el => {
  el.addEventListener('click', handleAction);
});

// 错误：内联 onclick
// <button onclick="toggle()">  ← 禁止
```

- 无内联事件处理器（`onclick`、`onchange` 等）
- 一个最终 `<script>` 块处理所有事件绑定
- 用 `querySelectorAll` + `addEventListener` 模式
- 优先事件委托（监听容器，通过 `e.target.closest('[data-action]')` 派发）

### 动画规范
- 优先属性：`transform`、`opacity`、`stroke-dashoffset`
- 过渡时长 80–200ms
- 须包裹在 `@media (prefers-reduced-motion: no-preference)` 中：

```css
@media (prefers-reduced-motion: no-preference) {
  .panel { transition: opacity 150ms ease, transform 150ms ease; }
}
```

- 禁止：`height` auto 过渡（性能差）、触发布局的动画
- 折叠/展开用 `max-height` + `overflow: hidden` 或 `grid-template-rows: 0fr/1fr`

### 可访问性
- 交互元素须有 `role` 或语义 HTML 标签（`<button>`、`<input>`）
- 标签组用 `role="tablist"` + `role="tab"` + `aria-selected`
- 开关用 `<button aria-pressed="true/false">`
- 键盘可达：可聚焦元素可通过 Tab 到达

### 交互静默预检
- 选定唯一局部控件概念，所有行为限于 widget 内
- 最终脚本运行前渲染有意义的默认状态
- 流式内容避免 `display:none`；挂载后用渐进增强
- 仅在最终脚本中用 `addEventListener` 绑定事件；无内联处理器
- 仅当点击需模型推理时用 `window.sendPrompt`
- 用语义控件或 ARIA 属性，初始化后设 `data-mounted`

## 参考材料

| 数据关系/意图 | 参考模板 | 用法说明 |
|---|---|---|
| — | 无专用模板 | 本场景按具体交互需求用 HTML/JS 片段自定义构建 |

> 即便自定义交互也必须先选降级原语（`explanation-panel`、`decision-cards`、`chart-card` 或 `node-flow`）作为静态结构，再用最小脚本增强。

## 组合指南

1. **定交互类型**：用户需什么控件？（开关/滑块/标签/步进器/筛选器）
2. **设计初始状态**：渲染完全可见的默认视图（无 JS 也有意义）
3. **规划状态变化**：列出用户动作 → 对应 DOM 变化（哪些元素显示/隐藏/高亮）
4. **写 HTML**：
   - 所有面板/状态内容渲染进 DOM
   - 非活动面板用 class 控制 opacity/visibility（不用 `display:none`）
   - 交互控件带 `data-action` 属性
5. **写脚本**：
   - 取根 → 绑定事件 → 管理状态 → 更新 DOM
   - 执行后设 `root.setAttribute('data-mounted', '')`
6. **加动画**：仅在状态切换点加过渡，包裹在 reduced-motion 媒体查询
7. **降级纪律**：默认渲染状态须已满足降级视觉契约；JavaScript 可改变状态，但不得引入独立色系、字号阶、间距阶、圆角阶、仅隐藏内容或装饰性 UI 外壳
