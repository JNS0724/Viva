import { AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion'
import { AppWindow } from '../components/AppWindow'
import { Caption } from '../components/Caption'
import { COLORS } from '../theme'

export interface FeatureProps {
  image: string
  eyebrow: string
  title: string
  body: string
  /** Where the slow zoom heads, in percent of the screen (the part worth looking at). */
  focus: { x: number, y: number }
  side?: 'left' | 'right'
  accent?: string
  /** Width over height of the image. */
  aspect?: number
}

/** One screen of the app: the window slides in turned toward the words, then zooms slowly into what matters. */
export const Feature: React.FC<FeatureProps> = ({ image, eyebrow, title, body, focus, side = 'right', accent = COLORS.blue, aspect = 1.6 }) => {
  const frame = useCurrentFrame()
  const { fps, durationInFrames } = useVideoConfig()
  const enter = spring({ frame, fps, config: { damping: 20 } })
  const zoom = interpolate(frame, [10, durationInFrames], [1, 1.28], { extrapolateLeft: 'clamp' })
  const toward = side === 'right' ? -1 : 1
  const windowBlock = (
    <AppWindow
      width={1000}
      aspect={aspect}
      glow={accent}
      rotateY={interpolate(enter, [0, 1], [toward * 20, toward * 7])}
      scale={interpolate(enter, [0, 1], [0.9, 1])}
    >
      <Img
        src={staticFile(image)}
        style={{ width: '100%', height: '100%', objectFit: 'cover', transform: `scale(${zoom})`, transformOrigin: `${focus.x}% ${focus.y}%` }}
      />
    </AppWindow>
  )
  const words = <Caption eyebrow={eyebrow} title={title} body={body} delay={6} accent={accent} />
  return (
    <AbsoluteFill style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 80, padding: '0 90px' }}>
      <div style={{ opacity: enter, transform: `translateX(${(1 - enter) * toward * -200}px)` }}>{side === 'right' ? words : windowBlock}</div>
      <div style={{ opacity: enter, transform: `translateX(${(1 - enter) * toward * 200}px)` }}>{side === 'right' ? windowBlock : words}</div>
    </AbsoluteFill>
  )
}
