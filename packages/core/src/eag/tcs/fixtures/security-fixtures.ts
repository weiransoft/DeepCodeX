/**
 * TCS 安全扫描红线 fixtures（TCS-SEC-01 / TCS-SEC-02）
 *
 * 每条红线 1 个违规样例 + 1 个合规样例（共 4 个 fixture），
 * 用于测试评估器对安全扫描红线的判定准确性。
 *
 * 设计依据：
 * - EAG 方案 §5.8.5 漏洞扫描与修复闭环
 * - eag/tcs/vulnerability-scanner.ts（VulnerabilityScanner + VulnerabilityScanPort + ScannerAdapter）
 * - eag/tcs/tcs-redlines.ts（TCS-SEC-01/02 红线定义）
 *
 * @module eag/tcs/fixtures/security-fixtures
 */

// 引入 deepFreeze 用于递归冻结 fixture 及其嵌套的 expectedViolations 数组。
// Object.freeze 是浅冻结，无法冻结嵌套的 expectedViolations 数组本身——
// F12 测试断言 Object.isFrozen(f.expectedViolations) 必须为 true，
// 因此改用 deepFreeze（types.ts 中已实现）递归冻结所有层级。
import { deepFreeze, type RedlineFixture } from "../types";

// ============================================================================
// TCS-SEC-01：高危依赖漏洞未修复即放行
// ============================================================================

/**
 * TCS-SEC-01 违规样例：package.json 含高危漏洞依赖且未升级
 *
 * 场景：项目 package.json 依赖 lodash@4.17.20（已知 CVE-2021-23337，CVSS 7.2 高危漏洞），
 * 未升级到修复版本 4.17.21。CI 流水线未阻塞发布，带高危漏洞发布生产。
 */
export const SEC_01_VIOLATION: RedlineFixture = deepFreeze({
  redlineId: "TCS-SEC-01",
  kind: "violation",
  description:
    "项目 package.json 依赖 lodash@4.17.20（已知 CVE-2021-23337，CVSS 7.2 高危漏洞，命令注入），" +
    "未升级到修复版本 4.17.21。CI 流水线未调用 vulnerabilityScanner.scan() 阻塞发布，" +
    "带高危漏洞发布生产，攻击者可利用漏洞执行任意命令。",
  code: [
    "{",
    '  "name": "hongene-platform",',
    '  "version": "1.2.0",',
    '  "dependencies": {',
    '    "lodash": "4.17.20",',
    '    "express": "4.17.1",',
    '    "axios": "0.21.1"',
    "  },",
    '  "scripts": {',
    '    "build": "tsc",',
    '    "test": "node --import tsx --test",',
    '    "ci": "npm run build && npm test"',
    "  }",
    "}",
    "",
    "// npm audit 输出：",
    "// # Run  npm install lodash@4.17.21  to resolve 1 vulnerability",
    "// ┌───────────────┬──────────────────────────────────────────────────────────────┐",
    "// │ high          │ Command Injection in lodash                                  │",
    "// ├───────────────┼──────────────────────────────────────────────────────────────┤",
    "// │ Package       │ lodash                                                       │",
    "│ ├───────────────┼──────────────────────────────────────────────────────────────┤",
    "// │ Vulnerable    │ <4.17.21                                                     │",
    "// │ versions      │                                                              │",
    "// ├───────────────┼──────────────────────────────────────────────────────────────┤",
    "// │ Patched       │ >=4.17.21                                                    │",
    "// │ versions      │                                                              │",
    "// ├───────────────┼──────────────────────────────────────────────────────────────┤",
    "// │ CVE           │ CVE-2021-23337                                               │",
    "// │ CVSS          │ 7.2 (HIGH)                                                   │",
    "// └───────────────┴──────────────────────────────────────────────────────────────┘",
  ].join("\n"),
  language: "typescript",
  expectedViolations: [
    {
      filePath: "package.json",
      line: 5,
      description:
        "依赖 lodash@4.17.20 含高危漏洞 CVE-2021-23337（CVSS 7.2，命令注入）未升级到修复版本 4.17.21，违反 TCS-SEC-01 红线",
    },
  ],
  expectedVerdict: "violated",
});

/**
 * TCS-SEC-01 合规样例：依赖已升级到修复版本
 *
 * 场景：项目 package.json 依赖 lodash@4.17.21（修复版本），CI 流水线调用
 * vulnerabilityScanner.scan() 验证无高危漏洞，verdict=pass 放行发布。
 */
export const SEC_01_COMPLIANT: RedlineFixture = deepFreeze({
  redlineId: "TCS-SEC-01",
  kind: "compliant",
  description:
    "项目 package.json 依赖 lodash@4.17.21（CVE-2021-23337 修复版本），" +
    "CI 流水线通过 vulnerabilityScanner.scan() 验证无高危漏洞（highRiskCount=0），" +
    "verdict=pass 放行发布，符合 §5.8.5 规范。",
  code: [
    "{",
    '  "name": "hongene-platform",',
    '  "version": "1.2.1",',
    '  "dependencies": {',
    '    "lodash": "4.17.21",',
    '    "express": "4.17.21",',
    '    "axios": "0.21.4"',
    "  },",
    '  "scripts": {',
    '    "build": "tsc",',
    '    "test": "node --import tsx --test",',
    '    "security:scan": "node -e \\"import(\'./dist/security-scan.js\')\\"",',
    '    "ci": "npm run build && npm test && npm run security:scan"',
    "  }",
    "}",
    "",
    "// vulnerabilityScanner.scan() 输出：",
    "// {",
    "//   verdict: 'pass',",
    "//   highRiskCount: 0,",
    "//   hasHardcodedSecret: false,",
    "//   reports: [",
    "//     {",
    "//       layer: 'dependency',",
    "//       findings: [],  // 无漏洞",
    "//       scannerVersion: 'npm-audit-10.2.3',",
    "//       durationMs: 1200",
    "//     }",
    "//   ]",
    "// }",
  ].join("\n"),
  language: "typescript",
  expectedViolations: [],
  expectedVerdict: "passed",
});

// ============================================================================
// TCS-SEC-02：扫描出硬编码密钥
// ============================================================================

/**
 * TCS-SEC-02 违规样例：代码中硬编码 AWS Access Key
 *
 * 场景：业务代码（aws-client.ts）硬编码 AWS_ACCESS_KEY_ID 与 AWS_SECRET_ACCESS_KEY，
 * 即使后续删除也会留在 git 历史中。攻击者获取代码后即可获取密钥访问企业云资源。
 */
export const SEC_02_VIOLATION: RedlineFixture = deepFreeze({
  redlineId: "TCS-SEC-02",
  kind: "violation",
  description:
    "业务代码（aws-client.ts）硬编码 AWS_ACCESS_KEY_ID 与 AWS_SECRET_ACCESS_KEY，" +
    "违反 §5.8.5 规范。即使后续删除也会留在 git 历史中，攻击者获取代码后即可获取密钥" +
    "访问企业云资源（S3 / RDS / Lambda 等），导致数据泄漏/篡改/勒索。",
  code: [
    "// src/services/aws-client.ts",
    "import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';",
    "",
    "/**",
    " * 上传文件到 S3（违规：硬编码 AWS 密钥）",
    " */",
    "export async function uploadToS3(bucket: string, key: string, body: Buffer): Promise<void> {",
    "  // 违规：硬编码 AWS_ACCESS_KEY_ID",
    "  const accessKeyId = 'AKIAIOSFODNN7EXAMPLE';",
    "  // 违规：硬编码 AWS_SECRET_ACCESS_KEY",
    "  const secretAccessKey = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';",
    "",
    "  const client = new S3Client({",
    "    region: 'us-east-1',",
    "    credentials: { accessKeyId, secretAccessKey },",
    "  });",
    "",
    "  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));",
    "}",
  ].join("\n"),
  language: "typescript",
  expectedViolations: [
    {
      filePath: "src/services/aws-client.ts",
      line: 10,
      description:
        "硬编码 AWS_ACCESS_KEY_ID='AKIAIOSFODNN7EXAMPLE'——违反 TCS-SEC-02 红线，应从 process.env.AWS_ACCESS_KEY_ID 读取",
    },
    {
      filePath: "src/services/aws-client.ts",
      line: 12,
      description:
        "硬编码 AWS_SECRET_ACCESS_KEY='wJalrXUtnFEMI/...'——违反 TCS-SEC-02 红线，应从 process.env.AWS_SECRET_ACCESS_KEY 读取",
    },
  ],
  expectedVerdict: "violated",
});

/**
 * TCS-SEC-02 合规样例：密钥从环境变量注入
 *
 * 场景：业务代码从 process.env 读取 AWS_ACCESS_KEY_ID 与 AWS_SECRET_ACCESS_KEY，
 * 密钥存储在 .env 文件（不入 git）或 Secret Manager，应用启动时注入到进程环境变量。
 */
export const SEC_02_COMPLIANT: RedlineFixture = deepFreeze({
  redlineId: "TCS-SEC-02",
  kind: "compliant",
  description:
    "业务代码（aws-client.ts）从 process.env 读取 AWS_ACCESS_KEY_ID 与 AWS_SECRET_ACCESS_KEY，" +
    "密钥存储在 .env 文件（不入 git，加入 .gitignore）或 Secret Manager，应用启动时注入到进程环境变量，" +
    "符合 §5.8.5 规范。",
  code: [
    "// src/services/aws-client.ts",
    "import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';",
    "",
    "/**",
    " * 上传文件到 S3（合规：密钥从环境变量注入）",
    " */",
    "export async function uploadToS3(bucket: string, key: string, body: Buffer): Promise<void> {",
    "  // 合规：从 process.env 读取密钥",
    "  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;",
    "  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;",
    "  if (!accessKeyId || !secretAccessKey) {",
    "    throw new Error('AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY 环境变量未设置');",
    "  }",
    "",
    "  const client = new S3Client({",
    "    region: process.env.AWS_REGION ?? 'us-east-1',",
    "    credentials: { accessKeyId, secretAccessKey },",
    "  });",
    "",
    "  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));",
    "}",
    "",
    "// .env 文件（不入 git，加入 .gitignore）",
    "// .env 示例使用占位符而非真实密钥值，对齐安全最佳实践",
    "// AWS_ACCESS_KEY_ID=<YOUR_AWS_ACCESS_KEY_ID>",
    "// AWS_SECRET_ACCESS_KEY=<YOUR_AWS_SECRET_ACCESS_KEY>",
    "// AWS_REGION=us-east-1",
    "",
    "// .gitignore",
    "// .env",
    "// .env.*",
  ].join("\n"),
  language: "typescript",
  expectedViolations: [],
  expectedVerdict: "passed",
});

// ============================================================================
// 安全 fixtures 聚合导出
// ============================================================================

/**
 * 安全扫描全部 fixtures（4 个，TCS-SEC-01/02 各 2 个）
 */
export const SECURITY_FIXTURES: ReadonlyArray<RedlineFixture> = Object.freeze([
  SEC_01_VIOLATION,
  SEC_01_COMPLIANT,
  SEC_02_VIOLATION,
  SEC_02_COMPLIANT,
]);
