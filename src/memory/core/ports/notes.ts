// Domain storage port. Implementations live in memory/node; no database handle crosses this boundary.
import type { DocumentSourceRef, MemoryPhysicalFile } from './documents.ts'
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
}
type Note = NoteRow & {
    title: string;
    markdown: string;
    document: string;
    session?: string;
    fileRevision: string;
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
    contextSources(session: string, source: MemorySource): string[];
    add(session: string, day: string, sources: MemorySource[], assistant: string, requestId?: string, assistantSources?: readonly string[], inputAssistant?: string, options?: { questionSources?: readonly string[], questionCurrent?: boolean }): string | null;
    list(from: string | null, through: string | null): Note[];
    changedFiles(from: string, through: string): Array<Pick<NoteRow, 'key' | 'workspace' | 'path'>>;
    pendingGroups: () => Array<{
        note: string;
        session: string;
        day: string;
        count: number;
    }>;
    pending: (key: string, limit?: number) => {
        sourceIds: string[];
        assistantSourceIds: string[];
        questionSourceIds: string[];
        questionCurrent: boolean;
        assistant: string;
        id: string;
        note: string;
        session: string;
        day: string;
        workspace: string;
        sources: string;
        source_tokens: string;
        assistant_sources: string;
        assistant_valid: number;
        question_sources: string;
        question_valid: number;
        written: number;
    }[];
    previous(_key: string, id: string): {
        sourceIds: string[];
        assistantSourceIds: string[];
        questionSourceIds: string[];
        questionCurrent: boolean;
        assistant: string;
        id: string;
        note: string;
        session: string;
        day: string;
        workspace: string;
        sources: string;
        source_tokens: string;
        assistant_sources: string;
        assistant_valid: number;
        question_sources: string;
        question_valid: number;
        written: number;
    } | undefined;
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
    }, generation: number, at: number, refs: SourceRef[], expected: Note | undefined): boolean;
    markProcessed(key: string, revision: number): boolean;
}
