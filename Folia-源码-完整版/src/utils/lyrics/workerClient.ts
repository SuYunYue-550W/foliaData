import { LyricData } from '../../types';
import type { LyricParseFormat } from './parserCore';
import type { LyricProcessingOptions } from './types';

let lyricsWorker: Worker | null = null;
let workerRequestId = 0;
type PendingLyric = {
    resolve: (data: LyricData | null) => void;
    timer: ReturnType<typeof setTimeout>;
    /** worker 没回应时在主线程重算这一笔的资料，不让歌词白白消失。 */
    fallback: () => Promise<LyricData | null>;
};
const workerCallbacks = new Map<string, PendingLyric>();

// Worker 创建成功但脚本加载失败/消息丢失时，onmessage 永远不来 —— Promise 就永久挂起，
// 回调表里的那一项也永远留着。项目里 worker 相关超时统一参考 spectrumTap 的 4s。
const WORKER_TIMEOUT_MS = 4000;

/** 正常结算一笔：清定时器、出表、回调。 */
const settle = (requestId: string, data: LyricData | null): void => {
    const pending = workerCallbacks.get(requestId);
    if (!pending) return;
    workerCallbacks.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(data);
};

/** worker 没干活（超时/出错）时：在主线程重算这笔资料，再结算。 */
const settleWithFallback = async (requestId: string, reason: string): Promise<void> => {
    const pending = workerCallbacks.get(requestId);
    if (!pending) return;
    console.warn(`[LyricsWorker] ${reason}, parsing on the main thread`);
    workerCallbacks.delete(requestId);
    clearTimeout(pending.timer);
    let parsed: LyricData | null = null;
    try {
        parsed = await pending.fallback();
    } catch (error) {
        console.warn('[LyricsWorker] main-thread fallback failed', error);
    }
    pending.resolve(parsed);
};

/** 出错时把所有在途请求一次性结算掉，不留悬空回调。 */
const settleAll = (reason: string): void => {
    for (const requestId of [...workerCallbacks.keys()]) settleWithFallback(requestId, reason);
};

type WorkerLyricProcessingOptions = Pick<LyricProcessingOptions, 'includeInterludes' | 'filterPattern'>;

// Keeps orchestration-only values such as provider callbacks outside the structured-clone boundary.
export const toWorkerLyricProcessingOptions = (
    options?: LyricProcessingOptions,
): WorkerLyricProcessingOptions | undefined => {
    if (!options) return undefined;
    return {
        ...(options.includeInterludes !== undefined ? { includeInterludes: options.includeInterludes } : {}),
        ...(options.filterPattern !== undefined ? { filterPattern: options.filterPattern } : {}),
    };
};

export const initLyricsWorker = (): Worker => {
    if (!lyricsWorker) {
        // Need to use correct relative path or alias
        lyricsWorker = new Worker(
            new URL('../../workers/lyricsParser.worker.ts', import.meta.url),
            { type: 'module' }
        );
        lyricsWorker.onmessage = (e) => {
            const { type, data, requestId, message } = e.data;
            if (type === 'result') {
                settle(requestId, data);
            } else {
                console.warn('[LyricsWorker] parsing error:', message);
                settle(requestId, null);
            }
        };
        // Worker 脚本加载失败（Android WebView / file:// 下 module worker 常见）也要结算。
        lyricsWorker.onerror = (event) => {
            console.warn('[LyricsWorker] worker error:', event.message);
            settleAll('worker error');
            // 这个实例已经坏了，下次请求重建一个。
            lyricsWorker?.terminate();
            lyricsWorker = null;
        };
    }
    return lyricsWorker;
};

export const parseLyricsAsync = (
    format: LyricParseFormat,
    content: string,
    translation?: string,
    options?: LyricProcessingOptions,
    romanization?: string
): Promise<LyricData | null> => {
    return new Promise((resolve) => {
        const worker = initLyricsWorker();
        const requestId = `req_${++workerRequestId}`;
        const workerOptions = toWorkerLyricProcessingOptions(options);
        const timer = setTimeout(
            () => settleWithFallback(requestId, `no answer in ${WORKER_TIMEOUT_MS}ms`),
            WORKER_TIMEOUT_MS,
        );
        workerCallbacks.set(requestId, {
            resolve,
            timer,
            // 纯解析函数在 parserCore 里，主线程直接调即可（歌词通常几十 KB，可接受）。
            // **动态 import**：静态引入会把 parserCore 拉进模块加载链，改变依赖它的
            // 那些测试的 mock 行为（歌词导演的预取测试就是这么坏的）。只在真的需要
            // 兜底时才加载，模块图与改动前一致。
            fallback: async () => {
                const { parseLyricsByFormat } = await import('./parserCore');
                return parseLyricsByFormat(format, content, translation, options, romanization);
            },
        });
        worker.postMessage({
            type: 'parse',
            format,
            content,
            translation,
            romanization,
            options: workerOptions,
            requestId,
        });
    });
};
