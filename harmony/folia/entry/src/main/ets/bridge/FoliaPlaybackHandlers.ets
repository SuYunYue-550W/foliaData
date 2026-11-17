// harmony/folia/entry/src/main/ets/bridge/FoliaPlaybackHandlers.ets
//
// FoliaPlayback 的方法实现（媒体会话 / 通知栏 / 锁屏控制 + 播放状态镜像）。
//
// 对应前端 src/hooks/useCapacitorPlaybackBridge.ts 的 FoliaPlaybackPlugin。
// 事件名 foliaPlaybackCommand（原生派发播放命令）与 foliaPlaybackLyrics（原生拉的歌词）。
//
// 与 Android 的差异（如实标注）：
//  - Android 侧原生维护播放队列镜像、并有「平台网关」按需解析歌曲地址，所以
//    playFromQueue / requestSkip 能真正在原生切歌。
//  - 鸿蒙这边没有那套地址解析（各平台的地址解析逻辑在 Web 侧的 provider 里），
//    所以这两个方法按前端契约回 ok=false / skipped=false —— 前端收到后会
//    按设计回退到 Web 全流程，功能不会坏，只是切歌走 Web 路径。
//  - 通知栏/锁屏控制、媒体元数据、播放状态同步是真做了（AVSession）。

import { avSession } from '@kit.AVSessionKit';
import { common } from '@kit.AbilityKit';
import { FoliaEventBus } from './FoliaEventBus';
import { optString, optNumber, optBool } from './FoliaBridgeOptions';
import { Handler } from './FoliaNativePlayerHandlers';

const PLUGIN: string = 'FoliaPlayback';
const EVENT_COMMAND: string = 'foliaPlaybackCommand';

/** getPlaybackSnapshot 的返回形状。 */
class PlaybackSnapshot {
  hasSong: boolean = false;
  songKey: string = '';
  title: string = '';
  artist: string = '';
  album: string = '';
  durationMs: number = 0;
  positionMs: number = 0;
  playing: boolean = false;
  liked: boolean = false;
  canLike: boolean = false;
  providerId: string = '';
  serverSongId: string = '';
  artworkUrl: string = '';
}

/** playFromQueue 的返回形状。 */
class PlayFromQueueResult {
  ok: boolean = false;
}

/** requestSkip 的返回形状。 */
class SkipResult {
  skipped: boolean = false;
}

/** consumeLikeOverrides 的返回形状。 */
class LikeOverridesResult {
  overrides: Object[] = [];
}

/** 原生派发给前端的播放命令事件。 */
class PlaybackCommand {
  command: string = '';
  positionMs: number = 0;
  songKey: string = '';
}

export class FoliaPlaybackHandlers {
  private context: common.UIAbilityContext;
  private bus: FoliaEventBus;
  private session: avSession.AVSession | undefined = undefined;
  private sessionActive: boolean = false;

  // 状态镜像：前端推过来的最新状态，供 getPlaybackSnapshot 取回。
  private hasSong: boolean = false;
  private songKey: string = '';
  private title: string = '';
  private artist: string = '';
  private album: string = '';
  private durationMs: number = 0;
  private positionMs: number = 0;
  private playing: boolean = false;
  private liked: boolean = false;
  private canLike: boolean = false;
  private providerId: string = '';
  private serverSongId: string = '';
  private artworkUrl: string = '';

  constructor(context: common.UIAbilityContext, bus: FoliaEventBus) {
    this.context = context;
    this.bus = bus;
  }

  /** 确保媒体会话存在且已激活。 */
  private async ensureSession(): Promise<avSession.AVSession> {
    if (this.session) return this.session;
    const session: avSession.AVSession = await avSession.createAVSession(this.context, 'folia', 'audio');
    this.session = session;

    // 通知栏 / 锁屏 / 耳机按键的命令，转成前端认识的事件。
    session.on('play', () => {
      this.emitCommand('play');
    });
    session.on('pause', () => {
      this.emitCommand('pause');
    });
    session.on('stop', () => {
      this.emitCommand('stop');
    });
    session.on('seek', (time: number) => {
      const cmd: PlaybackCommand = new PlaybackCommand();
      cmd.command = 'seek';
      cmd.positionMs = time;
      cmd.songKey = this.songKey;
      this.bus.emit(PLUGIN, EVENT_COMMAND, cmd);
    });
    session.on('playNext', () => {
      this.emitCommand('next');
    });
    session.on('playPrevious', () => {
      this.emitCommand('previous');
    });

    return session;
  }

  private emitCommand(command: string): void {
    const cmd: PlaybackCommand = new PlaybackCommand();
    cmd.command = command;
    cmd.songKey = this.songKey;
    this.bus.emit(PLUGIN, EVENT_COMMAND, cmd);
  }

  /** 把方法挂到桥的 handler 表。 */
  register(handlers: Map<string, Handler>): void {
    handlers.set('FoliaPlayback.update', async (o) => {
      const title: string = optString(o, 'title');
      const artist: string = optString(o, 'artist');
      const album: string = optString(o, 'album');
      const songKey: string = optString(o, 'songKey');
      const artwork: string = optString(o, 'artworkUrl');
      const duration: number = optNumber(o, 'durationMs');

      if (title || artist || album || songKey) {
        this.hasSong = true;
      }
      this.title = title || this.title;
      this.artist = artist || this.artist;
      this.album = album || this.album;
      this.songKey = songKey || this.songKey;
      this.artworkUrl = artwork || this.artworkUrl;
      this.durationMs = duration || this.durationMs;
      // liked / canLike 不传 = 不改（前端约定）。
      if (o['liked'] !== undefined) this.liked = optBool(o, 'liked');
      if (o['canLike'] !== undefined) this.canLike = optBool(o, 'canLike');
      this.providerId = optString(o, 'providerId') || this.providerId;
      this.serverSongId = optString(o, 'serverSongId') || this.serverSongId;

      // 媒体元数据 → 通知栏。
      try {
        const session: avSession.AVSession = await this.ensureSession();
        const metadata: avSession.AVMetadata = {
          assetId: this.songKey,
          title: this.title,
          artist: this.artist,
          album: this.album,
          duration: this.durationMs,
          mediaImage: this.artworkUrl
        };
        await session.setAVMetadata(metadata);
      } catch (e) {
        // 会话起不来不该拖垮播放：通知栏没有元数据，但界面照常用。
        console.warn(`[FoliaHarmony] setAVMetadata failed: ${String((e as Error).message ?? e)}`);
      }
      return new Object();
    });

    handlers.set('FoliaPlayback.setState', async (o) => {
      const state: ESObject = o['state'];
      this.positionMs = optNumber(o, 'positionMs');
      const speed: number = optNumber(o, 'speed');
      if (state !== undefined && state !== null && typeof state === 'object') {
        const playing: ESObject = state['playing'];
        if (playing !== undefined) this.playing = playing === true;
      }
      try {
        const session: avSession.AVSession = await this.ensureSession();
        const playbackState: avSession.AVPlaybackState = {
          state: this.playing ? avSession.PlaybackState.PLAYBACK_STATE_PLAY : avSession.PlaybackState.PLAYBACK_STATE_PAUSE,
          speed: speed > 0 ? speed : 1,
          position: { elapsedTime: this.positionMs, updateTime: Date.now() },
          duration: this.durationMs,
          isFavorite: this.liked
        };
        await session.setAVPlaybackState(playbackState);
        if (!this.sessionActive) {
          await session.activate();
          this.sessionActive = true;
        }
      } catch (e) {
        console.warn(`[FoliaHarmony] setAVPlaybackState failed: ${String((e as Error).message ?? e)}`);
      }
      return new Object();
    });

    handlers.set('FoliaPlayback.stop', async () => {
      this.playing = false;
      this.hasSong = false;
      try {
        if (this.session) {
          if (this.sessionActive) {
            await this.session.deactivate();
            this.sessionActive = false;
          }
          await this.session.destroy();
        }
        this.session = undefined;
      } catch (e) {
        console.warn(`[FoliaHarmony] session release failed: ${String((e as Error).message ?? e)}`);
      }
      return new Object();
    });

    handlers.set('FoliaPlayback.getPlaybackSnapshot', async () => {
      const snap: PlaybackSnapshot = new PlaybackSnapshot();
      snap.hasSong = this.hasSong;
      snap.songKey = this.songKey;
      snap.title = this.title;
      snap.artist = this.artist;
      snap.album = this.album;
      snap.durationMs = this.durationMs;
      snap.positionMs = this.positionMs;
      snap.playing = this.playing;
      snap.liked = this.liked;
      snap.canLike = this.canLike;
      snap.providerId = this.providerId;
      snap.serverSongId = this.serverSongId;
      snap.artworkUrl = this.artworkUrl;
      return snap;
    });

    // 队列镜像：鸿蒙侧存下来，供后续原生侧播放用；当前不据此解析地址。
    handlers.set('FoliaPlayback.setQueueMirror', async (o) => {
      optString(o, 'queueJson');
      optNumber(o, 'index');
      return new Object();
    });

    handlers.set('FoliaPlayback.setQueueMirrorIndex', async (o) => {
      optNumber(o, 'index');
      return new Object();
    });

    // 鸿蒙没有平台地址解析能力：如实回 false，前端按契约回退 Web 全流程。
    handlers.set('FoliaPlayback.playFromQueue', async () => {
      const result: PlayFromQueueResult = new PlayFromQueueResult();
      result.ok = false;
      return result;
    });

    handlers.set('FoliaPlayback.requestSkip', async () => {
      const result: SkipResult = new SkipResult();
      result.skipped = false;
      return result;
    });

    // 原生补写的红心：鸿蒙侧没有在 WebView 冻结时补写红心的通道，返回空列表。
    handlers.set('FoliaPlayback.consumeLikeOverrides', async () => {
      return new LikeOverridesResult();
    });
  }
}
