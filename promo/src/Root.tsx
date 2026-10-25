import { Composition } from 'remotion'
import { Promo } from './Promo'
import { FPS, HEIGHT, WIDTH } from './theme'
import { TOTAL_FRAMES } from './timeline'

export const Root: React.FC = () => (
  <Composition id="Promo" component={Promo} durationInFrames={TOTAL_FRAMES} fps={FPS} width={WIDTH} height={HEIGHT} />
)
