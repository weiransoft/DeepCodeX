// Test runner for @vegamo/deepcode-cli
import { globSync } from "glob";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import * as path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testFiles = globSync("*.test.ts", { cwd: __dirname });

const result = spawnSync(
  process.execPath,
  // 透传 CLI 参数（如 --experimental-test-coverage --test-reporter=lcov），
  // 对齐 core runner 模式（S1-D2，供 CI Coverage 步骤使用）
  // --test-concurrency=1：上游 0.3.1 引入，避免并发资源竞争导致的不稳定失败
  ["--import", "tsx", "--test", "--test-concurrency=1", ...process.argv.slice(2), ...testFiles],
  {
    stdio: "inherit",
    cwd: __dirname,
  }
);

process.exit(result.status ?? 1);
