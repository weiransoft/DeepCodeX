/**
 * EAG-P4 批次 13 Phase 7 §5.1：EagCommandParser 单元测试 —— /eag-deploy 命令
 * （拆分自 eag-cli-command-parser.test.ts）
 *
 * 测试范围：
 * - L. /eag-deploy 命令（parseEagDeployCommand + extractDeployRequest + extractDeployRequestFromPrompt）
 *   （EAG-P4 批次 13 Phase 7 §5.1）
 * - L58. 向后兼容验证：既有 6 个命令零回归（P-10 规则）
 *
 * 测试约定（严格遵循项目"禁止 mock"规则）：
 * - 使用 node:test + node:assert/strict
 * - 真实组件：直接 new EagCommandParser()，不通过 SessionManager 注入
 * - 所有 fixture 使用 Object.freeze 冻结（对齐不可变优先 §5.12.4 G-A6d）
 * - 中文注释
 *
 * 设计依据：
 * - EAG-P4 批次 13 Phase 7 §5.1（/eag-deploy 命令扩展）
 * - EAG 方案 §5.12.4 G-A6d 配置冻结原则（不可变优先）
 * - eag/cli/eag-command-parser.ts（EagCommandParser 类与 extractDeployRequestFromPrompt 函数）
 *
 * 注：原 K 段（边界情况）已存在 K39-K41，本段使用 L 作为字母前缀避免命名冲突
 *
 * @module tests/eag-cli-parser-deploy
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EagCommandParser, EAG_COMMAND_STRINGS, extractDeployRequestFromPrompt } from "../eag/cli/eag-command-parser";
import type { DeployRequest } from "../eag/cli/eag-command-parser";
import type { CodingLoopRequest } from "../eag/coding/types";
import type { DesignLoopInput } from "../eag/design/design-models";
import type { TestingLoopRequest } from "../eag/testing/types";
import type { EagRunRequest, EagResumeRequest, EagStatusRequest } from "../eag/long-horizon/index";
import {
  createMinimalCodingLoopRequest,
  createMinimalDesignLoopInput,
  createMinimalTestingLoopRequest,
  createMinimalEagRunRequest,
  createMinimalEagResumeRequest,
  createMinimalEagStatusRequest,
  createMinimalDeployRequest,
  createMinimalDeployRequestWithDryRun,
} from "./fixtures/eag-command-fixtures";

// ============================================================================
// L. /eag-deploy 命令测试（parseEagDeployCommand + extractDeployRequest + extractDeployRequestFromPrompt）
// EAG-P4 批次 13 Phase 7 §5.1
// 注：原 K 段（边界情况）已存在 K39-K41，本段使用 L 作为字母前缀避免命名冲突
// ============================================================================

test("L42. /eag-deploy 命令分发（parse + parseEagDeployCommand）", () => {
  // 验证 parse() 与 parseEagDeployCommand() 对 /eag-deploy 命令的分发逻辑
  // 对齐设计文档 §5.1：命令字符串严格匹配，参数通过 messageParams 注入
  const parser = new EagCommandParser();

  // 情况 1：parse() 对 /eag-deploy 命令返回 kind=eag-deploy（payload 默认 null）
  const cmd1 = parser.parse({ text: "/eag-deploy" });
  assert.equal(cmd1.kind, "eag-deploy");
  assert.equal(cmd1.payload, null);

  // 情况 2：parse() 对 trim 后的 /eag-deploy 命令仍识别
  const cmd2 = parser.parse({ text: "  /eag-deploy  " });
  assert.equal(cmd2.kind, "eag-deploy");
  assert.equal(cmd2.payload, null);

  // 情况 3：parseEagDeployCommand() 对 /eag-deploy 命令返回 eag-deploy kind
  const cmd3 = parser.parseEagDeployCommand({ text: "/eag-deploy" });
  assert.equal(cmd3.kind, "eag-deploy");
  assert.equal(cmd3.payload, null);

  // 情况 4：parseEagDeployCommand() 对其他 EAG 命令返回 unknown
  assert.equal(parser.parseEagDeployCommand({ text: "/eag-build" }).kind, "unknown");
  assert.equal(parser.parseEagDeployCommand({ text: "/eag-design" }).kind, "unknown");
  assert.equal(parser.parseEagDeployCommand({ text: "/eag-test" }).kind, "unknown");
  assert.equal(parser.parseEagDeployCommand({ text: "/eag-run" }).kind, "unknown");
  assert.equal(parser.parseEagDeployCommand({ text: "/eag-resume" }).kind, "unknown");
  assert.equal(parser.parseEagDeployCommand({ text: "/eag-status" }).kind, "unknown");

  // 情况 5：parseEagDeployCommand() 对非命令文本返回 unknown
  assert.equal(parser.parseEagDeployCommand({ text: "请帮我执行 /eag-deploy" }).kind, "unknown");
  assert.equal(parser.parseEagDeployCommand({ text: "/eag-deploy arg" }).kind, "unknown");
  assert.equal(parser.parseEagDeployCommand({ text: undefined }).kind, "unknown");
  assert.equal(parser.parseEagDeployCommand({ text: "/EAG-DEPLOY" }).kind, "unknown");

  // 情况 6：parseEagDeployCommand() 对含图片附件返回 unknown（避免误判）
  const cmdImg = parser.parseEagDeployCommand({
    text: "/eag-deploy",
    imageUrls: ["data:image/png;base64,iVBORw0KGgo="],
  });
  assert.equal(cmdImg.kind, "unknown");
  assert.equal(cmdImg.payload, null);

  // 情况 7：parseEagDeployCommand() 对含技能匹配返回 unknown（避免误判）
  const cmdSkill = parser.parseEagDeployCommand({
    text: "/eag-deploy",
    skills: [{ name: "test-skill", path: "/", description: "测试技能" }],
  });
  assert.equal(cmdSkill.kind, "unknown");
  assert.equal(cmdSkill.payload, null);

  // 情况 8：parse() 返回的对象被冻结（§5.12.4 G-A6d）
  assert.ok(Object.isFrozen(cmd1), "parse 返回的 /eag-deploy 对象应被冻结");
});

test("L43. extractDeployRequest 字段校验逻辑（合法/缺失/类型错误）", () => {
  // 验证 extractDeployRequest 字段校验逻辑（通过 parse 间接测试）
  // extractDeployRequest 为 private 方法，通过 parse() 间接验证
  const parser = new EagCommandParser();

  // 情况 1：messageParams 缺失 → payload 为 null
  assert.equal(parser.parse({ text: "/eag-deploy" }).payload, null);
  // 情况 1：messageParams 为 null → payload 为 null
  assert.equal(parser.parse({ text: "/eag-deploy", messageParams: null }).payload, null);
  // 情况 1：messageParams 为空对象 → payload 为 null
  assert.equal(parser.parse({ text: "/eag-deploy", messageParams: {} }).payload, null);
  // 情况 2：deployRequest 字段缺失 → payload 为 null
  assert.equal(parser.parse({ text: "/eag-deploy", messageParams: { other: "value" } }).payload, null);
  // 情况 2：deployRequest 字段非对象 → payload 为 null
  assert.equal(parser.parse({ text: "/eag-deploy", messageParams: { deployRequest: "not-object" } }).payload, null);
  assert.equal(parser.parse({ text: "/eag-deploy", messageParams: { deployRequest: 123 } }).payload, null);
  assert.equal(parser.parse({ text: "/eag-deploy", messageParams: { deployRequest: [] } }).payload, null);
  // 情况 2：deployRequest 为 null → payload 为 null
  assert.equal(parser.parse({ text: "/eag-deploy", messageParams: { deployRequest: null } }).payload, null);

  // 情况 3：projectName 缺失 → payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-deploy",
      messageParams: {
        deployRequest: {
          environment: "prod",
          image: "img",
          port: 8080,
          replicas: 3,
          iacType: "terraform",
          strategy: "rolling",
        },
      },
    }).payload,
    null
  );
  // 情况 3：projectName 为空字符串 → payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-deploy",
      messageParams: {
        deployRequest: {
          projectName: "   ",
          environment: "prod",
          image: "img",
          port: 8080,
          replicas: 3,
          iacType: "terraform",
          strategy: "rolling",
        },
      },
    }).payload,
    null
  );
  // 情况 3：projectName 为非字符串 → payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-deploy",
      messageParams: {
        deployRequest: {
          projectName: 123,
          environment: "prod",
          image: "img",
          port: 8080,
          replicas: 3,
          iacType: "terraform",
          strategy: "rolling",
        },
      },
    }).payload,
    null
  );

  // 情况 4：environment 取值非法 → payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-deploy",
      messageParams: {
        deployRequest: {
          projectName: "svc",
          environment: "production",
          image: "img",
          port: 8080,
          replicas: 3,
          iacType: "terraform",
          strategy: "rolling",
        },
      },
    }).payload,
    null
  );
  // 情况 4：environment 缺失 → payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-deploy",
      messageParams: {
        deployRequest: {
          projectName: "svc",
          image: "img",
          port: 8080,
          replicas: 3,
          iacType: "terraform",
          strategy: "rolling",
        },
      },
    }).payload,
    null
  );

  // 情况 5：image 缺失 → payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-deploy",
      messageParams: {
        deployRequest: {
          projectName: "svc",
          environment: "prod",
          port: 8080,
          replicas: 3,
          iacType: "terraform",
          strategy: "rolling",
        },
      },
    }).payload,
    null
  );
  // 情况 5：image 为空字符串 → payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-deploy",
      messageParams: {
        deployRequest: {
          projectName: "svc",
          environment: "prod",
          image: "  ",
          port: 8080,
          replicas: 3,
          iacType: "terraform",
          strategy: "rolling",
        },
      },
    }).payload,
    null
  );

  // 情况 6：port 非数字 → payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-deploy",
      messageParams: {
        deployRequest: {
          projectName: "svc",
          environment: "prod",
          image: "img",
          port: "8080",
          replicas: 3,
          iacType: "terraform",
          strategy: "rolling",
        },
      },
    }).payload,
    null
  );
  // 情况 6：port 非整数 → payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-deploy",
      messageParams: {
        deployRequest: {
          projectName: "svc",
          environment: "prod",
          image: "img",
          port: 80.5,
          replicas: 3,
          iacType: "terraform",
          strategy: "rolling",
        },
      },
    }).payload,
    null
  );
  // 情况 6：port 小于 1 → payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-deploy",
      messageParams: {
        deployRequest: {
          projectName: "svc",
          environment: "prod",
          image: "img",
          port: 0,
          replicas: 3,
          iacType: "terraform",
          strategy: "rolling",
        },
      },
    }).payload,
    null
  );
  // 情况 6：port 大于 65535 → payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-deploy",
      messageParams: {
        deployRequest: {
          projectName: "svc",
          environment: "prod",
          image: "img",
          port: 65536,
          replicas: 3,
          iacType: "terraform",
          strategy: "rolling",
        },
      },
    }).payload,
    null
  );

  // 情况 7：replicas 非数字 → payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-deploy",
      messageParams: {
        deployRequest: {
          projectName: "svc",
          environment: "prod",
          image: "img",
          port: 8080,
          replicas: "3",
          iacType: "terraform",
          strategy: "rolling",
        },
      },
    }).payload,
    null
  );
  // 情况 7：replicas 非整数 → payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-deploy",
      messageParams: {
        deployRequest: {
          projectName: "svc",
          environment: "prod",
          image: "img",
          port: 8080,
          replicas: 3.5,
          iacType: "terraform",
          strategy: "rolling",
        },
      },
    }).payload,
    null
  );
  // 情况 7：replicas 小于 1 → payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-deploy",
      messageParams: {
        deployRequest: {
          projectName: "svc",
          environment: "prod",
          image: "img",
          port: 8080,
          replicas: 0,
          iacType: "terraform",
          strategy: "rolling",
        },
      },
    }).payload,
    null
  );
  // 情况 7：replicas 大于 100 → payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-deploy",
      messageParams: {
        deployRequest: {
          projectName: "svc",
          environment: "prod",
          image: "img",
          port: 8080,
          replicas: 101,
          iacType: "terraform",
          strategy: "rolling",
        },
      },
    }).payload,
    null
  );

  // 情况 8：iacType 取值非法 → payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-deploy",
      messageParams: {
        deployRequest: {
          projectName: "svc",
          environment: "prod",
          image: "img",
          port: 8080,
          replicas: 3,
          iacType: "pulumi",
          strategy: "rolling",
        },
      },
    }).payload,
    null
  );
  // 情况 8：iacType 缺失 → payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-deploy",
      messageParams: {
        deployRequest: {
          projectName: "svc",
          environment: "prod",
          image: "img",
          port: 8080,
          replicas: 3,
          strategy: "rolling",
        },
      },
    }).payload,
    null
  );

  // 情况 9：strategy 取值非法 → payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-deploy",
      messageParams: {
        deployRequest: {
          projectName: "svc",
          environment: "prod",
          image: "img",
          port: 8080,
          replicas: 3,
          iacType: "terraform",
          strategy: "recreate",
        },
      },
    }).payload,
    null
  );
  // 情况 9：strategy 缺失 → payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-deploy",
      messageParams: {
        deployRequest: {
          projectName: "svc",
          environment: "prod",
          image: "img",
          port: 8080,
          replicas: 3,
          iacType: "terraform",
        },
      },
    }).payload,
    null
  );

  // 情况 10：dryRun 为非 boolean → payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-deploy",
      messageParams: {
        deployRequest: {
          projectName: "svc",
          environment: "prod",
          image: "img",
          port: 8080,
          replicas: 3,
          iacType: "terraform",
          strategy: "rolling",
          dryRun: "yes",
        },
      },
    }).payload,
    null
  );

  // 情况 11：字段完整（无 dryRun）→ payload 为 DeployRequest 对象
  const validRequest = createMinimalDeployRequest();
  const parsed = parser.parse({
    text: "/eag-deploy",
    messageParams: { deployRequest: validRequest },
  });
  assert.ok(parsed.payload, "字段完整时应返回 DeployRequest 对象");
  assert.equal((parsed.payload as DeployRequest).projectName, "order-service");
  assert.equal((parsed.payload as DeployRequest).environment, "prod");
  assert.equal((parsed.payload as DeployRequest).image, "registry.example.com/order-service:v1.2.3");
  assert.equal((parsed.payload as DeployRequest).port, 8080);
  assert.equal((parsed.payload as DeployRequest).replicas, 3);
  assert.equal((parsed.payload as DeployRequest).iacType, "helm-chart");
  assert.equal((parsed.payload as DeployRequest).strategy, "blue-green");
  assert.equal((parsed.payload as DeployRequest).dryRun, undefined);

  // 情况 12：字段完整（含 dryRun=true）→ payload 为 DeployRequest 对象
  const validRequestWithDryRun = createMinimalDeployRequestWithDryRun();
  const parsedWithDryRun = parser.parse({
    text: "/eag-deploy",
    messageParams: { deployRequest: validRequestWithDryRun },
  });
  assert.ok(parsedWithDryRun.payload, "字段完整（含 dryRun）时应返回 DeployRequest 对象");
  assert.equal((parsedWithDryRun.payload as DeployRequest).dryRun, true);
});

test("L44. extractDeployRequestFromPrompt 合法命令字符串解析（K3a）", () => {
  // 验证 extractDeployRequestFromPrompt 对合法命令字符串的解析
  // 包含全部 7 个必填参数，无 dryRun
  const prompt =
    "/eag-deploy --project order-service --env prod --image registry.example.com/order-service:v1.2.3 --port 8080 --replicas 3 --iac helm-chart --strategy blue-green";
  const request = extractDeployRequestFromPrompt(prompt);

  // 验证所有字段被正确解析
  assert.equal(request.projectName, "order-service");
  assert.equal(request.environment, "prod");
  assert.equal(request.image, "registry.example.com/order-service:v1.2.3");
  assert.equal(request.port, 8080);
  assert.equal(request.replicas, 3);
  assert.equal(request.iacType, "helm-chart");
  assert.equal(request.strategy, "blue-green");
  // dryRun 未提供时应为 undefined
  assert.equal(request.dryRun, undefined);
});

test("L45. extractDeployRequestFromPrompt 缺少必填参数抛错（K3b）", () => {
  // 验证 extractDeployRequestFromPrompt 在缺少任一必填参数时抛 Error
  // 错误信息应含参数名

  // 缺少 --project
  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --env prod --image img --port 8080 --replicas 3 --iac terraform --strategy rolling"
      ),
    /--project/,
    "缺少 --project 应抛包含参数名的错误"
  );

  // 缺少 --env
  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --project svc --image img --port 8080 --replicas 3 --iac terraform --strategy rolling"
      ),
    /--env/,
    "缺少 --env 应抛包含参数名的错误"
  );

  // 缺少 --image
  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --project svc --env prod --port 8080 --replicas 3 --iac terraform --strategy rolling"
      ),
    /--image/,
    "缺少 --image 应抛包含参数名的错误"
  );

  // 缺少 --port
  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --project svc --env prod --image img --replicas 3 --iac terraform --strategy rolling"
      ),
    /--port/,
    "缺少 --port 应抛包含参数名的错误"
  );

  // 缺少 --replicas
  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --project svc --env prod --image img --port 8080 --iac terraform --strategy rolling"
      ),
    /--replicas/,
    "缺少 --replicas 应抛包含参数名的错误"
  );

  // 缺少 --iac
  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --project svc --env prod --image img --port 8080 --replicas 3 --strategy rolling"
      ),
    /--iac/,
    "缺少 --iac 应抛包含参数名的错误"
  );

  // 缺少 --strategy
  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --project svc --env prod --image img --port 8080 --replicas 3 --iac terraform"
      ),
    /--strategy/,
    "缺少 --strategy 应抛包含参数名的错误"
  );

  // 完全无参数（仅命令前缀）
  assert.throws(
    () => extractDeployRequestFromPrompt("/eag-deploy"),
    /--project/,
    "仅命令前缀时应抛缺少 --project 的错误"
  );

  // prompt 为空字符串
  assert.throws(() => extractDeployRequestFromPrompt(""), /不能为空字符串/, "空字符串应抛特定错误");

  // 命令前缀不匹配
  assert.throws(
    () => extractDeployRequestFromPrompt("/eag-build --project svc"),
    /命令前缀不匹配/,
    "命令前缀不匹配应抛特定错误"
  );
});

test("L46. extractDeployRequestFromPrompt --env 取值非法抛错（K3c）", () => {
  // 验证 --env 取值不在 dev | staging | prod 时抛 Error
  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --project svc --env production --image img --port 8080 --replicas 3 --iac terraform --strategy rolling"
      ),
    /--env 取值非法/,
    "--env production 应抛取值非法错误"
  );

  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --project svc --env develop --image img --port 8080 --replicas 3 --iac terraform --strategy rolling"
      ),
    /--env 取值非法/,
    "--env develop 应抛取值非法错误"
  );

  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --project svc --env PROD --image img --port 8080 --replicas 3 --iac terraform --strategy rolling"
      ),
    /--env 取值非法/,
    "--env PROD（大写）应抛取值非法错误（大小写敏感）"
  );

  // 验证合法取值不抛错
  for (const env of ["dev", "staging", "prod"] as const) {
    const request = extractDeployRequestFromPrompt(
      `/eag-deploy --project svc --env ${env} --image img --port 8080 --replicas 3 --iac terraform --strategy rolling`
    );
    assert.equal(request.environment, env);
  }
});

test("L47. extractDeployRequestFromPrompt --port 非正整数抛错（K3d）", () => {
  // 验证 --port 非正整数（小数、字符串、负数）时抛 Error
  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --project svc --env prod --image img --port 80.5 --replicas 3 --iac terraform --strategy rolling"
      ),
    /--port 取值非法/,
    "--port 80.5（小数）应抛取值非法错误"
  );

  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --project svc --env prod --image img --port abc --replicas 3 --iac terraform --strategy rolling"
      ),
    /--port 取值非法/,
    "--port abc（非数字）应抛取值非法错误"
  );

  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --project svc --env prod --image img --port -1 --replicas 3 --iac terraform --strategy rolling"
      ),
    /--port 取值非法/,
    "--port -1（负数）应抛取值非法错误"
  );
});

test("L48. extractDeployRequestFromPrompt --port 超范围抛错（K3e）", () => {
  // 验证 --port 超出 1-65535 范围时抛 Error
  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --project svc --env prod --image img --port 0 --replicas 3 --iac terraform --strategy rolling"
      ),
    /--port 取值非法/,
    "--port 0（小于 1）应抛取值非法错误"
  );

  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --project svc --env prod --image img --port 65536 --replicas 3 --iac terraform --strategy rolling"
      ),
    /--port 取值非法/,
    "--port 65536（大于 65535）应抛取值非法错误"
  );

  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --project svc --env prod --image img --port 100000 --replicas 3 --iac terraform --strategy rolling"
      ),
    /--port 取值非法/,
    "--port 100000（远大于 65535）应抛取值非法错误"
  );

  // 验证边界值合法
  const r1 = extractDeployRequestFromPrompt(
    "/eag-deploy --project svc --env prod --image img --port 1 --replicas 3 --iac terraform --strategy rolling"
  );
  assert.equal(r1.port, 1, "边界值 port=1 应合法");

  const r2 = extractDeployRequestFromPrompt(
    "/eag-deploy --project svc --env prod --image img --port 65535 --replicas 3 --iac terraform --strategy rolling"
  );
  assert.equal(r2.port, 65535, "边界值 port=65535 应合法");
});

test("L49. extractDeployRequestFromPrompt --replicas 非正整数抛错（K3f）", () => {
  // 验证 --replicas 非正整数时抛 Error
  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --project svc --env prod --image img --port 8080 --replicas 3.5 --iac terraform --strategy rolling"
      ),
    /--replicas 取值非法/,
    "--replicas 3.5（小数）应抛取值非法错误"
  );

  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --project svc --env prod --image img --port 8080 --replicas abc --iac terraform --strategy rolling"
      ),
    /--replicas 取值非法/,
    "--replicas abc（非数字）应抛取值非法错误"
  );

  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --project svc --env prod --image img --port 8080 --replicas -5 --iac terraform --strategy rolling"
      ),
    /--replicas 取值非法/,
    "--replicas -5（负数）应抛取值非法错误"
  );
});

test("L50. extractDeployRequestFromPrompt --replicas 超范围抛错（K3g）", () => {
  // 验证 --replicas 超出 1-100 范围时抛 Error
  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --project svc --env prod --image img --port 8080 --replicas 0 --iac terraform --strategy rolling"
      ),
    /--replicas 取值非法/,
    "--replicas 0（小于 1）应抛取值非法错误"
  );

  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --project svc --env prod --image img --port 8080 --replicas 101 --iac terraform --strategy rolling"
      ),
    /--replicas 取值非法/,
    "--replicas 101（大于 100）应抛取值非法错误"
  );

  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --project svc --env prod --image img --port 8080 --replicas 1000 --iac terraform --strategy rolling"
      ),
    /--replicas 取值非法/,
    "--replicas 1000（远大于 100）应抛取值非法错误"
  );

  // 验证边界值合法
  const r1 = extractDeployRequestFromPrompt(
    "/eag-deploy --project svc --env prod --image img --port 8080 --replicas 1 --iac terraform --strategy rolling"
  );
  assert.equal(r1.replicas, 1, "边界值 replicas=1 应合法");

  const r2 = extractDeployRequestFromPrompt(
    "/eag-deploy --project svc --env prod --image img --port 8080 --replicas 100 --iac terraform --strategy rolling"
  );
  assert.equal(r2.replicas, 100, "边界值 replicas=100 应合法");
});

test("L51. extractDeployRequestFromPrompt --iac 取值非法抛错（K3h）", () => {
  // 验证 --iac 取值不在 terraform | k8s-manifest | helm-chart 时抛 Error
  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --project svc --env prod --image img --port 8080 --replicas 3 --iac pulumi --strategy rolling"
      ),
    /--iac 取值非法/,
    "--iac pulumi 应抛取值非法错误"
  );

  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --project svc --env prod --image img --port 8080 --replicas 3 --iac k8s_yaml --strategy rolling"
      ),
    /--iac 取值非法/,
    "--iac k8s_yaml 应抛取值非法错误"
  );

  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --project svc --env prod --image img --port 8080 --replicas 3 --iac Terraform --strategy rolling"
      ),
    /--iac 取值非法/,
    "--iac Terraform（大写）应抛取值非法错误（大小写敏感）"
  );

  // 验证合法取值不抛错
  for (const iac of ["terraform", "k8s-manifest", "helm-chart"] as const) {
    const request = extractDeployRequestFromPrompt(
      `/eag-deploy --project svc --env prod --image img --port 8080 --replicas 3 --iac ${iac} --strategy rolling`
    );
    assert.equal(request.iacType, iac);
  }
});

test("L52. extractDeployRequestFromPrompt --strategy 取值非法抛错（K3i）", () => {
  // 验证 --strategy 取值不在 rolling | blue-green | canary 时抛 Error
  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --project svc --env prod --image img --port 8080 --replicas 3 --iac terraform --strategy recreate"
      ),
    /--strategy 取值非法/,
    "--strategy recreate 应抛取值非法错误"
  );

  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --project svc --env prod --image img --port 8080 --replicas 3 --iac terraform --strategy rolling-update"
      ),
    /--strategy 取值非法/,
    "--strategy rolling-update 应抛取值非法错误"
  );

  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --project svc --env prod --image img --port 8080 --replicas 3 --iac terraform --strategy Canary"
      ),
    /--strategy 取值非法/,
    "--strategy Canary（大写）应抛取值非法错误（大小写敏感）"
  );

  // 验证合法取值不抛错
  for (const strategy of ["rolling", "blue-green", "canary"] as const) {
    const request = extractDeployRequestFromPrompt(
      `/eag-deploy --project svc --env prod --image img --port 8080 --replicas 3 --iac terraform --strategy ${strategy}`
    );
    assert.equal(request.strategy, strategy);
  }
});

test("L53. extractDeployRequestFromPrompt --dry-run flag 解析（K3j）", () => {
  // 验证 --dry-run flag（无值）解析为 dryRun=true
  const promptWithDryRun =
    "/eag-deploy --project svc --env prod --image img --port 8080 --replicas 3 --iac terraform --strategy rolling --dry-run";
  const request1 = extractDeployRequestFromPrompt(promptWithDryRun);
  assert.equal(request1.dryRun, true, "--dry-run flag 存在时 dryRun 应为 true");

  // 验证未提供 --dry-run 时 dryRun 为 undefined
  const promptWithoutDryRun =
    "/eag-deploy --project svc --env prod --image img --port 8080 --replicas 3 --iac terraform --strategy rolling";
  const request2 = extractDeployRequestFromPrompt(promptWithoutDryRun);
  assert.equal(request2.dryRun, undefined, "未提供 --dry-run 时 dryRun 应为 undefined");

  // 验证 --dry-run 出现在参数中间位置也能正确解析
  const promptDryRunMiddle =
    "/eag-deploy --project svc --dry-run --env prod --image img --port 8080 --replicas 3 --iac terraform --strategy rolling";
  const request3 = extractDeployRequestFromPrompt(promptDryRunMiddle);
  assert.equal(request3.dryRun, true, "--dry-run 在中间位置时也应被正确解析");
  // 其他字段仍应正确解析
  assert.equal(request3.projectName, "svc");
  assert.equal(request3.environment, "prod");
});

test("L54. extractDeployRequestFromPrompt 引号包裹的值解析（K3k）", () => {
  // 验证双引号包裹的值被正确解析（去除引号）
  const promptDouble =
    '/eag-deploy --project "order-service" --env prod --image "registry.example.com/order-service:v1.2.3" --port 8080 --replicas 3 --iac terraform --strategy rolling';
  const request1 = extractDeployRequestFromPrompt(promptDouble);
  assert.equal(request1.projectName, "order-service", "双引号包裹的 projectName 应去除引号");
  assert.equal(request1.image, "registry.example.com/order-service:v1.2.3", "双引号包裹的 image 应去除引号");

  // 验证单引号包裹的值被正确解析（去除引号）
  const promptSingle =
    "/eag-deploy --project 'order-service' --env prod --image 'registry.example.com/order-service:v1.2.3' --port 8080 --replicas 3 --iac terraform --strategy rolling";
  const request2 = extractDeployRequestFromPrompt(promptSingle);
  assert.equal(request2.projectName, "order-service", "单引号包裹的 projectName 应去除引号");
  assert.equal(request2.image, "registry.example.com/order-service:v1.2.3", "单引号包裹的 image 应去除引号");

  // 验证带空格的引号值被正确解析（保留空格）
  const promptWithSpace =
    '/eag-deploy --project "my order service" --env prod --image "registry.example.com/order service:v1" --port 8080 --replicas 3 --iac terraform --strategy rolling';
  const request3 = extractDeployRequestFromPrompt(promptWithSpace);
  assert.equal(request3.projectName, "my order service", "双引号内含空格的 projectName 应保留空格");
  assert.equal(request3.image, "registry.example.com/order service:v1", "双引号内含空格的 image 应保留空格");
});

test("L55. extractDeployRequestFromPrompt 重复参数首次匹配生效（K3l）", () => {
  // 验证重复参数首次匹配生效（后续重复参数被忽略）
  // 第一次 --project=svc1，第二次 --project=svc2，应使用 svc1
  const prompt =
    "/eag-deploy --project svc1 --env prod --image img --port 8080 --replicas 3 --iac terraform --strategy rolling --project svc2";
  const request = extractDeployRequestFromPrompt(prompt);
  assert.equal(request.projectName, "svc1", "重复参数首次匹配生效，应使用 svc1");

  // 验证 --env 重复时首次匹配生效
  const promptEnv =
    "/eag-deploy --project svc --env dev --image img --port 8080 --replicas 3 --iac terraform --strategy rolling --env prod";
  const requestEnv = extractDeployRequestFromPrompt(promptEnv);
  assert.equal(requestEnv.environment, "dev", "重复 --env 首次匹配生效，应使用 dev");

  // 验证 --port 重复时首次匹配生效
  const promptPort =
    "/eag-deploy --project svc --env prod --image img --port 8080 --replicas 3 --iac terraform --strategy rolling --port 9090";
  const requestPort = extractDeployRequestFromPrompt(promptPort);
  assert.equal(requestPort.port, 8080, "重复 --port 首次匹配生效，应使用 8080");
});

test("L56. extractDeployRequestFromPrompt 大小写不敏感命令前缀（K3m）", () => {
  // 验证命令前缀 /eag-deploy 大小写不敏感
  // 注：仅命令前缀大小写不敏感，参数值（如 --env prod）仍大小写敏感

  // 全小写（标准形式）
  const prompt1 =
    "/eag-deploy --project svc --env prod --image img --port 8080 --replicas 3 --iac terraform --strategy rolling";
  const request1 = extractDeployRequestFromPrompt(prompt1);
  assert.equal(request1.projectName, "svc", "全小写命令前缀应正常解析");

  // 全大写
  const prompt2 =
    "/EAG-DEPLOY --project svc --env prod --image img --port 8080 --replicas 3 --iac terraform --strategy rolling";
  const request2 = extractDeployRequestFromPrompt(prompt2);
  assert.equal(request2.projectName, "svc", "全大写命令前缀应正常解析");

  // 混合大小写 1
  const prompt3 =
    "/Eag-Deploy --project svc --env prod --image img --port 8080 --replicas 3 --iac terraform --strategy rolling";
  const request3 = extractDeployRequestFromPrompt(prompt3);
  assert.equal(request3.projectName, "svc", "混合大小写命令前缀（Eag-Deploy）应正常解析");

  // 混合大小写 2
  const prompt4 =
    "/eAg-DePlOy --project svc --env prod --image img --port 8080 --replicas 3 --iac terraform --strategy rolling";
  const request4 = extractDeployRequestFromPrompt(prompt4);
  assert.equal(request4.projectName, "svc", "混合大小写命令前缀（eAg-DePlOy）应正常解析");

  // 命令前缀带前后空格
  const prompt5 =
    "  /eag-deploy  --project svc --env prod --image img --port 8080 --replicas 3 --iac terraform --strategy rolling  ";
  const request5 = extractDeployRequestFromPrompt(prompt5);
  assert.equal(request5.projectName, "svc", "带前后空格的命令前缀应正常解析");
});

test("L57. extractDeployRequestFromPrompt 返回对象已冻结（K3n）", () => {
  // 验证返回的 DeployRequest 对象被 Object.freeze 冻结（§5.12.4 G-A6d）
  const prompt =
    "/eag-deploy --project svc --env prod --image img --port 8080 --replicas 3 --iac terraform --strategy rolling --dry-run";
  const request = extractDeployRequestFromPrompt(prompt);

  // 验证对象已被冻结
  assert.ok(Object.isFrozen(request), "extractDeployRequestFromPrompt 返回的对象应被 Object.freeze 冻结");

  // 验证修改冻结对象的字段应抛 TypeError（strict 模式下）
  assert.throws(
    () => {
      (request as any).projectName = "changed";
    },
    TypeError,
    "修改冻结对象的 projectName 字段应抛 TypeError"
  );

  assert.throws(
    () => {
      (request as any).port = 9090;
    },
    TypeError,
    "修改冻结对象的 port 字段应抛 TypeError"
  );

  assert.throws(
    () => {
      (request as any).dryRun = false;
    },
    TypeError,
    "修改冻结对象的 dryRun 字段应抛 TypeError"
  );

  // 验证新增字段应抛 TypeError
  assert.throws(
    () => {
      (request as any).newField = "value";
    },
    TypeError,
    "新增冻结对象属性应抛 TypeError"
  );

  // 验证原值未变
  assert.equal(request.projectName, "svc", "冻结后原 projectName 应保持不变");
  assert.equal(request.port, 8080, "冻结后原 port 应保持不变");
  assert.equal(request.dryRun, true, "冻结后原 dryRun 应保持不变");
});

test("L58. 向后兼容验证：既有 6 个命令零回归（P-10 规则）", () => {
  // 验证：新增 /eag-deploy 命令后，既有 6 个命令（/eag-build /eag-design /eag-test /eag-run /eag-resume /eag-status）
  // 的解析行为完全不变（P-10 100% 向后兼容规则）
  const parser = new EagCommandParser();

  // 1. 既有 6 个命令的 parse() 分发仍正确
  assert.equal(parser.parse({ text: "/eag-build" }).kind, "eag-build");
  assert.equal(parser.parse({ text: "/eag-design" }).kind, "eag-design");
  assert.equal(parser.parse({ text: "/eag-test" }).kind, "eag-test");
  assert.equal(parser.parse({ text: "/eag-run" }).kind, "eag-run");
  assert.equal(parser.parse({ text: "/eag-resume" }).kind, "eag-resume");
  assert.equal(parser.parse({ text: "/eag-status" }).kind, "eag-status");

  // 2. 既有 6 个命令的 parseEagXxxCommand() 判定方法仍正确
  assert.equal(parser.parseEagBuildCommand({ text: "/eag-build" }).kind, "eag-build");
  assert.equal(parser.parseEagDesignCommand({ text: "/eag-design" }).kind, "eag-design");
  assert.equal(parser.parseEagTestCommand({ text: "/eag-test" }).kind, "eag-test");
  assert.equal(parser.parseEagRunCommand({ text: "/eag-run" }).kind, "eag-run");
  assert.equal(parser.parseEagResumeCommand({ text: "/eag-resume" }).kind, "eag-resume");
  assert.equal(parser.parseEagStatusCommand({ text: "/eag-status" }).kind, "eag-status");

  // 3. 既有 6 个命令的 payload 提取仍正确（字段完整时返回对象）
  const parsedBuild = parser.parse({
    text: "/eag-build",
    messageParams: { codingLoopRequest: createMinimalCodingLoopRequest() },
  });
  assert.ok(parsedBuild.payload, "/eag-build payload 提取仍正确");
  assert.equal((parsedBuild.payload as CodingLoopRequest).projectRoot, "/test/project");

  const parsedDesign = parser.parse({
    text: "/eag-design",
    messageParams: { designLoopInput: createMinimalDesignLoopInput() },
  });
  assert.ok(parsedDesign.payload, "/eag-design payload 提取仍正确");
  assert.equal((parsedDesign.payload as DesignLoopInput).rawRequirement, createMinimalDesignLoopInput().rawRequirement);

  const parsedTest = parser.parse({
    text: "/eag-test",
    messageParams: { testingLoopRequest: createMinimalTestingLoopRequest() },
  });
  assert.ok(parsedTest.payload, "/eag-test payload 提取仍正确");
  assert.equal((parsedTest.payload as TestingLoopRequest).projectRoot, "/test/project");

  const parsedRun = parser.parse({
    text: "/eag-run",
    messageParams: { eagRunRequest: createMinimalEagRunRequest() },
  });
  assert.ok(parsedRun.payload, "/eag-run payload 提取仍正确");
  assert.equal((parsedRun.payload as EagRunRequest).projectRoot, "/test/project");

  const parsedResume = parser.parse({
    text: "/eag-resume",
    messageParams: { eagResumeRequest: createMinimalEagResumeRequest() },
  });
  assert.ok(parsedResume.payload, "/eag-resume payload 提取仍正确");
  assert.equal((parsedResume.payload as EagResumeRequest).runId, "abc123def456");

  const parsedStatus = parser.parse({
    text: "/eag-status",
    messageParams: { eagStatusRequest: createMinimalEagStatusRequest() },
  });
  assert.ok(parsedStatus.payload, "/eag-status payload 提取仍正确");
  assert.equal((parsedStatus.payload as EagStatusRequest).projectRoot, "/test/project");

  // 4. 既有 6 个命令的 payload 缺失时仍返回 null
  assert.equal(parser.parse({ text: "/eag-build" }).payload, null);
  assert.equal(parser.parse({ text: "/eag-design" }).payload, null);
  assert.equal(parser.parse({ text: "/eag-test" }).payload, null);
  assert.equal(parser.parse({ text: "/eag-run" }).payload, null);
  assert.equal(parser.parse({ text: "/eag-resume" }).payload, null);
  assert.equal(parser.parse({ text: "/eag-status" }).payload, null);

  // 5. 既有 6 个命令返回的对象仍被 Object.freeze 冻结
  assert.ok(Object.isFrozen(parser.parse({ text: "/eag-build" })), "/eag-build 返回对象仍被冻结");
  assert.ok(Object.isFrozen(parser.parse({ text: "/eag-design" })), "/eag-design 返回对象仍被冻结");
  assert.ok(Object.isFrozen(parser.parse({ text: "/eag-test" })), "/eag-test 返回对象仍被冻结");
  assert.ok(Object.isFrozen(parser.parse({ text: "/eag-run" })), "/eag-run 返回对象仍被冻结");
  assert.ok(Object.isFrozen(parser.parse({ text: "/eag-resume" })), "/eag-resume 返回对象仍被冻结");
  assert.ok(Object.isFrozen(parser.parse({ text: "/eag-status" })), "/eag-status 返回对象仍被冻结");

  // 6. unknown 兜底分支仍正确
  assert.equal(parser.parse({ text: "普通对话文本" }).kind, "unknown");
  assert.equal(parser.parse({ text: "/continue" }).kind, "unknown");
  assert.equal(parser.parse({ text: undefined }).kind, "unknown");

  // 7. 图片附件 / 技能匹配仍使既有 6 个命令返回 unknown
  const imageUrls = ["data:image/png;base64,iVBORw0KGgo="];
  assert.equal(parser.parse({ text: "/eag-build", imageUrls }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-design", imageUrls }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-test", imageUrls }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-run", imageUrls }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-resume", imageUrls }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-status", imageUrls }).kind, "unknown");

  const skills = [{ name: "test-skill", path: "/", description: "测试技能" }];
  assert.equal(parser.parse({ text: "/eag-build", skills }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-design", skills }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-test", skills }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-run", skills }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-resume", skills }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-status", skills }).kind, "unknown");

  // 8. EagCommandParser 类仍无状态（无实例字段）
  const instanceKeys = Object.keys(parser);
  assert.equal(instanceKeys.length, 0, "EagCommandParser 实例仍应无字段（无状态）");
});
