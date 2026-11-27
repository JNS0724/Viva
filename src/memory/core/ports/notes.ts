// Domain storage port. Implementations live in memory/node; no database handle crosses this boundary.
import type { DocumentSourceRef, MemoryPhysicalFile } from './documents.ts'
import type { MemorySessionKind } from '../../contracts/records.ts'
import type { MemorySource } from './store.ts'
type SourceRef = DocumentSourceRef
export interface NoteRow {
    key: string;
    day: string;
    workspace: string;
    path: string;
    revision: number;
    processed: number;
    updatedAt: number;
    file_revision: string;
    enabled: boolean;
    stateWatermarkAt?: number;
    stateWatermarkKey?: string;
}
type Note = NoteRow & {
    title: string;
    markdown: string;
    document: string;
    session?: string;
    fileRevision: string;
    stateWatermarkAt?: number;
    stateWatermarkKey?: string;
};
export interface DailyAllocation {
    key: string;
    day: string;
    workspace: string;
    path: string;
    revision: number;
    updatedAt: number;
}
export type DailyFileRegistration = DailyAllocation & { fileRevision: string, enabled: boolean }
export type NoteDbRegistration = {
    key: string;
    workspace: string;
    path: string;
    revision: number;
    processed: number;
    fileRevision: string | null;
    enabled: boolean;
    deleted: boolean;
}
export type ReadSessionRangeResult =
    | { status: 'ok'; assistant: string }
    | { status: 'deleted' }
    | { status: 'unavailable' }

export type ReadSessionRange = (
    input: { sessionId: string; fromSeq: number; toSeq: number; sessionKind?: MemorySessionKind },
    signal?: AbortSignal,
) => Promise<ReadSessionRangeResult>

export interface NoteRangeTurn {
    id: string;
    note: string;
    session: string;
    sessionKind: MemorySessionKind;
    day: string;
    workspace: string;
    fromSeq: number;
    toSeq: number;
    turn: number;
    turnAt: number;
    sourceIds: string[];
    assistantSourceIds: string[];
    assistantDigest: string | null;
    assistantValid: boolean;
    questionSourceIds: string[];
    questionCurrent: boolean;
    assistant: string;
}

export interface MemoryNotes {
    allocations(): DailyAllocation[];
    fileRegistry(): DailyFileRegistration[];
    noteRegistration(key: string): NoteDbRegistration | null;
    deleteFile(workspace: string, key: string, expectedUsageVersion: number): number;
    setEnabled(key: string, revision: number, enabled: boolean): boolean;
    registeredAt(workspace: string, path: string): { key: string, file_revision: string } | undefined;
    registeredForSources(ids: readonly string[]): Array<{ workspace: string, path: string }>;
    registered(): Array<NoteRow & { sources: DocumentSourceRef[], state: 'active' | 'withdrawing' }>;
    recoverDeletedFiles(): void;
    deletedFileCleanupPending(workspace: string, id: string): boolean;
    checkpointCleanup(): void;
    pendingCleanup(): number;
    needsRecovery(): boolean;
    recover: () => void;
    read: (key: string, physical?: MemoryPhysicalFile | null) => Note | undefined;
    snapshot: (ids: readonly string[]) => SourceRef[];
    jobState: (key: string, generation: number) => string | undefined;
    blocked: (key: string) => boolean;
    contextSources(session: string, source: MemorySource, excludeIds?: ReadonlySet<string>): string[] | null;
    hasRange(session: string, fromSeq: number, toSeq: number): boolean;
    canAttachHostDay?(groupKey: string, hostDay: string, workspace: string): boolean;
    addRange(input: {
        session: string;
        groupKey?: string;
        sessionKind?: MemorySessionKind;
        day: string;
        fromSeq: number;
        toSeq: number;
        turn: number;
        turnAt?: number;
        sources: MemorySource[];
        assistantDigest: string | null;
        assistantSources?: readonly string[];
        questionSources?: readonly string[];
        questionCurrent?: boolean;
        sourceEventSeqs?: Readonly<Record<string, number>>;
        ephemeralAssistant?: string;
    }): string | null;
    add(session: string, day: string, sources: MemorySource[], assistant: string, requestId?: string, assistantSources?: readonly string[], inputAssistant?: string, options?: { questionSources?: readonly string[], questionCurrent?: boolean, groupKey?: string, turnAt?: number }): string | null;
    list(from: string | null, through: string | null): Note[];
    changedFiles(from: string, through: string, updatedSinceMs?: number, backwriteBeforeDay?: string, backwriteSinceMs?: number): Array<Pick<NoteRow, 'key' | 'workspace' | 'path'>>;
    pendingGroups: () => Array<{
        note: string;
        day: string;
        count: number;
    }>;
    pendingKeysForSession?: (session: string) => Array<{ note: string; day: string }>;
    pending: (key: string, limit?: number) => NoteRangeTurn[];
    previous(key: string, id: string): NoteRangeTurn | undefined;
    sourceQuestionContext(sourceId: string): { current: boolean, refs: DocumentSourceRef[] };
    sources(key: string): string[];
    references(key: string): DocumentSourceRef[];
    finish(rows: Array<{
        id: string;
    }>, contributed: boolean): void;
    commit(key: string, rows: Array<{
        id: string;
    }>, reply: {
        status: "skip";
    } | {
        status: "write";
        title: string;
        markdown: string;
        filename?: string;
    }, generation: number, at: number, refs: SourceRef[], expected: Note | undefined, watermark?: { at: number; key: string }): boolean;
    markProcessed(key: string, revision: number): boolean;
}
