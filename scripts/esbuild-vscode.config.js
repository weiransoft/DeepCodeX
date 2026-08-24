import { build } from "esbuild";
import { familySync } from "detect-libc";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const vscodeRoot = join(root, "packages", "vscode-ide-companion");
const entry = join(vscodeRoot, "src", "extension.ts");
const outDir = join(vscodeRoot, "out");
const outfile = join(outDir, "extension.js");

await build({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  outfile,
  external: ["vscode", "sharp"],
  sourcemap: true,
  footer: {
    js: "module.exports = { activate, deactivate };",
  },
  logOverride: {
    "empty-import-meta": "silent",
  },
});

const resolveFromExtension = createRequire(join(vscodeRoot, "package.json"));
const runtimeModules = ["sharp", "detect-libc", "semver", "@img/colour"];
const runtimeSources = new Map();
const nativePlatform = process.platform === "linux" && familySync() === "musl" ? "linuxmusl" : process.platform;
const nativeModules = [
  `@img/sharp-${nativePlatform}-${process.arch}`,
  `@img/sharp-libvips-${nativePlatform}-${process.arch}`,
];
for (const moduleName of nativeModules) {
  const source = [join(vscodeRoot, "node_modules", moduleName), join(root, "node_modules", moduleName)].find(
    (candidate) => existsSync(join(candidate, "package.json"))
  );
  if (source) {
    runtimeModules.push(moduleName);
    runtimeSources.set(moduleName, source);
  }
}
if (!runtimeSources.has(nativeModules[0])) {
  throw new Error(`Sharp runtime is not installed for ${nativePlatform}-${process.arch}.`);
}
const runtimeRoot = join(outDir, "node_modules");
rmSync(runtimeRoot, { recursive: true, force: true });
for (const moduleName of runtimeModules) {
  const source = runtimeSources.get(moduleName) ?? dirname(resolveFromExtension.resolve(`${moduleName}/package.json`));
  const destination = join(runtimeRoot, moduleName);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true, dereference: true });
}

console.log(`\n✅  ${outfile} and Sharp runtime built successfully\n\n`);
