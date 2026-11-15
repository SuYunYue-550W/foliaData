import type { AudioConsoleImmersive } from '../../utils/audioConsole';
import { rampParam } from './effectParams';
import { createBassExciterBranch } from './bassExciterBranch';
import { createCrossfeedBranch } from './crossfeedBranch';
import { createOrbitBranch } from './orbitBranch';
import { createSurroundBranch } from './surroundBranch';
import { createVinylBranch } from './vinylBranch';
import { createVocalBranch } from './vocalBranch';
import { createNightBranch } from './nightBranch';
import { IMMERSIVE_CROSSFADE_SECONDS, createImmersiveNodes, disconnectImmersiveNodes, isImmersiveNeutral } from './immersiveNodes';

/**
 * 各段的通用外形：第一参数是「这一段的强度」（0 表示让路），第二参数是它自己的那份设置。
 *
 * 环绕不用这个外形（它的强度由 mode 决定，不是一个比例），单独声明。
 */
type ImmersiveBranch<TSettings> = {
    set: (level: number, settings?: TSettings) => void;
    dispose: () => void;
};

// src/services/audioEffects/immersiveChain.ts
// 沉浸音效在桌面端的总装：虚拟环绕 / 交叉馈送 / 人声增强 / 夜间模式 / 黑胶 / 8D / 超低音。
//
// 位置：接在老音效链的输出之后、音量之前 —— 与原生 EqAudioProcessor 的 ⑦½ 级同构
// （在 StereoStage 之后、ReverbStage 之前）。为什么在那儿：这七项都在改「声场」的干声部分，
// 混响要听到处理之后的声场才有意义；而饱和/压缩要的是干净的、未展开的干声
// （先展开再压缩会把串扰当成信号一起压）。
//
// 与老音效链的关系：**并列**而不是替换。老链的开关是均衡器总开关，这七项各有各的开关，
// 由调音台的「沉浸音效」页管。两条链都在信号路径上，同时打开会叠加 —— 有意的。
//
// 七项全关时：整张子图不建（`isNeutral` 判断），输出电平直通 —— 与没装这一版完全一致。

export type ImmersiveChain = {
    /** 推一份新设置；`enabled` 为 false 时整条让路（与七项全关等价）。 */
    apply: (immersive: AudioConsoleImmersive, enabled: boolean) => void;
    dispose: () => void;
};

type CreateImmersiveChainParams = {
    context: AudioContext;
    input: AudioNode;
    output: AudioNode;
};

/**
 * 建一条沉浸链。
 *
 * 各段串成一条直线（环绕 → 交叉馈送 → 人声 → 夜间 → 黑胶 → 8D → 超低音），
 * 顺序与原生 EqAudioProcessor 的 ⑦½ 级一致 —— 两端听感要对得上，顺序就不能各排一套。
 *
 * 为什么串联而不是并联：这几项每一都对「上一项的输出」有依赖 ——
 * 交叉馈送要喂宽之后的声场、人声要从展开后的中置里取、8D 要转已经处理好的那条信号。
 * 并联会让每一项都作用在原始干声上，展开与旋转互相打架。
 *
 * 实现上每段之间插一个 GainNode 作为接点：段是**懒建**的（第一次真正要用才建图），
 * 而段的输入输出在创建时就要定下来，所以接点必须提前存在。
 */
export const createImmersiveChain = ({
    context,
    input,
    output,
}: CreateImmersiveChainParams): ImmersiveChain => {
    const nodes = createImmersiveNodes(context, input, output);

    /*
     * 干声通路：nodes.input → dry → output（在 createImmersiveNodes 里接好）。
     * 湿声通路：nodes.input → 接点串 → nodes.wet → wetGain → output。
     *
     * 八个接点，每个「有输入的段」一个：
     *   taps[0] 环绕（PannerNode 通路，没有独立的「输入节点」，整条子图挂在这里）
     *   taps[1] 交叉馈送
     *   taps[2] 人声（sidechain 也要从这里取信号，所以输入与输出分开两个接点）
     *   taps[3] 夜间
     *   taps[4] 黑胶
     *   taps[5] 8D
     *   taps[6] 超低音
     *   taps[7] 汇总（最后一段的输出倒进 nodes.wet）
     *
     * 段是懒建的（第一次真正要用才建图），而段的输入输出在创建时就要定下来，
     * 所以接点必须提前存在 —— 这也是为什么这里先把整串接点铺好。
     */
    const taps: GainNode[] = [];
    let cursor: AudioNode = nodes.input;
    for (let index = 0; index < 8; index += 1) {
        const tap = context.createGain();
        cursor.connect(tap);
        cursor = tap;
        taps.push(tap);
    }
    // 最后一段的输出倒进 wet，再由 wetGain 决定整条湿声通路的量。
    cursor.connect(nodes.wet);

    const surround = createSurroundBranch(context, taps[0]);
    const crossfeed: ImmersiveBranch<AudioConsoleImmersive['crossfeed']> = createCrossfeedBranch(context, taps[1]);
    const vocal: ImmersiveBranch<AudioConsoleImmersive['vocal']> = createVocalBranch(context, taps[2], taps[3]);
    const night: ImmersiveBranch<AudioConsoleImmersive['night']> = createNightBranch(context, taps[3], taps[4]);
    const vinyl: ImmersiveBranch<AudioConsoleImmersive['vinyl']> = createVinylBranch(context, taps[4], taps[5]);
    const orbit: ImmersiveBranch<AudioConsoleImmersive['orbit']> = createOrbitBranch(context, taps[5], taps[6]);
    const bass: ImmersiveBranch<AudioConsoleImmersive['bass']> = createBassExciterBranch(context, taps[6], taps[7]);

    const apply = (immersive: AudioConsoleImmersive, enabled: boolean) => {
        const neutral = !enabled || isImmersiveNeutral(immersive);

        if (neutral) {
            // 整条链只留干声：湿声归零、干声回满，各段自己的 fade 会把节点陆续释放。
            rampParam(context, nodes.wetGain.gain, 0, IMMERSIVE_CROSSFADE_SECONDS);
            rampParam(context, nodes.dry.gain, 1, IMMERSIVE_CROSSFADE_SECONDS);
            surround.set(null);
            crossfeed.set(0);
            vocal.set(0);
            night.set(0);
            vinyl.set(0);
            orbit.set(0);
            bass.set(0);
            return;
        }

        /*
         * 只要有一项开着，就做一次干湿交叉：湿声起来、干声让路。
         *
         * 两路同时为 1 是并联相加，同相成分直接多出 6 dB（离线渲染实测：0.30 峰值的正弦
         * 开环绕后变成 0.60），所以湿声必须替换干声而不是叠加。
         *
         * 但**不能各取 0.707**：湿声通路里已经包含一份完整的干声（每段都是「原信号 + 处理量」），
         * 干声 0.707 + 湿声 0.707 相加还是 1.414，等于 +3 dB。实测确是如此：同样的正弦
         * 未开时 RMS 0.1768，开任一效果后 0.2497。
         * 这里让两路严格互补：湿声 1、干声 0 —— 湿声通路自己会保留原信号。
         */
        rampParam(context, nodes.dry.gain, 0, IMMERSIVE_CROSSFADE_SECONDS);
        rampParam(context, nodes.wetGain.gain, 1, IMMERSIVE_CROSSFADE_SECONDS);

        surround.set(immersive.surround);
        crossfeed.set(immersive.crossfeed.enabled ? 1 : 0, immersive.crossfeed);
        vocal.set(immersive.vocal.enabled ? 1 : 0, immersive.vocal);
        night.set(immersive.night.enabled ? 1 : 0, immersive.night);
        vinyl.set(immersive.vinyl.enabled ? 1 : 0, immersive.vinyl);
        orbit.set(immersive.orbit.enabled ? 1 : 0, immersive.orbit);
        bass.set(immersive.bass.enabled ? 1 : 0, immersive.bass);
    };

    return {
        apply,
        dispose: () => {
            surround.dispose();
            crossfeed.dispose();
            vocal.dispose();
            night.dispose();
            vinyl.dispose();
            orbit.dispose();
            bass.dispose();
            taps.forEach(tap => tap.disconnect());
            disconnectImmersiveNodes(nodes);
        },
    };
};
