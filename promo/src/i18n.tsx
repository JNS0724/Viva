import { createContext, useContext } from 'react'
export type PromoLocale = 'en' | 'zh-CN'
export const PromoLanguage = createContext<PromoLocale>('en')
const messages = {
  "copy0": {
    "en": "A desktop AI that follows up",
    "zh-CN": "会主动跟进的桌面 AI 助手"
  },
  "copy1": {
    "en": "Mention what needs doing",
    "zh-CN": "你随口说的一件事"
  },
  "copy2": {
    "en": "Viva remembers,",
    "zh-CN": "它记着，"
  },
  "copy3": {
    "en": "and prepares ahead",
    "zh-CN": "提前替你准备好"
  },
  "copy4": {
    "en": "Say what you need to do",
    "zh-CN": "随口说一句要做的事"
  },
  "copy5": {
    "en": "Review the timing and sources",
    "zh-CN": "它提议跟进，写清时间和会读什么"
  },
  "copy6": {
    "en": "Accept and choose preparation times",
    "zh-CN": "你点「跟进」，挑后台准备的时段"
  },
  "copy7": {
    "en": "A read-only draft, while you are away",
    "zh-CN": "空闲时在后台只读地起草"
  },
  "copy8": {
    "en": "Review the draft before sending",
    "zh-CN": "「接着做」：草稿进输入框，由你来发"
  },
  "copy9": {
    "en": "Connect sources",
    "zh-CN": "接入消息源"
  },
  "copy10": {
    "en": "Mail, alerts, and your own programs",
    "zh-CN": "邮箱、告警、任何能跑的程序"
  },
  "copy11": {
    "en": "Find what needs you",
    "zh-CN": "挑出要你做的"
  },
  "copy12": {
    "en": "See the original and the reason",
    "zh-CN": "依据和原消息都给你看"
  },
  "copy13": {
    "en": "On your schedule",
    "zh-CN": "你选的时段才动"
  },
  "copy14": {
    "en": "Prepare while you are away",
    "zh-CN": "不占你用电脑的时候"
  },
  "copy15": {
    "en": "Catch what matters in your messages",
    "zh-CN": "不只是你说的，消息里的事也不漏"
  },
  "copy16": {
    "en": "For developers",
    "zh-CN": "开放给开发者"
  },
  "copy17": {
    "en": "Connect in any language",
    "zh-CN": "任何语言，都能接进来"
  },
  "copy18": {
    "en": "One folder, one program. JSON in, JSON out. Secrets go only to your source.",
    "zh-CN": "一个文件夹、一个程序：标准输入进，标准输出出。密钥只交给它自己。"
  },
  "copy19": {
    "en": "Free · Open source",
    "zh-CN": "开源 · 免费"
  },
  "copy20": {
    "en": "Viva remembers what matters to you",
    "zh-CN": "你说过的事，它替你记着"
  },
  "copy21": {
    "en": "You stay in control",
    "zh-CN": "动手前先问你"
  },
  "copy22": {
    "en": "Review changes first",
    "zh-CN": "会改东西的，先给你看"
  },
  "copy23": {
    "en": "Review commands and files before work proceeds.",
    "zh-CN": "要跑的命令、要动的文件写在卡片上，你允许了才做。"
  },
  "copy24": {
    "en": "Your files, close by",
    "zh-CN": "文件就在手边"
  },
  "copy25": {
    "en": "See what changed",
    "zh-CN": "改了什么，一眼看清"
  },
  "copy26": {
    "en": "Preview workspace files, tables, and Markdown.",
    "zh-CN": "工作目录里的文件、表格和 Markdown 直接预览。"
  },
  "copy27": {
    "en": "Today",
    "zh-CN": "今天"
  },
  "copy28": {
    "en": "Start with today",
    "zh-CN": "回到电脑前，先看一眼今天"
  },
  "copy29": {
    "en": "Drafts and messages await your review. You decide what happens next.",
    "zh-CN": "准备好几件、几条消息要你看，都还没动，等你点头。"
  }
} as const
export function usePromoCopy() { const locale = useContext(PromoLanguage); return (key: keyof typeof messages): string => messages[key][locale] }
