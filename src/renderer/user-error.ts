import { t } from '../shared/i18n/translate.ts'
/** UI copy only. Raw provider/RPC errors stay in application state and diagnostic logs, never in a bubble. */
export function userError(message: string): string {
  // These are bounded status messages produced by the app itself, not provider response bodies.
  const reconnect = /^(?:助手意外退出，(\d+) 秒后自动重新连接…|The assistant exited unexpectedly\. Reconnecting in (\d+) seconds…)$/.exec(message)
  if (reconnect) return t('main.main.the.assistant.exited.unexpectedly.reconnecting.in.seconds', { value1: Number(reconnect[1] ?? reconnect[2]) })
  if (message.startsWith('助手连续意外退出，已停止重试：') || message.startsWith('The assistant exited repeatedly. Retrying has stopped:')) return t("merge.the.assistant.exited.repeatedly.and.retries.have.stopped.check.model.settings.an.19")
  if (/\b(?:401|403)\b|authentication|unauthori[sz]ed|invalid.{0,30}(?:api.?key|token)|api.?key.{0,30}invalid/i.test(message)) {
    return t("merge.the.model.credentials.are.invalid.or.lack.access.check.the.key.in.settings.or.ch.20")
  }
  if (/\b429\b|rate.?limit|quota|insufficient.{0,12}(?:balance|credit)|余额不足/i.test(message)) {
    return t("merge.the.model.service.has.insufficient.quota.or.too.many.requests.check.your.quota.o.21")
  }
  if (/connection error|ECONN|ENOTFOUND|ETIMEDOUT|fetch failed|network|socket|timed?\s*out|timeout|超时/i.test(message)) {
    return t("merge.cannot.connect.to.the.model.service.check.the.network.and.api.address.then.try.a.22")
  }
  if (/\b404\b|no adapter|unknown (?:model|provider)|model.{0,20}not found/i.test(message)) {
    return t("merge.this.model.is.unavailable.check.the.model.name.and.api.address.or.choose.another.23")
  }
  return t("merge.this.attempt.did.not.complete.try.again.later.details.are.available.in.the.app.l.24")
}
