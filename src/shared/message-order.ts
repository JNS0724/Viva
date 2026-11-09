/** Locate an unchanged sequence within a version with inserted messages, in linear time. */
export function retainedMessagePositions<Before, After>(before: readonly Before[], after: readonly After[], same: (left: Before, right: After) => boolean): number[] | null {
  const positions: number[] = []
  for (let index = 0; index < after.length && positions.length < before.length; index += 1) {
    if (same(before[positions.length], after[index])) positions.push(index)
  }
  return positions.length === before.length ? positions : null
}

/** A report remains immediately after the same retained message. */
export function retainedMessageBoundary(after: number, positions: readonly number[]): number {
  return after > 0 && after <= positions.length ? positions[after - 1] + 1 : after
}
