// test/unit/bilibili/bilibiliAudioSource.test.ts
// B站取流：搜索结果只有 bvid、没有 cid，播放时必须先用 view 接口补 cid 再取 playurl。
//
// 这个 bug 三端一致：B站搜索能搜出视频，点播放却报「B站未返回音频」。根因是
// getAudioSource 里 Number(providerData?.cid) 得到 NaN 就静默 return null，playurl
// 根本没发出去，上层把「没抛错但也没 url」归类成 no-audio。测试钉住整条路径。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const requestBilibili = vi.fn();

vi.mock('../../../src/services/onlineMusic/bilibili/bilibiliTransport', () => ({
    requestBilibili: (...args: unknown[]) => requestBilibili(...args),
    bilibiliPlayUrlExpiry: () => Date.now() + 90_000,
    hasBilibiliLogin: () => false,
    readBilibiliSessdata: () => null,
    writeBilibiliSessdata: () => undefined,
}));

const DASH = {
    dash: {
        audio: [
            { id: 30280, baseUrl: 'https://upos.example/audio.m4s', backupUrl: ['https://backup.example/audio.m4s'] },
            { id: 30216, baseUrl: 'https://upos.example/audio-low.m4s', backupUrl: [] },
        ],
        video: [{ id: 80, codecid: 7, baseUrl: 'https://upos.example/video.m4s', backupUrl: [] }],
    },
};

const song = (providerData?: Record<string, unknown>) => ({
    id: 'BV1xx411c7mD',
    name: '测试视频',
    sourceRef: {
        kind: 'online',
        providerId: 'bilibili',
        mediaId: 'BV1xx411c7mD',
        providerData,
    },
});

describe('B站取流（搜索结果无 cid）', () => {
    const getAudioSource = async (input: unknown) => {
        const { bilibiliProvider } = await import('../../../src/services/onlineMusic/bilibili/bilibiliProvider');
        return (bilibiliProvider.playback.getAudioSource as (s: unknown, q: string) => Promise<unknown>)(input, 'lossless');
    };

    beforeEach(() => {
        requestBilibili.mockReset();
    });

    it('无 cid 时先按 bvid 调 view 补 cid，再取 playurl', async () => {
        requestBilibili
            .mockResolvedValueOnce({ data: { bvid: 'BV1xx411c7mD', cid: 123456 }, code: 0 }) // view
            .mockResolvedValueOnce({ data: DASH, code: 0 }); // playurl

        const result = await getAudioSource(song({ aid: 999 })) as { url: string; videoUrl?: string };

        expect(requestBilibili).toHaveBeenCalledTimes(2);
        expect(requestBilibili.mock.calls[0]).toEqual(['view', { bvid: 'BV1xx411c7mD' }]);
        expect(requestBilibili.mock.calls[1]).toEqual(['playurl', { bvid: 'BV1xx411c7mD', cid: 123456 }]);
        expect(result.url).toBe('https://upos.example/audio.m4s');
        expect(result.videoUrl).toBe('https://upos.example/video.m4s');
    });

    it('补到的 cid 回写 sourceRef，下次播放不再重复查 view', async () => {
        requestBilibili.mockImplementation((module: string) => Promise.resolve(
            module === 'view' ? { data: { cid: 123456 }, code: 0 } : { data: DASH, code: 0 },
        ));
        const input = song({ aid: 999 });

        await getAudioSource(input);
        await getAudioSource(input);

        // 第一次：view + playurl；第二次：只有 playurl（cid 已被记住）。
        expect(requestBilibili).toHaveBeenCalledTimes(3);
        expect(requestBilibili.mock.calls.filter(call => call[0] === 'view')).toHaveLength(1);
        expect((input as { sourceRef: { providerData: { cid: number } } }).sourceRef.providerData.cid).toBe(123456);
    });

    it('已有 cid 时直接取 playurl，不查 view', async () => {
        requestBilibili.mockResolvedValue({ data: DASH, code: 0 });

        await getAudioSource(song({ cid: 777 }));

        expect(requestBilibili).toHaveBeenCalledTimes(1);
        expect(requestBilibili.mock.calls[0]).toEqual(['playurl', { bvid: 'BV1xx411c7mD', cid: 777 }]);
    });

    it('baseUrl 缺失时回退到 backupUrl', async () => {
        requestBilibili
            .mockResolvedValueOnce({ data: { cid: 123 }, code: 0 })
            .mockResolvedValueOnce({
                data: {
                    dash: {
                        audio: [{ id: 30280, baseUrl: '', backupUrl: ['https://backup.example/audio.m4s'] }],
                        video: [{ id: 80, codecid: 7, baseUrl: '', backupUrl: ['https://backup.example/video.m4s'] }],
                    },
                },
                code: 0,
            });

        const result = await getAudioSource(song()) as { url: string; videoUrl?: string };
        expect(result.url).toBe('https://backup.example/audio.m4s');
        expect(result.videoUrl).toBe('https://backup.example/video.m4s');
    });

    it('view 也拿不到 cid 时返回 null（不瞎请求 playurl）', async () => {
        requestBilibili.mockResolvedValue({ data: {}, code: 0 });

        const result = await getAudioSource(song());
        expect(result).toBeNull();
        expect(requestBilibili).toHaveBeenCalledTimes(1);
        expect(requestBilibili.mock.calls[0][0]).toBe('view');
    });
});
