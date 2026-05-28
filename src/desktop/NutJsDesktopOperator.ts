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
import type { ListUiCandidatesOptions, UiCandidate } from './ui-candidates';

class PowerShellExecutionError extends Error {
    constructor(
        message: string,
        readonly exitCode: number | null,
        readonly stderr: string
    ) {
        super(message);
        this.name = 'PowerShellExecutionError';
    }
}

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
    private lastUiCandidates: UiCandidate[] | null = null;

    constructor() {
        mouse.config.autoDelayMs = 150;
        keyboard.config.autoDelayMs = 200;
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

    async listUiCandidates(options: ListUiCandidatesOptions): Promise<UiCandidate[]> {
        const maxLimit = 400;
        const limit = typeof options.limit === 'number' && Number.isFinite(options.limit) ? Math.max(1, Math.min(maxLimit, options.limit)) : 40;
        const match = options.match === 'exact' ? 'exact' : 'contains';

        const script = buildUiCandidatesScript(options.windowTitle, match, limit);
        const output = await runPowerShell(script).catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            try {
                if (err instanceof PowerShellExecutionError && err.exitCode === 2) {
                    console.error(`[Desktop][UIAutomation] Candidates window not found: ${JSON.stringify(options.windowTitle)}`);
                } else {
                    console.error('[Desktop][UIAutomation] Candidates PowerShell error:', msg);
                }
            } catch {
                // ignore logging issues
            }
            return '';
        });
        const raw = (output ?? '').trim();
        if (!raw) {
            this.lastUiCandidates = [];
            return [];
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            console.error('[Desktop][UIAutomation] Invalid candidates JSON:', raw.slice(0, 200));
            this.lastUiCandidates = [];
            return [];
        }

        if (!Array.isArray(parsed)) {
            this.lastUiCandidates = [];
            return [];
        }

        const candidates: UiCandidate[] = [];
        for (const item of parsed) {
            const o = item as any;
            const id = typeof o.id === 'number' && Number.isFinite(o.id) ? o.id : null;
            const role = typeof o.role === 'string' ? o.role : '';
            const text = typeof o.text === 'string' ? o.text : '';
            const bbox = Array.isArray(o.bbox) && o.bbox.length === 4 ? o.bbox.map((n: any) => Number(n)) : null;
            if (id === null || !bbox || bbox.some((n: number) => !Number.isFinite(n))) continue;

            const enabled = Boolean(o.enabled);
            const visible = Boolean(o.visible);
            const clickable = Boolean(o.clickable);
            const typeable = Boolean(o.typeable);

            const clickPoint =
                o.clickPoint && typeof o.clickPoint.x === 'number' && typeof o.clickPoint.y === 'number'
                    ? { x: o.clickPoint.x, y: o.clickPoint.y }
                    : undefined;

            candidates.push({
                id,
                role,
                text,
                bbox: [bbox[0], bbox[1], bbox[2], bbox[3]],
                enabled,
                visible,
                clickable,
                typeable,
                ...(typeof o.automationId === 'string' && o.automationId ? { automationId: o.automationId } : {}),
                ...(typeof o.className === 'string' && o.className ? { className: o.className } : {}),
                ...(typeof o.frameworkId === 'string' && o.frameworkId ? { frameworkId: o.frameworkId } : {}),
                ...(typeof o.controlType === 'string' && o.controlType ? { controlType: o.controlType } : {}),
                ...(clickPoint ? { clickPoint } : {}),
            });
        }

        this.lastUiCandidates = candidates;
        return candidates;
    }

    resolveUiCandidateClickPoint(id: number): { x: number; y: number } | null {
        const candidates = this.lastUiCandidates;
        if (!candidates) return null;
        const c = candidates.find((x) => x.id === id);
        if (!c) return null;
        if (c.clickPoint) return c.clickPoint;
        const [x, y, w, h] = c.bbox;
        return { x: Math.round(x + w / 2), y: Math.round(y + h / 2) };
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
            case 'findCandidates': {
                // Planning-only action: the loop agent should intercept this and
                // re-prompt with a filtered candidate list.
                throw new Error('findCandidates is a planning-only action handled by IterativeDesktopAgent.');
            }

            case 'typeText': {
                await this.releaseModifierKeysBestEffort();
                await this.typeTextSafe(action.text);
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

            case 'click': {
                const button: MouseButton = (action.button ?? 'left') as MouseButton;
                const { x, y, nx, ny } = action;

                const coords = await this.resolveCoordinates(x, y, nx, ny);

                await mouse.move(straightTo(new Point(coords.x, coords.y)));
                await mouse.click(buttonMap[button]);
                return;
            }

            case 'clickCandidate': {
                const button: MouseButton = (action.button ?? 'left') as MouseButton;
                const pt = this.resolveUiCandidateClickPoint(action.id);
                if (!pt) {
                    throw new Error(`Unknown candidate id ${action.id}. Ensure candidates were listed before clicking.`);
                }
                await mouse.move(straightTo(new Point(pt.x, pt.y)));
                await mouse.click(buttonMap[button]);
                return;
            }

            case 'launchApp': {
                if (action.mode === 'search') {
                    // Launch via Windows search: press Windows key, type the app name, then press Enter.
                    const winKey = resolveKey('windowskey');
                    await keyboard.pressKey(winKey);
                    await keyboard.releaseKey(winKey);
                    await new Promise((resolve) => setTimeout(resolve, 400));
                    await this.typeTextSafe(action.command);
                    const enterKey = resolveKey('enter');
                    await keyboard.pressKey(enterKey);
                    await keyboard.releaseKey(enterKey);
                    return;
                }

                spawn(action.command, action.args ?? [], {
                    detached: true,
                    stdio: 'ignore',
                    shell: true,
                }).unref();
                return;
            }

            case 'uiClick': {
                const {
                    windowTitle,
                    controlName,
                    automationId,
                    className,
                    intent,
                    allowPartialName,
                    requireKeyboardFocusable,
                    wantToText,
                } = action;

                if (!windowTitle || !controlName) {
                    throw new Error('uiClick requires windowTitle and controlName');
                }

                const rect = await this.findUiElementBoundingRect(
                    windowTitle,
                    controlName,
                    wantToText,
                    automationId,
                    className,
                    intent,
                    allowPartialName,
                    requireKeyboardFocusable,
                );
                if (!rect) {
                    throw new Error(`UI element not found: windowTitle=${windowTitle}, controlName=${controlName}`);
                }

                const targetX = typeof rect.clickX === 'number' ? rect.clickX : Math.round(rect.x + rect.width / 2);
                const targetY = typeof rect.clickY === 'number' ? rect.clickY : Math.round(rect.y + rect.height / 2);

                await mouse.move(straightTo(new Point(targetX, targetY)));
                await mouse.click(buttonMap.left);
                return;
            }

            default: {
                const exhaustive: never = action;
                throw new Error(`Unhandled action: ${JSON.stringify(exhaustive)}`);
            }
        }
    }

    private async typeTextSafe(text: string): Promise<void> {
        // If we encounter a character we don't know how to map safely,
        // fall back to the library's generic typing for the remaining substring.
        // (Do NOT type the entire string, otherwise we duplicate the already-typed prefix.)
        for (let i = 0; i < text.length; i++) {
            const ch = text[i] ?? '';
            const mapping = SIMPLE_CHAR_KEY_MAP[ch];
            if (!mapping) {
                await keyboard.type(text.slice(i));
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
    }

    private async findUiElementBoundingRect(
        windowTitle: string,
        controlName: string,
        wantToText?: boolean,
        automationId?: string,
        className?: string,
        intent?: 'Any' | 'Text' | 'Button' | 'ListItem' | 'CheckBox' | 'ComboBox' | 'Tab' | 'Window',
        allowPartialName?: boolean,
        requireKeyboardFocusable?: boolean,
    ): Promise<{ x: number; y: number; width: number; height: number; clickX?: number; clickY?: number } | null> {
        const script = buildUiAutomationScript(
            windowTitle,
            controlName,
            wantToText === true,
            automationId,
            className,
            intent,
            allowPartialName,
            requireKeyboardFocusable,
        );

        const output = await runPowerShell(script).catch((err) => {
            if (err instanceof PowerShellExecutionError && err.exitCode === 2) {
                console.error('[Desktop][UIAutomation] UI element not found.');
            } else {
                console.error('[Desktop][UIAutomation] PowerShell error:', err instanceof Error ? err.message : String(err));
            }
            return '';
        });

        const line = (output ?? '').trim();
        if (!line) return null;

        const parts = line.split(',').map((p) => Number(p.trim()));
        if (parts.length < 4 || parts.some((n) => !Number.isFinite(n))) {
            console.error('[Desktop][UIAutomation] Invalid bounding rect output:', line);
            return null;
        }

        const [x, y, width, height, clickX, clickY] = parts;
        const result: { x: number; y: number; width: number; height: number; clickX?: number; clickY?: number } = {
            x,
            y,
            width,
            height,
        };

        if (Number.isFinite(clickX) && Number.isFinite(clickY)) {
            result.clickX = clickX;
            result.clickY = clickY;
        }

        return result;
    }
}

function psStringLiteral(value: string): string {
    // Use single-quoted PowerShell string and escape embedded single quotes.
    return `'${value.replace(/'/g, "''")}'`;
}

function buildUiAutomationScript(
    windowTitle: string,
    controlName: string,
    wantToText?: boolean,
    automationId?: string,
    className?: string,
    intent?: 'Any' | 'Text' | 'Button' | 'ListItem' | 'CheckBox' | 'ComboBox' | 'Tab' | 'Window',
    allowPartialName?: boolean,
    requireKeyboardFocusable?: boolean,
): string {
    const winTitlePs = psStringLiteral(windowTitle);
    const controlNamePs = psStringLiteral(controlName);
    const automationIdPs = psStringLiteral(automationId ?? '');
    const classNamePs = psStringLiteral(className ?? '');

    const effectiveIntent: 'Any' | 'Text' | 'Button' | 'ListItem' | 'CheckBox' | 'ComboBox' | 'Tab' | 'Window' =
        intent ?? (wantToText ? 'Text' : 'Any');
    const intentPs = psStringLiteral(effectiveIntent);

    const effectiveAllowPartialName = allowPartialName === false ? false : true;
    const allowPartialNamePs = effectiveAllowPartialName ? '$true' : '$false';

    const effectiveRequireKeyboardFocusable =
        typeof requireKeyboardFocusable === 'boolean'
            ? requireKeyboardFocusable
            : wantToText === true;
    const requireKeyboardFocusablePs = effectiveRequireKeyboardFocusable ? '$true' : '$false';

    return `
Add-Type -AssemblyName UIAutomationClient | Out-Null

function Get-UiaSafeCurrentProperty {
    param(
        [Parameter(Mandatory)]
        [System.Windows.Automation.AutomationElement]$Element,

        [Parameter(Mandatory)]
        [string]$PropertyName
    )

    try {
        return $Element.Current.$PropertyName
    } catch {
        return $null
    }
}

function Get-UiaLegacyInfo {
    param(
        [Parameter(Mandatory)]
        [System.Windows.Automation.AutomationElement]$Element
    )

    $result = @{
        Name  = $null
        Help  = $null
        Value = $null
        Role  = $null
    }

    try {
        $pattern = $Element.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern)
        if ($pattern) {
            $result.Name  = $pattern.Current.Name
            $result.Help  = $pattern.Current.Help
            $result.Value = $pattern.Current.Value
            $result.Role  = $pattern.Current.Role
        }
    } catch {
    }

    return $result
}

function Test-UiaPatternAvailable {
    param(
        [Parameter(Mandatory)]
        [System.Windows.Automation.AutomationElement]$Element,

        [Parameter(Mandatory)]
        [ValidateSet(
            "Value",
            "Text",
            "TextEdit",
            "Invoke",
            "SelectionItem",
            "ExpandCollapse",
            "LegacyIAccessible",
            "ScrollItem",
            "Window"
        )]
        [string]$PatternName
    )

    try {
        switch ($PatternName) {
            "Value"             { return [bool]$Element.Current.IsValuePatternAvailable }
            "Text"              { return [bool]$Element.Current.IsTextPatternAvailable }
            "TextEdit"          { return [bool]$Element.Current.IsTextEditPatternAvailable }
            "Invoke"            { return [bool]$Element.Current.IsInvokePatternAvailable }
            "SelectionItem"     { return [bool]$Element.Current.IsSelectionItemPatternAvailable }
            "ExpandCollapse"    { return [bool]$Element.Current.IsExpandCollapsePatternAvailable }
            "LegacyIAccessible" { return [bool]$Element.Current.IsLegacyIAccessiblePatternAvailable }
            "ScrollItem"        { return [bool]$Element.Current.IsScrollItemPatternAvailable }
            "Window"            { return [bool]$Element.Current.IsWindowPatternAvailable }
        }
    } catch {
        return $false
    }

    return $false
}

function Get-UiaWindowByTitle {
    param(
        [string]$WindowTitle
    )

    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $windows = $root.FindAll(
        [System.Windows.Automation.TreeScope]::Children,
        [System.Windows.Automation.Condition]::TrueCondition
    )

    if ([string]::IsNullOrWhiteSpace($WindowTitle)) {
        return $root
    }

    $normalizedNeedle = $WindowTitle.Trim().ToLowerInvariant()

    $best = $null
    $bestScore = -1

    foreach ($w in $windows) {
        $name = Get-UiaSafeCurrentProperty -Element $w -PropertyName "Name"
        if ([string]::IsNullOrWhiteSpace($name)) { continue }

        $candidate = $name.Trim().ToLowerInvariant()
        $score = 0

        if ($candidate -eq $normalizedNeedle) {
            $score = 100
        } elseif ($candidate.Contains($normalizedNeedle)) {
            $score = 80
        } elseif ($normalizedNeedle.Contains($candidate) -and $candidate.Length -ge 3) {
            $score = 40
        }

        if ($score -gt $bestScore) {
            $bestScore = $score
            $best = $w
        }
    }

    if ($best) { return $best }

    foreach ($w in $windows) {
        $name = Get-UiaSafeCurrentProperty -Element $w -PropertyName "Name"
        if ([string]::IsNullOrWhiteSpace($name)) { continue }

        if ($name -match 'Outlook|Chrome|Edge|Mail|Firefox|Visual Studio|Notepad|Explorer') {
            return $w
        }
    }

    return $root
}

function Get-UiaFrameworkMode {
    param(
        [Parameter(Mandatory)]
        [System.Windows.Automation.AutomationElement]$Window
    )

    $frameworkId = Get-UiaSafeCurrentProperty -Element $Window -PropertyName "FrameworkId"
    $className   = Get-UiaSafeCurrentProperty -Element $Window -PropertyName "ClassName"
    $name        = Get-UiaSafeCurrentProperty -Element $Window -PropertyName "Name"

    $frameworkIdNorm = if ($frameworkId) { $frameworkId.ToString().Trim().ToLowerInvariant() } else { "" }
    $classNameNorm   = if ($className)   { $className.ToString().Trim().ToLowerInvariant() } else { "" }
    $nameNorm        = if ($name)        { $name.ToString().Trim().ToLowerInvariant() } else { "" }

    if ($frameworkIdNorm -eq "wpf") {
        return "WPF"
    }

    if ($frameworkIdNorm -eq "win32") {
        return "Win32"
    }

    if (
        $frameworkIdNorm -eq "chrome" -or
        $classNameNorm -match 'chrome|widgetwin|webview|edge' -or
        $nameNorm -match 'outlook'
    ) {
        return "Chrome"
    }

    return "Generic"
}

function Get-UiaElementClickablePointOrCenter {
    param(
        [Parameter(Mandatory)]
        [System.Windows.Automation.AutomationElement]$Element
    )

    $rect = $Element.Current.BoundingRectangle
    if (-not $rect -or $rect.IsEmpty) {
        return $null
    }

    try {
        $pt = $Element.GetClickablePoint()
        return [pscustomobject]@{
            X = [int][math]::Round($pt.X)
            Y = [int][math]::Round($pt.Y)
        }
    } catch {
        return [pscustomobject]@{
            X = [int][math]::Round($rect.X + ($rect.Width / 2))
            Y = [int][math]::Round($rect.Y + ($rect.Height / 2))
        }
    }
}

function Find-UiaElementUnified {
    [CmdletBinding()]
    param(
        [string]$WindowTitle,
        [string]$ControlName,
        [string]$AutomationId,
        [string]$ClassName,
        [ValidateSet("Any","Text","Button","ListItem","CheckBox","ComboBox","Tab","Window")]
        [string]$Intent = "Any",
        [switch]$AllowPartialName,
        [switch]$RequireKeyboardFocusable
    )

    $window = Get-UiaWindowByTitle -WindowTitle $WindowTitle
    $mode = Get-UiaFrameworkMode -Window $window

    $conditions = New-Object 'System.Collections.Generic.List[System.Windows.Automation.Condition]'

    if (-not [string]::IsNullOrWhiteSpace($ControlName)) {
        $conditions.Add(
            (New-Object System.Windows.Automation.PropertyCondition(
                [System.Windows.Automation.AutomationElement]::NameProperty,
                $ControlName
            ))
        )
    }

    if (-not [string]::IsNullOrWhiteSpace($AutomationId)) {
        $conditions.Add(
            (New-Object System.Windows.Automation.PropertyCondition(
                [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
                $AutomationId
            ))
        )
    }

    if (-not [string]::IsNullOrWhiteSpace($ClassName)) {
        $conditions.Add(
            (New-Object System.Windows.Automation.PropertyCondition(
                [System.Windows.Automation.AutomationElement]::ClassNameProperty,
                $ClassName
            ))
        )
    }

    $searchCondition = $null
    if ($conditions.Count -eq 0) {
        $searchCondition = [System.Windows.Automation.Condition]::TrueCondition
    } elseif ($conditions.Count -eq 1) {
        $searchCondition = $conditions[0]
    } else {
        $searchCondition = New-Object System.Windows.Automation.AndCondition($conditions.ToArray())
    }

    $scope = [System.Windows.Automation.TreeScope]::Descendants

    $candidates = $window.FindAll($scope, $searchCondition)

    if ($candidates.Count -eq 0 -and $AllowPartialName.IsPresent -and -not [string]::IsNullOrWhiteSpace($ControlName)) {
        $candidates = $window.FindAll(
            $scope,
            [System.Windows.Automation.Condition]::TrueCondition
        )
    }

    $best = $null
    $bestScore = -999999

    foreach ($e in $candidates) {
        $name         = Get-UiaSafeCurrentProperty -Element $e -PropertyName "Name"
        $helpText     = Get-UiaSafeCurrentProperty -Element $e -PropertyName "HelpText"
        $autoId       = Get-UiaSafeCurrentProperty -Element $e -PropertyName "AutomationId"
        $class        = Get-UiaSafeCurrentProperty -Element $e -PropertyName "ClassName"
        $frameworkId  = Get-UiaSafeCurrentProperty -Element $e -PropertyName "FrameworkId"
        $controlType  = Get-UiaSafeCurrentProperty -Element $e -PropertyName "ControlType"
        $enabled      = Get-UiaSafeCurrentProperty -Element $e -PropertyName "IsEnabled"
        $offscreen    = Get-UiaSafeCurrentProperty -Element $e -PropertyName "IsOffscreen"
        $focusable    = Get-UiaSafeCurrentProperty -Element $e -PropertyName "IsKeyboardFocusable"
        $hasFocus     = Get-UiaSafeCurrentProperty -Element $e -PropertyName "HasKeyboardFocus"

        $legacy       = Get-UiaLegacyInfo -Element $e
        $hasValue     = Test-UiaPatternAvailable -Element $e -PatternName "Value"
        $hasText      = Test-UiaPatternAvailable -Element $e -PatternName "Text"
        $hasTextEdit  = Test-UiaPatternAvailable -Element $e -PatternName "TextEdit"
        $hasInvoke    = Test-UiaPatternAvailable -Element $e -PatternName "Invoke"
        $hasExpand    = Test-UiaPatternAvailable -Element $e -PatternName "ExpandCollapse"
        $hasSelect    = Test-UiaPatternAvailable -Element $e -PatternName "SelectionItem"

        if ($RequireKeyboardFocusable.IsPresent -and -not $focusable) {
            continue
        }

        if ($offscreen -eq $true) {
            continue
        }

        $score = 0
        $fields = @($name, $helpText, $autoId, $class, $legacy.Name, $legacy.Help)

        if (-not [string]::IsNullOrWhiteSpace($ControlName)) {
            foreach ($f in $fields) {
                if ([string]::IsNullOrWhiteSpace($f)) { continue }

                if ($f -eq $ControlName) {
                    $score += 200
                } elseif ($AllowPartialName.IsPresent -and $f -like "*$ControlName*") {
                    $score += 80
                }
            }
        }

        if (-not [string]::IsNullOrWhiteSpace($AutomationId) -and $autoId -eq $AutomationId) {
            $score += 180
        }

        if (-not [string]::IsNullOrWhiteSpace($ClassName) -and $class -eq $ClassName) {
            $score += 120
        }

        if ($enabled)   { $score += 15 }
        if ($focusable) { $score += 20 }
        if ($hasFocus)  { $score += 10 }

        $rejectCandidate = $false

        switch ($Intent) {
            "Text" {
                $isChromeEditableGroup =
                    $mode -eq "Chrome" -and
                    $controlType -eq [System.Windows.Automation.ControlType]::Group -and
                    ($hasTextEdit -or $hasText)

                $isEditLike =
                    $hasValue -or
                    $hasText -or
                    $hasTextEdit -or
                    $controlType -eq [System.Windows.Automation.ControlType]::Edit -or
                    $controlType -eq [System.Windows.Automation.ControlType]::Document -or
                    $isChromeEditableGroup

                if (-not $isEditLike) {
                    $rejectCandidate = $true
                    break
                }

                # 🚫 Reject buttons explicitly
                if ($controlType -eq [System.Windows.Automation.ControlType]::Button) {
                    $rejectCandidate = $true
                    break
                }

                # 🚫 Reject invoke-only elements (buttons/links)
                if ($hasInvoke -and -not $hasTextEdit -and -not $hasValue -and -not $hasText) {
                    $rejectCandidate = $true
                    break
                }

                # ✅ Positive scoring
                if ($hasValue)    { $score += 80 }
                if ($hasText)     { $score += 80 }
                if ($hasTextEdit) { $score += 140 }

                if ($controlType -eq [System.Windows.Automation.ControlType]::Edit) {
                    $score += 140
                }

                if ($controlType -eq [System.Windows.Automation.ControlType]::Document) {
                    $score += 80
                }

                if ($isChromeEditableGroup) {
                    $score += 180
                }

                if ($hasFocus) {
                    $score += 40
                }

                if (-not [string]::IsNullOrWhiteSpace($class) -and $class -match 'EditorClass') {
                    $score += 80
                }

                break
            }

            "Button" {
                if ($hasInvoke) { $score += 80 }

                if ($controlType -eq [System.Windows.Automation.ControlType]::Button) {
                    $score += 140
                }

                if ($mode -eq "Chrome" -and $controlType -eq [System.Windows.Automation.ControlType]::Hyperlink) {
                    $score += 40
                }

                break
            }

            "ListItem" {
                if ($hasSelect) { $score += 70 }

                if ($controlType -eq [System.Windows.Automation.ControlType]::ListItem) {
                    $score += 130
                }

                break
            }

            "CheckBox" {
                if ($controlType -eq [System.Windows.Automation.ControlType]::CheckBox) {
                    $score += 150
                }

                break
            }

            "ComboBox" {
                if ($hasExpand) { $score += 50 }

                if ($controlType -eq [System.Windows.Automation.ControlType]::ComboBox) {
                    $score += 150
                }

                break
            }

            "Tab" {
                if ($controlType -eq [System.Windows.Automation.ControlType]::TabItem) {
                    $score += 150
                }

                break
            }

            "Window" {
                if ($controlType -eq [System.Windows.Automation.ControlType]::Window) {
                    $score += 150
                }

                break
            }

            "Any" {
                if ($hasInvoke)    { $score += 10 }
                if ($hasValue)     { $score += 10 }
                if ($hasTextEdit)  { $score += 10 }
                if ($hasSelect)    { $score += 10 }

                break
            }
        }

        # 🔥 CRITICAL LINE — THIS IS WHAT WAS MISSING
        if ($rejectCandidate) {
            continue
        }

        switch ($mode) {
            "Win32" {
                if ($controlType -eq [System.Windows.Automation.ControlType]::Edit -and $Intent -eq "Text") {
                    $score += 40
                }
                if (-not [string]::IsNullOrWhiteSpace($autoId)) {
                    $score += 20
                }
            }

            "WPF" {
                if (-not [string]::IsNullOrWhiteSpace($autoId)) {
                    $score += 30
                }
                if ($controlType -eq [System.Windows.Automation.ControlType]::Edit -and $Intent -eq "Text") {
                    $score += 30
                }
            }

            "Chrome" {
                if (($frameworkId -eq "Chrome") -or ($class -match 'Editor|Chrome|Widget')) {
                    $score += 30
                }

                if ($Intent -eq "Text") {
                    if ($controlType -eq [System.Windows.Automation.ControlType]::Group -and $hasTextEdit) {
                        $score += 70
                    }
                    if ($legacy.Name -eq $ControlName) {
                        $score += 35
                    }
                }
            }
        }

        $rect = $null
        try { $rect = $e.Current.BoundingRectangle } catch {}
        if ($rect -and -not $rect.IsEmpty) {
            if ($rect.Width -gt 1 -and $rect.Height -gt 1) {
                $score += 10
            }
        } else {
            $score -= 50
        }

        if ($score -gt $bestScore) {
            $bestScore = $score
            $best = $e
        }
    }

    if (-not $best) {
        return $null
    }

    $rect = $best.Current.BoundingRectangle
    if (-not $rect -or $rect.IsEmpty) {
        return $null
    }

    $pt = Get-UiaElementClickablePointOrCenter -Element $best

    return [pscustomobject]@{
        WindowName         = Get-UiaSafeCurrentProperty -Element $window -PropertyName "Name"
        Mode               = $mode
        Name               = Get-UiaSafeCurrentProperty -Element $best -PropertyName "Name"
        AutomationId       = Get-UiaSafeCurrentProperty -Element $best -PropertyName "AutomationId"
        ClassName          = Get-UiaSafeCurrentProperty -Element $best -PropertyName "ClassName"
        FrameworkId        = Get-UiaSafeCurrentProperty -Element $best -PropertyName "FrameworkId"
        ControlType        = (Get-UiaSafeCurrentProperty -Element $best -PropertyName "ControlType").ProgrammaticName
        IsEnabled          = Get-UiaSafeCurrentProperty -Element $best -PropertyName "IsEnabled"
        IsKeyboardFocusable= Get-UiaSafeCurrentProperty -Element $best -PropertyName "IsKeyboardFocusable"
        X                  = [int][math]::Round($rect.X)
        Y                  = [int][math]::Round($rect.Y)
        Width              = [int][math]::Round($rect.Width)
        Height             = [int][math]::Round($rect.Height)
        ClickX             = $pt.X
        ClickY             = $pt.Y
        Score              = $bestScore
    }
}

$winTitle = ${winTitlePs}
$controlName = ${controlNamePs}
$automationId = ${automationIdPs}
$className = ${classNamePs}
$intent = ${intentPs}
$allowPartialName = ${allowPartialNamePs}
$requireKeyboardFocusable = ${requireKeyboardFocusablePs}

$found = Find-UiaElementUnified -WindowTitle $winTitle -ControlName $controlName -AutomationId $automationId -ClassName $className -Intent $intent -AllowPartialName:$allowPartialName -RequireKeyboardFocusable:$requireKeyboardFocusable

if (-not $found) { exit 2 }

"$($found.X),$($found.Y),$($found.Width),$($found.Height),$($found.ClickX),$($found.ClickY)"
`.trim();
}

function buildUiCandidatesScript(windowTitle: string, match: 'contains' | 'exact', limit: number): string {
    const winTitlePs = psStringLiteral(windowTitle);
    const matchPs = psStringLiteral(match);
    const limitNum = Number.isFinite(limit) ? Math.max(1, Math.min(400, Math.round(limit))) : 40;

    return `
Add-Type -AssemblyName UIAutomationClient | Out-Null

function Get-UiaSafeCurrentProperty {
    param(
        [Parameter(Mandatory)]
        [System.Windows.Automation.AutomationElement]$Element,

        [Parameter(Mandatory)]
        [string]$PropertyName
    )

    try { return $Element.Current.$PropertyName } catch { return $null }
}

function Get-UiaLabelText {
    param(
        [Parameter(Mandatory)]
        [System.Windows.Automation.AutomationElement]$Element
    )

    try {
        $lbl = $Element.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::LabeledByProperty)
        if ($lbl -and ($lbl -is [System.Windows.Automation.AutomationElement])) {
            $n = [string](Get-UiaSafeCurrentProperty -Element $lbl -PropertyName "Name")
            if (-not [string]::IsNullOrWhiteSpace($n)) { return $n }
        }
    } catch {
    }

    return $null
}

function Test-UiaPatternAvailable {
    param(
        [Parameter(Mandatory)]
        [System.Windows.Automation.AutomationElement]$Element,

        [Parameter(Mandatory)]
        [ValidateSet("Value","Text","TextEdit","Invoke","SelectionItem","ExpandCollapse","Toggle","LegacyIAccessible")]
        [string]$PatternName
    )

    try {
        switch ($PatternName) {
            "Value"         { return [bool]$Element.Current.IsValuePatternAvailable }
            "Text"          { return [bool]$Element.Current.IsTextPatternAvailable }
            "TextEdit"      { return [bool]$Element.Current.IsTextEditPatternAvailable }
            "Invoke"        { return [bool]$Element.Current.IsInvokePatternAvailable }
            "SelectionItem" { return [bool]$Element.Current.IsSelectionItemPatternAvailable }
            "ExpandCollapse"{ return [bool]$Element.Current.IsExpandCollapsePatternAvailable }
            "Toggle"        { return [bool]$Element.Current.IsTogglePatternAvailable }
            "LegacyIAccessible" { return [bool]$Element.Current.IsLegacyIAccessiblePatternAvailable }
        }
    } catch {
        return $false
    }

    return $false
}

function Get-UiaElementClickablePointOrCenter {
    param(
        [Parameter(Mandatory)]
        [System.Windows.Automation.AutomationElement]$Element
    )

    try {
        $pt = $null
        $has = $Element.TryGetClickablePoint([ref]$pt)
        if ($has -and $pt) {
            return [pscustomobject]@{ X = [int][math]::Round($pt.X); Y = [int][math]::Round($pt.Y) }
        }
    } catch {
    }

    $rect = $null
    try { $rect = $Element.Current.BoundingRectangle } catch {}
    if ($rect -and -not $rect.IsEmpty) {
        return [pscustomobject]@{ X = [int][math]::Round($rect.X + ($rect.Width / 2)); Y = [int][math]::Round($rect.Y + ($rect.Height / 2)) }
    }

    return $null
}

function Find-UiaWindowByTitle {
    param(
        [Parameter(Mandatory)]
        [string]$Title,
        [Parameter(Mandatory)]
        [ValidateSet("contains","exact")]
        [string]$Match
    )

    function Test-TitleMatch {
        param(
            [string]$Name
        )

        if ([string]::IsNullOrWhiteSpace($Name)) { return $false }
        if ($Match -eq "exact") { return ($Name -eq $Title) }
        try { return ($Name.IndexOf($Title, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) } catch { return $false }
    }

    # Prefer the currently focused window (important when multiple Outlook windows exist).
    try {
        $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
        if ($focused) {
            $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
            $cur = $focused
            for ($k = 0; $k -lt 50 -and $cur; $k++) {
                $ct = $null
                try { $ct = (Get-UiaSafeCurrentProperty -Element $cur -PropertyName "ControlType").ProgrammaticName } catch {}
                if ([string]$ct -match 'Window') {
                    $n = [string](Get-UiaSafeCurrentProperty -Element $cur -PropertyName "Name")
                    if (Test-TitleMatch -Name $n) { return $cur }
                    break
                }
                $cur = $walker.GetParent($cur)
            }
        }
    } catch {
        # ignore
    }

    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($w in $wins) {
        $name = [string](Get-UiaSafeCurrentProperty -Element $w -PropertyName "Name")
        if ([string]::IsNullOrWhiteSpace($name)) { continue }
        if (Test-TitleMatch -Name $name) { return $w }
    }
    return $null
}

$winTitle = ${winTitlePs}
$match = ${matchPs}
$limit = ${limitNum}

$window = Find-UiaWindowByTitle -Title $winTitle -Match $match
if (-not $window) { exit 2 }

$elements = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$items = New-Object System.Collections.ArrayList

for ($i = 0; $i -lt $elements.Count; $i++) {
    $e = $elements.Item($i)
    if (-not $e) { continue }

    $enabled = [bool](Get-UiaSafeCurrentProperty -Element $e -PropertyName "IsEnabled")
    $focusable = [bool](Get-UiaSafeCurrentProperty -Element $e -PropertyName "IsKeyboardFocusable")
    $offscreen = [bool](Get-UiaSafeCurrentProperty -Element $e -PropertyName "IsOffscreen")
    $visible = -not $offscreen

    $rect = $null
    try { $rect = $e.Current.BoundingRectangle } catch {}
    if (-not $rect -or $rect.IsEmpty) { continue }
    if ($rect.Width -lt 3 -or $rect.Height -lt 3) { continue }

    $name = [string](Get-UiaSafeCurrentProperty -Element $e -PropertyName "Name")
    $help = [string](Get-UiaSafeCurrentProperty -Element $e -PropertyName "HelpText")
    $label = Get-UiaLabelText -Element $e
    $autoId = [string](Get-UiaSafeCurrentProperty -Element $e -PropertyName "AutomationId")
    $class = [string](Get-UiaSafeCurrentProperty -Element $e -PropertyName "ClassName")
    $frameworkId = [string](Get-UiaSafeCurrentProperty -Element $e -PropertyName "FrameworkId")
    $ct = $null
    try { $ct = (Get-UiaSafeCurrentProperty -Element $e -PropertyName "ControlType").ProgrammaticName } catch {}
    $controlType = [string]$ct

    $clickable = (Test-UiaPatternAvailable -Element $e -PatternName "Invoke") -or (Test-UiaPatternAvailable -Element $e -PatternName "SelectionItem") -or (Test-UiaPatternAvailable -Element $e -PatternName "ExpandCollapse") -or (Test-UiaPatternAvailable -Element $e -PatternName "Toggle") -or (Test-UiaPatternAvailable -Element $e -PatternName "LegacyIAccessible")
    $typeable = (Test-UiaPatternAvailable -Element $e -PatternName "TextEdit") -or (Test-UiaPatternAvailable -Element $e -PatternName "Text") -or (Test-UiaPatternAvailable -Element $e -PatternName "Value")

    # Outlook often doesn't expose the expected UIA patterns, so fall back to heuristics:
    # keep elements that are labeled, focusable, or have a commonly actionable role.
    $hasLabel = -not [string]::IsNullOrWhiteSpace($name) -or -not [string]::IsNullOrWhiteSpace($autoId)
    $isInterestingRole = $false
    if (-not [string]::IsNullOrWhiteSpace($controlType)) {
        $isInterestingRole = $controlType -match 'Button|Edit|Document|TabItem|MenuItem|ListItem|TreeItem|Hyperlink|ComboBox|CheckBox|RadioButton|SplitButton'
    }

    if (-not $clickable -and -not $typeable -and -not $hasLabel -and -not $focusable -and -not $isInterestingRole) { continue }

    $text = $name
    if ([string]::IsNullOrWhiteSpace($text) -and -not [string]::IsNullOrWhiteSpace($label)) { $text = $label }
    if ([string]::IsNullOrWhiteSpace($text) -and -not [string]::IsNullOrWhiteSpace($help)) { $text = $help }
    if ([string]::IsNullOrWhiteSpace($text) -and -not [string]::IsNullOrWhiteSpace($autoId)) { $text = $autoId }

    $pt = Get-UiaElementClickablePointOrCenter -Element $e

    $obj = [pscustomobject]@{
        role = $controlType
        text = $text
        bbox = @(
            [int][math]::Round($rect.X),
            [int][math]::Round($rect.Y),
            [int][math]::Round($rect.Width),
            [int][math]::Round($rect.Height)
        )
        enabled = $enabled
        visible = $visible
        focusable = $focusable
        clickable = [bool]$clickable
        typeable = [bool]$typeable
        automationId = $autoId
        className = $class
        frameworkId = $frameworkId
        controlType = $controlType
        clickPoint = $(if ($pt) { [pscustomobject]@{ x = $pt.X; y = $pt.Y } } else { $null })
    }

    [void]$items.Add($obj)
}

$ranked = $items | Sort-Object @{Expression={ if ($_.typeable) { 0 } elseif ($_.clickable) { 1 } elseif ($_.focusable) { 2 } else { 3 } }}, @{Expression={ $_.bbox[1] }}, @{Expression={ $_.bbox[0] }}
$limited = $ranked | Select-Object -First $limit

$out = @()
$id = 0
foreach ($it in $limited) {
    $out += [pscustomobject]@{ id = $id; role = $it.role; text = $it.text; bbox = $it.bbox; enabled = $it.enabled; visible = $it.visible; clickable = $it.clickable; typeable = $it.typeable; automationId = $it.automationId; className = $it.className; frameworkId = $it.frameworkId; controlType = $it.controlType; clickPoint = $it.clickPoint }
    $id++
}

$out | ConvertTo-Json -Depth 6 -Compress
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
                const exitCode = typeof code === 'number' ? code : null;
                const message = stderr.trim() || `PowerShell exited with code ${exitCode ?? 'unknown'}`;
                reject(new PowerShellExecutionError(message, exitCode, stderr));
            }
        });
    });
}
