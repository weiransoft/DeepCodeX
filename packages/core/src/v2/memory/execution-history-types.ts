/**
 * execution-history-types.ts — 执行历史记录数据类型定义
 *
 * 设计原则：
 * - 纯类型文件，零运行时依赖（仅 `import type`）
 * - ExecutionRecord 是一期核心，二期字段用 `?` 标记可选，保证一期读写零兼容成本
 * - ArtifactEntry 描述产出物（write/edit 产出文件 / bash 新增文件）
 *   一期只登记 write/edit 工具产出的文件变更，bash 产出物登记输出路径
 *
 * 与 V2 MemoryStore 的关系：
 * - 一期 ExecutionHistoryStore 与 V2 MemoryStore 完全独立（双轨隔离）
 * - 二期 US-EH-007/008 通过 metadata.executionRecordIds / memoryEntryIds 双向打通
 * - 具体双向关联逻辑在 execution-history-memory-sync.ts（二期新增）里实现
 */

/** 工具执行成功标志 */
export type ExecutionOutcome = "ok" | "fail";

/** 产出物条目（一期核心字段） */
export interface ArtifactEntry {
  /** 变更类型：新增文件 / 修改文件 / 删除文件 / bash 产出 */
  kind: "created" | "modified" | "deleted" | "bash-output";
  /** 变更文件的绝对路径（bash-output 是输出路径） */
  path: string;
  /** 变更说明（可选简短描述，如 "bash build 产出 dist/bundle.js"） */
  description?: string;
  /** 文件哈希（SHA256），可选，用于后续 diff（一期可选） */
  sha256?: string;
  /** 变更前文件大小（字节），可选；created 时 undefined */
  beforeSize?: number;
  /** 变更后文件大小（字节） */
  afterSize?: number;
}

/**
 * 单条执行记录
 *
 * 一期必填字段：toolName / ok / sessionId / turnIndex / timestamp
 * 二期可选字段（? 标记）：memoryEntryIds / fixedByExecutionId
 *   一期读写 JSON 时这两个字段缺省为 undefined，不影响任何逻辑
 */
export interface ExecutionRecord {
  /** 记录唯一 id（时间戳+随机后缀） */
  id: string;
  /** 所属 session id */
  sessionId: string;
  /** 所属 session 内的 turn 序号（每条工具调用 +1，从 0 开始） */
  turnIndex: number;
  /** 执行时间戳（毫秒，Date.now()） */
  timestamp: number;
  /** 执行日期（YYYY-MM-DD，便于 query.lastDays 过滤） */
  date: string;
  /** 工具名（bash / read / write / edit / skill / AskUserQuestion / ...） */
  toolName: string;
  /** 是否成功：true=ok；false=fail */
  ok: boolean;

  // ========== 执行上下文 ==========
  /** 工具参数（截断到 4KB，防止单条爆炸） */
  argsSnippet?: string;
  /** 工具输出摘要（截断到 4KB，防止单条爆炸） */
  outputSnippet?: string;
  /** 工具错误摘要（截断到 2KB） */
  errorSnippet?: string;

  // ========== bash 专属元数据（从 ToolCommandResult.metadata 透传） ==========
  /** bash：shell 退出码（成功通常 0） */
  exitCode?: number | null;
  /** bash：进程信号（如 "SIGKILL"，如果非正常退出） */
  signal?: string | null;
  /** bash：执行工作目录 */
  cwd?: string | null;
  /** bash：是否超时 */
  timedOut?: boolean;
  /** bash：进程 pid（便于关联后台任务） */
  pid?: number | null;
  /** bash：命令执行耗时（ms） */
  durationMs?: number;

  // ========== 产出物（一期核心） ==========
  /** 本次执行产出/变更的文件列表 */
  outputs?: ArtifactEntry[];

  // ========== 二期 US-EH-007/008 双向打通（可选） ==========
  /** 二期：关联的 MemoryEntry id 列表（成功/失败+修复命令沉淀为经验后写回） */
  memoryEntryIds?: string[];
  /** 二期：如果本记录是失败+修复对的第一条（ok=false），
   *  指向同 session 内修复它的后续执行记录 id；无修复时为 null */
  fixedByExecutionId?: string | null;
}

/** ExecutionHistoryStore 构造参数 */
export interface ExecutionHistoryStoreOptions {
  /** 项目根目录（用于计算 projectCode，路径 ~/.deepcode/projects/<projectCode>/execution-history.jsonl） */
  projectRoot: string;
  /** 每 session 最大保留记录数（默认 500）——超出时裁剪最旧记录 */
  maxRecordsPerSession?: number;
  /** 全局记录最大保留天数（默认 100）——超出时裁剪 */
  maxAgeDays?: number;
  /** 内存缓存最大条目数（默认 2000）——按 session 聚合后 FIFO 淘汰 */
  cacheMax?: number;
}

/** ExecutionHistoryStore.query() 查询参数 */
export interface ExecutionHistoryQuery {
  /** 只查指定 sessionId（可选，不传=全项目范围） */
  sessionId?: string;
  /** 只查指定工具名（bash / read / write / edit / skill / ...） */
  toolName?: string;
  /** 只查最近 N 天内的记录（可选，不传=全部） */
  lastDays?: number;
  /** 只查 ok=true 或 ok=false（可选） */
  ok?: boolean;
  /** 关键词模糊搜索（argsSnippet / outputSnippet / cwd 里匹配子串） */
  keyword?: string;
  /** 返回最多 N 条（默认 200） */
  limit?: number;
  /** 从第 N 条开始（分页） */
  offset?: number;
  /** 按 timestamp 排序（默认 desc=true，即最新在前） */
  order?: "asc" | "desc";
}

/** query_execution_history LLM 工具定义的参数（对齐 prompt.ts ToolDefinition.parameters） */
export interface QueryExecutionHistoryToolArgs {
  sessionId?: string;
  toolName?: string;
  lastDays?: number;
  ok?: boolean;
  keyword?: string;
  limit?: number;
}

/** query_execution_history 工具返回结构（LLM 直接读这个 JSON） */
export interface QueryExecutionHistoryToolResult {
  ok: boolean;
  /** 查询到的总记录数（分页前） */
  totalCount: number;
  /** 实际返回的条数（分页后） */
  returnedCount: number;
  /** 截断后的记录详情（敏感字段已处理） */
  records: Array<{
    id: string;
    sessionId: string;
    date: string;
    toolName: string;
    ok: boolean;
    exitCode?: number | null;
    cwd?: string | null;
    durationMs?: number;
    /** args 截断到 500 字符 */
    args: string;
    /** output 截断到 1000 字符 */
    output: string;
    /** 关联产出物数量 */
    outputCount: number;
  }>;
  /** 可能的错误信息（ok=false 时填写） */
  error?: string;
}

// ========== ExecutionHistoryStore.record() 输入参数 ==========
/**
 * ExecutionHistoryStore.record() 的输入参数
 * —— 排除 id / turnIndex / memoryEntryIds / fixedByExecutionId（store 内部自动生成，二期字段永不从 record 传入）
 * —— timestamp / date 也先排除再重新声明为可选：生产代码不传（store 自动 Date.now()），测试可传精确时序
 */
export type ExecutionHistoryRecordInputs = Omit<
  ExecutionRecord,
  "id" | "turnIndex" | "timestamp" | "date" | "memoryEntryIds" | "fixedByExecutionId"
> & {
  /** 可选：timestamp（ms epoch），不传则 store 自动 Date.now() */
  timestamp?: number;
  /** 可选：date（YYYY-MM-DD），不传则 store 自动 ISOString.slice(0,10) */
  date?: string;
};

// ========== 黑名单命令（二期 SummaryBuilder 过滤用，一期定义在此供共用） ==========
/** 不沉淀到 MemoryStore 的低价值 bash 命令名（一期二期共用） */
export const LOW_VALUE_BASH_COMMANDS = new Set([
  "echo",
  "ls",
  "cat",
  "ps",
  "pwd",
  "date",
  "whoami",
  "uname",
  "env",
  "printenv",
]);
