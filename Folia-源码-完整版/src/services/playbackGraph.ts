import { connectAudioEqualizerGraph } from './audioEqualizerGraph';
import { createAudioEffectChain, type AudioEffectChain } from './audioEffects/effectChain';
import { createImmersiveChain, type ImmersiveChain } from './audioEffects/immersiveChain';
import { createKaraokeBranch, type KaraokeBranch } from './audioEffects/karaokeBranch';
import type { AudioEqualizerSettings } from '../utils/audioEqualizer';
import type { AudioConsoleImmersive } from '../utils/audioConsole';
import type { KaraokeMode } from '../stores/useKaraokeModeStore';
import { DEFAULT_AUDIO_CONSOLE_SETTINGS } from '../utils/audioConsole';

// src/services/playbackGraph.ts
// The order the playback nodes are wired in, as one function so the order can be asserted.
//
// This lived inline in usePlaybackAudioBridge, where nothing could reach it: testing it meant
// rendering the hook, and the alternative - a test that rebuilds the same wiring - would have
// passed no matter what the hook did. The order matters enough to be worth reaching (see the
// volume note below), so it moved here and the hook now only owns the refs.

type BuildPlaybackGraphParams = {
    context: AudioContext;
    /** Where the mix lands. Everything downstream of here is per-listener, not per-track. */
    analyser: AnalyserNode;
    /** Wires both automix decks into the shared mix point. Returns false if a deck is missing. */
    connectDecks: (context: AudioContext, output: AudioNode) => boolean;
    equalizerNodesRef: { current: BiquadFilterNode[] };
    settings: AudioEqualizerSettings;
    /** 沉浸音效（调音台的第六页）。缺省视为七项全关。 */
    immersive?: AudioConsoleImmersive;
    /** 伴唱模式档位。缺省「关」，链路直通。 */
    karaoke?: KaraokeMode;
};

export type PlaybackGraph = {
    /** Playback volume. Ramped by syncOutputGain; nothing else may write it. */
    gainNode: GainNode;
    /**
     * Play/pause fade, unity at rest. Its own node because the volume node is rewritten by
     * syncOutputGain on every volume, mute and track start, and the deck gains belong to automix.
     * Owned by services/playbackFade; nothing else may write it.
     */
    fadeNode: GainNode;
    effectChain: AudioEffectChain;
    /** 沉浸音效子图：环绕 / 交叉馈送 / 人声 / 夜间 / 黑胶 / 8D / 超低音。 */
    immersiveChain: ImmersiveChain;
    /** 伴唱模式子图：伴奏（人声消除）/ 人声独唱 / 直通。 */
    karaokeBranch: KaraokeBranch;
    /** False when a deck was missing, so automix will stay idle. Audio still flows. */
    decksConnected: boolean;
};

export const buildPlaybackGraph = ({
    context,
    analyser,
    connectDecks,
    equalizerNodesRef,
    settings,
    immersive,
    karaoke = 'off',
}: BuildPlaybackGraphParams): PlaybackGraph => {
    // The shared mix point. Both decks land here, so the equaliser and the analyser each exist
    // once and see the sum: the tone never steps mid-blend and the visualiser draws what is
    // actually being heard.
    const mixNode = context.createGain();
    const decksConnected = connectDecks(context, mixNode);

    // Keeps a stable seam between the equalizer bands and the effect chain.
    const equalizerOutput = context.createGain();
    connectAudioEqualizerGraph({
        context,
        input: mixNode,
        output: equalizerOutput,
        nodesRef: equalizerNodesRef,
        settings,
    });

    /**
     * Volume, and it sits AFTER the effects rather than at the mix point where it started.
     *
     * Three of the effects are absolute rather than relative, so a fader upstream of them changes
     * what they DO instead of how loud they are. Measured through the real chain with an
     * OfflineAudioContext, before and after this moved:
     *
     * - Vinyl noise is mixed into the chain OUTPUT, so upstream of it the fader never touched it
     *   at all: -51.9 dBFS of crackle at volume 1.00, 0.50 and 0.25 alike. Turning the music down
     *   turned the record hiss UP relative to it, 6 dB per halving, and there was no volume at
     *   which the crackle could be made quiet. Downstream: -51.8 / -57.9 / -64.0 dBFS.
     * - Bit crush quantizes on a fixed staircase, so its step is a fixed fraction of FULL scale.
     *   Fed an attenuated signal it eats a bigger share of it: one -12 dBFS tone came back at
     *   38.2 dB SNR at volume 1.00 but 25.8 dB at 0.25 - a bit depth that dropped by two bits
     *   because somebody moved a slider that is not its own. Downstream: 38.2 dB at every volume.
     * - Punch is a compressor with a fixed threshold, so quieter input simply stopped reaching it.
     *
     * With every effect neutral the two orders measure identically (82.6 dB SNR either way), so
     * this is inaudible to anyone who leaves the effects off.
     */
    const immersiveIn = context.createGain();
    const immersiveOut = context.createGain();
    const gainNode = context.createGain();

    const effectChain = createAudioEffectChain({
        context,
        input: equalizerOutput,
        output: immersiveIn,
        effects: settings.effects,
        enabled: settings.enabled,
    });

    /*
     * 沉浸音效接在「老音效之后、音量之前」—— 与原生 EqAudioProcessor 的 ⑦½ 级同一个位置
     * （StereoStage 之后、ReverbStage 之前）。两个理由，缺一不可：
     *
     *   · 在音量之前：这七项里有三项是「绝对」而不是「相对」的 —— 夜间模式的 AGC 往一个
     *     固定目标响度拉、超低音的激励量是固定增益、人声增强的激活阈值是一条固定 dBFS 线。
     *     把它们放在音量之后，用户调小音量就等于改掉它们的工作点，而不是改响度。
     *     上面那段注释里踩过的坑，这里不再踩第二遍。
     *   · 在老音效之后：黑胶与混响都要「听到」展开后的声场，与人声/8D 的先后也才对得上。
     *
     * 接线：效果链 → immersiveIn → 沉浸子图 → immersiveOut → 音量。
     * 以前这里把 input 与 output 都传成 gainNode（自我闭环），子图的干声直接从 input 绕到
     * output，音量节点与子图成了同一个点 —— 音量调不动那条干声。现在两端分开。
     */
    const immersiveChain = createImmersiveChain({
        context,
        input: immersiveIn,
        output: immersiveOut,
    });
    immersiveChain.apply(immersive ?? DEFAULT_AUDIO_CONSOLE_SETTINGS.immersive, true);

    /*
     * 伴唱（中/侧路由）串在沉浸子图之后、音量之前：它改的是声场的构成而不是
     * 响度，放音量之前与沉浸那三项「绝对效果」同一个道理。串（而不是并联）
     * 保住了「音量只有一条进边」的图形状，切换档位只动三颗增益，无缝。
     */
    const karaokeBranch = createKaraokeBranch(context, immersiveOut, gainNode);
    karaokeBranch.apply(karaoke);

    // After the volume so the fade multiplies whatever level the listener chose, and before the
    // analyser so the visualiser fades with the sound.
    const fadeNode = context.createGain();
    gainNode.connect(fadeNode);

    // The analyser stays last, so the visualiser draws what is actually being heard - including
    // the volume the listener set.
    fadeNode.connect(analyser);
    analyser.connect(context.destination);

    // Once per audio context. Printed rather than assumed because the ORDER is the fix: if this
    // ever reads "volume" before "effects" again, the vinyl noise has stopped answering the
    // volume control and the bit crush has gone back to tracking it.
    console.log(
        '[AudioContext] graph: decks -> mix -> equaliser -> effects -> immersive -> karaoke -> volume -> fade -> analyser -> out'
        + ` (equaliser ${settings.enabled ? 'on' : 'flat'},`
        + ` noise ${settings.effects.noise}, crush ${settings.effects.crush}, punch ${settings.effects.punch})`,
    );

    return { gainNode, fadeNode, effectChain, immersiveChain, karaokeBranch, decksConnected };
};
