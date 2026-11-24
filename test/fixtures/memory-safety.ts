/** Unit fixtures have no physical model transport or active send permits. */
export const offlineMemorySafety = Object.freeze({
  canCommit: () => true,
})
