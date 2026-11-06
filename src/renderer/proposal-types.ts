export type ScheduleRuleView = { kind: 'at' } | { kind: 'daily', daily: { time: string } } | { kind: 'weekly', weekly: { time: string, weekdays: readonly number[] } } | { kind: 'cron', cron: { expression: string } }
export interface ScheduleProposal { proposalId: string, title: string, prompt: string, firstAt: string, rule: ScheduleRuleView }
export interface ProposalCard {
  id: string, proposal: ScheduleProposal, status: 'open' | 'accepted' | 'declined'
  accepted?: { title: string, nextAt: string } | null, error?: string | null, busy?: boolean
}
