import type { Notice } from './notice-plan.ts'

/**
 * What the backend may ask of the desktop it runs beside (the shell, src/shell/main.ts): the only way it reaches
 * Electron. The backend's module tree imports no `electron` at run time (test/backend-boundary.test.ts); every
 * capability the shell owns comes through here. Dialogs answer with local paths; they serve only the local
 * capabilities group (docs/backend-split-design.md §4, classes 3 and 4).
 */
export interface FolderOptions { title: string, createDirectory?: boolean, defaultPath?: string, showHidden?: boolean }
export interface FileOptions { title: string, multiple?: boolean }
export interface SaveOptions { title: string, defaultPath: string, filters?: Array<{ name: string, extensions: string[] }> }

/** The encryption of the user's keys (Electron's safeStorage), as the stores use it. */
export interface Secrets {
  isEncryptionAvailable(): boolean
  encryptString(text: string): Buffer
  decryptString(data: Buffer): string
}

/** What the shell shows in settings beside the backend's own (the shortcut, 开机启动). */
export interface ShellSettings {
  shortcut: { keys: string, held: boolean } | null
  openAtLogin: { available: boolean }
}

export type HostEvent = { type: string, [field: string]: any }

export interface HostCapabilities {
  paths: { userData: string, documents: string, home: string }
  /** The installed app, or a run from the repository. */
  packaged: boolean
  /** Started by an external automation client (smoke tests): no notifications, no login item, no shortcut. */
  automation: boolean
  /** The system's language, for language 'system'. */
  locale(): string
  secrets: Secrets
  dialogs: {
    chooseFolder(options: FolderOptions): Promise<string | null>
    chooseFiles(options: FileOptions): Promise<string[] | null>
    saveFile(options: SaveOptions): Promise<string | null>
  }
  shell: {
    openExternal(url: string): Promise<void>
    /** Resolves to an error message, '' when it worked. */
    openPath(path: string): Promise<string>
    showItemInFolder(path: string): void
    trash(path: string): Promise<void>
  }
  /** A follow-up's notice as a system notification; `opened` when the user clicks it. */
  notify(notice: Notice, opened: (afterMs: number) => void): void
  power: { idleSeconds(): number }
  window: {
    /** An event for the window's page (agent:event). */
    send(event: HostEvent): void
    /** The language for every window (language:changed). */
    broadcastLanguage(state: unknown): void
    inFront(): boolean
    /** The tray's count of what waits for the user. */
    setPending(count: number): void
    /** Native words (the tray menu) after the language changed. */
    refreshNative(): void
  }
  loginItem: { set(on: boolean): void }
  /** The shell's part of the settings view. */
  shellSettings(): ShellSettings
}
