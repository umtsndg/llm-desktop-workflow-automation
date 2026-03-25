import { getActiveWindow, getWindows } from '@computer-use/nut-js';

export type DesktopPerception = {
    timestamp: string;
    activeWindowTitle?: string;
    windowTitles: string[];
};

export async function getDesktopPerception(maxWindows = 12): Promise<DesktopPerception> {
    const timestamp = new Date().toISOString();

    try {
        const [active, wins] = await Promise.all([
            getActiveWindow().catch(() => null),
            getWindows().catch(() => []),
        ]);

        const activeWindowTitle = active ? await active.getTitle().catch(() => undefined) : undefined;

        const titles: string[] = [];
        for (const w of wins) {
            const t = await w.getTitle().catch(() => '');
            const trimmed = String(t ?? '').trim();
            if (!trimmed) continue;
            titles.push(trimmed);
            if (titles.length >= maxWindows) break;
        }

        return {
            timestamp,
            activeWindowTitle,
            windowTitles: titles,
        };
    } catch {
        return { timestamp, windowTitles: [] };
    }
}
