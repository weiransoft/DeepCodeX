# ============================================================================
# install.ps1 —— DeepCodeX 全自动安装脚本（Windows / PowerShell 5.1+）
# ============================================================================
#
# 与 scripts/install.sh 一一对应，覆盖同样的六个阶段：
#   1. 环境预检（Node.js >= 18、npm、git；缺 MSVC 构建工具时提示）
#   2. 国内镜像源配置（npm registry / node-gyp 头文件 / prebuild 二进制）
#   3. npm install（工作区安装，含原生模块）
#   4. better-sqlite3 原生模块保障（预编译缺失时走本地重编译 + FTS5 验证）
#   5. 项目构建（npm run build）
#   6. 安装后冒烟验证（deepcode CLI 版本号输出）
#
# 退出码语义（与 install.sh / install-better-sqlite3.sh 对齐）：
#   0 = 安装与验证全部通过
#   1 = 环境预检失败（Node.js/npm 缺失或版本不符）
#   2 = 安装/构建/验证失败
#
# 使用方式（在 PowerShell 中执行）：
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1
#   .\scripts\install.ps1 -SkipBuild            # 跳过构建
#   .\scripts\install.ps1 -NpmRegistry https://registry.npmjs.org   # 官方源
#
# 编码说明：本文件必须以 UTF-8 with BOM 保存。PowerShell 5.1 读取无 BOM 的
# UTF-8 脚本时按系统 ANSI 代码页解析，中文注释与提示会乱码甚至解析失败。
# ============================================================================

[CmdletBinding()]
param(
    [string]$NpmRegistry = $env:NPM_REGISTRY,
    [string]$NodeMirror = $env:NODE_MIRROR,
    [string]$PrebuildMirror = $env:PREBUILD_MIRROR,
    [string]$BinaryHostPrefix = $env:BINARY_HOST_PREFIX,
    [switch]$SkipBuild,
    [switch]$SkipSmoke,
    # 仅修复 better-sqlite3（等价于 bash 侧的 npm run rebuild:sqlite）
    [switch]$SqliteOnly
)

$ErrorActionPreference = 'Stop'

# ----------------------------------------------------------------------------
# 全局变量与常量
# ----------------------------------------------------------------------------

$ScriptDir = $PSScriptRoot
if (-not $ScriptDir) {
    $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}
$ProjectRoot = Split-Path -Parent $ScriptDir

$EXIT_SUCCESS = 0
$EXIT_PREFLIGHT_FAILED = 1
$EXIT_INSTALL_FAILED = 2

# Node.js 最低版本（与 packages/cli、core engines 语义一致）
$NODE_MIN_MAJOR = 18

# 国内镜像源默认值（npmmirror = 阿里云；全部可被参数/环境变量覆盖）
if (-not $NpmRegistry) { $NpmRegistry = 'https://registry.npmmirror.com' }
if (-not $NodeMirror) { $NodeMirror = 'https://cdn.npmmirror.com/binaries/node' }
if (-not $PrebuildMirror) { $PrebuildMirror = 'https://npmmirror.com/mirrors' }
if (-not $BinaryHostPrefix) { $BinaryHostPrefix = 'https://cdn.npmmirror.com/binaries' }

# ----------------------------------------------------------------------------
# 日志辅助函数（与 install.sh 的输出风格保持一致）
# ----------------------------------------------------------------------------

function Write-Info {
    param([string]$Message)
    Write-Host "[INFO] $Message" -ForegroundColor Cyan
}

function Write-Warn {
    param([string]$Message)
    Write-Host "[WARN] $Message" -ForegroundColor Yellow
}

function Write-Err {
    param([string]$Message)
    Write-Host "[ERROR] $Message" -ForegroundColor Red
}

function Write-Ok {
    param([string]$Message)
    Write-Host "[SUCCESS] $Message" -ForegroundColor Green
}

# 以 UTF-8（无 BOM）写文本文件，避免 npm 读取带 BOM 的 .npmrc 时把键名污染成 "\uFEFFregistry"
function Write-TextFileNoBom {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Content
    )
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}

# ----------------------------------------------------------------------------
# 阶段 0：环境预检
# ----------------------------------------------------------------------------

function Test-PreflightNode {
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCmd) {
        Write-Err "未找到 Node.js 可执行文件，请先安装 Node.js >= $NODE_MIN_MAJOR"
        Write-Err "  推荐：winget install OpenJS.NodeJS.LTS"
        Write-Err "  或从 $NodeMirror 下载 msi 手动安装"
        return $EXIT_PREFLIGHT_FAILED
    }

    $nodeVersion = (& node --version 2>$null)
    if (-not $nodeVersion) {
        Write-Err "无法获取 Node.js 版本（node --version 无输出）"
        return $EXIT_PREFLIGHT_FAILED
    }

    $trimmed = $nodeVersion.TrimStart('v')
    $major = [int]($trimmed.Split('.')[0])
    if ($major -lt $NODE_MIN_MAJOR) {
        Write-Err "Node.js 版本 $nodeVersion 不满足要求（>= $NODE_MIN_MAJOR）"
        return $EXIT_PREFLIGHT_FAILED
    }

    Write-Info "Node.js 版本检查通过：$nodeVersion"
    return $EXIT_SUCCESS
}

function Test-PreflightNpm {
    $npmCmd = Get-Command npm -ErrorAction SilentlyContinue
    if (-not $npmCmd) {
        Write-Err "未找到 npm（通常随 Node.js 一起安装）；检查 PATH 中是否包含 Node.js 安装目录"
        return $EXIT_PREFLIGHT_FAILED
    }
    $npmVersion = (& npm --version 2>$null)
    Write-Info "npm 可用性检查通过：$npmVersion"
    return $EXIT_SUCCESS
}

function Test-PreflightGit {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        Write-Warn "未找到 git；版本信息生成（scripts/generate-git-commit-info.js）会降级，其余流程可继续"
    }
    return $EXIT_SUCCESS
}

# Windows 上原生模块源码编译依赖 Visual Studio Build Tools（MSVC）+ Python。
# 只提示不阻断：优先走 prebuild 预编译二进制，绝大多数机器不需要本地编译。
function Test-PreflightBuildTools {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    $hasVs = $false
    if (Test-Path $vswhere) {
        $installPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
        if ($installPath) { $hasVs = $true }
    }

    if (-not $hasVs) {
        Write-Warn "未检测到 MSVC C++ 构建工具；若预编译二进制不可用，原生模块本地编译会失败"
        Write-Warn "  安装：winget install Microsoft.VisualStudio.2022.BuildTools"
        Write-Warn "  勾选「使用 C++ 的桌面开发」工作负载，并安装 Python 3"
    } else {
        Write-Info "MSVC 构建工具检查通过"
    }

    if (-not (Get-Command python -ErrorAction SilentlyContinue) -and -not (Get-Command python3 -ErrorAction SilentlyContinue)) {
        Write-Warn "未找到 Python；node-gyp 源码编译回退会失败（仅影响本地编译路径）"
    }
    return $EXIT_SUCCESS
}

# ----------------------------------------------------------------------------
# 阶段 1：国内镜像源配置
# ----------------------------------------------------------------------------

function Set-Mirrors {
    Write-Info "==== 阶段 1：配置国内镜像源 ===="
    Write-Info "  npm registry : $NpmRegistry"
    Write-Info "  node mirror  : $NodeMirror"
    Write-Info "  prebuild     : $PrebuildMirror"
    Write-Info "  binary proxy : $BinaryHostPrefix"

    # 项目级 .npmrc（不改用户全局配置，安装产物目录不入库）
    $npmrcPath = Join-Path $ProjectRoot '.npmrc'
    $npmrcContent = @"
registry=$NpmRegistry
disturl=$NodeMirror
better_sqlite3_binary_host_mirror=$PrebuildMirror/better-sqlite3
"@
    Write-TextFileNoBom -Path $npmrcPath -Content $npmrcContent

    # 环境变量供本次进程内的 npm / prebuild-install 使用
    $env:npm_config_registry = $NpmRegistry
    $env:npm_config_disturl = $NodeMirror
    $env:NPM_CONFIG_REGISTRY = $NpmRegistry
    $env:PREBUILD_INSTALL_GITHUB_HOST = $BinaryHostPrefix
    $env:npm_config_better_sqlite3_binary_host = "$BinaryHostPrefix/goodbetter/better-sqlite3"

    Write-Ok "镜像源配置完成"
    return $EXIT_SUCCESS
}

# ----------------------------------------------------------------------------
# 阶段 2：依赖安装
# ----------------------------------------------------------------------------

function Install-Dependencies {
    Write-Info "==== 阶段 2：安装依赖（npm install，registry=$NpmRegistry） ===="
    Push-Location $ProjectRoot
    try {
        & npm install --no-audit --no-fund | Out-Host
        if ($LASTEXITCODE -ne 0) {
            Write-Err "npm install 失败（exit=$LASTEXITCODE）"
            Write-Err "  可尝试：1) 检查网络/镜像可达性 2) 删除 node_modules 后重试"
            return $EXIT_INSTALL_FAILED
        }
    } finally {
        Pop-Location
    }
    Write-Ok "依赖安装完成"
    return $EXIT_SUCCESS
}

# 用真实加载验证 better-sqlite3：建内存库 → 建 FTS5 虚表 → 查回写入内容
# 写成临时 .mjs 文件而不是 `node -e`，避免 PowerShell 与 JS 双重引号转义
function Test-Sqlite3Loadable {
    $probePath = Join-Path $env:TEMP ("deepcode-sqlite3-verify-" + [guid]::NewGuid().ToString('N') + ".mjs")
    $probeContent = @'
import { createRequire } from "node:module";

const require = createRequire(process.cwd() + "/");

let Database;
try {
  Database = require("better-sqlite3");
} catch (err) {
  console.error("[ERROR] 加载 better-sqlite3 失败：" + err.message);
  process.exit(2);
}

let db;
try {
  db = new Database(":memory:");
  db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS fts5_verify USING fts5(content, tokenize=\"porter unicode61\");");
  db.prepare("INSERT INTO fts5_verify(content) VALUES (?)").run("hello world");
  const row = db.prepare("SELECT content FROM fts5_verify WHERE fts5_verify MATCH ?").get("hello");
  if (!row || row.content !== "hello world") {
    console.error("[ERROR] FTS5 查询结果不符合预期");
    process.exit(2);
  }
  console.log("[INFO] FTS5 可用性验证通过");
} catch (err) {
  console.error("[ERROR] better-sqlite3 加载或 FTS5 验证失败：" + err.message);
  process.exit(2);
} finally {
  if (db) { db.close(); }
}
console.log("[SUCCESS] better-sqlite3 加载验证通过");
'@
    Write-TextFileNoBom -Path $probePath -Content $probeContent

    Push-Location $ProjectRoot
    try {
        & node $probePath | Out-Host
        $exitCode = $LASTEXITCODE
    } finally {
        Pop-Location
        Remove-Item -LiteralPath $probePath -Force -ErrorAction SilentlyContinue
    }
    return $exitCode
}

# better-sqlite3 保障：先验证加载，失败则本地重编译，再验证一次
function Repair-BetterSqlite3 {
    Write-Info "==== 阶段 2.5：better-sqlite3 原生模块保障 ===="

    $sqlite3Dir = Join-Path $ProjectRoot 'node_modules\better-sqlite3'
    if (-not (Test-Path $sqlite3Dir)) {
        Write-Warn "node_modules 中未找到 better-sqlite3（npm install 可能跳过了 optionalDependencies）"
        Write-Info "尝试单独安装 better-sqlite3 ..."
        Push-Location $ProjectRoot
        try {
            & npm install better-sqlite3 --no-save --no-audit --no-fund | Out-Host
            if ($LASTEXITCODE -ne 0) {
                Write-Err "better-sqlite3 安装失败"
                return $EXIT_INSTALL_FAILED
            }
        } finally {
            Pop-Location
        }
    }

    $exitCode = Test-Sqlite3Loadable
    if ($exitCode -eq 0) {
        Write-Ok "better-sqlite3 已验证可加载（FTS5 可用）"
        return $EXIT_SUCCESS
    }

    Write-Warn "better-sqlite3 加载失败，尝试本地重编译（--build-from-source）..."
    Push-Location $ProjectRoot
    try {
        & npm rebuild better-sqlite3 --build-from-source | Out-Host
        if ($LASTEXITCODE -ne 0) {
            Write-Warn "npm rebuild 失败；若本机无 MSVC 构建工具这是预期结果"
        }
    } finally {
        Pop-Location
    }

    $exitCode = Test-Sqlite3Loadable
    if ($exitCode -ne 0) {
        Write-Err "better-sqlite3 仍不可用（exit=$exitCode）"
        Write-Err "  安装 Visual Studio Build Tools（含 C++ 桌面开发）+ Python 3 后重试："
        Write-Err "  npm rebuild better-sqlite3 --build-from-source"
        return $EXIT_INSTALL_FAILED
    }

    Write-Ok "better-sqlite3 重编译后验证通过"
    return $EXIT_SUCCESS
}

# sharp 不可用只降级图像能力，不阻断安装
function Test-Sharp {
    Write-Info "验证 sharp 原生模块可加载性 ..."
    Push-Location $ProjectRoot
    try {
        $probe = 'try { const s = (await import("sharp")).default; console.log("[INFO] sharp 加载通过（libvips " + (s.versions ? s.versions.vips : "unknown") + "）"); } catch (e) { console.error("[WARN] sharp 加载失败：" + e.message.split("\n")[0]); process.exit(1); }'
        & node --input-type=module -e $probe | Out-Host
        if ($LASTEXITCODE -eq 0) {
            Write-Ok "sharp 原生模块验证通过"
        } else {
            Write-Warn "sharp 不可用：图片多模态/预览图像能力将降级"
            Write-Warn "  修复：npm install @img/sharp-win32-x64 --no-save"
        }
    } finally {
        Pop-Location
    }
    return $EXIT_SUCCESS
}

# ----------------------------------------------------------------------------
# 阶段 3：构建
# ----------------------------------------------------------------------------

function Invoke-Build {
    Write-Info "==== 阶段 3：项目构建（npm run build） ===="
    Push-Location $ProjectRoot
    try {
        & npm run build | Out-Host
        if ($LASTEXITCODE -ne 0) {
            Write-Err "构建失败（npm run build），请检查上方编译日志"
            return $EXIT_INSTALL_FAILED
        }
    } finally {
        Pop-Location
    }
    Write-Ok "项目构建完成"
    return $EXIT_SUCCESS
}

# ----------------------------------------------------------------------------
# 阶段 4：冒烟验证
# ----------------------------------------------------------------------------

function Invoke-SmokeTest {
    Write-Info "==== 阶段 4：冒烟验证 ===="

    $cliEntry = Join-Path $ProjectRoot 'packages\cli\dist\cli.js'
    if (-not (Test-Path $cliEntry)) {
        Write-Warn "未找到 CLI 产物 $cliEntry（跳过冒烟，构建阶段可能已报警）"
        return $EXIT_SUCCESS
    }

    $output = (& node $cliEntry --version 2>&1 | Select-Object -First 1)
    if ($LASTEXITCODE -ne 0 -or -not $output) {
        Write-Err "CLI 冒烟失败：node packages\cli\dist\cli.js --version"
        Write-Err "  $output"
        return $EXIT_INSTALL_FAILED
    }
    Write-Ok "CLI 冒烟通过：$output"

    $webDist = Join-Path $ProjectRoot 'packages\web\web\dist'
    if ((Test-Path (Join-Path $webDist 'bundle.js')) -and (Test-Path (Join-Path $webDist 'index.html'))) {
        Write-Ok "Web 前端产物齐备：$webDist"
    } else {
        Write-Warn "Web 前端产物缺失（$webDist）；可手动重建：node packages/web/web/build.mjs"
    }
    return $EXIT_SUCCESS
}

# ----------------------------------------------------------------------------
# 主流程
# ----------------------------------------------------------------------------

function Invoke-Main {
    Write-Info "==== DeepCodeX 全自动安装脚本启动（Windows / PowerShell） ===="
    Write-Info "项目根目录：$ProjectRoot"

    Write-Info "==== 阶段 0：环境预检 ===="
    $code = Test-PreflightNode
    if ($code -ne $EXIT_SUCCESS) { return $code }
    $code = Test-PreflightNpm
    if ($code -ne $EXIT_SUCCESS) { return $code }
    Test-PreflightGit | Out-Null
    Test-PreflightBuildTools | Out-Null

    $code = Set-Mirrors
    if ($code -ne $EXIT_SUCCESS) { return $code }

    if ($SqliteOnly) {
        Write-Info "SqliteOnly 已指定：只做 better-sqlite3 保障，跳过依赖安装/构建/冒烟"
        return (Repair-BetterSqlite3)
    }

    $code = Install-Dependencies
    if ($code -ne $EXIT_SUCCESS) { return $code }
    $code = Repair-BetterSqlite3
    if ($code -ne $EXIT_SUCCESS) { return $code }
    Test-Sharp | Out-Null

    if ($SkipBuild) {
        Write-Info "SkipBuild 已指定，跳过构建阶段"
    } else {
        $code = Invoke-Build
        if ($code -ne $EXIT_SUCCESS) { return $code }
    }

    if ($SkipSmoke) {
        Write-Info "SkipSmoke 已指定，跳过冒烟验证阶段"
    } else {
        $code = Invoke-SmokeTest
        if ($code -ne $EXIT_SUCCESS) { return $code }
    }

    Write-Ok "==== DeepCodeX 全自动安装完成 ===="
    Write-Info "启动方式：node scripts\start.js（或 npm run build-and-start）"
    return $EXIT_SUCCESS
}

$exitCode = Invoke-Main
if ($exitCode -ne $EXIT_SUCCESS) {
    Write-Err "安装脚本执行失败，退出码：$exitCode"
}
exit $exitCode
