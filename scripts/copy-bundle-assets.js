import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const cliRoot = join(root, "packages", "cli");
const distDir = join(cliRoot, "dist");

// 1. Copy core/templates/ → dist/templates/
//    Core's getExtensionRoot() resolves to dist/ in the bundle (because
//    __dirname is dist/chunks/ and ".." goes up to dist/).  The runtime code
//    loads templates from extensionRoot + "/templates/...", so they must
//    exist at dist/templates/.
const templatesSrc = join(root, "packages", "core", "templates");
const templatesDest = join(distDir, "templates");

if (!existsSync(distDir)) {
  mkdirSync(distDir, { recursive: true });
}

if (!existsSync(templatesSrc)) {
  console.error(`Templates directory not found at ${templatesSrc}`);
  process.exit(1);
}

rmSync(templatesDest, { recursive: true, force: true });
cpSync(templatesSrc, templatesDest, {
  recursive: true,
  dereference: true,
});
console.log("\n✅  Copied core/templates/ → dist/templates/");

// 2. Copy bundled skills to dist/bundled/ (legacy path used by getBundledSkillsRoot fallback)
const bundledSkillsSrc = join(templatesSrc, "skills", "bundled");
const bundledSkillsDest = join(distDir, "bundled");

if (existsSync(bundledSkillsSrc)) {
  rmSync(bundledSkillsDest, { recursive: true, force: true });
  cpSync(bundledSkillsSrc, bundledSkillsDest, {
    recursive: true,
    dereference: true,
  });
  console.log("✅  Copied bundled skills → dist/bundled/");
}

console.log("\n✅  All bundle assets copied.\n");
