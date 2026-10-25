import { useCurrentFrame } from 'remotion'
import { COLORS } from '../theme'

interface AppWindowProps {
  width: number
  /** Width over height of what is inside (the app's screens are 16:10). */
  aspect?: number
  rotateX?: number
  rotateY?: number
  scale?: number
  translateY?: number
  glow?: string
  children: React.ReactNode
}

/** A floating window in 3D: soft colored glow under it and a light sheen sweeping across the glass. */
export const AppWindow: React.FC<AppWindowProps> = ({ width, aspect = 1.6, rotateX = 0, rotateY = 0, scale = 1, translateY = 0, glow = COLORS.blue, children }) => {
  const frame = useCurrentFrame()
  const sheen = ((frame * 1.2) % 260) - 80
  return (
    <div style={{ perspective: 2200 }}>
      <div
        style={{
          position: 'relative',
          width,
          height: width / aspect,
          borderRadius: 18,
          overflow: 'hidden',
          border: `1px solid ${COLORS.line}`,
          transform: `translateY(${translateY}px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale(${scale})`,
          boxShadow: `0 60px 140px -30px rgba(0,0,0,0.85), 0 0 120px -20px ${glow}55`,
          backgroundColor: '#0d1220',
        }}
      >
        {children}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            background: `linear-gradient(115deg, transparent ${sheen}%, rgba(255,255,255,0.07) ${sheen + 8}%, transparent ${sheen + 16}%)`,
          }}
        />
      </div>
    </div>
  )
}
