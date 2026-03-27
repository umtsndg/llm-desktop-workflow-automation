import {
    mouse,
    keyboard,
    Button,
    straightTo,
    Point,
    getWindows,
    Key,
} from '@computer-use/nut-js';
import screenshot from 'screenshot-desktop';
import { spawn } from 'node:child_process';

import { resolveKey } from './supported-keys';

import type {
    DesktopAction,
    DesktopObservation,
    ExecutionResult,
    MouseButton,
} from './action-types';
import type { DesktopOperator } from './DesktopOperator';

const buttonMap: Record<MouseButton, Button> = {
    left: Button.LEFT,
    right: Button.RIGHT,
    middle: Button.MIDDLE,
};

const SIMPLE_CHAR_KEY_MAP: Record<string, { key: Key; shift?: boolean }> = {
    // Letters
    a: { key: Key.A }, A: { key: Key.A, shift: true },
    b: { key: Key.B }, B: { key: Key.B, shift: true },
    c: { key: Key.C }, C: { key: Key.C, shift: true },
    d: { key: Key.D }, D: { key: Key.D, shift: true },
    e: { key: Key.E }, E: { key: Key.E, shift: true },
    f: { key: Key.F }, F: { key: Key.F, shift: true },
    g: { key: Key.G }, G: { key: Key.G, shift: true },
    h: { key: Key.H }, H: { key: Key.H, shift: true },
    i: { key: Key.I }, I: { key: Key.I, shift: true },
    j: { key: Key.J }, J: { key: Key.J, shift: true },
    k: { key: Key.K }, K: { key: Key.K, shift: true },
    l: { key: Key.L }, L: { key: Key.L, shift: true },
    m: { key: Key.M }, M: { key: Key.M, shift: true },
    n: { key: Key.N }, N: { key: Key.N, shift: true },
    o: { key: Key.O }, O: { key: Key.O, shift: true },
    p: { key: Key.P }, P: { key: Key.P, shift: true },
    q: { key: Key.Q }, Q: { key: Key.Q, shift: true },
    r: { key: Key.R }, R: { key: Key.R, shift: true },
    s: { key: Key.S }, S: { key: Key.S, shift: true },
    t: { key: Key.T }, T: { key: Key.T, shift: true },
    u: { key: Key.U }, U: { key: Key.U, shift: true },
    v: { key: Key.V }, V: { key: Key.V, shift: true },
    w: { key: Key.W }, W: { key: Key.W, shift: true },
    x: { key: Key.X }, X: { key: Key.X, shift: true },
    y: { key: Key.Y }, Y: { key: Key.Y, shift: true },
    z: { key: Key.Z }, Z: { key: Key.Z, shift: true },
    // Space and a few basic punctuation characters used in our tasks
    ' ': { key: Key.Space },
};

export class NutJsDesktopOperator implements DesktopOperator {
    private lastScreenshot: DesktopObservation | null = null;

    constructor() {
        mouse.config.autoDelayMs = 150;
        keyboard.config.autoDelayMs = 80;
    }

    private async releaseModifierKeysBestEffort(): Promise<void> {
        // NutJS can occasionally leave modifier keys logically pressed if an action
        // is interrupted or the OS focus changes mid-input. Releasing them before
        // typing prevents accidental shortcuts (e.g., Notepad Ctrl+, opens Settings).
        const keys: Key[] = [
            Key.LeftControl,
            Key.LeftShift,
            Key.LeftWin,
            // Right-side variants may not exist in all nut-js builds; guard access.
            ...(typeof (Key as any).RightControl !== 'undefined' ? [(Key as any).RightControl as Key] : []),
            ...(typeof (Key as any).RightShift !== 'undefined' ? [(Key as any).RightShift as Key] : []),
            ...(typeof (Key as any).RightWin !== 'undefined' ? [(Key as any).RightWin as Key] : []),
        ];

        for (const k of keys) {
            await keyboard.releaseKey(k).catch(() => undefined);
        }
    }

    async screenshot(): Promise<DesktopObservation> {
        const img = await screenshot({ format: 'png' });

        // Keep screenshots small to avoid blowing up LLM request size.
        // If sharp isn't installed, fall back to the original screenshot buffer.
        let optimized = img;
        let width: number | undefined;
        let height: number | undefined;
        try {
            const mod = await import('sharp');
            const sharp = mod.default;

            const meta = await sharp(img).metadata().catch(() => null);
            width = typeof meta?.width === 'number' ? meta.width : undefined;
            height = typeof meta?.height === 'number' ? meta.height : undefined;

            optimized = await sharp(img)
                .png({ compressionLevel: 9 })
                .toBuffer();
        } catch {
            // ignore
        }
        const observation: DesktopObservation = {
            screenshotBase64: optimized.toString('base64'),
            timestamp: new Date().toISOString(),
            width,
            height,
        };
        this.lastScreenshot = observation;
        return observation;
    }

    async execute(actions: DesktopAction[]): Promise<ExecutionResult[]> {
        const results: ExecutionResult[] = [];

        for (const action of actions) {
            // Log each action as it is about to be executed. Use stderr so we
            // don't interfere with callers that expect JSON on stdout.
            try {
                // JSON.stringify keeps the log compact and unambiguous.
                console.error('[Desktop] Executing action:', JSON.stringify(action));
            } catch {
                console.error('[Desktop] Executing action (unstringified):', action);
            }

            try {
                await this.executeOne(action);
                results.push({
                    ok: true,
                    action,
                    executedAt: new Date().toISOString(),
                });
            } catch (error) {
                results.push({
                    ok: false,
                    action,
                    error: error instanceof Error ? error.message : String(error),
                    executedAt: new Date().toISOString(),
                });
            }
        }

        return results;
    }

    private async resolveCoordinates(
        x?: number,
        y?: number,
        nx?: number,
        ny?: number
    ): Promise<{ x: number; y: number }> {
        if (typeof nx === 'number' && typeof ny === 'number') {
            if (nx < 0 || nx > 1 || ny < 0 || ny > 1) {
                throw new Error('Normalized coordinates nx,ny must be between 0 and 1');
            }

            let snapshot = this.lastScreenshot;
            if (!snapshot) {
                snapshot = await this.screenshot().catch(() => null as any);
            }

            const width = snapshot?.width;
            const height = snapshot?.height;
            if (!width || !height) {
                throw new Error('Screen size is unknown; cannot resolve normalized coordinates nx,ny.');
            }

            const absX = Math.round(nx * (width - 1));
            const absY = Math.round(ny * (height - 1));
            return { x: absX, y: absY };
        }

        if (typeof x === 'number' && typeof y === 'number') {
            return { x, y };
        }

        throw new Error('Mouse actions require either absolute x,y or normalized nx,ny coordinates.');
    }

    private async executeOne(action: DesktopAction): Promise<void> {
        switch (action.type) {
            case 'moveMouse': {
                const { x, y } = await this.resolveCoordinates(action.x, action.y, (action as any).nx, (action as any).ny);
                await mouse.move(straightTo(new Point(x, y)));
                return;
            }

            case 'click': {
                if (
                    typeof action.x === 'number' ||
                    typeof action.y === 'number' ||
                    typeof (action as any).nx === 'number' ||
                    typeof (action as any).ny === 'number'
                ) {
                    const { x, y } = await this.resolveCoordinates(
                        action.x,
                        action.y,
                        (action as any).nx,
                        (action as any).ny
                    );
                    await mouse.move(straightTo(new Point(x, y)));
                }

                const button = buttonMap[action.button ?? 'left'];

                if (action.double) {
                    await mouse.doubleClick(button);
                } else {
                    await mouse.click(button);
                }
                return;
            }

            case 'typeText': {
                await this.releaseModifierKeysBestEffort();
                await this.typeTextSafe(action.text, action.delayMs);
                await this.releaseModifierKeysBestEffort();
                return;
            }

            case 'pressKey': {
                const key = resolveKey(action.key);
                await keyboard.pressKey(key);
                await keyboard.releaseKey(key);
                return;
            }

            case 'releaseKey': {
                const key = resolveKey(action.key);
                await keyboard.releaseKey(key);
                return;
            }

            case 'hotkey': {
                await this.releaseModifierKeysBestEffort();
                const keys = action.keys.map(resolveKey);
                for (const key of keys) {
                    await keyboard.pressKey(key);
                }
                for (const key of [...keys].reverse()) {
                    await keyboard.releaseKey(key);
                }
                await this.releaseModifierKeysBestEffort();
                return;
            }

            case 'focusWindow': {
                const needle = action.title.toLowerCase();

                const timeoutMs = 5000;
                const pollMs = 250;
                const deadline = Date.now() + timeoutMs;

                while (true) {
                    const windows = await getWindows();
                    for (const win of windows) {
                        const title = (await win.getTitle()).toLowerCase();
                        const isMatch =
                            action.match === 'exact'
                                ? title === needle
                                : title.includes(needle);

                        if (!isMatch) continue;

                        await win.restore().catch(() => false);
                        const ok = await win.focus();
                        if (!ok) {
                            throw new Error(`Failed to focus window: ${action.title}`);
                        }
                        return;
                    }

                    if (Date.now() >= deadline) {
                        throw new Error(`Window not found: ${action.title}`);
                    }

                    await new Promise((resolve) => setTimeout(resolve, pollMs));
                }
                return;
            }

            case 'wait': {
                await new Promise((resolve) => setTimeout(resolve, action.ms));
                return;
            }

            case 'scroll': {
                const amount =
                    action.direction === 'up'
                        ? -Math.abs(action.amount)
                        : Math.abs(action.amount);

                await mouse.scrollDown(amount);
                return;
            }

            case 'launchApp': {
                spawn(action.command, action.args ?? [], {
                    detached: true,
                    stdio: 'ignore',
                    shell: true,
                }).unref();
                return;
            }

            case 'uiClick': {
                const { windowTitle, controlName, controlType } = action;

                // Special-case: in Outlook, prefer the keyboard shortcut to send mail
                // instead of relying on UI Automation, which may match the wrong
                // element when searching for a generic "Send" label.
                if (windowTitle.toLowerCase().includes('outlook') && controlName.toLowerCase() === 'send') {
                    await this.executeOne({ type: 'hotkey', keys: ['ctrl', 'enter'] } as any);
                    return;
                }

                const rect = await this.findUiElementBoundingRect(windowTitle, controlName, controlType);
                if (!rect) {
                    throw new Error(`UI element not found: windowTitle=${windowTitle}, controlName=${controlName}${controlType ? `, controlType=${controlType}` : ''}`);
                }

                const centerX = Math.round(rect.x + rect.width / 2);
                const centerY = Math.round(rect.y + rect.height / 2);

                await mouse.move(straightTo(new Point(centerX, centerY)));
                await mouse.click(buttonMap.left);
                return;
            }

            default: {
                const exhaustive: never = action;
                throw new Error(`Unhandled action: ${JSON.stringify(exhaustive)}`);
            }
        }
    }

    private async typeTextSafe(text: string, delayMs?: number): Promise<void> {
        const originalDelay = keyboard.config.autoDelayMs;
        if (typeof delayMs === 'number') {
            keyboard.config.autoDelayMs = delayMs;
        }

        // If we encounter a character we don't know how to map safely,
        // fall back to the library's generic typing for the entire string.
        for (const ch of text) {
            const mapping = SIMPLE_CHAR_KEY_MAP[ch];
            if (!mapping) {
                await keyboard.type(text);
                keyboard.config.autoDelayMs = originalDelay;
                return;
            }

            if (mapping.shift) {
                await keyboard.pressKey(Key.LeftShift).catch(() => undefined);
            }

            await keyboard.pressKey(mapping.key);
            await keyboard.releaseKey(mapping.key);

            if (mapping.shift) {
                await keyboard.releaseKey(Key.LeftShift).catch(() => undefined);
            }
        }

        keyboard.config.autoDelayMs = originalDelay;
    }

    private async findUiElementBoundingRect(
        windowTitle: string,
        controlName: string,
        controlType?: 'Button' | 'MenuItem' | 'Edit'
    ): Promise<{ x: number; y: number; width: number; height: number } | null> {
        const script = buildUiAutomationScript(windowTitle, controlName, controlType);

        const output = await runPowerShell(script).catch((err) => {
            console.error('[Desktop][UIAutomation] PowerShell error:', err instanceof Error ? err.message : String(err));
            return '';
        });

        const line = (output ?? '').trim();
        if (!line) return null;

        const parts = line.split(',').map((p) => Number(p.trim()));
        if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
            console.error('[Desktop][UIAutomation] Invalid bounding rect output:', line);
            return null;
        }

        const [x, y, width, height] = parts;
        return { x, y, width, height };
    }
}

function psStringLiteral(value: string): string {
    // Use single-quoted PowerShell string and escape embedded single quotes.
    return `'${value.replace(/'/g, "''")}'`;
}

function buildUiAutomationScript(
    windowTitle: string,
    controlName: string,
    controlType?: 'Button' | 'MenuItem' | 'Edit'
): string {
    const winTitlePs = psStringLiteral(windowTitle);
    const controlNamePs = psStringLiteral(controlName);

    const controlTypeSnippet = controlType
        ? `$ctlType = [System.Windows.Automation.ControlType]::${controlType};`
        : `$ctlType = $null;`;

    return `
Add-Type -AssemblyName UIAutomationClient | Out-Null
$winTitle = ${winTitlePs}
$controlName = ${controlNamePs}

$root = [System.Windows.Automation.AutomationElement]::RootElement
$windows = $root.FindAll(
    [System.Windows.Automation.TreeScope]::Children,
    [System.Windows.Automation.Condition]::TrueCondition
)

$window = $null
foreach ($w in $windows) {
    $name = $w.Current.Name
    if (-not [string]::IsNullOrWhiteSpace($name)) {
        if ($name -like "*${windowTitle}*") {
            $window = $w
            break
        }
    }
}

if (-not $window) { exit 1 }

${controlTypeSnippet}

$all = $window.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition
)

$elem = $null
foreach ($e in $all) {
    $n = $e.Current.Name
    if ([string]::IsNullOrWhiteSpace($n)) { continue }
    if ($n -notlike "*${controlName}*") { continue }
    $elem = $e
    break
}

if (-not $elem) { exit 2 }

$rect = $elem.Current.BoundingRectangle
if (-not $rect) { exit 3 }

"$($rect.X),$($rect.Y),$($rect.Width),$($rect.Height)"
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
            } else {
                reject(new Error(stderr || `PowerShell exited with code ${code}`));
            }
        });
    });
}