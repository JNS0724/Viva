# 写一个消息源

消息源把邮件、告警、通讯工具里的新消息交给 Viva。它是一个文件夹：一份 `viva-source.json`，加一个程序，用什么语言写都行。Viva 每隔几分钟启动它一次，问「上次之后有什么新的」，它答完就退出。

本文写给要接入自己系统的开发者。用户怎么安装、打开、配置，见 [features.md 的「消息源」](features.md#消息源)。

## 五分钟上手

```bash
npx viva-source new my-alerts                       # JS 模板；--template python 或 command 换别的
cd my-alerts && npm install                         # Python 模板不用这一步
# 改 viva-source.json 和程序里标着 TODO 的地方
npx viva-source test . --set token=xxx              # 用 Viva 自己的检查跑一遍
```

检查通过后，在 Viva 的设置「消息源」里点「安装消息源…」选这个文件夹，填好配置，打开开关。

> `viva-source-kit` 还没有发布到 npm。发布之前，在 Viva 仓库里用 `node packages/viva-source-kit/bin/viva-source.js`（先运行一次 `node scripts/build-source-kit.mjs`）。

## viva-source.json

```jsonc
{
  "contract": 1,                          // 约定版本，现在是 1
  "id": "acme-alerts",                    // 小写字母、数字、连字符，最多 40 个字符；安装后的文件夹名
  "name": "Acme 告警",                    // 设置里显示的名字
  "kind": "alert",                        // mail | alert | chat | other
  "run": ["node", "index.mjs"],           // 怎么启动；相对路径按这个文件夹解析
  "runOn": { "win32": ["py", "-3", "main.py"] },   // 可选：某个平台换一种启动方式（win32 / darwin / linux）
  "reads": "告警名、级别、时间",           // 会读什么，安装时和设置页里给用户看，请写实
  "everyMinutes": 5,                      // 默认多久拉一次（1–1440），用户可以改
  "config": {                             // 要用户填的东西；设置页按它生成表单
    "endpoint": { "type": "string", "title": "地址", "required": true },
    "token":    { "type": "secret", "title": "访问令牌", "help": "在 Acme 的个人设置里生成" },
    "minLevel": { "type": "enum", "title": "最低级别", "values": ["P0", "P1", "P2"], "default": "P1" },
    "limit":    { "type": "number", "title": "每次最多几条", "default": 50 },
    "unread":   { "type": "boolean", "title": "只看未读", "default": true }
  }
}
```

- 配置项名只能用英文字母、数字和下划线，最多 20 项。
- `secret` 用系统钥匙串加密保存，只在调用时交给你的程序，页面上永远看不到它的值。
- 必填项没填，用户打不开开关。

## 协议

Viva 每次做一个动作就启动一次程序：

- **请求**：从标准输入读一行 JSON，`{ "contract": 1, "action": "poll", "config": { … }, "cursor": "…" }`。
- **回答**：在标准输出写一行 JSON，Viva 取**最后一行**能解析的 JSON。前面可以打日志。
- **失败**：退出码不为 0。标准错误的最后几行会作为原因显示在设置里，所以请写用户看得懂的话，比如「令牌过期了，请重新生成」。

| 动作 | 输入 | 回答 |
|---|---|---|
| `check` | `config` | `{ "ok": true }`，或 `{ "ok": false, "problem": "令牌不对" }` |
| `poll` | `config`、`cursor`（第一次是 `null`） | `{ "cursor": "…", "messages": [ … ] }` |

**消息**：

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 在这个消息源里稳定、唯一；Viva 按它去重 |
| `at` | 是 | 毫秒时间戳，或 ISO 时间（`2026-10-25T09:00:00Z`） |
| `title` / `text` | 至少一个 | 标题最多 300 字，正文最多 8000 字 |
| `from` | 否 | 发件人、告警来源 |
| `link` | 否 | 只能是 http、https 或 mailto |
| `level` | 否 | 例如 P1 |
| `thread` | 否 | 同一个会话或告警的标识 |

每次最多交 200 条。格式不对的单条会被丢掉，原因显示在设置里，其余照收。

**游标**：`cursor` 是你自己定的一段文字（最长 4000 字），可以是时间、页码、最后一条的 id，Viva 原样存着，下次交回给你。消息和新游标一起保存；这次失败了，下次还从原来的位置拉，所以重复交回同一条消息没关系，Viva 会按 `id` 去掉。不交游标（`null`）也行，只是每次都从头拉。

## 运行环境

- **启动**：`run` 第一个是 `node` 时，Viva 用自带的运行时启动，用户不用另装 Node。其他程序按 `PATH` 查找。程序名在 Windows 上不一样的（`python3` → `py -3`），用 `runOn` 写出来；`viva-source test` 会提醒你。
- **Windows 上的 `.cmd`**：npm 装的命令行工具在 Windows 上是 `.cmd`，Viva 会经 `cmd.exe` 启动它，这时参数只能是简单的词（字母、数字和 `./\:=@+,-`）。配置不要放进参数，它本来就从标准输入给。
- **环境变量**：只有系统基本项（`PATH`、home、语言、临时目录，Windows 上再加 `SystemRoot`、`ComSpec`、`PATHEXT` 等），加上：
  - `VIVA_SOURCE_DATA`：给你自己用的数据目录，可以存刷新后的令牌、缓存。移除消息源时一起删掉。
  - `VIVA_SOURCE_CONTRACT`：约定版本。
  - 用户的其他环境变量（包括模型的 key）都不会给你。
- **限制**：每次 60 秒，输出最多 1MB。超时会结束你的程序和它启动的子进程。
- **失败了**：游标不动，按 1、5、15、60 分钟退避重试，不会比用户设的间隔更频繁。
- **编码**：标准输入、输出都是 UTF-8。Python 在 Windows 上请照模板设置 `sys.stdout.reconfigure(encoding="utf-8")`。

## viva-source-kit

JS 写消息源时，`defineSource` 帮你读请求、写回答、处理出错：

```js
import { defineSource, dataDir } from 'viva-source-kit'

defineSource({
  async check(config) {
    return config.token ? true : '请填写访问令牌'      // true、一句话，或 { ok, problem }
  },
  async poll(config, cursor) {
    const items = await fetchSince(config, cursor)   // 你的系统
    return { cursor: items.at(-1)?.time ?? cursor, messages: items.map(toMessage) }
  },
})
```

`poll` 里抛出的错误会写到标准错误、以退出码 1 结束，原因显示在设置里。

## 命令行工具怎么接

已经有输出 JSON 的命令行工具（比如邮箱 CLI），用 `command` 模板：它运行配置里的命令，把每一项交给 `toMessage` 转成消息，以最新的时间为游标，只交回之后的。你只需要改 `toMessage`；如果命令能按时间过滤，把游标传给它更省。

## 检查

```bash
npx viva-source test <文件夹> [--config 配置.json] [--set 名称=值]...
```

用的是 Viva 自己的校验代码，按 Viva 的方式运行：

1. 检查清单
2. 检查配置
3. 能否在这个平台启动
4. 跑一次 `check`
5. 从头 `poll` 一次
6. 再用上一步的游标 `poll` 一次

每步出错（✖）或者看着不对（⚠）都会说明，比如游标没往前走、时间用了秒而不是毫秒、Windows 上缺 `runOn`。全部 ✔ 或只有 ⚠ 就可以安装。

## 安全

消息源程序以用户的权限运行，Viva 拦不住它读文件、联网，所以设置页会提醒用户只安装信得过的。Viva 能保证的是：

- 你交的内容一律当数据：先校验，再存进 `sources.db`；它碰不到助手的模型、工具和上下文。
- 你拿不到用户的其他密钥和环境变量，也拿不到别的消息源的配置。

请只读 `reads` 里写的东西，令牌只存在 `VIVA_SOURCE_DATA` 里。
