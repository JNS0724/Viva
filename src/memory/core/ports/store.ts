// Domain storage port. Implementations live in memory/node; no database handle crosses this boundary.
import type { MemoryKind, MemoryScope } from '../../contracts/memory-contract.ts'
import type { MemoryFact } from '../memory-facts.ts'
import type { MemoryInterval } from '../memory-intervals.ts'
import type { MemoryDependency, MemoryFileDependency, MemoryProvenance, MemorySource, StoredFact, MemoryCandidate, MemoryEvidence, MemoryChangeKind, MemoryChangeStatus, MemoryChange, MemoryEntry } from '../../contracts/records.ts'
export type { MemoryDependency, MemoryFileDependency, MemoryProvenance, MemorySource, StoredFact, MemoryCandidate, MemoryEvidence, MemoryChangeKind, MemoryChangeStatus, MemoryChange, MemoryEntry } from '../../contracts/records.ts'
export interface MemoryStore {
    tx: <T>(work: () => T) => T;
    revision: () => number;
    epoch: () => number;
    nextRevision: (invalidate?: boolean) => number;
    get: (id: number) => MemoryEntry | null;
    exists: (id: number) => boolean;
    list: () => MemoryEntry[];
    listForScope: (scope?: MemoryScope) => MemoryEntry[];
    recentRecallRefs: (scope: MemoryScope | undefined, interval: MemoryInterval, limit: number, contextOnly?: boolean) => Pick<MemoryEntry, "id" | "revision">[];
    relationRecallRefs: (scope: MemoryScope, label: string, interval: MemoryInterval, limit: number) => Pick<MemoryEntry, "id" | "revision">[];
    inactiveRecallRefs: (scope: MemoryScope | undefined, interval: MemoryInterval, limit: number) => Pick<MemoryEntry, "id" | "revision">[];
    profileCandidates: (scope: MemoryScope, at: number, limit: number) => Pick<MemoryEntry, "id" | "revision">[];
    nextProfileBoundary: (scope: MemoryScope, at: number) => number | null;
    modelEligible: (id: number) => boolean;
    hasPendingEnding: (interval: MemoryInterval) => boolean;
    pendingEndingsFor: (ids: readonly number[]) => MemoryChange[];
    sameText: (text: string, scope: MemoryScope) => MemoryEntry[];
    getChange: (id: number) => MemoryChange | null;
    listChanges: () => MemoryChange[];
    appliedChanges: () => MemoryChange[];
    changesFor: (id: number) => MemoryChange[];
    recordChange: (change: Omit<MemoryChange, "id" | "status" | ("intentWindows" | "oldValueSpans" | "needsConfirmation" | "derivedFrom")> & Partial<Pick<MemoryChange, "intentWindows" | "oldValueSpans" | "needsConfirmation" | "derivedFrom">>) => number;
    setChangeStatus: (id: number, status: MemoryChangeStatus, revision: number) => void;
    projectChange: (id: number, interval: MemoryInterval, needsConfirmation: boolean, revision: number) => void;
    reviseDispute: (id: number, interval: MemoryInterval, revision: number) => void;
    readSource: (id: string) => MemorySource | null;
    insertSource: (source: MemorySource) => void;
    outcome: (id: string, state: string) => void;
    withdrawSource: (id: string) => void;
    evidence: (memory: number, source: MemorySource, start: number, end: number, parts: MemoryFact["evidence"] | null, changeId: number | null, interval: MemoryInterval, spans: MemoryEvidence["spans"], inheritsChangeTime?: boolean) => number | bigint;
    storedEvidence: (id: number) => MemoryEvidence[];
    removeEvidence: (memory: number, source: string, start: number, end: number) => void;
    bindEvidenceChange: (memory: number, source: string, start: number, end: number, changeId: number, parts: MemoryFact["evidence"] | null) => void;
    updateEvidenceSpans: (memory: number, edge: MemoryEvidence, spans: MemoryEvidence["spans"]) => void;
    redactSource: (source: string, text: string) => void;
    clearSourceQuestions: () => string[];
    insert: (entry: Pick<MemoryEntry, "text" | "kind" | "scope" | "modality" | "conditional" | "keywords" | "source" | "conversationId">, rev: number, at: number, interval: MemoryInterval) => number;
    setAssertion: (id: number, interval: MemoryInterval, text: string, details: Pick<MemoryEntry, "keywords" | "scope" | "conditional" | "modality">) => void;
    project: (id: number, data: Pick<MemoryEntry, "state" | "text" | "windows" | "invalidAt" | "invalidatedBy">, revision: number) => void;
    touch: (id: number, revision: number) => void;
    authorize: (id: number, revision: number) => void;
    remove: (id: number) => void;
    forgetEntry: (id: number, revision: number) => void;
    restoreEntry: (id: number, revision: number) => void;
    recordFact: (id: number, fact: MemoryFact) => void;
    setKeywords: (id: number, words: readonly string[]) => void;
    touchChange: (id: number, revision: number) => void;
    exclude: (text: string, scope: MemoryScope) => void;
    excluded: (text: string, scope?: MemoryScope, authorizedRevision?: number) => boolean;
    sourceExcluded: (id: string) => boolean;
    excludeSource: (id: string) => void;
    sourceIds: (conversation: string) => string[];
    answerSourceIds: (conversation: string, request: string) => string[];
    memoriesFrom: (source: string) => number[];
    changesFrom: (source: string) => MemoryChange[];
    changesReferencing: (id: number) => MemoryChange[];
    hasChangeSource: (id: string) => boolean;
    deliveredSourceIds: (conversation: string) => string[];
    deliveredSource: (id: string) => {
        conversation: string;
        derived: number;
    } | undefined;
    recordDeliveredSource: (id: string, conversation: string, derived: boolean) => void;
    dispatch: {
        /** Only after a durable host context replacement, under the owner send fence. */
        replace(session: string, sources: readonly string[]): void;
        dependencies(session: string, dependencies: readonly MemoryDependency[]): void;
        files(session: string, files: readonly MemoryFileDependency[], sources?: readonly string[]): void;
        source: (session: string, source: string) => void;
        turnOnly: (session: string) => void;
        snapshot(session: string): MemoryProvenance;
    };
    priorSources: (source: MemorySource) => Array<{
        id: string;
        text: string;
    }>;
    candidate: (source: string, start: number, end: number, proposal: object, reason: string) => void;
    expire: (retainSource?: (id: string) => boolean) => void;
    clearCandidates: (id: string) => void;
    discardUnused: (id: string) => void;
    compactSource: (id: string) => void;
    nextCandidateExpiry: () => number | null;
    candidatesReferencing: (id: number) => MemoryCandidate[];
    hasCandidateReference: (id: number) => boolean;
    removeCandidate: ({ sourceId, start, end }: MemoryCandidate) => void;
    pendingChanges: (at: number) => MemoryCandidate[];
    recallPendingChanges: (at: number, scope: MemoryScope | undefined, limit: number) => MemoryCandidate[];
    pendingChange: (at: number, ref: Pick<MemoryCandidate, "sourceId" | "start" | "end">) => MemoryCandidate | undefined;
    sessionEpoch: (id: string) => number;
    recordSession: (id: string) => void;
    sessionProject: (id: string) => string | undefined;
    recordSessionProject: (id: string, project: string) => void;
    meta: (key: string) => string | undefined;
    setMeta: (key: string, value: string) => void;
    profile: () => {
        [k: string]: {
            value: string;
            updatedAt: number;
            revision: number;
            source: string;
        };
    };
    setProfile: (fields: Record<string, string>) => {
        [k: string]: {
            value: string;
            updatedAt: number;
            revision: number;
            source: string;
        };
    };
    command: (key: string) => {
        kind: string;
        payload: string;
        result: number | null;
    } | undefined;
    recordCommand: (key: string, kind: string, payload: string, result: number | null) => void;
    close(): void;
}
