/**
 * Fixture: E6 硬编码密钥（违规样例）
 *
 * @fixtureId hardcode-secret-scanner/e6-hardcoded-aws-key.violation
 * @checker HardcodeSecretScanner
 * @redlineIds E6
 * @kind violation
 * @expectVerdict violated
 * @description 代码字符串字面量含 AWS Access Key 与 GitHub Token 等真实格式密钥——违反 E6 密钥与配置红线
 */

// 该 export 的 artifacts 数组即 StaticChecker.check() 的入参
export const artifacts: ReadonlyArray<{ readonly path: string; readonly content: string }> = Object.freeze([
  {
    path: "src/config/aws.config.ts",
    content: `// src/config/aws.config.ts
/**
 * AWS 配置文件——违规点：硬编码密钥
 */
export class AwsConfig {
  // 违规点：硬编码 AWS Access Key ID
  static readonly AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";

  // 违规点：硬编码 AWS Secret Access Key
  static readonly AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

  // 违规点：硬编码 GitHub Token
  static readonly GITHUB_TOKEN = "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

  // 违规点：硬编码 API Key（已替换为无害占位符，避免 GitHub Secret Scanning 误报）
  static readonly API_KEY = "sk_live_REDACTED_PLACEHOLDER";
}
`,
  },
]);
