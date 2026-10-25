import { spring, useCurrentFrame, useVideoConfig } from 'remotion'

interface KineticTextProps {
  text: string
  delay?: number
  /** Frames between one character and the next. */
  stagger?: number
  style?: React.CSSProperties
}

/** Characters rise into place out of a blur, one after another. */
export const KineticText: React.FC<KineticTextProps> = ({ text, delay = 0, stagger = 1.6, style }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  return (
    <span style={{ display: 'inline-block', whiteSpace: 'pre', ...style }}>
      {Array.from(text).map((char, i) => {
        const p = spring({ frame: frame - delay - i * stagger, fps, config: { damping: 200, mass: 0.6 } })
        return (
          <span
            key={i}
            style={{
              display: 'inline-block',
              opacity: p,
              transform: `translateY(${(1 - p) * 0.6}em)`,
              filter: `blur(${(1 - p) * 10}px)`,
            }}
          >
            {char}
          </span>
        )
      })}
    </span>
  )
}

interface HighlightProps {
  children: React.ReactNode
  /** 0..1: how far the marker has swept. */
  progress: number
  color: string
}

/** A marker stroke sweeping under a phrase. */
export const Highlight: React.FC<HighlightProps> = ({ children, progress, color }) => (
  <span
    style={{
      backgroundImage: `linear-gradient(90deg, ${color}66, ${color}33)`,
      backgroundRepeat: 'no-repeat',
      backgroundSize: `${progress * 100}% 38%`,
      backgroundPosition: '0 88%',
      padding: '0 0.08em',
    }}
  >
    {children}
  </span>
)
