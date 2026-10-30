// A Viva message source (source@1). Viva runs this file with its own runtime, once per action; defineSource reads
// the request and writes the answer. Replace the TODO parts with calls to your system.
import { defineSource } from 'viva-source-kit'

/** TODO: fetch what came after `since` from your system. Here: a few demo messages, numbered. */
async function fetchAfter(config, since) {
  const last = 5
  const items = []
  for (let n = since + 1; n <= Math.min(since + 2, last); n += 1) {
    items.push({ number: n, sender: '[示例发件人]', subject: `示例消息 ${n}`, body: `这是第 ${n} 条`, time: Date.UTC(2026, 9, 25, n) })
  }
  return items
}

defineSource({
  // Answer true when the config works, or say what is wrong in words the user can act on.
  async check(config) {
    return config.account ? true : '请填写账号'
  },
  // Hand back what came after the cursor (null the first time) and the cursor to read on from next time.
  async poll(config, cursor) {
    const since = Number(cursor ?? 0)
    const items = await fetchAfter(config, since)
    return {
      cursor: String(items.at(-1)?.number ?? since),
      messages: items.map((item) => ({
        id: String(item.number),
        at: item.time,
        from: item.sender,
        title: item.subject,
        text: item.body,
      })),
    }
  },
})
