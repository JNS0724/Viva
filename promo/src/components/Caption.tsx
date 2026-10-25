import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion'
import { COLORS, FONT } from '../theme'

interface CaptionProps {
  eyebrow: string
  title: string
  body?: string
  delay?: number
  align?: 'left' | 'center'
  accent?: string
}

/** A small colored label, a headline and a line under it, each arriving a beat after the last. */
export const Caption: React.FC<CaptionProps> = ({ eyebrow, title, body, delay = 0, align = 'left', accent = COLORS.blue }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const enter = (offset: number) => spring({ frame: frame - delay - offset, fps, config: { damping: 200 } })
  const rise = (p: number) => ({ opacity: p, transform: `translateY(${interpolate(p, [0, 1], [24, 0])}px)` })
  return (
    <div style={{ fontFamily: FONT, color: COLORS.ink, textAlign: align, maxWidth: 620 }}>
      <div style={{ ...rise(enter(0)), display: 'inline-flex', alignItems: 'center', gap: 10, fontSize: 22, fontWeight: 600, color: accent, letterSpacing: 2 }}>
        <span style={{ width: 10, height: 10, borderRadius: 5, background: accent, boxShadow: `0 0 16px ${accent}` }} />
        {eyebrow}
      </div>
      <div style={{ ...rise(enter(5)), fontSize: 58, fontWeight: 700, lineHeight: 1.18, marginTop: 18, letterSpacing: -1 }}>{title}</div>
      {body ? <div style={{ ...rise(enter(10)), fontSize: 28, lineHeight: 1.6, marginTop: 20, color: COLORS.muted }}>{body}</div> : null}
    </div>
  )
}
