// test/unit/harmony/harmonyBridgeContract.test.ts
// HarmonyOS 壳工程的桥契约护栏。
// 本机没有 DevEco SDK，无法编译 HAP，因此用静态断言钉住「前端 JS 桥」与「ArkTS 原生桥」
// 之间不会漂移的契约：方法名注入点、JSON 信封字段、三级降级语义、以及标准工程文件齐全。
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// 测试在 Folia-源码-完整版 下运行，harmony 工程在上一级工作区。
const workspaceRoot = resolve(__dirname, '../../../..');
const harmonyRoot = resolve(workspaceRoot, 'harmony/folia');
const read = (rel: string): string => readFileSync(resolve(harmonyRoot, rel), 'utf8');

const jsBridge = () => read('entry/src/main/resources/rawfile/capacitor-harmony-bridge.js');
const etsBridge = () => read('entry/src/main/ets/bridge/FoliaHarmonyBridge.ets');

describe('HarmonyOS 前端桥（capacitor-harmony-bridge.js）', () => {
    it('声明 Capacitor 自定义平台为 harmony 并接管平台判定', () => {
        const js = jsBridge();
        expect(js).toContain("window.CapacitorCustomPlatform = { name: 'harmony'");
        expect(js).toContain("cap.getPlatform = function () { return 'harmony'; }");
        expect(js).toContain('cap.nativePromise');
        expect(js).toContain('cap.nativeCallback');
    });

    it('注入 ArkTS 期望的 foliaHarmonyInvoke 与回执函数', () => {
        const js = jsBridge();
        expect(js).toContain('window.foliaHarmonyInvoke(payload)');
        expect(js).toContain('window.__foliaHarmonyResolve = function');
    });

    it('JSON 信封字段与 ArkTS BridgeRequest 对齐', () => {
        const js = jsBridge();
        ['callbackId', 'pluginName', 'methodName', 'options'].forEach((field) => {
            expect(js, `前端信封缺 ${field}`).toContain(field);
        });
    });

    it('原生未就绪时明确拒绝，不留 pending Promise', () => {
        const js = jsBridge();
        expect(js).toContain("typeof window.foliaHarmonyInvoke !== 'function'");
        expect(js).toContain("err.code = 'unavailable'");
        expect(js).toContain('reject(err)');
    });
});

describe('HarmonyOS ArkTS 桥（FoliaHarmonyBridge.ets）', () => {
    it('注册 JS 代理方法与前端注入点一致', () => {
        const ets = etsBridge();
        expect(ets).toContain('foliaHarmonyInvoke');
        expect(ets).toContain("'foliaHarmonyNative'");
        expect(ets).toContain('__foliaHarmonyResolve');
        expect(ets).toContain('registerJavaScriptProxy');
    });

    it('具备 unimplemented / unsupported 三级降级语义', () => {
        const ets = etsBridge();
        expect(ets).toContain("code: 'unimplemented'");
        expect(ets).toContain("code = 'unsupported'");
        expect(ets).toContain('未注册');
    });

    it('Record 用索引访问且 JSON.stringify 显式转 Object（ArkTS 严格模式）', () => {
        const ets = etsBridge();
        expect(ets).toContain("o['text']");
        expect(ets).toContain('JSON.stringify(reply as Object)');
    });

    it('已实现能力覆盖前端声明的关键方法', () => {
        const ets = etsBridge();
        [
            'FoliaNative.showToast',
            'FoliaNative.setScreenAwake',
            'FoliaNative.moveToBackground',
            'FoliaNative.exitApp',
        ].forEach((key) => expect(ets, `ArkTS 缺 ${key}`).toContain(`'${key}'`));
    });
});

describe('HarmonyOS 工程标准文件齐全（DevEco Sync 前置条件）', () => {
    it('具备工程级与模块级构建配置', () => {
        ['hvigor/hvigor-config.json5', 'build-profile.json5', 'entry/build-profile.json5',
         'oh-package.json5', 'entry/oh-package.json5', 'AppScope/app.json5',
         'entry/src/main/module.json5'].forEach((rel) => {
            expect(existsSync(resolve(harmonyRoot, rel)), `缺文件 ${rel}`).toBe(true);
        });
    });

    it('具备混淆规则与包装器（Windows + POSIX）', () => {
        ['entry/obfuscation-rules.txt', 'hvigorw', 'hvigorw.bat'].forEach((rel) => {
            expect(existsSync(resolve(harmonyRoot, rel)), `缺文件 ${rel}`).toBe(true);
        });
    });

    it('hvigor-config 声明 ohos 插件依赖', () => {
        const cfg = read('hvigor/hvigor-config.json5');
        expect(cfg).toContain('@ohos/hvigor-ohos-plugin');
        expect(cfg).toContain('modelVersion');
    });
});
