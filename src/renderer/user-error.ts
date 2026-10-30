import { t } from '../shared/i18n/translate.ts'
/** UI copy only. Raw provider/RPC errors stay in application state and diagnostic logs, never in a bubble. */
export function userError(message: string): string {
  // These are bounded status messages produced by the app itself, not provider response bodies.
  const reconnect = /^(?:助手意外退出，(\d+) 秒后自动重新连接…|The assistant exited unexpectedly\. Reconnecting in (\d+) seconds…)$/.exec(message)
  if (reconnect) return t('main.main.the.assistant.exited.unexpectedly.reconnecting.in.seconds', { value1: Number(reconnect[1] ?? reconnect[2]) })
  if (message.startsWith('助手连续意外退出，已停止重试：') || message.startsWith('The assistant exited repeatedly. Retrying has stopped:')) return t("errors.assistant.retries.stopped")
  if (/\b(?:401|403)\b|authentication|unauthori[sz]ed|invalid.{0,30}(?:api.?key|token)|api.?key.{0,30}invalid/i.test(message)) {
    return t("errors.model.credentials")
  }
  if (/\b429\b|rate.?limit|quota|insufficient.{0,12}(?:balance|credit)|余额不足/i.test(message)) {
    return t("errors.model.quota")
  }
  if (/connection error|ECONN|ENOTFOUND|ETIMEDOUT|fetch failed|network|socket|timed?\s*out|timeout|超时/i.test(message)) {
    return t("errors.model.connection")
  }
  if (/\b404\b|no adapter|unknown (?:model|provider)|model.{0,20}not found/i.test(message)) {
    return t("errors.model.unavailable")
  }
  return t("errors.attempt.incomplete")
}
