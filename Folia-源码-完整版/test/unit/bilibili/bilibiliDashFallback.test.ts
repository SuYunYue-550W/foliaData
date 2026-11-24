import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// test/unit/bilibili/bilibiliDashFallback.test.ts
//
// DASH 失败自动回退 iframe 的两个边界：
//   ① 切视频后旧视频的 play() 拒绝迟到，不能把**新**视频误切成 iframe；
//   ② AbortError / NotAllowedError 不是「媒体加载失败」，不该触发回退。
//
// 组件要起浏览器，这里用源码契约断言把行为钉住 —— 改回旧写法会立刻失败。

const source = readFileSync(
    fileURLToPath(new URL('../../../src/components/bilibili/BilibiliVideoSurface.tsx', import.meta.url)),
    'utf8',
);

describe('B站 DASH 失败回退 iframe 的边界', () => {
    it('scopes the fallback to the video that actually failed', () => {
        expect(source).toContain('if (failedBvid !== bvid) return;');
        expect(source).toContain('handleDashError(bvid)');
    });

    it('does not fall back on AbortError or NotAllowedError', () => {
        expect(source).toContain("name === 'AbortError'");
        expect(source).toContain("name === 'NotAllowedError'");
        expect(source).toContain('onPlayRejected');
        // onError（媒体真的加载不出来）仍然要回退。
        expect(source).toContain('onError={onMediaError}');
    });

    it('keeps the one-shot guard per video', () => {
        expect(source).toContain('failedRef.current = false;');
        expect(source).toContain('if (failedRef.current) return;');
    });
});
