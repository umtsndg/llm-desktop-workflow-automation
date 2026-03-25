import type { DesktopAction } from '../desktop/action-types';

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function isString(value: unknown): value is string {
    return typeof value === 'string';
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(isString);
}

function isBoolean(value: unknown): value is boolean {
    return typeof value === 'boolean';
}

export function assertDesktopActions(value: unknown): DesktopAction[] {
    if (!isObject(value)) throw new Error('Expected JSON object');
    const actions = (value as any).actions;
    if (!Array.isArray(actions)) throw new Error('Expected "actions" to be an array');

    for (const action of actions) {
        if (!isObject(action)) throw new Error('Each action must be an object');
        const type = action.type;
        if (!isString(type)) throw new Error('Action.type must be a string');

        switch (type) {
            case 'moveMouse':
                if (!isNumber(action.x) || !isNumber(action.y)) throw new Error('moveMouse requires x,y numbers');
                break;

            case 'click':
                if (action.x !== undefined && !isNumber(action.x)) throw new Error('click.x must be number');
                if (action.y !== undefined && !isNumber(action.y)) throw new Error('click.y must be number');
                if (action.button !== undefined && !['left', 'right', 'middle'].includes(String(action.button))) {
                    throw new Error('click.button must be left|right|middle');
                }
                if (action.double !== undefined && typeof action.double !== 'boolean') throw new Error('click.double must be boolean');
                break;

            case 'typeText':
                if (!isString(action.text)) throw new Error('typeText requires text string');
                if (action.delayMs !== undefined && !isNumber(action.delayMs)) throw new Error('typeText.delayMs must be number');
                break;

            case 'pressKey':
                if (!isString(action.key)) throw new Error('pressKey requires key string');
                break;

            case 'releaseKey':
                if (!isString(action.key)) throw new Error('releaseKey requires key string');
                break;

            case 'hotkey':
                if (!isStringArray(action.keys) || action.keys.length === 0) throw new Error('hotkey requires non-empty keys[]');
                break;

            case 'focusWindow':
                if (!isString(action.title)) throw new Error('focusWindow requires title string');
                if (action.match !== undefined && !['contains', 'exact'].includes(String(action.match))) {
                    throw new Error('focusWindow.match must be contains|exact');
                }
                break;

            case 'wait':
                if (!isNumber(action.ms)) throw new Error('wait requires ms number');
                break;

            case 'scroll':
                if (!isNumber(action.amount)) throw new Error('scroll requires amount number');
                if (action.direction !== undefined && !['up', 'down'].includes(String(action.direction))) {
                    throw new Error('scroll.direction must be up|down');
                }
                break;

            case 'launchApp':
                if (!isString(action.command)) throw new Error('launchApp requires command string');
                if (action.args !== undefined && !isStringArray(action.args)) throw new Error('launchApp.args must be string[]');
                break;

            default:
                throw new Error(`Unsupported action type: ${type}`);
        }
    }

    return actions as DesktopAction[];
}
