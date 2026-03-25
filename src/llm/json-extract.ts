export function extractFirstJsonObject(text: string): unknown {
    // Fast path: pure JSON
    try {
        return JSON.parse(text);
    } catch {
        // continue
    }

    // Fallback: find the first top-level {...} block.
    const start = text.indexOf('{');
    if (start === -1) {
        throw new Error('No JSON object found in LLM output');
    }

    let depth = 0;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (ch === '{') depth++;
        if (ch === '}') depth--;
        if (depth === 0) {
            const candidate = text.slice(start, i + 1);
            try {
                return JSON.parse(candidate);
            } catch {
                break;
            }
        }
    }

    throw new Error('Failed to parse JSON object from LLM output');
}
