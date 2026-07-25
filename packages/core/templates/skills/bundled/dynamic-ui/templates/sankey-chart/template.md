# sankey-chart — 桑基图

## 场景与意图
- 场景：data-visualization
- 意图：flow_magnitude_sankey
- 触发：用户意图涉及分阶段节点间加权流动、路径量级、流量分配、来源-结果归因（如"流量来源分布""用户路径""资源流转""收入构成路径"）

## 数据形状
- 数据结构：有向无环图（DAG），节点按阶段分层；边为加权流量
- 必需字段：
  - `flows`：数组，每项含 `from`（源节点名）、`to`（目标节点名）、`flow`（非负数值）
  - `nodes`：数组（或由 flows 自动派生），每项含 `name`、`color`（token 角色名，如 `chart-series-1`/`success`/`chart-other`）
  - `stages`：阶段标签数组，描述从左到右的分层语义（如 ["来源","互动","结果"]）
- 可选字段：
  - `unit`：流量单位（如"用户数""次""元"）
  - `focusNode`：单一焦点节点名，用于强调主路径

## 适配要点
- 阶段数 2-4 为宜；节点总数 ≤ 12；超量时归并 Top N + Other 或改用紧凑表
- 同辈来源节点按序用 `--chart-series-1` 至 `--chart-series-4`；去强调余项/流失桶用 `--chart-other`
- 结果节点若编码真实状态/风险变量（如"转化/流失"），可用 `--success`/`--danger` — 此为 sankey 模板本地例外，不得复制到其他模板
- 单一焦点：最高流量的来源→结果主路径，或核心转化节点；用 `--brand` 边框或位置强调，不靠多色
- 流量值舍入一致；提示框显示 from → to + 流量 + 占总量百分比
- 禁止循环图、双向边、稠密多对多；遇此改用紧凑表

## 降级策略
- 降级原语：`compact-table-visual`（插件不可用时显示 from | to | flow 紧凑表，按 flow 降序）
- 降级触发条件：
  - chartjs-chart-sankey 插件加载失败（`typeof Chart === 'undefined'` 或 `Chart.controllers.sankey` 不存在）
  - flows 为空或含循环
  - canvas 2d 上下文获取失败
- 降级内容在 `<script>` 执行前可见，仅图表实例化成功后隐藏

## 适配示例
见 `widget-code.html` 与 `fixture.json`
