<#
.SYNOPSIS
    deepcode-desktop-agent Windows UIA 桥（L4 执行层平台实现，长驻 stdio）。

.DESCRIPTION
    由 desktop/desktop-agent/src/backends/windows.mjs 以
        powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File windows-uia.ps1 -Stdio
    启动为**长驻子进程**。协议：
      - 启动后 stdout 第一行输出 {"ok":true,"type":"ready",...}
      - 之后 stdin 每行一条 base64(JSON) 请求 {id,command,args}
      - stdout 每行一条 JSON 响应 {id,...result}（最后一行无换行缓冲，逐行 Flush）
      - 所有诊断日志走 stderr，绝不污染 stdout

    为什么必须长驻：稳定 ref 绑定的是 AutomationElement 强引用，存于本进程内存。
    P1 的「每次调用新起 powershell.exe」会让 SnapshotStore 跨进程丢失，
    invokeRef 必然 STALE_REF——这是真机打不通的根因，不是沙箱权限问题。

    能力：
      listWindows / snapshot（骨架+完整树+稳定 ref）/ screenshot / invokeRef /
      clickXY / typeText / sendKey / waitFor / observeState / invalidateSnapshots

.NOTES
    安全：截图只回传内存 base64，不落盘；键盘/坐标输入先校验前台窗口属于目标
    进程，避免把文本或点击打到用户正在使用的其它窗口；UAC / 锁屏 / 验证码不绕过。
#>
param(
    [string]$PayloadBase64 = '',
    [switch]$Stdio
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

$script:SnapshotStore = @{}
$script:NodeSeq = 0
$script:NodeCount = 0
$script:MaxNodes = 1500
$script:CurrentSnapshotId = ''
$script:LastAppId = ''
$script:LastPid = 0
$script:LastHwnd = 0
$script:Ready = $false
$script:MaxSnapshots = 8
# 生命周期相关（供 Node 侧 health / shutdown 使用）
$script:StartedAt = Get-Date
$script:RequestCount = 0
$script:Stopping = $false

function Write-JsonLine($obj) {
    $json = $obj | ConvertTo-Json -Depth 14 -Compress
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
}

function Write-Diag([string]$msg) {
    [Console]::Error.WriteLine("[uia] $msg")
}

function New-Fail([string]$code, [string]$message, $extra = $null) {
    $o = [ordered]@{ ok = $false; code = $code; message = $message }
    if ($extra) { foreach ($k in $extra.Keys) { $o[$k] = $extra[$k] } }
    return $o
}

function Emit-Result($obj, $id) {
    if ($null -eq $id) { Write-JsonLine $obj; return }
    $o = [ordered]@{ id = $id }
    foreach ($k in $obj.Keys) { $o[$k] = $obj[$k] }
    Write-JsonLine $o
}

function Initialize-Bridge {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DcxNative {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from, uint to, bool attach);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    public const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004;
    public static void Click(int x, int y) {
        SetCursorPos(x, y);
        mouse_event(LEFTDOWN, 0, 0, 0, IntPtr.Zero);
        mouse_event(LEFTUP, 0, 0, 0, IntPtr.Zero);
    }
    public static uint ForegroundPid() {
        uint pid;
        GetWindowThreadProcessId(GetForegroundWindow(), out pid);
        return pid;
    }
    public static long ForegroundHwnd() {
        return GetForegroundWindow().ToInt64();
    }
    /**
     * 后台进程直接调 SetForegroundWindow 常被 Windows 前台锁定拒绝。
     * 用 AttachThreadInput 临时挂到前台线程的输入队列，配合 SW_RESTORE /
     * BringWindowToTop 再置前，最后按 HWND 校验而非只比 PID（同进程多窗口）。
     */
    public static bool ForceForeground(IntPtr h) {
        if (h == IntPtr.Zero) return false;
        IntPtr fg = GetForegroundWindow();
        if (fg == h) return true;
        uint dummy;
        uint fgThread = GetWindowThreadProcessId(fg, out dummy);
        uint curThread = GetCurrentThreadId();
        bool attached = false;
        if (fgThread != 0 && fgThread != curThread) {
            attached = AttachThreadInput(curThread, fgThread, true);
        }
        ShowWindow(h, 9);
        BringWindowToTop(h);
        SetForegroundWindow(h);
        if (attached) AttachThreadInput(curThread, fgThread, false);
        return GetForegroundWindow() == h;
    }
}
'@
    # 自检：能真正枚举顶层窗口才算 UIA 可用（不靠硬编码 supported:true）
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $probe = $root.FindAll([System.Windows.Automation.TreeScope]::Children,
                           [System.Windows.Automation.Condition]::TrueCondition)
    $null = $probe.Count
    $script:Ready = $true
}

function Get-TopWindows {
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children,
                          [System.Windows.Automation.Condition]::TrueCondition)
    $list = @()
    foreach ($w in $wins) {
        try {
            $c = $w.Current
            if (-not $c.Name) { continue }
            $pn = ''
            $p = Get-Process -Id $c.ProcessId -ErrorAction SilentlyContinue
            if ($p) { $pn = [string]$p.ProcessName }
            $list += ,([pscustomobject]@{
                El = $w; Name = [string]$c.Name; Pid = [int]$c.ProcessId
                ProcessName = $pn; Hwnd = [long]$c.NativeWindowHandle
            })
        } catch { }
    }
    return $list
}

function Resolve-Window([string]$appId, [int]$targetPid, [long]$targetHwnd) {
    $wins = @(Get-TopWindows)
    # HWND 优先：同一进程可能有多个窗口（如资源管理器的桌面窗口与文件夹窗口），
    # 只按 pid 会稳定命中错误的那一个，后续 ref 与坐标都会落在错窗口上。
    if ($targetHwnd -gt 0) {
        foreach ($w in $wins) { if ([long]$w.Hwnd -eq $targetHwnd) { return $w } }
        return $null
    }
    if ($targetPid -gt 0) {
        foreach ($w in $wins) { if ($w.Pid -eq $targetPid) { return $w } }
    }
    if ($appId) {
        foreach ($w in $wins) { if ($w.ProcessName -ieq $appId) { return $w } }
        foreach ($w in $wins) { if ($w.Name -like "*$appId*") { return $w } }
    }
    return $null
}

function Convert-Node($el, [int]$depth, [int]$maxDepth, [string]$prefix) {
    $c = $el.Current
    $seq = $script:NodeSeq++
    $ref = "$prefix$seq"
    $script:SnapshotStore[$script:CurrentSnapshotId][$ref] = $el
    $script:NodeCount++
    $rx = 0; $ry = 0; $rw = 0; $rh = 0
    try {
        $r = $c.BoundingRectangle
        if ($r.Width -lt 100000 -and $r.Height -lt 100000) {
            $rx = [int]$r.X; $ry = [int]$r.Y; $rw = [int]$r.Width; $rh = [int]$r.Height
        }
    } catch { }

    $node = [ordered]@{
        ref       = $ref
        role      = [string]($c.ControlType.ProgrammaticName -replace 'ControlType\.', '')
        name      = [string]$c.Name
        rect      = [ordered]@{ x = $rx; y = $ry; width = $rw; height = $rh }
        depth     = $depth
        enabled   = [bool]$c.IsEnabled
        focused   = [bool]$c.HasKeyboardFocus
        untrusted = $true
        children  = @()
    }
    try {
        $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        if ($vp) { $node['value'] = [string]$vp.Current.Value }
    } catch { }

    $kids = @()
    try {
        if ($depth -lt $maxDepth -and $script:NodeCount -lt $script:MaxNodes) {
            $kids = @($el.FindAll([System.Windows.Automation.TreeScope]::Children,
                                  [System.Windows.Automation.Condition]::TrueCondition))
        }
    } catch { }
    $children = @()
    foreach ($k in $kids) { $children += ,(Convert-Node $k ($depth + 1) $maxDepth $ref) }
    $node['children'] = $children
    return $node
}

# 从同源完整树裁出骨架，保证 tree 与 fullTree 的 ref 完全一致（下钻才有效）
function Copy-Skeleton($node, [int]$depth, [int]$maxDepth) {
    $o = [ordered]@{}
    foreach ($k in $node.Keys) { if ($k -ne 'children') { $o[$k] = $node[$k] } }
    $kids = @($node['children'])
    if ($depth -ge $maxDepth) {
        $o['children'] = @()
        if ($kids.Count -gt 0) { $o['truncated'] = $true }
    } else {
        $arr = @()
        foreach ($k in $kids) { $arr += ,(Copy-Skeleton $k ($depth + 1) $maxDepth) }
        $o['children'] = $arr
    }
    return $o
}

function Get-WindowState($w) {
    $o = [ordered]@{ ok = $true }
    $focusedName = ''
    $focusedValue = ''
    try {
        $fg = [System.Windows.Automation.AutomationElement]::FocusedElement
        $focusedName = [string]$fg.Current.Name
        try {
            $vp = $fg.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
            if ($vp) { $focusedValue = [string]$vp.Current.Value }
        } catch { }
    } catch { }
    $o['focusedName'] = $focusedName
    $o['focusedValue'] = $focusedValue

    $activeName = ''
    $activePid = 0
    $values = @()
    $texts = @()
    if ($null -ne $w) {
        $activeName = [string]$w.Name
        $activePid = [int]$w.Pid
        try {
            $all = $w.El.FindAll([System.Windows.Automation.TreeScope]::Descendants,
                                [System.Windows.Automation.Condition]::TrueCondition)
            $limit = [Math]::Min($all.Count, 200)
            for ($i = 0; $i -lt $limit; $i++) {
                $n = $all[$i]
                try {
                    $vp = $n.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
                    if ($vp) { $values += ,([string]$vp.Current.Value) }
                } catch { }
                # 文本快照：按钮点击后 Label/状态文本变化也能被 Verifier 检测到
                try {
                    $nm = [string]$n.Current.Name
                    if ($nm -and $texts.Count -lt 60) { $texts += ,$nm }
                } catch { }
            }
        } catch { }
    }
    $o['activeWindowName'] = $activeName
    $o['activePid'] = $activePid
    $o['editValues'] = @($values)
    $o['texts'] = @($texts)
    $o['untrusted'] = $true
    return $o
}

function Test-Foreground([string]$appId, [int]$targetPid, [long]$targetHwnd, [switch]$Activate) {
    $w = Resolve-Window $appId $targetPid $targetHwnd
    if ($null -eq $w) { return $null }
    if ($Activate -and $w.Hwnd -ne 0) {
        # 后台进程置前常被拒绝：多策略重试（AttachThreadInput + UIA SetFocus），
        # 每次以 HWND 精确校验，避免同 appId 多窗口时误判成「已置前」。
        for ($i = 0; $i -lt 4; $i++) {
            try {
                if ([DcxNative]::ForceForeground([IntPtr][long]$w.Hwnd)) { break }
            } catch { }
            try { $w.El.SetFocus() } catch { }
            Start-Sleep -Milliseconds 120
            try {
                if ([long][DcxNative]::ForegroundHwnd() -eq [long]$w.Hwnd) { break }
            } catch { }
        }
        Start-Sleep -Milliseconds 100
    }
    $fgHwnd = [long][DcxNative]::ForegroundHwnd()
    if ($fgHwnd -eq [long]$w.Hwnd) { return $w }
    # 同进程多窗口（例如宿主进程还带一个控制台窗口）时，前台属于目标进程也可接受；
    # 关键是绝不能把输入打到别的进程窗口上。
    if ([int][DcxNative]::ForegroundPid() -eq [int]$w.Pid) { return $w }
    return $null
}

function Invoke-Dcx([string]$command, $a) {
    if ($null -eq $a) { $a = @{} }
    switch ($command) {
        'ping' {
            # 轻量健康检查：只读进程内状态，不碰 UIA。Node 侧据此判断
            # 「进程活着但管道僵死」并触发回收重建。
            $refCount = 0
            foreach ($k in $script:SnapshotStore.Keys) {
                try { $refCount += $script:SnapshotStore[$k].Count } catch { }
            }
            $uptime = [int]((Get-Date) - $script:StartedAt).TotalMilliseconds
            $o = [ordered]@{
                ok = $true; pong = $true; protocol = 1
                uptimeMs = $uptime
                requests = $script:RequestCount
                snapshots = $script:SnapshotStore.Count
                refs = $refCount
                lastHwnd = [long]$script:LastHwnd
                workingSetMb = [int]([Diagnostics.Process]::GetCurrentProcess().WorkingSet64 / 1MB)
            }
            return $o
        }
        'capabilities' {
            $o = [ordered]@{
                ok = $true; uia = $script:Ready; screenshot = $true; input = $true
                session = [string]$env:SESSIONNAME
                userInteractive = [bool][Environment]::UserInteractive
                psVersion = [string]$PSVersionTable.PSVersion
                uptimeMs = [int]((Get-Date) - $script:StartedAt).TotalMilliseconds
                note = 'windows-uia.ps1 persistent stdio bridge'
            }
            return $o
        }
        'listWindows' {
            $wins = @(Get-TopWindows)
            $arr = @()
            foreach ($w in $wins) {
                $arr += ,([ordered]@{
                    appId = ([string]$w.ProcessName).ToLowerInvariant()
                    processName = [string]$w.ProcessName
                    pid = [int]$w.Pid
                    name = [string]$w.Name
                    hwnd = [long]$w.Hwnd
                })
            }
            $o = [ordered]@{ ok = $true; windows = $arr; count = $arr.Count }
            return $o
        }
        'snapshot' {
            $sw = [Diagnostics.Stopwatch]::StartNew()
            $appId = [string]$a.appId
            $targetPid = 0
            if ($a.pid) { $targetPid = [int]$a.pid }
            $targetHwnd = 0
            if ($a.hwnd) { $targetHwnd = [long]$a.hwnd }
            $maxDepth = 2
            if ($a.maxDepth) { $maxDepth = [Math]::Min([Math]::Max([int]$a.maxDepth, 1), 8) }
            $w = Resolve-Window $appId $targetPid $targetHwnd
            if ($null -eq $w) {
                return New-Fail 'OBSERVATION_FAILED' "未找到目标窗口：$appId (pid=$targetPid, hwnd=$targetHwnd)"
            }
            $script:LastAppId = $appId
            $script:LastPid = [int]$w.Pid
            $script:LastHwnd = [long]$w.Hwnd
            $script:CurrentSnapshotId = 'uia-' + [Guid]::NewGuid().ToString('N').Substring(0, 12)
            $script:NodeSeq = 0
            $script:NodeCount = 0
            $script:SnapshotStore[$script:CurrentSnapshotId] = @{}
            $fullDepth = [Math]::Min($maxDepth + 2, 8)
            $fullTree = @(,(Convert-Node $w.El 0 $fullDepth 'e'))
            $skeleton = @()
            foreach ($n in $fullTree) { $skeleton += ,(Copy-Skeleton $n 0 $maxDepth) }
            if ($script:SnapshotStore.Count -gt $script:MaxSnapshots) {
                $keys = @($script:SnapshotStore.Keys)
                $removeCount = $keys.Count - $script:MaxSnapshots
                for ($i = 0; $i -lt $removeCount; $i++) {
                    if ($keys[$i] -ne $script:CurrentSnapshotId) { $script:SnapshotStore.Remove($keys[$i]) }
                }
            }
            $sw.Stop()
            $o = [ordered]@{
                ok = $true; snapshotId = $script:CurrentSnapshotId
                appId = $appId; pid = $script:LastPid; hwnd = $script:LastHwnd; windowName = [string]$w.Name
                tree = $skeleton; fullTree = $fullTree
                source = 'a11y'; nodeCount = $script:NodeCount
                elapsedMs = [int]$sw.ElapsedMilliseconds
                truncated = $true; boundary = 'depth-budget-exhausted; drill down with rootRef'
                untrusted = $true
            }
            return $o
        }
        'screenshot' {
            $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
            $x = [int]$b.X; $y = [int]$b.Y; $w = [int]$b.Width; $h = [int]$b.Height
            $appId = [string]$a.appId
            $targetPid = 0
            if ($a.pid) { $targetPid = [int]$a.pid }
            $targetHwnd = 0
            if ($a.hwnd) { $targetHwnd = [long]$a.hwnd }
            if ($appId -or $targetPid -gt 0 -or $targetHwnd -gt 0) {
                $win = Resolve-Window $appId $targetPid $targetHwnd
                if ($null -ne $win) {
                    try {
                        $r = $win.El.Current.BoundingRectangle
                        if ($r.Width -gt 0 -and $r.Height -gt 0 -and $r.Width -lt 100000) {
                            $x = [int]$r.X; $y = [int]$r.Y; $w = [int]$r.Width; $h = [int]$r.Height
                        }
                    } catch { }
                }
            }
            $bmp = New-Object System.Drawing.Bitmap($w, $h)
            $g = [System.Drawing.Graphics]::FromImage($bmp)
            $g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)
            $ms = New-Object System.IO.MemoryStream
            $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
            $b64 = [Convert]::ToBase64String($ms.ToArray())
            $g.Dispose(); $bmp.Dispose(); $ms.Dispose()
            $o = [ordered]@{
                ok = $true; mimeType = 'image/png'; base64 = $b64
                width = $w; height = $h; bytes = $b64.Length
                persisted = $false; untrusted = $true
            }
            return $o
        }
        'invokeRef' {
            $sid = [string]$a.snapshotId
            $ref = [string]$a.ref
            if (-not $script:SnapshotStore.ContainsKey($sid)) {
                return New-Fail 'STALE_REF' "快照 $sid 不存在或已过期，请重新 snapshot"
            }
            $store = $script:SnapshotStore[$sid]
            if (-not $store.ContainsKey($ref)) {
                return New-Fail 'STALE_REF' "ref $ref 不在快照 $sid 中"
            }
            $el = $store[$ref]
            try { $null = $el.Current.Name } catch {
                return New-Fail 'STALE_REF' '元素已失效（窗口关闭或重建）'
            }
            $value = $a.value
            $via = ''
            if ($null -ne $value -and ([string]$value).Length -gt 0) {
                try {
                    $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
                    if ($vp) { $vp.SetValue([string]$value); $via = 'value-pattern' }
                } catch { }
            }
            if (-not $via) {
                try {
                    $ip = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
                    if ($ip) { $ip.Invoke(); $via = 'a11y-invoke' }
                } catch { }
            }
            if (-not $via) {
                try {
                    $tp = $el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
                    if ($tp) { $tp.Toggle(); $via = 'toggle-pattern' }
                } catch { }
            }
            if (-not $via) {
                # 坐标回退同样必须确认前台窗口属于目标进程，避免误点其它窗口
                $fgApp = [string]$a.appId
                $fgPid = 0
                if ($a.pid) { $fgPid = [int]$a.pid }
                $fgHwnd = 0
                if ($a.hwnd) { $fgHwnd = [long]$a.hwnd }
                $fgWin = Test-Foreground $fgApp $fgPid $fgHwnd -Activate
                if ($null -ne $fgWin) {
                    try {
                        $r = $el.Current.BoundingRectangle
                        if ($r.Width -gt 0 -and $r.Height -gt 0 -and $r.Width -lt 100000) {
                            $cx = [int]($r.X + $r.Width / 2)
                            $cy = [int]($r.Y + $r.Height / 2)
                            [DcxNative]::Click($cx, $cy)
                            $via = 'coordinate-fallback'
                        }
                    } catch { }
                }
            }
            if (-not $via) {
                return New-Fail 'ACTION_DENIED' '元素不支持 Invoke/Value/Toggle，且无有效坐标' @{ ref = $ref }
            }
            $o = [ordered]@{
                ok = $true; via = $via; ref = $ref; action = [string]$a.action
                foregroundRequired = ($via -eq 'coordinate-fallback')
            }
            return $o
        }
        'clickXY' {
            $appId = [string]$a.appId
            $targetPid = 0
            if ($a.pid) { $targetPid = [int]$a.pid }
            $targetHwnd = 0
            if ($a.hwnd) { $targetHwnd = [long]$a.hwnd }
            $win = Test-Foreground $appId $targetPid $targetHwnd -Activate
            if ($null -eq $win) {
                return New-Fail 'ACTION_DENIED' '坐标点击被拒绝：无法把目标窗口置为前台' @{
                    hint = '避免把点击打到用户正在使用的其它窗口'
                }
            }
            $x = [int]$a.x; $y = [int]$a.y
            [DcxNative]::Click($x, $y)
            $o = [ordered]@{ ok = $true; via = 'coordinate-input'; x = $x; y = $y; foregroundRequired = $true }
            return $o
        }
        'typeText' {
            $text = [string]$a.text
            $sid = [string]$a.snapshotId
            $ref = [string]$a.ref
            $via = ''
            # paste 是调用方的**显式通道选择**：它意味着「这个落点是自绘文档模型，
            # 请走应用自己的粘贴路径」。此时绝不能先用 ValuePattern 抄近路——
            # Excel 的焦点元素是「编辑栏」（也是 Edit/ValuePattern），SetValue 会返回
            # 成功、屏幕上却什么都没变，形成一个看起来全绿、实际零写入的假成功。
            if (-not $a.paste -and $sid -and $ref -and $script:SnapshotStore.ContainsKey($sid) -and $script:SnapshotStore[$sid].ContainsKey($ref)) {
                $el = $script:SnapshotStore[$sid][$ref]
                try {
                    $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
                    if ($vp) { $vp.SetValue($text); $via = 'value-pattern-ref' }
                } catch { }
            }
            if (-not $a.paste -and -not $via) {
                try {
                    $fg = [System.Windows.Automation.AutomationElement]::FocusedElement
                    $vp = $fg.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
                    if ($vp) { $vp.SetValue($text); $via = 'value-pattern-focused' }
                } catch { }
            }
            if (-not $via) {
                $appId = [string]$a.appId
                $targetPid = 0
                if ($a.pid) { $targetPid = [int]$a.pid }
                $targetHwnd = 0
                if ($a.hwnd) { $targetHwnd = [long]$a.hwnd }
                $win = Test-Foreground $appId $targetPid $targetHwnd -Activate
                if ($null -eq $win) {
                    return New-Fail 'ACTION_DENIED' '键盘输入被拒绝：前台窗口不属于目标应用' @{
                        hint = '优先用 ValuePattern 输入（不抢焦点）；确认目标窗口已置前'
                    }
                }
                if ($a.paste) {
                    # 剪贴板粘贴：Word / Excel 的自绘编辑区用 SendKeys 会稳定漏字符
                    # （实测 "M-abc-123" → "M-abc-2"，逐字符 + 20ms 也救不回来），
                    # 而 ^v 是应用自己的标准输入路径，一次到位。
                    # 代价是临时占用剪贴板：写前读旧文本、写完立刻还原，只在文本格式上操作。
                    $prev = $null
                    try { $prev = Get-Clipboard -Raw -ErrorAction Stop } catch { }
                    try {
                        Set-Clipboard -Value $text
                        Start-Sleep -Milliseconds 120
                        [System.Windows.Forms.SendKeys]::SendWait('^v')
                        Start-Sleep -Milliseconds 250
                        $via = 'clipboard-paste'
                    } catch {
                        $via = ''
                    } finally {
                        try {
                            if ($null -ne $prev -and $prev.Length -gt 0) { Set-Clipboard -Value $prev }
                            else { Set-Clipboard -Value ' ' }
                        } catch { }
                    }
                }
                if (-not $via) {
                    # 逐字符发送：一次 SendWait 整个字符串时，慢应用会漏字符。字符级 + 间隔相对稳，
                    # 但对自绘文档模型仍不保证（这正是要提供 paste 通道的原因）。
                    $perChar = 20
                    if ($a.perCharMs) { $perChar = [Math]::Min([Math]::Max([int]$a.perCharMs, 0), 200) }
                    for ($i = 0; $i -lt $text.Length; $i++) {
                        $ch2 = [string]$text[$i]
                        $escaped = $ch2 -replace '([+^%~(){}\[\]])', '{$1}'
                        [System.Windows.Forms.SendKeys]::SendWait($escaped)
                        if ($perChar -gt 0) { Start-Sleep -Milliseconds $perChar }
                    }
                    $via = 'keyboard'
                }
            }
            $o = [ordered]@{
                ok = $true; via = $via; chars = $text.Length
                foregroundRequired = ($via -eq 'keyboard' -or $via -eq 'clipboard-paste')
            }
            return $o
        }
        'sendKey' {
            $appId = [string]$a.appId
            $targetPid = 0
            if ($a.pid) { $targetPid = [int]$a.pid }
            $targetHwnd = 0
            if ($a.hwnd) { $targetHwnd = [long]$a.hwnd }
            $win = Test-Foreground $appId $targetPid $targetHwnd -Activate
            if ($null -eq $win) {
                return New-Fail 'ACTION_DENIED' '快捷键发送被拒绝：前台窗口不属于目标应用'
            }
            $combo = [string]$a.combo
            [System.Windows.Forms.SendKeys]::SendWait($combo)
            $o = [ordered]@{ ok = $true; combo = $combo; via = 'keyboard' }
            return $o
        }
        'waitFor' {
            $timeoutMs = 200
            if ($a.timeoutMs) { $timeoutMs = [Math]::Min([Math]::Max([int]$a.timeoutMs, 10), 5000) }
            Start-Sleep -Milliseconds $timeoutMs
            $o = [ordered]@{ ok = $true; predicate = [string]$a.predicate; waitedMs = $timeoutMs }
            return $o
        }
        'observeState' {
            $w = $null
            if ($script:LastHwnd -gt 0) { $w = Resolve-Window '' 0 ([long]$script:LastHwnd) }
            if ($null -eq $w -and $script:LastPid -gt 0) { $w = Resolve-Window '' ([int]$script:LastPid) }
            if ($null -eq $w -and $script:LastAppId) { $w = Resolve-Window $script:LastAppId 0 0 }
            return (Get-WindowState $w)
        }
        'text' {
            # 读「文档正文」而不是控件属性：Word / Excel 这类自绘文档模型没有 ValuePattern，
            # 只有 TextPattern。没有它，验证器只能看 UI 上的标题/提示文本变化，
            # 一个 tooltip 冒出来就会被误判成「内容变了」。
            $sid = [string]$a.snapshotId
            $ref = [string]$a.ref
            $el = $null
            if ($sid -and $ref -and $script:SnapshotStore.ContainsKey($sid) -and $script:SnapshotStore[$sid].ContainsKey($ref)) {
                $el = $script:SnapshotStore[$sid][$ref]
            }
            if ($null -eq $el) {
                $appId = [string]$a.appId
                $targetPid = 0
                if ($a.pid) { $targetPid = [int]$a.pid }
                $targetHwnd = 0
                if ($a.hwnd) { $targetHwnd = [long]$a.hwnd }
                if (-not $appId -and -not $targetPid -and -not $targetHwnd) {
                    $appId = $script:LastAppId; $targetPid = $script:LastPid; $targetHwnd = $script:LastHwnd
                }
                $w = Resolve-Window $appId $targetPid $targetHwnd
                if ($null -ne $w) {
                    $docs = @($w.El.FindAll([System.Windows.Automation.TreeScope]::Descendants,
                                            [System.Windows.Automation.Condition]::TrueCondition)) |
                            Where-Object { try { $_.Current.ControlType.ProgrammaticName -eq 'ControlType.Document' } catch { $false } }
                    if ($docs.Count -gt 0) { $el = $docs[0] } else { $el = $w.El }
                }
            }
            if ($null -eq $el) {
                return New-Fail 'OBSERVATION_FAILED' '未找到可读文本的目标元素（先 snapshot 或指定 appId/hwnd）'
            }
            $limit = 4000
            if ($a.maxLength) { $limit = [Math]::Min([Math]::Max([int]$a.maxLength, 16), 20000) }
            $text = $null
            $via = ''
            try {
                $tp = $el.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
                if ($tp) { $text = [string]$tp.DocumentRange.GetText($limit); $via = 'text-pattern' }
            } catch { }
            if ($null -eq $text) {
                try {
                    $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
                    if ($vp) { $text = [string]$vp.Current.Value; $via = 'value-pattern' }
                } catch { }
            }
            if ($null -eq $text) {
                return New-Fail 'CAPABILITY_UNAVAILABLE' '目标元素既不支持 TextPattern 也不支持 ValuePattern'
            }
            $o = [ordered]@{
                ok = $true; via = $via; text = $text; length = $text.Length
                truncated = ($text.Length -ge $limit); untrusted = $true
            }
            return $o
        }
        'invalidateSnapshots' {
            $script:SnapshotStore = @{}
            $o = [ordered]@{ ok = $true; cleared = $true }
            return $o
        }
        'shutdown' {
            # 置 Stopping 后由主循环 break 退出：让 PowerShell 走正常退栈，
            # 而不是被 Node 侧 kill 掉（避免打断正在写盘的子进程/句柄未释放）
            $script:Stopping = $true
            $o = [ordered]@{ ok = $true; bye = $true; requests = $script:RequestCount }
            return $o
        }
    }
    return New-Fail 'INVALID_ARGUMENT' "未知命令：$command"
}

try {
    Initialize-Bridge
} catch {
    $msg = "UIA 桥初始化失败：$($_.Exception.Message)"
    Write-Diag $msg
    if ($Stdio) {
        Write-JsonLine ([ordered]@{ ok = $false; type = 'ready'; code = 'CAPABILITY_UNAVAILABLE'; message = $msg })
    } else {
        Write-JsonLine (New-Fail 'CAPABILITY_UNAVAILABLE' $msg)
    }
    exit 1
}

if (-not $Stdio) {
    # 单次模式仅用于诊断 / 无状态命令；跨进程无法复用 ref，正式路径请用 -Stdio
    try {
        $req = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PayloadBase64)) | ConvertFrom-Json
        $res = Invoke-Dcx ([string]$req.command) $req.args
        Emit-Result $res $null
    } catch {
        Write-JsonLine (New-Fail 'INTERNAL' "桥请求处理失败：$($_.Exception.Message)")
    }
    exit 0
}

Write-JsonLine ([ordered]@{
    ok = $true; type = 'ready'; protocol = 1; bridge = 'windows-uia'
    psVersion = [string]$PSVersionTable.PSVersion
    session = [string]$env:SESSIONNAME
    userInteractive = [bool][Environment]::UserInteractive
    pid = $PID
})

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Trim().Length -eq 0) { continue }
    $id = $null
    try {
        $raw = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line.Trim()))
        $req = $raw | ConvertFrom-Json
        $id = $req.id
        $script:RequestCount = $script:RequestCount + 1
        $res = Invoke-Dcx ([string]$req.command) $req.args
        Emit-Result $res $id
    } catch {
        Write-Diag "请求失败：$($_.Exception.Message)"
        Emit-Result (New-Fail 'INTERNAL' "桥请求处理失败：$($_.Exception.Message)") $id
    }
    if ($script:Stopping) { Write-Diag '收到 shutdown，正常退出'; break }
}
