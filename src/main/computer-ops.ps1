# OpenPi P56: OS-level computer-use ops (called from computer-tools.mjs)
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File computer-ops.ps1 <op> [args...]
# Ops: list_windows | screenshot <out.png> | click <x> <y> [left|right|double] | type <text> | key <keys> | activate <pid>
param(
	[string]$op,
	[string]$a1,
	[string]$a2,
	[string]$a3,
	[string]$a4
)
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Native {
	[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
	[DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, int dwExtraInfo);
	[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
	[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
	[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
	[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);
	public const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004, RIGHTDOWN = 0x0008, RIGHTUP = 0x0010;
	public const uint KEYUP = 0x0002, EXTENDEDKEY = 0x0001;
	public static void TapRight() { keybd_event(0x27, 0, EXTENDEDKEY, 0); keybd_event(0x27, 0, EXTENDEDKEY | KEYUP, 0); }
	public static void ShiftDown() { keybd_event(0x10, 0, 0, 0); }
	public static void ShiftUp() { keybd_event(0x10, 0, KEYUP, 0); }
}
"@

function Fail($msg) { Write-Output ("ERR " + $msg); exit 1 }

switch ($op) {
	"list_windows" {
		$wins = Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object {
			[PSCustomObject]@{ pid = $_.Id; name = $_.ProcessName; title = $_.MainWindowTitle }
		}
		$out = @($wins) | ConvertTo-Json -Compress -Depth 3
		if (-not $wins) { $out = "[]" }
		Write-Output ("OK " + $out)
	}
	"screenshot" {
		if (-not $a1) { Fail "screenshot 需要输出路径" }
		$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
		$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
		$g = [System.Drawing.Graphics]::FromImage($bmp)
		$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
		$g.Dispose()
		$bmp.Save($a1, [System.Drawing.Imaging.ImageFormat]::Png)
		$dim = "$($bmp.Width)x$($bmp.Height)"
		$bmp.Dispose()
		Write-Output ("OK " + $dim + " saved=" + $a1)
	}
	"click" {
		$x = [int]$a1; $y = [int]$a2
		if ($x -le 0 -and $y -le 0) { Fail "click坐标无效" }
		[Native]::SetCursorPos($x, $y) | Out-Null
		Start-Sleep -Milliseconds 80
		if ($a3 -eq "right") {
			[Native]::mouse_event([Native]::RIGHTDOWN, 0, 0, 0, 0); Start-Sleep -Milliseconds 40
			[Native]::mouse_event([Native]::RIGHTUP, 0, 0, 0, 0)
		} elseif ($a3 -eq "double") {
			1..2 | ForEach-Object {
				[Native]::mouse_event([Native]::LEFTDOWN, 0, 0, 0, 0); Start-Sleep -Milliseconds 40
				[Native]::mouse_event([Native]::LEFTUP, 0, 0, 0, 0); Start-Sleep -Milliseconds 60
			}
		} else {
			[Native]::mouse_event([Native]::LEFTDOWN, 0, 0, 0, 0); Start-Sleep -Milliseconds 40
			[Native]::mouse_event([Native]::LEFTUP, 0, 0, 0, 0)
		}
		Write-Output "OK clicked $x,$y"
	}
	"type" {
		if ($null -eq $a1 -or $a1 -eq "") { Fail "type 需要文本" }
		Set-Clipboard -Value $a1
		Start-Sleep -Milliseconds 150
		[System.Windows.Forms.SendKeys]::SendWait("^v")
		Start-Sleep -Milliseconds 150
		Write-Output ("OK typed " + $a1.Length + " chars (clipboard+paste)")
	}
	"key" {
		if (-not $a1) { Fail "key 需要按键" }
		# 常用键映射到 SendKeys 语法
		$map = @{ "enter"="{ENTER}"; "esc"="{ESC}"; "escape"="{ESC}"; "tab"="{TAB}"; "backspace"="{BACKSPACE}"; "delete"="{DEL}"; "del"="{DEL}";
			"home"="{HOME}"; "end"="{END}"; "pgup"="{PGUP}"; "pgdn"="{PGDN}"; "up"="{UP}"; "down"="{DOWN}"; "left"="{LEFT}"; "right"="{RIGHT}";
			"space"=" "; "win"="^{ESC}" }
		$k = $a1.ToLower()
		if ($a1.StartsWith("^") -or $a1.StartsWith("%") -or $a1.StartsWith("+")) { $sk = $a1 }
		elseif ($map.ContainsKey($k)) { $sk = $map[$k] } elseif ($a1.Length -eq 1) { $sk = $a1 } else { Fail ("未知按键: " + $a1) }
		[System.Windows.Forms.SendKeys]::SendWait($sk)
		Write-Output "OK key sent"
	}
	"select" {
		# 真实键盘事件选择 n 个字符（SendKeys 的 shift 组合在 UWP 记事本失效）
		$n = [int]$a1
		if ($n -le 0) { Fail "select 数量无效" }
		for ($i = 0; $i -lt $n; $i++) {
			[Native]::ShiftDown()
			[Native]::TapRight()
			Start-Sleep -Milliseconds 15
			[Native]::ShiftUp()
			Start-Sleep -Milliseconds 15
		}
		Write-Output ("OK selected " + $n + " chars")
	}
	"activate" {
		$p = Get-Process -Id ([int]$a1) -ErrorAction SilentlyContinue
		if (-not $p -or $p.MainWindowHandle -eq 0) { Fail "找不到目标窗口" }
		$h = $p.MainWindowHandle
		[Native]::ShowWindow($h, 9) | Out-Null  # SW_RESTORE
		# Windows 前台锁定 workaround：先模拟 ALT 按下/释放解除前台锁，再切前台
		[Native]::keybd_event(0x12, 0, 0, 0)
		[Native]::SetForegroundWindow($h) | Out-Null
		[Native]::keybd_event(0x12, 0, 2, 0)
		Start-Sleep -Milliseconds 400
		if ([Native]::GetForegroundWindow() -ne $h) { Fail "前台切换失败（目标窗口未能获得焦点）" }
		Write-Output ("OK activated " + $p.ProcessName)
	}
	default { Fail ("未知操作: " + $op) }
}
