/** Unit fixtures have no physical model transport or active send permits. */
export const offlineMemorySafety = Object.freeze({
  canCommit: () => true,
  validateDispatch() {},
  async runDocumentMutation<T>(work: () => T): Promise<T> { return work() },
})
