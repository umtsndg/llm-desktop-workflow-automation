import { NutJsDesktopOperator } from './desktop/NutJsDesktopOperator';

async function main() {
    const operator = new NutJsDesktopOperator();

    const filePath = 'C:\\Users\\UMUTS\\Desktop\\mock_employee_data.xlsx';

    const results = await operator.execute([
        {
            type: 'launchApp',
            command: 'cmd',
            args: ['/c', 'start', '""', filePath],
        },

        { type: 'wait', ms: 6000 },

        // maximize Excel window
        { type: 'hotkey', keys: ['alt', 'space'] },
        { type: 'wait', ms: 500 },
        { type: 'pressKey', key: 'up' },
        { type: 'wait', ms: 300 },
        { type: 'pressKey', key: 'up' },
        { type: 'wait', ms: 300 },
        { type: 'pressKey', key: 'enter' },
        { type: 'wait', ms: 1000 },

        // click inside worksheet grid
        { type: 'click', x: 400, y: 350 },
        { type: 'wait', ms: 800 },

        // go to A1
        { type: 'hotkey', keys: ['ctrl', 'home'] },
        { type: 'wait', ms: 500 },

        // move to H1 = SalaryUSD
        { type: 'pressKey', key: 'right' },
        { type: 'pressKey', key: 'right' },
        { type: 'pressKey', key: 'right' },
        { type: 'pressKey', key: 'right' },
        { type: 'pressKey', key: 'right' },
        { type: 'pressKey', key: 'right' },
        { type: 'pressKey', key: 'right' },

        { type: 'wait', ms: 700 },

        // sort descending on current column
        { type: 'hotkey', keys: ['alt', 'a'] },
        { type: 'wait', ms: 700 },
        { type: 'pressKey', key: 's' },
        { type: 'pressKey', key: 'd' },

        { type: 'wait', ms: 1500 },
        { type: 'hotkey', keys: ['ctrl', 's'] },
    ]);

    console.log(results);
}

main().catch(console.error);