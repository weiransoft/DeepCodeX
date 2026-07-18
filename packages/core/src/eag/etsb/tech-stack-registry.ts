/**
 * 技术选型矩阵注册表（Tech Stack Matrix Registry）
 *
 * 本模块是 EAG 方案 §5.6.1 技术选型矩阵的运行期访问入口：
 * - 维护 4 语言 × 10 层 = 40 单元格的完整技术选型矩阵
 * - 每个单元格包含按 priority 升序排列的候选选项列表
 * - 提供按语言/层查询、全量枚举的 API
 *
 * 设计依据：
 * - EAG 方案 §5.6.1 技术选型矩阵（4 语言 × 10 层）
 * - 矩阵内容严格对齐 §5.6.1 表格，每个单元格的 options 按 priority 排序
 *
 * 矩阵内容说明（严格对齐 §5.6.1 表格）：
 * - TypeScript 系：每层均有完整方案（前端 React/Vue，后端 NestJS/Express 等）
 * - Java 系：前端层无原生方案（采用前后端分离，前端使用 TypeScript 系方案），
 *            其他 9 层均有完整方案
 * - Python 系：同 Java 系（前端层使用 TypeScript 系方案）
 * - Go 系：同 Java 系（前端层使用 TypeScript 系方案）
 *
 * 不可变保证：
 * - TECH_STACK_MATRIX 使用 Object.freeze 深度冻结（顶层 + 嵌套对象）
 * - 注册表初始化后不可修改，对齐 §5.12.4 G-A6d 配置冻结原则
 * - 防止运行期被 LLM 自改导致选型漂移
 *
 * @module eag/etsb/tech-stack-registry
 */

import type { TechLanguage, TechLayer, TechStackMatrix, TechStackOption } from "./types";
import { TECH_LANGUAGES, TECH_LAYERS } from "./types";

// ============================================================================
// 矩阵数据构建（严格对齐 §5.6.1 表格）
// ============================================================================

/**
 * TypeScript 系矩阵（10 层完整方案）
 *
 * 对齐 §5.6.1 表格 TypeScript 列：
 * - 前端：React 18 + TypeScript + Ant Design（首选）/ Vue 3 + Element Plus（备选）
 * - 后端框架：NestJS（首选，DDD 亲和）/ Express（备选）
 * - ORM：Prisma（首选）/ TypeORM（备选）
 * - 缓存：Redis（ioredis）
 * - 消息队列：BullMQ（首选，基于 Redis）/ Kafka（备选，高并发场景）
 * - 对象存储：S3 SDK（S3/OSS/MinIO 统一抽象）
 * - 搜索：Elasticsearch（首选）/ Meilisearch（备选，轻量级）
 * - 任务调度：node-cron（首选）/ BullMQ（备选，分布式）
 * - 认证授权：JWT + Passport（首选）/ Casdoor（备选）
 * - API 契约：OpenAPI（tsoa/zod-to-openapi）
 */
const TYPESCRIPT_MATRIX: Readonly<Record<TechLayer, ReadonlyArray<TechStackOption>>> = Object.freeze({
  frontend: Object.freeze([
    { name: "React 18 + TypeScript + Ant Design", priority: 1, notes: "企业级中后台首选，生态成熟" },
    { name: "Vue 3 + Element Plus", priority: 2, notes: "国内团队熟悉度高" },
  ]),
  "backend-framework": Object.freeze([
    { name: "NestJS", priority: 1, notes: "DDD 亲和" },
    { name: "Express", priority: 2, notes: "轻量灵活" },
  ]),
  orm: Object.freeze([
    { name: "Prisma", priority: 1, notes: "类型安全，迁移管理完善" },
    { name: "TypeORM", priority: 2, notes: "装饰器风格，ActiveRecord/DataMapper 双模式" },
  ]),
  cache: Object.freeze([{ name: "Redis（ioredis）", priority: 1, notes: "高性能键值缓存" }]),
  "message-queue": Object.freeze([
    { name: "BullMQ（Redis）", priority: 1, notes: "基于 Redis，轻量易用" },
    { name: "Kafka", priority: 2, notes: "高吞吐，适合高并发场景" },
  ]),
  "object-storage": Object.freeze([{ name: "S3 SDK（S3/OSS/MinIO 统一抽象）", priority: 1, notes: "多云兼容" }]),
  search: Object.freeze([
    { name: "Elasticsearch", priority: 1, notes: "全文搜索生态成熟" },
    { name: "Meilisearch", priority: 2, notes: "轻量级，适合中小项目" },
  ]),
  "task-scheduler": Object.freeze([
    { name: "node-cron", priority: 1, notes: "轻量定时任务" },
    { name: "BullMQ", priority: 2, notes: "分布式任务队列" },
  ]),
  auth: Object.freeze([
    { name: "JWT + Passport", priority: 1, notes: "通用认证方案" },
    { name: "Casdoor", priority: 2, notes: "统一身份认证平台" },
  ]),
  "api-contract": Object.freeze([{ name: "OpenAPI（tsoa/zod-to-openapi）", priority: 1, notes: "代码生成契约" }]),
});

/**
 * Java 系矩阵（10 层完整方案）
 *
 * 对齐 §5.6.1 表格 Java 列：
 * - 前端：Java 无原生前端框架，采用前后端分离架构，前端使用 TypeScript 系方案
 * - 后端框架：Spring Boot 3 + Spring Data
 * - ORM：MyBatis-Plus（首选）/ JPA（备选）
 * - 缓存：Redis + Caffeine（本地二级缓存）
 * - 消息队列：RocketMQ（首选）/ Kafka（备选）/ RabbitMQ（备选）
 * - 对象存储：OSS SDK（首选）/ MinIO（备选）
 * - 搜索：Elasticsearch
 * - 任务调度：XXL-Job（首选）/ Quartz（备选）
 * - 认证授权：Spring Security + OAuth2（首选）/ Sa-Token（备选）
 * - API 契约：springdoc-openapi
 */
const JAVA_MATRIX: Readonly<Record<TechLayer, ReadonlyArray<TechStackOption>>> = Object.freeze({
  frontend: Object.freeze([
    {
      name: "前后端分离，前端采用 TypeScript 系方案（React 18 + Ant Design）",
      priority: 1,
      notes: "Java 无原生前端框架，前后端分离是企业级标准实践",
    },
  ]),
  "backend-framework": Object.freeze([
    { name: "Spring Boot 3 + Spring Data", priority: 1, notes: "企业级 Java 标准栈" },
  ]),
  orm: Object.freeze([
    { name: "MyBatis-Plus", priority: 1, notes: "国内主流，SQL 灵活可控" },
    { name: "JPA", priority: 2, notes: "标准 ORM，跨数据库兼容性好" },
  ]),
  cache: Object.freeze([{ name: "Redis + Caffeine（本地）", priority: 1, notes: "二级缓存，性能更优" }]),
  "message-queue": Object.freeze([
    { name: "RocketMQ", priority: 1, notes: "阿里开源，事务消息支持完善" },
    { name: "Kafka", priority: 2, notes: "高吞吐，日志/流处理场景" },
    { name: "RabbitMQ", priority: 3, notes: "路由灵活，AMQP 协议标准" },
  ]),
  "object-storage": Object.freeze([
    { name: "OSS SDK", priority: 1, notes: "阿里云对象存储" },
    { name: "MinIO", priority: 2, notes: "自建对象存储，S3 兼容" },
  ]),
  search: Object.freeze([{ name: "Elasticsearch", priority: 1, notes: "全文搜索标准方案" }]),
  "task-scheduler": Object.freeze([
    { name: "XXL-Job", priority: 1, notes: "分布式任务调度平台" },
    { name: "Quartz", priority: 2, notes: "成熟定时任务库" },
  ]),
  auth: Object.freeze([
    { name: "Spring Security + OAuth2", priority: 1, notes: "企业级安全框架" },
    { name: "Sa-Token", priority: 2, notes: "国内轻量级认证框架" },
  ]),
  "api-contract": Object.freeze([{ name: "springdoc-openapi", priority: 1, notes: "Spring Boot 集成 OpenAPI" }]),
});

/**
 * Python 系矩阵（10 层完整方案）
 *
 * 对齐 §5.6.1 表格 Python 列：
 * - 前端：Python 无原生前端框架，采用前后端分离架构，前端使用 TypeScript 系方案
 * - 后端框架：FastAPI（首选）/ Django（备选）
 * - ORM：SQLAlchemy（首选）/ Django ORM（备选）
 * - 缓存：Redis
 * - 消息队列：Celery（首选）/ Kafka（备选）
 * - 对象存储：boto3（首选，AWS S3）/ OSS2（备选，阿里云）
 * - 搜索：Elasticsearch
 * - 任务调度：APScheduler（首选）/ Celery Beat（备选）
 * - 认证授权：JWT + OAuthlib
 * - API 契约：FastAPI 原生
 */
const PYTHON_MATRIX: Readonly<Record<TechLayer, ReadonlyArray<TechStackOption>>> = Object.freeze({
  frontend: Object.freeze([
    {
      name: "前后端分离，前端采用 TypeScript 系方案（React 18 + Ant Design）",
      priority: 1,
      notes: "Python 无原生前端框架，前后端分离是企业级标准实践",
    },
  ]),
  "backend-framework": Object.freeze([
    { name: "FastAPI", priority: 1, notes: "异步高性能，类型提示原生支持" },
    { name: "Django", priority: 2, notes: "全功能框架，admin 后台开箱即用" },
  ]),
  orm: Object.freeze([
    { name: "SQLAlchemy", priority: 1, notes: "Python ORM 事实标准" },
    { name: "Django ORM", priority: 2, notes: "Django 内置，与框架深度集成" },
  ]),
  cache: Object.freeze([{ name: "Redis", priority: 1, notes: "通用缓存方案" }]),
  "message-queue": Object.freeze([
    { name: "Celery", priority: 1, notes: "Python 分布式任务队列标准" },
    { name: "Kafka", priority: 2, notes: "高吞吐消息流" },
  ]),
  "object-storage": Object.freeze([
    { name: "boto3", priority: 1, notes: "AWS S3 SDK" },
    { name: "OSS2", priority: 2, notes: "阿里云 OSS SDK" },
  ]),
  search: Object.freeze([{ name: "Elasticsearch", priority: 1, notes: "全文搜索标准方案" }]),
  "task-scheduler": Object.freeze([
    { name: "APScheduler", priority: 1, notes: "轻量定时任务" },
    { name: "Celery Beat", priority: 2, notes: "Celery 定时任务扩展" },
  ]),
  auth: Object.freeze([{ name: "JWT + OAuthlib", priority: 1, notes: "Python 认证授权标准组合" }]),
  "api-contract": Object.freeze([{ name: "FastAPI 原生", priority: 1, notes: "FastAPI 自动生成 OpenAPI 文档" }]),
});

/**
 * Go 系矩阵（10 层完整方案）
 *
 * 对齐 §5.6.1 表格 Go 列：
 * - 前端：Go 无原生前端框架，采用前后端分离架构，前端使用 TypeScript 系方案
 * - 后端框架：Gin（首选）/ go-zero（备选，微服务框架）
 * - ORM：GORM（首选）/ sqlx（备选，轻量 SQL 库）
 * - 缓存：Redis（go-redis）
 * - 消息队列：Kafka（首选）/ NATS（备选，轻量消息系统）
 * - 对象存储：MinIO Go SDK
 * - 搜索：Elasticsearch
 * - 任务调度：cron（首选，robfig/cron）/ Asynq（备选，基于 Redis）
 * - 认证授权：JWT + Casbin
 * - API 契约：swaggo/swag
 */
const GO_MATRIX: Readonly<Record<TechLayer, ReadonlyArray<TechStackOption>>> = Object.freeze({
  frontend: Object.freeze([
    {
      name: "前后端分离，前端采用 TypeScript 系方案（React 18 + Ant Design）",
      priority: 1,
      notes: "Go 无原生前端框架，前后端分离是企业级标准实践",
    },
  ]),
  "backend-framework": Object.freeze([
    { name: "Gin", priority: 1, notes: "高性能 HTTP 框架" },
    { name: "go-zero", priority: 2, notes: "微服务框架，工具链完善" },
  ]),
  orm: Object.freeze([
    { name: "GORM", priority: 1, notes: "Go 主流 ORM" },
    { name: "sqlx", priority: 2, notes: "轻量 SQL 库，接近原生 SQL" },
  ]),
  cache: Object.freeze([{ name: "Redis（go-redis）", priority: 1, notes: "Go Redis 客户端" }]),
  "message-queue": Object.freeze([
    { name: "Kafka", priority: 1, notes: "高吞吐消息队列" },
    { name: "NATS", priority: 2, notes: "轻量消息系统，云原生友好" },
  ]),
  "object-storage": Object.freeze([{ name: "MinIO Go SDK", priority: 1, notes: "S3 兼容，自建对象存储" }]),
  search: Object.freeze([{ name: "Elasticsearch", priority: 1, notes: "全文搜索标准方案" }]),
  "task-scheduler": Object.freeze([
    { name: "cron", priority: 1, notes: "robfig/cron，轻量定时任务" },
    { name: "Asynq", priority: 2, notes: "基于 Redis 的异步任务队列" },
  ]),
  auth: Object.freeze([{ name: "JWT + Casbin", priority: 1, notes: "认证 + 授权分离，Casbin 支持多种权限模型" }]),
  "api-contract": Object.freeze([{ name: "swaggo/swag", priority: 1, notes: "Go Swagger 文档生成" }]),
});

// ============================================================================
// 完整矩阵（4 语言 × 10 层 = 40 单元格）
// ============================================================================

/**
 * 完整技术选型矩阵常量（4 语言 × 10 层 = 40 单元格）
 *
 * 数据来源：TYPESCRIPT_MATRIX / JAVA_MATRIX / PYTHON_MATRIX / GO_MATRIX 四个子矩阵。
 *
 * 冻结策略：
 * - 顶层 cells 对象冻结
 * - 每个语言的子对象冻结（已在子矩阵定义中冻结）
 * - 每个单元格的 options 数组冻结（已在子矩阵定义中冻结）
 * - 每个 option 对象在子矩阵定义时未单独冻结，但通过深度冻结辅助函数补齐
 *
 * 使用 deepFreeze 辅助函数确保所有层级都被冻结，对齐 §5.12.4 G-A6d 配置冻结原则。
 */
const TECH_STACK_MATRIX_INTERNAL: TechStackMatrix = {
  cells: {
    typescript: TYPESCRIPT_MATRIX,
    java: JAVA_MATRIX,
    python: PYTHON_MATRIX,
    go: GO_MATRIX,
  },
};

/**
 * 深度冻结辅助函数
 *
 * 递归冻结对象的所有嵌套属性，确保矩阵的所有层级都不可变。
 * 对齐 §5.12.4 G-A6d 配置冻结原则——防止运行期被 LLM 自改。
 *
 * 实现说明：
 * - 仅冻结对象类型（typeof === "object" 且非 null）
 * - 跳过函数类型（避免冻结原型链上的方法）
 * - 即使父对象已冻结，仍递归检查子属性（子属性可能未冻结）
 *   —— 这一点至关重要：sub-matrix 常量在声明时已 Object.freeze 顶层，
 *      但其内部 option 对象未冻结，必须通过递归补冻结
 *
 * @param obj 待冻结的对象
 * @returns 冻结后的对象（同引用）
 */
function deepFreeze<T>(obj: T): T {
  // 仅处理对象且非 null
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  // 冻结自身（若未冻结；Object.freeze 幂等，重复调用无副作用）
  if (!Object.isFrozen(obj)) {
    Object.freeze(obj);
  }
  // 关键：无论自身是否已冻结，都必须递归检查子属性。
  // 因为子矩阵常量（如 TYPESCRIPT_MATRIX）声明时仅 Object.freeze 顶层对象与数组，
  // 但数组内的 option 对象（如 { name, priority, notes }）并未冻结，
  // 必须通过递归补冻结才能保证深度不可变。
  // 不使用 !Object.isFrozen(value) 作为递归条件，否则会跳过已冻结父对象的未冻结子属性。
  const keys = Object.keys(obj as Record<string, unknown>);
  for (const key of keys) {
    const value = (obj as Record<string, unknown>)[key];
    // 仅对非 null 对象递归（避免对原始值与 null 递归）
    if (value !== null && typeof value === "object") {
      deepFreeze(value);
    }
  }
  return obj;
}

/**
 * 完整技术选型矩阵（深度冻结后导出）
 *
 * 使用 deepFreeze 确保矩阵的所有层级（顶层 cells / 语言子对象 / 层子对象 /
 * options 数组 / option 对象）均不可变。
 *
 * 对齐 §5.12.4 G-A6d 配置冻结原则——防止运行期被 LLM 自改导致选型漂移。
 */
export const TECH_STACK_MATRIX: Readonly<TechStackMatrix> = Object.freeze(deepFreeze(TECH_STACK_MATRIX_INTERNAL));

// ============================================================================
// 查询 API
// ============================================================================

/**
 * 查询指定语言与层的候选选项列表
 *
 * @param language 语言（4 语言之一）
 * @param layer 层（10 层之一）
 * @returns 该单元格的候选选项列表（按 priority 升序，至少 1 个选项）
 */
export function getTechStackOptions(language: TechLanguage, layer: TechLayer): ReadonlyArray<TechStackOption> {
  return TECH_STACK_MATRIX.cells[language][layer];
}

/**
 * 获取全部技术层（10 层）
 *
 * 返回 TECH_LAYERS 常量，顺序对齐 §5.6.1 表格行序。
 *
 * @returns 10 个技术层字面量数组
 */
export function getAllLayers(): ReadonlyArray<TechLayer> {
  return TECH_LAYERS;
}

/**
 * 获取全部技术语言（4 语言）
 *
 * 返回 TECH_LANGUAGES 常量，顺序对齐 §5.6.1 表格列序。
 *
 * @returns 4 个技术语言字面量数组
 */
export function getAllLanguages(): ReadonlyArray<TechLanguage> {
  return TECH_LANGUAGES;
}

/**
 * 获取矩阵单元格总数（4 语言 × 10 层 = 40）
 *
 * 用于测试断言与配置校验。
 *
 * @returns 单元格总数（40）
 */
export function getMatrixCellCount(): number {
  return TECH_LANGUAGES.length * TECH_LAYERS.length;
}
