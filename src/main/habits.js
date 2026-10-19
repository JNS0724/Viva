/**
 * Work habits read from the user's own history, without the model: for now, the hours they usually
 * ask for help. Pure, so it can be tested with fixed timestamps.
 */

/** Fewer questions than this say nothing reliable about someone's day. */
export const MIN_SAMPLES = 20
/** An hour counts as active when it has at least this share of the busiest hour's questions. */
const ACTIVE_SHARE = 0.25
/** A single late-night question is not a habit. */
const MIN_HOUR_COUNT = 2
const HOURS = 24

/** Consecutive active hours as [start, endExclusive] pairs. */
function hourRanges(active) {
  return active.reduce((ranges, isActive, hour) => {
    if (!isActive) return ranges
    const last = ranges[ranges.length - 1]
    return last && last[1] === hour ? [...ranges.slice(0, -1), [last[0], hour + 1]] : [...ranges, [hour, hour + 1]]
  }, [])
}

/**
 * @param {number[]} timestamps when the user sent a message (ms)
 * @returns {{ samples: number, ranges: Array<[number, number]>, text: string }} text is '' when there is too little to go on
 */
export function activeHours(timestamps) {
  const samples = timestamps.length
  if (samples < MIN_SAMPLES) return { samples, ranges: [], text: '' }
  const counts = new Array(HOURS).fill(0)
  for (const ts of timestamps) counts[new Date(ts).getHours()] += 1
  const busiest = Math.max(...counts)
  const ranges = hourRanges(counts.map((n) => n >= Math.max(MIN_HOUR_COUNT, busiest * ACTIVE_SHARE)))
  const text = `常在 ${ranges.map(([from, to]) => `${from}–${to} 点`).join('、')}使用`
  return { samples, ranges, text }
}
