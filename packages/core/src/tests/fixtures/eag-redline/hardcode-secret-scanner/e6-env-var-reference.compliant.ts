/**
 * Fixture: E6 环境变量引用（合规样例）
 *
 * @fixtureId hardcode-secret-scanner/e6-env-var-reference.compliant
 * @checker HardcodeSecretScanner
 * @redlineIds E6
 * @kind compliant
 * @expectVerdict passed
 * @description 密钥通过 process.env 读取，无明文字面量——符合 E6 密钥与配置红线
 */

// 该 export 的 artifacts 数组即 StaticChecker.check() 的入参
export const artifacts: ReadonlyArray<{ readonly path: string; readonly content: string }> = Object.freeze([
  {
    path: "src/config/aws.config.ts",
    content: `// src/config/aws.config.ts
/**
 * AWS 配置文件——合规点：通过环境变量读取密钥
 */
export class AwsConfig {
  // 合规点：通过环境变量读取 AWS Access Key ID
  static readonly AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "";

  // 合规点：通过环境变量读取 AWS Secret Access Key
  static readonly AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "";

  // 合规点：通过环境变量读取 GitHub Token
  static readonly GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";

  // 合规点：通过环境变量读取 API Key
  static readonly API_KEY = process.env.API_KEY ?? "";
}
`,
  },
]);
