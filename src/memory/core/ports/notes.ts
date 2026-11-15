// Domain storage port. Implementations live in memory/node; no database handle crosses this boundary.
import type { MemorySource } from './store.ts'
type SourceRef = {
    id: string;
    token: string;
};
export interface NoteRow {
    key: string;
    day: string;
    workspace: string;
    path: string;
    revision: number;
    processed: number;
    updatedAt: number;
    file_revision: string;
}
type Note = NoteRow & {
    title: string;
    markdown: string;
    fileRevision: string;
};
export interface MemoryNotes {
    recover: () => void;
    read: (key: string) => Note | undefined;
    snapshot: (ids: readonly string[]) => SourceRef[];
    jobState: (key: string, generation: number) => string | undefined;
    blocked: (key: string) => boolean;
    contextSources(session: string, source: MemorySource): string[];
    add(session: string, day: string, sources: MemorySource[], assistant: string, requestId?: string, assistantSources?: readonly string[], inputAssistant?: string): string | null;
    list(from: string | null, through: string | null): Note[];
    changed(from: string, through: string): Note[];
    pendingGroups: () => Array<{
        note: string;
        session: string;
        day: string;
        count: number;
    }>;
    pending: (key: string, limit?: number) => {
        sourceIds: string[];
        assistantSourceIds: string[];
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
        written: number;
    }[];
    previous(_key: string, id: string): {
        sourceIds: string[];
        assistantSourceIds: string[];
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
        written: number;
    } | undefined;
    sources(key: string): string[];
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
    markProcessed(key: string, revision: number): void;
    withdraw(sourceId: string): string[];
}
