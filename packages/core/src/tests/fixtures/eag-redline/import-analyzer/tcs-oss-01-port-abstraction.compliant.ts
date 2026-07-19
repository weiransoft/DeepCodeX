/**
 * Fixture: TCS-OSS-01 业务代码通过 Port 抽象接口（合规样例）
 *
 * @fixtureId import-analyzer/tcs-oss-01-port-abstraction.compliant
 * @checker ImportAnalyzer
 * @redlineIds TCS-OSS-01
 * @kind compliant
 * @expectVerdict passed
 * @description 业务代码 UploadService.ts 仅 import ObjectStoragePort 抽象接口——符合 TCS-OSS-01 红线
 */

// 该 export 的 artifacts 数组即 StaticChecker.check() 的入参
export const artifacts: ReadonlyArray<{ readonly path: string; readonly content: string }> = Object.freeze([
  {
    path: "src/services/UploadService.ts",
    content: `// src/services/UploadService.ts
// 合规点：业务代码仅 import ObjectStoragePort 抽象接口
import type { ObjectStoragePort } from "../ports/ObjectStoragePort";

/**
 * 文件上传服务
 */
export class UploadService {
  private objectStorage: ObjectStoragePort;

  constructor(objectStorage: ObjectStoragePort) {
    this.objectStorage = objectStorage;
  }

  /**
   * 上传文件
   */
  async uploadFile(key: string, body: Buffer): Promise<void> {
    await this.objectStorage.put(key, body);
  }

  /**
   * 获取文件下载链接
   */
  async getDownloadUrl(key: string, expirySeconds: number): Promise<string> {
    return this.objectStorage.signedUrl(key, { expirySeconds });
  }
}
`,
  },
]);
