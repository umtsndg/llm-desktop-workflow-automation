import { Key } from '@computer-use/nut-js';

export const KEY_MAP: Record<string, Key> = {
    enter: Key.Enter,
    return: Key.Return,
    tab: Key.Tab,
    escape: Key.Escape,
    esc: Key.Escape,
    space: Key.Space,
    backspace: Key.Backspace,
    insert: Key.Insert,
    delete: Key.Delete,
    up: Key.Up,
    down: Key.Down,
    left: Key.Left,
    right: Key.Right,
    home: Key.Home,
    end: Key.End,
    pageup: Key.PageUp,
    pagedown: Key.PageDown,
    f1: Key.F1,
    f2: Key.F2,
    f3: Key.F3,
    f4: Key.F4,
    f5: Key.F5,
    f6: Key.F6,
    f7: Key.F7,
    f8: Key.F8,
    f9: Key.F9,
    f10: Key.F10,
    f11: Key.F11,
    f12: Key.F12,
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
    windowskey: Key.LeftWin,
};

export function resolveKey(name: string): Key {
    const key = KEY_MAP[name.toLowerCase()];
    if (!key) {
        throw new Error(`Unsupported key: ${name}`);
    }
    return key;
}

export function supportedKeyNames(): string[] {
    return Object.keys(KEY_MAP).sort();
}
