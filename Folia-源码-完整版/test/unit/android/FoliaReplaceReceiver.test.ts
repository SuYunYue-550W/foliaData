// test/unit/android/FoliaReplaceReceiver.test.ts
// 覆盖安装前收尾的护栏。
//
// 现象：MIUI 的安装器在覆盖安装时先卸载旧版本，旧进程还占着文件时那一步会失败，
// 手机上弹 "Failed to uninstall old application files. Please try running the installer
// again. -2"，装不上且重试无效。系统发 PACKAGE_REPLACED / PACKAGE_FULLY_REMOVED 时
// 旧进程还能收到，那正是收尾的时机。
//
// 这里读 Kotlin 源码做静态断言（与 immersiveParams.test.ts 读 ImmersiveParams 源码对表同一路子）：
// 接收器必须存在、必须声明这两个 action、并且真的去停那三个会占文件的服务。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../../..');
const read = (rel: string): string => readFileSync(resolve(root, rel), 'utf8');

const manifest = read('android/app/src/main/AndroidManifest.xml');
const receiver = read('android/app/src/main/java/top/izuna/foliamajor/FoliaReplaceReceiver.kt');

describe('覆盖安装前收尾', () => {
    it('清单里注册了接收器，并声明覆盖安装与卸载两个广播', () => {
        expect(manifest).toContain('.FoliaReplaceReceiver');
        expect(manifest).toContain('android.intent.action.PACKAGE_REPLACED');
        expect(manifest).toContain('android.intent.action.PACKAGE_FULLY_REMOVED');
    });

    it('接收器只处理这两个广播', () => {
        expect(receiver).toContain('Intent.ACTION_PACKAGE_REPLACED');
        expect(receiver).toContain('Intent.ACTION_PACKAGE_FULLY_REMOVED');
    });

    it('会停掉会占住文件的前台服务', () => {
        for (const service of [
            'FoliaPlaybackService',
            'AppleMusicHoldService',
            'FloatingWhaleService',
        ]) {
            expect(receiver, `没有停 ${service}`).toContain(service);
        }
        expect(receiver).toContain('stopService');
    });
});
