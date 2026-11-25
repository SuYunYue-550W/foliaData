import { afterEach, describe, expect, it, vi } from 'vitest';

// test/unit/lyrics/workerClient.test.ts

describe('lyrics worker client', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.resetModules();
    });

    it('does not post provider callbacks or song identity to the parser worker', async () => {
        const messages: Array<Record<string, unknown>> = [];

        class FakeWorker {
            onmessage: ((event: MessageEvent) => void) | null = null;

            postMessage(message: Record<string, unknown>) {
                messages.push(message);
                structuredClone(message);
                this.onmessage?.({
                    data: {
                        type: 'result',
                        data: { lines: [] },
                        requestId: message.requestId,
                    },
                } as MessageEvent);
            }
        }

        vi.stubGlobal('Worker', FakeWorker);
        const { parseLyricsAsync } = await import('@/utils/lyrics/workerClient');
        const fetchChorusRanges = vi.fn(async () => []);

        await expect(parseLyricsAsync('lrc', '[00:00.00]Line', '', {
            includeInterludes: false,
            filterPattern: '^metadata$',
            songId: 123,
            fetchChorusRanges,
        }, '[00:00.00]Roma')).resolves.toEqual({ lines: [] });

        expect(messages[0]?.options).toEqual({
            includeInterludes: false,
            filterPattern: '^metadata$',
        });
        expect(messages[0]?.romanization).toBe('[00:00.00]Roma');
        expect(fetchChorusRanges).not.toHaveBeenCalled();
    });

    it('settles and falls back to the main thread when the worker never answers', async () => {
        vi.useFakeTimers();
        try {
            // 这个 worker 收到消息后什么都不做 —— 旧实现里 Promise 会永远挂着。
            class SilentWorker {
                onmessage: ((event: MessageEvent) => void) | null = null;
                onerror: ((event: ErrorEvent) => void) | null = null;
                terminate() {}
                postMessage() {}
            }
            vi.stubGlobal('Worker', SilentWorker);
            const { parseLyricsAsync } = await import('@/utils/lyrics/workerClient');

            const pending = parseLyricsAsync('lrc', '[00:00.00]Hello');
            await vi.advanceTimersByTimeAsync(4001);
            const result = await pending;
            // 超时后走主线程纯函数兜底，歌词不会凭空消失。
            expect(result?.lines?.length).toBe(1);
        } finally {
            vi.useRealTimers();
        }
    });
});
