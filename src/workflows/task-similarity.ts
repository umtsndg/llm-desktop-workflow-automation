export type SimilarityOptions = {
    stopWords?: Set<string>;
};

const DEFAULT_STOP_WORDS = new Set([
    'a',
    'an',
    'and',
    'are',
    'as',
    'at',
    'be',
    'by',
    'for',
    'from',
    'has',
    'have',
    'i',
    'in',
    'is',
    'it',
    'of',
    'on',
    'or',
    'please',
    'the',
    'then',
    'to',
    'we',
    'with',
    'you',
    'your',
]);

export function tokenize(text: string, options?: SimilarityOptions): string[] {
    const stopWords = options?.stopWords ?? DEFAULT_STOP_WORDS;

    return String(text)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .split(' ')
        .map((t) => t.trim())
        .filter((t) => t.length >= 2)
        .filter((t) => !stopWords.has(t));
}

type SparseVec = Map<string, number>;

function termFreq(tokens: string[]): SparseVec {
    const m = new Map<string, number>();
    for (const t of tokens) {
        m.set(t, (m.get(t) ?? 0) + 1);
    }
    return m;
}

function l2Norm(v: SparseVec): number {
    let s = 0;
    for (const w of v.values()) s += w * w;
    return Math.sqrt(s);
}

function dot(a: SparseVec, b: SparseVec): number {
    // Iterate smaller map.
    const [small, big] = a.size <= b.size ? [a, b] : [b, a];
    let s = 0;
    for (const [k, av] of small.entries()) {
        const bv = big.get(k);
        if (bv) s += av * bv;
    }
    return s;
}

function cosine(a: SparseVec, b: SparseVec): number {
    const denom = l2Norm(a) * l2Norm(b);
    if (!denom) return 0;
    return dot(a, b) / denom;
}

function computeIdf(docTokens: string[][]): Map<string, number> {
    const df = new Map<string, number>();
    const n = docTokens.length;

    for (const tokens of docTokens) {
        const seen = new Set(tokens);
        for (const t of seen) {
            df.set(t, (df.get(t) ?? 0) + 1);
        }
    }

    const idf = new Map<string, number>();
    for (const [term, dfi] of df.entries()) {
        // Smooth IDF.
        const val = Math.log((n + 1) / (dfi + 1)) + 1;
        idf.set(term, val);
    }

    return idf;
}

function tfidf(tf: SparseVec, idf: Map<string, number>, defaultIdf: number): SparseVec {
    const out = new Map<string, number>();
    for (const [term, freq] of tf.entries()) {
        const w = freq * (idf.get(term) ?? defaultIdf);
        out.set(term, w);
    }
    return out;
}

export function tfidfCosineSimilarity(queryText: string, docText: string, corpusTexts: string[], options?: SimilarityOptions): number {
    const qTokens = tokenize(queryText, options);
    const dTokens = tokenize(docText, options);
    if (qTokens.length === 0 || dTokens.length === 0) return 0;

    const corpusTokens = corpusTexts.map((t) => tokenize(t, options)).filter((t) => t.length > 0);
    const idf = computeIdf(corpusTokens.length > 0 ? corpusTokens : [dTokens]);

    const n = corpusTokens.length > 0 ? corpusTokens.length : 1;
    const defaultIdf = Math.log((n + 1) / 1) + 1;

    const qVec = tfidf(termFreq(qTokens), idf, defaultIdf);
    const dVec = tfidf(termFreq(dTokens), idf, defaultIdf);

    return cosine(qVec, dVec);
}

export function tokenOverlapSimilarity(queryText: string, docText: string, options?: SimilarityOptions): number {
    const q = new Set(tokenize(queryText, options));
    const d = new Set(tokenize(docText, options));
    if (q.size === 0 || d.size === 0) return 0;

    let inter = 0;
    for (const t of q) if (d.has(t)) inter++;

    // Symmetric overlap (Dice coefficient).
    return (2 * inter) / (q.size + d.size);
}
