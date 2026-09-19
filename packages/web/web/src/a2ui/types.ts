/**
 * A2UI v0.8 协议类型定义（客户端渲染层）。
 *
 * 依据 a2ui.org/reference/messages v0.8：
 * - 传输格式为 JSONL，每行一条消息，共 4 类消息；
 * - 组件模型为"扁平邻接表"：components 数组按 id 索引，父子关系通过 childIds 引用，不嵌套；
 * - 文本属性支持 DynamicString 数据绑定（形如 "${path.to.value}"）。
 *
 * 本文件是渲染层（renderer.tsx）与转换器（parser.ts）之间的唯一契约：
 * 渲染器消费标准 A2UI 消息流，不引入私有协议分支——后续接入 A2UI agent SDK
 * 产出的 surface 可直接复用本渲染器。
 */

/**
 * DynamicString：A2UI 的可绑定字符串。
 * - 纯文本：原样渲染；
 * - "${a.b.c}"：整串为单一路径绑定，渲染时从 dataModel 取值，取不到则显示原始占位串；
 * - "文本 ${a.b} 文本"：内嵌绑定，渲染时逐个替换（取不到的占位保持原文）。
 * 注意：协议层面 DynamicString 就是 string，绑定语义在渲染时解析。
 */
export type DynamicString = string;

/** 图表数据序列（```chart fence JSON 的 series 元素） */
export interface A2uiChartSeries {
  /** 系列名称（图例显示；饼图/单系列柱图可缺省） */
  name?: string;
  /** 与 labels 一一对应的数据值；非法值（NaN/非有限数）由渲染层兜底处理 */
  data: number[];
}

/** 图表规格（```chart fence 的 JSON 结构） */
export interface A2uiChartSpec {
  /** 图表类型：柱状图 / 折线图 / 饼图 */
  type: "bar" | "line" | "pie";
  /** 图表标题（可缺省） */
  title?: string;
  /** 类目轴标签（饼图时为扇区名） */
  labels?: string[];
  /** 数据系列（至少 1 条） */
  series: A2uiChartSeries[];
}

/** Text 组件属性：文本（支持行内 **粗体** *斜体* `code` [链接](url) 由渲染层解析） */
export interface A2uiTextProps {
  /** 文本内容，支持 DynamicString 绑定 */
  text: DynamicString;
  /** 文本变体：body=正文（默认）；monospace=等宽（代码块内）；quote=引用块 */
  variant?: "body" | "monospace" | "quote";
  /** 是否加粗（表格表头使用） */
  bold?: boolean;
}

/** Heading 组件属性：标题（# ~ ####，level 即 # 数量） */
export interface A2uiHeadingProps {
  /** 标题文本 */
  text: DynamicString;
  /** 标题级别 1-6（设计约定 # ~ ####，容错支持 5/6） */
  level: 1 | 2 | 3 | 4 | 5 | 6;
}

/** Image 组件属性：图片（url 直接渲染；渲染层校验协议白名单） */
export interface A2uiImageProps {
  /** 图片地址（http/https/data/blob 之外一律拒绝渲染） */
  url: string;
  /** 替代文本（加载失败或无障碍场景展示） */
  alt?: string;
}

/** 按钮动作描述（本渲染层支持的动作子集） */
export interface A2uiButtonAction {
  /**
   * 动作类型：
   * - copy：将 text 复制到剪贴板（代码块"复制"按钮使用）；
   * - submit：语义上为提交类动作，当前渲染层无表单上下文，点击给出不支持提示（不静默）。
   */
  type: "copy" | "submit";
  /** copy 动作的复制内容 */
  text?: string;
}

/** Button 组件属性 */
export interface A2uiButtonProps {
  /** 按钮文案（亦可通过 childIds 引用子 Text；两者都缺省时显示"按钮"） */
  label?: DynamicString;
  /** 点击动作（缺省时按钮仅作展示） */
  action?: A2uiButtonAction;
}

/** Card 组件属性：卡片（标题栏 + 内容子组件） */
export interface A2uiCardProps {
  /** 标题栏文字（代码块场景为语言名） */
  title?: DynamicString;
  /** 内容子组件 id 列表（邻接表引用） */
  childIds: string[];
  /** 标题栏动作（代码块场景为"复制"按钮） */
  headerAction?: A2uiButtonAction;
}

/** Row 组件属性：横向 flex 布局容器 */
export interface A2uiRowProps {
  /** 子组件 id 列表 */
  childIds: string[];
  /** 子项间距（px，缺省 8） */
  gap?: number;
  /** 是否允许换行（表格单元格场景不需要换行） */
  wrap?: boolean;
}

/** Column 组件属性：纵向 flex 布局容器（解析产物的根容器） */
export interface A2uiColumnProps {
  /** 子组件 id 列表 */
  childIds: string[];
  /** 子项间距（px，缺省 12） */
  gap?: number;
}

/**
 * List 组件属性：纵向/横向列表容器。
 * Markdown 表格映射为 List（direction 默认 vertical）内含 Row 行、Column 单元格，
 * 表头行内 Text 以 bold=true 呈现"表头加粗"。
 */
export interface A2uiListProps {
  /** 子组件 id 列表 */
  childIds: string[];
  /** 排列方向，缺省 vertical */
  direction?: "vertical" | "horizontal";
  /** 子项间距（px，缺省 4） */
  gap?: number;
}

/** Divider 组件属性：分隔线（---），无附加属性 */
export type A2uiDividerProps = Record<string, never>;

/**
 * A2UI 组件：{id, component: {<组件类型名>: 属性对象}}。
 * 组件类型名为协议原语名（Text/Heading/...），值为该原语的属性对象；
 * 未收录进本渲染层的原语（Tabs/Modal/Video 等）按 unknown 处理并兜底渲染。
 */
export interface A2uiComponent {
  /** 组件唯一 id（同一 surface 内按 id 合并/覆盖） */
  id: string;
  /** 组件类型名 → 属性对象（单键） */
  component: Record<string, unknown>;
}

/** 消息：beginRendering —— 声明一个 surface 及其根组件 id */
export interface A2uiBeginRenderingMessage {
  beginRendering: {
    /** surface 唯一标识 */
    surfaceId: string;
    /** 根组件 id */
    root: string;
  };
}

/** 消息：surfaceUpdate —— 全量/合并式提交组件列表（按 id 合并覆盖） */
export interface A2uiSurfaceUpdateMessage {
  surfaceUpdate: {
    surfaceId: string;
    /** 本次提交的组件（与 surface 已有组件按 id 合并，新 id 覆盖旧定义） */
    components: A2uiComponent[];
  };
}

/** 消息：dataModelUpdate —— 合并式提交数据模型（DynamicString 绑定取值来源） */
export interface A2uiDataModelUpdateMessage {
  dataModelUpdate: {
    surfaceId: string;
    /** 数据模型内容（与已有内容浅合并：顶层键覆盖） */
    contents: Record<string, unknown>;
  };
}

/** 消息：deleteSurface —— 销毁 surface（渲染层清空对应状态） */
export interface A2uiDeleteSurfaceMessage {
  deleteSurface: {
    surfaceId: string;
  };
}

/** A2UI 四类消息的判别联合（JSONL 每行一条） */
export type A2uiMessage =
  | A2uiBeginRenderingMessage
  | A2uiSurfaceUpdateMessage
  | A2uiDataModelUpdateMessage
  | A2uiDeleteSurfaceMessage;

/** 渲染器内部 surface 状态（状态机快照，可测试的纯数据结构） */
export interface A2uiSurfaceState {
  /** 是否已收到 beginRendering（未收到前不渲染任何组件） */
  started: boolean;
  /** 根组件 id（beginRendering.root） */
  rootId: string | null;
  /** 组件邻接表：id → 组件（surfaceUpdate 按 id 合并覆盖） */
  components: Map<string, A2uiComponent>;
  /** 数据模型（dataModelUpdate 浅合并） */
  dataModel: Record<string, unknown>;
}
