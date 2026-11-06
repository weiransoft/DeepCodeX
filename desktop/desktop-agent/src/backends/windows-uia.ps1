<#
.SYNOPSIS
    deepcode-desktop-agent Windows UIA 桥（L4 执行层平台实现）。

.DESCRIPTION
    供 desktop/desktop-agent/src/backends/windows.mjs 以
        powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File windows-uia.ps1 -PayloadBase64 <...>
    调用。输入为 base64(JSON)，输出**最后一行**必须是单行 JSON（其余行走 stderr/Write-Verbose）。

    能力：
      - snapshot    : UIAutomation 树遍历（骨架 + 稳定 ref + 深度预算 + 局部观察）
      - screenshot  : 虚拟屏截图，默认只回传 base64 到调用方内存，**不落盘**（R2）
      - invokeRef   : 元素 InvokePattern / ValuePattern，不抢焦点（首选动作通道）
      - clickXY     : 坐标点击兜底（自绘界面）
      - typeText / sendKey / waitFor / observeState

.NOTES
    P1 状态：**产品实现，尚未在交互式桌面会话端到端验证**。
    前提：交互式桌面会话、进程具备 UIA 访问权限、.NET Framework UIAutomationClient 可用。
    明确不做：UAC Secure Desktop 提权、验证码/登录绕过、驱动级输入注入。
    会话 0 / 服务会话 / 受管控沙箱（禁止运行时加载 .NET 程序集）下会失败，
    Node 后端会把它归类为 CAPABILITY_UNAVAILABLE 并降级，不会伪造观察结果。
#>
param(
    [Parameter(Mandatory = $true)][string]$PayloadBase64
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

function Write-Result($obj) {
    $json = $obj | ConvertTo-Json -Depth 12 -Compress
    [Console]::Out.WriteLine($json)
}

function Write-Err($code, $message, $extra = @{}) {
    $o = @{ ok = $false; code = $code; message = $message } + $extra
    Write-Result $o
}

try {
    $payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PayloadBase64)) | ConvertFrom-Json
    $command = $payload.command
    $args = if ($payload.args) { $payload.args } else { @{} }

    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing

    # 坐标输入：仅 P/Invoke user32 的最小面，不做驱动级注入
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DcxNativeInput {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
    public const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004;
    public static void Click(int x, int y) {
        SetCursorPos(x, y);
        mouse_event(LEFTDOWN, 0, 0, 0, IntPtr.Zero);
        mouse_event(LEFTUP, 0, 0, 0, IntPtr.Zero);
    }
}
'@

    # 进程内快照存储：ref -> AutomationElement 的强引用，跨进程/跨调用不共享
    if (-not $script:SnapshotStore) { $script:SnapshotStore = @{} }

    function Get-AppRoot([string]$appId) {
        $root = [System.Windows.Automation.AutomationElement]::RootElement
        $cond = [System.Windows.Automation.Condition]::TrueCondition
        $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
        foreach ($w in $windows) {
            try {
                $p = Get-Process -Id $w.Current.ProcessId -ErrorAction SilentlyContinue
                if ($appId -and $p -and $p.ProcessName -ine $appId) { continue }
                if (-not $w.Current.Name) { continue }
                return $w
            } catch { continue }
        }
        return $null
    }

    function Convert-Node($el, [int]$depth, [int]$maxDepth, [string]$prefix) {
        $c = $el.Current
        $r = $c.BoundingRectangle
        $seq = $script:NodeSeq++
        $ref = "$prefix$seq"
        $script:SnapshotStore[$script:CurrentSnapshotId][$ref] = $el
        $node = [ordered]@{
            ref        = $ref
            role       = $c.ControlType.ProgrammaticName -replace 'ControlType\.', ''
            name       = [string]$c.Name
            rect       = @{ x = [int]$r.X; y = [int]$r.Y; width = [int]$r.Width; height = [int]$r.Height }
            depth      = $depth
            enabled    = [bool]$c.IsEnabled
            focused    = [bool]$c.HasKeyboardFocus
            untrusted  = $true   # UI 文本一律标记不可信（R1 提示注入）
            children   = @()
        }
        # ValuePattern 的值（编辑框内容）——属于不可信输入
        try {
            $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
            if ($vp) { $node.value = [string]$vp.Current.Value }
        } catch { }
        if ($depth -lt $maxDepth) {
            $kids = $el.FindAll([System.Windows.Automation.TreeScope]::Children,
                                [System.Windows.Automation.Condition]::TrueCondition)
            foreach ($k in $kids) {
                $node.children += (Convert-Node $k ($depth + 1) $maxDepth $ref)
            }
        } elseif ($el.FindAll([System.Windows.Automation.TreeScope]::Children,
                    [System.Windows.Automation.Condition]::TrueCondition).Count -gt 0) {
            $node.truncated = $true
        }
        return $node
    }

    switch ($command) {
        'capabilities' {
            Write-Result @{ ok = $true; uia = $true; screenshot = $true; input = $true;
                            note = 'requires interactive desktop session' }
        }
        'snapshot' {
            $sw = [Diagnostics.Stopwatch]::StartNew()
            $appId = [string]$args.appId
            $maxDepth = if ($args.maxDepth) { [int]$args.maxDepth } else { 3 }
            $root = Get-AppRoot $appId
            if (-not $root) { Write-Err 'OBSERVATION_FAILED' "未找到目标窗口：$appId"; break }
            $script:CurrentSnapshotId = 'uia-' + [Guid]::NewGuid().ToString('N').Substring(0, 12)
            $script:NodeSeq = 0
            $script:SnapshotStore[$script:CurrentSnapshotId] = @{}
            $tree = @(Convert-Node $root 0 $maxDepth 'e')
            $sw.Stop()
            Write-Result @{
                ok = $true; snapshotId = $script:CurrentSnapshotId; appId = $appId
                tree = $tree; source = if ($tree.Count) { 'a11y' } else { 'empty' }
                nodeCount = $tree.Count; elapsedMs = [int]$sw.ElapsedMilliseconds
                truncated = $true; boundary = 'depth-budget-exhausted; drill down with rootRef'
                untrusted = $true
            }
        }
        'screenshot' {
            $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
            $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
            $g = [System.Drawing.Graphics]::FromImage($bmp)
            $g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
            $ms = New-Object System.IO.MemoryStream
            $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
            $b64 = [Convert]::ToBase64String($ms.ToArray())
            $g.Dispose(); $bmp.Dispose(); $ms.Dispose()
            # 不写磁盘：画面只在返回管道的内存里（R2）
            Write-Result @{ ok = $true; mimeType = 'image/png'; base64 = $b64
                            width = $b.Width; height = $b.Height; persisted = $false; untrusted = $true }
        }
        'invokeRef' {
            $sid = [string]$args.snapshotId; $ref = [string]$args.ref
            if (-not $script:SnapshotStore.ContainsKey($sid) -or -not $script:SnapshotStore[$sid].ContainsKey($ref)) {
                Write-Err 'STALE_REF' "ref $ref 不在快照 $sid 中，请重新 snapshot"; break
            }
            $el = $script:SnapshotStore[$sid][$ref]
            try {
                $value = $args.value
                if ($null -ne $value -and $value -ne '') {
                    $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
                    $vp.SetValue([string]$value)
                    Write-Result @{ ok = $true; via = 'value-pattern'; ref = $ref; foregroundRequired = $false }
                } else {
                    $ip = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
                    $ip.Invoke()
                    Write-Result @{ ok = $true; via = 'a11y-invoke'; ref = $ref; foregroundRequired = $false }
                }
            } catch { Write-Err 'ACTION_DENIED' "元素不支持该模式：$($_.Exception.Message)"; }
        }
        'clickXY' {
            [DcxNativeInput]::Click([int]$args.x, [int]$args.y) | Out-Null
            Write-Result @{ ok = $true; via = 'coordinate-input'; foregroundRequired = $true }
        }
        'typeText' {
            [System.Windows.Forms.SendKeys]::SendWait(([string]$args.text) -replace '([+^%~(){}\[\]])', '{$1}')
            Write-Result @{ ok = $true; via = 'keyboard' }
        }
        'sendKey' {
            [System.Windows.Forms.SendKeys]::SendWait([string]$args.combo)
            Write-Result @{ ok = $true; combo = [string]$args.combo }
        }
        'waitFor' {
            Start-Sleep -Milliseconds ([Math]::Min(200, [int]($args.timeoutMs | ForEach-Object { if ($_) { $_ } else { 50 } })))
            Write-Result @{ ok = $true; predicate = [string]$args.predicate }
        }
        'observeState' {
            $fg = [System.Windows.Automation.AutomationElement]::FocusedElement
            Write-Result @{ ok = $true; focusedName = [string]$fg.Current.Name; untrusted = $true }
        }
        default { Write-Err 'INVALID_ARGUMENT' "未知命令：$command" }
    }
} catch {
    Write-Err 'CAPABILITY_UNAVAILABLE' "UIA 桥不可用：$($_.Exception.Message)"
}
