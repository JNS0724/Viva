// Domain storage port. Implementations live in memory/node; no database handle crosses this boundary.
export type Outcome = 'done' | 'wait' | 'retry';
export interface Effect<P = unknown> {
    kind: string;
    key: string;
    payload: P;
    generation: number;
    attempts: number;
}
/** How the effects of one kind are run: those due, all at once (a kind may join them, as reports do), each its outcome. */
export type Runner = (effects: readonly Effect[]) => Promise<ReadonlyMap<string, Outcome>>;
export interface Effects {
    queue: (kind: string, key: string, payload: unknown, dueAt?: number) => void;
    cancel: (kind: string, key: string) => void;
    finish: (kind: string, key: string) => void;
    finishGeneration: (effect: Pick<Effect, "kind" | "key" | "generation">) => boolean;
    holds: (effect: Pick<Effect, "kind" | "key" | "generation">) => boolean;
    timing(kind: string, key: string): { dueAt: number, attempts: number, generation: number } | undefined;
    get: (kind: string, key: string) => Effect | null;
    amend: (effect: Pick<Effect, "kind" | "key" | "generation">, payload: object) => boolean;
    cancelStarting: (kind: string, prefix: string) => void;
    list: () => Effect[];
    wake: () => Promise<void>;
    close(): void;
    /** How the effects of `kind` are done. */
    runs(kind: string, run: Runner, delay?: (attempts: number) => number): void;
}
export const MAX_TIMER_DELAY_MS = 2_147_483_647
