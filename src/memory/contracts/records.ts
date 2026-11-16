import type { TextSpan } from './text-spans.ts'

import type { MemoryKind, MemoryScope } from './memory-contract.ts'
import type { MemoryFact, MemoryInterval } from './facts.ts'
export type MemoryDependency = {
    id: number;
    revision: number;
    asOf?: string;
    asOfZone?: string;
    disputed?: boolean;
    expiresAt?: number;
    collectionRevision?: number;
};
/** Exact accepted file/policy snapshot carried by every derived request. */
export type MemoryFileDependency = {
    workspace: string;
    id: string;
    path: string;
    revision: string;
    usageVersion: number;
    policyToken: string;
    /** Body-free evidence of this accepted projection, retained even after it changes. */
    sourceRanges?: Array<{ sourceId: string; spans?: TextSpan[] }>;
};
export type MemoryProvenance = {
    dependencies: MemoryDependency[];
    files?: MemoryFileDependency[];
    sources: string[];
    /** Subset of sources seen only through the exact accepted file dependencies. */
    fileSources?: string[];
    turnOnly: boolean;
    epoch: number;
    projects?: readonly string[];
};
export interface MemorySourceErasure {
    token: string;
    spans: Array<{ start: number; end: number }>;
}
export interface MemorySource {
    id: string;
    operation: string;
    version: number;
    conversation: string | null;
    session: string | null;
    scope: MemoryScope;
    context: MemoryScope | null;
    project?: MemoryScope | null;
    author: 'user' | 'manual' | 'answer';
    text: string | null;
    hash: string | null;
    length: number;
    question: string | null;
    requestId: string | null;
    questionId: string | null;
    at: number;
    timezone: string;
    outcome: string;
    withdrawn: boolean;
    rememberedHash?: string | null;
    erasure?: MemorySourceErasure;
}
export type StoredFact = Pick<MemoryFact, 'subject' | 'predicate' | 'relation' | 'object' | 'polarity' | 'dated'> & {
    intendedFrom: number | null;
    intendedTo: number | null;
};
export interface MemoryCandidate {
    sourceId: string;
    start: number;
    end: number;
    proposal: string;
    expiresAt: number;
}
export type MemoryEvidence = {
    sourceId: string;
    conversationId: string | null;
    sourceVersion: number;
    start: number;
    end: number;
    parts: MemoryFact['evidence'] | null;
    spans: {
        start: number;
        end: number;
    }[];
    changeId: number | null;
    assertedFrom: number | null;
    assertedTo: number | null;
    inheritsChangeTime: boolean;
};
export type MemoryChangeKind = 'correct' | 'supersede' | 'end' | 'possible_conflict';
export type MemoryChangeStatus = 'applied' | 'undone' | 'withdrawn' | 'resolved';
export interface MemoryChange {
    id: number;
    revision: number;
    targetId: number;
    replacementId: number | null;
    kind: MemoryChangeKind | 'pending_relation';
    sourceId: string | null;
    sourceVersion: number | null;
    spans: {
        start: number;
        end: number;
    }[];
    from: number | null;
    to: number | null;
    effectiveAt: number | null;
    createdAt: number;
    automatic: boolean;
    status: MemoryChangeStatus;
    intentFrom: number | null;
    intentTo: number | null;
    derivedFrom: number | null;
    intentWindows: MemoryInterval[] | null;
    oldValueSpans: MemoryEvidence['spans'];
    needsConfirmation: boolean;
}
export interface MemoryEntry {
    id: number;
    revision: number;
    text: string;
    kind: MemoryKind;
    scope: MemoryScope;
    modality: 'asserted' | 'planned' | 'hypothetical' | 'reported';
    conditional: boolean;
    keywords: string[];
    source: 'user' | 'agent';
    conversationId: string | null;
    createdAt: number;
    updatedAt: number;
    state: 'active' | 'superseded' | 'retracted' | 'disputed';
    retention: 'retained' | 'forgotten';
    invalidAt: number | null;
    invalidatedBy: string | null;
    validFrom: number | null;
    validTo: number | null;
    authorizedRevision: number;
    assertedFrom: number | null;
    assertedTo: number | null;
    windows: MemoryInterval[];
    fact: StoredFact | null;
    links: Array<{
        id: number;
        kind: 'conflict' | 'supersedes' | 'corrects' | 'pending-relation';
        incoming: boolean;
        revision?: number;
        changeId?: number;
        from?: number | null;
        to?: number | null;
        windows?: MemoryInterval[];
    }>;
    evidence: MemoryEvidence[];
}
