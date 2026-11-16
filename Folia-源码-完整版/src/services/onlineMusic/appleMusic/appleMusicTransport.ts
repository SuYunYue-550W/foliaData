import { OnlineProviderError } from '../../../types/onlineMusic';
import type { ProviderAvailability, ProviderErrorCode } from '../../../types/onlineMusic';
import { isCapacitorAndroid } from '../../../platform/runtime';

// The provider's sole renderer-side boundary to the isolated desktop companion.
// The queue is Folia's: no next/previous of the companion's own.
export type AppleMusicOperation = 'showWindow' | 'hideWindow' | 'logout' | 'accountStatus' | 'search' | 'playlists' | 'playlistTracks' | 'playlistTrackCount' | 'lyrics'
    | 'songOriginal' | 'catalogSong' | 'catalogAlbum' | 'catalogAlbumTracks' | 'catalogArtist' | 'catalogArtistSongs' | 'catalogArtistAlbums' | 'libraryAlbums' | 'librarySongs' | 'libraryAlbumTracks' | 'stations' | 'station' | 'playStation' | 'personalFm' | 'addPlaylistTracks' | 'likeSong' | 'prepareNext' | 'playbackStatus' | 'playSong' | 'pause' | 'resume' | 'seek' | 'setVolume' | 'setRepeatOne';
export type AppleMusicParams = Record<string, string | number | boolean | string[] | undefined>;
export type AppleMusicBridgeResult =
    | { ok: true; data: unknown }
    | { ok: false; error: string; httpStatus?: number | null; playbackStage?: string };

// macOS and Windows ship the system-WebView host (WKWebView / WebView2 Evergreen). Android carries
// the same brain inside its own native WebView (android/appleMusicAndroidBridge.ts). Linux stays
// visible with a provider-owned explanation, and the plain web has no host at all.
export const getAppleMusicTransportAvailability = (): ProviderAvailability => {
    const bridge = typeof window !== 'undefined' ? window.electron : undefined;
    if (typeof bridge?.appleMusicRequest === 'function') {
        if (bridge.platform === 'darwin' || bridge.platform === 'win32') return { configured: true };
        if (bridge.platform === 'linux') return { configured: false, reason: 'not-configured', messageKey: 'home.appleMusicLinuxUnsupported' };
        return { configured: false, reason: 'runtime-unavailable' };
    }
    if (isCapacitorAndroid()) return { configured: true };
    return { configured: false, reason: 'runtime-unavailable' };
};

// Translate protocol failures into the common provider error without copying credentials or response bodies.
const errorCode = (error: string): ProviderErrorCode => {
    if (error === 'auth-required') return 'auth-required';
    if (error === 'invalid-response' || error === 'invalid-request') return 'invalid-response';
    if (error === 'unsupported') return 'unsupported';
    // The page had the track but refused to play it: not a network failure, and retrying it at once is pointless.
    if (error === 'playback-failed') return 'not-playable';
    if (error === 'timeout' || error === 'disconnected' || error === 'request-failed') return 'network';
    return 'unavailable';
};

export async function requestAppleMusic<T>(operation: AppleMusicOperation, params: AppleMusicParams = {}): Promise<T> {
    // 桌面走 Electron 的 IPC；安卓走原生宿主桥；两头共用同一套操作与返回形状。
    const desktopRequest = typeof window !== 'undefined' ? window.electron?.appleMusicRequest : undefined;
    if (!desktopRequest && !isCapacitorAndroid()) {
        throw new OnlineProviderError('unavailable', 'Apple Music companion is unavailable', 'appleMusic');
    }
    let result: AppleMusicBridgeResult;
    try {
        if (desktopRequest) {
            result = await desktopRequest(operation, params);
        } else {
            const { requestAppleMusicOnAndroid } = await import('./android/appleMusicAndroidBridge');
            result = await requestAppleMusicOnAndroid(operation, params);
        }
    } catch (error) {
        console.warn('[AppleMusic] Desktop request failed', error);
        throw new OnlineProviderError('network', 'Apple Music companion request failed', 'appleMusic');
    }
    if (!result.ok) {
        // Only fixed stage names enter the error; never forward remote exception text or URLs.
        const stages = ['prepared-queue', 'configure', 'queue', 'play', 'seek'];
        const stage = result.error === 'playback-failed' && stages.includes(result.playbackStage ?? '') ? result.playbackStage : undefined;
        throw new OnlineProviderError(errorCode(result.error), `Apple Music companion request failed${stage ? ` (stage: ${stage})` : ''}`, 'appleMusic', result.error, result.httpStatus ?? undefined);
    }
    return result.data as T;
}
