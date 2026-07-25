# 图表嵌入实践

本文件定义 Mermaid 结构图表的嵌入实践与图类型选择。结构图表（流程图、时序图、组件图等）使用 Mermaid，通过 CDN 引用。

## 1. CDN 引用与初始化

Mermaid 通过 CDN 引用，在 `</body>` 前引入。Mermaid 的初始化逻辑需写入 `assets/charts.js`（与 ECharts 共用同一外部文件，符合 CSP 兼容要求）：

```html
<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
<script src="./assets/charts.js"></script>
```

`assets/charts.js` 中 Mermaid 初始化（放在 IIFE 顶部，ECharts 图表之前）：

```javascript
// assets/charts.js
(function() {
  // --- Mermaid 初始化 ---
  if (window.mermaid) {
    mermaid.initialize({
      startOnLoad: true,      // 自动渲染 <pre class="mermaid"> 块
      theme: 'neutral',       // 中性主题，适配报告配色
      securityLevel: 'loose'   // 允许点击事件与样式自定义
    });
  }

  // --- ECharts 图表初始化（如有） ---
  // var style = getComputedStyle(document.documentElement);
  // ...
})();
```

**关键配置**：
- `theme: 'neutral'`：中性主题，不与报告调色板冲突
- `securityLevel: 'loose'`：允许样式定制（默认 `'strict'` 会限制部分功能）
- `startOnLoad: true`：页面加载时自动渲染 `<pre class="mermaid">` 块

## 2. 图类型选择

按要表达的关系选择 Mermaid 图类型：

| 表达意图 | Mermaid 类型 | 关键字 | 适用场景 |
|---|---|---|---|
| 流程/决策 | 流程图 | `flowchart` | 业务流程、决策树、系统流转 |
| 时序交互 | 时序图 | `sequenceDiagram` | API 调用、服务交互、消息传递 |
| 状态转换 | 状态图 | `stateDiagram-v2` | 状态机、生命周期、状态转换 |
| 类/对象关系 | 类图 | `classDiagram` | 领域模型、类继承关系 |
| 实体关系 | ER 图 | `erDiagram` | 数据库表关系、数据模型 |
| 甘特进度 | 甘特图 | `gantt` | 项目计划、里程碑 |
| 思维结构 | 思维导图 | `mindmap` | 知识结构、分类体系 |
| 用户旅程 | 用户旅程图 | `journey` | 用户体验路径 |

## 3. 嵌入实践

### 标准结构

每个 Mermaid 图表必须包裹在 `<figure>` + `<pre class="mermaid">` + `<figcaption>` 中：

```html
<figure class="diagram">
  <pre class="mermaid">
    flowchart LR
      A[服务 A] --> B[服务 B] --> C[(数据库)]
  </pre>
  <figcaption>图 1：系统架构图</figcaption>
</figure>
```

- `<pre class="mermaid">`：Mermaid 图源，`class="mermaid"` 是渲染标识
- `<figcaption>`：必填，描述图表内容
- `<figure class="diagram">`：提供与 ECharts 图表统一的样式容器

### 缩进与格式

`<pre>` 内的 Mermaid 语法保持顶格或统一缩进，避免前导空格导致语法错误：

```html
<pre class="mermaid">
flowchart LR
  A[步骤一] --> B[步骤二]
  B --> C{判断}
  C -->|是| D[结果 A]
  C -->|否| E[结果 B]
</pre>
```

## 4. 主题适配

Mermaid `neutral` 主题使用灰阶，不与报告调色板冲突。如需让图表色彩与报告 `--accent` 一致，可在图源中指定节点样式：

```html
<pre class="mermaid">
flowchart LR
  A[输入] --> B[处理] --> C[输出]
  classDef accent fill:var(--accent),color:#fff,stroke:none;
  class B accent;
</pre>
```

**注意**：Mermaid 节点样式中的 `var(--accent)` 仅在 `securityLevel: 'loose'` 时生效。

## 5. 各类型图表示例

### 流程图（flowchart）

```html
<pre class="mermaid">
flowchart TD
  A[开始] --> B{是否满足条件?}
  B -->|是| C[执行操作]
  B -->|否| D[跳过]
  C --> E[结束]
  D --> E
</pre>
```

方向控制：`TD`（自顶向下）、`LR`（从左到右）、`BT`（自底向上）、`RL`（从右到左）。

### 时序图（sequenceDiagram）

```html
<pre class="mermaid">
sequenceDiagram
  participant U as 用户
  participant F as 前端
  participant B as 后端
  participant D as 数据库
  U->>F: 发起请求
  F->>B: 转发请求
  B->>D: 查询数据
  D-->>B: 返回结果
  B-->>F: 响应
  F-->>U: 展示
</pre>
```

`->>` 实线箭头，`-->>` 虚线箭头（返回）。

### 状态图（stateDiagram-v2）

```html
<pre class="mermaid">
stateDiagram-v2
  [*] --> 待审核
  待审核 --> 已发布: 审核通过
  待审核 --> 已拒绝: 审核拒绝
  已发布 --> 已下架: 下架
  已拒绝 --> [*]
  已下架 --> [*]
</pre>
```

### 类图（classDiagram）

```html
<pre class="mermaid">
classDiagram
  class 用户 {
    +String 姓名
    +String 邮箱
    +登录()
  }
  class 订单 {
    +String 订单号
    +Date 下单时间
    +支付()
  }
  用户 "1" --> "*" 订单 : 拥有
</pre>
```

### ER 图（erDiagram）

```html
<pre class="mermaid">
erDiagram
  用户 ||--o{ 订单 : 创建
  订单 ||--|{ 订单项 : 包含
  订单项 }o--|| 商品 : 引用
  用户 {
    int id PK
    string 姓名
  }
</pre>
```

### 甘特图（gantt）

```html
<pre class="mermaid">
gantt
  title 项目进度计划
  dateFormat YYYY-MM-DD
  section 设计阶段
  需求分析 :a1, 2024-01-01, 10d
  原型设计 :after a1, 7d
  section 开发阶段
  前端开发 :a2, after a1, 15d
  后端开发 :a3, after a1, 18d
  section 测试阶段
  集成测试 :after a2, 5d
</pre>
```

## 6. 替代方案：PlantUML / Graphviz

如需 PlantUML 或 Graphviz 渲染的图表（Mermaid 不支持的场景），采用以下流程：

1. 编写图源文件（`.puml` 或 `.dot`）
2. 使用渲染工具生成 PNG：`dot -Tpng input.dot -o output.png`（Graphviz）
3. 将 PNG 放入报告 `assets/` 目录
4. 在 HTML 中用相对路径引用：

```html
<figure class="diagram">
  <img src="assets/architecture.png" alt="系统架构图">
  <figcaption>图 2：系统架构图</figcaption>
</figure>
```

**优先级**：Mermaid 能表达的图优先用 Mermaid（浏览器渲染，矢量清晰）；Mermaid 不支持的复杂图再用 PlantUML/Graphviz 生成 PNG。

## 7. 禁止事项

- ❌ 在 HTML 内写内联 `<script>` 初始化 Mermaid（必须放入 `assets/charts.js`）
- ❌ 省略 `<figcaption>` 标题
- ❌ 使用 Mermaid 默认主题（`default`/`dark`/`forest`），改用 `neutral`
- ❌ 在图源中使用硬编码颜色（应通过 `classDef` + CSS 变量）
- ❌ 省略 `<pre class="mermaid">` 的 `class="mermaid"`（Mermaid 无法识别）

## 8. 与 ECharts 共存

同一份报告可同时使用 ECharts（数据图表）与 Mermaid（结构图表）。CDN 引用顺序：

```html
<!-- 1. ECharts CDN -->
<script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>
<!-- 2. Mermaid CDN -->
<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
<!-- 3. 自定义逻辑（含 Mermaid 初始化与 ECharts 图表） -->
<script src="./assets/charts.js"></script>
```

在 `charts.js` 的 IIFE 中，先初始化 Mermaid（`startOnLoad` 会自动渲染），再初始化各 ECharts 图表实例。
