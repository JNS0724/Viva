import type { MemoryScope } from '../../contracts/memory-contract.ts'
import type { MemoryInterval } from '../memory-intervals.ts'
export type MemorySemanticReference = {
    id: number;
    revision: number;
};
export type MemorySemanticProjection = MemorySemanticReference & {
    vector: Float32Array | null;
};
export interface MemorySemanticIndex {
    configure(fingerprint: string): boolean;
    version: (fingerprint: string) => number | null;
    clear(): void;
    purge(ids: readonly number[], revision: number): boolean;
    missing(fingerprint: string, authorized: readonly MemorySemanticReference[], limit?: number): {
        id: number;
        revision: number;
    }[];
    missingScoped: (fingerprint: string, scope: MemoryScope | undefined, interval: MemoryInterval, limit?: number) => {
        id: number;
        revision: number;
    }[];
    similarities(fingerprint: string, query: Float32Array, authorized: readonly MemorySemanticReference[]): {
        similarity: number;
        id: number;
        revision: number;
    }[];
    missingAfter(fingerprint: string, afterId: number, limit?: number): {
        id: number;
        revision: number;
    }[];
    put(fingerprint: string, items: readonly MemorySemanticProjection[], expectedVersion: number): number;
    searchScoped: (fingerprint: string, query: Float32Array, scope: MemoryScope | undefined, limit: number, { interval, signal, deadline, accept, }: {
        interval: MemoryInterval;
        signal?: AbortSignal;
        deadline?: number;
        accept?: (ref: MemorySemanticReference) => boolean;
    }) => Promise<{
        hits: {
            id: number;
            revision: number;
        }[];
        partial: boolean;
        skipped: boolean;
        incomplete: boolean;
    }>;
}
