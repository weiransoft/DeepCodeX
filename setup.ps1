# ============================================================================
# setup.ps1 —— DeepCodeX 一键安装入口（Windows / PowerShell 5.1+）
# ============================================================================
#
# 与仓库根目录 setup.sh 对应，Windows 原生版本（不依赖 WSL / Git Bash）：
#   1. 环境预检（Node.js >= 18、npm、git；缺失时可自动安装 Node LTS）
#   2. Git clone 仓库（默认浅克隆 --depth=1）
#   3. 调 scripts\install.ps1 完成依赖 + 构建 + 冒烟
#
# 两种安装模式（-Mode）：
#   source （默认）完整源码克隆 + npm install + build
#   npm     GitHub Release tarball → npm install -g（最快，仅 CLI）
#
# 典型用法（PowerShell）：
#   irm https://raw.githubusercontent.com/weiransoft/DeepCodeX/main/setup.ps1 -OutFile setup.ps1
#   powershell -ExecutionPolicy Bypass -File .\setup.ps1
#   .\setup.ps1 -Mode npm -Tag v0.4.3.14
#
# 环境变量覆盖：GIT_REPO  DEFAULT_BRANCH  INSTALL_DIR  NPM_REGISTRY  GH_PROXY
#
# 编码说明：本文件必须以 UTF-8 with BOM 保存（PowerShell 5.1 无 BOM 时按 ANSI 解析）。
# ============================================================================

[CmdletBinding()]
param(
    [ValidateSet('source', 'npm')][string]$Mode = 'source',
    [string]$Tag,
    [string]$Dir,
    [string]$Branch,
    [switch]$Deep,
    [switch]$Force,
    [switch]$NoUpdate,
    [switch]$SkipBuild,
    [switch]$SkipSmoke,
    [switch]$InstallNode,
    [switch]$NoInstallNode,
    [string]$NodeVersion = 'v22.14.0'
)

$ErrorActionPreference = 'Stop'

# ----------------------------------------------------------------------------
# 常量与默认值（全部可被参数 / 同名环境变量覆盖）
# ----------------------------------------------------------------------------

if (-not $env:GIT_REPO) { $env:GIT_REPO = 'https://github.com/weiransoft/DeepCodeX.git' }
$GitRepo = $env:GIT_REPO

if (-not $Branch) {
    if ($env:DEFAULT_BRANCH) { $Branch = $env:DEFAULT_BRANCH } else { $Branch = 'main' }
}
if (-not $Dir) {
    if ($env:INSTALL_DIR) { $Dir = $env:INSTALL_DIR } else { $Dir = Join-Path $env:USERPROFILE 'DeepCodeX' }
}
if (-not $env:NPM_REGISTRY) { $env:NPM_REGISTRY = 'https://registry.npmmirror.com' }

$NODE_MIN_MAJOR = 18
# GitHub Release 资产名固定为 deepcode-cli.tgz（每次 release 覆盖上传）
$RELEASE_ASSET = 'deepcode-cli.tgz'

# 退出码语义（与 setup.sh / scripts/install.ps1 对齐）
$EXIT_SUCCESS = 0
$EXIT_PREFLIGHT_FAILED = 1
$EXIT_INSTALL_FAILED = 2

# ghproxy 国内镜像前缀（空格分隔，直连放最后兜底）
if (-not $env:GH_PROXY) { $env:GH_PROXY = 'https://gh-proxy.com/ https://ghproxy.net/ https://ghfast.top/' }

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
    Write-Host "[OK] $Message" -ForegroundColor Green
}

# ----------------------------------------------------------------------------
# 帮助
# ----------------------------------------------------------------------------

function Show-Usage {
    @'
setup.ps1 -- DeepCodeX 一键安装入口（Windows）

用法: .\setup.ps1 [选项]

选项:
  -Mode <source|npm>   安装模式（默认 source）
                       source = git clone + npm install + build
                       npm    = GitHub Release tarball -> npm install -g
  -Tag <vX.Y.Z>        npm 模式指定 Release tag（默认 latest）
  -Dir <path>          安装目录（默认 %USERPROFILE%\DeepCodeX）
  -Branch <name>       git 检出分支/tag（默认 main）
  -Deep                完整克隆（默认浅克隆 --depth=1）
  -Force               覆盖重装：npm 模式先卸载再装；source 模式删目录重 clone
  -NoUpdate            目录已存在时不 git pull
  -SkipBuild           跳过构建阶段
  -SkipSmoke           跳过冒烟验证
  -InstallNode         Node.js 缺失时自动安装（winget）
  -NoInstallNode       Node.js 缺失时退出并提示手动安装
  -NodeVersion <ver>   指定安装的 Node LTS 版本（默认 v22.14.0）

示例:
  powershell -ExecutionPolicy Bypass -File .\setup.ps1
  .\setup.ps1 -Mode npm -Tag v0.4.3.14
'@ | Write-Host
}

# ----------------------------------------------------------------------------
# Node.js 检查与自动安装
# ----------------------------------------------------------------------------

function Get-NodeMajor {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return -1 }
    $version = (& node --version 2>$null)
    if (-not $version) { return -1 }
    return [int]($version.TrimStart('v').Split('.')[0])
}

function Install-NodeLts {
    Write-Info "==== 自动安装 Node.js LTS（winget） ===="
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Write-Err "未找到 winget，无法自动安装 Node.js"
        Write-Err "  手动安装：https://nodejs.org/ 或 https://npmmirror.com/mirrors/node/"
        return $EXIT_INSTALL_FAILED
    }

    # 优先按 -NodeVersion 精确安装（winget 的版本号不带前导 v）；找不到该版本时回退最新 LTS
    $pinnedVersion = $NodeVersion.TrimStart('v')
    Write-Info "尝试安装指定版本 $pinnedVersion ..."
    & winget install --id OpenJS.NodeJS.LTS --version $pinnedVersion --silent --accept-package-agreements --accept-source-agreements | Out-Host
    if ($LASTEXITCODE -ne 0) {
        Write-Warn "指定版本 $pinnedVersion 安装失败，回退到最新 LTS ..."
        & winget install --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements | Out-Host
        if ($LASTEXITCODE -ne 0) {
            Write-Err "winget 安装 Node.js 失败（exit=$LASTEXITCODE）"
            return $EXIT_INSTALL_FAILED
        }
    }

    # winget 安装后当前进程的 PATH 可能还没刷新，从注册表重读机器级/用户级 PATH
    $machinePath = [System.Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath = [System.Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machinePath;$userPath"

    if ((Get-NodeMajor) -lt $NODE_MIN_MAJOR) {
        Write-Err "Node.js 安装后仍不可用或版本仍低于 $NODE_MIN_MAJOR；请重开一个 PowerShell 窗口后重试"
        return $EXIT_INSTALL_FAILED
    }

    Write-Ok "Node.js 已就绪：$(& node --version)"
    return $EXIT_SUCCESS
}

# ----------------------------------------------------------------------------
# 环境预检
# ----------------------------------------------------------------------------

function Invoke-Preflight {
    Write-Info "==== 环境预检 ===="
    Write-Info "系统：Windows $([System.Environment]::OSVersion.Version)"

    $major = Get-NodeMajor
    if ($major -lt 0) {
        Write-Warn "未检测到 Node.js（需要 >= $NODE_MIN_MAJOR）"
        if ($NoInstallNode) {
            Write-Err "已指定 -NoInstallNode，请手动安装 Node.js >= $NODE_MIN_MAJOR 后重跑"
            return $EXIT_PREFLIGHT_FAILED
        }

        $shouldInstall = $false
        if ($InstallNode) {
            $shouldInstall = $true
        } else {
            try {
                $answer = Read-Host "是否现在自动安装 Node.js LTS？（Y/n）"
                if ($answer -eq '' -or $answer -match '^[Yy]') { $shouldInstall = $true }
            } catch {
                # 非交互式上下文（CI / 计划任务）Read-Host 会失败，直接按"装"处理
                Write-Info "非交互式环境，自动安装 Node.js"
                $shouldInstall = $true
            }
        }
        if (-not $shouldInstall) {
            Write-Err "请手动安装 Node.js >= $NODE_MIN_MAJOR 后重跑，或加 -InstallNode"
            return $EXIT_PREFLIGHT_FAILED
        }

        $code = Install-NodeLts
        if ($code -ne $EXIT_SUCCESS) { return $code }
    } elseif ($major -lt $NODE_MIN_MAJOR) {
        Write-Err "Node.js 版本过低（$(& node --version)），需要 >= $NODE_MIN_MAJOR"
        Write-Err "  升级：winget upgrade --id OpenJS.NodeJS.LTS"
        return $EXIT_PREFLIGHT_FAILED
    } else {
        Write-Ok "Node.js: $(& node --version)"
    }

    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        Write-Err "未找到 npm（通常随 Node.js 一起安装）"
        return $EXIT_PREFLIGHT_FAILED
    }
    Write-Ok "npm: $(& npm --version)"

    if ($Mode -eq 'source' -and -not (Get-Command git -ErrorAction SilentlyContinue)) {
        Write-Err "源码模式需要 git：winget install Git.Git"
        return $EXIT_PREFLIGHT_FAILED
    }

    return $EXIT_SUCCESS
}

# ----------------------------------------------------------------------------
# 模式 1：npm global install（GitHub Release tarball）
# ----------------------------------------------------------------------------

function Install-ViaNpm {
    Write-Info "==== mode: release tarball（GitHub Release → 本地 npm install -g）===="

    if ($Tag) {
        $releaseUrl = "https://github.com/weiransoft/DeepCodeX/releases/download/$Tag/$RELEASE_ASSET"
        Write-Info "指定版本：$Tag"
    } else {
        $releaseUrl = "https://github.com/weiransoft/DeepCodeX/releases/latest/download/$RELEASE_ASSET"
        Write-Info "拉取最新 Release（或用 -Tag 指定版本）"
    }

    $tgzPath = Join-Path $env:TEMP ("deepcode-cli-" + [guid]::NewGuid().ToString('N') + ".tgz")

    # 依次尝试 ghproxy 前缀 + 直连兜底
    $sources = @()
    foreach ($prefix in ($env:GH_PROXY -split '\s+')) {
        if (-not $prefix) { continue }
        if ($prefix.EndsWith('/')) { $sources += "$prefix$releaseUrl" } else { $sources += "$prefix/$releaseUrl" }
    }
    $sources += $releaseUrl

    $downloaded = $false
    foreach ($src in $sources) {
        Write-Info "下载：$src"
        try {
            # 老版本 PowerShell 默认走 IE 引擎解析，-UseBasicParsing 关闭它
            Invoke-WebRequest -Uri $src -OutFile $tgzPath -UseBasicParsing -TimeoutSec 600
        } catch {
            Write-Warn "下载失败：$($_.Exception.Message)"
            Remove-Item -LiteralPath $tgzPath -Force -ErrorAction SilentlyContinue
            continue
        }

        # 校验确实是 gzip（1F 8B），避免把 404 HTML 页当 tarball 装进去
        $bytes = [System.IO.File]::ReadAllBytes($tgzPath)
        if ($bytes.Length -ge 2 -and $bytes[0] -eq 0x1F -and $bytes[1] -eq 0x8B) {
            $downloaded = $true
            break
        }
        Write-Warn "下载内容不是有效 tarball（可能 Release 不存在或返回了错误页）"
        Remove-Item -LiteralPath $tgzPath -Force -ErrorAction SilentlyContinue
    }

    if (-not $downloaded) {
        Write-Err "所有下载源均失败：$releaseUrl"
        Write-Err "  可用 -Tag 指定已存在的版本，或设置 GH_PROXY 指向可用代理"
        return $EXIT_INSTALL_FAILED
    }
    Write-Ok "下载完成（$([math]::Round((Get-Item $tgzPath).Length / 1MB, 1)) MB）"

    try {
        if ($Force) {
            Write-Info "-Force：先卸载旧版本 ..."
            & npm uninstall -g @vegamo/deepcode-cli 2>$null | Out-Host
            Write-Warn "卸载完成（若原本未安装，此处退出码非 0 属正常）"
        }

        Write-Info "npm install -g $tgzPath ..."
        & npm install -g $tgzPath | Out-Host
        if ($LASTEXITCODE -ne 0) {
            Write-Err "npm install -g 失败（exit=$LASTEXITCODE）"
            Write-Err "  权限问题可用：npm config set prefix $env:APPDATA\npm"
            return $EXIT_INSTALL_FAILED
        }
    } finally {
        Remove-Item -LiteralPath $tgzPath -Force -ErrorAction SilentlyContinue
    }

    $npmPrefix = (& npm config get prefix 2>$null)
    Write-Ok "npm install 完成（prefix=$npmPrefix）"

    $cli = Get-Command deepcode -ErrorAction SilentlyContinue
    if (-not $cli) {
        Write-Warn "deepcode 未在当前 PATH 中；新开终端生效，或手动加入 PATH："
        Write-Warn "  $npmPrefix"
        return $EXIT_SUCCESS
    }
    $version = (& deepcode --version 2>&1 | Select-Object -First 1)
    Write-Ok "deepcode: $($cli.Source)"
    Write-Ok "  version: $version"
    return $EXIT_SUCCESS
}

# ----------------------------------------------------------------------------
# 模式 2：git clone + scripts\install.ps1
# ----------------------------------------------------------------------------

function Install-FromSource {
    Write-Info "==== mode: source ===="
    Write-Info "  repo    : $GitRepo"
    Write-Info "  branch  : $Branch"
    Write-Info "  dir     : $Dir"

    $gitDir = Join-Path $Dir '.git'

    if (Test-Path $gitDir) {
        if ($Force) {
            Write-Warn "-Force：删除已存在目录 $Dir 后重新克隆"
            Remove-Item -LiteralPath $Dir -Recurse -Force
        } elseif ($NoUpdate) {
            Write-Warn "-NoUpdate：跳过 git pull，直接使用现有工作区"
        } else {
            Write-Info "目录已存在，尝试更新 ..."
            Push-Location $Dir
            try {
                & git fetch --depth=1 origin $Branch | Out-Host
                if ($LASTEXITCODE -eq 0) {
                    & git checkout -q $Branch | Out-Host
                    & git pull --ff-only origin $Branch | Out-Host
                }
                if ($LASTEXITCODE -ne 0) {
                    Write-Warn "git 更新失败，保留现有工作区继续"
                } else {
                    Write-Ok "仓库已更新"
                }
            } finally {
                Pop-Location
            }
        }
    }

    if (-not (Test-Path $gitDir)) {
        Write-Info "克隆到 $Dir ..."
        $cloneArgs = @('clone')
        if (-not $Deep) { $cloneArgs += '--depth'; $cloneArgs += '1' }
        $cloneArgs += @('--branch', $Branch, '--single-branch', $GitRepo, $Dir)

        & git @cloneArgs | Out-Host
        if ($LASTEXITCODE -ne 0) {
            Write-Err "git clone 失败"
            Write-Err "  repo : $GitRepo"
            Write-Err "  hint : 检查网络/代理，或用 `$env:GIT_REPO 指向镜像"
            return $EXIT_INSTALL_FAILED
        }
        Write-Ok "仓库克隆完成"
    }

    $installScript = Join-Path $Dir 'scripts\install.ps1'
    if (-not (Test-Path $installScript)) {
        Write-Err "未找到 $installScript（仓库结构可能已变化）"
        return $EXIT_INSTALL_FAILED
    }

    Write-Info "执行 scripts\install.ps1 ..."
    $installArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $installScript)
    if ($SkipBuild) { $installArgs += '-SkipBuild' }
    if ($SkipSmoke) { $installArgs += '-SkipSmoke' }
    if ($env:NPM_REGISTRY) { $installArgs += @('-NpmRegistry', $env:NPM_REGISTRY) }

    Push-Location $Dir
    try {
        & powershell @installArgs | Out-Host
        if ($LASTEXITCODE -ne 0) {
            Write-Err "scripts\install.ps1 失败（exit=$LASTEXITCODE）"
            return $EXIT_INSTALL_FAILED
        }
    } finally {
        Pop-Location
    }

    Write-Ok "DeepCodeX 源码安装完成！"
    Write-Info "下一步："
    Write-Info "  cd $Dir"
    Write-Info "  node scripts\start.js    # CLI"
    return $EXIT_SUCCESS
}

# ----------------------------------------------------------------------------
# 主流程
# ----------------------------------------------------------------------------

Write-Info "==== DeepCodeX setup.ps1 ===="

$code = Invoke-Preflight
if ($code -eq $EXIT_PREFLIGHT_FAILED) {
    # 打印帮助，避免用户只看到一条错误无从下手
    Show-Usage
}

if ($code -eq $EXIT_SUCCESS) {
    if ($Mode -eq 'npm') {
        $code = Install-ViaNpm
    } else {
        $code = Install-FromSource
    }
}

if ($code -ne $EXIT_SUCCESS) {
    Write-Err "安装失败，退出码：$code"
}
exit $code
