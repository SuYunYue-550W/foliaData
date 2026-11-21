// test/unit/services/releaseUrls.test.ts
// 发布页/更新源地址跨端共用一处：Android 检查面板、桌面「下载来源」、Web 帮助页都从这里取。
// 钉住地址本身与「三端都引用它」这件事，防止哪天又各自硬编码一份、镜像列表走偏。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RELEASES_PAGE_MIRRORS,
  RELEASES_PAGE_URL,
  UPDATE_MANIFEST_URLS,
} from '../../../src/services/releaseUrls';
import {
  APP_UPDATE_MANIFEST_URLS,
  APP_UPDATE_RELEASES_MIRRORS,
  APP_UPDATE_RELEASES_PAGE,
} from '../../../src/services/appUpdate';

const ROOT = path.resolve(__dirname, '../../..');
const read = (relative: string) => readFileSync(path.join(ROOT, relative), 'utf8');

describe('跨端发布页地址', () => {
    it('主发布页与更新清单指向本仓库 Releases', () => {
        expect(RELEASES_PAGE_URL).toBe('https://github.com/SuYunYue-550W/foliaData/releases');
        expect(UPDATE_MANIFEST_URLS[0]).toBe(`${RELEASES_PAGE_URL}/latest/download/update.json`);
        expect(UPDATE_MANIFEST_URLS).toHaveLength(3);
    });

    it('发布页镜像与清单镜像用同一组加速域名', () => {
        const domains = RELEASES_PAGE_MIRRORS.map(m => new URL(m.url).hostname);
        expect(domains).toEqual(['gh-proxy.com', 'ghfast.top']);
        UPDATE_MANIFEST_URLS.slice(1).forEach((url, index) => {
            expect(new URL(url).hostname).toBe(domains[index]);
        });
    });

    it('appUpdate 的导出仍是同一份常量（旧引用没走偏）', () => {
        expect(APP_UPDATE_RELEASES_PAGE).toBe(RELEASES_PAGE_URL);
        expect(APP_UPDATE_RELEASES_MIRRORS).toBe(RELEASES_PAGE_MIRRORS);
        expect(APP_UPDATE_MANIFEST_URLS).toBe(UPDATE_MANIFEST_URLS);
    });

    it('桌面与 Web 的帮助页都从 releaseUrls 取，不再硬编码镜像', () => {
        const desktop = read('src/components/modal/settings/pages/FoundUpdateRow.tsx');
        expect(desktop).toContain("from '../../../../services/releaseUrls'");
        expect(desktop).toContain('RELEASES_PAGE_MIRRORS');
        const help = read('src/components/modal/settings/pages/HelpPage.tsx');
        expect(help).toContain("from '../../../../services/releaseUrls'");
        expect(help).toContain('!hasElectronBridge() && !isCapacitorAndroid()');
    });
});
