/**
 * EAG-P2 批次 8 单元测试：L3 周边系统关联分析器（PeripheralSystemAnalyzer）
 *
 * 测试范围：
 * - T1. PeripheralSystemAnalyzer 实例化
 * - T2. analyze 入参校验（空路径 / 不存在路径 / 文件路径）
 * - T3. .env 文件解析（KEY=VALUE + 注释 + 引号）
 * - T4. application.properties 文件解析（嵌套 key 转大写下划线）
 * - T5. application.yml 文件解析（嵌套结构 + 缩进栈）
 * - T6. docker-compose.yml 文件解析（services.* 配置）
 * - T7. k8s ConfigMap manifest 解析（data 段 key:value）
 * - T8. k8s Secret manifest 解析（data 段 value 脱敏为空）
 * - T9. 识别 database 依赖（DATABASE_URL → PostgreSQL）
 * - T10. 识别 cache 依赖（REDIS_URL → Redis）
 * - T11. 识别 message-queue 依赖（RABBITMQ_URL → RabbitMQ）
 * - T12. 识别 object-storage 依赖（S3_BUCKET → AWS S3）
 * - T13. 识别 payment-gateway 依赖（STRIPE_API_KEY → Stripe）
 * - T14. 识别 ldap 依赖（LDAP_URL）
 * - T15. 识别 third-party-api 依赖（API_BASE_URL）
 * - T16. 敏感配置 key 标注（PASSWORD/SECRET/TOKEN/KEY）
 * - T17. 配置值脱敏（敏感 key 的原值不返回）
 * - T18. 交互矩阵（源码 process.env.X 引用 → 关联依赖）
 * - T19. 配置清单多环境合并（.env.production + .env.staging 同 key）
 * - T20. 不可变性（PeripheralAnalysisResult 冻结）
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，使用真实文件系统（fs.mkdtemp 创建临时目录）
 * - 测试用例独立、可重复，每个用例自己创建与清理临时目录
 * - 中文详细注释，符合项目代码规范
 *
 * @module core/tests/eag-pkc-l3-peripheral-system
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { PeripheralSystemAnalyzer, PeripheralSystemAnalyzerError } from "../eag/pkc/l3/peripheral-system-analyzer";

// ============================================================================
// 辅助函数：创建临时项目目录与文件
// ============================================================================

/**
 * 创建临时项目目录
 *
 * @returns 临时项目根目录绝对路径
 */
async function createTempProject(): Promise<string> {
  // 使用 eag-pkc-periph- 前缀，便于区分
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "eag-pkc-periph-"));
  return tmpDir;
}

/**
 * 递归删除目录（测试结束后清理）
 *
 * @param dirPath 待删除目录
 */
async function removeTempDir(dirPath: string): Promise<void> {
  try {
    await fs.rm(dirPath, { recursive: true, force: true });
  } catch {
    // 忽略删除失败
  }
}

/**
 * 写入文件（自动创建父目录）
 *
 * @param projectRoot 项目根目录
 * @param relativePath 文件相对路径
 * @param content 文件内容
 */
async function writeProjectFile(projectRoot: string, relativePath: string, content: string): Promise<void> {
  const absolutePath = path.join(projectRoot, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, "utf-8");
}

// ============================================================================
// T1. PeripheralSystemAnalyzer 实例化
// ============================================================================

test("T1a. PeripheralSystemAnalyzer 可实例化", () => {
  const analyzer = new PeripheralSystemAnalyzer();
  assert.ok(analyzer, "analyzer 应为非空对象");
  assert.equal(typeof analyzer.analyze, "function", "analyze 应为方法");
});

// ============================================================================
// T2. analyze 入参校验
// ============================================================================

test("T2a. analyze 空 projectRoot 抛 invalid-path", async () => {
  const analyzer = new PeripheralSystemAnalyzer();
  await assert.rejects(
    () => analyzer.analyze(""),
    (err: unknown) => {
      assert.ok(err instanceof PeripheralSystemAnalyzerError, "应为 PeripheralSystemAnalyzerError");
      assert.equal((err as PeripheralSystemAnalyzerError).kind, "invalid-path");
      return true;
    }
  );
});

test("T2b. analyze 空白 projectRoot 抛 invalid-path", async () => {
  const analyzer = new PeripheralSystemAnalyzer();
  await assert.rejects(
    () => analyzer.analyze("   "),
    (err: unknown) => {
      assert.ok(err instanceof PeripheralSystemAnalyzerError);
      assert.equal((err as PeripheralSystemAnalyzerError).kind, "invalid-path");
      return true;
    }
  );
});

test("T2c. analyze 不存在的路径抛 path-not-found", async () => {
  const analyzer = new PeripheralSystemAnalyzer();
  const notExistPath = path.join(os.tmpdir(), `eag-pkc-periph-not-exist-${Date.now()}`);
  await assert.rejects(
    () => analyzer.analyze(notExistPath),
    (err: unknown) => {
      assert.ok(err instanceof PeripheralSystemAnalyzerError);
      assert.equal((err as PeripheralSystemAnalyzerError).kind, "path-not-found");
      return true;
    }
  );
});

test("T2d. analyze 文件路径（非目录）抛 invalid-path", async () => {
  const tmpDir = await createTempProject();
  try {
    const filePath = path.join(tmpDir, "not-a-dir.txt");
    await fs.writeFile(filePath, "hello", "utf-8");
    const analyzer = new PeripheralSystemAnalyzer();
    await assert.rejects(
      () => analyzer.analyze(filePath),
      (err: unknown) => {
        assert.ok(err instanceof PeripheralSystemAnalyzerError);
        assert.equal((err as PeripheralSystemAnalyzerError).kind, "invalid-path");
        return true;
      }
    );
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T3. .env 文件解析
// ============================================================================

test("T3a. 解析 .env 文件中的 KEY=VALUE", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      ".env",
      [
        "# 主数据库配置",
        "DATABASE_URL=postgres://user:pass@localhost:5432/mydb",
        "REDIS_URL=redis://localhost:6379",
        "APP_PORT=3000",
        "",
      ].join("\n")
    );
    const analyzer = new PeripheralSystemAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    // 应识别到三个配置项
    const keys = result.configInventory.map((c) => c.key);
    assert.ok(keys.includes("DATABASE_URL"), "应包含 DATABASE_URL");
    assert.ok(keys.includes("REDIS_URL"), "应包含 REDIS_URL");
    assert.ok(keys.includes("APP_PORT"), "应包含 APP_PORT");
    // APP_PORT 非敏感
    const appPort = result.configInventory.find((c) => c.key === "APP_PORT");
    assert.ok(appPort);
    assert.equal(appPort!.isSensitive, false, "APP_PORT 不应敏感");
    assert.equal(appPort!.source, "env", "来源应为 env");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T3b. .env 文件支持引号值", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      ".env",
      ['APP_NAME="my-application"', "APP_ENV='production'", "APP_TIMEOUT=30", ""].join("\n")
    );
    const analyzer = new PeripheralSystemAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    const appName = result.configInventory.find((c) => c.key === "APP_NAME");
    assert.ok(appName);
    // 引号应被去除
    assert.equal(appName!.defaultValue, "my-application", "双引号应被去除");
    const appEnv = result.configInventory.find((c) => c.key === "APP_ENV");
    assert.ok(appEnv);
    assert.equal(appEnv!.defaultValue, "production", "单引号应被去除");
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T4. application.properties 文件解析
// ============================================================================

test("T4a. 解析 application.properties 嵌套 key 转大写下划线", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "application.properties",
      [
        "# Spring Boot 配置",
        "server.port=8080",
        "spring.datasource.url=jdbc:postgresql://localhost:5432/mydb",
        "spring.datasource.username=admin",
        "spring.datasource.password=secret",
        "",
      ].join("\n")
    );
    const analyzer = new PeripheralSystemAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    // spring.datasource.url → SPRING_DATASOURCE_URL
    const dsUrl = result.configInventory.find((c) => c.key === "SPRING_DATASOURCE_URL");
    assert.ok(dsUrl, "应识别 SPRING_DATASOURCE_URL");
    assert.equal(dsUrl!.source, "application.properties");
    // spring.datasource.password → SPRING_DATASOURCE_PASSWORD（敏感）
    const dsPassword = result.configInventory.find((c) => c.key === "SPRING_DATASOURCE_PASSWORD");
    assert.ok(dsPassword, "应识别 SPRING_DATASOURCE_PASSWORD");
    assert.equal(dsPassword!.isSensitive, true, "PASSWORD 应为敏感");
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T5. application.yml 文件解析
// ============================================================================

test("T5a. 解析 application.yml 嵌套结构", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "application.yml",
      [
        "server:",
        "  port: 8080",
        "  host: localhost",
        "spring:",
        "  datasource:",
        "    url: jdbc:postgresql://localhost:5432/mydb",
        "    username: admin",
        "  redis:",
        "    host: redis-host",
        "    port: 6379",
        "",
      ].join("\n")
    );
    const analyzer = new PeripheralSystemAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    // server.port → SERVER_PORT
    const serverPort = result.configInventory.find((c) => c.key === "SERVER_PORT");
    assert.ok(serverPort, "应识别 SERVER_PORT");
    assert.equal(serverPort!.source, "application.yml");
    // spring.datasource.url → SPRING_DATASOURCE_URL
    const dsUrl = result.configInventory.find((c) => c.key === "SPRING_DATASOURCE_URL");
    assert.ok(dsUrl, "应识别 SPRING_DATASOURCE_URL");
    // spring.redis.host → SPRING_REDIS_HOST
    const redisHost = result.configInventory.find((c) => c.key === "SPRING_REDIS_HOST");
    assert.ok(redisHost, "应识别 SPRING_REDIS_HOST");
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T6. docker-compose.yml 文件解析
// ============================================================================

test("T6a. 解析 docker-compose.yml services 配置", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "docker-compose.yml",
      [
        "version: '3.8'",
        "services:",
        "  postgres:",
        "    image: postgres:15",
        "    environment:",
        "      POSTGRES_PASSWORD: secretpass",
        "  redis:",
        "    image: redis:7",
        "    ports:",
        '      - "6379:6379"',
        "",
      ].join("\n")
    );
    const analyzer = new PeripheralSystemAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    // 应识别到 docker-compose 来源的配置项
    const dockerEntries = result.configInventory.filter((c) => c.source === "docker-compose");
    assert.ok(dockerEntries.length > 0, "应有 docker-compose 来源的配置");
    // image 配置项（如 SERVICES_POSTGRES_IMAGE）
    const postgresImage = result.configInventory.find((c) => c.key === "SERVICES_POSTGRES_IMAGE");
    assert.ok(postgresImage, "应识别 SERVICES_POSTGRES_IMAGE");
    assert.equal(postgresImage!.defaultValue, "postgres:15");
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T7. k8s ConfigMap manifest 解析
// ============================================================================

test("T7a. 解析 k8s ConfigMap data 段", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "k8s/configmap.yaml",
      [
        "apiVersion: v1",
        "kind: ConfigMap",
        "metadata:",
        "  name: app-config",
        "data:",
        "  DATABASE_URL: postgres://localhost:5432/mydb",
        "  APP_PORT: '3000'",
        "  LOG_LEVEL: info",
        "",
      ].join("\n")
    );
    const analyzer = new PeripheralSystemAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    const dbUrl = result.configInventory.find((c) => c.key === "DATABASE_URL");
    assert.ok(dbUrl, "应识别 ConfigMap 中的 DATABASE_URL");
    assert.equal(dbUrl!.source, "k8s-configmap", "来源应为 k8s-configmap");
    const appPort = result.configInventory.find((c) => c.key === "APP_PORT");
    assert.ok(appPort, "应识别 ConfigMap 中的 APP_PORT");
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T8. k8s Secret manifest 解析
// ============================================================================

test("T8a. 解析 k8s Secret data 段（值脱敏为空）", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "k8s/secret.yaml",
      [
        "apiVersion: v1",
        "kind: Secret",
        "metadata:",
        "  name: app-secret",
        "type: Opaque",
        "data:",
        "  DATABASE_PASSWORD: c2VjcmV0LXBhc3M=", // base64 of "secret-pass"
        "  API_KEY: YWJjZGVmZ2hpamtsbW5vcA==",
        "",
      ].join("\n")
    );
    const analyzer = new PeripheralSystemAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    // Secret 的值应被脱敏为空
    const dbPassword = result.configInventory.find((c) => c.key === "DATABASE_PASSWORD");
    assert.ok(dbPassword, "应识别 Secret 中的 DATABASE_PASSWORD");
    assert.equal(dbPassword!.source, "k8s-configmap", "Secret 也归入 k8s-configmap 来源");
    // 注：Secret 的 value 在解析时已脱敏为空字符串，buildConfigInventory 中 entry.value || undefined 会转为 undefined
    assert.equal(dbPassword!.defaultValue, undefined, "Secret 值不应保留原值");
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T9. 识别 database 依赖
// ============================================================================

test("T9a. 识别 DATABASE_URL → PostgreSQL 数据库依赖", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      ".env",
      ["DATABASE_URL=postgres://user:pass@localhost:5432/mydb", "DATABASE_POOL_SIZE=10", ""].join("\n")
    );
    const analyzer = new PeripheralSystemAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    const dbDep = result.dependencies.find((d) => d.type === "database");
    assert.ok(dbDep, "应识别 database 依赖");
    // 技术栈：URL scheme 为 postgres:// → PostgreSQL
    assert.equal(dbDep!.technology, "PostgreSQL", "应推断为 PostgreSQL");
    // configKeys 应包含 DATABASE_URL 与 DATABASE_POOL_SIZE
    assert.ok(dbDep!.configKeys.includes("DATABASE_URL"), "应含 DATABASE_URL");
    assert.ok(dbDep!.configKeys.includes("DATABASE_POOL_SIZE"), "应含 DATABASE_POOL_SIZE");
    // 凭据来源含 env: 前缀
    assert.ok(dbDep!.credentialSource.startsWith("env:"), "凭据来源应以 env: 开头");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T9b. 识别 MYSQL_HOST → MySQL 数据库依赖", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(tmpDir, ".env", ["MYSQL_HOST=localhost", "MYSQL_PORT=3306", ""].join("\n"));
    const analyzer = new PeripheralSystemAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    const dbDep = result.dependencies.find((d) => d.type === "database");
    assert.ok(dbDep, "应识别 database 依赖");
    assert.equal(dbDep!.technology, "MySQL", "应推断为 MySQL");
    assert.equal(dbDep!.name, "mysql-db", "名称应为 mysql-db");
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T10. 识别 cache 依赖
// ============================================================================

test("T10a. 识别 REDIS_URL → Redis 缓存依赖", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      ".env",
      ["REDIS_URL=redis://localhost:6379", "REDIS_PASSWORD=secret", ""].join("\n")
    );
    const analyzer = new PeripheralSystemAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    const cacheDep = result.dependencies.find((d) => d.type === "cache");
    assert.ok(cacheDep, "应识别 cache 依赖");
    assert.equal(cacheDep!.technology, "Redis", "应推断为 Redis");
    assert.equal(cacheDep!.name, "redis-cache", "名称应为 redis-cache");
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T11. 识别 message-queue 依赖
// ============================================================================

test("T11a. 识别 RABBITMQ_URL → RabbitMQ 消息队列依赖", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      ".env",
      ["RABBITMQ_URL=amqp://localhost:5672", "RABBITMQ_USER=guest", ""].join("\n")
    );
    const analyzer = new PeripheralSystemAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    const mqDep = result.dependencies.find((d) => d.type === "message-queue");
    assert.ok(mqDep, "应识别 message-queue 依赖");
    assert.equal(mqDep!.technology, "RabbitMQ", "应推断为 RabbitMQ");
    assert.equal(mqDep!.name, "rabbitmq", "名称应为 rabbitmq");
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T12. 识别 object-storage 依赖
// ============================================================================

test("T12a. 识别 S3_BUCKET → AWS S3 对象存储依赖", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      ".env",
      ["S3_BUCKET=my-app-bucket", "S3_REGION=us-east-1", "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE", ""].join("\n")
    );
    const analyzer = new PeripheralSystemAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    const storageDep = result.dependencies.find((d) => d.type === "object-storage");
    assert.ok(storageDep, "应识别 object-storage 依赖");
    assert.equal(storageDep!.technology, "AWS S3", "应推断为 AWS S3");
    assert.equal(storageDep!.name, "s3-storage", "名称应为 s3-storage");
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T13. 识别 payment-gateway 依赖
// ============================================================================

test("T13a. 识别 STRIPE_API_KEY → Stripe 支付网关依赖", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      ".env",
      ["STRIPE_API_KEY=sk_test_abcdef", "STRIPE_WEBHOOK_SECRET=whsec_xxx", ""].join("\n")
    );
    const analyzer = new PeripheralSystemAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    const payDep = result.dependencies.find((d) => d.type === "payment-gateway");
    assert.ok(payDep, "应识别 payment-gateway 依赖");
    assert.equal(payDep!.technology, "Stripe", "应推断为 Stripe");
    assert.equal(payDep!.name, "stripe", "名称应为 stripe");
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T14. 识别 ldap 依赖
// ============================================================================

test("T14a. 识别 LDAP_URL → LDAP 依赖", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      ".env",
      ["LDAP_URL=ldap://ldap.example.com:389", "LDAP_BASE_DN=dc=example,dc=com", ""].join("\n")
    );
    const analyzer = new PeripheralSystemAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    const ldapDep = result.dependencies.find((d) => d.type === "ldap");
    assert.ok(ldapDep, "应识别 ldap 依赖");
    assert.equal(ldapDep!.technology, "LDAP / Active Directory", "应推断为 LDAP");
    assert.equal(ldapDep!.name, "ldap", "名称应为 ldap");
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T15. 识别 third-party-api 依赖
// ============================================================================

test("T15a. 识别 API_BASE_URL → 第三方 API 依赖", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      ".env",
      ["API_BASE_URL=https://api.example.com/v1", "WEBHOOK_URL=https://hooks.example.com", ""].join("\n")
    );
    const analyzer = new PeripheralSystemAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    const apiDep = result.dependencies.find((d) => d.type === "third-party-api");
    assert.ok(apiDep, "应识别 third-party-api 依赖");
    assert.equal(apiDep!.technology, "HTTP/HTTPS API", "应推断为 HTTP/HTTPS API");
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T16. 敏感配置 key 标注
// ============================================================================

test("T16a. 含 PASSWORD 的 key 标注为敏感", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(tmpDir, ".env", ["DB_PASSWORD=secret123", "DB_HOST=localhost", ""].join("\n"));
    const analyzer = new PeripheralSystemAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    const dbPassword = result.configInventory.find((c) => c.key === "DB_PASSWORD");
    assert.ok(dbPassword);
    assert.equal(dbPassword!.isSensitive, true, "DB_PASSWORD 应为敏感");
    const dbHost = result.configInventory.find((c) => c.key === "DB_HOST");
    assert.ok(dbHost);
    assert.equal(dbHost!.isSensitive, false, "DB_HOST 不应敏感");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T16b. 含 SECRET/TOKEN/KEY 的 key 标注为敏感", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      ".env",
      ["JWT_SECRET=my-secret", "API_TOKEN=my-token", "ACCESS_KEY=my-access-key", "APP_NAME=myapp", ""].join("\n")
    );
    const analyzer = new PeripheralSystemAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    assert.equal(result.configInventory.find((c) => c.key === "JWT_SECRET")!.isSensitive, true, "JWT_SECRET 应敏感");
    assert.equal(result.configInventory.find((c) => c.key === "API_TOKEN")!.isSensitive, true, "API_TOKEN 应敏感");
    assert.equal(result.configInventory.find((c) => c.key === "ACCESS_KEY")!.isSensitive, true, "ACCESS_KEY 应敏感");
    assert.equal(result.configInventory.find((c) => c.key === "APP_NAME")!.isSensitive, false, "APP_NAME 不应敏感");
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T17. 配置值脱敏
// ============================================================================

test("T17a. 敏感 key 的值脱敏后不返回原值", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      ".env",
      [
        "DB_PASSWORD=super-secret-password-123",
        "API_KEY=sk_live_abcdef123456",
        "DATABASE_URL=postgres://user:pass@localhost:5432/mydb",
        "",
      ].join("\n")
    );
    const analyzer = new PeripheralSystemAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    // DB_PASSWORD 应脱敏为空字符串
    const dbPassword = result.configInventory.find((c) => c.key === "DB_PASSWORD");
    assert.ok(dbPassword);
    assert.notEqual(dbPassword!.defaultValue, "super-secret-password-123", "不应返回原密码值");
    // API_KEY 应脱敏为空字符串
    const apiKey = result.configInventory.find((c) => c.key === "API_KEY");
    assert.ok(apiKey);
    assert.notEqual(apiKey!.defaultValue, "sk_live_abcdef123456", "不应返回原 API key 值");
    // DATABASE_URL 含 password 但 key 本身不含敏感词 → 不脱敏
    // 注：DATABASE_URL 不匹配 SENSITIVE_KEY_PATTERN，故原值保留（但实际密码已嵌入 URL 中，这是已知限制）
    const dbUrl = result.configInventory.find((c) => c.key === "DATABASE_URL");
    assert.ok(dbUrl);
    // DATABASE_URL 不匹配 SENSITIVE_KEY_PATTERN，原值保留
    assert.equal(
      dbUrl!.defaultValue,
      "postgres://user:pass@localhost:5432/mydb",
      "DATABASE_URL 非敏感 key，原值应保留"
    );
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T18. 交互矩阵
// ============================================================================

test("T18a. 源码 process.env.X 引用 → 关联依赖", async () => {
  const tmpDir = await createTempProject();
  try {
    // 写入 .env 定义 DATABASE_URL
    await writeProjectFile(tmpDir, ".env", ["DATABASE_URL=postgres://localhost:5432/mydb", ""].join("\n"));
    // 写入源码引用 process.env.DATABASE_URL
    await writeProjectFile(
      tmpDir,
      "src/services/UserService.ts",
      [
        "import { Pool } from 'pg';",
        "",
        "const pool = new Pool({",
        "  connectionString: process.env.DATABASE_URL,",
        "});",
        "",
        "export class UserService {",
        "  async findById(id: number) {",
        "    return pool.query('SELECT * FROM users WHERE id = $1', [id]);",
        "  }",
        "}",
        "",
      ].join("\n")
    );
    const analyzer = new PeripheralSystemAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    // 交互矩阵应含 UserService.ts → database 依赖
    const matrixEntries = result.interactionMatrix.filter((m) => m.dependency.type === "database");
    assert.ok(matrixEntries.length > 0, "应有 database 交互矩阵条目");
    const userServiceEntry = matrixEntries.find((m) => m.dependentModule.includes("UserService"));
    assert.ok(userServiceEntry, "应有 UserService → database 条目");
    assert.equal(userServiceEntry!.configKey, "DATABASE_URL", "configKey 应为 DATABASE_URL");
    assert.equal(userServiceEntry!.protocol, "TCP（数据库协议）", "协议应为 TCP（数据库协议）");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T18b. 多语言配置引用（System.getenv / os.environ）", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(tmpDir, ".env", ["REDIS_URL=redis://localhost:6379", ""].join("\n"));
    // Java 风格引用
    await writeProjectFile(
      tmpDir,
      "src/services/CacheService.java",
      ["public class CacheService {", '  private String redisUrl = System.getenv("REDIS_URL");', "}", ""].join("\n")
    );
    // Python 风格引用
    await writeProjectFile(
      tmpDir,
      "src/services/CacheClient.py",
      ["import os", "", 'redis_url = os.environ["REDIS_URL"]', ""].join("\n")
    );
    const analyzer = new PeripheralSystemAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    const cacheEntries = result.interactionMatrix.filter((m) => m.dependency.type === "cache");
    assert.ok(cacheEntries.length >= 2, "应有至少 2 个 cache 交互矩阵条目（Java + Python）");
    // 验证 Java 引用
    const javaEntry = cacheEntries.find((m) => m.dependentModule.includes("CacheService.java"));
    assert.ok(javaEntry, "应有 Java CacheService → cache 条目");
    // 验证 Python 引用
    const pyEntry = cacheEntries.find((m) => m.dependentModule.includes("CacheClient.py"));
    assert.ok(pyEntry, "应有 Python CacheClient → cache 条目");
    assert.equal(pyEntry!.protocol, "RESP（Redis 协议）", "协议应为 RESP");
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T19. 配置清单多环境合并
// ============================================================================

test("T19a. .env.production 与 .env.staging 同 key 合并环境", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(tmpDir, ".env.production", ["DATABASE_URL=postgres://prod-db:5432/myapp", ""].join("\n"));
    await writeProjectFile(tmpDir, ".env.staging", ["DATABASE_URL=postgres://staging-db:5432/myapp", ""].join("\n"));
    const analyzer = new PeripheralSystemAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    const dbUrl = result.configInventory.find((c) => c.key === "DATABASE_URL");
    assert.ok(dbUrl);
    // 生效环境列表应包含 production 与 staging
    assert.ok(dbUrl!.effectiveEnvironments.includes("production"), "应包含 production 环境");
    assert.ok(dbUrl!.effectiveEnvironments.includes("staging"), "应包含 staging 环境");
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T20. 不可变性
// ============================================================================

test("T20a. PeripheralAnalysisResult 顶层冻结", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(tmpDir, ".env", ["DATABASE_URL=postgres://localhost:5432/mydb", ""].join("\n"));
    const analyzer = new PeripheralSystemAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    assert.ok(Object.isFrozen(result), "PeripheralAnalysisResult 应冻结");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T20b. dependencies 数组冻结", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(tmpDir, ".env", ["DATABASE_URL=postgres://localhost:5432/mydb", ""].join("\n"));
    const analyzer = new PeripheralSystemAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    assert.ok(Object.isFrozen(result.dependencies), "dependencies 数组应冻结");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T20c. interactionMatrix 数组冻结", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(tmpDir, ".env", ["DATABASE_URL=postgres://localhost:5432/mydb", ""].join("\n"));
    await writeProjectFile(
      tmpDir,
      "src/services/DbService.ts",
      ["const url = process.env.DATABASE_URL;", ""].join("\n")
    );
    const analyzer = new PeripheralSystemAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    assert.ok(Object.isFrozen(result.interactionMatrix), "interactionMatrix 数组应冻结");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T20d. configInventory 数组冻结", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(tmpDir, ".env", ["DATABASE_URL=postgres://localhost:5432/mydb", ""].join("\n"));
    const analyzer = new PeripheralSystemAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    assert.ok(Object.isFrozen(result.configInventory), "configInventory 数组应冻结");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T20e. 单个 dependency 对象冻结", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(tmpDir, ".env", ["DATABASE_URL=postgres://localhost:5432/mydb", ""].join("\n"));
    const analyzer = new PeripheralSystemAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    const dbDep = result.dependencies.find((d) => d.type === "database");
    assert.ok(dbDep);
    assert.ok(Object.isFrozen(dbDep), "单个 dependency 对象应冻结");
    assert.ok(Object.isFrozen(dbDep!.configKeys), "configKeys 数组应冻结");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T20f. 单个 configInventory 对象冻结（含 effectiveEnvironments）", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(tmpDir, ".env.production", ["DATABASE_URL=postgres://prod-db:5432/myapp", ""].join("\n"));
    await writeProjectFile(tmpDir, ".env.staging", ["DATABASE_URL=postgres://staging-db:5432/myapp", ""].join("\n"));
    const analyzer = new PeripheralSystemAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    const dbUrl = result.configInventory.find((c) => c.key === "DATABASE_URL");
    assert.ok(dbUrl);
    assert.ok(Object.isFrozen(dbUrl), "单个 configInventory 对象应冻结");
    assert.ok(Object.isFrozen(dbUrl!.effectiveEnvironments), "effectiveEnvironments 数组应冻结");
  } finally {
    await removeTempDir(tmpDir);
  }
});
