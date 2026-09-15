# computer-use daemon：常驻 PowerShell 进程，stdin 收 JSON 指令行，stdout 回 @R@{json} 行
# 由 index.ts 启动；零原生依赖，全部 Win32 user32 + GDI+
$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
try { [Console]::InputEncoding = [System.Text.Encoding]::UTF8 } catch {}
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
# UIA 元素定位（精准模式）：枚举窗口控件 / 取焦点控件 / 命中点控件
try { Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes } catch {}
try { Add-Type -AssemblyName WindowsBase } catch {}
Add-Type @"
using System;using System.Runtime.InteropServices;
public class CUInput {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint dx,uint dy,uint d,int e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk,byte sc,uint f,int e);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd,int n);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
"@

function Get-Shot($x, $y, $w, $h, $maxw, $path) {
	$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
	if ($null -ne $x -and $w -gt 0) {
		$r = New-Object Drawing.Rectangle([int]$x, [int]$y, [int]$w, [int]$h)
	} else {
		$r = New-Object Drawing.Rectangle($vs.Left, $vs.Top, $vs.Width, $vs.Height)
	}
	$bmp = New-Object Drawing.Bitmap($r.Width, $r.Height)
	$g = [Drawing.Graphics]::FromImage($bmp)
	$g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
	$g.Dispose()
	if ($maxw -gt 0 -and $bmp.Width -gt $maxw) {
		$nh = [int]($bmp.Height * $maxw / $bmp.Width)
		$sm = New-Object Drawing.Bitmap($maxw, $nh)
		$g2 = [Drawing.Graphics]::FromImage($sm)
		$g2.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
		$g2.DrawImage($bmp, 0, 0, $maxw, $nh)
		$g2.Dispose(); $bmp.Dispose(); $bmp = $sm
	}
	$enc = [Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
	$ep = New-Object Drawing.Imaging.EncoderParameters(1)
	$ep.Param[0] = New-Object Drawing.Imaging.EncoderParameter([Drawing.Imaging.Encoder]::Quality, [int64]85)
	$bmp.Save($path, $enc, $ep)
	$out = @{ w = $bmp.Width; h = $bmp.Height }
	$bmp.Dispose(); $ep.Dispose()
	return $out
}

function Press-VKs($vks) {
	foreach ($v in $vks) { [CUInput]::keybd_event([byte]$v, 0, 0, 0) }
	Start-Sleep -Milliseconds 40
	for ($i = $vks.Count - 1; $i -ge 0; $i--) { [CUInput]::keybd_event([byte]$vks[$i], 0, 2, 0) }
}

# 前台窗口信息（用 GetWindowThreadProcessId 直接拿 pid，兼容终端/新式窗口）
function Get-FgInfo {
	$h = [CUInput]::GetForegroundWindow()
	if ($h -eq [IntPtr]::Zero) { return $null }
	$wpid = [uint32]0
	[CUInput]::GetWindowThreadProcessId($h, [ref]$wpid) | Out-Null
	if ($wpid -eq 0) { return $null }
	try { $p = Get-Process -Id $wpid -ErrorAction Stop; return @{ pid = $p.Id; name = $p.ProcessName; title = $p.MainWindowTitle } } catch { return @{ pid = $wpid; name = "?"; title = "" } }
}

# 控件简报：类型 + 名称（名称压平换行并截断）
function Get-ElBrief($el, $nameMax) {
	try {
		$c = $el.Current
		$t = $c.ControlType.ProgrammaticName -replace "^ControlType\.", ""
		$name = ([string]$c.Name) -replace "\s+", " "
		if ($name.Length -gt $nameMax) { $name = $name.Substring(0, $nameMax) + "…" }
		return @{ type = $t; name = $name }
	} catch { return $null }
}

# 当前焦点控件（反撒谎：type/focus 后 Agent 能看到文字进了哪个控件）
function Get-FocusedEl {
	try {
		$fe = [System.Windows.Automation.AutomationElement]::FocusedElement
		if ($null -eq $fe) { return $null }
		return Get-ElBrief $fe 40
	} catch { return $null }
}

while ($true) {
	$line = [Console]::In.ReadLine()
	if ($null -eq $line) { break }
	$req = $null
	$resp = $null
	try {
		$req = $line | ConvertFrom-Json
		switch ($req.op) {
			"shot" {
				$info = Get-Shot $req.x $req.y $req.w $req.h $req.maxw $req.path
				$resp = @{ id = $req.id; ok = $true; data = $info }
			}
			"click" {
				[CUInput]::SetCursorPos([int]$req.x, [int]$req.y) | Out-Null
				Start-Sleep -Milliseconds 60
				$down = 2; $up = 4
				if ($req.button -eq "right") { $down = 8; $up = 16 }
				elseif ($req.button -eq "middle") { $down = 32; $up = 64 }
				$n = 1; if ($req.double) { $n = 2 }
				for ($c = 0; $c -lt $n; $c++) {
					[CUInput]::mouse_event([uint32]$down, 0, 0, 0, 0)
					Start-Sleep -Milliseconds 25
					[CUInput]::mouse_event([uint32]$up, 0, 0, 0, 0)
					if ($c -lt $n - 1) { Start-Sleep -Milliseconds 70 }
				}
				# 点击落点精确报告：WindowFromPoint 拿实际命中的窗口所属进程（反撒谎：Agent 能看到点到了哪）
				$pt = New-Object CUInput+POINT
				$pt.X = [int]$req.x; $pt.Y = [int]$req.y
				$h = [CUInput]::WindowFromPoint($pt)
				$wpid = [uint32]0
				[CUInput]::GetWindowThreadProcessId($h, [ref]$wpid) | Out-Null
				$tproc = try { Get-Process -Id $wpid -ErrorAction Stop } catch { $null }
				# 控件级落点：FromPoint 拿命中点上的 UIA 控件（比窗口级更精准）
				$elType = ""; $elName = ""
				try {
					$ptA = New-Object System.Windows.Point([double]$req.x, [double]$req.y)
					$el = [System.Windows.Automation.AutomationElement]::FromPoint($ptA)
					if ($null -ne $el) { $b = Get-ElBrief $el 50; if ($b) { $elType = $b.type; $elName = $b.name } }
				} catch { }
				$resp = @{ id = $req.id; ok = $true; data = @{ msg = "clicked $n x $($req.button) at $($req.x),$($req.y)"; targetPid = $wpid; target = $tproc.ProcessName; title = $tproc.MainWindowTitle; elType = $elType; elName = $elName } }
			}
			"key" {
				Press-VKs @([int[]]$req.vks)
				Start-Sleep -Milliseconds 50
				$resp = @{ id = $req.id; ok = $true; data = "pressed" }
			}
			"paste" {
				# 粘贴落点报告：粘贴前记录前台窗口（反撒谎：Agent 能看到文字实际去了哪个窗口）
				$fgp = Get-FgInfo
				[System.Windows.Forms.Clipboard]::SetText([string]$req.text)
				Start-Sleep -Milliseconds 100
				Press-VKs @(17, 86)
				Start-Sleep -Milliseconds 100
				$fe = Get-FocusedEl
				$resp = @{ id = $req.id; ok = $true; data = @{ pasted = $req.text.Length; targetPid = $fgp.pid; target = $fgp.name; title = $fgp.title; feType = $fe.type; feName = $fe.name } }
			}
			"clip_get" {
				$resp = @{ id = $req.id; ok = $true; data = [string][System.Windows.Forms.Clipboard]::GetText() }
			}
			"clip_set" {
				[System.Windows.Forms.Clipboard]::SetText([string]$req.text)
				$resp = @{ id = $req.id; ok = $true; data = "clipboard set" }
			}
			"scroll" {
				if ($null -ne $req.x) { [CUInput]::SetCursorPos([int]$req.x, [int]$req.y) | Out-Null; Start-Sleep -Milliseconds 60 }
				$d = -[int]$req.amount * 120
				[CUInput]::mouse_event([uint32]0x0800, 0, 0, [uint32]($d -band 0xFFFFFFFF), 0)
				$resp = @{ id = $req.id; ok = $true; data = "scrolled $($req.amount)" }
			}
			"drag" {
				[CUInput]::SetCursorPos([int]$req.x1, [int]$req.y1) | Out-Null
				Start-Sleep -Milliseconds 90
				[CUInput]::mouse_event([uint32]2, 0, 0, 0, 0)
				Start-Sleep -Milliseconds 90
				$steps = 14
				for ($i = 1; $i -le $steps; $i++) {
					$nx = [int]($req.x1 + ($req.x2 - $req.x1) * $i / $steps)
					$ny = [int]($req.y1 + ($req.y2 - $req.y1) * $i / $steps)
					[CUInput]::SetCursorPos($nx, $ny) | Out-Null
					Start-Sleep -Milliseconds 25
				}
				Start-Sleep -Milliseconds 60
				[CUInput]::mouse_event([uint32]4, 0, 0, 0, 0)
				$resp = @{ id = $req.id; ok = $true; data = "dragged ($($req.x1),$($req.y1)) -> ($($req.x2),$($req.y2))" }
			}
			"wins" {
				$ws = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { @{ pid = $_.Id; name = $_.ProcessName; title = $_.MainWindowTitle } })
				$resp = @{ id = $req.id; ok = $true; data = $ws }
			}
			"elements" {
				# UIA 元素枚举：精准定位（Agent 用元素中心坐标点击，不再从截图猜像素）
				if ($req.pid) {
					$p = Get-Process -Id ([int]$req.pid) -ErrorAction Stop
					$h = $p.MainWindowHandle
					if ($h -eq [IntPtr]::Zero) { throw "进程 $($p.ProcessName) 没有可见窗口" }
				} else {
					$h = [CUInput]::GetForegroundWindow()
					if ($h -eq [IntPtr]::Zero) { throw "没有前台窗口" }
				}
				$root = [System.Windows.Automation.AutomationElement]::FromHandle($h)
				$clickable = @("Button","MenuItem","TabItem","CheckBox","RadioButton","Hyperlink","ListItem","TreeItem","DataItem","HeaderItem","Edit","Document","ComboBox","List","Tab","Tree","Table","Menu","ScrollBar","Slider","Spinner","SplitButton")
				$all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
				$out = @()
				for ($i = 0; $i -lt $all.Count; $i++) {
					if ($out.Count -ge 200) { break }
					$b = Get-ElBrief $all[$i] 60
					if ($null -eq $b) { continue }
					try { $c = $all[$i].Current } catch { continue }
					if ($c.IsOffscreen) { continue }
					$r = $c.BoundingRectangle
					if ($r.Width -lt 2 -or $r.Height -lt 2) { continue }
					if (-not $b.name -and ($clickable -notcontains $b.type)) { continue }
					$out += @{ i = $out.Count; type = $b.type; name = $b.name; x = [int]($r.X + $r.Width / 2); y = [int]($r.Y + $r.Height / 2); w = [int]$r.Width; h = [int]$r.Height; enabled = $c.IsEnabled }
				}
				$wb = Get-ElBrief $root 60
				$resp = @{ id = $req.id; ok = $true; data = @{ window = $wb; count = $out.Count; total = $all.Count; elements = $out } }
			}
			"focus" {
				$p = Get-Process -Id ([int]$req.pid) -ErrorAction Stop
				$h = $p.MainWindowHandle
				if ($h -eq [IntPtr]::Zero) { throw "进程 $($p.ProcessName) 没有可见窗口" }
				# 策略1：Alt 键模拟解锁前台锁 + SetForegroundWindow
				[CUInput]::keybd_event(0x12, 0, 0, 0)
				[CUInput]::keybd_event(0x12, 0, 2, 0)
				Start-Sleep -Milliseconds 40
				[CUInput]::ShowWindow($h, 9) | Out-Null
				[CUInput]::SetForegroundWindow($h) | Out-Null
				Start-Sleep -Milliseconds 150
				$ok = ([CUInput]::GetForegroundWindow() -eq $h)
				# 策略2：WScript.Shell AppActivate
				if (-not $ok) {
					try {
						$ws = New-Object -ComObject WScript.Shell
						$null = $ws.AppActivate($p.Id)
						Start-Sleep -Milliseconds 250
						$ok = ([CUInput]::GetForegroundWindow() -eq $h)
					} catch { }
				}
				# 策略3：最小化再还原（还原会被 Windows 授予前台权，最可靠但有视觉闪烁）
				if (-not $ok) {
					[CUInput]::ShowWindow($h, 6) | Out-Null
					Start-Sleep -Milliseconds 150
					[CUInput]::ShowWindow($h, 9) | Out-Null
					Start-Sleep -Milliseconds 300
					$ok = ([CUInput]::GetForegroundWindow() -eq $h)
				}
				$fgInfo = Get-FgInfo
				$fe = Get-FocusedEl
				$resp = @{ id = $req.id; ok = $true; data = @{ name = $p.ProcessName; pid = $p.Id; title = $p.MainWindowTitle; verified = $ok; fgPid = $fgInfo.pid; fgName = $fgInfo.name; feType = $fe.type; feName = $fe.name } }
			}
			"readfocus" {
				# 读取焦点控件文本（反撒谎：type 后程序化回读验证，比截图更可靠）
				$fe = [System.Windows.Automation.AutomationElement]::FocusedElement
				if ($null -eq $fe) { throw "没有焦点控件" }
				$b = Get-ElBrief $fe 40
				$text = ""
				try {
					$vp = $fe.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
					$text = [string]$vp.Current.Value
				} catch {
					try {
						$tp = $fe.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
						$text = [string]$tp.DocumentRange.GetText(600)
					} catch { throw "该控件不支持文本读取（ValuePattern/TextPattern 都不可用）" }
				}
				if ($text.Length -gt 400) { $text = $text.Substring(0, 400) + "…(截断)" }
				$resp = @{ id = $req.id; ok = $true; data = @{ type = $b.type; name = $b.name; text = $text } }
			}
			"fg" {
				$h = [CUInput]::GetForegroundWindow()
				$p = Get-Process | Where-Object { $_.MainWindowHandle -eq $h } | Select-Object -First 1
				$resp = @{ id = $req.id; ok = $true; data = @{ pid = $p.Id; name = $p.ProcessName; title = $p.MainWindowTitle } }
			}
			"apps" {
				# 搜索本机已安装应用（开始菜单全量：桌面程序 + UWP），供 Agent 先搜再开，不许拿替代品顶替
				$q = [string]$req.q
				$all = Get-StartApps | Where-Object { $_.AppID -notlike "{*}" }
				if ($q) { $all = $all | Where-Object { $_.Name -like "*$q*" } }
				$list = @($all | Select-Object -First 40 | ForEach-Object { @{ name = $_.Name; id = $_.AppID } })
				$resp = @{ id = $req.id; ok = $true; data = $list }
			}
			"launch" {
				$id = [string]$req.id
				if ($id -like "*!*") { Start-Process "explorer.exe" "shell:AppsFolder\$id" }
				elseif ($id -like "*\*") { Start-Process $id }
				else { Start-Process "explorer.exe" "shell:AppsFolder\$id" }
				Start-Sleep -Milliseconds 500
				$resp = @{ id = $req.id; ok = $true; data = "launched: $id" }
			}
			default { throw "unknown op: $op" }
		}
	} catch {
		$resp = @{ id = $req.id; ok = $false; data = $_.Exception.Message }
	}
	[Console]::Out.WriteLine("@R@" + ($resp | ConvertTo-Json -Compress -Depth 6))
}
