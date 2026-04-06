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
                if (!isStringArray(action.keys) || action.keys.length === 0) throw new Error('hotkey requires non-empty keys string[]');
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
                if (action.args !== undefined && !Array.isArray(action.args)) throw new Error('launchApp.args must be string[]');
                if (Array.isArray(action.args) && !action.args.every(isString)) throw new Error('launchApp.args must be string[]');
                if (action.mode !== undefined) {
                    const allowedModes = ['shell', 'search'];
                    if (!allowedModes.includes(String(action.mode))) {
                        throw new Error('launchApp.mode must be shell|search when provided');
                    }
                }
                break;

            case 'click': {
                if (action.button !== undefined && !['left', 'right', 'middle'].includes(String(action.button))) {
                    throw new Error('click.button must be left|right|middle when provided');
                }

                const hasAbs = isNumber(action.x) && isNumber(action.y);
                const hasNorm = isNumber(action.nx) && isNumber(action.ny);

                if (!hasAbs && !hasNorm) {
                    throw new Error('click requires either (x,y) absolute coordinates or (nx,ny) normalized coordinates');
                }
                break;
            }

            case 'uiClick': {
                if (!isString(action.windowTitle) || !action.windowTitle.trim()) {
                    throw new Error('uiClick requires non-empty windowTitle string');
                }
                if (!isString(action.controlName) || !action.controlName.trim()) {
                    throw new Error('uiClick requires non-empty controlName string');
                }
                if (action.automationId !== undefined && !isString(action.automationId)) {
                    throw new Error('uiClick.automationId must be string when provided');
                }
                if (action.className !== undefined && !isString(action.className)) {
                    throw new Error('uiClick.className must be string when provided');
                }
                if (action.intent !== undefined) {
                    const allowedIntents = ['Any', 'Text', 'Button', 'ListItem', 'CheckBox', 'ComboBox', 'Tab', 'Window'];
                    if (!allowedIntents.includes(String(action.intent))) {
                        throw new Error('uiClick.intent must be one of Any|Text|Button|ListItem|CheckBox|ComboBox|Tab|Window when provided');
                    }
                }
                if (action.allowPartialName !== undefined && !isBoolean(action.allowPartialName)) {
                    throw new Error('uiClick.allowPartialName must be boolean when provided');
                }
                if (action.requireKeyboardFocusable !== undefined && !isBoolean(action.requireKeyboardFocusable)) {
                    throw new Error('uiClick.requireKeyboardFocusable must be boolean when provided');
                }
                if (action.wantToText !== undefined && !isBoolean(action.wantToText)) {
                    throw new Error('uiClick.wantToText must be boolean when provided');
                }
                break;
            }

            default:
                if (type === 'screenshot' || type === 'perception') {
                    throw new Error(
                        `Unsupported action type: ${type}. Screenshots/perception must be requested via toolRequests (e.g. {"toolRequests":[{"type":"${type}"}]}), not emitted as DesktopAction.`
                    );
                }
                if (type === 'toolRequests') {
                    throw new Error(
                        'Unsupported action type: toolRequests. toolRequests must be a TOP-LEVEL field (e.g. {"actions":[],"toolRequests":[{"type":"screenshot"}]}), not an item inside actions.'
                    );
                }
                throw new Error(`Unsupported action type: ${type}`);
        }
    }

    return actions as DesktopAction[];
}
