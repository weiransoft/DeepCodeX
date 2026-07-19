/**
 * Fixture: TCS-SEC-01 修复版本依赖（合规样例）
 *
 * @fixtureId dependency-scanner/tcs-sec-01-fixed-version.compliant
 * @checker DependencyScanner
 * @redlineIds TCS-SEC-01
 * @kind compliant
 * @expectVerdict passed
 * @description package.json 含 lodash@^4.17.21（修复版本）——符合 TCS-SEC-01 高危依赖漏洞红线
 */

// 该 export 的 artifacts 数组即 StaticChecker.check() 的入参
export const artifacts: ReadonlyArray<{ readonly path: string; readonly content: string }> = Object.freeze([
  {
    path: "package.json",
    content: `{
  "name": "my-app",
  "version": "1.0.0",
  "description": "My Application",
  "main": "index.js",
  "scripts": {
    "test": "echo \\"Error: no test specified\\" && exit 1"
  },
  "dependencies": {
    "lodash": "^4.17.21",
    "express": "^4.17.3"
  },
  "devDependencies": {
    "typescript": "^4.5.4"
  }
}
`,
  },
]);
