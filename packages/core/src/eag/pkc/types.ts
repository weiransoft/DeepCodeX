/**
 * PKC（Project Knowledge Context，项目知识上下文）数据模型（EAG-P1 批次 5）
 *
 * 本模块定义 EAG 方案 §5.11 PKC（项目知识上下文）层所需的全部结构化数据类型。
 * PKC 是 EAG 体系的项目全景地图，让系统像资深程序员一样掌握项目全局视野。
 *
 * PKC 分四层（L1/L2/L3/L4），本批次（P1 批次 5）只实施 L1 全局视野层：
 * - L1：全局视野（Repo Map + 入口点 + 技术栈指纹 + 分层架构识别）
 * - L2：模块级知识（由后续批次实施）
 * - L3：函数级知识（由后续批次实施）
 * - L4：符号级知识图谱与爆炸半径分析（由 V2-P4 实施，§5.11.6）
 *
 * 设计依据：
 * - EAG 方案 §5.11 PKC 项目知识上下文
 * - §5.11.1 L1 全局视野层（目录树 + 模块职责 + 技术栈指纹 + 入口点 + 分层架构）
 * - §5.1 EAK 范式定义（用于分层架构识别）
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d 配置冻结）：
 * - 所有接口字段使用 readonly 修饰
 * - 数组使用 ReadonlyArray<T>
 * - 字面量联合类型避免字符串拼写错误
 * - 顶层配置常量使用 Object.freeze 冻结，防止运行期被 LLM 自改
 *
 * @module eag/pkc/types
 */

// ============================================================================
// 1. PKC 层级与基础结构
// ============================================================================

/**
 * PKC 层级（4 层，字面量联合类型）
 *
 * 对齐 EAG 方案 §5.11 PKC 四层架构：
 * - L1：全局视野层（项目全景地图——目录树/技术栈/入口点/分层架构）
 * - L2：模块级知识（模块边界/依赖关系/接口契约）
 * - L3：函数级知识（函数签名/调用图/副作用）
 * - L4：符号级知识图谱（爆炸半径分析/变更影响传播，§5.11.6，V2-P4 实施）
 *
 * 本批次（P1 批次 5）只实施 L1，L2/L3/L4 由后续批次实施。
 *
 * 字面量联合而非 string，避免拼写错误。
 */
export type PkcLayer = "L1" | "L2" | "L3" | "L4";

/**
 * PkcLayer 全部合法值（用于运行时枚举、测试断言）
 *
 * 使用 Object.freeze 冻结。顺序对应 PKC 层级自然顺序（粗→细）。
 */
export const PKC_LAYERS: ReadonlyArray<PkcLayer> = Object.freeze(["L1", "L2", "L3", "L4"]);

/**
 * 当前批次实施的 PKC 层级（仅 L1）
 *
 * 本批次（P1 批次 5）只实施 L1 全局视野层，L2/L3/L4 由后续批次实施。
 * 此常量用于运行时校验，防止误用未实施的层级。
 */
export const IMPLEMENTED_PKC_LAYERS: ReadonlyArray<PkcLayer> = Object.freeze(["L1"]);

// ============================================================================
// 2. 仓库地图（Repository Map）
// ============================================================================

/**
 * 仓库地图（Repository Map，L1 全局视野的核心数据结构）
 *
 * 描述项目仓库的完整结构：根路径 + 目录树 + 文件列表 + 统计信息。
 * 由 L1GlobalViewBuilder.build(projectRoot) 扫描项目目录后产出。
 *
 * 字段全部 readonly——仓库地图一经构建即不可变，
 * 项目变更需重新扫描生成新的 RepositoryMap。
 *
 * 范例：
 *   {
 *     rootPath: "/tmp/my-project",
 *     directories: [{ path: "src", name: "src", moduleResponsibility: "源代码", children: [...] }],
 *     files: [{ path: "src/index.ts", name: "index.ts", extension: ".ts", lines: 42 }],
 *     totalFiles: 10,
 *     totalDirectories: 3
 *   }
 */
export interface RepositoryMap {
  /** 项目根目录绝对路径 */
  readonly rootPath: string;
  /** 目录节点列表（顶层目录，含子目录递归结构） */
  readonly directories: ReadonlyArray<DirectoryNode>;
  /** 文件节点列表（全部文件，扁平结构，便于扫描入口点/技术栈指纹） */
  readonly files: ReadonlyArray<FileNode>;
  /** 文件总数 */
  readonly totalFiles: number;
  /** 目录总数（含子目录） */
  readonly totalDirectories: number;
}

/**
 * 目录节点（递归结构，描述项目目录树）
 *
 * 每个目录节点含子目录列表（递归），形成完整目录树。
 * moduleResponsibility 字段标注模块职责（如 "源代码" / "测试" / "文档"），
 * 由 L1GlobalViewBuilder 基于目录名启发式识别。
 *
 * 范例：
 *   {
 *     path: "src",
 *     name: "src",
 *     moduleResponsibility: "源代码",
 *     children: [{ path: "src/domain", name: "domain", moduleResponsibility: "领域层", children: [] }]
 *   }
 */
export interface DirectoryNode {
  /** 目录相对路径（相对于 rootPath，如 "src/domain"） */
  readonly path: string;
  /** 目录名（如 "domain"） */
  readonly name: string;
  /** 模块职责标注（如 "源代码" / "测试" / "领域层"，可选） */
  readonly moduleResponsibility?: string;
  /** 子目录列表（递归结构） */
  readonly children: ReadonlyArray<DirectoryNode>;
}

/**
 * 文件节点（描述项目中的单个文件）
 *
 * 文件节点采用扁平结构（不嵌套），便于入口点检测与技术栈指纹提取。
 * lines 字段表示文件行数（用于代码量统计）。
 *
 * 范例：
 *   {
 *     path: "src/index.ts",
 *     name: "index.ts",
 *     extension: ".ts",
 *     lines: 42
 *   }
 */
export interface FileNode {
  /** 文件相对路径（相对于 rootPath，如 "src/index.ts"） */
  readonly path: string;
  /** 文件名（含扩展名，如 "index.ts"） */
  readonly name: string;
  /** 文件扩展名（如 ".ts"、".java"、".py"、".go"） */
  readonly extension: string;
  /** 文件行数（用于代码量统计） */
  readonly lines: number;
}

// ============================================================================
// 3. 入口点（Entry Point）
// ============================================================================

/**
 * 入口点类型（4 类，字面量联合类型）
 *
 * 对齐 EAG 方案 §5.11.1 L1 入口点识别——检测 4 类入口点：
 * - main：主入口（package.json bin/main 字段、index.ts/main.ts/app.ts 等）
 * - http-route：HTTP 路由注册（@Controller/@Get/@Post 装饰器、Express router 调用）
 * - scheduled-task：定时任务（@Cron/cron.schedule/setInterval 等）
 * - mq-consumer：MQ 消费者（@Processor/@RabbitSubscribe/queue.process 等）
 *
 * 字面量联合而非 string，避免拼写错误。
 */
export type EntryPointType = "main" | "http-route" | "scheduled-task" | "mq-consumer";

/**
 * EntryPointType 全部合法值（用于运行时枚举、测试断言）
 *
 * 使用 Object.freeze 冻结。顺序对齐 §5.11.1 入口点识别 4 类顺序。
 */
export const ENTRY_POINT_TYPES: ReadonlyArray<EntryPointType> = Object.freeze([
  "main",
  "http-route",
  "scheduled-task",
  "mq-consumer",
]);

/**
 * 入口点（描述项目中的一类入口点）
 *
 * 入口点是项目对外暴露的功能边界——main 是程序启动入口，
 * http-route 是 HTTP API 入口，scheduled-task 是定时任务入口，
 * mq-consumer 是消息队列消费者入口。
 *
 * 识别入口点有助于 L1 全局视野理解项目的功能分布与边界。
 *
 * 范例：
 *   {
 *     type: "http-route",
 *     filePath: "src/interfaces/UserController.ts",
 *     symbolName: "UserController",
 *     description: "NestJS @Controller 装饰器声明的用户控制器"
 *   }
 */
export interface EntryPoint {
  /** 入口点类型（main/http-route/scheduled-task/mq-consumer） */
  readonly type: EntryPointType;
  /** 入口点所在文件相对路径（如 "src/interfaces/UserController.ts"） */
  readonly filePath: string;
  /** 符号名（函数/类名，如 "UserController"、"main"、"cronJob"） */
  readonly symbolName: string;
  /** 入口点描述（说明入口点的功能与触发方式） */
  readonly description: string;
}

// ============================================================================
// 4. 技术栈指纹（Tech Stack Fingerprint）
// ============================================================================

/**
 * 技术栈指纹（识别项目使用的语言/框架/包管理器/依赖文件）
 *
 * 由 TechStackFingerprintExtractor.extract(map) 从 RepositoryMap 提取，
 * 基于 package.json/pom.xml/requirements.txt/go.mod 等依赖文件识别。
 *
 * 范例：
 *   {
 *     languages: ["typescript", "javascript"],
 *     frameworks: ["NestJS", "Express"],
 *     packageManager: "npm",
 *     dependencyFiles: ["package.json", "tsconfig.json"]
 *   }
 */
export interface TechStackFingerprint {
  /** 编程语言列表（如 ["typescript", "javascript"]） */
  readonly languages: ReadonlyArray<string>;
  /** 框架列表（如 ["NestJS", "Express"]） */
  readonly frameworks: ReadonlyArray<string>;
  /** 包管理器（如 "npm" / "yarn" / "pnpm" / "maven" / "pip" / "go-mod"，可选） */
  readonly packageManager?: string;
  /** 依赖文件列表（如 ["package.json", "tsconfig.json"]） */
  readonly dependencyFiles: ReadonlyArray<string>;
}

// ============================================================================
// 5. 分层架构识别结果（Layered Architecture）
// ============================================================================

/**
 * 分层架构范式（5 类，字面量联合类型）
 *
 * 对齐 EAG 方案 §5.1 EAK 范式定义，识别项目采用的分层架构：
 * - ddd-layered：DDD 分层架构（interfaces/application/domain/infrastructure 四层）
 * - clean-architecture：Clean Architecture（entities/use-cases/adapters/frameworks 同心圆）
 * - cqrs-es：CQRS + Event Sourcing（命令/查询分离 + 事件溯源 + 投影重建）
 * - microservice：微服务（服务边界=限界上下文 + API Gateway + Saga 编排）
 * - unknown：未识别（无足够证据判定）
 *
 * 字面量联合而非 string，避免拼写错误。
 */
export type LayeredArchitectureParadigm = "ddd-layered" | "clean-architecture" | "cqrs-es" | "microservice" | "unknown";

/**
 * 分层架构识别结果
 *
 * 由 TechStackFingerprintExtractor.detectLayeredArchitecture(fingerprint, map) 产出，
 * 基于技术栈指纹 + 目录结构启发式识别项目采用的分层架构。
 *
 * 识别证据（evidence）字段记录判定依据，便于审计与可解释性：
 * - 目录证据：如 "存在 src/domain/ 目录"
 * - 文件证据：如 "存在 NestJS @Controller 装饰器"
 * - 配置证据：如 "package.json 依赖包含 @nestjs/cqrs"
 *
 * 置信度（confidence）字段表示识别结果的可信度，0-1 之间：
 * - 0.0-0.3：低置信度（证据弱，可能误判）
 * - 0.4-0.6：中置信度（有部分证据，需人工确认）
 * - 0.7-1.0：高置信度（证据充分，可信判定）
 *
 * 范例：
 *   {
 *     paradigm: "ddd-layered",
 *     evidence: ["存在 src/domain/ 目录", "存在 src/application/ 目录", "domain 层无外部依赖"],
 *     confidence: 0.85
 *   }
 */
export interface LayeredArchitecture {
  /** 分层架构范式（5 类之一） */
  readonly paradigm: LayeredArchitectureParadigm;
  /** 识别证据列表（每条描述一个判定依据） */
  readonly evidence: ReadonlyArray<string>;
  /** 置信度（0-1，越高越可信） */
  readonly confidence: number;
}

// ============================================================================
// 6. L1 全局视野综合结果
// ============================================================================

/**
 * L1 全局视野综合结果
 *
 * 汇总 L1 层的全部识别结果：
 * - repositoryMap：仓库地图（目录树 + 文件列表）
 * - entryPoints：入口点列表（4 类入口点）
 * - techStackFingerprint：技术栈指纹
 * - layeredArchitecture：分层架构识别结果
 *
 * 此结构作为 L1 层的对外产出，供 L2/L3 层与 Loop 编排器消费。
 */
export interface L1GlobalView {
  /** 仓库地图（目录树 + 文件列表 + 统计信息） */
  readonly repositoryMap: RepositoryMap;
  /** 入口点列表（4 类入口点的综合列表） */
  readonly entryPoints: ReadonlyArray<EntryPoint>;
  /** 技术栈指纹（语言/框架/包管理器/依赖文件） */
  readonly techStackFingerprint: TechStackFingerprint;
  /** 分层架构识别结果（范式/证据/置信度） */
  readonly layeredArchitecture: LayeredArchitecture;
}

// ============================================================================
// 7. 忽略目录配置
// ============================================================================

/**
 * 默认忽略的目录名列表（用于 L1GlobalViewBuilder.shouldIgnore 判定）
 *
 * 这些目录通常包含构建产物/依赖包/版本控制元数据，不应纳入 L1 全局视野扫描：
 * - node_modules：npm/yarn/pnpm 依赖目录
 * - .git：Git 版本控制元数据目录
 * - dist：构建产物目录（TypeScript/JavaScript）
 * - build：构建产物目录（Java/C++）
 * - .next：Next.js 构建产物
 * - .nuxt：Nuxt.js 构建产物
 * - coverage：测试覆盖率报告
 * - .cache：缓存目录
 * - .vscode：VS Code 配置目录
 * - .idea：IntelliJ IDEA 配置目录
 *
 * 使用 Object.freeze 冻结，防止运行期被篡改。
 */
export const DEFAULT_IGNORED_DIRECTORIES: ReadonlyArray<string> = Object.freeze([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "coverage",
  ".cache",
  ".vscode",
  ".idea",
  ".turbo",
  ".parcel-cache",
  "target", // Maven/Java 构建产物
  "__pycache__", // Python 字节码缓存
  ".pytest_cache",
  ".mypy_cache",
  "vendor", // Go/PHP 依赖目录
]);

/**
 * 默认忽略的文件扩展名列表（用于 L1GlobalViewBuilder.shouldIgnore 判定）
 *
 * 这些文件通常是二进制/媒体/锁文件，不纳入代码分析：
 * - 图片：.png/.jpg/.jpeg/.gif/.svg/.ico/.bmp
 * - 字体：.ttf/.woff/.woff2/.eot/.otf
 * - 媒体：.mp3/.mp4/.avi/.mov/.wav/.flac
 * - 文档：.pdf/.docx/.xlsx/.pptx
 * - 压缩：.zip/.tar/.gz/.rar/.7z
 * - 锁文件：.lock（保留 package-lock.json/yarn.lock，单独处理）
 *
 * 使用 Object.freeze 冻结。
 */
export const DEFAULT_IGNORED_EXTENSIONS: ReadonlyArray<string> = Object.freeze([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".ico",
  ".bmp",
  ".ttf",
  ".woff",
  ".woff2",
  ".eot",
  ".otf",
  ".mp3",
  ".mp4",
  ".avi",
  ".mov",
  ".wav",
  ".flac",
  ".pdf",
  ".docx",
  ".xlsx",
  ".pptx",
  ".zip",
  ".tar",
  ".gz",
  ".rar",
  ".7z",
]);
