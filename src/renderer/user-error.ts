/** UI copy only. Raw provider/RPC errors stay in application state and diagnostic logs, never in a bubble. */
export function userError(message: string): string {
  // These are bounded status messages produced by the app itself, not provider response bodies.
  if (/^助手意外退出，\d+ 秒后自动重新连接…$/.test(message)) return message
  if (message.startsWith('助手连续意外退出，已停止重试：')) return '助手连续意外退出，已停止重试。请检查模型设置后重新打开应用。'
  if (/\b(?:401|403)\b|authentication|unauthori[sz]ed|invalid.{0,30}(?:api.?key|token)|api.?key.{0,30}invalid/i.test(message)) {
    return '模型连接凭据无效或没有访问权限，请在设置里检查 key，或切换到可用的模型。'
  }
  if (/\b429\b|rate.?limit|quota|insufficient.{0,12}(?:balance|credit)|余额不足/i.test(message)) {
    return '模型服务的额度不足或请求太多，请检查服务额度，或稍后重试。'
  }
  if (/connection error|ECONN|ENOTFOUND|ETIMEDOUT|fetch failed|network|socket|timed?\s*out|timeout|超时/i.test(message)) {
    return '暂时连不上模型服务，请检查网络和接口地址，稍后重试。'
  }
  if (/\b404\b|no adapter|unknown (?:model|provider)|model.{0,20}not found/i.test(message)) {
    return '这个模型暂时不可用，请检查模型名称和接口地址，或切换到其他模型。'
  }
  return '这次没有完成，请稍后重试。详细原因可在应用日志中查看。'
}
