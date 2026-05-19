import type { DesktopOperator } from './DesktopOperator';
import { NutJsDesktopOperator } from './NutJsDesktopOperator';
import { PeekabooDesktopOperator } from './PeekabooDesktopOperator';

export type DesktopOperatorBackend = 'auto' | 'nutjs' | 'peekaboo';

export function createDesktopOperator(backend: DesktopOperatorBackend = readBackendFromEnv()): DesktopOperator {
    if (backend === 'peekaboo') return new PeekabooDesktopOperator();
    if (backend === 'nutjs') return new NutJsDesktopOperator();

    if (process.platform === 'darwin') return new PeekabooDesktopOperator();
    return new NutJsDesktopOperator();
}

function readBackendFromEnv(): DesktopOperatorBackend {
    const raw = (process.env.DESKTOP_OPERATOR ?? 'auto').trim().toLowerCase();
    if (raw === 'peekaboo' || raw === 'mac' || raw === 'macos') return 'peekaboo';
    if (raw === 'nutjs' || raw === 'windows' || raw === 'uia') return 'nutjs';
    return 'auto';
}
