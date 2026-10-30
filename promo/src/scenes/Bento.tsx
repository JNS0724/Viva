import { usePromoCopy } from '../i18n'
import { AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion'
import { KineticText } from '../components/KineticText'
import { COLORS, FONT } from '../theme'

interface Tile {
  image: string
  label: string
  note: string
  accent: string
  /** The part of the screen shown, zoomed in: its center in percent, and how far in. */
  focus: string
  zoom: number
}


/** Three tiles fly in one after another, each turning flat as it lands: the loop from message to suggestion. */
export const Bento: React.FC = () => {
  const copy = usePromoCopy()
  const TILES: readonly Tile[] = [
  { image: 'sources.png', label: copy('copy9'), note: copy('copy10'), accent: COLORS.blue, focus: '56% 47%', zoom: 2.1 },
  { image: 'suggestion.png', label: copy('copy11'), note: copy('copy12'), accent: COLORS.orange, focus: '42% 26%', zoom: 1.9 },
  { image: 'prepare-settings.png', label: copy('copy13'), note: copy('copy14'), accent: COLORS.violet, focus: '56% 30%', zoom: 2.1 },
]

  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', fontFamily: FONT, color: COLORS.ink }}>
      <div style={{ fontSize: 64, fontWeight: 800, marginBottom: 64, letterSpacing: -1 }}>
        <KineticText text={copy('copy15')} />
      </div>
      <div style={{ display: 'flex', gap: 40, perspective: 1800 }}>
        {TILES.map((tile, i) => {
          const p = spring({ frame: frame - 14 - i * 8, fps, config: { damping: 16 } })
          const float = Math.sin((frame + i * 20) / 22) * 6
          return (
            <div
              key={tile.image}
              style={{
                width: 520, borderRadius: 24, overflow: 'hidden', background: '#0d1220',
                border: `1px solid ${COLORS.line}`, boxShadow: `0 40px 90px -20px rgba(0,0,0,0.8), 0 0 80px -30px ${tile.accent}`,
                opacity: p, transform: `translateY(${interpolate(p, [0, 1], [260, float])}px) rotateX(${interpolate(p, [0, 1], [50, 0])}deg)`,
              }}
            >
              <div style={{ height: 330, overflow: 'hidden' }}>
                <Img src={staticFile(tile.image)} style={{ width: '100%', height: '100%', objectFit: 'cover', transform: `scale(${tile.zoom + p * 0.05})`, transformOrigin: tile.focus }} />
              </div>
              <div style={{ padding: '24px 28px 30px', borderTop: `1px solid ${COLORS.line}` }}>
                <div style={{ fontSize: 34, fontWeight: 700, color: tile.accent }}>{tile.label}</div>
                <div style={{ fontSize: 24, color: COLORS.muted, marginTop: 8 }}>{tile.note}</div>
              </div>
            </div>
          )
        })}
      </div>
    </AbsoluteFill>
  )
}
