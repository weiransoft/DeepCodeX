/**
 * 环境模块声明：让 TypeScript 识别 CSS 副作用导入
 * （esbuild 构建时由 css loader 处理，类型检查时按任意模块放行）。
 */
declare module "*.css";
