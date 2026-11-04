import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import prettierConfig from "eslint-config-prettier";

// ============================================================================
// Super Agent 内核门禁常量
// ============================================================================

/** Super Agent 内核目录（零 I/O、零框架依赖、零反向依赖） */
const SA_KERNEL_DIRS = [
  "packages/core/src/super-agent/domain/**/*.ts",
  "packages/core/src/super-agent/engine/**/*.ts",
  "packages/core/src/super-agent/policy/**/*.ts",
  "packages/core/src/super-agent/effects/**/*.ts",
  "packages/core/src/super-agent/passes/**/*.ts",
  // Soul 层（2026-11-04）：四层人格与分类记忆，纯函数零 I/O
  "packages/core/src/super-agent/soul/**/*.ts",
];

/** Super Agent 持久层目录（唯一允许 `node:sqlite`——SQLite 事实来源） */
const SA_STORE_DIRS = ["packages/core/src/super-agent/store/**/*.ts"];

/** Super Agent 适配层目录（可接入既有资产，但仍受 I/O 门禁约束） */
const SA_ADAPTER_DIRS = [
  "packages/core/src/super-agent/router/**/*.ts",
  "packages/core/src/super-agent/worker/**/*.ts",
  // 计划层（2026-11-04）：需要调用既有 LLM 单次通道与角色注册表
  "packages/core/src/super-agent/planner/**/*.ts",
];

/** 内核禁止直接触碰的 I/O 与并发原语 */
const SA_IO_PATHS = [
  { name: "node:fs", message: "Super Agent 内核不得直接读写文件——请经 store/ 或 source/ 适配层。" },
  { name: "node:fs/promises", message: "Super Agent 内核不得直接读写文件——请经 store/ 或 source/ 适配层。" },
  { name: "node:child_process", message: "Super Agent 内核不得起子进程——执行交由 worker/ 适配层。" },
  { name: "node:http", message: "Super Agent 内核不得起网络服务。" },
  { name: "node:https", message: "Super Agent 内核不得起网络服务。" },
  { name: "node:net", message: "Super Agent 内核不得起网络服务。" },
  { name: "node:dgram", message: "Super Agent 内核不得起网络服务。" },
  { name: "node:worker_threads", message: "Super Agent 内核不得自行开线程池——并发由 passes/ 串行化。" },
];

/** `node:sqlite` 静态导入禁列（只有 store/ 例外） */
const SA_SQLITE_PATH = [
  {
    name: "node:sqlite",
    message: "Super Agent 内核不得直接碰 SQLite——只有 store/ 允许（领域状态只经 Store 读写）。",
  },
];

/** V2 双层上下文禁列（barrel 会把整棵依赖树拉进链接期） */
const SA_V2_PATTERN = [
  {
    group: ["../../v2/*"],
    allowTypeImports: true,
    message:
      "Super Agent 内核不得依赖 V2 双层上下文实现：其 barrel 会把整棵依赖树拉进链接期（间接引入 node:fs / node:child_process）。纯类型引用可用 `import type`。",
  },
];

/** 反向依赖 V1 目录禁列（仅内核层；router/ 与 worker/ 属适配层） */
const SA_V1_PATTERN = [
  {
    group: ["../../team/*", "../../common/*", "../../tools/*", "../../session*", "../../settings*"],
    allowTypeImports: true,
    message:
      "Super Agent 内核不得反向依赖 V1 目录（team/common/tools/session/settings）。请经 worker/ 或 router/ 适配层接入既有资产。",
  },
];

/** 动态 `import()` 门禁——`no-restricted-imports` 拦不住动态导入 */
const SA_DYNAMIC_IMPORT = [
  "error",
  {
    selector:
      "ImportExpression[source.value=/^(node:sqlite|node:fs|node:child_process|node:http|node:https|node:net|node:dgram|node:worker_threads)/]",
    message: "Super Agent 内核不得用动态 import() 绕过 I/O 门禁——请经 store/ 或 source/ 适配层。",
  },
];

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
                // 多角色审查补漏：execution-history 曾直接 import ../../prompt
                // （ToolDefinition），与 v1-adapters 审计命令对齐，纳入门禁
                "../../prompt*",
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
  // 2026-09-19：packages/web 新增后，测试目录除 packages/*/src/tests/** 外还有
  // packages/web/tests/**（Web 包测试独立于 src 布局），统一纳入放宽规则：
  // no-explicit-any 关闭（测试桩/受控实现需要）、unused-vars 关闭、Node globals。
  {
    files: [
      "packages/*/src/tests/**/*.ts",
      "packages/*/src/tests/**/*.mjs",
      "packages/*/tests/**/*.ts",
      "packages/*/tests/**/*.tsx",
      "packages/*/tests/**/*.mjs",
    ],
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
      // 2026-11-01：tests/scripts 下的独立 Node 程序（如 e2e-settings-drawer-ui.mjs
      // 直连 Chrome CDP），此前未纳入任何 globals 配置，被按无 Node 全局检查
      "./tests/scripts/**/*.mjs",
      "packages/*/*.mjs",
      // 2026-09-19：web 包独立 runner 与前端构建脚本（src 布局之外的 Node 程序）
      "packages/*/tests/*.mjs",
      "packages/*/web/*.mjs",
    ],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        // Node/Web 标准全局（CDP 脚本会用到定时器、Buffer 与 fetch）
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        URL: "readonly",
        fetch: "readonly",
      },
    },
  },
  // CommonJS 脚本：Node.js 环境 + CJS 全局
  // 2026-11-01：desktop/scripts/gen-icon.cjs 等 .cjs 脚本用 require / __dirname，
  // 此前无对应配置块，被按 ESM 检查而报 6 个 no-undef（pre-commit 直接拦住提交）。
  // 注意 sourceType 必须是 commonjs，否则 require 会被当成未声明标识符。
  {
    files: ["**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        require: "readonly",
        module: "readonly",
        exports: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
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
  // Super Agent 内核依赖门禁（docs/proposals/super-agent/proposal-final.md §4.3
  // / proposal-p3-context-v2.md §5 P3-6）
  //
  // 目的：把「内核层不得直接触碰 I/O 与并发原语」从约定变成**编译/静态可查的门禁**。
  //
  // 允许的：
  // - domain/  —— 零 I/O、零框架依赖（纯类型 + 纯谓词）
  // - store/   —— 唯一允许 `node:sqlite` 的地方（SQLite 事实来源）
  // - engine/  —— 领域规则，只经 Store 读写
  //
  // 禁止的（越界即报错）：
  // - node:fs / node:child_process / node:http(s) / node:net / node:dgram
  //   —— 内核不得自己开文件、起进程、起网络服务
  // - node:worker_threads —— 不得自行开线程池（并发由 Passes 串行化）
  // - node:sqlite —— 只 store/ 允许（P3-6 补齐：此前只靠约定）
  // - ../../team/*、../../common/*、../../tools/* 等 V1 目录
  //   —— 内核不得反向依赖既有编排体系（避免与 5 套并行编排再叠一层）
  // - ../../v2/* —— **P3-6 补齐**：V2 的 barrel 会把整棵依赖树拉进链接期，
  //   间接引入 node:fs / node:child_process；纯类型引用（编译期擦除）除外。
  //
  // 豁免：source/（事件源适配层，按设计要读文件系统）。
  // router/ 与 worker/ 属**适配层**——允许按需接入既有资产
  // （`router/assessment.ts` → team/orchestrator/llm-once；
  //  `worker/executor.ts` → team/role-registry），
  // 但仍受 I/O 门禁与 `../../v2/*` 门禁约束（P3-6 把这两个目录纳入）。
  //
  // ⚠️ flat config 里**同一个规则由最后一个匹配块决定**（不做规则拼接）——
  // 因此下面按「谁最后生效」精确分块。
  {
    // 内核 + 适配层：I/O 门禁 + node:sqlite 门禁 + V2 门禁 + 动态 import 门禁
    files: [...SA_KERNEL_DIRS, ...SA_ADAPTER_DIRS],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [...SA_IO_PATHS, ...SA_SQLITE_PATH],
          patterns: SA_V2_PATTERN,
        },
      ],
      "no-restricted-syntax": SA_DYNAMIC_IMPORT,
    },
  },
  {
    // store/ 例外：它是唯一允许 node:sqlite 的地方（SQLite 事实来源）
    files: SA_STORE_DIRS,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: SA_IO_PATHS,
          patterns: SA_V2_PATTERN,
        },
      ],
    },
  },
  {
    // 内核层追加「反向依赖 V1 目录」门禁（适配层按设计要接入既有资产，不受此限）
    files: SA_KERNEL_DIRS,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [...SA_IO_PATHS, ...SA_SQLITE_PATH],
          patterns: [...SA_V2_PATTERN, ...SA_V1_PATTERN],
        },
      ],
    },
  },
  {
    // store/ 同样受 V1 门禁约束（只放宽 node:sqlite 一项）
    files: SA_STORE_DIRS,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: SA_IO_PATHS,
          patterns: [...SA_V2_PATTERN, ...SA_V1_PATTERN],
        },
      ],
    },
  },
  // Prettier config: disable conflicting ESLint rules, MUST be last
  prettierConfig
);
