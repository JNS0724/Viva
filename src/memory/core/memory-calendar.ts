/** Resolve a calendar boundary in the zone captured with the source. */
export function localDay(value: string, timezone: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null
  const target = Date.parse(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(target) || new Date(target).toISOString().slice(0, 10) !== value) return null
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  })
  // The first instant of the local date may have a midnight offset change.
  let low = target - 48 * 3_600_000
  let high = target + 48 * 3_600_000
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2)
    if (formatter.format(mid) < value) low = mid
    else high = mid
  }
  return formatter.format(high) === value ? high : null
}

export function todayAt(at: number, timezone: string) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(at)
}

export function nextDay(day: string) {
  return new Date(Date.parse(day) + 86_400_000).toISOString().slice(0, 10)
}

type CivilBoundary = { date: string, time?: string } | { daysFromSource: number, time?: string }
export function localBoundary(boundary: CivilBoundary, assertedAt: number, timezone: string): number | null {
  const date = 'date' in boundary ? boundary.date
    : new Date(Date.parse(todayAt(assertedAt, timezone)) + boundary.daysFromSource * 86_400_000).toISOString().slice(0, 10)
  if (!boundary.time) return localDay(date, timezone)
  const time = boundary.time.length === 5 ? boundary.time + ':00' : boundary.time
  const civil = `${date}T${time}`
  const utc = Date.parse(civil + 'Z')
  if (!Number.isFinite(utc) || new Date(utc).toISOString().slice(0, 19) !== civil) return null
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  })
  const civilAt = (at: number) => formatter.format(at).replace(' ', 'T')
  // Sample offsets around the boundary, then round-trip each candidate. Repeated
  // and nonexistent local times both require clarification.
  const offsets = new Set([-48, -24, 0, 24, 48].map(hours => {
    const at = utc + hours * 3_600_000
    return Date.parse(civilAt(at) + 'Z') - at
  }))
  const matches = [...offsets].map(offset => utc - offset).filter(at => civilAt(at) === civil)
  return matches.length === 1 ? matches[0] : null
}
