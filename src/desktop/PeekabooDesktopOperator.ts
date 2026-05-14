import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import type { DesktopOperator } from './DesktopOperator';
import type { DesktopAction, DesktopObservation, ExecutionResult, MouseButton } from './action-types';
import type { ListUiCandidatesOptions, UiCandidate } from './ui-candidates';

type PeekabooRunResult = {
    stdout: string;
    stderr: string;
};

type PeekabooCandidate = UiCandidate & {
    peekabooId?: string;
    snapshotId?: string;
};

export class PeekabooDesktopOperator implements DesktopOperator {
    private lastUiCandidates: PeekabooCandidate[] | null = null;
    private lastSnapshotId: string | null = null;

    constructor(private readonly binary = process.env.PEEKABOO_BIN || 'peekaboo') { }

    async screenshot(): Promise<DesktopObservation> {
        const path = join(tmpdir(), `llm-desktop-peekaboo-${process.pid}-${Date.now()}.png`);
        await this.runPeekaboo(['image', '--mode', 'screen', '--path', path]);

        try {
            const img = await fs.readFile(path);
            const dimensions = await readImageDimensions(img);
            const observation: DesktopObservation = {
                screenshotBase64: img.toString('base64'),
                timestamp: new Date().toISOString(),
                ...dimensions,
            };
            return observation;
        } finally {
            await fs.unlink(path).catch(() => undefined);
        }
    }

    async listUiCandidates(options: ListUiCandidatesOptions): Promise<UiCandidate[]> {
        const windowTitle = options.windowTitle.trim();
        const result = await this.runPeekabooFirstSuccessful(
            windowTitle
                ? [
                    ['see', '--json', '--app', windowTitle],
                    ['see', '--json', '--window-title', windowTitle],
                ]
                : [['see', '--json']]
        );
        const parsed = parseJsonOutput(result.stdout);
        const data = unwrapData(parsed);
        const snapshotId = readString(data, ['snapshot_id', 'snapshotId', 'id']);
        const rawElements = readArray(data, ['ui_elements', 'uiElements', 'elements']) ?? [];

        const limit = typeof options.limit === 'number' && Number.isFinite(options.limit)
            ? Math.max(1, Math.floor(options.limit))
            : 40;

        const candidates: PeekabooCandidate[] = [];
        for (const raw of rawElements) {
            const element = raw as Record<string, unknown>;
            const bbox = extractBounds(element);
            if (!bbox) continue;

            const text = firstNonEmptyString(element, [
                'label',
                'title',
                'description',
                'role_description',
                'help',
                'identifier',
                'value',
            ]);
            const role = firstNonEmptyString(element, ['role', 'role_description', 'type']) ?? '';
            const peekabooId = readString(element, ['id', 'element_id', 'elementId']);

            if (!text && !peekabooId) continue;

            const visible = readBoolean(element, ['visible', 'isVisible']) ?? true;
            const enabled = readBoolean(element, ['enabled', 'isEnabled']) ?? true;
            const roleText = role.toLowerCase();
            const typeable = roleText.includes('text') || roleText.includes('field') || roleText.includes('edit');
            const clickable =
                roleText.includes('button') ||
                roleText.includes('link') ||
                roleText.includes('menu') ||
                roleText.includes('checkbox') ||
                roleText.includes('radio') ||
                roleText.includes('tab') ||
                roleText.includes('item');

            candidates.push({
                id: candidates.length,
                role,
                text: text ?? peekabooId ?? '',
                bbox,
                enabled,
                visible,
                clickable,
                typeable,
                ...(peekabooId ? { peekabooId } : {}),
                ...(snapshotId ? { snapshotId } : {}),
                clickPoint: { x: Math.round(bbox[0] + bbox[2] / 2), y: Math.round(bbox[1] + bbox[3] / 2) },
            });

            if (candidates.length >= limit) break;
        }

        this.lastUiCandidates = candidates;
        this.lastSnapshotId = snapshotId ?? null;
        return candidates;
    }

    resolveUiCandidateClickPoint(id: number): { x: number; y: number } | null {
        const c = this.lastUiCandidates?.find((x) => x.id === id);
        if (!c) return null;
        if (c.clickPoint) return c.clickPoint;
        const [x, y, w, h] = c.bbox;
        return { x: Math.round(x + w / 2), y: Math.round(y + h / 2) };
    }

    async execute(actions: DesktopAction[]): Promise<ExecutionResult[]> {
        const results: ExecutionResult[] = [];

        for (const action of actions) {
            try {
                await this.executeOne(action);
                results.push({ ok: true, action, executedAt: new Date().toISOString() });
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

    private async executeOne(action: DesktopAction): Promise<void> {
        switch (action.type) {
            case 'typeText':
                await this.runPeekaboo(['type', action.text]);
                return;

            case 'pressKey':
                await this.runPeekaboo(['press', mapKeyForPeekaboo(action.key)]);
                return;

            case 'releaseKey':
                return;

            case 'hotkey':
                await this.runPeekaboo(['hotkey', action.keys.map(mapKeyForPeekaboo).join(',')]);
                return;

            case 'focusWindow':
                await this.runPeekabooFirstSuccessful([
                    ['window', 'focus', '--app', action.title, '--verify'],
                    ['app', 'switch', '--to', action.title, '--verify'],
                ]);
                return;

            case 'wait':
                await new Promise((resolve) => setTimeout(resolve, action.ms));
                return;

            case 'scroll':
                await this.runPeekaboo([
                    'scroll',
                    '--direction',
                    action.direction ?? 'down',
                    '--amount',
                    String(Math.max(1, Math.round(Math.abs(action.amount)))),
                ]);
                return;

            case 'launchApp':
                await this.runPeekaboo(['app', 'launch', action.command, '--wait-until-ready']);
                return;

            case 'click': {
                const coords = await this.resolveCoordinates(action.x, action.y, action.nx, action.ny);
                await this.runPeekaboo([
                    'click',
                    '--coords',
                    `${coords.x},${coords.y}`,
                    ...clickButtonArgs(action.button),
                ]);
                return;
            }

            case 'clickCandidate': {
                const c = this.lastUiCandidates?.find((x) => x.id === action.id);
                if (!c) throw new Error(`Unknown candidate id ${action.id}. Ensure candidates were listed before clicking.`);

                if (c.peekabooId) {
                    await this.runPeekaboo([
                        'click',
                        '--id',
                        c.peekabooId,
                        ...(c.snapshotId ?? this.lastSnapshotId ? ['--snapshot', c.snapshotId ?? this.lastSnapshotId!] : []),
                        ...clickButtonArgs(action.button),
                    ]);
                    return;
                }

                const pt = this.resolveUiCandidateClickPoint(action.id);
                if (!pt) throw new Error(`Unknown candidate id ${action.id}. Ensure candidates were listed before clicking.`);
                await this.runPeekaboo(['click', '--coords', `${pt.x},${pt.y}`, ...clickButtonArgs(action.button)]);
                return;
            }

            case 'uiClick':
                await this.runPeekaboo(['click', action.controlName, '--app', action.windowTitle]);
                return;

            case 'findCandidates':
                throw new Error('findCandidates is a planning-only action handled by IterativeDesktopAgent.');

            default: {
                const exhaustive: never = action;
                throw new Error(`Unhandled action: ${JSON.stringify(exhaustive)}`);
            }
        }
    }

    private async resolveCoordinates(
        x?: number,
        y?: number,
        nx?: number,
        ny?: number
    ): Promise<{ x: number; y: number }> {
        if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)) {
            return { x: Math.round(x), y: Math.round(y) };
        }

        if (typeof nx === 'number' && typeof ny === 'number' && Number.isFinite(nx) && Number.isFinite(ny)) {
            if (nx < 0 || nx > 1 || ny < 0 || ny > 1) {
                throw new Error('Normalized coordinates nx,ny must be between 0 and 1');
            }

            const obs = await this.screenshot();
            if (typeof obs.width !== 'number' || typeof obs.height !== 'number') {
                throw new Error('Screen size is unknown; cannot resolve normalized coordinates nx,ny.');
            }
            return { x: Math.round(nx * obs.width), y: Math.round(ny * obs.height) };
        }

        throw new Error('Mouse actions require either absolute x,y or normalized nx,ny coordinates.');
    }

    private runPeekaboo(args: string[]): Promise<PeekabooRunResult> {
        return new Promise((resolve, reject) => {
            const child = spawn(this.binary, args, {
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
            child.on('error', (err) => {
                reject(new Error(`Failed to run ${this.binary}: ${err.message}`));
            });
            child.on('close', (code) => {
                if (code === 0) {
                    resolve({ stdout, stderr });
                    return;
                }
                reject(new Error(`${this.binary} ${args.join(' ')} failed with code ${code}: ${stderr || stdout}`.trim()));
            });
        });
    }

    private async runPeekabooFirstSuccessful(argSets: string[][]): Promise<PeekabooRunResult> {
        let lastError: unknown;
        for (const args of argSets) {
            try {
                return await this.runPeekaboo(args);
            } catch (error) {
                lastError = error;
            }
        }

        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }
}

function parseJsonOutput(stdout: string): unknown {
    const trimmed = stdout.trim();
    if (!trimmed) throw new Error('Peekaboo returned empty JSON output.');

    try {
        return JSON.parse(trimmed);
    } catch {
        const first = trimmed.indexOf('{');
        const last = trimmed.lastIndexOf('}');
        if (first >= 0 && last > first) {
            return JSON.parse(trimmed.slice(first, last + 1));
        }
        throw new Error(`Peekaboo returned invalid JSON: ${trimmed.slice(0, 200)}`);
    }
}

function unwrapData(value: unknown): Record<string, unknown> {
    const obj = asObject(value) ?? {};
    const data = asObject(obj.data);
    return data ?? obj;
}

function extractBounds(element: Record<string, unknown>): [number, number, number, number] | null {
    const direct = readNumberArray(element, ['bbox', 'bounds', 'frame']);
    if (direct && direct.length >= 4) return [direct[0]!, direct[1]!, direct[2]!, direct[3]!];

    const boundsObj = asObject(element.bounds) ?? asObject(element.frame);
    if (!boundsObj) return null;

    const x = readNumber(boundsObj, ['x', 'X', 'minX']);
    const y = readNumber(boundsObj, ['y', 'Y', 'minY']);
    const width = readNumber(boundsObj, ['width', 'w', 'Width']);
    const height = readNumber(boundsObj, ['height', 'h', 'Height']);
    if ([x, y, width, height].every((n) => typeof n === 'number' && Number.isFinite(n))) {
        return [Math.round(x!), Math.round(y!), Math.round(width!), Math.round(height!)];
    }

    return null;
}

function asObject(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readString(obj: Record<string, unknown>, keys: string[]): string | undefined {
    for (const key of keys) {
        const value = obj[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
        if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    }
    return undefined;
}

function firstNonEmptyString(obj: Record<string, unknown>, keys: string[]): string | undefined {
    return readString(obj, keys);
}

function readBoolean(obj: Record<string, unknown>, keys: string[]): boolean | undefined {
    for (const key of keys) {
        const value = obj[key];
        if (typeof value === 'boolean') return value;
    }
    return undefined;
}

function readArray(obj: Record<string, unknown>, keys: string[]): unknown[] | undefined {
    for (const key of keys) {
        const value = obj[key];
        if (Array.isArray(value)) return value;
    }
    return undefined;
}

function readNumber(obj: Record<string, unknown>, keys: string[]): number | undefined {
    for (const key of keys) {
        const value = obj[key];
        if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return undefined;
}

function readNumberArray(obj: Record<string, unknown>, keys: string[]): number[] | undefined {
    for (const key of keys) {
        const value = obj[key];
        if (!Array.isArray(value)) continue;
        const nums = value.map((n) => Number(n));
        if (nums.length >= 4 && nums.every((n) => Number.isFinite(n))) return nums;
    }
    return undefined;
}

function clickButtonArgs(button?: MouseButton): string[] {
    if (button === 'right') return ['--right'];
    return [];
}

function mapKeyForPeekaboo(key: string): string {
    const k = key.toLowerCase().replace(/\s+/g, '');
    const map: Record<string, string> = {
        enter: 'return',
        return: 'return',
        escape: 'escape',
        esc: 'escape',
        space: 'space',
        tab: 'tab',
        backspace: 'delete',
        delete: 'forward_delete',
        up: 'up',
        down: 'down',
        left: 'left',
        right: 'right',
        ctrl: 'ctrl',
        control: 'ctrl',
        cmd: 'cmd',
        command: 'cmd',
        meta: 'cmd',
        alt: 'alt',
        option: 'alt',
        shift: 'shift',
    };
    return map[k] ?? k;
}

async function readImageDimensions(img: Buffer): Promise<{ width?: number; height?: number }> {
    try {
        const mod = await import('sharp');
        const meta = await mod.default(img).metadata();
        return {
            ...(typeof meta.width === 'number' ? { width: meta.width } : {}),
            ...(typeof meta.height === 'number' ? { height: meta.height } : {}),
        };
    } catch {
        return {};
    }
}
