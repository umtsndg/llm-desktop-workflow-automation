import { NutJsDesktopOperator } from './desktop/NutJsDesktopOperator';

async function main() {
    const operator = new NutJsDesktopOperator();

    const results = await operator.execute([
        { type: 'pressKey', key: 'meta' },
        { type: 'wait', ms: 800 },
        { type: 'typeText', text: 'notepad' },
        { type: 'wait', ms: 500 },
        { type: 'pressKey', key: 'enter' },
        { type: 'wait', ms: 1500 },
        { type: 'typeText', text: 'Hello from desktop operator.' },
    ]);

    console.log(results);
}

main().catch(console.error);