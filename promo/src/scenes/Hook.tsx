import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion'
import { Highlight, KineticText } from '../components/KineticText'
import { COLORS, FONT } from '../theme'

/** The idea in two lines: what you said in passing, it keeps, and gets ready before you ask again. */
export const Hook: React.FC = () => {
  const frame = useCurrentFrame()
  const sweep = interpolate(frame, [44, 70], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', fontFamily: FONT, color: COLORS.ink, textAlign: 'center' }}>
      <div style={{ fontSize: 56, color: COLORS.muted }}>
        <KineticText text="你随口说的一件事" />
      </div>
      <div style={{ fontSize: 96, fontWeight: 800, marginTop: 28, letterSpacing: -2 }}>
        <KineticText text="它记着，" delay={18} />
        <Highlight progress={sweep} color={COLORS.orange}>
          <KineticText text="提前替你准备好" delay={30} />
        </Highlight>
      </div>
    </AbsoluteFill>
  )
}
