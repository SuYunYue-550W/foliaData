// src/services/onlineMusic/omni/externalPlaybackMethods.ts
// [apple-music] 上游主线把这些方法写在单文件 omni.ts 里；本 fork 的 omni 是按能力分组拼装的，
// 所以单独成一个模块，由 omni.ts 展开进去。实现与上游 v0.7.28 一致，辅助函数复用本仓库的
// providerCalls.ts，避免复制一份请求/失败封装。

import type { SongResult } from '../../../types';
import type { ProviderExternalPlaybackStatus } from '../../../types/onlineMusic';
import { canPlaySongExternally, getOnlineMusicProviderForSong } from '../providerRegistry';
import { providerForSong, runRequest, unsupported } from './providerCalls';

export const externalPlaybackMethods = {
    canPlayExternally(song: SongResult): boolean {
        return canPlaySongExternally(song);
    },

    async playSongExternally(song: SongResult, startSec = 0): Promise<void> {
        const provider = providerForSong(song);
        if (!provider.externalPlayback) return unsupported(provider.id, 'externalPlayback');
        await runRequest(provider, 'audio', () => provider.externalPlayback!.play(song, startSec));
    },

    /** A window rebuild keeps the player sounding: adopt it instead of starting it again. */
    adoptExternalPlayback(song: SongResult): void {
        getOnlineMusicProviderForSong(song)?.externalPlayback?.adopt?.(song);
    },

    isExternalPlaybackPrepared(song: SongResult): boolean {
        return getOnlineMusicProviderForSong(song)?.externalPlayback?.isPrepared?.(song) === true;
    },

    async prepareExternalPlaybackQueue(song: SongResult, upcoming: SongResult[]): Promise<void> {
        const provider = providerForSong(song);
        if (!provider.externalPlayback?.prepareNext) return;
        await runRequest(provider, 'audio', () => provider.externalPlayback!.prepareNext!(song, upcoming));
    },

    async pauseExternalPlayback(song: SongResult): Promise<void> {
        const provider = providerForSong(song);
        if (!provider.externalPlayback) return unsupported(provider.id, 'externalPlayback');
        await runRequest(provider, 'audio', () => provider.externalPlayback!.pause());
    },

    async resumeExternalPlayback(song: SongResult): Promise<void> {
        const provider = providerForSong(song);
        if (!provider.externalPlayback) return unsupported(provider.id, 'externalPlayback');
        await runRequest(provider, 'audio', () => provider.externalPlayback!.resume());
    },

    async seekExternalPlayback(song: SongResult, seconds: number): Promise<void> {
        const provider = providerForSong(song);
        if (!provider.externalPlayback) return unsupported(provider.id, 'externalPlayback');
        await runRequest(provider, 'audio', () => provider.externalPlayback!.seek(seconds));
    },

    /** A player without its own level control is left alone: the call is a no-op, not an error. */
    async setExternalPlaybackVolume(song: SongResult, volume: number): Promise<void> {
        const provider = providerForSong(song);
        if (!provider.externalPlayback?.setVolume) return;
        await runRequest(provider, 'audio', () => provider.externalPlayback!.setVolume!(volume));
    },

    async setExternalPlaybackRepeatOne(song: SongResult, enabled: boolean): Promise<void> {
        const provider = providerForSong(song);
        const player = provider.externalPlayback;
        if (!player?.setRepeatOne) return;
        await runRequest(provider, 'audio', () => player.setRepeatOne?.(enabled) ?? Promise.resolve());
    },

    async getExternalPlaybackStatus(song: SongResult): Promise<ProviderExternalPlaybackStatus> {
        const provider = providerForSong(song);
        if (!provider.externalPlayback) return unsupported(provider.id, 'externalPlayback');
        return await runRequest(provider, 'audio', () => provider.externalPlayback!.getStatus(song));
    },

    isExternalPlaybackStatusForSong(song: SongResult, status: ProviderExternalPlaybackStatus): boolean {
        return getOnlineMusicProviderForSong(song)?.externalPlayback?.isStatusForSong(song, status) === true;
    },
};
