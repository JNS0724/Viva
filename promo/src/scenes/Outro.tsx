import { AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion'
import { COLORS, FONT, MONO } from '../theme'

const PILLS = ['macOS', 'Windows', '开源 · 免费', 'DeepSeek']

/** The name again, where to get it, and what it runs on; the light swells once and settles. */
export const Outro: React.FC = () => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const p = spring({ frame, fps, config: { damping: 200 } })
  const glow = interpolate(frame, [0, 30, 90], [0, 1, 0.6], { extrapolateRight: 'clamp' })
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', fontFamily: FONT, color: COLORS.ink }}>
      <div style={{ position: 'absolute', width: 900, height: 900, borderRadius: '50%', background: `radial-gradient(circle, ${COLORS.blue}40, transparent 60%)`, opacity: glow }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 36, opacity: p, transform: `scale(${interpolate(p, [0, 1], [0.9, 1])})` }}>
        <Img src={staticFile('icon.png')} style={{ width: 150, height: 150 }} />
        <div style={{ fontSize: 120, fontWeight: 800, letterSpacing: -2 }}>Viva</div>
      </div>
      <div style={{ marginTop: 30, fontSize: 40, color: COLORS.muted, opacity: p }}>你说过的事，它替你记着</div>
      <div style={{ display: 'flex', gap: 18, marginTop: 50 }}>
        {PILLS.map((pill, i) => {
          const q = spring({ frame: frame - 16 - i * 5, fps, config: { damping: 200 } })
          return (
            <span key={pill} style={{ padding: '12px 26px', borderRadius: 999, border: `1px solid ${COLORS.line}`, fontSize: 26, background: 'rgba(255,255,255,0.04)', opacity: q, transform: `translateY(${(1 - q) * 20}px)` }}>
              {pill}
            </span>
          )
        })}
      </div>
      <div style={{ marginTop: 56, fontFamily: MONO, fontSize: 30, color: COLORS.blue, opacity: spring({ frame: frame - 40, fps, config: { damping: 200 } }) }}>
        github.com/JNS0724/Viva
      </div>
    </AbsoluteFill>
  )
}
