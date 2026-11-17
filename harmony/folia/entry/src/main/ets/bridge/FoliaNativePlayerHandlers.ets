// harmony/folia/entry/src/main/ets/bridge/FoliaNativePlayerHandlers.ets
//
// FoliaNativePlayer 的方法实现（原生播放内核）。
//
// 对应前端 src/services/playbackEngine/nativePlayerPlugin.ts 的 FoliaNativePlayerPlugin。
// 事件名 foliaNativePlayer，事件形状见 NativePlaybackEvent。
//
// 与 Android 的差异（如实标注，不假装等价）：
//  - 均衡器 / 频谱 / 音频快照：鸿蒙 AVPlayer 没有 FFT、快照与等效的 AudioProcessor 链，
//    这几个方法一律回 unsupported —— 前端拿到明确的错误，而不是一份假数据。

import { FoliaPlayer, NativePlaybackEvent, NativePlaybackSnapshot, DolbyDeviceCapabilities, AudioOutputCapabilities } from './FoliaPlayer';
import { FoliaEventBus } from './FoliaEventBus';
import { optString, optNumber, optBool } from './FoliaBridgeOptions';

/** prepare 的入参形状。 */
class PrepareOptions {
  url: string = '';
  startPositionMs: number = 0;
  repeatMode: number = 0;
  songKey: string = '';
}

/** 通用数字入参。 */
class NumberOption {
  value: number = 0;
}

/** 布尔入参。 */
class BoolOption {
  value: boolean = false;
}

/** prepare 的返回值。 */
class PrepareResult {
  ok: boolean = false;
}

/** 桥方法签名：入参由 JSON 解析而来，形状动态。 */
export type Handler = (options: Record<string, ESObject>) => Promise<Object>;

const PLUGIN: string = 'FoliaNativePlayer';
const EVENT: string = 'foliaNativePlayer';


export class FoliaNativePlayerHandlers {
  private player: FoliaPlayer;
  private bus: FoliaEventBus;

  constructor(bus: FoliaEventBus) {
    this.bus = bus;
    this.player = new FoliaPlayer((event: NativePlaybackEvent) => {
      this.onEvent(event);
    });
  }

  private onEvent(event: NativePlaybackEvent): void {
    this.bus.emit(PLUGIN, EVENT, event);
  }

  /** 把方法挂到桥的 handler 表。 */
  register(handlers: Map<string, Handler>): void {
    handlers.set('FoliaNativePlayer.prepare', async (o) => {
      const url: string = optString(o, 'url');
      if (!url) {
        throw new Error('prepare requires a url');
      }
      const start: number = optNumber(o, 'startPositionMs');
      const repeat: number = optNumber(o, 'repeatMode');
      const key: string = optString(o, 'songKey');
      await this.player.prepare(url, start, repeat, key);
      const result: PrepareResult = new PrepareResult();
      result.ok = true;
      return result;
    });

    handlers.set('FoliaNativePlayer.play', async () => {
      await this.player.play();
      return new Object();
    });

    handlers.set('FoliaNativePlayer.pause', async () => {
      await this.player.pause();
      return new Object();
    });

    handlers.set('FoliaNativePlayer.stop', async () => {
      await this.player.stop();
      return new Object();
    });

    handlers.set('FoliaNativePlayer.seek', async (o) => {
      this.player.seek(optNumber(o, 'positionMs'));
      return new Object();
    });

    handlers.set('FoliaNativePlayer.setVolume', async (o) => {
      this.player.setVolume(optNumber(o, 'volume'));
      return new Object();
    });

    handlers.set('FoliaNativePlayer.setSpeed', async (o) => {
      this.player.setSpeed(optNumber(o, 'speed'));
      return new Object();
    });

    handlers.set('FoliaNativePlayer.setRepeatMode', async (o) => {
      this.player.setRepeatMode(optNumber(o, 'repeatMode'));
      return new Object();
    });

    handlers.set('FoliaNativePlayer.release', async () => {
      await this.player.release();
      return new Object();
    });

    handlers.set('FoliaNativePlayer.getSnapshot', async () => {
      const snap: NativePlaybackSnapshot = this.player.snapshot();
      return snap;
    });

    // 下面三个鸿蒙侧没有对应实现：AVPlayer 没有 FFT、快照与等效的 EQ 链。
    // 如实回 unsupported，让前端按「能力不可用」降级，而不是拿到假数据。
    const unsupported = async () => {
      throw new Error('This capability is not available on HarmonyOS');
    };
    handlers.set('FoliaNativePlayer.setEqualizer', unsupported);
    handlers.set('FoliaNativePlayer.getEqualizerState', unsupported);
    handlers.set('FoliaNativePlayer.setSpectrumEnabled', unsupported);
    handlers.set('FoliaNativePlayer.getSpectrum', unsupported);

    handlers.set('FoliaNativePlayer.getDolbyDeviceCapabilities', async () => {
      // 鸿蒙没有公开的 MediaCodec 解码器枚举接口，如实报「探测不可用」。
      const caps: DolbyDeviceCapabilities = new DolbyDeviceCapabilities();
      caps.available = false;
      caps.error = 'decoder capability probing is not available on HarmonyOS';
      return caps;
    });

    handlers.set('FoliaNativePlayer.getAudioOutputCapabilities', async () => {
      const caps: AudioOutputCapabilities = new AudioOutputCapabilities();
      caps.available = false;
      caps.error = 'output capability probing is not available on HarmonyOS';
      return caps;
    });
  }
}
