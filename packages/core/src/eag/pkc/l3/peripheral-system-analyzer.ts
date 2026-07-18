/**
 * K5 周边系统关联分析器实现（EAG-P2 批次 8）
 *
 * 本模块实现 `PeripheralSystemAnalyzer` 类，提供 EAG 方案 §5.11.2 K5 周边系统关联的真实逻辑。
 *
 * 核心职责：
 * - analyze(projectRoot)：扫描项目配置文件，产出 PeripheralAnalysisResult
 * - 配置文件解析（.env / application.yml / application.properties / docker-compose.yml / k8s manifest）
 * - 识别周边系统依赖（数据库 / 消息队列 / 缓存 / 对象存储 / 第三方 API / LDAP / 支付网关）
 * - 构建交互矩阵（依赖方模块 ↔ 周边系统）
 * - 构建配置清单（配置项 key + 默认值 + 生效环境 + 是否敏感 + 来源）
 *
 * §5.11.2 K5 周边系统关联设计要求：
 * - 配置文件/env/docker-compose/k8s 解析
 * - 交互矩阵（系统 ↔ 周边的交互关系）
 * - 配置清单（配置项全清单）
 *
 * 设计依据：
 * - EAG 方案 §5.11.2 K5 周边系统关联
 * - 12-factor App 配置管理（环境变量驱动）
 *
 * 实现说明：
 * - 支持 5 类配置文件：
 *   * .env / .env.{env}：环境变量文件（KEY=VALUE 格式）
 *   * application.yml / application-{env}.yml：Spring Boot 风格 YAML 配置
 *   * application.properties / application-{env}.properties：Java properties 格式
 *   * docker-compose.yml / docker-compose.{env}.yml：Docker Compose 编排
 *   * k8s manifest (.yaml/.yml in k8s/ kubernetes/ manifests/ 目录)：ConfigMap / Secret / Deployment
 * - 依赖识别：基于配置 key 关键词匹配（DATABASE_URL → database, REDIS_URL → cache 等）
 * - 交互矩阵：在源码中搜索配置 key 的使用位置，关联模块与依赖
 * - 配置清单：聚合所有配置 key，标注来源与敏感性
 *
 * 不可变优先：
 * - 公开方法返回冻结对象
 *
 * @module eag/pkc/l3/peripheral-system-analyzer
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  ConfigInventoryEntry,
  InteractionMatrixEntry,
  PeripheralAnalysisResult,
  PeripheralDependency,
  PeripheralDependencyType,
} from "./l3-types";

// ============================================================================
// 配置文件识别规则
// ============================================================================

/**
 * 配置文件名模式
 *
 * 用于识别项目中的配置文件。
 */
interface ConfigFilePattern {
  /** 文件名模式（精确匹配或正则） */
  readonly pattern: RegExp;
  /** 配置来源类型 */
  readonly source: "env" | "docker-compose" | "k8s-configmap" | "application.yml" | "application.properties";
  /** 解析器名（用于分发到具体解析方法） */
  readonly parser: "env" | "yaml" | "properties" | "k8s-manifest";
}

/**
 * 配置文件模式表
 *
 * 覆盖：
 * - .env / .env.local / .env.production / .env.development
 * - application.yml / application-{env}.yml
 * - application.properties / application-{env}.properties
 * - docker-compose.yml / docker-compose.{env}.yml
 */
const CONFIG_FILE_PATTERNS: ReadonlyArray<ConfigFilePattern> = Object.freeze([
  {
    pattern: /^\.env(?:\.[a-z]+)?$/i,
    source: "env",
    parser: "env",
  },
  {
    pattern: /^application(?:-[a-z]+)?\.ya?ml$/i,
    source: "application.yml",
    parser: "yaml",
  },
  {
    pattern: /^application(?:-[a-z]+)?\.properties$/i,
    source: "application.properties",
    parser: "properties",
  },
  {
    pattern: /^docker-compose(?:\.[a-z]+)?\.ya?ml$/i,
    source: "docker-compose",
    parser: "yaml",
  },
]);

/**
 * k8s manifest 目录名
 */
const K8S_MANIFEST_DIRS: ReadonlyArray<string> = Object.freeze([
  "k8s",
  "kubernetes",
  "manifests",
  "deploy",
  "deploy/k8s",
  "helm",
]);

/**
 * k8s manifest 文件扩展名
 */
const K8S_MANIFEST_EXTENSIONS: ReadonlyArray<string> = Object.freeze([".yaml", ".yml"]);

// ============================================================================
// 周边系统依赖识别规则
// ============================================================================

/**
 * 周边系统依赖识别规则
 *
 * 基于配置 key 关键词匹配识别周边系统依赖。
 */
interface DependencyDetectionRule {
  /** 依赖类型 */
  readonly type: PeripheralDependencyType;
  /** 配置 key 关键词模式（正则，匹配则视为该类依赖） */
  readonly keyPatterns: ReadonlyArray<RegExp>;
  /** 技术栈推断模式（从 key 名推断技术栈） */
  readonly techInference: (key: string, value: string) => string;
  /** 依赖名称推断模式 */
  readonly nameInference: (key: string) => string;
}

/**
 * 周边系统依赖识别规则表
 *
 * 覆盖：
 * - database：DATABASE_URL / DB_HOST / MYSQL_HOST / POSTGRES_HOST / MONGODB_URI
 * - message-queue：RABBITMQ_URL / KAFKA_BROKERS / REDIS_HOST（若含 pubsub） / SQS_URL
 * - cache：REDIS_URL / REDIS_HOST / MEMCACHED_URL
 * - object-storage：S3_BUCKET / MINIO_ENDPOINT / OSS_BUCKET / AWS_S3
 * - third-party-api：API_BASE_URL / EXTERNAL_API_URL / WEBHOOK_URL
 * - ldap：LDAP_URL / LDAP_HOST / AD_DOMAIN
 * - payment-gateway：STRIPE_API_KEY / ALIPAY_APP_ID / WXPAY_APP_ID / PAYPAL_CLIENT_ID
 */
const DEPENDENCY_DETECTION_RULES: ReadonlyArray<DependencyDetectionRule> = Object.freeze([
  // 数据库
  {
    type: "database",
    keyPatterns: [
      /^(DATABASE_URL|DB_URL|DB_HOST|DB_CONNECTION|MYSQL_HOST|MYSQL_URL|POSTGRES_HOST|POSTGRES_URL|POSTGRESQL_URL|MONGODB_URI|MONGODB_URL|MONGO_URL|SQLITE_PATH|DB_PATH)$/i,
      /^DB_[A-Z_]+$/i,
      /^DATABASE_[A-Z_]+$/i,
      /^MYSQL_[A-Z_]+$/i,
      /^POSTGRES_[A-Z_]+$/i,
      /^POSTGRESQL_[A-Z_]+$/i,
      /^MONGO[A-Z_]*$/i,
    ],
    techInference: (key, value) => {
      if (/MYSQL/i.test(key)) return "MySQL";
      if (/POSTGRES/i.test(key)) return "PostgreSQL";
      if (/MONGO/i.test(key)) return "MongoDB";
      if (/SQLITE/i.test(key)) return "SQLite";
      if (/^DB_/.test(key)) return "Generic Database";
      if (value && /^postgres:\/\//i.test(value)) return "PostgreSQL";
      if (value && /^mysql:\/\//i.test(value)) return "MySQL";
      if (value && /^mongodb:\/\//i.test(value)) return "MongoDB";
      return "Unknown Database";
    },
    nameInference: (key) => {
      if (/MYSQL/i.test(key)) return "mysql-db";
      if (/POSTGRES/i.test(key)) return "postgres-db";
      if (/MONGO/i.test(key)) return "mongo-db";
      if (/SQLITE/i.test(key)) return "sqlite-db";
      return "primary-db";
    },
  },
  // 消息队列
  {
    type: "message-queue",
    keyPatterns: [
      /^(RABBITMQ_URL|RABBITMQ_HOST|KAFKA_BROKERS|KAFKA_URL|SQS_URL|SNS_ARN|NATS_URL|PULSAR_URL|MQ_URL|AMQP_URL)$/i,
      /^RABBITMQ_[A-Z_]+$/i,
      /^KAFKA_[A-Z_]+$/i,
      /^MQ_[A-Z_]+$/i,
    ],
    techInference: (key) => {
      if (/RABBITMQ|AMQP/i.test(key)) return "RabbitMQ";
      if (/KAFKA/i.test(key)) return "Kafka";
      if (/SQS|SNS/i.test(key)) return "AWS SQS/SNS";
      if (/NATS/i.test(key)) return "NATS";
      if (/PULSAR/i.test(key)) return "Apache Pulsar";
      return "Message Queue";
    },
    nameInference: (key) => {
      if (/RABBITMQ|AMQP/i.test(key)) return "rabbitmq";
      if (/KAFKA/i.test(key)) return "kafka";
      if (/SQS/i.test(key)) return "sqs";
      if (/NATS/i.test(key)) return "nats";
      return "mq";
    },
  },
  // 缓存
  {
    type: "cache",
    keyPatterns: [
      /^(REDIS_URL|REDIS_HOST|REDIS_PORT|MEMCACHED_URL|MEMCACHE_URL|CACHE_URL)$/i,
      /^REDIS_[A-Z_]+$/i,
      /^MEMCACHE[A-Z_]*$/i,
    ],
    techInference: (key) => {
      if (/REDIS/i.test(key)) return "Redis";
      if (/MEMCACHE/i.test(key)) return "Memcached";
      return "Cache";
    },
    nameInference: (key) => {
      if (/REDIS/i.test(key)) return "redis-cache";
      if (/MEMCACHE/i.test(key)) return "memcached-cache";
      return "cache";
    },
  },
  // 对象存储
  {
    type: "object-storage",
    keyPatterns: [
      /^(S3_BUCKET|S3_ENDPOINT|S3_REGION|MINIO_ENDPOINT|OSS_BUCKET|OSS_ENDPOINT|COS_BUCKET|GCS_BUCKET|AZURE_BLOB_CONNECTION|AWS_S3_BUCKET)$/i,
      /^S3_[A-Z_]+$/i,
      /^MINIO_[A-Z_]+$/i,
      /^OSS_[A-Z_]+$/i,
      /^COS_[A-Z_]+$/i,
    ],
    techInference: (key) => {
      if (/^S3_|AWS_S3/i.test(key)) return "AWS S3";
      if (/MINIO/i.test(key)) return "MinIO";
      if (/OSS/i.test(key)) return "Aliyun OSS";
      if (/COS/i.test(key)) return "Tencent COS";
      if (/GCS/i.test(key)) return "Google Cloud Storage";
      if (/AZURE_BLOB/i.test(key)) return "Azure Blob Storage";
      return "Object Storage";
    },
    nameInference: (key) => {
      if (/^S3_|AWS_S3/i.test(key)) return "s3-storage";
      if (/MINIO/i.test(key)) return "minio-storage";
      if (/OSS/i.test(key)) return "oss-storage";
      if (/COS/i.test(key)) return "cos-storage";
      return "object-storage";
    },
  },
  // 第三方 API
  {
    type: "third-party-api",
    keyPatterns: [
      /^(API_BASE_URL|EXTERNAL_API_URL|WEBHOOK_URL|THIRD_PARTY_API|PARTNER_API_URL|SMS_API_URL|EMAIL_API_URL)$/i,
      /^EXTERNAL_[A-Z_]+$/i,
      /^THIRD_PARTY_[A-Z_]+$/i,
    ],
    techInference: (_key, value) => {
      if (value && /^https?:\/\//i.test(value)) return "HTTP/HTTPS API";
      return "Third-party API";
    },
    nameInference: (key) => {
      if (/SMS/i.test(key)) return "sms-api";
      if (/EMAIL/i.test(key)) return "email-api";
      if (/WEBHOOK/i.test(key)) return "webhook";
      return "external-api";
    },
  },
  // LDAP
  {
    type: "ldap",
    keyPatterns: [
      /^(LDAP_URL|LDAP_HOST|LDAP_PORT|LDAP_BASE_DN|LDAP_BIND_DN|AD_DOMAIN|AD_URL|ACTIVE_DIRECTORY_URL)$/i,
      /^LDAP_[A-Z_]+$/i,
      /^AD_[A-Z_]+$/i,
    ],
    techInference: (_key) => "LDAP / Active Directory",
    nameInference: (key) => {
      if (/AD_|ACTIVE_DIRECTORY/i.test(key)) return "active-directory";
      return "ldap";
    },
  },
  // 支付网关
  {
    type: "payment-gateway",
    keyPatterns: [
      /^(STRIPE_API_KEY|STRIPE_SECRET|ALIPAY_APP_ID|ALIPAY_PRIVATE_KEY|WXPAY_APP_ID|WXPAY_MCH_ID|PAYPAL_CLIENT_ID|PAYPAL_SECRET|SQUARE_ACCESS_TOKEN|BRAINTREE_MERCHANT_ID)$/i,
      /^STRIPE_[A-Z_]+$/i,
      /^ALIPAY_[A-Z_]+$/i,
      /^WXPAY_[A-Z_]+$/i,
      /^PAYPAL_[A-Z_]+$/i,
    ],
    techInference: (key) => {
      if (/STRIPE/i.test(key)) return "Stripe";
      if (/ALIPAY/i.test(key)) return "Alipay";
      if (/WXPAY|MCH_ID/i.test(key)) return "WeChat Pay";
      if (/PAYPAL/i.test(key)) return "PayPal";
      if (/SQUARE/i.test(key)) return "Square";
      if (/BRAINTREE/i.test(key)) return "Braintree";
      return "Payment Gateway";
    },
    nameInference: (key) => {
      if (/STRIPE/i.test(key)) return "stripe";
      if (/ALIPAY/i.test(key)) return "alipay";
      if (/WXPAY|MCH_ID/i.test(key)) return "wxpay";
      if (/PAYPAL/i.test(key)) return "paypal";
      return "payment-gateway";
    },
  },
]);

/**
 * 敏感配置 key 识别模式
 *
 * 匹配以下模式的配置 key 视为敏感（含凭据/密钥）：
 * - 含 PASSWORD / PASSWD / PWD / SECRET / TOKEN / KEY / CREDENTIAL
 * - 含 PRIVATE_KEY / ACCESS_KEY / API_KEY / SIGNING_KEY
 */
const SENSITIVE_KEY_PATTERN: RegExp =
  /(?:PASSWORD|PASSWD|PWD|SECRET|TOKEN|PRIVATE_KEY|ACCESS_KEY|API_KEY|SIGNING_KEY|CREDENTIAL|CLIENT_SECRET)/i;

// ============================================================================
// 文件扫描忽略目录与扩展名
// ============================================================================

/**
 * 扫描忽略目录
 */
const IGNORED_DIRECTORIES: ReadonlyArray<string> = Object.freeze([
  "node_modules",
  ".git",
  "dist",
  "build",
  "target",
  "__pycache__",
  ".next",
  ".nuxt",
  ".cache",
  ".turbo",
  "coverage",
  ".idea",
  ".vscode",
]);

/**
 * 配置文件扫描最大深度
 */
const MAX_SCAN_DEPTH: number = 4;

/**
 * 源码文件扩展名（用于交互矩阵搜索）
 */
const SOURCE_EXTENSIONS: ReadonlyArray<string> = Object.freeze([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".java",
  ".py",
  ".go",
]);

/**
 * 配置 key 引用模式（源码中搜索配置 key 使用）
 *
 * 匹配：
 * - process.env.KEY
 * - process.env["KEY"]
 * - System.getenv("KEY")
 * - os.environ["KEY"]
 * - os.Getenv("KEY")
 * - @Value("${key}")
 * - Config.get("key")
 */
const CONFIG_KEY_REFERENCE_PATTERN: RegExp =
  /(?:process\.env\.([A-Z_][A-Z0-9_]+)|process\.env\[\s*['"]([A-Z_][A-Z0-9_]+)['"]\s*\]|System\.getenv\(\s*['"]([A-Z_][A-Z0-9_]+)['"]\s*\)|os\.environ\[\s*['"]([A-Z_][A-Z0-9_]+)['"]\s*\]|os\.environ\.get\(\s*['"]([A-Z_][A-Z0-9_]+)['"]|os\.Getenv\(\s*['"]([A-Z_][A-Z0-9_]+)['"]\s*\))/g;

// ============================================================================
// 异常类型
// ============================================================================

/**
 * 周边系统分析错误
 */
export class PeripheralSystemAnalyzerError extends Error {
  /**
   * @param kind 错误类型
   *   - invalid-path：路径非法
   *   - path-not-found：路径不存在
   *   - scan-error：扫描失败
   * @param detail 错误详情
   */
  constructor(
    public readonly kind: "invalid-path" | "path-not-found" | "scan-error",
    public readonly detail: string
  ) {
    super(`周边系统分析错误 [${kind}]：${detail}`);
    this.name = "PeripheralSystemAnalyzerError";
  }
}

// ============================================================================
// 内部辅助类型
// ============================================================================

/**
 * 已解析的配置项（内部中间结构）
 */
interface ParsedConfigEntry {
  /** 配置 key */
  readonly key: string;
  /** 配置值（脱敏后，仅用于技术栈推断） */
  readonly value: string;
  /** 配置来源 */
  readonly source: ConfigInventoryEntry["source"];
  /** 推断的生效环境（如 production/staging/development） */
  readonly environment?: string;
}

// ============================================================================
// PeripheralSystemAnalyzer 类
// ============================================================================

/**
 * 周边系统分析器（实现 §5.11.2 K5 周边系统关联）
 *
 * 提供真实分析逻辑（禁止 mock）：
 * - analyze：扫描项目根目录，返回 PeripheralAnalysisResult
 * - 解析 .env / application.yml / application.properties / docker-compose.yml / k8s manifest
 * - 识别周边系统依赖（数据库/MQ/缓存/对象存储/第三方 API/LDAP/支付网关）
 * - 构建交互矩阵（依赖方模块 ↔ 周边系统）
 * - 构建配置清单（配置项 key + 默认值 + 生效环境 + 是否敏感 + 来源）
 *
 * 使用方式：
 * ```typescript
 * const analyzer = new PeripheralSystemAnalyzer();
 * const result = await analyzer.analyze("/path/to/project");
 * console.log(result.dependencies.length);
 * console.log(result.configInventory.length);
 * ```
 */
export class PeripheralSystemAnalyzer {
  // ============================ 公共 API ============================

  /**
   * 分析项目周边系统关联
   *
   * 执行流程：
   * 1. 校验 projectRoot 存在
   * 2. 扫描配置文件（.env / application.yml / application.properties / docker-compose / k8s manifest）
   * 3. 解析配置项，识别周边系统依赖（dependencies）
   * 4. 构建交互矩阵（在源码中搜索配置 key 引用 → 关联模块与依赖）
   * 5. 构建配置清单（聚合所有配置 key + 元数据）
   * 6. 返回冻结的 PeripheralAnalysisResult
   *
   * @param projectRoot 项目根目录
   * @returns 周边系统分析结果
   * @throws {PeripheralSystemAnalyzerError} 路径非法或扫描失败时抛出
   */
  async analyze(projectRoot: string): Promise<PeripheralAnalysisResult> {
    // 入参校验
    if (typeof projectRoot !== "string" || projectRoot.trim().length === 0) {
      throw new PeripheralSystemAnalyzerError("invalid-path", "projectRoot 必须为非空字符串");
    }

    // 解析为绝对路径
    const absoluteRoot = path.isAbsolute(projectRoot) ? projectRoot : path.resolve(process.cwd(), projectRoot);

    // 校验路径存在
    let stat;
    try {
      stat = await fs.stat(absoluteRoot);
    } catch (err) {
      throw new PeripheralSystemAnalyzerError(
        "path-not-found",
        `路径不存在：${absoluteRoot}（${(err as Error).message}）`
      );
    }
    if (!stat.isDirectory()) {
      throw new PeripheralSystemAnalyzerError("invalid-path", `projectRoot 必须为目录：${absoluteRoot}`);
    }

    // 1. 收集配置文件
    const configFiles: Array<{
      readonly absPath: string;
      readonly relPath: string;
      readonly pattern: ConfigFilePattern;
    }> = [];
    await this.collectConfigFiles(absoluteRoot, "", configFiles, 0, MAX_SCAN_DEPTH);

    // 收集 k8s manifest 文件
    const k8sFiles: Array<{ readonly absPath: string; readonly relPath: string }> = [];
    await this.collectK8sManifests(absoluteRoot, k8sFiles);

    // 2. 解析配置文件，得到全部配置项
    const allEntries: ParsedConfigEntry[] = [];
    for (const file of configFiles) {
      try {
        const content = await fs.readFile(file.absPath, "utf-8");
        const entries = this.parseConfigFile(content, file.pattern, file.relPath);
        allEntries.push(...entries);
      } catch {
        continue;
      }
    }

    // 解析 k8s manifest（提取 ConfigMap/Secret 中的配置）
    for (const file of k8sFiles) {
      try {
        const content = await fs.readFile(file.absPath, "utf-8");
        const entries = this.parseK8sManifest(content, file.relPath);
        allEntries.push(...entries);
      } catch {
        continue;
      }
    }

    // 3. 识别周边系统依赖
    const dependencies = this.identifyDependencies(allEntries);

    // 4. 构建交互矩阵
    const interactionMatrix = await this.buildInteractionMatrix(absoluteRoot, dependencies);

    // 5. 构建配置清单
    const configInventory = this.buildConfigInventory(allEntries);

    return Object.freeze({
      dependencies: Object.freeze(dependencies.map((d) => Object.freeze({ ...d }))),
      interactionMatrix: Object.freeze(interactionMatrix.map((i) => Object.freeze({ ...i }))),
      configInventory: Object.freeze(configInventory.map((c) => Object.freeze({ ...c }))),
    });
  }

  // ============================ 私有辅助方法 ============================

  /**
   * 递归收集配置文件
   *
   * @param absoluteDir 当前绝对目录
   * @param relativeDir 当前相对目录
   * @param files 文件收集列表
   * @param depth 当前深度
   * @param maxDepth 最大深度
   */
  private async collectConfigFiles(
    absoluteDir: string,
    relativeDir: string,
    files: Array<{ readonly absPath: string; readonly relPath: string; readonly pattern: ConfigFilePattern }>,
    depth: number,
    maxDepth: number
  ): Promise<void> {
    if (depth > maxDepth) {
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(absoluteDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.includes(entry.name)) {
          continue;
        }
        const subAbs = path.join(absoluteDir, entry.name);
        const subRel = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
        await this.collectConfigFiles(subAbs, subRel, files, depth + 1, maxDepth);
      } else if (entry.isFile()) {
        // 匹配配置文件模式
        const matchedPattern = CONFIG_FILE_PATTERNS.find((p) => p.pattern.test(entry.name));
        if (!matchedPattern) continue;
        const absPath = path.join(absoluteDir, entry.name);
        const relPath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
        files.push({ absPath, relPath, pattern: matchedPattern });
      }
    }
  }

  /**
   * 收集 k8s manifest 文件
   *
   * 仅扫描项目根目录下的 k8s/kubernetes/manifests/deploy/helm 目录。
   *
   * @param projectRoot 项目根目录
   * @param files 文件收集列表
   */
  private async collectK8sManifests(
    projectRoot: string,
    files: Array<{ readonly absPath: string; readonly relPath: string }>
  ): Promise<void> {
    for (const dirName of K8S_MANIFEST_DIRS) {
      const dirPath = path.join(projectRoot, dirName);
      let stat;
      try {
        stat = await fs.stat(dirPath);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;

      // 平铺式扫描（不递归子目录，避免过深）
      let entries;
      try {
        entries = await fs.readdir(dirPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (!K8S_MANIFEST_EXTENSIONS.includes(ext)) continue;
        const absPath = path.join(dirPath, entry.name);
        const relPath = path.relative(projectRoot, absPath);
        files.push({ absPath, relPath });
      }
    }
  }

  /**
   * 根据文件类型解析配置文件
   *
   * @param content 文件内容
   * @param pattern 配置文件模式
   * @param relPath 相对路径
   * @returns 配置项列表
   */
  private parseConfigFile(content: string, pattern: ConfigFilePattern, relPath: string): ParsedConfigEntry[] {
    // 推断生效环境（从文件名提取，如 .env.production → production）
    const envMatch = relPath.match(/\.([a-z]+)$/i);
    const environment =
      envMatch &&
      envMatch[1] !== "env" &&
      envMatch[1] !== "yml" &&
      envMatch[1] !== "yaml" &&
      envMatch[1] !== "properties"
        ? envMatch[1]
        : undefined;

    if (pattern.parser === "env") {
      return this.parseEnvFile(content, pattern.source, environment);
    }
    if (pattern.parser === "properties") {
      return this.parsePropertiesFile(content, pattern.source, environment);
    }
    if (pattern.parser === "yaml") {
      return this.parseYamlFile(content, pattern.source, environment);
    }
    return [];
  }

  /**
   * 解析 .env 文件
   *
   * 格式：KEY=VALUE，每行一个配置项。
   * 支持：
   * - 注释行（# 开头）
   * - 引号值（"value" / 'value'）
   * - 空 VALUE
   *
   * @param content .env 文件内容
   * @param source 配置来源
   * @param environment 生效环境
   * @returns 配置项列表
   */
  private parseEnvFile(
    content: string,
    source: ConfigInventoryEntry["source"],
    environment?: string
  ): ParsedConfigEntry[] {
    const entries: ParsedConfigEntry[] = [];
    const lines = content.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      // 跳过空行与注释行
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      // 解析 KEY=VALUE
      const match = trimmed.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/i);
      if (!match) continue;
      const key = match[1];
      let value = match[2];
      // 去除引号
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      // 脱敏处理（仅保留前 4 字符供技术栈推断 URL 前缀）
      const sanitizedValue = this.sanitizeValue(key, value);
      entries.push({
        key,
        value: sanitizedValue,
        source,
        environment,
      });
    }
    return entries;
  }

  /**
   * 解析 properties 文件
   *
   * 格式：key=value，每行一个配置项。
   * 支持：
   * - 注释行（# 或 ! 开头）
   * - 嵌套 key（spring.datasource.url → SPRING_DATASOURCE_URL）
   *
   * @param content properties 文件内容
   * @param source 配置来源
   * @param environment 生效环境
   * @returns 配置项列表
   */
  private parsePropertiesFile(
    content: string,
    source: ConfigInventoryEntry["source"],
    environment?: string
  ): ParsedConfigEntry[] {
    const entries: ParsedConfigEntry[] = [];
    const lines = content.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) {
        continue;
      }
      const match = trimmed.match(/^([a-zA-Z][a-zA-Z0-9_.-]*)\s*=\s*(.*)$/);
      if (!match) continue;
      const key = match[1].toUpperCase().replace(/\./g, "_").replace(/-/g, "_");
      const value = match[2].trim();
      const sanitizedValue = this.sanitizeValue(key, value);
      entries.push({
        key,
        value: sanitizedValue,
        source,
        environment,
      });
    }
    return entries;
  }

  /**
   * 解析 YAML 配置文件（application.yml / docker-compose.yml）
   *
   * 采用简化的 YAML 解析（不依赖外部库）：
   * - 识别顶层 key 与嵌套 key（点号拼接为大写 KEY）
   * - 识别 spring.datasource.url: xxx → SPRING_DATASOURCE_URL
   * - 识别 services.redis.image: redis:7 → SERVICES_REDIS_IMAGE
   * - 跳过 list 项（- xxx）
   *
   * @param content YAML 内容
   * @param source 配置来源
   * @param environment 生效环境
   * @returns 配置项列表
   */
  private parseYamlFile(
    content: string,
    source: ConfigInventoryEntry["source"],
    environment?: string
  ): ParsedConfigEntry[] {
    const entries: ParsedConfigEntry[] = [];
    const lines = content.split("\n");
    // 缩进栈：跟踪当前嵌套路径
    const stack: Array<{ readonly indent: number; readonly key: string }> = [];

    for (const line of lines) {
      // 跳过空行与注释
      if (!line.trim() || line.trim().startsWith("#")) continue;
      // 跳过 list 项（- xxx）
      if (line.trim().startsWith("-")) continue;

      // 计算缩进
      const indentMatch = line.match(/^(\s*)/);
      const indent = indentMatch ? indentMatch[1].length : 0;

      // 弹出栈中比当前缩进深或等的项
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
        stack.pop();
      }

      // 解析 key: value
      const kvMatch = line.trim().match(/^([a-zA-Z_][a-zA-Z0-9_.-]*)\s*:\s*(.*)$/);
      if (!kvMatch) continue;
      const keyPart = kvMatch[1];
      const valuePart = kvMatch[2].trim();

      // 构建完整 key（栈中 key + 当前 key）
      const fullPath = [...stack.map((s) => s.key), keyPart];
      const fullKey = fullPath.join("_").toUpperCase().replace(/-/g, "_");

      // 若 value 非空，记录配置项
      if (valuePart && !valuePart.startsWith("#")) {
        // 去除引号
        let value = valuePart;
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        // 跳过引用其他 anchor 的值（如 *ref）
        if (value.startsWith("*")) continue;
        const sanitizedValue = this.sanitizeValue(fullKey, value);
        entries.push({
          key: fullKey,
          value: sanitizedValue,
          source,
          environment,
        });
      } else {
        // value 为空：可能是嵌套节点，压入栈
        stack.push({ indent, key: keyPart });
      }
    }

    return entries;
  }

  /**
   * 解析 k8s manifest（提取 ConfigMap/Secret 中的配置）
   *
   * 支持 YAML 多文档（---分隔），逐段解析每个 ConfigMap/Secret 的 data 部分。
   *
   * @param content manifest 内容
   * @param relPath 相对路径
   * @returns 配置项列表
   */
  private parseK8sManifest(content: string, relPath: string): ParsedConfigEntry[] {
    const entries: ParsedConfigEntry[] = [];
    const environment = this.inferEnvironmentFromPath(relPath);

    // 按 "---" 分割多文档 YAML
    const documents = content.split(/^---\s*$/m);
    for (const doc of documents) {
      // 仅处理 ConfigMap / Secret 文档
      // 注：kind 必须在行首（避免匹配 xxxkind: 这种子串）
      const kindMatch = doc.match(/(?:^|\n)\s*kind:\s*(ConfigMap|Secret)/i);
      if (!kindMatch) continue;
      const kind = kindMatch[1].toLowerCase();

      // 提取 data: 段落内容（直到下一个顶层非缩进 key 或文档结尾）
      // 注：data 必须在行首（避免匹配 metadata: 中的 data 子串，否则会错误提取 metadata 段）
      // 早期 pattern /data:\s*\n([\s\S]*?)(?=...)/ 会匹配 metadata: 中的 data:，
      // 导致 dataBlock 取到 metadata 段的 name 字段而非真正的 data 段。
      const dataMatch = doc.match(/(?:^|\n)data:\s*\n([\s\S]*?)(?=\n[a-z][a-zA-Z]*:|$)/);
      if (!dataMatch) continue;
      const dataBlock = dataMatch[1];

      // 逐行解析 data 段落中的 KEY: VALUE
      const dataLines = dataBlock.split("\n");
      for (const line of dataLines) {
        // 仅匹配缩进的数据行（形如 "  KEY: value" 或 "  KEY: 'value'"）
        const m = line.match(/^\s+([a-zA-Z_][a-zA-Z0-9_.-]*)\s*:\s*(.*)$/);
        if (!m) continue;
        const key = m[1].toUpperCase().replace(/\./g, "_").replace(/-/g, "_");
        const rawValue = m[2].trim();
        // Secret 的值是 base64 编码，不解析具体值
        if (kind === "secret") {
          entries.push({
            key,
            value: "",
            source: "k8s-configmap",
            environment,
          });
        } else {
          // ConfigMap：去除引号后记录
          const value = rawValue.replace(/^["']|["']$/g, "");
          entries.push({
            key,
            value: this.sanitizeValue(key, value),
            source: "k8s-configmap",
            environment,
          });
        }
      }
    }

    return entries;
  }

  /**
   * 从文件路径推断环境（如 k8s/production/config.yaml → production）
   *
   * @param relPath 文件相对路径
   * @returns 环境名（无法推断返回 undefined）
   */
  private inferEnvironmentFromPath(relPath: string): string | undefined {
    const parts = relPath.split(path.sep);
    for (const part of parts) {
      if (["production", "staging", "development", "dev", "prod", "test", "qa"].includes(part.toLowerCase())) {
        return part.toLowerCase();
      }
    }
    return undefined;
  }

  /**
   * 配置值脱敏
   *
   * 对敏感 key 的值仅保留前缀（用于技术栈推断），其余部分脱敏。
   * - 含 URL scheme（如 postgres://）→ 保留 scheme
   * - 含 password/secret/token/key 的 key → 仅返回空字符串
   *
   * @param key 配置 key
   * @param value 原始值
   * @returns 脱敏后的值
   */
  private sanitizeValue(key: string, value: string): string {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      // 敏感值：仅返回空字符串，但保留 URL scheme 用于技术栈推断
      const schemeMatch = value.match(/^([a-z]+):\/\//i);
      return schemeMatch ? `${schemeMatch[1]}://***` : "";
    }
    // 非敏感值：保留原值
    return value;
  }

  /**
   * 识别周边系统依赖
   *
   * 基于 DEPENDENCY_DETECTION_RULES 规则表，对配置项进行分类识别。
   * 同一类型的多个 key 合并为一个依赖项（取最具体的名称）。
   *
   * @param entries 已解析的配置项
   * @returns 依赖列表
   */
  private identifyDependencies(entries: ReadonlyArray<ParsedConfigEntry>): PeripheralDependency[] {
    const dependencies: PeripheralDependency[] = [];
    const seenTypes = new Set<PeripheralDependencyType>();
    // 记录每个类型对应的全部配置 key
    const typeToKeys = new Map<PeripheralDependencyType, string[]>();
    // 记录每个类型的代表值（用于技术栈推断）
    const typeToValue = new Map<PeripheralDependencyType, string>();

    for (const entry of entries) {
      for (const rule of DEPENDENCY_DETECTION_RULES) {
        if (!rule.keyPatterns.some((p) => p.test(entry.key))) continue;

        // 记录 key
        const keys = typeToKeys.get(rule.type) || [];
        keys.push(entry.key);
        typeToKeys.set(rule.type, keys);

        // 记录代表值（用于技术栈推断，优先 URL 类型的值）
        if (!typeToValue.has(rule.type) || /^([a-z]+):\/\//i.test(entry.value)) {
          typeToValue.set(rule.type, entry.value);
        }

        // 标记类型已识别
        if (!seenTypes.has(rule.type)) {
          seenTypes.add(rule.type);
        }
        break;
      }
    }

    // 构建依赖列表
    for (const type of seenTypes) {
      const keys = typeToKeys.get(type) || [];
      const value = typeToValue.get(type) || "";
      // 取第一个 key 作为名称推断依据
      const representativeKey = keys[0] || "";
      const name = this.inferDependencyName(type, representativeKey);
      const technology = this.inferDependencyTech(type, representativeKey, value);
      // 凭据来源：从配置 key 推断
      const credentialSource = keys.some((k) => SENSITIVE_KEY_PATTERN.test(k))
        ? `env:${keys.find((k) => SENSITIVE_KEY_PATTERN.test(k)) || keys[0]}`
        : `env:${keys[0] || ""}`;

      dependencies.push(
        Object.freeze({
          type,
          name,
          technology,
          configKeys: Object.freeze([...keys]),
          credentialSource,
        })
      );
    }

    return dependencies;
  }

  /**
   * 推断依赖名称
   *
   * @param type 依赖类型
   * @param key 代表 key
   * @returns 依赖名称
   */
  private inferDependencyName(type: PeripheralDependencyType, key: string): string {
    const rule = DEPENDENCY_DETECTION_RULES.find((r) => r.type === type);
    return rule ? rule.nameInference(key) : type;
  }

  /**
   * 推断依赖技术栈
   *
   * @param type 依赖类型
   * @param key 代表 key
   * @param value 代表值
   * @returns 技术栈描述
   */
  private inferDependencyTech(type: PeripheralDependencyType, key: string, value: string): string {
    const rule = DEPENDENCY_DETECTION_RULES.find((r) => r.type === type);
    return rule ? rule.techInference(key, value) : type;
  }

  /**
   * 构建交互矩阵
   *
   * 在源码中搜索配置 key 引用，关联使用模块与依赖。
   *
   * @param projectRoot 项目根目录
   * @param dependencies 已识别的依赖列表
   * @returns 交互矩阵条目列表
   */
  private async buildInteractionMatrix(
    projectRoot: string,
    dependencies: ReadonlyArray<PeripheralDependency>
  ): Promise<InteractionMatrixEntry[]> {
    const matrix: InteractionMatrixEntry[] = [];

    // 构建 key → dependency 映射
    const keyToDependency = new Map<string, PeripheralDependency>();
    for (const dep of dependencies) {
      for (const key of dep.configKeys) {
        keyToDependency.set(key, dep);
      }
    }

    // 收集源码文件
    const sourceFiles: string[] = [];
    await this.collectSourceFiles(projectRoot, "", sourceFiles, 0, 5);

    // 在每个源码文件中搜索配置 key 引用
    for (const filePath of sourceFiles) {
      let content: string;
      try {
        content = await fs.readFile(filePath, "utf-8");
      } catch {
        continue;
      }

      const relPath = path.relative(projectRoot, filePath);

      // 用 Set 去重（同一文件多次引用同一 key 只记录一次）
      const referencedKeys = new Set<string>();
      CONFIG_KEY_REFERENCE_PATTERN.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = CONFIG_KEY_REFERENCE_PATTERN.exec(content)) !== null) {
        // 从 6 个捕获组中找到非空的那个
        const key = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
        if (key) {
          referencedKeys.add(key);
        }
      }

      // 对每个引用的 key，查找对应依赖，构建交互矩阵条目
      for (const key of referencedKeys) {
        const dep = keyToDependency.get(key);
        if (!dep) continue;

        // 推断通信协议（基于依赖类型）
        const protocol = this.inferProtocol(dep.type);

        matrix.push(
          Object.freeze({
            dependentModule: relPath,
            dependency: dep,
            protocol,
            configKey: key,
            credentialSource: dep.credentialSource,
          })
        );
      }
    }

    return matrix;
  }

  /**
   * 推断通信协议
   *
   * @param type 依赖类型
   * @returns 通信协议描述
   */
  private inferProtocol(type: PeripheralDependencyType): string {
    switch (type) {
      case "database":
        return "TCP（数据库协议）";
      case "message-queue":
        return "AMQP/Kafka Protocol";
      case "cache":
        return "RESP（Redis 协议）";
      case "object-storage":
        return "HTTPS（S3 API）";
      case "third-party-api":
        return "HTTPS（REST API）";
      case "ldap":
        return "LDAP（TCP 389/636）";
      case "payment-gateway":
        return "HTTPS（支付 API）";
      default:
        return "Unknown";
    }
  }

  /**
   * 递归收集源码文件（用于交互矩阵搜索）
   *
   * @param absoluteDir 当前绝对目录
   * @param relativeDir 当前相对目录
   * @param files 文件路径收集列表
   * @param depth 当前深度
   * @param maxDepth 最大深度
   */
  private async collectSourceFiles(
    absoluteDir: string,
    relativeDir: string,
    files: string[],
    depth: number,
    maxDepth: number
  ): Promise<void> {
    if (depth > maxDepth) {
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(absoluteDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.includes(entry.name)) {
          continue;
        }
        const subAbs = path.join(absoluteDir, entry.name);
        const subRel = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
        await this.collectSourceFiles(subAbs, subRel, files, depth + 1, maxDepth);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!SOURCE_EXTENSIONS.includes(ext)) continue;
        files.push(path.join(absoluteDir, entry.name));
      }
    }
  }

  /**
   * 构建配置清单
   *
   * 聚合所有配置项，去重后构建配置清单。
   * 同一 key 在不同环境下出现时合并生效环境列表。
   *
   * @param entries 已解析的配置项
   * @returns 配置清单条目列表
   */
  private buildConfigInventory(entries: ReadonlyArray<ParsedConfigEntry>): ConfigInventoryEntry[] {
    const inventory: ConfigInventoryEntry[] = [];
    // key → 环境集合 + 默认值 + 来源
    const keyMap = new Map<
      string,
      {
        readonly defaultValue?: string;
        readonly source: ConfigInventoryEntry["source"];
        readonly environments: Set<string>;
      }
    >();

    for (const entry of entries) {
      const existing = keyMap.get(entry.key);
      if (existing) {
        // 合并环境
        if (entry.environment) {
          existing.environments.add(entry.environment);
        }
      } else {
        // 新增配置项
        keyMap.set(entry.key, {
          defaultValue: entry.value || undefined,
          source: entry.source,
          environments: new Set(entry.environment ? [entry.environment] : []),
        });
      }
    }

    for (const [key, info] of keyMap) {
      inventory.push(
        Object.freeze({
          key,
          defaultValue: info.defaultValue,
          effectiveEnvironments: Object.freeze([...info.environments]),
          isSensitive: SENSITIVE_KEY_PATTERN.test(key),
          source: info.source,
        })
      );
    }

    return inventory;
  }
}
