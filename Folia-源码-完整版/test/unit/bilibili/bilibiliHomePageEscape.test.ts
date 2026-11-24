import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// test/unit/bilibili/bilibiliHomePageEscape.test.ts
//
// B站首页页签（v0.7.40 引入）的 Esc 处理曾经是手写的 window 捕获监听 +
// stopPropagation。那会吞掉命令面板 / 设置 / 登录弹窗的 Esc（它们都在冒泡阶段），
// 并且没调 preventDefault 导致 Android 返回键把整个 App 退到后台。
//
// 组件测试要起浏览器，这里用源码契约断言把「不能改回那套写法」钉住；
// useEscapeClose 栈本身的行为由它自己的测试与组件测试覆盖。

const pageSource = readFileSync(
    fileURLToPath(new URL('../../../src/components/app/home/BilibiliHomePage.tsx', import.meta.url)),
    'utf8',
);

describe('BilibiliHomePage Escape handling', () => {
    it('uses the shared useEscapeClose stack instead of a window capture listener', () => {
        expect(pageSource).toContain('useEscapeClose(onClose)');
        expect(pageSource).toContain("from '../../../hooks/useEscapeClose'");
        // 这两行正是曾经的 bug：捕获阶段 + stopPropagation 吞掉上层弹窗的 Esc。
        expect(pageSource).not.toMatch(/addEventListener\('keydown',\s*onKey,\s*true'\)/);
        expect(pageSource).not.toContain("window.addEventListener('keydown'");
    });

    it('marks itself as a keyboard-owning window like the mod home pages', () => {
        // 没有这个标记，全局热键与悬停探针不会为这一层让路。
        expect(pageSource).toContain('data-folia-keyboard-window="true"');
    });

    it('normalizes the room: prefix in both playback and current-item detection', () => {
        // 直播的 sourceRef.mediaId 带 room: 前缀，store 里存的是剥掉前缀的房间号。
        // 之前只有点播放时剥前缀、高亮比较用原值，直播间永不显示"正在播放"。
        expect(pageSource).toContain("mediaId.startsWith('room:') ? mediaId.slice(5) : mediaId");
        expect(pageSource).toContain('bvidOf(song.sourceRef) === currentBvid');
        expect(pageSource).toContain('const bvid = bvidOf(ref)');
    });

    it('guards module loads with a request id so a slow earlier response cannot win', () => {
        // 连点模块时旧请求后返回会覆盖新结果，界面停在「热门」却显示推荐内容。
        expect(pageSource).toContain('requestIdRef');
        expect(pageSource).toContain('if (requestId !== requestIdRef.current) return;');
    });
});
