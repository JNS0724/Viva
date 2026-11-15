// Domain storage port. Implementations live in memory/node; no database handle crosses this boundary.
import type { MemoryProfileScope, MemoryProfileRef } from '../memory-profile.ts'
export interface MemoryProfileProjection { scope: MemoryProfileScope; revision: number; generator: string; generatedAt: number; validUntil: number | null; refs: MemoryProfileRef[] }
export interface MemoryProfileStore {
    read(scope: MemoryProfileScope): MemoryProfileProjection | null;
    /** The caller can also complete its effect generation in this transaction. */
    save({ scope, ...projection }: MemoryProfileProjection, now: number): boolean;
    scopes(limit?: number): MemoryProfileScope[];
    invalidate(revision: number): void;
    clear(): void;
}
