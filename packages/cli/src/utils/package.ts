import { readPackageUp, type PackageJson as BasePackageJson } from "read-package-up";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { CLI_VERSION } from "../generated/git-commit";

/**
 * 校验 version 是否可安全写入 PackageJson 类型（语义化版本 x.y.z 或 4 段 x.y.z.w）。
 *
 * normalize-package-data（read-package-up@12 内部）对 4 段版本号会抛异常，
 * try/catch 已兜底；此处再做一道形状过滤，确保透传/回退路径的 version
 * 始终满足 PackageJson 类型契约，非法形状一律回退编译期常量。
 */
const SEMVER_LIKE = /^\d+\.\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z-.]+)?$/;

function resolveFallbackVersion(): string {
  return CLI_VERSION && SEMVER_LIKE.test(CLI_VERSION) ? CLI_VERSION : "";
}

export type PackageJson = BasePackageJson;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let packageJson: PackageJson;

export async function getPackageJson(): Promise<PackageJson> {
  if (packageJson) {
    return packageJson;
  }

  // 版本解析容错（修复"4 段版本号导致 CLI 启动即死"2026-10-03）：
  // read-package-up@12 内部 normalize-package-data 对 version 做严格 semver 校验，
  // 本仓库自 0.4.3.2 起使用 4 段补丁版本号（如 0.4.3.3），解析时直接抛异常。
  // 本函数的既定契约是"读不到合法 package.json 时回退编译期常量 CLI_VERSION"——
  // 旧实现只覆盖 result 为 undefined 的分支，异常路径会把 --help 在内的所有
  // CLI 命令炸死在启动阶段。这里把读取整体纳入 try/catch，异常与未命中
  // 走同一回退路径；注意回退结果不写入 packageJson 缓存，
  // 保持"下次调用仍会重试真实 package.json"的原有语义。
  try {
    const result = await readPackageUp({ cwd: __dirname });
    if (!result) {
      return { name: "@vegamo/deepcode-cli", version: resolveFallbackVersion() };
    }

    packageJson = result.packageJson;
    return packageJson;
  } catch {
    // package.json 缺失、JSON 损坏或 version 不符合严格 semver：
    // 回退编译期注入的 CLI_VERSION，保证 CLI 任何命令都能正常启动
    return { name: "@vegamo/deepcode-cli", version: resolveFallbackVersion() };
  }
}
