// test/unit/releaseManifest.test.ts
// 更新清单的生成：附件名与 sha512。
//
// v0.7.37 正式版的安卓应用内更新下不了：清单里的地址是 app-release.apk（本地文件名），
// 而真正上传的附件叫 Folia-Android-0.7.37.apk，地址 404。清单必须用**上传时的名字**生成。
// 顺带钉住 sha512 写进清单：原生下载后按它比对，挡下载损坏与清单被替换。
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// test/unit/releaseManifest.test.ts

const ROOT = path.resolve(__dirname, '../..');
// 清单脚本在**仓库根**的 release-manifests/ 下，不在源码树里。
const REPO_ROOT = path.resolve(ROOT, '..');
const PYTHON = process.platform === 'win32' ? 'python' : 'python3';

/*
 * 脚本本身在中文路径下（release-manifests/生成更新清单.py）。Windows 上把命令行按 GBK
 * 传给 python 时中文会转坏，于是「文件不存在」。所以先复制到纯 ASCII 的临时路径再跑。
 */
const stageScript = (dir: string): string => {
    const source = path.join(REPO_ROOT, 'release-manifests/生成更新清单.py');
    const target = path.join(dir, 'make_manifest.py');
    writeFileSync(target, readFileSync(source));
    return target;
};

describe('更新清单生成', () => {
    let work: string;

    beforeEach(() => {
        work = mkdtempSync(path.join(tmpdir(), 'folia-manifest-'));
        const out = path.join(work, 'out');
        mkdirSync(out);
        writeFileSync(path.join(work, 'app-release.apk'), 'x'.repeat(1000));
        writeFileSync(path.join(work, 'setup.exe'), 'y'.repeat(2000));
    });

    afterEach(() => {
        rmSync(work, { recursive: true, force: true });
    });

    const run = (extraArgs: string[]): string => {
        execFileSync(PYTHON, [
            stageScript(work),
            '--exe', path.join(work, 'setup.exe'),
            '--apk', path.join(work, 'app-release.apk'),
            '--out', path.join(work, 'out'),
            '--version', '9.9.9',
            '--tag', 'v9.9.9',
            ...extraArgs,
        ], { encoding: 'utf8' });
        return readFileSync(path.join(work, 'out', 'update.json'), 'utf8');
    };

    it('不带 --apk-name 时用本地文件名，并给出提醒', () => {
        const stdout = execFileSync(PYTHON, [
            stageScript(work),
            '--exe', path.join(work, 'setup.exe'),
            '--apk', path.join(work, 'app-release.apk'),
            '--out', path.join(work, 'out'),
            '--version', '9.9.9',
            '--tag', 'v9.9.9',
        ], { encoding: 'utf8' });
        const manifest = JSON.parse(readFileSync(path.join(work, 'out', 'update.json'), 'utf8'));
        expect(manifest.download_url).toContain('app-release.apk');
        expect(stdout).toContain('--apk-name');
    });

    it('--apk-name 决定清单里的附件名（这正是 v0.7.37 404 的根因）', () => {
        const manifest = JSON.parse(run(['--apk-name', 'Folia-Android-9.9.9.apk']));
        expect(manifest.download_url).toBe(
            'https://github.com/SuYunYue-550W/foliaData/releases/download/v9.9.9/Folia-Android-9.9.9.apk');
        expect(manifest.download_url).not.toContain('app-release.apk');
        expect(manifest.assets[0].name).toBe('Folia-Android-9.9.9.apk');
        expect(manifest.assets[0].browser_download_url).toBe(manifest.download_url);
    });

    it('清单带 apk 的 sha512（base64 与 hex 两种）与大小', () => {
        const manifest = JSON.parse(run(['--apk-name', 'app.apk']));
        expect(manifest.size).toBe(1000);
        expect(typeof manifest.sha512).toBe('string');
        expect(manifest.sha512.length).toBeGreaterThan(80);
        expect(manifest.sha512_hex).toMatch(/^[0-9a-f]{128}$/);
        expect(manifest.assets[0].sha512).toBe(manifest.sha512);
        expect(manifest.assets[0].sha512_hex).toBe(manifest.sha512_hex);
    });

    it('sha512 与文件实际内容一致', () => {
        const manifest = JSON.parse(run(['--apk-name', 'app.apk']));
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const crypto = require('node:crypto');
        const expected = crypto.createHash('sha512').update('x'.repeat(1000)).digest('hex');
        expect(manifest.sha512_hex).toBe(expected);
    });

    it('--tag / --version 必填：不再生成 0.7.33 的清单配 v0.7.40 的说明', () => {
        expect(() => execFileSync(PYTHON, [
            stageScript(work),
            '--exe', path.join(work, 'setup.exe'),
            '--apk', path.join(work, 'app-release.apk'),
            '--version', '9.9.9',
        ], { encoding: 'utf8', stdio: 'pipe' })).toThrow();
    });

    it('beta / alpha 模板不复用 stable 包的地址与摘要', () => {
        run(['--apk-name', 'app.apk']);
        for (const channel of ['beta', 'alpha']) {
            const text = readFileSync(path.join(work, 'out', `${channel}.yml.example`), 'utf8');
            expect(text).toContain(`REPLACE_WITH_${channel.toUpperCase()}_SHA512`);
            expect(text).not.toMatch(/sha512: wGmsk|sha512: [A-Za-z0-9+/]{60,}/);
        }
    });

    it('--exe-name 决定 latest.yml 里的附件名', () => {
        run(['--apk-name', 'app.apk', '--exe-name', 'Folia-Setup-9.9.9.exe']);
        const latest = readFileSync(path.join(work, 'out', 'latest.yml'), 'utf8');
        expect(latest).toContain('url: Folia-Setup-9.9.9.exe');
        expect(latest).toContain('path: Folia-Setup-9.9.9.exe');
    });
});
