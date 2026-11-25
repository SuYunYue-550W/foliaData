export interface EmbeddedMetadataResult {
    title?: string;
    artist?: string;
    artists?: string[];
    album?: string;
    trackNumber?: number;
    discNumber?: number;
    cover?: Blob;
    coverAssetId?: string;
    bitrate?: number;
    lyrics?: string;
    translationLyrics?: string;
    replayGain?: number;
    replayGainTrackGain?: number;
    replayGainTrackPeak?: number;
    replayGainAlbumGain?: number;
    replayGainAlbumPeak?: number;
    duration?: number;
}

export interface HashedLocalCoverResult {
    cover: Blob;
    coverAssetId: string;
}

let metadataWorker: Worker | null = null;
let workerRequestId = 0;
type Pending = {
    resolve: (result: unknown | null) => void;
    timer: ReturnType<typeof setTimeout>;
};
const workerCallbacks = new Map<string, Pending>();

// 和歌词 worker 一样：创建成功却不回消息时 Promise 会永久挂起，回调表也留着。
// 超时后 resolve(null)，调用方按「没有元数据」继续，界面不会卡在 loading。
const WORKER_TIMEOUT_MS = 4000;

const settle = (requestId: string, result: unknown | null): void => {
    const pending = workerCallbacks.get(requestId);
    if (!pending) return;
    workerCallbacks.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(result);
};

const settleAll = (reason: string): void => {
    if (workerCallbacks.size === 0) return;
    console.warn(`[MetadataWorker] ${reason}`);
    for (const requestId of [...workerCallbacks.keys()]) settle(requestId, null);
};

export const initMetadataWorker = (): Worker => {
    if (!metadataWorker) {
        metadataWorker = new Worker(
            new URL('../workers/metadataParser.worker.ts', import.meta.url),
            { type: 'module' }
        );
        metadataWorker.onmessage = (e) => {
            const { type, data, requestId, message } = e.data;
            if (type === 'result') {
                settle(requestId, data);
            } else {
                console.warn('[MetadataWorker] parsing error:', message);
                settle(requestId, null);
            }
        };
        metadataWorker.onerror = (event) => {
            settleAll(`worker error: ${event.message}`);
            // 这个实例坏了，下次请求重建。
            metadataWorker?.terminate();
            metadataWorker = null;
        };
    }

    return metadataWorker;
};

export const parseEmbeddedMetadataAsync = (
    file: File,
    includeCover = false
): Promise<EmbeddedMetadataResult | null> => {
    return new Promise((resolve) => {
        const worker = initMetadataWorker();
        const requestId = `meta_req_${++workerRequestId}`;
        workerCallbacks.set(requestId, {
            resolve: result => resolve(result as EmbeddedMetadataResult | null),
            timer: setTimeout(() => settle(requestId, null), WORKER_TIMEOUT_MS),
        });
        worker.postMessage({ type: 'parse-metadata', file, includeCover, requestId });
    });
};

export const hashLocalCoverBlobAsync = (cover: Blob): Promise<HashedLocalCoverResult | null> => {
    return new Promise((resolve) => {
        const worker = initMetadataWorker();
        const requestId = `cover_hash_req_${++workerRequestId}`;
        workerCallbacks.set(requestId, {
            resolve: result => resolve(result as HashedLocalCoverResult | null),
            timer: setTimeout(() => settle(requestId, null), WORKER_TIMEOUT_MS),
        });
        worker.postMessage({ type: 'hash-cover', cover, requestId });
    });
};
