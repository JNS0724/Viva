// Domain storage port. Implementations live in memory/node; no database handle crosses this boundary.
import type { MemoryScope } from '../../contracts/memory-contract.ts'
import type { MemoryInterval } from '../memory-intervals.ts'
export type MemoryIndexHit = {
    id: number;
    revision: number;
};
export type MemoryIndexResult = {
    hits: MemoryIndexHit[];
    truncated: boolean;
};
export interface MemoryIndex {
    search: (query: string, scope: MemoryScope | undefined, limit: number, interval?: MemoryInterval, reader?: "recall" | "context") => MemoryIndexResult | null;
    refresh: () => boolean;
    refreshBatch: () => boolean;
    pending: () => boolean;
    purge: (ids: readonly number[], revision: number) => boolean;
    rebuild(): boolean;
}
