/** A rule's local time zone, when the model gave one; edits keep it, so 09:00 stays the 09:00 it meant. */
type Zoned = { time_zone?: string }
export type ScheduleRuleView =
  | { kind: 'at', at?: string | ({ date: string, time: string } & Zoned) }
  | { kind: 'daily', daily: { time: string } & Zoned }
  | { kind: 'weekly', weekly: { time: string, weekdays: readonly number[] } & Zoned }
  | { kind: 'cron', cron: { expression: string } & Zoned }
export interface ScheduleProposal { proposalId: string, title: string, prompt: string, firstAt: string, rule: ScheduleRuleView }

/**
 * How often, as the card's form offers it: once, every day, on some weekdays, on a day of the month, or (only for
 * a cron the form cannot say in these words) the model's own expression.
 */
export type RepeatKind = 'at' | 'daily' | 'weekly' | 'monthly' | 'cron'
/** What the card's form holds: the proposal's values in the form's words, then what the user changed. */
export interface ProposalDraft {
  title: string, prompt: string, repeat: RepeatKind
  /** YYYY-MM-DD and HH:mm in `zone`; `weekdays` ISO (Monday 1 … Sunday 7); `day` of the month. */
  date: string, time: string, weekdays: readonly number[], day: number, expression: string, zone: string
}
type EditedRule =
  | { kind: 'at', at: { date: string, time: string, time_zone: string } }
  | { kind: 'daily', daily: { time: string, time_zone: string } }
  | { kind: 'weekly', weekly: { time: string, weekdays: readonly number[], time_zone: string } }
  | { kind: 'cron', cron: { expression: string, time_zone: string } }
/** The proposal as the user keeps it, sent with 定时 (schedules.ts accept); the rule in dsh-schedule's input. */
export type ScheduleEdits = { title: string, prompt: string, rule: EditedRule }

export interface ProposalCard {
  id: string, proposal: ScheduleProposal, status: 'open' | 'accepted' | 'declined'
  /** How many messages the conversation had when it came: it goes at the end of that turn (proposalHost). */
  after: number
  accepted?: { title: string, nextAt: string } | null, error?: string | null, busy?: boolean
  /** Its form is open; `draft` is what was last sent from it, kept so a refused save loses nothing typed. */
  editing?: boolean, draft?: ProposalDraft | null
}
