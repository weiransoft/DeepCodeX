/**
 * EAG-P1 批次 5 单元测试：L1 全局视野层（目录扫描 + 入口点检测 + 技术栈指纹 + 分层识别）
 *
 * 测试范围：
 * - T1. L1GlobalViewBuilder.shouldIgnore 路径过滤
 *   - T1a. node_modules 目录被忽略
 *   - T1b. .git 目录被忽略
 *   - T1c. dist 目录被忽略
 *   - T1d. src 目录不忽略
 *   - T1e. .png 文件被忽略
 *   - T1f. .jpg 文件被忽略
 *   - T1g. .ts 文件不忽略
 *   - T1h. .py 文件不忽略
 * - T2. L1GlobalViewBuilder.build 目录扫描
 *   - T2a. 不存在路径抛 path-not-found
 *   - T2b. 文件路径抛 invalid-path
 *   - T2c. 空目录返回空 RepositoryMap
 *   - T2d. 单文件扫描（src/index.ts）
 *   - T2e. 嵌套目录扫描
 *   - T2f. 忽略 node_modules 目录
 *   - T2g. 计算文件行数
 *   - T2h. 标注模块职责（src/domain）
 *   - T2i. 返回冻结 map
 *   - T2j. 空字符串路径抛 invalid-path
 * - T3. EntryPointDetector.detectMain 主入口检测
 *   - T3a. index.ts 启发式识别
 *   - T3b. package.json main 字段识别
 *   - T3c. package.json bin 字段识别
 * - T4. EntryPointDetector.detectHttpRoutes HTTP 路由检测
 *   - T4a. NestJS @Controller 装饰器
 *   - T4b. Express app.get() 调用
 *   - T4c. Spring @RestController 注解
 * - T5. EntryPointDetector.detectScheduledTasks 定时任务检测
 *   - T5a. NestJS @Cron 装饰器
 *   - T5b. setInterval 调用
 * - T6. EntryPointDetector.detectMqConsumers MQ 消费者检测
 *   - T6a. NestJS BullMQ @Processor 装饰器
 *   - T6b. BullMQ new Worker() 调用
 * - T7. EntryPointDetector.detectAll 综合检测
 *   - T7a. 并行检测全部 4 类入口点
 * - T8. TechStackFingerprintExtractor.parsePackageJson
 *   - T8a. 解析 main/bin/dependencies
 *   - T8b. 非法 JSON 返回空对象
 * - T9. TechStackFingerprintExtractor.parsePomXml
 *   - T9a. 解析 Maven 坐标与依赖
 * - T10. TechStackFingerprintExtractor.parseRequirementsTxt
 *   - T10a. 解析包名与版本约束
 *   - T10b. 跳过注释行
 * - T11. TechStackFingerprintExtractor.parseGoMod
 *   - T11a. 解析 module/go/require
 * - T12. TechStackFingerprintExtractor.extract 综合提取
 *   - T12a. 真实 TypeScript 项目识别
 *   - T12b. 返回冻结结果
 * - T13. TechStackFingerprintExtractor.detectLayeredArchitecture 分层架构识别
 *   - T13a. DDD 分层架构识别
 *   - T13b. Clean Architecture 识别
 *   - T13c. CQRS-ES 识别
 *   - T13d. 微服务架构识别
 *   - T13e. 未识别返回 unknown
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，使用真实文件系统（fs.mkdtemp 创建临时目录）
 * - 测试用例独立、可重复，每个用例自己创建与清理临时目录
 *
 * @module core/tests/eag-pkc-l1-global-view
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { L1GlobalViewBuilder, L1GlobalViewError } from "../eag/pkc/l1-global-view";
import { EntryPointDetector } from "../eag/pkc/entry-point-detector";
import { TechStackFingerprintExtractor } from "../eag/pkc/tech-stack-fingerprint";

// ============================================================================
// 辅助函数：创建临时目录与文件
// ============================================================================

/**
 * 创建临时目录（基于 os.tmpdir + 当前时间戳 + 随机数，保证唯一）
 *
 * @returns 临时目录绝对路径
 */
async function createTempDir(): Promise<string> {
  const prefix = path.join(os.tmpdir(), `eag-pkc-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-`);
  return fs.mkdtemp(prefix);
}

/**
 * 在指定根目录下创建文件（自动创建父目录）
 *
 * @param root 根目录
 * @param relativePath 文件相对路径（如 "src/index.ts"）
 * @param content 文件内容
 */
async function createFile(root: string, relativePath: string, content: string): Promise<void> {
  const fullPath = path.join(root, relativePath);
  const dir = path.dirname(fullPath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(fullPath, content, "utf-8");
}

/**
 * 递归删除目录（用于清理临时目录）
 *
 * @param dirPath 目录路径
 */
async function removeDir(dirPath: string): Promise<void> {
  await fs.rm(dirPath, { recursive: true, force: true });
}

// ============================================================================
// T1. L1GlobalViewBuilder.shouldIgnore 路径过滤
// ============================================================================

test("T1a. shouldIgnore node_modules 目录被忽略", () => {
  const builder = new L1GlobalViewBuilder();
  assert.equal(builder.shouldIgnore("node_modules", true), true);
});

test("T1b. shouldIgnore .git 目录被忽略", () => {
  const builder = new L1GlobalViewBuilder();
  assert.equal(builder.shouldIgnore(".git", true), true);
});

test("T1c. shouldIgnore dist 目录被忽略", () => {
  const builder = new L1GlobalViewBuilder();
  assert.equal(builder.shouldIgnore("dist", true), true);
});

test("T1d. shouldIgnore src 目录不忽略", () => {
  const builder = new L1GlobalViewBuilder();
  assert.equal(builder.shouldIgnore("src", true), false);
});

test("T1e. shouldIgnore .png 文件被忽略", () => {
  const builder = new L1GlobalViewBuilder();
  assert.equal(builder.shouldIgnore("logo.png", false), true);
});

test("T1f. shouldIgnore .jpg 文件被忽略", () => {
  const builder = new L1GlobalViewBuilder();
  assert.equal(builder.shouldIgnore("photo.jpg", false), true);
});

test("T1g. shouldIgnore .ts 文件不忽略", () => {
  const builder = new L1GlobalViewBuilder();
  assert.equal(builder.shouldIgnore("index.ts", false), false);
});

test("T1h. shouldIgnore .py 文件不忽略", () => {
  const builder = new L1GlobalViewBuilder();
  assert.equal(builder.shouldIgnore("main.py", false), false);
});

// ============================================================================
// T2. L1GlobalViewBuilder.build 目录扫描
// ============================================================================

test("T2a. build 不存在路径抛 path-not-found", async () => {
  const builder = new L1GlobalViewBuilder();
  const nonExistentPath = path.join(os.tmpdir(), `non-existent-${Date.now()}`);
  await assert.rejects(builder.build(nonExistentPath), (err: unknown) => {
    assert.ok(err instanceof L1GlobalViewError);
    assert.equal((err as L1GlobalViewError).kind, "path-not-found");
    return true;
  });
});

test("T2b. build 文件路径抛 invalid-path", async () => {
  const builder = new L1GlobalViewBuilder();
  // 创建一个临时文件（非目录）
  const tmpFile = path.join(os.tmpdir(), `eag-test-file-${Date.now()}.txt`);
  await fs.writeFile(tmpFile, "test", "utf-8");
  try {
    await assert.rejects(builder.build(tmpFile), (err: unknown) => {
      assert.ok(err instanceof L1GlobalViewError);
      assert.equal((err as L1GlobalViewError).kind, "invalid-path");
      return true;
    });
  } finally {
    await fs.unlink(tmpFile);
  }
});

test("T2c. build 空目录返回空 RepositoryMap", async () => {
  const tmpDir = await createTempDir();
  try {
    const builder = new L1GlobalViewBuilder();
    const map = await builder.build(tmpDir);
    assert.equal(map.rootPath, tmpDir);
    assert.equal(map.directories.length, 0);
    assert.equal(map.files.length, 0);
    assert.equal(map.totalFiles, 0);
    assert.equal(map.totalDirectories, 0);
  } finally {
    await removeDir(tmpDir);
  }
});

test("T2d. build 单文件扫描（src/index.ts）", async () => {
  const tmpDir = await createTempDir();
  try {
    await createFile(tmpDir, "src/index.ts", "console.log('hello');\n");
    const builder = new L1GlobalViewBuilder();
    const map = await builder.build(tmpDir);
    assert.equal(map.files.length, 1);
    assert.equal(map.files[0].name, "index.ts");
    assert.equal(map.files[0].extension, ".ts");
    assert.equal(map.files[0].path, path.join("src", "index.ts"));
    // src 目录应被扫描
    assert.equal(map.directories.length, 1);
    assert.equal(map.directories[0].name, "src");
  } finally {
    await removeDir(tmpDir);
  }
});

test("T2e. build 嵌套目录扫描", async () => {
  const tmpDir = await createTempDir();
  try {
    await createFile(tmpDir, "src/domain/user.ts", "export class User {}\n");
    await createFile(tmpDir, "src/application/service.ts", "export class Service {}\n");
    const builder = new L1GlobalViewBuilder();
    const map = await builder.build(tmpDir);
    assert.equal(map.files.length, 2);
    assert.equal(map.directories.length, 1);
    assert.equal(map.directories[0].name, "src");
    // src 应含 domain 与 application 两个子目录
    assert.equal(map.directories[0].children.length, 2);
    const childNames = map.directories[0].children.map((c) => c.name);
    assert.ok(childNames.includes("domain"));
    assert.ok(childNames.includes("application"));
  } finally {
    await removeDir(tmpDir);
  }
});

test("T2f. build 忽略 node_modules 目录", async () => {
  const tmpDir = await createTempDir();
  try {
    await createFile(tmpDir, "src/index.ts", "console.log('hello');\n");
    // node_modules 下的文件应被忽略
    await createFile(tmpDir, "node_modules/lodash/index.js", "module.exports = {};\n");
    const builder = new L1GlobalViewBuilder();
    const map = await builder.build(tmpDir);
    // 仅扫描到 src/index.ts，node_modules 下的文件被忽略
    assert.equal(map.files.length, 1);
    assert.equal(map.files[0].path, path.join("src", "index.ts"));
    // 仅 src 目录，node_modules 被忽略
    assert.equal(map.directories.length, 1);
    assert.equal(map.directories[0].name, "src");
  } finally {
    await removeDir(tmpDir);
  }
});

test("T2g. build 计算文件行数", async () => {
  const tmpDir = await createTempDir();
  try {
    // 3 行内容（最后一行带换行符）
    await createFile(tmpDir, "src/index.ts", "line1\nline2\nline3\n");
    const builder = new L1GlobalViewBuilder();
    const map = await builder.build(tmpDir);
    assert.equal(map.files.length, 1);
    // 3 行（按 \n 切分得 4 段，末尾 \n 减 1 = 3 行）
    assert.equal(map.files[0].lines, 3);
  } finally {
    await removeDir(tmpDir);
  }
});

test("T2h. build 标注模块职责（src/domain）", async () => {
  const tmpDir = await createTempDir();
  try {
    await createFile(tmpDir, "src/domain/user.ts", "export class User {}\n");
    const builder = new L1GlobalViewBuilder();
    const map = await builder.build(tmpDir);
    // src 目录职责应为"源代码"
    const srcDir = map.directories.find((d) => d.name === "src");
    assert.ok(srcDir);
    assert.equal(srcDir.moduleResponsibility, "源代码");
    // src/domain 目录职责应为"领域层（DDD）"
    const domainDir = srcDir.children.find((d) => d.name === "domain");
    assert.ok(domainDir);
    assert.equal(domainDir.moduleResponsibility, "领域层（DDD）");
  } finally {
    await removeDir(tmpDir);
  }
});

test("T2i. build 返回冻结 map", async () => {
  const tmpDir = await createTempDir();
  try {
    await createFile(tmpDir, "src/index.ts", "console.log('hello');\n");
    const builder = new L1GlobalViewBuilder();
    const map = await builder.build(tmpDir);
    assert.equal(Object.isFrozen(map), true);
    assert.equal(Object.isFrozen(map.directories), true);
    assert.equal(Object.isFrozen(map.files), true);
    // 嵌套 directories 也应冻结
    for (const dir of map.directories) {
      assert.equal(Object.isFrozen(dir), true);
      assert.equal(Object.isFrozen(dir.children), true);
    }
  } finally {
    await removeDir(tmpDir);
  }
});

test("T2j. build 空字符串路径抛 invalid-path", async () => {
  const builder = new L1GlobalViewBuilder();
  await assert.rejects(builder.build(""), (err: unknown) => {
    assert.ok(err instanceof L1GlobalViewError);
    assert.equal((err as L1GlobalViewError).kind, "invalid-path");
    return true;
  });
});

// ============================================================================
// T3. EntryPointDetector.detectMain 主入口检测
// ============================================================================

test("T3a. detectMain index.ts 启发式识别", async () => {
  const tmpDir = await createTempDir();
  try {
    await createFile(tmpDir, "src/index.ts", "console.log('hello');\n");
    const builder = new L1GlobalViewBuilder();
    const map = await builder.build(tmpDir);
    const detector = new EntryPointDetector();
    const mainEntries = await detector.detectMain(map);
    // 应识别 src/index.ts 为 main 入口
    const indexEntry = mainEntries.find((ep) => ep.filePath.endsWith("index.ts"));
    assert.ok(indexEntry);
    assert.equal(indexEntry.type, "main");
    assert.equal(indexEntry.symbolName, "Index");
  } finally {
    await removeDir(tmpDir);
  }
});

test("T3b. detectMain package.json main 字段识别", async () => {
  const tmpDir = await createTempDir();
  try {
    const pkgJson = JSON.stringify({
      name: "test-pkg",
      version: "1.0.0",
      main: "dist/index.js",
    });
    await createFile(tmpDir, "package.json", pkgJson);
    const builder = new L1GlobalViewBuilder();
    const map = await builder.build(tmpDir);
    const detector = new EntryPointDetector();
    const mainEntries = await detector.detectMain(map);
    // 应识别 package.json main 字段声明的入口
    const mainEntry = mainEntries.find((ep) => ep.filePath === "dist/index.js");
    assert.ok(mainEntry);
    assert.equal(mainEntry.type, "main");
  } finally {
    await removeDir(tmpDir);
  }
});

test("T3c. detectMain package.json bin 字段识别", async () => {
  const tmpDir = await createTempDir();
  try {
    const pkgJson = JSON.stringify({
      name: "test-cli",
      version: "1.0.0",
      bin: {
        "my-cli": "bin/cli.js",
      },
    });
    await createFile(tmpDir, "package.json", pkgJson);
    const builder = new L1GlobalViewBuilder();
    const map = await builder.build(tmpDir);
    const detector = new EntryPointDetector();
    const mainEntries = await detector.detectMain(map);
    // 应识别 package.json bin 字段声明的 CLI 入口
    const cliEntry = mainEntries.find((ep) => ep.symbolName === "my-cli");
    assert.ok(cliEntry);
    assert.equal(cliEntry.type, "main");
  } finally {
    await removeDir(tmpDir);
  }
});

// ============================================================================
// T4. EntryPointDetector.detectHttpRoutes HTTP 路由检测
// ============================================================================

test("T4a. detectHttpRoutes NestJS @Controller 装饰器", async () => {
  const tmpDir = await createTempDir();
  try {
    const code = `
import { Controller, Get } from '@nestjs/common';

@Controller('users')
export class UserController {
  @Get('list')
  listUsers() {}
}
`;
    await createFile(tmpDir, "src/interfaces/UserController.ts", code);
    const builder = new L1GlobalViewBuilder();
    const map = await builder.build(tmpDir);
    const detector = new EntryPointDetector();
    const routes = await detector.detectHttpRoutes(map);
    // 应识别到 NestJS HTTP 路由（@Controller 与 @Get）
    assert.ok(routes.length > 0);
    const controllerRoute = routes.find((r) => r.symbolName === "users");
    assert.ok(controllerRoute);
    assert.equal(controllerRoute.type, "http-route");
    assert.ok(controllerRoute.description.includes("NestJS"));
  } finally {
    await removeDir(tmpDir);
  }
});

test("T4b. detectHttpRoutes Express app.get() 调用", async () => {
  const tmpDir = await createTempDir();
  try {
    const code = `
const express = require('express');
const app = express();
app.get('/users', (req, res) => res.json([]));
app.post('/users', (req, res) => res.json({}));
`;
    await createFile(tmpDir, "src/app.js", code);
    const builder = new L1GlobalViewBuilder();
    const map = await builder.build(tmpDir);
    const detector = new EntryPointDetector();
    const routes = await detector.detectHttpRoutes(map);
    // 应识别到 Express HTTP 路由
    assert.ok(routes.length > 0);
    const usersRoute = routes.find((r) => r.symbolName === "/users");
    assert.ok(usersRoute);
    assert.equal(usersRoute.type, "http-route");
    assert.ok(usersRoute.description.includes("Express"));
  } finally {
    await removeDir(tmpDir);
  }
});

test("T4c. detectHttpRoutes Spring @RestController 注解", async () => {
  const tmpDir = await createTempDir();
  try {
    const code = `
@RestController
@RequestMapping("/api/orders")
public class OrderController {
  @GetMapping("/list")
  public List<Order> list() { return null; }
}
`;
    await createFile(tmpDir, "src/main/java/com/example/OrderController.java", code);
    const builder = new L1GlobalViewBuilder();
    const map = await builder.build(tmpDir);
    const detector = new EntryPointDetector();
    const routes = await detector.detectHttpRoutes(map);
    // 应识别到 Spring HTTP 路由
    assert.ok(routes.length > 0);
    const restControllerRoute = routes.find((r) => r.symbolName === "RestController");
    assert.ok(restControllerRoute);
    assert.ok(restControllerRoute.description.includes("Spring"));
  } finally {
    await removeDir(tmpDir);
  }
});

// ============================================================================
// T5. EntryPointDetector.detectScheduledTasks 定时任务检测
// ============================================================================

test("T5a. detectScheduledTasks NestJS @Cron 装饰器", async () => {
  const tmpDir = await createTempDir();
  try {
    const code = `
import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

@Injectable()
export class TasksService {
  @Cron('45 * * * * *')
  handleCron() {}
}
`;
    await createFile(tmpDir, "src/tasks.service.ts", code);
    const builder = new L1GlobalViewBuilder();
    const map = await builder.build(tmpDir);
    const detector = new EntryPointDetector();
    const tasks = await detector.detectScheduledTasks(map);
    // 应识别到 NestJS @Cron 定时任务
    assert.ok(tasks.length > 0);
    const cronTask = tasks.find((t) => t.symbolName === "45 * * * * *");
    assert.ok(cronTask);
    assert.equal(cronTask.type, "scheduled-task");
    assert.ok(cronTask.description.includes("NestJS"));
  } finally {
    await removeDir(tmpDir);
  }
});

test("T5b. detectScheduledTasks setInterval 调用", async () => {
  const tmpDir = await createTempDir();
  try {
    const code = `
setInterval(() => {
  console.log('tick');
}, 1000);
`;
    await createFile(tmpDir, "src/ticker.js", code);
    const builder = new L1GlobalViewBuilder();
    const map = await builder.build(tmpDir);
    const detector = new EntryPointDetector();
    const tasks = await detector.detectScheduledTasks(map);
    // 应识别到 setInterval 定时任务
    assert.ok(tasks.length > 0);
    const setIntervalTask = tasks.find((t) => t.description.includes("setInterval"));
    assert.ok(setIntervalTask);
    assert.equal(setIntervalTask.type, "scheduled-task");
  } finally {
    await removeDir(tmpDir);
  }
});

// ============================================================================
// T6. EntryPointDetector.detectMqConsumers MQ 消费者检测
// ============================================================================

test("T6a. detectMqConsumers NestJS BullMQ @Processor 装饰器", async () => {
  const tmpDir = await createTempDir();
  try {
    const code = `
import { Processor } from '@nestjs/bullmq';
import { WorkerHost } from '@nestjs/bullmq';

@Processor('email')
export class EmailConsumer extends WorkerHost {
  async process(job) {}
}
`;
    await createFile(tmpDir, "src/email.consumer.ts", code);
    const builder = new L1GlobalViewBuilder();
    const map = await builder.build(tmpDir);
    const detector = new EntryPointDetector();
    const consumers = await detector.detectMqConsumers(map);
    // 应识别到 BullMQ @Processor 消费者
    assert.ok(consumers.length > 0);
    const processorConsumer = consumers.find((c) => c.symbolName === "email");
    assert.ok(processorConsumer);
    assert.equal(processorConsumer.type, "mq-consumer");
    assert.ok(processorConsumer.description.includes("BullMQ"));
  } finally {
    await removeDir(tmpDir);
  }
});

test("T6b. detectMqConsumers BullMQ new Worker() 调用", async () => {
  const tmpDir = await createTempDir();
  try {
    const code = `
const { Worker } = require('bullmq');
new Worker('email-queue', async (job) => {
  console.log('processing', job.id);
});
`;
    await createFile(tmpDir, "src/worker.js", code);
    const builder = new L1GlobalViewBuilder();
    const map = await builder.build(tmpDir);
    const detector = new EntryPointDetector();
    const consumers = await detector.detectMqConsumers(map);
    // 应识别到 BullMQ new Worker() 消费者
    assert.ok(consumers.length > 0);
    const workerConsumer = consumers.find((c) => c.symbolName === "email-queue");
    assert.ok(workerConsumer);
    assert.equal(workerConsumer.type, "mq-consumer");
  } finally {
    await removeDir(tmpDir);
  }
});

// ============================================================================
// T7. EntryPointDetector.detectAll 综合检测
// ============================================================================

test("T7a. detectAll 综合检测全部 4 类入口点", async () => {
  const tmpDir = await createTempDir();
  try {
    // main 入口：index.ts
    await createFile(tmpDir, "src/index.ts", "console.log('main');\n");
    // HTTP 路由：NestJS @Controller
    await createFile(
      tmpDir,
      "src/user.controller.ts",
      `import { Controller, Get } from '@nestjs/common';\n@Controller('users')\nexport class UserController { @Get('list') list() {} }\n`
    );
    // 定时任务：@Cron
    await createFile(
      tmpDir,
      "src/cron.service.ts",
      `import { Cron } from '@nestjs/schedule';\nexport class CronService { @Cron('0 * * * * *') handle() {} }\n`
    );
    // MQ 消费者：@Processor
    await createFile(
      tmpDir,
      "src/email.processor.ts",
      `import { Processor } from '@nestjs/bullmq';\n@Processor('email')\nexport class EmailProcessor {}\n`
    );

    const builder = new L1GlobalViewBuilder();
    const map = await builder.build(tmpDir);
    const detector = new EntryPointDetector();
    const allEntries = await detector.detectAll(map);

    // 应至少检测到 4 类入口点
    const types = new Set(allEntries.map((ep) => ep.type));
    assert.ok(types.has("main"));
    assert.ok(types.has("http-route"));
    assert.ok(types.has("scheduled-task"));
    assert.ok(types.has("mq-consumer"));
  } finally {
    await removeDir(tmpDir);
  }
});

// ============================================================================
// T8. TechStackFingerprintExtractor.parsePackageJson
// ============================================================================

test("T8a. parsePackageJson 解析 main/bin/dependencies", () => {
  const extractor = new TechStackFingerprintExtractor();
  const content = JSON.stringify({
    name: "test-pkg",
    version: "1.0.0",
    main: "dist/index.js",
    bin: {
      "my-cli": "bin/cli.js",
    },
    dependencies: {
      "@nestjs/core": "^10.0.0",
      express: "^4.18.0",
    },
    devDependencies: {
      typescript: "^5.0.0",
    },
  });
  const result = extractor.parsePackageJson(content);
  assert.equal(result.name, "test-pkg");
  assert.equal(result.version, "1.0.0");
  assert.equal(result.main, "dist/index.js");
  assert.ok(result.bin && typeof result.bin === "object");
  assert.equal((result.bin as Record<string, string>)["my-cli"], "bin/cli.js");
  assert.ok(result.dependencies);
  assert.equal((result.dependencies as Record<string, string>)["@nestjs/core"], "^10.0.0");
  assert.ok(result.devDependencies);
  assert.equal((result.devDependencies as Record<string, string>)["typescript"], "^5.0.0");
});

test("T8b. parsePackageJson 非法 JSON 返回空对象", () => {
  const extractor = new TechStackFingerprintExtractor();
  const result = extractor.parsePackageJson("{ invalid json");
  // 非法 JSON 应返回空对象（不抛出）
  assert.ok(result.dependencies);
  assert.ok(result.devDependencies);
});

// ============================================================================
// T9. TechStackFingerprintExtractor.parsePomXml
// ============================================================================

test("T9a. parsePomXml 解析 Maven 坐标与依赖", () => {
  const extractor = new TechStackFingerprintExtractor();
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>demo</artifactId>
  <version>1.0.0</version>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
      <version>3.1.0</version>
    </dependency>
  </dependencies>
</project>`;
  const result = extractor.parsePomXml(content);
  assert.equal(result.groupId, "com.example");
  assert.equal(result.artifactId, "demo");
  assert.equal(result.version, "1.0.0");
  assert.equal(result.dependencies.length, 1);
  assert.equal(result.dependencies[0].groupId, "org.springframework.boot");
  assert.equal(result.dependencies[0].artifactId, "spring-boot-starter-web");
});

// ============================================================================
// T10. TechStackFingerprintExtractor.parseRequirementsTxt
// ============================================================================

test("T10a. parseRequirementsTxt 解析包名与版本约束", () => {
  const extractor = new TechStackFingerprintExtractor();
  const content = `fastapi==0.104.0
uvicorn>=0.23.0
celery
# this is a comment
django>=4.2.0`;
  const result = extractor.parseRequirementsTxt(content);
  assert.equal(result.requirements.length, 4);
  // 第一行：fastapi==0.104.0
  assert.equal(result.requirements[0].name, "fastapi");
  assert.equal(result.requirements[0].version, "0.104.0");
  // 第三行：celery（无版本约束）
  const celery = result.requirements.find((r) => r.name === "celery");
  assert.ok(celery);
  assert.equal(celery.version, undefined);
});

test("T10b. parseRequirementsTxt 跳过注释行", () => {
  const extractor = new TechStackFingerprintExtractor();
  const content = `# 注释行
fastapi==0.104.0
# 另一个注释
uvicorn>=0.23.0`;
  const result = extractor.parseRequirementsTxt(content);
  // 仅 2 个依赖（注释行跳过）
  assert.equal(result.requirements.length, 2);
  assert.equal(result.requirements[0].name, "fastapi");
  assert.equal(result.requirements[1].name, "uvicorn");
});

// ============================================================================
// T11. TechStackFingerprintExtractor.parseGoMod
// ============================================================================

test("T11a. parseGoMod 解析 module/go/require", () => {
  const extractor = new TechStackFingerprintExtractor();
  const content = `module github.com/example/demo

go 1.21

require (
\tgithub.com/gin-gonic/gin v1.9.0
\tgithub.com/lib/pq v1.10.0
)`;
  const result = extractor.parseGoMod(content);
  assert.equal(result.modulePath, "github.com/example/demo");
  assert.equal(result.goVersion, "1.21");
  assert.equal(result.requires.length, 2);
  assert.equal(result.requires[0].path, "github.com/gin-gonic/gin");
  assert.equal(result.requires[0].version, "v1.9.0");
  assert.equal(result.requires[1].path, "github.com/lib/pq");
  assert.equal(result.requires[1].version, "v1.10.0");
});

// ============================================================================
// T12. TechStackFingerprintExtractor.extract 综合提取
// ============================================================================

test("T12a. extract 真实 TypeScript 项目识别", async () => {
  const tmpDir = await createTempDir();
  try {
    // 模拟一个 TypeScript NestJS 项目
    await createFile(
      tmpDir,
      "package.json",
      JSON.stringify({
        name: "demo",
        version: "1.0.0",
        main: "dist/index.js",
        dependencies: {
          "@nestjs/core": "^10.0.0",
          "@nestjs/common": "^10.0.0",
          express: "^4.18.0",
        },
        devDependencies: {
          typescript: "^5.0.0",
        },
      })
    );
    await createFile(tmpDir, "tsconfig.json", "{}");
    await createFile(tmpDir, "package-lock.json", "{}");

    const builder = new L1GlobalViewBuilder();
    const map = await builder.build(tmpDir);
    const extractor = new TechStackFingerprintExtractor();
    const fingerprint = await extractor.extract(map);

    // 应识别 TypeScript 语言
    assert.ok(fingerprint.languages.includes("typescript"));
    // 应识别 NestJS 与 Express 框架
    assert.ok(fingerprint.frameworks.includes("NestJS"));
    assert.ok(fingerprint.frameworks.includes("Express"));
    // 应识别 npm 包管理器（基于 package-lock.json）
    assert.equal(fingerprint.packageManager, "npm");
    // 应识别依赖文件
    assert.ok(fingerprint.dependencyFiles.includes("package.json"));
    assert.ok(fingerprint.dependencyFiles.includes("package-lock.json"));
    assert.ok(fingerprint.dependencyFiles.includes("tsconfig.json"));
  } finally {
    await removeDir(tmpDir);
  }
});

test("T12b. extract 返回冻结结果", async () => {
  const tmpDir = await createTempDir();
  try {
    await createFile(tmpDir, "package.json", JSON.stringify({ name: "demo" }));
    const builder = new L1GlobalViewBuilder();
    const map = await builder.build(tmpDir);
    const extractor = new TechStackFingerprintExtractor();
    const fingerprint = await extractor.extract(map);
    assert.equal(Object.isFrozen(fingerprint), true);
    assert.equal(Object.isFrozen(fingerprint.languages), true);
    assert.equal(Object.isFrozen(fingerprint.frameworks), true);
    assert.equal(Object.isFrozen(fingerprint.dependencyFiles), true);
  } finally {
    await removeDir(tmpDir);
  }
});

// ============================================================================
// T13. TechStackFingerprintExtractor.detectLayeredArchitecture 分层架构识别
// ============================================================================

test("T13a. detectLayeredArchitecture DDD 分层架构识别", async () => {
  const tmpDir = await createTempDir();
  try {
    // 模拟 DDD 分层目录结构
    await createFile(tmpDir, "src/domain/user.ts", "export class User {}\n");
    await createFile(tmpDir, "src/application/service.ts", "export class Service {}\n");
    await createFile(tmpDir, "src/interfaces/controller.ts", "export class Controller {}\n");
    await createFile(tmpDir, "src/infrastructure/repo.ts", "export class Repo {}\n");

    const builder = new L1GlobalViewBuilder();
    const map = await builder.build(tmpDir);
    const extractor = new TechStackFingerprintExtractor();
    const fingerprint = await extractor.extract(map);
    const arch = extractor.detectLayeredArchitecture(fingerprint, map);

    // 应识别为 DDD 分层架构
    assert.equal(arch.paradigm, "ddd-layered");
    assert.ok(arch.confidence >= 0.4);
    assert.ok(arch.evidence.length > 0);
    assert.equal(Object.isFrozen(arch), true);
  } finally {
    await removeDir(tmpDir);
  }
});

test("T13b. detectLayeredArchitecture Clean Architecture 识别", async () => {
  const tmpDir = await createTempDir();
  try {
    // 模拟 Clean Architecture 目录结构
    await createFile(tmpDir, "src/entities/user.ts", "export class User {}\n");
    await createFile(tmpDir, "src/use-cases/login.ts", "export class Login {}\n");
    await createFile(tmpDir, "src/adapters/db.ts", "export class Db {}\n");
    await createFile(tmpDir, "src/frameworks/web.ts", "export class Web {}\n");

    const builder = new L1GlobalViewBuilder();
    const map = await builder.build(tmpDir);
    const extractor = new TechStackFingerprintExtractor();
    const fingerprint = await extractor.extract(map);
    const arch = extractor.detectLayeredArchitecture(fingerprint, map);

    // 应识别为 Clean Architecture
    assert.equal(arch.paradigm, "clean-architecture");
    assert.ok(arch.confidence >= 0.4);
  } finally {
    await removeDir(tmpDir);
  }
});

test("T13c. detectLayeredArchitecture CQRS-ES 识别", async () => {
  const tmpDir = await createTempDir();
  try {
    // 模拟 CQRS-ES 目录结构
    await createFile(tmpDir, "src/command-side/create-order.ts", "export class CreateOrder {}\n");
    await createFile(tmpDir, "src/query-side/order-view.ts", "export class OrderView {}\n");
    await createFile(tmpDir, "src/projections/order-projection.ts", "export class Proj {}\n");
    await createFile(tmpDir, "src/events/order-created.ts", "export class OrderCreated {}\n");

    const builder = new L1GlobalViewBuilder();
    const map = await builder.build(tmpDir);
    const extractor = new TechStackFingerprintExtractor();
    const fingerprint = await extractor.extract(map);
    const arch = extractor.detectLayeredArchitecture(fingerprint, map);

    // 应识别为 CQRS-ES
    assert.equal(arch.paradigm, "cqrs-es");
    assert.ok(arch.confidence >= 0.4);
  } finally {
    await removeDir(tmpDir);
  }
});

test("T13d. detectLayeredArchitecture 微服务架构识别", async () => {
  const tmpDir = await createTempDir();
  try {
    // 模拟微服务目录结构
    await createFile(tmpDir, "services/user-service/main.ts", "console.log('user');\n");
    await createFile(tmpDir, "services/order-service/main.ts", "console.log('order');\n");
    await createFile(tmpDir, "gateway/index.ts", "console.log('gateway');\n");
    await createFile(tmpDir, "saga/order-saga.ts", "export class OrderSaga {}\n");

    const builder = new L1GlobalViewBuilder();
    const map = await builder.build(tmpDir);
    const extractor = new TechStackFingerprintExtractor();
    const fingerprint = await extractor.extract(map);
    const arch = extractor.detectLayeredArchitecture(fingerprint, map);

    // 应识别为微服务架构
    assert.equal(arch.paradigm, "microservice");
    assert.ok(arch.confidence >= 0.4);
  } finally {
    await removeDir(tmpDir);
  }
});

test("T13e. detectLayeredArchitecture 未识别返回 unknown", async () => {
  const tmpDir = await createTempDir();
  try {
    // 模拟一个无任何分层特征的扁平结构
    await createFile(tmpDir, "index.ts", "console.log('hello');\n");
    await createFile(tmpDir, "utils.ts", "export function util() {}\n");

    const builder = new L1GlobalViewBuilder();
    const map = await builder.build(tmpDir);
    const extractor = new TechStackFingerprintExtractor();
    const fingerprint = await extractor.extract(map);
    const arch = extractor.detectLayeredArchitecture(fingerprint, map);

    // 应返回 unknown
    assert.equal(arch.paradigm, "unknown");
    assert.equal(arch.confidence, 0);
  } finally {
    await removeDir(tmpDir);
  }
});
