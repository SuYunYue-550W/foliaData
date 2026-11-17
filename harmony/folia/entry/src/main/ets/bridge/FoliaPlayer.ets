// harmony/folia/entry/src/main/ets/bridge/FoliaPlayer.ets
//
// 原生播放内核：HarmonyOS AVPlayer 的封装。
//
// 对应前端的 src/services/playbackEngine/nativePlayerPlugin.ts（FoliaNativePlayerPlugin）。
// 方法名、事件名（foliaNativePlayer）、字段名改一处两边都要改。
//
// 能力边界（鸿蒙 SDK 没有对应 API 的，如实说明而不是假装支持）：
//  - 均衡器 / 频谱 / 音频快照：AVPlayer 没有 FFT 与快照接口，鸿蒙侧不做；
//    前端会收到明确的 unsupported 错误，不会静默返回假数据。
//  - 音量：AVPlayer 的 setVolume 是相对音量（0.00~1.00），与 Android 的绝对音量不同，
//    这里按相对音量处理，并在实现类里做映射。

import { media } from '@kit.MediaKit';

/** 前端 NativePlaybackEvent 的形状（nativePlayerPlugin.ts）。 */
export class NativePlaybackEvent {
  type: string = 'idle';
  positionMs: number = 0;
  durationMs: number = 0;
  message: string = '';
  songKey: string = '';
  playing: boolean = false;
  buffering: boolean = false;
}

/** 前端 NativePlaybackSnapshot 的形状。 */
export class NativePlaybackSnapshot {
  positionMs: number = 0;
  durationMs: number = 0;
  playing: boolean = false;
  buffering: boolean = false;
  speed: number = 1;
  songKey: string = '';
}

/** 前端 DolbyDeviceCapabilities 的形状。 */
export class DolbyDeviceCapabilities {
  eac3: boolean = false;
  ac4: boolean = false;
  ac3: boolean = false;
  flac: boolean = false;
  available: boolean = false;
  error: string = '';
}

/** 前端 AudioOutputCapabilities 的形状。 */
export class AudioOutputCapabilities {
  outputSampleRate: number = 0;
  floatPcmOutput: boolean = false;
  available: boolean = false;
  error: string = '';
}

/** 播放状态变化时抛给上层的回调。 */
export type PlayerEventHandler = (event: NativePlaybackEvent) => void;

/** 播放器的可播放状态（对齐 media3 的 REPEAT_MODE_*）。 */
export const REPEAT_MODE_OFF: number = 0;
export const REPEAT_MODE_ONE: number = 1;
export const REPEAT_MODE_ALL: number = 2;

export class FoliaPlayer {
  private player: media.AVPlayer | undefined = undefined;
  private handler: PlayerEventHandler | undefined = undefined;
  private songKey: string = '';
  private speed: number = 1;
  private volume: number = 1;
  private buffering: boolean = false;
  private prepared: boolean = false;
  private released: boolean = false;

  constructor(handler: PlayerEventHandler) {
    this.handler = handler;
  }

  private emit(type: string, message: string = ''): void {
    if (!this.handler) return;
    const event: NativePlaybackEvent = new NativePlaybackEvent();
    event.type = type;
    event.positionMs = this.positionMs();
    event.durationMs = this.durationMs();
    event.message = message;
    event.songKey = this.songKey;
    event.playing = this.playing;
    event.buffering = this.buffering;
    this.handler(event);
  }

  private get playerOrThrow(): media.AVPlayer {
    if (!this.player) {
      throw new Error('AVPlayer not created');
    }
    return this.player;
  }

  /** 装入一首歌。url 用 http(s) 或本地文件路径。 */
  async prepare(url: string, startPositionMs: number, repeatMode: number, songKey: string): Promise<void> {
    await this.release();
    this.released = false;
    this.songKey = songKey;
    this.buffering = false;
    this.prepared = false;

    const player: media.AVPlayer = await media.createAVPlayer();
    this.player = player;

    player.on('stateChange', (state: media.AVPlayerState, reason: media.StateChangeReason) => {
      this.onStateChange(state, reason);
    });
    player.on('timeUpdate', (positionMs: number) => {
      this.emit('position');
      if (positionMs < 0) return;
    });
    player.on('error', (err: BusinessError) => {
      this.buffering = false;
      this.emit('error', err ? String(err.message ?? err) : 'playback error');
    });

    player.url = url;
    // 单曲循环用 AVPlayer 自带的 loop；整列循环（REPEAT_MODE_ALL）需要播放列表，
    // 那是 FoliaPlayback 队列镜像那一层的职责，这里先按 loop 处理。
    player.loop = repeatMode === REPEAT_MODE_ONE || repeatMode === REPEAT_MODE_ALL;
    await player.prepare();
    if (startPositionMs > 0) {
      player.seek(startPositionMs, media.SeekMode.SEEK_CLOSEST);
    }
    this.prepared = true;
    this.emit('ready');
  }

  private onStateChange(state: media.AVPlayerState, reason: media.StateChangeReason): void {
    switch (state) {
      case 'playing':
        this.buffering = false;
        this.emit('playing');
        break;
      case 'paused':
        this.emit('paused');
        break;
      case 'completed':
        // 单曲循环时 AVPlayer 会自己回到开头再播，这里报 ended 让前端推进队列。
        if (this.player && this.player.loop) {
          this.emit('position');
        } else {
          this.emit('ended');
        }
        break;
      case 'error':
        this.buffering = false;
        this.emit('error', `state=${state} reason=${reason}`);
        break;
      case 'idle':
      case 'stopped':
        this.emit('idle');
        break;
      default:
        break;
    }
  }

  async play(): Promise<void> {
    if (!this.player) return;
    this.buffering = true;
    try {
      await this.player.play();
    } catch (e) {
      this.buffering = false;
      this.emit('error', String((e as Error).message ?? e));
    }
  }

  async pause(): Promise<void> {
    if (!this.player) return;
    await this.player.pause();
  }

  async stop(): Promise<void> {
    if (!this.player) return;
    await this.player.stop();
  }

  seek(positionMs: number): void {
    if (!this.player) return;
    this.player.seek(Math.max(0, positionMs), media.SeekMode.SEEK_CLOSEST);
    this.emit('seeked');
  }

  setVolume(volume: number): void {
    // 前端传的是 0~1 的相对音量，与 AVPlayer 的 setVolume 同义，直接传。
    const v: number = Math.max(0, Math.min(1, volume));
    this.volume = v;
    if (!this.player) return;
    this.player.setVolume(v);
  }

  setSpeed(speed: number): void {
    const s: number = Math.max(0.25, Math.min(4, speed));
    this.speed = s;
    if (!this.player) return;
    // setSpeed 只认枚举档位，setPlaybackRate 支持任意倍速。
    this.player.setPlaybackRate(s);
  }

  setRepeatMode(repeatMode: number): void {
    if (!this.player) return;
    this.player.loop = repeatMode === REPEAT_MODE_ONE || repeatMode === REPEAT_MODE_ALL;
  }

  positionMs(): number {
    if (!this.player) return 0;
    const pos: number = this.player.getPlaybackPosition();
    return pos > 0 ? pos : 0;
  }

  durationMs(): number {
    if (!this.player) return 0;
    const d: number = this.player.duration;
    return d > 0 ? d : 0;
  }

  get playing(): boolean {
    if (!this.player) return false;
    return this.player.state === 'playing';
  }

  get isPrepared(): boolean {
    return this.prepared;
  }

  snapshot(): NativePlaybackSnapshot {
    const snap: NativePlaybackSnapshot = new NativePlaybackSnapshot();
    snap.positionMs = this.positionMs();
    snap.durationMs = this.durationMs();
    snap.playing = this.playing;
    snap.buffering = this.buffering;
    snap.speed = this.speed;
    snap.songKey = this.songKey;
    return snap;
  }

  /** 释放播放器。重复调用安全。 */
  async release(): Promise<void> {
    if (!this.player) {
      this.released = true;
      return;
    }
    const p: media.AVPlayer = this.player;
    this.player = undefined;
    this.prepared = false;
    this.buffering = false;
    try {
      p.off('stateChange');
      p.off('timeUpdate');
      p.off('error');
      await p.release();
    } catch (e) {
      // 已经释放过就算了
    }
    this.released = true;
  }
}
