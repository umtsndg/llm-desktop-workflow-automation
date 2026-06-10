import { getDesktopPerception } from './src/desktop/perception';

async function main() {
    const perception = await getDesktopPerception();
    console.log(JSON.stringify(perception, null, 2));
}

main().catch(console.error);
