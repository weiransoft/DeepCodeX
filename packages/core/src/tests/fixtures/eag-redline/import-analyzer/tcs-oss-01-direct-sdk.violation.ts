/**
 * Fixture: TCS-OSS-01 业务代码直连对象存储厂商 SDK（违规样例）
 *
 * @fixtureId import-analyzer/tcs-oss-01-direct-sdk.violation
 * @checker ImportAnalyzer
 * @redlineIds TCS-OSS-01
 * @kind violation
 * @expectVerdict violated
 * @description 业务代码 UploadService.ts 直接 import @aws-sdk/client-s3 厂商 SDK——违反 TCS-OSS-01 红线
 */

// 该 export 的 artifacts 数组即 StaticChecker.check() 的入参
export const artifacts: ReadonlyArray<{ readonly path: string; readonly content: string }> = Object.freeze([
  {
    path: "src/services/UploadService.ts",
    content: `// src/services/UploadService.ts
// 违规点：业务代码直接 import 对象存储厂商 SDK
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

/**
 * 文件上传服务
 */
export class UploadService {
  private s3Client: S3Client;

  constructor() {
    this.s3Client = new S3Client({ region: "us-east-1" });
  }

  /**
   * 上传文件到 S3
   */
  async uploadFile(bucket: string, key: string, body: Buffer): Promise<void> {
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
    });
    await this.s3Client.send(command);
  }
}
`,
  },
]);
