import { PromoLanguage, usePromoCopy, type PromoLocale } from './i18n'
import { linearTiming, springTiming, TransitionSeries } from '@remotion/transitions'
import { fade } from '@remotion/transitions/fade'
import { slide } from '@remotion/transitions/slide'
import { wipe } from '@remotion/transitions/wipe'
import { AbsoluteFill } from 'remotion'
import { Backdrop } from './components/Backdrop'
import { Bento } from './scenes/Bento'
import { Demo } from './scenes/Demo'
import { Developers } from './scenes/Developers'
import { Feature } from './scenes/Feature'
import { Hook } from './scenes/Hook'
import { Intro } from './scenes/Intro'
import { Outro } from './scenes/Outro'
import { COLORS, TRANSITION_FRAMES } from './theme'
import { SCENE_FRAMES } from './timeline'

const soft = springTiming({ config: { damping: 200 }, durationInFrames: TRANSITION_FRAMES })
const even = linearTiming({ durationInFrames: TRANSITION_FRAMES })

/** About 40 seconds: the promise, the real demo, what else it does, the door for developers, where to get it. */
const PromoContent: React.FC = () => {
  const copy = usePromoCopy()
  return (
  <AbsoluteFill>
    <Backdrop />
    <TransitionSeries>
      <TransitionSeries.Sequence durationInFrames={SCENE_FRAMES.intro}><Intro /></TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={fade()} timing={even} />
      <TransitionSeries.Sequence durationInFrames={SCENE_FRAMES.hook}><Hook /></TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={fade()} timing={even} />
      <TransitionSeries.Sequence durationInFrames={SCENE_FRAMES.demo}><Demo frames={SCENE_FRAMES.demo} /></TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={slide({ direction: 'from-bottom' })} timing={soft} />
      <TransitionSeries.Sequence durationInFrames={SCENE_FRAMES.bento}><Bento /></TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={wipe({ direction: 'from-right' })} timing={soft} />
      <TransitionSeries.Sequence durationInFrames={SCENE_FRAMES.approval}>
        <Feature image="approval.png" eyebrow={copy('copy21')} title={copy('copy22')} body={copy('copy23')} focus={{ x: 50, y: 70 }} side="right" accent={COLORS.orange} />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={slide({ direction: 'from-right' })} timing={soft} />
      <TransitionSeries.Sequence durationInFrames={SCENE_FRAMES.files}>
        <Feature image="files.png" eyebrow={copy('copy24')} title={copy('copy25')} body={copy('copy26')} focus={{ x: 70, y: 40 }} side="left" />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={slide({ direction: 'from-right' })} timing={soft} />
      <TransitionSeries.Sequence durationInFrames={SCENE_FRAMES.today}>
        <Feature image="home.png" eyebrow={copy('copy27')} title={copy('copy28')} body={copy('copy29')} focus={{ x: 50, y: 62 }} side="right" accent={COLORS.violet} />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={fade()} timing={even} />
      <TransitionSeries.Sequence durationInFrames={SCENE_FRAMES.developers}><Developers /></TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={fade()} timing={even} />
      <TransitionSeries.Sequence durationInFrames={SCENE_FRAMES.outro}><Outro /></TransitionSeries.Sequence>
    </TransitionSeries>
  </AbsoluteFill>
)
}
export const Promo: React.FC<{ locale: PromoLocale }> = ({ locale }) => <PromoLanguage.Provider value={locale}><PromoContent /></PromoLanguage.Provider>
