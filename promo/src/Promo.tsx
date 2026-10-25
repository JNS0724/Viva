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
export const Promo: React.FC = () => (
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
        <Feature image="approval.png" eyebrow="动手前先问你" title="会改东西的，先给你看" body="要跑的命令、要动的文件写在卡片上，你允许了才做。" focus={{ x: 50, y: 70 }} side="right" accent={COLORS.orange} />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={slide({ direction: 'from-right' })} timing={soft} />
      <TransitionSeries.Sequence durationInFrames={SCENE_FRAMES.files}>
        <Feature image="files.png" eyebrow="文件就在手边" title="改了什么，一眼看清" body="工作目录里的文件、表格和 Markdown 直接预览。" focus={{ x: 70, y: 40 }} side="left" />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={slide({ direction: 'from-right' })} timing={soft} />
      <TransitionSeries.Sequence durationInFrames={SCENE_FRAMES.today}>
        <Feature image="home.png" eyebrow="今天" title="回到电脑前，先看一眼今天" body="准备好几件、几条消息要你看，都还没动，等你点头。" focus={{ x: 50, y: 62 }} side="right" accent={COLORS.violet} />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={fade()} timing={even} />
      <TransitionSeries.Sequence durationInFrames={SCENE_FRAMES.developers}><Developers /></TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={fade()} timing={even} />
      <TransitionSeries.Sequence durationInFrames={SCENE_FRAMES.outro}><Outro /></TransitionSeries.Sequence>
    </TransitionSeries>
  </AbsoluteFill>
)
