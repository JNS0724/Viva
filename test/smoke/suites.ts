/** One desktop worker per runner. Keep restart pairs inside their owning spec. */
export const integrationLanes = {
  interaction: ['setup.spec.ts', 'walkthrough.spec.ts', 'timeline.spec.ts', 'language.spec.ts', 'resume.spec.ts'],
  memory: ['memory.spec.ts', 'schedules.spec.ts', 'lifecycle.spec.ts'],
} as const

export function integrationSpecs(lane?: string): string[] {
  if (lane === undefined) return Object.values(integrationLanes).flat()
  if (!Object.hasOwn(integrationLanes, lane)) throw new Error(`Unknown smoke lane: ${lane}`)
  return [...integrationLanes[lane as keyof typeof integrationLanes]]
}
