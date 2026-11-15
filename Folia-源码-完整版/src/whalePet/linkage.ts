// 桌宠联动扩展（鼓点起舞 / 歌词气泡 / 久坐提醒）的运行时壳：
//   - 只读订阅 usePlaybackStore（歌词行变化 / 播放状态），不写任何 store；
//   - 节拍来源：src/services/beatFx/beatFxLive.ts 的拍点计数器
//     `getBeatFxFiredCounts()`——它由 usePlaybackVisualizerBridge 的帧循环在
//     智能动感模式开启时驱动（beat_this 的拍点，含重音/无节奏小节过滤）。
//     智能动感模式没开（或该曲目没有拍点）时计数不增长，桌宠就安静待着——
//     不硬造假节拍器。也不自己另跑 beat_this：那是 GPU 秒级的推理，
//     为桌宠蹦一下单独跑不划算。
//   - 鼓点动作：每拍触发 pet.pulse()（stage 的轻微 scale 脉冲，见 pet.js），
//     而不是切 happy_hop 动画——catalog 里 happy_hop（开心跃动）确实像"蹦一下"，
//     但 pet.js 对同一动画重复 play 会去重不重启，每拍换动画还会打断跳舞的
//     双缓冲淡切、造成解码抖动；脉冲既短促又不破坏当前舞蹈。
//
// 生命周期：ensureWhalePet 创建实例后 attach，pet.destroy 时 detach；
// 桌宠关闭或某项开关关闭时对应订阅/循环不跑（拍点 RAF 循环只在
// 门控全开时启动，久坐 interval 常驻但每 tick 都先看门控，开销一个布尔判断）。
import i18n from '../i18n/config';
import { usePlaybackStore, selectDisplayLyrics, selectDisplayPlayerState } from '../stores/usePlaybackStore';
import { PlayerState } from '../types';
import { getBeatFxFiredCounts } from '../services/beatFx/beatFxLive';
import {
    SittingReminderTracker,
    shouldHopOnBeat,
    shouldShowLyricBubble,
    shouldTrackSitting,
    truncateLyricText,
} from './linkageLogic';
import type { WhalePetInstance } from './init';

/** 同一拍点最多多久蹦一次（ms）：超过 ~180 BPM 时合并连续拍。 */
const BEAT_HOP_MIN_INTERVAL_MS = 300;
/** 久坐计时的轮询粒度（ms）。 */
const SITTING_TICK_MS = 30_000;

interface PetLikeForLinkage extends WhalePetInstance {
    showTip?: (text: string) => void;
    pulse?: () => void;
}

let detachLinkage: (() => void) | null = null;

/** 把三项联动挂到桌宠实例上（幂等：先退订旧的）。 */
export function attachWhalePetLinkage(pet: PetLikeForLinkage): void {
    detachLinkage?.();

    let playing = false;
    let rafId = 0;
    let lastSeenBeats = getBeatFxFiredCounts().beats;
    let lastHopAt = 0;

    // ---- 鼓点起舞：RAF 循环只在门控全开时跑 ----
    const hopLoop = () => {
        rafId = 0;
        if (!shouldHopOnBeat(pet.settings, playing)) return;
        const counts = getBeatFxFiredCounts();
        const now = Date.now();
        if (counts.beats > lastSeenBeats && now - lastHopAt >= BEAT_HOP_MIN_INTERVAL_MS) {
            lastHopAt = now;
            pet.pulse?.();
        }
        lastSeenBeats = counts.beats;
        rafId = requestAnimationFrame(hopLoop);
    };
    const syncBeatLoop = () => {
        const want = shouldHopOnBeat(pet.settings, playing);
        if (want && !rafId) {
            lastSeenBeats = getBeatFxFiredCounts().beats;
            rafId = requestAnimationFrame(hopLoop);
        } else if (!want && rafId) {
            cancelAnimationFrame(rafId);
            rafId = 0;
        }
    };

    // ---- 歌词气泡：只读订阅，行变化才动作 ----
    let lastLineIndex = -2;   // -1（无词）也值得与 -2 区分，避免停词时残留旧句
    const unsubscribePlayback = usePlaybackStore.subscribe((state) => {
        playing = selectDisplayPlayerState(state) === PlayerState.PLAYING;

        if (shouldShowLyricBubble(pet.settings, playing)) {
            const index = state.currentLineIndex;
            if (index !== lastLineIndex) {
                lastLineIndex = index;
                const line = index >= 0 ? selectDisplayLyrics(state)?.lines[index] : undefined;
                const text = line?.fullText;
                if (text) pet.showTip?.(truncateLyricText(text));
            }
        } else {
            lastLineIndex = -2;
        }

        syncBeatLoop();
    });

    // ---- 久坐提醒：暂停不重置，只在播放时累计 ----
    const tracker = new SittingReminderTracker(pet.settings.sittingReminderMin ?? 45);
    const sittingTimer = setInterval(() => {
        tracker.setIntervalMinutes(pet.settings.sittingReminderMin ?? 45);
        if (!shouldTrackSitting(pet.settings) || !playing) return;
        if (tracker.tick(SITTING_TICK_MS, true)) {
            pet.showTip?.(i18n.t('whalePet.sittingReminderTip'));
        }
    }, SITTING_TICK_MS);

    detachLinkage = () => {
        if (rafId) cancelAnimationFrame(rafId);
        rafId = 0;
        clearInterval(sittingTimer);
        unsubscribePlayback();
        detachLinkage = null;
    };
}

/** 卸载三项联动（pet.destroy 前调用；幂等）。 */
export function detachWhalePetLinkage(): void {
    detachLinkage?.();
}
