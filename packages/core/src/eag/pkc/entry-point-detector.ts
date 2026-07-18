/**
 * 入口点检测器实现（EAG-P1 批次 5）
 *
 * 本模块实现 `EntryPointDetector` 类，提供 EAG 方案 §5.11.1 L1 入口点识别的真实逻辑。
 *
 * 核心职责：
 * - detectMain(map)：检测 main 入口（package.json bin/main 字段、index.ts/main.ts/app.ts 等）
 * - detectHttpRoutes(map)：检测 HTTP 路由注册
 *   （@Controller/@Get/@Post 装饰器、Express router 调用、Spring @RestController 等）
 * - detectScheduledTasks(map)：检测定时任务
 *   （@Cron/cron.schedule/setInterval、Spring @Scheduled、Python @app.task 等）
 * - detectMqConsumers(map)：检测 MQ 消费者
 *   （@Processor/@RabbitSubscribe/queue.process、Java @KafkaListener 等）
 * - detectAll(map)：综合检测全部 4 类入口点
 *
 * §5.11.1 L1 入口点识别设计要求：
 * 检测 4 类入口点（main/http-route/scheduled-task/mq-consumer），
 * 识别入口点有助于 L1 全局视野理解项目的功能分布与边界。
 *
 * 设计依据：
 * - EAG 方案 §5.11.1 L1 入口点识别
 * - 多语言多框架支持（TypeScript/JavaScript/Java/Python/Go）
 *
 * 实现说明：
 * - 基于正则表达式匹配源代码中的装饰器/函数调用模式
 * - 不依赖 AST 解析库（避免引入外部依赖），采用字符串模式匹配
 * - 异步读取文件内容（fs/promises），不阻塞事件循环
 * - 读取失败时跳过该文件（不抛出，避免单点失败导致整体检测中断）
 *
 * @module eag/pkc/entry-point-detector
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { EntryPoint, EntryPointType, RepositoryMap } from "./types";

// ============================================================================
// 入口点检测规则（正则表达式表）
// ============================================================================

/**
 * HTTP 路由检测规则（多语言多框架）
 *
 * 每条规则含：
 * - pattern：正则表达式（带捕获组提取符号名）
 * - framework：框架名（用于生成 description）
 *
 * 覆盖框架：
 * - NestJS：@Controller / @Get / @Post / @Put / @Delete / @Patch
 * - Express：app.get/post/put/delete/patch、router.get/post/...
 * - Spring：@RestController / @Controller / @RequestMapping / @GetMapping / @PostMapping
 * - FastAPI：@app.get/post/... / @router.get/post/...
 * - Gin：router.GET/POST/... / r.GET/POST/...
 */
interface DetectionRule {
  /** 正则表达式（带捕获组提取符号名，第一个捕获组为符号名） */
  readonly pattern: RegExp;
  /** 入口点类型描述模板（{symbol} 占位符替换为符号名） */
  readonly descriptionTemplate: string;
  /** 框架名（用于描述） */
  readonly framework: string;
}

/**
 * HTTP 路由检测规则表
 *
 * 使用 Object.freeze 冻结。覆盖 NestJS / Express / Spring / FastAPI / Gin。
 */
const HTTP_ROUTE_RULES: ReadonlyArray<DetectionRule> = Object.freeze([
  // NestJS：@Controller 装饰器
  {
    pattern: /@(Controller)\s*\(\s*['"`]?([^'"`\s)]+)/g,
    descriptionTemplate: "NestJS @Controller 装饰器声明的控制器 {symbol}",
    framework: "NestJS",
  },
  // NestJS：@Get / @Post / @Put / @Delete / @Patch 装饰器（路由方法）
  {
    pattern: /@(Get|Post|Put|Delete|Patch)\s*\(\s*['"`]?([^'"`\s)]+)?/g,
    descriptionTemplate: "NestJS @{method} 装饰器声明的 HTTP 路由 {symbol}",
    framework: "NestJS",
  },
  // Express：app.get/post/put/delete/patch('path', handler)
  {
    pattern: /\b(?:app|router)\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/g,
    descriptionTemplate: "Express {method}() 注册的 HTTP 路由 {symbol}",
    framework: "Express",
  },
  // Spring：@RestController / @Controller 注解
  {
    pattern: /@(RestController|Controller)\b/g,
    descriptionTemplate: "Spring @RestController 注解声明的控制器 {symbol}",
    framework: "Spring",
  },
  // Spring：@RequestMapping / @GetMapping / @PostMapping 注解
  {
    pattern:
      /@(RequestMapping|GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping)\s*\(\s*['"`]?([^'"`\s)]+)?/g,
    descriptionTemplate: "Spring {method} 注解声明的 HTTP 路由 {symbol}",
    framework: "Spring",
  },
  // FastAPI：@app.get/post/...('path')
  {
    pattern: /@(?:app|router)\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/g,
    descriptionTemplate: "FastAPI {method}() 装饰器声明的 HTTP 路由 {symbol}",
    framework: "FastAPI",
  },
  // Gin：router.GET/POST/...('path', handler)
  {
    pattern: /\b(?:router|r)\.(GET|POST|PUT|DELETE|PATCH)\s*\(\s*['"`]([^'"`]+)['"`]/g,
    descriptionTemplate: "Gin {method}() 注册的 HTTP 路由 {symbol}",
    framework: "Gin",
  },
]);

/**
 * 定时任务检测规则表
 *
 * 覆盖：NestJS @Cron / node-cron cron.schedule / setInterval / Spring @Scheduled /
 * Python @app.task / Go cron.NewJob / time.Tick
 */
const SCHEDULED_TASK_RULES: ReadonlyArray<DetectionRule> = Object.freeze([
  // NestJS：@Cron 装饰器
  {
    pattern: /@(Cron)\s*\(\s*['"`]([^'"`]+)['"`]/g,
    descriptionTemplate: "NestJS @Cron 装饰器声明的定时任务 {symbol}",
    framework: "NestJS",
  },
  // node-cron：cron.schedule('expression', callback)
  {
    pattern: /\bcron\.schedule\s*\(\s*['"`]([^'"`]+)['"`]/g,
    descriptionTemplate: "node-cron cron.schedule() 注册的定时任务 {symbol}",
    framework: "node-cron",
  },
  // setInterval（基础 JS）
  {
    pattern: /\bsetInterval\s*\(/g,
    descriptionTemplate: "setInterval() 注册的定时任务 {symbol}",
    framework: "JavaScript",
  },
  // Spring：@Scheduled 注解
  {
    pattern: /@(Scheduled)\s*\(\s*(?:cron|fixedRate|fixedDelay)\s*=\)/g,
    descriptionTemplate: "Spring @Scheduled 注解声明的定时任务 {symbol}",
    framework: "Spring",
  },
  // Python Celery：@app.task / @shared_task 装饰器（含 periodic 任务）
  {
    pattern: /@(?:app|celery)\.task\s*\(\s*\)/g,
    descriptionTemplate: "Celery @app.task 装饰器声明的异步任务 {symbol}",
    framework: "Celery",
  },
  // Python APScheduler：@scheduler.scheduled_job
  {
    pattern: /@scheduler\.scheduled_job\s*\(/g,
    descriptionTemplate: "APScheduler @scheduler.scheduled_job 装饰器声明的定时任务 {symbol}",
    framework: "APScheduler",
  },
  // Go：cron.NewJob / cron.Schedule
  {
    pattern: /\bcron\.(NewJob|Schedule)\s*\(/g,
    descriptionTemplate: "robfig/cron {method}() 注册的定时任务 {symbol}",
    framework: "robfig/cron",
  },
  // Go：time.Tick / time.AfterFunc
  {
    pattern: /\btime\.(Tick|AfterFunc)\s*\(/g,
    descriptionTemplate: "Go time.{method}() 注册的定时任务 {symbol}",
    framework: "Go time",
  },
]);

/**
 * MQ 消费者检测规则表
 *
 * 覆盖：NestJS BullMQ @Processor / NestJS RabbitMQ @RabbitSubscribe /
 * Bull queue.process / Java @KafkaListener / Python @KafkaHandler / consumer.subscribe
 */
const MQ_CONSUMER_RULES: ReadonlyArray<DetectionRule> = Object.freeze([
  // NestJS BullMQ：@Processor 装饰器
  {
    pattern: /@(Processor)\s*\(\s*['"`]?([^'"`\s)]+)?/g,
    descriptionTemplate: "NestJS BullMQ @Processor 装饰器声明的队列消费者 {symbol}",
    framework: "NestJS BullMQ",
  },
  // NestJS RabbitMQ：@RabbitSubscribe 装饰器
  {
    pattern: /@(RabbitSubscribe)\s*\(\s*[^)]*queue\s*:\s*['"`]([^'"`]+)['"`]/g,
    descriptionTemplate: "NestJS RabbitMQ @RabbitSubscribe 装饰器声明的队列消费者 {symbol}",
    framework: "NestJS RabbitMQ",
  },
  // Bull：queue.process('job', handler) / queue.process(handler)
  {
    pattern: /\bqueue\.process\s*\(\s*['"`]?([^'"`\s)]+)?/g,
    descriptionTemplate: "Bull queue.process() 注册的队列消费者 {symbol}",
    framework: "Bull",
  },
  // BullMQ：new Worker('queue', handler)
  {
    pattern: /\bnew\s+Worker\s*\(\s*['"`]([^'"`]+)['"`]/g,
    descriptionTemplate: "BullMQ new Worker() 创建的队列消费者 {symbol}",
    framework: "BullMQ",
  },
  // Spring Kafka：@KafkaListener 注解
  {
    pattern: /@(KafkaListener)\s*\(\s*[^)]*(?:topics|topicPattern)\s*=\)/g,
    descriptionTemplate: "Spring @KafkaListener 注解声明的 Kafka 消费者 {symbol}",
    framework: "Spring Kafka",
  },
  // Spring RabbitMQ：@RabbitListener 注解
  {
    pattern: /@(RabbitListener)\s*\(\s*[^)]*queues\s*=\)/g,
    descriptionTemplate: "Spring @RabbitListener 注解声明的 RabbitMQ 消费者 {symbol}",
    framework: "Spring RabbitMQ",
  },
  // Python Kafka：consumer.subscribe(['topic'])
  {
    pattern: /\bconsumer\.subscribe\s*\(\s*\[?['"`]([^'"`]+)['"`]/g,
    descriptionTemplate: "Kafka-Python consumer.subscribe() 注册的 Kafka 消费者 {symbol}",
    framework: "Kafka-Python",
  },
  // Go sarami：consumer.ConsumePartition
  {
    pattern: /\bconsumer\.ConsumePartition\s*\(/g,
    descriptionTemplate: "Sarama consumer.ConsumePartition() 注册的 Kafka 消费者 {symbol}",
    framework: "Sarama",
  },
]);

// ============================================================================
// 主入口文件名识别规则
// ============================================================================

/**
 * 主入口文件名模式（用于 detectMain 识别）
 *
 * 这些文件名通常作为程序主入口：
 * - index.ts / index.js / index.mjs / index.cjs：Node.js 默认入口
 * - main.ts / main.js / main.mjs / main.cjs：Node.js 自定义入口
 * - app.ts / app.js / app.mjs / app.cjs：Express/Koa 入口
 * - server.ts / server.js：HTTP 服务器入口
 * - Main.java：Java 主类
 * - main.py / app.py：Python 主入口
 * - main.go：Go 主入口
 *
 * 使用 Object.freeze 冻结。
 */
const MAIN_ENTRY_FILENAMES: ReadonlyArray<string> = Object.freeze([
  "index.ts",
  "index.tsx",
  "index.js",
  "index.jsx",
  "index.mjs",
  "index.cjs",
  "main.ts",
  "main.tsx",
  "main.js",
  "main.jsx",
  "main.mjs",
  "main.cjs",
  "app.ts",
  "app.tsx",
  "app.js",
  "app.jsx",
  "app.mjs",
  "app.cjs",
  "server.ts",
  "server.js",
  "server.mjs",
  "server.cjs",
  "Main.java",
  "main.py",
  "app.py",
  "main.go",
]);

// ============================================================================
// 入口点检测器辅助类型
// ============================================================================

/**
 * 符号名提取结果（用于从正则匹配结果中提取符号名）
 */
interface SymbolMatch {
  /** 符号名（如 "UserController"、"login"） */
  readonly symbol: string;
  /** 描述（含符号名替换后的完整描述） */
  readonly description: string;
}

// ============================================================================
// EntryPointDetector 类
// ============================================================================

/**
 * 入口点检测器（实现 §5.11.1 L1 入口点识别）
 *
 * 提供真实检测逻辑（禁止 mock）：
 * - detectMain(map)：检测 main 入口（package.json bin/main 字段、index.ts/main.ts/app.ts 等）
 * - detectHttpRoutes(map)：检测 HTTP 路由注册
 * - detectScheduledTasks(map)：检测定时任务
 * - detectMqConsumers(map)：检测 MQ 消费者
 * - detectAll(map)：综合检测全部 4 类入口点
 *
 * 检测策略：
 * - main 入口：通过文件名启发式 + package.json bin/main 字段识别
 * - 其他 3 类：读取源代码文件内容，按正则表达式表匹配装饰器/函数调用模式
 *
 * 使用方式：
 * ```typescript
 * const detector = new EntryPointDetector();
 * const map = await new L1GlobalViewBuilder().build("/path/to/project");
 * const entryPoints = await detector.detectAll(map);
 * console.log(entryPoints);
 * ```
 */
export class EntryPointDetector {
  /**
   * 检测 main 入口
   *
   * 检测策略：
   * 1. 查找 package.json 文件，解析 main/bin 字段识别入口文件
   * 2. 查找文件名为 MAIN_ENTRY_FILENAMES 之一的源代码文件
   *
   * @param map 仓库地图
   * @returns main 入口点列表
   */
  async detectMain(map: RepositoryMap): Promise<ReadonlyArray<EntryPoint>> {
    const entryPoints: EntryPoint[] = [];

    // 策略 1：解析 package.json 的 main/bin 字段
    const packageJsonFile = map.files.find((f) => f.name === "package.json");
    if (packageJsonFile) {
      const mainEntries = await this.detectMainFromPackageJson(map, packageJsonFile.path);
      entryPoints.push(...mainEntries);
    }

    // 策略 2：通过文件名启发式识别
    for (const file of map.files) {
      if (MAIN_ENTRY_FILENAMES.includes(file.name)) {
        // 避免重复（package.json main 字段已识别的不再加入）
        const alreadyDetected = entryPoints.some((ep) => ep.filePath === file.path);
        if (!alreadyDetected) {
          entryPoints.push({
            type: "main",
            filePath: file.path,
            symbolName: this.extractSymbolName(file.name),
            description: `主入口文件 ${file.name}（基于文件名启发式识别）`,
          });
        }
      }
    }

    return Object.freeze(entryPoints.map((ep) => Object.freeze({ ...ep })));
  }

  /**
   * 检测 HTTP 路由注册
   *
   * 检测策略：
   * - 遍历源代码文件（.ts/.js/.java/.py/.go）
   * - 读取文件内容，按 HTTP_ROUTE_RULES 正则表匹配
   * - 每条匹配生成一个 EntryPoint（type="http-route"）
   *
   * @param map 仓库地图
   * @returns HTTP 路由入口点列表
   */
  async detectHttpRoutes(map: RepositoryMap): Promise<ReadonlyArray<EntryPoint>> {
    return this.detectByRules(map, HTTP_ROUTE_RULES, "http-route");
  }

  /**
   * 检测定时任务
   *
   * 检测策略：
   * - 遍历源代码文件（.ts/.js/.java/.py/.go）
   * - 读取文件内容，按 SCHEDULED_TASK_RULES 正则表匹配
   * - 每条匹配生成一个 EntryPoint（type="scheduled-task"）
   *
   * @param map 仓库地图
   * @returns 定时任务入口点列表
   */
  async detectScheduledTasks(map: RepositoryMap): Promise<ReadonlyArray<EntryPoint>> {
    return this.detectByRules(map, SCHEDULED_TASK_RULES, "scheduled-task");
  }

  /**
   * 检测 MQ 消费者
   *
   * 检测策略：
   * - 遍历源代码文件（.ts/.js/.java/.py/.go）
   * - 读取文件内容，按 MQ_CONSUMER_RULES 正则表匹配
   * - 每条匹配生成一个 EntryPoint（type="mq-consumer"）
   *
   * @param map 仓库地图
   * @returns MQ 消费者入口点列表
   */
  async detectMqConsumers(map: RepositoryMap): Promise<ReadonlyArray<EntryPoint>> {
    return this.detectByRules(map, MQ_CONSUMER_RULES, "mq-consumer");
  }

  /**
   * 综合检测全部 4 类入口点
   *
   * 并行调用 4 个检测方法，合并结果。
   *
   * @param map 仓库地图
   * @returns 全部入口点列表（4 类综合）
   */
  async detectAll(map: RepositoryMap): Promise<ReadonlyArray<EntryPoint>> {
    // 并行执行 4 类检测（Promise.all 提升性能）
    const [mainEntries, httpRoutes, scheduledTasks, mqConsumers] = await Promise.all([
      this.detectMain(map),
      this.detectHttpRoutes(map),
      this.detectScheduledTasks(map),
      this.detectMqConsumers(map),
    ]);

    // 合并结果
    const all = [...mainEntries, ...httpRoutes, ...scheduledTasks, ...mqConsumers];
    return Object.freeze(all.map((ep) => Object.freeze({ ...ep })));
  }

  // ============================ 私有辅助方法 ============================

  /**
   * 通用规则检测方法（适用于 HTTP 路由/定时任务/MQ 消费者三类）
   *
   * @param map 仓库地图
   * @param rules 检测规则列表
   * @param entryType 入口点类型
   * @returns 入口点列表
   */
  private async detectByRules(
    map: RepositoryMap,
    rules: ReadonlyArray<DetectionRule>,
    entryType: EntryPointType
  ): Promise<ReadonlyArray<EntryPoint>> {
    const entryPoints: EntryPoint[] = [];

    // 仅扫描源代码文件（按扩展名过滤）
    const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".java", ".py", ".go"]);
    const sourceFiles = map.files.filter((f) => sourceExtensions.has(f.extension));

    for (const file of sourceFiles) {
      // 读取文件内容
      const content = await this.readFileContent(map.rootPath, file.path);
      if (!content) {
        continue;
      }

      // 对每条规则进行匹配
      for (const rule of rules) {
        const matches = this.matchRule(content, rule);
        for (const match of matches) {
          entryPoints.push({
            type: entryType,
            filePath: file.path,
            symbolName: match.symbol,
            description: match.description,
          });
        }
      }
    }

    return Object.freeze(entryPoints.map((ep) => Object.freeze({ ...ep })));
  }

  /**
   * 从 package.json 解析 main/bin 字段识别入口
   *
   * @param map 仓库地图
   * @param packageJsonPath package.json 相对路径
   * @returns main 入口点列表
   */
  private async detectMainFromPackageJson(
    map: RepositoryMap,
    packageJsonPath: string
  ): Promise<ReadonlyArray<EntryPoint>> {
    const entryPoints: EntryPoint[] = [];
    const content = await this.readFileContent(map.rootPath, packageJsonPath);
    if (!content) {
      return entryPoints;
    }

    try {
      const pkgJson = JSON.parse(content);
      // main 字段：Node.js 模块默认入口
      if (typeof pkgJson.main === "string" && pkgJson.main.trim().length > 0) {
        entryPoints.push({
          type: "main",
          filePath: pkgJson.main,
          symbolName: this.extractSymbolName(pkgJson.main),
          description: `package.json main 字段声明的入口（${pkgJson.main}）`,
        });
      }
      // bin 字段：CLI 工具入口（字符串或对象）
      if (typeof pkgJson.bin === "string" && pkgJson.bin.trim().length > 0) {
        entryPoints.push({
          type: "main",
          filePath: pkgJson.bin,
          symbolName: this.extractSymbolName(pkgJson.bin),
          description: `package.json bin 字段声明的 CLI 入口（${pkgJson.bin}）`,
        });
      } else if (pkgJson.bin && typeof pkgJson.bin === "object") {
        for (const [binName, binPath] of Object.entries(pkgJson.bin)) {
          if (typeof binPath === "string") {
            entryPoints.push({
              type: "main",
              filePath: binPath,
              symbolName: binName,
              description: `package.json bin.${binName} 字段声明的 CLI 入口（${binPath}）`,
            });
          }
        }
      }
    } catch {
      // JSON 解析失败：跳过该文件
    }

    return entryPoints;
  }

  /**
   * 读取文件内容（异步，失败时返回 null）
   *
   * @param rootPath 项目根目录绝对路径
   * @param relativePath 文件相对路径
   * @returns 文件内容（失败时返回 null）
   */
  private async readFileContent(rootPath: string, relativePath: string): Promise<string | null> {
    try {
      const absolutePath = path.join(rootPath, relativePath);
      return await fs.readFile(absolutePath, "utf-8");
    } catch {
      return null;
    }
  }

  /**
   * 对文件内容应用检测规则，返回所有匹配结果
   *
   * 重置正则的 lastIndex（因为带 g 标志的正则会保持 lastIndex 状态，
   * 多次使用同一正则对象会导致漏匹配）。
   *
   * @param content 文件内容
   * @param rule 检测规则
   * @returns 匹配结果列表
   */
  private matchRule(content: string, rule: DetectionRule): SymbolMatch[] {
    const matches: SymbolMatch[] = [];
    // 重置 lastIndex（带 g 标志的正则需要重置）
    rule.pattern.lastIndex = 0;

    let match: RegExpExecArray | null;
    // 使用 while 循环提取所有匹配
    while ((match = rule.pattern.exec(content)) !== null) {
      // 提取符号名：优先使用第二个捕获组（路径/方法名），其次用第一个捕获组（装饰器名）
      const symbol = this.extractMatchSymbol(match);
      if (!symbol) {
        continue;
      }

      // 生成描述（替换 {symbol} 与 {method} 占位符）
      const description = rule.descriptionTemplate.replace("{symbol}", symbol).replace("{method}", match[1] || "");

      matches.push({ symbol, description });
    }

    return matches;
  }

  /**
   * 从正则匹配结果中提取符号名
   *
   * 优先级：
   * 1. 第二个捕获组（通常是路径/方法名，如 @Get('login') 中的 'login'）
   * 2. 第一个捕获组（通常是装饰器名，如 @Controller 中的 'Controller'）
   * 3. 兜底：'anonymous'
   *
   * @param match 正则匹配结果
   * @returns 符号名
   */
  private extractMatchSymbol(match: RegExpExecArray): string {
    // 第二个捕获组（路径/方法名）
    if (match[2] !== undefined && match[2] !== "") {
      return match[2];
    }
    // 第一个捕获组（装饰器名）
    if (match[1] !== undefined && match[1] !== "") {
      return match[1];
    }
    return "anonymous";
  }

  /**
   * 从文件名/路径中提取符号名
   *
   * 策略：
   * - 取 basename（含扩展名）
   * - 去除扩展名
   * - 首字母大写（如 "index.ts" → "Index"）
   *
   * @param filePath 文件路径或文件名
   * @returns 符号名
   */
  private extractSymbolName(filePath: string): string {
    const basename = path.basename(filePath);
    const ext = path.extname(basename);
    const nameWithoutExt = basename.slice(0, basename.length - ext.length);
    if (nameWithoutExt.length === 0) {
      return basename;
    }
    // 首字母大写
    return nameWithoutExt.charAt(0).toUpperCase() + nameWithoutExt.slice(1);
  }
}
