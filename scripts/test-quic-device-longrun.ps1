param(
    [int]$DurationHours = 2,
    [string]$Device = '',
    [int]$QuicPort = 1935,
    [int]$UdpFallbackPort = 1936,
    [string]$LogDirectory = ''
)

$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
$packageName = 'org.dpdns.sylw.videostreamer.debug'
$duration = [TimeSpan]::FromHours($DurationHours)
if ([string]::IsNullOrWhiteSpace($LogDirectory)) {
    $LogDirectory = Join-Path $projectDirectory 'tmp-quic-longrun'
}
New-Item -ItemType Directory -Force -Path $LogDirectory | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$eventLog = Join-Path $LogDirectory "quic-device-$stamp.events.jsonl"
$errorLog = Join-Path $LogDirectory "quic-device-$stamp.server.stderr.log"
$resultPath = Join-Path $LogDirectory 'latest-result.json'
$serverProcess = $null

function Invoke-DeviceAdb {
    param([string[]]$Arguments)
    if ([string]::IsNullOrWhiteSpace($Device)) {
        & adb @Arguments
    } else {
        & adb -s $Device @Arguments
    }
    if ($LASTEXITCODE -ne 0) {
        throw "adb 失败($LASTEXITCODE): $($Arguments -join ' ')"
    }
}

function Get-DeviceUi {
    Invoke-DeviceAdb @('shell', 'uiautomator', 'dump', '/sdcard/codex-quic-ui.xml') | Out-Null
    $output = if ([string]::IsNullOrWhiteSpace($Device)) {
        & adb shell cat /sdcard/codex-quic-ui.xml
    } else {
        & adb -s $Device shell cat /sdcard/codex-quic-ui.xml
    }
    if ($LASTEXITCODE -ne 0) {
        throw '无法读取 Android UI 层次'
    }
    return ($output -join "`n")
}

function Tap-Device([int]$X, [int]$Y) {
    Invoke-DeviceAdb @('shell', 'input', 'tap', $X, $Y)
    Start-Sleep -Milliseconds 700
}

function Start-WholeScreenStream {
    Invoke-DeviceAdb @('shell', 'monkey', '-p', $packageName, '1') | Out-Null
    Start-Sleep -Milliseconds 800
    Tap-Device 1400 155
    $ui = Get-DeviceUi

    if ($ui -match '关闭录屏及相关服务') {
        Tap-Device 715 315
        Invoke-DeviceAdb @('shell', 'monkey', '-p', $packageName, '1') | Out-Null
        Start-Sleep -Milliseconds 500
        Tap-Device 1400 155
        $ui = Get-DeviceUi
    }

    if ($ui -match '授权并开启录屏') {
        Tap-Device 715 315
        Start-Sleep -Milliseconds 800
        $ui = Get-DeviceUi
        if ($ui -match 'screen_share_mode_spinner') {
            # OEM 默认是“共享一个应用”，显式改成“共享整个屏幕”。
            Tap-Device 1800 1650
            Tap-Device 1680 1480
            $ui = Get-DeviceUi
        }
        if ($ui -match 'android:id/button1|content-desc="继续"') {
            Tap-Device 1400 1890
            Start-Sleep -Milliseconds 1000
        }
        $ui = Get-DeviceUi
        if ($ui -match '屏幕共享保护|content-desc="开始"') {
            Tap-Device 1400 1890
        }
    }

    Invoke-DeviceAdb @('shell', 'monkey', '-p', $packageName, '1') | Out-Null
    Start-Sleep -Milliseconds 800
    $ui = Get-DeviceUi
    if ($ui -notmatch '关闭录屏及相关服务') {
        throw '录屏授权未建立；请确认系统授权范围为“共享整个屏幕”'
    }
    Tap-Device 2085 315
}

function Write-TestResult([string]$Status, [string]$Message, [object]$Metrics) {
    [ordered]@{
        status = $Status
        message = $Message
        finishedAt = (Get-Date).ToString('o')
        metrics = $Metrics
        eventLog = $eventLog
    } | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 $resultPath
}

try {
    Remove-Item -LiteralPath $resultPath -Force -ErrorAction SilentlyContinue
    $nodeArguments = @(
        (Join-Path $PSScriptRoot 'run-quic-device-server.js'),
        '--port', $QuicPort,
        '--udp-fallback-port', $UdpFallbackPort,
        '--recording-dir', (Join-Path $LogDirectory 'recordings')
    )
    # Windows PowerShell 在本机同时存在 Path/PATH 时，Start-Process 会因环境字典
    # 大小写冲突失败；用原生 ProcessStartInfo 启动 cmd 重定向日志，避免枚举环境变量。
    $nodePath = (Get-Command node.exe).Source
    $quotedArguments = ($nodeArguments | ForEach-Object { '"' + $_.ToString().Replace('"', '\"') + '"' }) -join ' '
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $env:ComSpec
    $startInfo.Arguments = '/d /c ""' + $nodePath + '" ' + $quotedArguments + ' 1>"' + $eventLog + '" 2>"' + $errorLog + '""'
    $startInfo.WorkingDirectory = $projectDirectory
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $serverProcess = [System.Diagnostics.Process]::Start($startInfo)
    Start-Sleep -Seconds 2
    if ($serverProcess.HasExited) {
        throw "QUIC 测试服务启动失败，请查看 $errorLog"
    }

    Start-WholeScreenStream
    $deadline = (Get-Date) + $duration
    $lastFrames = -1
    $lastFrameAt = Get-Date
    $lastMetrics = $null
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 5
        if ($serverProcess.HasExited) {
            throw "QUIC 测试服务提前退出，请查看 $errorLog"
        }
        $lines = if (Test-Path -LiteralPath $eventLog) { Get-Content -LiteralPath $eventLog -Tail 80 } else { @() }
        foreach ($line in $lines) {
            try {
                $event = $line | ConvertFrom-Json
            } catch {
                continue
            }
            if ($event.type -eq 'error' -or $event.type -eq 'test-server-error') {
                throw "服务端报告错误: $($event.message)"
            }
            if ($event.type -eq 'metrics' -and $event.transport -eq 'quic') {
                $lastMetrics = $event
                if (-not $event.active) {
                    throw 'QUIC 会话已结束'
                }
                if ([int]$event.droppedFrames -gt 0) {
                    throw "检测到丢帧: $($event.droppedFrames)"
                }
                if ([int64]$event.frames -gt $lastFrames) {
                    $lastFrames = [int64]$event.frames
                    $lastFrameAt = Get-Date
                }
            }
        }
        if ($null -eq $lastMetrics) {
            continue
        }
        if (((Get-Date) - $lastFrameAt).TotalSeconds -gt 20) {
            throw "视频帧超过 20 秒没有增长，最后帧数: $lastFrames"
        }
    }
    Write-TestResult 'passed' "完成 $DurationHours 小时 QUIC 可靠流长稳测试" $lastMetrics
    Write-Host "QUIC long-run test passed. Result: $resultPath"
    exit 0
} catch {
    Write-TestResult 'failed' $_.Exception.Message $lastMetrics
    Write-Error $_.Exception.Message
    exit 1
} finally {
    try { Invoke-DeviceAdb @('shell', 'am', 'force-stop', $packageName) } catch { }
    if ($null -ne $serverProcess -and -not $serverProcess.HasExited) {
        & taskkill.exe /PID $serverProcess.Id /T /F | Out-Null
    }
}
