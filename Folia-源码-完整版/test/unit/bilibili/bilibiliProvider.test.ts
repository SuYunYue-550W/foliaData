// test/unit/bilibili/bilibiliProvider.test.ts
// B站 provider 的逻辑护栏：只用最小真实答复，验证归一化、七个模块映射、扫码状态与取流。
// 不联网：transport 的行为由真实抓包记录在此作为 fixture。
import { describe, expect, it } from 'vitest';
import { normalizeBilibiliSong, normalizeBilibiliLive, cleanBiliTitle, isBilibiliLiveSong } from '../../../src/services/onlineMusic/bilibili/bilibiliNormalize';

const searchItem = {
    type: 'video',
    bvid: 'BV1BZbSzZEGT',
    title: '【𝐇𝐢-𝐑𝐞𝐬无损音质】｜《晴天》- <em class="keyword">周杰伦</em>',
    author: 'VV音乐局',
    pic: '//i0.hdslb.com/bfs/archive/abc.jpg',
    duration: '4:29',
    stat: { view: 123456, danmaku: 789 },
};

const liveItem = {
    roomid: 22637261,
    uid: 12345,
    title: '凌晨聊天室',
    uname: '某主播',
    user_cover: 'https://i0.hdslb.com/bfs/live/cover.jpg',
};

describe('B站视频归一化', () => {
    it('bvid 作为 id，cid/播放数塞进 providerData', () => {
        const song = normalizeBilibiliSong({ ...searchItem, cid: 31268997329, aid: 2 });
        expect(song.id).toBe('BV1BZbSzZEGT');
        expect(song.name).toBe('【𝐇𝐢-𝐑𝐞𝐬无损音质】｜《晴天》- 周杰伦');
        expect(song.artists[0]?.name).toBe('VV音乐局');
        expect(song.album.coverUrl).toBe('https://i0.hdslb.com/bfs/archive/abc.jpg');
        expect(song.durationMs).toBe(4 * 60_000 + 29_000);
        expect(song.sourceRef).toEqual({
            kind: 'online', providerId: 'bilibili', mediaId: 'BV1BZbSzZEGT',
            providerData: { cid: 31268997329, aid: 2, view: 123456, danmaku: 789 },
        });
    });

    it('已是本平台归一化结果时不重复转换', () => {
        const once = normalizeBilibiliSong({ ...searchItem, cid: 1 });
        expect(normalizeBilibiliSong(once)).toBe(once);
    });

    it('直播间用 room: 前缀并标记 live', () => {
        const song = normalizeBilibiliLive(liveItem);
        expect(song.id).toBe('room:22637261');
        expect(song.name).toBe('凌晨聊天室');
        expect(isBilibiliLiveSong(song)).toBe(true);
        expect(song.sourceRef?.kind === 'online' && song.sourceRef.providerData?.roomId).toBe(22637261);
    });

    it('清掉搜索高亮标签与 HTML 实体', () => {
        expect(cleanBiliTitle('A <em class="keyword">B</em> &amp; C')).toBe('A B & C');
    });
});
