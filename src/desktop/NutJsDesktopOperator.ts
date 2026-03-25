import {
    mouse,
    keyboard,
    Button,
    straightTo,
    Point,
    getWindows,
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

export class NutJsDesktopOperator implements DesktopOperator {
    constructor() {
        mouse.config.autoDelayMs = 150;
        keyboard.config.autoDelayMs = 80;
    }

    async screenshot(): Promise<DesktopObservation> {
        const img = await screenshot({ format: 'png' });

        // Keep screenshots small to avoid blowing up LLM request size.
        // If sharp isn't installed, fall back to the original screenshot buffer.
        let optimized = img;
        try {
            const mod = await import('sharp');
            const sharp = mod.default;
            optimized = await sharp(img)
                .png({ compressionLevel: 9 })
                .toBuffer();
        } catch {
            // ignore
        }
        return {
            screenshotBase64: optimized.toString('base64'),
            timestamp: new Date().toISOString(),
        };
    }

    async execute(actions: DesktopAction[]): Promise<ExecutionResult[]> {
        const results: ExecutionResult[] = [];

        for (const action of actions) {
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

    private async executeOne(action: DesktopAction): Promise<void> {
        switch (action.type) {
            case 'moveMouse': {
                await mouse.move(straightTo(new Point(action.x, action.y)));
                return;
            }

            case 'click': {
                if (typeof action.x === 'number' && typeof action.y === 'number') {
                    await mouse.move(straightTo(new Point(action.x, action.y)));
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
                if (action.delayMs) {
                    keyboard.config.autoDelayMs = action.delayMs;
                }
                await keyboard.type(action.text);
                keyboard.config.autoDelayMs = 80;
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
                const keys = action.keys.map(resolveKey);
                for (const key of keys) {
                    await keyboard.pressKey(key);
                }
                for (const key of [...keys].reverse()) {
                    await keyboard.releaseKey(key);
                }
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

            default: {
                const exhaustive: never = action;
                throw new Error(`Unhandled action: ${JSON.stringify(exhaustive)}`);
            }
        }
    }
}