export type BBox = [number, number, number, number]; // [x, y, width, height]

export type UiCandidate = {
    id: number;
    role: string;
    text: string;
    value: string;
    bbox: BBox;
    enabled: boolean;
    visible: boolean;
    clickable: boolean;
    typeable: boolean;

    // Extra metadata that can help debugging / future selector-based replay.
    automationId?: string;
    className?: string;
    frameworkId?: string;
    controlType?: string;

    // A best-effort click point (often better than bbox center).
    clickPoint?: { x: number; y: number };
};

export type ListUiCandidatesOptions = {
    windowTitle: string;
    match?: 'contains' | 'exact';
    limit?: number;
};

export interface UiCandidateProvider {
    listUiCandidates(options: ListUiCandidatesOptions): Promise<UiCandidate[]>;
    resolveUiCandidateClickPoint(id: number): { x: number; y: number } | null;
}

export function formatCandidatesForPrompt(candidates: UiCandidate[], limit = 30): string {
    const lines: string[] = [];
    const slice = candidates.slice(0, Math.max(0, limit));

    for (const c of slice) {
        const kind = c.typeable ? 'input' : c.clickable ? 'button' : 'element';
        const safeText = (c.text ?? '').replace(/\s+/g, ' ').trim();
        const safeValue = (c.value ?? '').replace(/\s+/g, ' ').trim();
        const textPart = safeText ? `text=${JSON.stringify(safeText)}` : 'text=""';
        const valuePart = safeValue ? `value=${JSON.stringify(safeValue)}` : 'value=""';
        const bboxPart = `bbox=[${c.bbox[0]}, ${c.bbox[1]}, ${c.bbox[2]}, ${c.bbox[3]}]`;
        const statePart = `visible=${c.visible} enabled=${c.enabled}`;
        lines.push(`Candidate ${c.id}: ${kind}, ${textPart}, ${valuePart}, ${bboxPart}, ${statePart}`);
    }

    return lines.join('\n');
}

export function isUiCandidateProvider(value: unknown): value is UiCandidateProvider {
    const v = value as any;
    return Boolean(v) && typeof v.listUiCandidates === 'function' && typeof v.resolveUiCandidateClickPoint === 'function';
}
