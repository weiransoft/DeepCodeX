# build/ —— sidecar 拉取与打包脚本（M5 占位）

M1 不含打包脚本（Karpathy 四原则：不写投机代码）。本目录在 M5 承载：

- **Node SEA 构建**：把 DeepCodeX-cli 引擎打包为单文件可执行（externalBin），
  按 target 三件套发布（darwin-arm64 / darwin-x64 / win32-x64）+ sha256 校验；
  M1 阶段引擎以 **system 模式**运行（`node <cli.js> web`，入口经
  `DEEPCODE_CLI_PATH` / `DEEPCODE_HOME` 环境变量或开发默认仓库路径解析）。
- **签名与公证**：macOS Developer ID + notarytool（app + dmg + sidecar 同签）；
  Windows Authenticode（NSIS）。
- **更新通道**：updater endpoint JSON + minisign 验签产物流水线。
