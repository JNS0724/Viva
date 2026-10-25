import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion'
import { Caption } from '../components/Caption'
import { COLORS, MONO } from '../theme'

/** A message source as a third party writes one (docs/sources.md), colored by hand: [text, color] runs per line. */
const CODE: readonly (readonly [string, string][])[] = [
  [['import', COLORS.violet], [' { defineSource } ', COLORS.ink], ['from', COLORS.violet], [" 'viva-source-kit'", '#9FE29A']],
  [],
  [['defineSource', COLORS.blue], ['({', COLORS.ink]],
  [['  async ', COLORS.violet], ['poll', COLORS.blue], ['(config, cursor) {', COLORS.ink]],
  [['    const ', COLORS.violet], ['page = ', COLORS.ink], ['await ', COLORS.violet], ['fetchInbox', COLORS.blue], ['(config.token, cursor)', COLORS.ink]],
  [['    return ', COLORS.violet], ['{ cursor: page.next, messages: page.items }', COLORS.ink]],
  [['  },', COLORS.ink]],
  [['})', COLORS.ink]],
]
const CHARS_PER_FRAME = 1.6

/** The code types itself out beside the pitch to developers. */
export const Developers: React.FC = () => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const enter = spring({ frame, fps, config: { damping: 20 } })
  let budget = Math.max(0, (frame - 12) * CHARS_PER_FRAME)
  const lines = CODE.map((runs) => runs.map(([text, color]) => {
    const shown = text.slice(0, Math.max(0, Math.floor(budget)))
    budget -= text.length
    return [shown, color] as const
  }))
  const caretLine = lines.findIndex((runs, i) => runs.some(([shown], j) => shown.length < CODE[i][j][0].length))
  return (
    <AbsoluteFill style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 100 }}>
      <Caption eyebrow="开放给开发者" title="任何语言，都能接进来" body="一个文件夹、一个程序：标准输入进，标准输出出。密钥只交给它自己。" accent={COLORS.orange} />
      <div
        style={{
          width: 980, padding: '40px 46px', borderRadius: 22, background: 'rgba(10, 15, 27, 0.9)', border: `1px solid ${COLORS.line}`,
          fontFamily: MONO, fontSize: 30, lineHeight: 1.7, whiteSpace: 'pre', color: COLORS.ink,
          boxShadow: `0 50px 120px -30px rgba(0,0,0,0.9), 0 0 100px -40px ${COLORS.orange}`,
          opacity: enter, transform: `perspective(1800px) rotateY(${interpolate(enter, [0, 1], [-22, -8])}deg)`,
        }}
      >
        <div style={{ display: 'flex', gap: 10, marginBottom: 24 }}>
          {['#FF5F57', '#FEBC2E', '#28C840'].map((c) => <span key={c} style={{ width: 14, height: 14, borderRadius: 7, background: c }} />)}
          <span style={{ marginLeft: 16, fontSize: 22, color: COLORS.muted }}>my-mail/index.js</span>
        </div>
        {lines.map((runs, i) => (
          <div key={i} style={{ minHeight: '1.7em' }}>
            {runs.map(([shown, color], j) => <span key={j} style={{ color }}>{shown}</span>)}
            {i === caretLine || (caretLine === -1 && i === lines.length - 1)
              ? <span style={{ display: 'inline-block', width: 3, height: '1.1em', verticalAlign: 'middle', background: COLORS.orange, opacity: Math.floor(frame / 8) % 2 ? 1 : 0.2 }} />
              : null}
          </div>
        ))}
      </div>
    </AbsoluteFill>
  )
}
