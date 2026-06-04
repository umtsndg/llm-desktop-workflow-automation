import { getActiveWindow, getWindows } from '@computer-use/nut-js';
import { spawn } from 'node:child_process';

export type DesktopPerception = {
    timestamp: string;
    activeWindowTitle?: string;
    windowTitles: string[];
};

const ignoredWindowTitlePatterns = [
    /^BackgroundModeTrayIconClass$/i,
    /^Notification-manager$/i,
    /^RzMonitorForegroundWindow$/i,
    /^RazerAppEngine Window$/i,
    /^SonicMapperOSD$/i,
    /^Systray-/i,
    /^VisualHostingHelper$/i,
    /^ClientVisualWindow$/i,
    /^GDI\+ Window \(.+\)$/i,
    /^OmApSvcBroker$/i,
    /^Hidden Window$/i,
    /^Microsoft OneDrive Sync Service$/i,
    /^C:\\WINDOWS\\system32\\cmd\.exe$/i,
    /^DesktopWindowXamlSource$/i,
    /^SpotifyWidgetProviderWindow$/i,
    /^MediaPlayer SMTC window\b/i,
    /^\.NET-BroadcastEventWindow\./i,
    /^SystemResourceNotifyWindow$/i,
    /^MediaContextNotificationWindow$/i,
    /^Gms-proxy$/i,
    /^Lighting-engine$/i,
    /^Appengine Background Manager$/i,
    /^Logi_Devio_MainWindow$/i,
    /^WindowToGetHandle$/i,
    /^RealtekAudioBackgroundProcessClass$/i,
    /^DDE Server Window$/i,
    /^SecurityHealthSystray$/i,
    /^\{[0-9A-F-]{36}\}$/i,
    /^CallBackWindowThread$/i,
    /^NVIDIA GeForce Overlay$/i,
    /^SpotifyLauncher$/i,
    /^Windows Giri/i,
    /^FortiTray Daemon$/i,
    /^MS_WebcheckMonitor$/i,
    /NotificationAreaIconWindowClass$/i,
    /^MiracastConnectionWindow$/i,
    /^BroadcastListenerWindow$/i,
    /^H\.NotifyIcon_[0-9a-f-]+$/i,
    /^CrossDeviceResumeWindow$/i,
    /^NvSvc$/i,
    /^Pil /i,
    /^G(?:ö|�)rev Ge(?:ç|�)i(?:ş|�)i$/i,
];

export function isIgnoredWindowTitle(title: string): boolean {
    const trimmed = title.trim();
    if (!trimmed) return true;
    return ignoredWindowTitlePatterns.some((pattern) => pattern.test(trimmed));
}

export async function getDesktopPerception(maxWindows = 12): Promise<DesktopPerception> {
    const timestamp = new Date().toISOString();

    if (process.platform === 'win32') {
        const win32 = await getWin32DesktopPerception(maxWindows).catch(() => null);
        if (win32) {
            return {
                timestamp,
                activeWindowTitle: win32.activeWindowTitle,
                windowTitles: win32.windowTitles,
            };
        }
    }

    try {
        const [active, wins] = await Promise.all([
            getActiveWindow().catch(() => null),
            getWindows().catch(() => []),
        ]);

        const activeTitle = active ? await active.getTitle().catch(() => undefined) : undefined;
        const activeWindowTitle =
            activeTitle && !isIgnoredWindowTitle(activeTitle)
                ? activeTitle
                : undefined;

        const rawTitles: string[] = [];
        for (const w of wins) {
            const t = await w.getTitle().catch(() => '');
            rawTitles.push(String(t ?? ''));
        }

        return {
            timestamp,
            activeWindowTitle,
            windowTitles: sanitizeWindowTitles(rawTitles, maxWindows),
        };
    } catch {
        return { timestamp, windowTitles: [] };
    }
}

function sanitizeWindowTitles(titles: string[], maxWindows: number): string[] {
    const out: string[] = [];
    const seenTitles = new Set<string>();

    for (const title of titles) {
        const trimmed = String(title ?? '').trim();
        if (isIgnoredWindowTitle(trimmed)) continue;

        const key = trimmed.toLocaleLowerCase();
        if (seenTitles.has(key)) continue;
        seenTitles.add(key);

        out.push(trimmed);
        if (out.length >= maxWindows) break;
    }

    return out;
}

async function getWin32DesktopPerception(maxWindows: number): Promise<Omit<DesktopPerception, 'timestamp'> | null> {
    const fetchLimit = Math.max(maxWindows * 4, 24);
    const script = buildWin32WindowEnumerationScript(fetchLimit);
    const raw = await runPowerShell(script);
    const parsed = JSON.parse(raw.trim()) as { activeWindowTitle?: unknown; windowTitles?: unknown };

    const active =
        typeof parsed.activeWindowTitle === 'string' && !isIgnoredWindowTitle(parsed.activeWindowTitle)
            ? parsed.activeWindowTitle.trim()
            : undefined;

    const rawTitles = Array.isArray(parsed.windowTitles)
        ? parsed.windowTitles.map((title) => String(title ?? ''))
        : [];

    return {
        activeWindowTitle: active,
        windowTitles: sanitizeWindowTitles(rawTitles, maxWindows),
    };
}

function buildWin32WindowEnumerationScript(limit: number): string {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));

    return `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class CodexWin32WindowEnum {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetShellWindow();

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", SetLastError=true)]
    public static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("dwmapi.dll")]
    public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out int pvAttribute, int cbAttribute);

    public const uint GW_OWNER = 4;
    public const int DWMWA_CLOAKED = 14;

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    public static string GetTitle(IntPtr hWnd) {
        int len = GetWindowTextLength(hWnd);
        if (len <= 0) return "";
        var sb = new StringBuilder(len + 1);
        GetWindowText(hWnd, sb, sb.Capacity);
        return sb.ToString();
    }

    public static bool IsCloaked(IntPtr hWnd) {
        int cloaked = 0;
        try {
            int hr = DwmGetWindowAttribute(hWnd, DWMWA_CLOAKED, out cloaked, 4);
            return hr == 0 && cloaked != 0;
        } catch {
            return false;
        }
    }
}
"@ | Out-Null

$limit = ${safeLimit}
$shell = [CodexWin32WindowEnum]::GetShellWindow()
$activeTitle = [CodexWin32WindowEnum]::GetTitle([CodexWin32WindowEnum]::GetForegroundWindow()).Trim()
$items = New-Object System.Collections.ArrayList

[CodexWin32WindowEnum]::EnumWindows({
    param([IntPtr]$hWnd, [IntPtr]$lParam)

    if ($hWnd -eq [IntPtr]::Zero) { return $true }
    if ($hWnd -eq $shell) { return $true }
    if (-not [CodexWin32WindowEnum]::IsWindowVisible($hWnd)) { return $true }
    if ([CodexWin32WindowEnum]::GetWindow($hWnd, [CodexWin32WindowEnum]::GW_OWNER) -ne [IntPtr]::Zero) { return $true }
    if ([CodexWin32WindowEnum]::IsCloaked($hWnd)) { return $true }

    $rect = New-Object CodexWin32WindowEnum+RECT
    if (-not [CodexWin32WindowEnum]::GetWindowRect($hWnd, [ref]$rect)) { return $true }

    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    if (-not [CodexWin32WindowEnum]::IsIconic($hWnd) -and ($width -lt 160 -or $height -lt 100)) { return $true }

    $title = [CodexWin32WindowEnum]::GetTitle($hWnd).Trim()
    if ([string]::IsNullOrWhiteSpace($title)) { return $true }

    [void]$items.Add($title)
    return $items.Count -lt $limit
}, [IntPtr]::Zero) | Out-Null

[pscustomobject]@{
    activeWindowTitle = $activeTitle
    windowTitles = @($items)
} | ConvertTo-Json -Depth 3 -Compress
`.trim();
}

function runPowerShell(script: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn('powershell', ['-NoProfile', '-Command', script], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (data) => {
            stdout += data.toString();
        });
        child.stderr.on('data', (data) => {
            stderr += data.toString();
        });
        child.on('error', (err) => reject(err));
        child.on('close', (code) => {
            if (code === 0) {
                resolve(stdout);
                return;
            }
            reject(new Error(stderr.trim() || `PowerShell exited with code ${code ?? 'unknown'}`));
        });
    });
}
