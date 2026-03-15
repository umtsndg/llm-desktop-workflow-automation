import {
    mouse,
    keyboard,
    Button,
    Key,
    straightTo,
    Point,
} from '@computer-use/nut-js';
import screenshot from 'screenshot-desktop';
import { spawn } from 'node:child_process';

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

const keyMap: Record<string, Key> = {
    enter: Key.Enter,
    tab: Key.Tab,
    escape: Key.Escape,
    esc: Key.Escape,
    space: Key.Space,
    backspace: Key.Backspace,
    delete: Key.Delete,
    up: Key.Up,
    down: Key.Down,
    left: Key.Left,
    right: Key.Right,
    a: Key.A,
    b: Key.B,
    c: Key.C,
    d: Key.D,
    e: Key.E,
    f: Key.F,
    g: Key.G,
    h: Key.H,
    i: Key.I,
    j: Key.J,
    k: Key.K,
    l: Key.L,
    m: Key.M,
    n: Key.N,
    o: Key.O,
    p: Key.P,
    q: Key.Q,
    r: Key.R,
    s: Key.S,
    t: Key.T,
    u: Key.U,
    v: Key.V,
    w: Key.W,
    x: Key.X,
    y: Key.Y,
    z: Key.Z,
    ctrl: Key.LeftControl,
    alt: Key.LeftAlt,
    shift: Key.LeftShift,
    meta: Key.LeftWin,
};

function resolveKey(name: string): Key {
    const key = keyMap[name.toLowerCase()];
    if (!key) {
        throw new Error(`Unsupported key: ${name}`);
    }
    return key;
}

export class NutJsDesktopOperator implements DesktopOperator {
    constructor() {
        mouse.config.autoDelayMs = 150;
        keyboard.config.autoDelayMs = 80;
    }

    async screenshot(): Promise<DesktopObservation> {
        const img = await screenshot({ format: 'png' });
        return {
            screenshotBase64: img.toString('base64'),
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