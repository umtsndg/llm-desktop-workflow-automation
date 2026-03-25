import { NutJsDesktopOperator } from './desktop/NutJsDesktopOperator';

async function main() {
    const operator = new NutJsDesktopOperator();

    const results = await operator.execute([
        { type: 'launchApp', command: 'notepad' },
        { type: 'wait', ms: 1200 },
        { type: 'focusWindow', title: 'Notepad', match: 'contains' },
        { type: 'wait', ms: 200 },
        { type: 'typeText', text: 'Hello from desktop operator.' },
    ]);

    console.log(results);
}

main().catch(console.error);