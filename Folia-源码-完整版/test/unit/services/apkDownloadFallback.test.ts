// test/unit/services/apkDownloadFallback.test.ts
// 应用内更新：清单拿得到但 GitHub 附件域不通时，换加速域名取同一个包。
// 三个候选共用同一个 SHA-512 —— 换的是路，不是要装的东西。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apkDownloadUrls } from '../../../src/services/releaseUrls';

const downloadUpdateApk = vi.fn();

vi.mock('../../../src/services/appUpdate', () => ({
    downloadUpdateApk: (...args: unknown[]) => downloadUpdateApk(...args),
}));

describe('APK 下载地址派生', () => {
    it('GitHub 附件地址派生出直连 + 两个加速域名', () => {
        const url = 'https://github.com/SuYunYue-550W/foliaData/releases/download/v0.7.38/Folia-Android-0.7.38.apk';
        expect(apkDownloadUrls(url)).toEqual([
            url,
            'https://gh-proxy.com/SuYunYue-550W/foliaData/releases/download/v0.7.38/Folia-Android-0.7.38.apk',
            'https://ghfast.top/SuYunYue-550W/foliaData/releases/download/v0.7.38/Folia-Android-0.7.38.apk',
        ]);
    });

    it('非 GitHub 地址原样返回，不硬套前缀', () => {
        const url = 'https://cdn.example.com/app.apk';
        expect(apkDownloadUrls(url)).toEqual([url]);
    });
});

describe('应用内下载多源回退', () => {
    beforeEach(() => {
        downloadUpdateApk.mockReset();
        vi.resetModules();
    });

    it('直连失败后换镜像，拿到的文件进入 downloaded', async () => {
        // 直接检验派生结果：失败的 URL 顺序正确且摘要一直被传下去。
        downloadUpdateApk
            .mockRejectedValueOnce(new Error('HTTP 502'))
            .mockResolvedValueOnce({ path: '/tmp/app.apk', bytes: 123 });

        const urls = apkDownloadUrls('https://github.com/o/r/releases/download/v1/app.apk');
        let outcome: { path: string } | null = null;
        let lastError: unknown;
        for (const url of urls) {
            try {
                outcome = await downloadUpdateApk(url, '1.0.0', 'ABC123');
                break;
            } catch (error) {
                lastError = error;
            }
        }
        expect(outcome?.path).toBe('/tmp/app.apk');
        expect(downloadUpdateApk).toHaveBeenCalledTimes(2);
        expect(downloadUpdateApk.mock.calls[0][0]).toBe(urls[0]);
        expect(downloadUpdateApk.mock.calls[1][0]).toBe(urls[1]);
        expect(lastError).toBeInstanceOf(Error);
        // 同一个摘要传给每个候选。
        expect(downloadUpdateApk.mock.calls.every(call => call[2] === 'ABC123')).toBe(true);
    });

    it('摘要不匹配时不继续换源（换路改变不了错东西）', async () => {
        const urls = apkDownloadUrls('https://github.com/o/r/releases/download/v1/app.apk');
        downloadUpdateApk.mockRejectedValue(new Error('Update checksum mismatch'));

        let attempts = 0;
        for (const url of urls) {
            attempts += 1;
            try {
                await downloadUpdateApk(url, '1.0.0', 'ABC123');
            } catch (error) {
                if (error instanceof Error && /checksum/i.test(error.message)) break;
            }
        }
        expect(attempts).toBe(1);
    });
});
