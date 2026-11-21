// test/unit/prefetchCacheBytes.test.ts
// The prefetch cache holds lyrics as raw strings: a count-only cap of 200 cannot bound memory when
// a few lyrics are very long. Guard that the byte budget exists and that EVERY direct mutation of
// the cache keeps the running byte total in sync - otherwise the counter drifts and eviction stops
// doing anything, which is worse than no cap at all.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '../../src/services/prefetchService.ts');
const src = readFileSync(SRC, 'utf8');

describe('prefetch cache byte budget', () => {
    it('declares both a count cap and a byte cap', () => {
        expect(src).toMatch(/const MAX_PREFETCH_CACHE_SIZE = \d+/);
        expect(src).toMatch(/const MAX_PREFETCH_CACHE_BYTES = \d+ \* 1024 \* 1024/);
        expect(src).toContain('estimatePrefetchBytes');
    });

    it('all insert/delete/clear paths go through the byte-aware helper or adjust the counter', () => {
        // The shared helper is the only place that may add a plain .set without touching the counter.
        expect(src).toContain('const setPrefetchCacheEntry');
        expect(src).toContain('prefetchCacheBytes += bytes');
        expect(src).toContain('prefetchCacheBytes -= estimatePrefetchBytes');
        expect(src).toContain('prefetchCacheBytes > MAX_PREFETCH_CACHE_BYTES');
        // The three direct mutations that bypass the helper must each adjust the total.
        expect(src).toContain('prefetchCache.clear();\n    prefetchCacheBytes = 0;');
        const deleteCount = (src.match(/prefetchCache\.delete\(/g) ?? []).length;
        const subtractCount = (src.match(/prefetchCacheBytes -=/g) ?? []).length;
        // helper delete + helper evict + cleanup delete = 3; the first two subtract via `existing`/`oldest`.
        expect(deleteCount).toBeGreaterThanOrEqual(3);
        expect(subtractCount).toBeGreaterThanOrEqual(3);
    });

    it('eviction is least-recently-used (inserts delete then set, refreshing recency)', () => {
        expect(src).toContain('prefetchCache.delete(songKey);\n    prefetchCache.set(songKey, data);');
        expect(src).toContain('const oldestKey = prefetchCache.keys().next().value;');
    });
});
