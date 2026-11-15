// Domain storage port. Implementations live in memory/node; no database handle crosses this boundary.
import type { MemorySpan } from '../../contracts/memory-contract.ts'
export type MemoryDeleteResult = { status: 'cleared' | 'stopped' }
type Redaction = {
    sourceId: string;
    spans: readonly MemorySpan[];
};
export interface MemoryCleanup {
    queue(operation: string, id: number, ids: readonly number[], revision: number, redactions?: readonly Redaction[], questions?: readonly string[]): void;
    attempt(operation: string): MemoryDeleteResult;
    status: (operation: string) => MemoryDeleteResult;
    pending: () => number;
}
