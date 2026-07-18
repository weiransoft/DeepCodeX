/**
 * EAG-P1 批次 4 单元测试：技术选型矩阵注册表
 *
 * 测试范围：
 * - T1. TECH_STACK_MATRIX 常量已冻结
 * - T2. 矩阵完整性（4 语言 × 10 层 = 40 单元格）
 * - T3. 每个单元格至少 1 个选项
 * - T4. 每个单元格 options 按 priority 升序排列
 * - T5. TypeScript 系矩阵内容正确性（严格对齐 §5.6.1 表格）
 * - T6. Java 系矩阵内容正确性
 * - T7. Python 系矩阵内容正确性
 * - T8. Go 系矩阵内容正确性
 * - T9. getTechStackOptions 查询函数正确性
 * - T10. getAllLayers / getAllLanguages / getMatrixCellCount 查询函数正确性
 * - T11. 矩阵深度冻结（嵌套对象也冻结）
 *
 * 测试约定：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，使用真实 TECH_STACK_MATRIX 常量
 * - 严格对齐 §5.6.1 表格内容
 *
 * @module core/tests/eag-etsb-tech-stack-registry
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TECH_STACK_MATRIX,
  getTechStackOptions,
  getAllLayers,
  getAllLanguages,
  getMatrixCellCount,
} from "../eag/etsb/tech-stack-registry";
import { TECH_LANGUAGES, TECH_LAYERS } from "../eag/etsb/types";
import type { TechLanguage, TechLayer } from "../eag/etsb/types";

// ============================================================================
// T1. TECH_STACK_MATRIX 常量已冻结
// ============================================================================

test("T1a. TECH_STACK_MATRIX 顶层已冻结", () => {
  assert.ok(Object.isFrozen(TECH_STACK_MATRIX));
});

test("T1b. TECH_STACK_MATRIX.cells 已冻结", () => {
  assert.ok(Object.isFrozen(TECH_STACK_MATRIX.cells));
});

// ============================================================================
// T2. 矩阵完整性（4 语言 × 10 层 = 40 单元格）
// ============================================================================

test("T2a. 矩阵包含 4 个语言维度", () => {
  const languages = Object.keys(TECH_STACK_MATRIX.cells);
  assert.equal(languages.length, 4);
  assert.deepEqual(languages.sort(), ["go", "java", "python", "typescript"]);
});

test("T2b. 每个语言维度包含 10 个层", () => {
  for (const lang of TECH_LANGUAGES) {
    const layers = Object.keys(TECH_STACK_MATRIX.cells[lang]);
    assert.equal(layers.length, 10, `语言 ${lang} 应包含 10 个层，实际 ${layers.length}`);
  }
});

test("T2c. 矩阵单元格总数 = 40（4 语言 × 10 层）", () => {
  let cellCount = 0;
  for (const lang of TECH_LANGUAGES) {
    for (const layer of TECH_LAYERS) {
      const options = TECH_STACK_MATRIX.cells[lang][layer];
      if (options && options.length > 0) {
        cellCount++;
      }
    }
  }
  assert.equal(cellCount, 40);
});

test("T2d. getMatrixCellCount() 返回 40", () => {
  assert.equal(getMatrixCellCount(), 40);
});

// ============================================================================
// T3. 每个单元格至少 1 个选项
// ============================================================================

test("T3. 每个单元格至少 1 个选项", () => {
  for (const lang of TECH_LANGUAGES) {
    for (const layer of TECH_LAYERS) {
      const options = TECH_STACK_MATRIX.cells[lang][layer];
      assert.ok(
        options && options.length >= 1,
        `单元格 [${lang}][${layer}] 应至少 1 个选项，实际 ${options?.length ?? 0}`
      );
    }
  }
});

// ============================================================================
// T4. 每个单元格 options 按 priority 升序排列
// ============================================================================

test("T4. 每个单元格 options 按 priority 升序排列", () => {
  for (const lang of TECH_LANGUAGES) {
    for (const layer of TECH_LAYERS) {
      const options = TECH_STACK_MATRIX.cells[lang][layer];
      for (let i = 1; i < options.length; i++) {
        assert.ok(
          options[i - 1].priority <= options[i].priority,
          `单元格 [${lang}][${layer}] 的 options 未按 priority 升序：` +
            `位置 ${i - 1} priority=${options[i - 1].priority}，位置 ${i} priority=${options[i].priority}`
        );
      }
    }
  }
});

// ============================================================================
// T5. TypeScript 系矩阵内容正确性（严格对齐 §5.6.1 表格）
// ============================================================================

test("T5a. TypeScript frontend 包含 React 18 + Ant Design（首选）与 Vue 3 + Element Plus（备选）", () => {
  const options = TECH_STACK_MATRIX.cells.typescript.frontend;
  assert.equal(options.length, 2);
  assert.equal(options[0].priority, 1);
  assert.ok(options[0].name.includes("React 18"));
  assert.ok(options[0].name.includes("Ant Design"));
  assert.equal(options[1].priority, 2);
  assert.ok(options[1].name.includes("Vue 3"));
  assert.ok(options[1].name.includes("Element Plus"));
});

test("T5b. TypeScript backend-framework 包含 NestJS（首选）与 Express（备选）", () => {
  const options = TECH_STACK_MATRIX.cells.typescript["backend-framework"];
  assert.equal(options.length, 2);
  assert.ok(options[0].name.includes("NestJS"));
  assert.equal(options[0].priority, 1);
  assert.ok(options[1].name.includes("Express"));
  assert.equal(options[1].priority, 2);
});

test("T5c. TypeScript orm 包含 Prisma（首选）与 TypeORM（备选）", () => {
  const options = TECH_STACK_MATRIX.cells.typescript.orm;
  assert.equal(options.length, 2);
  assert.ok(options[0].name.includes("Prisma"));
  assert.ok(options[1].name.includes("TypeORM"));
});

test("T5d. TypeScript cache 包含 Redis（ioredis）", () => {
  const options = TECH_STACK_MATRIX.cells.typescript.cache;
  assert.equal(options.length, 1);
  assert.ok(options[0].name.includes("Redis"));
  assert.ok(options[0].name.includes("ioredis"));
});

test("T5e. TypeScript message-queue 包含 BullMQ（首选）与 Kafka（备选）", () => {
  const options = TECH_STACK_MATRIX.cells.typescript["message-queue"];
  assert.equal(options.length, 2);
  assert.ok(options[0].name.includes("BullMQ"));
  assert.ok(options[1].name.includes("Kafka"));
});

test("T5f. TypeScript object-storage 包含 S3 SDK", () => {
  const options = TECH_STACK_MATRIX.cells.typescript["object-storage"];
  assert.ok(options[0].name.includes("S3"));
});

test("T5g. TypeScript search 包含 Elasticsearch（首选）与 Meilisearch（备选）", () => {
  const options = TECH_STACK_MATRIX.cells.typescript.search;
  assert.ok(options[0].name.includes("Elasticsearch"));
  assert.ok(options[1].name.includes("Meilisearch"));
});

test("T5h. TypeScript task-scheduler 包含 node-cron（首选）与 BullMQ（备选）", () => {
  const options = TECH_STACK_MATRIX.cells.typescript["task-scheduler"];
  assert.ok(options[0].name.includes("node-cron"));
  assert.ok(options[1].name.includes("BullMQ"));
});

test("T5i. TypeScript auth 包含 JWT + Passport（首选）与 Casdoor（备选）", () => {
  const options = TECH_STACK_MATRIX.cells.typescript.auth;
  assert.ok(options[0].name.includes("JWT"));
  assert.ok(options[0].name.includes("Passport"));
  assert.ok(options[1].name.includes("Casdoor"));
});

test("T5j. TypeScript api-contract 包含 OpenAPI", () => {
  const options = TECH_STACK_MATRIX.cells.typescript["api-contract"];
  assert.ok(options[0].name.includes("OpenAPI"));
});

// ============================================================================
// T6. Java 系矩阵内容正确性
// ============================================================================

test("T6a. Java frontend 为前后端分离方案（无原生 Java 前端框架）", () => {
  const options = TECH_STACK_MATRIX.cells.java.frontend;
  assert.equal(options.length, 1);
  assert.ok(options[0].name.includes("前后端分离"));
  assert.ok(options[0].name.includes("TypeScript"));
});

test("T6b. Java backend-framework 包含 Spring Boot 3", () => {
  const options = TECH_STACK_MATRIX.cells.java["backend-framework"];
  assert.ok(options[0].name.includes("Spring Boot 3"));
});

test("T6c. Java orm 包含 MyBatis-Plus（首选）与 JPA（备选）", () => {
  const options = TECH_STACK_MATRIX.cells.java.orm;
  assert.ok(options[0].name.includes("MyBatis-Plus"));
  assert.ok(options[1].name.includes("JPA"));
});

test("T6d. Java cache 包含 Redis + Caffeine", () => {
  const options = TECH_STACK_MATRIX.cells.java.cache;
  assert.ok(options[0].name.includes("Redis"));
  assert.ok(options[0].name.includes("Caffeine"));
});

test("T6e. Java message-queue 包含 RocketMQ / Kafka / RabbitMQ（3 个选项）", () => {
  const options = TECH_STACK_MATRIX.cells.java["message-queue"];
  assert.ok(options.length >= 3);
  assert.ok(options[0].name.includes("RocketMQ"));
  assert.ok(options[1].name.includes("Kafka"));
  assert.ok(options[2].name.includes("RabbitMQ"));
});

test("T6f. Java auth 包含 Spring Security + OAuth2（首选）与 Sa-Token（备选）", () => {
  const options = TECH_STACK_MATRIX.cells.java.auth;
  assert.ok(options[0].name.includes("Spring Security"));
  assert.ok(options[0].name.includes("OAuth2"));
  assert.ok(options[1].name.includes("Sa-Token"));
});

// ============================================================================
// T7. Python 系矩阵内容正确性
// ============================================================================

test("T7a. Python frontend 为前后端分离方案", () => {
  const options = TECH_STACK_MATRIX.cells.python.frontend;
  assert.ok(options[0].name.includes("前后端分离"));
});

test("T7b. Python backend-framework 包含 FastAPI（首选）与 Django（备选）", () => {
  const options = TECH_STACK_MATRIX.cells.python["backend-framework"];
  assert.ok(options[0].name.includes("FastAPI"));
  assert.ok(options[1].name.includes("Django"));
});

test("T7c. Python orm 包含 SQLAlchemy（首选）与 Django ORM（备选）", () => {
  const options = TECH_STACK_MATRIX.cells.python.orm;
  assert.ok(options[0].name.includes("SQLAlchemy"));
  assert.ok(options[1].name.includes("Django ORM"));
});

test("T7d. Python message-queue 包含 Celery（首选）与 Kafka（备选）", () => {
  const options = TECH_STACK_MATRIX.cells.python["message-queue"];
  assert.ok(options[0].name.includes("Celery"));
  assert.ok(options[1].name.includes("Kafka"));
});

test("T7e. Python api-contract 包含 FastAPI 原生", () => {
  const options = TECH_STACK_MATRIX.cells.python["api-contract"];
  assert.ok(options[0].name.includes("FastAPI"));
});

// ============================================================================
// T8. Go 系矩阵内容正确性
// ============================================================================

test("T8a. Go frontend 为前后端分离方案", () => {
  const options = TECH_STACK_MATRIX.cells.go.frontend;
  assert.ok(options[0].name.includes("前后端分离"));
});

test("T8b. Go backend-framework 包含 Gin（首选）与 go-zero（备选）", () => {
  const options = TECH_STACK_MATRIX.cells.go["backend-framework"];
  assert.ok(options[0].name.includes("Gin"));
  assert.ok(options[1].name.includes("go-zero"));
});

test("T8c. Go orm 包含 GORM（首选）与 sqlx（备选）", () => {
  const options = TECH_STACK_MATRIX.cells.go.orm;
  assert.ok(options[0].name.includes("GORM"));
  assert.ok(options[1].name.includes("sqlx"));
});

test("T8d. Go message-queue 包含 Kafka（首选）与 NATS（备选）", () => {
  const options = TECH_STACK_MATRIX.cells.go["message-queue"];
  assert.ok(options[0].name.includes("Kafka"));
  assert.ok(options[1].name.includes("NATS"));
});

test("T8e. Go auth 包含 JWT + Casbin", () => {
  const options = TECH_STACK_MATRIX.cells.go.auth;
  assert.ok(options[0].name.includes("JWT"));
  assert.ok(options[0].name.includes("Casbin"));
});

// ============================================================================
// T9. getTechStackOptions 查询函数正确性
// ============================================================================

test("T9a. getTechStackOptions 返回指定语言与层的 options", () => {
  const options = getTechStackOptions("typescript", "frontend");
  assert.ok(options.length >= 1);
  assert.ok(options[0].name.includes("React"));
});

test("T9b. getTechStackOptions 返回的 options 与矩阵直查一致", () => {
  const directOptions = TECH_STACK_MATRIX.cells.java["backend-framework"];
  const funcOptions = getTechStackOptions("java", "backend-framework");
  assert.equal(directOptions.length, funcOptions.length);
  for (let i = 0; i < directOptions.length; i++) {
    assert.equal(directOptions[i].name, funcOptions[i].name);
    assert.equal(directOptions[i].priority, funcOptions[i].priority);
  }
});

test("T9c. getTechStackOptions 覆盖全部 4 语言 × 10 层组合", () => {
  for (const lang of TECH_LANGUAGES) {
    for (const layer of TECH_LAYERS) {
      const options = getTechStackOptions(lang, layer);
      assert.ok(options.length >= 1, `getTechStackOptions(${lang}, ${layer}) 应返回非空数组`);
    }
  }
});

// ============================================================================
// T10. getAllLayers / getAllLanguages / getMatrixCellCount 查询函数正确性
// ============================================================================

test("T10a. getAllLayers 返回 10 个层", () => {
  const layers = getAllLayers();
  assert.equal(layers.length, 10);
});

test("T10b. getAllLayers 返回的层与 TECH_LAYERS 一致", () => {
  const layers = getAllLayers();
  assert.deepEqual([...layers], [...TECH_LAYERS]);
});

test("T10c. getAllLanguages 返回 4 个语言", () => {
  const langs = getAllLanguages();
  assert.equal(langs.length, 4);
});

test("T10d. getAllLanguages 返回的语言与 TECH_LANGUAGES 一致", () => {
  const langs = getAllLanguages();
  assert.deepEqual([...langs], [...TECH_LANGUAGES]);
});

test("T10e. getMatrixCellCount 返回 40", () => {
  assert.equal(getMatrixCellCount(), 40);
});

// ============================================================================
// T11. 矩阵深度冻结（嵌套对象也冻结）
// ============================================================================

test("T11a. 矩阵的语言子对象已冻结", () => {
  for (const lang of TECH_LANGUAGES) {
    assert.ok(Object.isFrozen(TECH_STACK_MATRIX.cells[lang]), `cells.${lang} 应被冻结`);
  }
});

test("T11b. 矩阵的层 options 数组已冻结", () => {
  for (const lang of TECH_LANGUAGES) {
    for (const layer of TECH_LAYERS) {
      const options = TECH_STACK_MATRIX.cells[lang][layer];
      assert.ok(Object.isFrozen(options), `cells.${lang}.${layer} options 数组应被冻结`);
    }
  }
});

test("T11c. 矩阵的 option 对象已冻结（深度冻结验证）", () => {
  // 抽检若干单元格的 option 对象是否冻结
  const sampleOption = TECH_STACK_MATRIX.cells.typescript.frontend[0];
  assert.ok(Object.isFrozen(sampleOption), "TypeScript frontend 首选 option 应被冻结");
  const javaOption = TECH_STACK_MATRIX.cells.java["backend-framework"][0];
  assert.ok(Object.isFrozen(javaOption), "Java backend-framework 首选 option 应被冻结");
});
