import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import prettierConfig from "eslint-config-prettier";

export default tseslint.config(
  // Base recommended rules from ESLint
  js.configs.recommended,
  // TypeScript recommended rules
  ...tseslint.configs.recommended,
  // Custom project rules
  {
    rules: {
      // CLI project allows console
      "no-console": "off",
      // Allow dynamic require for package.json (cli.tsx)
      "@typescript-eslint/no-var-requires": "off",
      "@typescript-eslint/no-require-imports": "off",
      // Allow control regex for ANSI stripping (markdown.test.ts)
      "no-control-regex": "off",
      // Enforce consistent type imports
      "@typescript-eslint/consistent-type-imports": "warn",
      // Unused vars: allow _-prefixed parameters
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
    },
  },
  // React hooks rules
  {
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  // V2 模块边界（V2.3 P1-05 修复）：V2 → V1 依赖必须经由唯一入口
  // packages/core/src/v2/integration/v1-adapters.ts。
  // 禁止 V2 业务模块直接 import V1 目录（team/ common/ tools/ session 等），
  // 依赖面集中在 v1-adapters 一处，可审计、可门禁。
  // 豁免：v1-adapters.ts 自身（它是对外 re-export 的唯一入口）与 v2/tests
  //（测试可直接构造 V1 被测对象，如 ToolExecutor 集成测试）。
  {
    files: ["packages/core/src/v2/**/*.ts"],
    ignores: ["packages/core/src/v2/integration/v1-adapters.ts", "packages/core/src/v2/tests/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              // 多角色审查 ARCH-07 修复：补 "../../eag/*"——
              // dual-layer-manager 曾直接 import ../../eag/rlis/* 绕过单一入口门禁
              group: [
                "../../team/*",
                "../../common/*",
                "../../tools/*",
                "../../session*",
                "../../settings*",
                "../../eag/*",
              ],
              message:
                "V2 模块禁止直接 import V1 文件（V2.3 P1-05 单一入口约束）。请从 ../../integration/v1-adapters 导入 V1 能力；若依赖缺失，请在 v1-adapters.ts 中补充 re-export。",
            },
          ],
        },
      ],
    },
  },
  // Test files: relaxed rules
  {
    files: ["packages/*/src/tests/**/*.ts", "packages/*/src/tests/**/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  // Script files: Node.js environment
  // 覆盖范围：
  //   - 根目录 scripts/ 下的 JS/MJS 脚本
  //   - 各 package 下的 scripts/ JS 脚本
  //   - v2/tests/scripts/ 下的 MJS 性能基准/基线脚本（如 cm-12-large-bench.mjs、perf-baseline.mjs）
  //     这些脚本是独立运行的 Node.js 程序，使用 process/console 全局变量
  //   - 根目录 tests/*.mjs 测试入口 runner（S1-D2：tests/run-tests.mjs）
  //   - 各 package 根层 *.mjs 测试汇总 runner（如 packages/core/run-all-tests.mjs，
  //     位于包根而非 src/tests/，S1 测试基建统一新增）
  {
    files: [
      "./scripts/**/*.js",
      "./scripts/**/*.mjs",
      "packages/*/scripts/**/*.js",
      "packages/*/scripts/**/*.mjs",
      "packages/*/src/v2/tests/scripts/**/*.mjs",
      "./tests/*.mjs",
      "packages/*/*.mjs",
    ],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
      },
    },
  },
  // Statusline plugins: Node.js environment
  {
    files: [".deepcode/plugins/**/*.mjs", ".deepcode/plugins/**/*.js"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
      },
    },
  },
  // Browser resources: VSCode webview scripts
  {
    files: ["packages/*/resources/**/*.js"],
    languageOptions: {
      globals: {
        window: "readonly",
        document: "readonly",
        console: "readonly",
        FileReader: "readonly",
        Blob: "readonly",
        URL: "readonly",
        fetch: "readonly",
      },
    },
  },
  // Skill 模板资源：bundled skill 中的浏览器运行时脚本
  // 覆盖范围：packages/*/templates/skills/bundled/*/assets/**/*.js
  // 这些文件是 skill 模板自带的浏览器侧运行时（如 html-deck/assets/runtime.js），
  // 使用 window/document/setTimeout/location 等 browser globals，不属于 Node.js 源码
  {
    files: ["packages/*/templates/skills/bundled/*/assets/**/*.js"],
    languageOptions: {
      globals: {
        window: "readonly",
        document: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        requestAnimationFrame: "readonly",
        localStorage: "readonly",
        history: "readonly",
        location: "readonly",
      },
    },
  },
  // Prettier config: disable conflicting ESLint rules, MUST be last
  prettierConfig
);
