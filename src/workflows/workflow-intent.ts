export type DesktopPlatform = NodeJS.Platform;

export type KnownApp =
    | 'browser'
    | 'calculator'
    | 'chrome'
    | 'cmd'
    | 'edge'
    | 'excel'
    | 'notepad'
    | 'outlook'
    | 'powerpoint'
    | 'terminal'
    | 'textedit'
    | 'word'
    | 'vscode';

export type WorkflowAppContext = {
    kind: string;
    app: KnownApp;
    windowsCommand: string;
    macCommand: string;
    windowsWindowTitle: string;
    macWindowTitle: string;
};

export function inferAppContext(task: string): WorkflowAppContext | undefined {
    const app = detectPrimaryApp(task);
    if (!app) return undefined;
    return appContextForApp(app);
}

export function detectPrimaryApp(task: string): KnownApp | null {
    const t = task.toLowerCase();

    const checks: Array<[KnownApp, RegExp]> = [
        ['textedit', /\btext\s*edit\b|\btextedit\b/],
        ['notepad', /\bnotepad\b|\bplain\s+text\s+editor\b/],
        ['chrome', /\bgoogle\s+chrome\b|\bchrome\b/],
        ['edge', /\bmicrosoft\s+edge\b|\bedge\b/],
        ['outlook', /\boutlook\b|\be-?mail\b|\bmail\b/],
        ['excel', /\bexcel\b|\.xlsx\b/],
        ['word', /\bword\b|\.docx\b/],
        ['powerpoint', /\bpower\s*point\b|\bpowerpoint\b|\.pptx\b/],
        ['vscode', /\bvisual\s+studio\s+code\b|\bvs\s*code\b|\bvscode\b/],
        ['calculator', /\bcalculator\b|\bcalc\b/],
        ['cmd', /\bcommand\s+prompt\b|\bcmd(?:\.exe)?\b/],
        ['terminal', /\bterminal\b|\biterm\b/],
        ['browser', /\bbrowser\b|\bwebsite\b|https?:\/\//],
    ];

    for (const [app, pattern] of checks) {
        if (pattern.test(t)) return app;
    }

    return null;
}

export function detectAppFromLaunchCommand(command: string): KnownApp | null {
    const c = command.toLowerCase();
    if (/\btext\s*edit\b|\btextedit\b/.test(c)) return 'textedit';
    if (/\bnotepad(?:\.exe)?\b/.test(c)) return 'notepad';
    if (/\bgoogle\s+chrome\b|\bchrome(?:\.exe)?\b/.test(c)) return 'chrome';
    if (/\bmicrosoft\s+edge\b|\bmsedge(?:\.exe)?\b|\bedge\b/.test(c)) return 'edge';
    if (/\boutlook(?:\.exe)?\b|\bmicrosoft\s+outlook\b/.test(c)) return 'outlook';
    if (/\bexcel(?:\.exe)?\b|\bmicrosoft\s+excel\b/.test(c)) return 'excel';
    if (/\bwinword(?:\.exe)?\b|\bmicrosoft\s+word\b|\bword\b/.test(c)) return 'word';
    if (/\bpowerpnt(?:\.exe)?\b|\bmicrosoft\s+powerpoint\b|\bpowerpoint\b/.test(c)) return 'powerpoint';
    if (/\bcode(?:\.exe)?\b|\bvisual\s+studio\s+code\b/.test(c)) return 'vscode';
    if (/\bcalc(?:\.exe)?\b|\bcalculator\b/.test(c)) return 'calculator';
    if (/\bcmd(?:\.exe)?\b|\bcommand\s+prompt\b/.test(c)) return 'cmd';
    if (/\bterminal\b|\biterm\b/.test(c)) return 'terminal';
    if (/\bbrowser\b/.test(c)) return 'browser';
    return null;
}

export function commandForApp(app: KnownApp, platform: DesktopPlatform): string {
    const mac = platform === 'darwin';
    const map: Record<KnownApp, string> = {
        browser: mac ? 'Safari' : 'Microsoft Edge',
        calculator: 'Calculator',
        chrome: 'Google Chrome',
        cmd: mac ? 'Terminal' : 'Command Prompt',
        edge: 'Microsoft Edge',
        excel: mac ? 'Microsoft Excel' : 'Excel',
        notepad: mac ? 'TextEdit' : 'Notepad',
        outlook: mac ? 'Microsoft Outlook' : 'Outlook',
        powerpoint: mac ? 'Microsoft PowerPoint' : 'PowerPoint',
        terminal: mac ? 'Terminal' : 'Command Prompt',
        textedit: mac ? 'TextEdit' : 'Notepad',
        word: mac ? 'Microsoft Word' : 'Word',
        vscode: 'Visual Studio Code',
    };
    return map[app];
}

export function windowTitleForApp(app: KnownApp, platform: DesktopPlatform): string {
    const command = commandForApp(app, platform);
    if (platform === 'darwin' && command.startsWith('Microsoft ')) {
        return command.replace(/^Microsoft\s+/, '');
    }
    if (app === 'cmd' && platform !== 'darwin') return 'Command Prompt';
    return command;
}

export function inferExpectedWindowTitle(task: string, app: KnownApp | null, platform: DesktopPlatform): string | null {
    const documentTitle = extractDocumentTitle(task);
    if (documentTitle) return documentTitle;
    if (!app) return null;
    return windowTitleForApp(app, platform);
}

export function shouldReplaceLaunchCommand(
    command: string,
    recordedApp: KnownApp | null,
    preferredApp: KnownApp | null,
    platform: DesktopPlatform
): boolean {
    if (!preferredApp) return false;
    if (recordedApp) return recordedApp !== preferredApp || commandForApp(recordedApp, platform) !== command;
    return false;
}

export function shouldReplaceWindowTitle(title: string, task: string, preferredApp: KnownApp | null): boolean {
    if (!preferredApp) return false;
    if (containsDocumentName(title)) return Boolean(extractDocumentTitle(task));
    return detectAppFromLaunchCommand(title) !== null || isGenericAppTitle(title);
}

function appContextForApp(app: KnownApp): WorkflowAppContext {
    return {
        kind: appKind(app),
        app,
        windowsCommand: commandForApp(app, 'win32'),
        macCommand: commandForApp(app, 'darwin'),
        windowsWindowTitle: windowTitleForApp(app, 'win32'),
        macWindowTitle: windowTitleForApp(app, 'darwin'),
    };
}

function appKind(app: KnownApp): string {
    if (app === 'notepad' || app === 'textedit') return 'plain_text_editor';
    if (app === 'chrome' || app === 'edge' || app === 'browser') return 'browser';
    if (app === 'cmd' || app === 'terminal') return 'terminal';
    return app;
}

function extractDocumentTitle(task: string): string | null {
    const m = task.match(/([A-Za-z0-9 _.-]+)\.(xlsx|docx|pptx|txt|pdf)\b/i);
    if (!m?.[1]) return null;
    return m[1].trim();
}

function containsDocumentName(title: string): boolean {
    return /\.(xlsx|docx|pptx|txt|pdf)\b/i.test(title);
}

function isGenericAppTitle(title: string): boolean {
    return detectAppFromLaunchCommand(title) !== null;
}
