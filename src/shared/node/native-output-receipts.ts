export const NATIVE_OUTPUT_RECEIPTS = 'viva/native-output-receipts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Wait for the memory owner to record the native output evidence of this session. */
    [NATIVE_OUTPUT_RECEIPTS](session: string): Promise<void>
  }
}
