/** A message as Viva takes it; `at` is ms since 1970 or an ISO date. At least one of title and text. */
export interface SourceMessage {
  id: string
  at: number | string
  from?: string
  title?: string
  text?: string
  /** http, https or mailto only. */
  link?: string
  level?: string
  thread?: string
}

export interface PollResult { cursor: string | null, messages: SourceMessage[] }

export type Config = Record<string, string | number | boolean>

export interface SourceDefinition {
  /** What came after `cursor` (null: from the start), and where to read on from next time. */
  poll(config: Config, cursor: string | null): PollResult | Promise<PollResult>
  /** Whether `config` works: true, what is wrong as a string, or { ok, problem }. Left out: always fine. */
  check?(config: Config): true | string | { ok: boolean, problem?: string } | Promise<true | string | { ok: boolean, problem?: string }>
}

/** Runs the source for the request the app wrote on stdin, writes its answer, and exits. */
export function defineSource(source: SourceDefinition): Promise<void>

/** The source's own data folder (VIVA_SOURCE_DATA), or null outside Viva. */
export function dataDir(): string | null
