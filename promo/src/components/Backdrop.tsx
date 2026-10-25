import { AbsoluteFill, useCurrentFrame } from 'remotion'
import { COLORS } from '../theme'

interface Blob {
  color: string
  x: number
  y: number
  size: number
  speed: number
  phase: number
}

const BLOBS: readonly Blob[] = [
  { color: COLORS.blue, x: 22, y: 28, size: 900, speed: 0.011, phase: 0 },
  { color: COLORS.violet, x: 78, y: 70, size: 1000, speed: 0.008, phase: 2 },
  { color: COLORS.orange, x: 70, y: 18, size: 620, speed: 0.013, phase: 4 },
]

/** Slow drifting light behind everything, a faint grid, and a vignette; it never sits still, so no frame looks frozen. */
export const Backdrop: React.FC<{ intensity?: number }> = ({ intensity = 1 }) => {
  const frame = useCurrentFrame()
  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.night, overflow: 'hidden' }}>
      {BLOBS.map((blob) => {
        const dx = Math.sin(frame * blob.speed + blob.phase) * 6
        const dy = Math.cos(frame * blob.speed * 1.3 + blob.phase) * 5
        return (
          <div
            key={blob.color}
            style={{
              position: 'absolute',
              left: `${blob.x + dx}%`,
              top: `${blob.y + dy}%`,
              width: blob.size,
              height: blob.size,
              transform: 'translate(-50%, -50%)',
              borderRadius: '50%',
              background: `radial-gradient(circle, ${blob.color} 0%, transparent 65%)`,
              opacity: 0.22 * intensity,
              filter: 'blur(40px)',
            }}
          />
        )
      })}
      <AbsoluteFill
        style={{
          backgroundImage: `linear-gradient(${COLORS.line} 1px, transparent 1px), linear-gradient(90deg, ${COLORS.line} 1px, transparent 1px)`,
          backgroundSize: '80px 80px',
          backgroundPosition: `${(frame * 0.4) % 80}px ${(frame * 0.4) % 80}px`,
          opacity: 0.18,
          maskImage: 'radial-gradient(ellipse at center, black 20%, transparent 70%)',
        }}
      />
      <AbsoluteFill style={{ background: 'radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.65) 100%)' }} />
    </AbsoluteFill>
  )
}
