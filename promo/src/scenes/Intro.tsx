import { usePromoCopy } from '../i18n'
import { AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion'
import { KineticText } from '../components/KineticText'
import { COLORS, FONT } from '../theme'

/** The cat drops in with a ring of light bursting out behind it, then the name and the promise. */
export const Intro: React.FC = () => {
  const copy = usePromoCopy()
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const pop = spring({ frame, fps, config: { damping: 12, mass: 0.8 } })
  const ring = interpolate(frame, [4, 40], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  const lift = spring({ frame: frame - 28, fps, config: { damping: 200 } })
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', fontFamily: FONT, color: COLORS.ink }}>
      <div style={{ position: 'relative', transform: `translateY(${interpolate(lift, [0, 1], [90, 0])}px)` }}>
        <div
          style={{
            position: 'absolute', left: '50%', top: '50%', width: 220, height: 220, borderRadius: '50%',
            border: `3px solid ${COLORS.blue}`,
            transform: `translate(-50%, -50%) scale(${1 + ring * 2.4})`,
            opacity: 1 - ring,
          }}
        />
        <Img
          src={staticFile('icon.png')}
          style={{ width: 220, height: 220, transform: `scale(${pop}) rotate(${(1 - pop) * -18}deg)`, filter: `drop-shadow(0 30px 60px ${COLORS.blue}66)` }}
        />
      </div>
      <div style={{ marginTop: 40, fontSize: 132, fontWeight: 800, letterSpacing: interpolate(lift, [0, 1], [40, -2]), opacity: lift }}>Viva</div>
      <div style={{ marginTop: 12, fontSize: 44, color: COLORS.muted }}>
        <KineticText text={copy('copy0')} delay={40} />
      </div>
    </AbsoluteFill>
  )
}
