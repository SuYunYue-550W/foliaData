import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock 会被提升到 import 之前，工厂里引用的变量必须用 vi.hoisted 声明。
const { nativeFetch } = vi.hoisted(() => ({ nativeFetch: vi.fn() }));
vi.mock('../../../src/services/nativeHttpFetch', () => ({
    createNativeFetch: () => nativeFetch,
}));

import { __setWbiKeysForTest, encodeWbiQuery, signWbi } from '../../../src/services/onlineMusic/bilibili/bilibiliWbi';

// test/unit/bilibili/bilibiliWbi.test.ts
//
// 钉住 wbi 签名的每一步：mixin 表、参数排序、字符过滤、w_rid 的 md5。
// 签名算法一变（B站历史上换过一次），这些向量就会失败，不用等到线上 -403 才发现。

// 官方 wiki 与 2026-10 实测报告里公开的 key 对。
const IMG_KEY = '7cd084941338484aae1ad9425b84077c';
const SUB_KEY = '4932caff0ff746eab6f01bf08b70ac45';
const EXPECTED_MIXIN = 'ea1db124af3c7062474693fa704f4ff8';

describe('bilibili wbi signing', () => {
    beforeEach(() => {
        __setWbiKeysForTest({ imgKey: IMG_KEY, subKey: SUB_KEY });
    });

    it('produces the documented mixin key', async () => {
        // 通过签名结果间接验证：手算官方示例的 w_rid 与本实现一致。
        const params = { foo: '114', bar: '514', baz: 1919810, wts: 1700000000 };
        const signed = await signWbi(params);
        // wts 会被当前时间覆盖，所以用返回的 wts 重算期望值。
        const query = `bar=514&baz=1919810&foo=114&wts=${signed.wts}`;
        const { md5 } = await import('../../../src/utils/md5');
        expect(signed.w_rid).toBe(md5(query + EXPECTED_MIXIN));
    });

    it('adds wts and w_rid without mutating the input', async () => {
        const input = { fresh_idx: 2, ps: 12 };
        const signed = await signWbi(input);
        expect(input).toEqual({ fresh_idx: 2, ps: 12 });
        expect(signed.fresh_idx).toBe(2);
        expect(typeof signed.wts).toBe('number');
        expect(signed.w_rid).toMatch(/^[0-9a-f]{32}$/);
    });

    it('filters !\'()* from values and sorts keys before hashing', async () => {
        const { md5 } = await import('../../../src/utils/md5');
        const signed = await signWbi({ b: "a!'()*b", a: 'x' });
        // 过滤后 b=ab；排序后 a 在 b 前。
        const query = `a=x&b=ab&wts=${signed.wts}`;
        expect(signed.b).toBe("a!'()*b"); // 原值保留在参数里
        expect(signed.w_rid).toBe(md5(query + EXPECTED_MIXIN));
    });

    it('drops undefined and empty values before signing', async () => {
        const signed = await signWbi({ keep: 1, missing: undefined, blank: '' });
        expect('missing' in signed).toBe(false);
        expect('blank' in signed).toBe(false);
        expect(signed.keep).toBe(1);
    });

    it('serializes with %20 and filters specials, unlike URLSearchParams', () => {
        // 请求必须用和签名一样的序列化：URLSearchParams 会用 + 表示空格且不过滤 !'()*，
        // 参数一旦含空格，服务端算出的 w_rid 就对不上。
        const query = encodeWbiQuery({ a: 'a b+c', b: "x!'()*y" });
        expect(query).toBe('a=a%20b%2Bc&b=xy');
        expect(query).not.toBe(new URLSearchParams({ a: 'a b+c' }).toString());
    });

    it('fails clearly when nav cannot provide keys', async () => {
        __setWbiKeysForTest(null);
        nativeFetch.mockRejectedValueOnce(new Error('offline'));
        // 没有缓存时会去打 nav；取不到 key 就应该抛错，而不是静默返回空签名。
        await expect(signWbi({ foo: 1 })).rejects.toThrow(/offline/);
    });
});
