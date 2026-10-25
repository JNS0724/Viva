import { AbsoluteFill, interpolate, OffthreadVideo, Sequence, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion'
import { AppWindow } from '../components/AppWindow'
import { COLORS, FONT } from '../theme'
import { DEMO_RATE } from '../timeline'

/** Steps of the recorded demo, each from a share of its length on. */
const STEPS: readonly { at: number, n: string, text: string }[] = [
  { at: 0, n: '01', text: '随口说一句要做的事' },
  { at: 0.23, n: '02', text: '它提议跟进，写清时间和会读什么' },
  { at: 0.35, n: '03', text: '你点「跟进」，挑后台准备的时段' },
  { at: 0.54, n: '04', text: '空闲时在后台只读地起草' },
  { at: 0.83, n: '05', text: '「接着做」：草稿进输入框，由你来发' },
]

const StepPill: React.FC<{ n: string, text: string }> = ({ n, text }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const p = spring({ frame, fps, config: { damping: 200 } })
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 18, padding: '18px 30px', borderRadius: 999,
        background: 'rgba(12, 18, 32, 0.78)', border: `1px solid ${COLORS.line}`, backdropFilter: 'blur(16px)',
        fontFamily: FONT, fontSize: 32, color: COLORS.ink,
        opacity: p, transform: `translateY(${interpolate(p, [0, 1], [30, 0])}px) scale(${interpolate(p, [0, 1], [0.94, 1])})`,
        boxShadow: '0 20px 50px rgba(0,0,0,0.5)',
      }}
    >
      <span style={{ fontWeight: 800, color: COLORS.orange, fontVariantNumeric: 'tabular-nums' }}>{n}</span>
      {text}
    </div>
  )
}

/** The real app, recorded: the window swings up flat from a tilt, the steps named as they happen. */
export const Demo: React.FC<{ frames: number }> = ({ frames }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const enter = spring({ frame, fps, config: { damping: 18, mass: 1.1 } })
  const drift = interpolate(frame, [0, frames], [0, 1])
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ marginTop: -60 }}>
        <AppWindow
          width={1440}
          rotateX={interpolate(enter, [0, 1], [28, 2])}
          rotateY={interpolate(drift, [0, 1], [-3, 3])}
          scale={interpolate(enter, [0, 1], [0.82, 1]) + drift * 0.03}
          translateY={interpolate(enter, [0, 1], [220, 0])}
        >
          <OffthreadVideo src={staticFile('demo.mp4')} playbackRate={DEMO_RATE} muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        </AppWindow>
      </div>
      {STEPS.map((step, i) => {
        const from = Math.round(step.at * frames)
        const until = i + 1 < STEPS.length ? Math.round(STEPS[i + 1].at * frames) : frames
        return (
          <Sequence key={step.n} from={from} durationInFrames={until - from} layout="none">
            <div style={{ position: 'absolute', bottom: 56, left: 0, right: 0, display: 'flex', justifyContent: 'center' }}>
              <StepPill n={step.n} text={step.text} />
            </div>
          </Sequence>
        )
      })}
    </AbsoluteFill>
  )
}
