import { NutJsDesktopOperator } from './desktop/NutJsDesktopOperator';

async function main() {
    const operator = new NutJsDesktopOperator();

    const results = await operator.execute([
        {
            type: 'launchApp',
            command: 'cmd',
            args: ['/c', 'start', '""', '"C:\\Users\\UMUTS\\Desktop\\mock_employee_data.xlsx"'],
        },
        { type: 'wait', ms: 4000 },
    ]);

    console.log(results);
}

main().catch(console.error);