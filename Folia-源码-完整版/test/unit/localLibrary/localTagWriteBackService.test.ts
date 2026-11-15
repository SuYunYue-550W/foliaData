import { describe, expect, it, vi } from 'vitest';

// test/unit/localLibrary/localTagWriteBackService.test.ts
// 纯逻辑（模板渲染、冲突序号、字段 diff、目标字段来源）+ 预览/执行编排（mock Electron 桥）。

vi.mock('@/services/nativeLocalMusic', () => ({
  isAndroidNativeRuntime: () => false,
}));

import {
  buildTagFieldsForSong,
  collectTagWriteBackPreview,
  executeTagWriteBack,
  nextAvailableName,
  renderRenameTemplate,
  type TagWriteBackPreviewItem,
} from '@/services/localTagWriteBackService';
import type { LocalSong } from '@/types';

const makeSong = (overrides: Partial<LocalSong> = {}): LocalSong => ({
  id: 'song-1',
  fileName: '01 - Old.mp3',
  filePath: 'Music/01 - Old.mp3',
  duration: 0,
  fileSize: 1,
  mimeType: 'audio/mpeg',
  addedAt: 0,
  title: '新标题',
  titleOrigin: 'manual-match',
  importedMetadata: {
    title: '文件名标题',
    titleSource: 'filename',
    artistNames: ['导入艺术家'],
    albumName: '导入专辑',
  },
  ...overrides,
});

describe('buildTagFieldsForSong', () => {
  it('在线匹配结果优先，导入快照兜底', () => {
    const online = buildTagFieldsForSong(makeSong({
      onlineMetadata: {
        source: 'netease' as never,
        artists: [{ name: '在线艺术家' }],
        album: { name: '在线专辑' },
        matchMode: 'manual',
        matchedAt: 0,
      },
      trackNumber: 3,
    }));
    expect(online).toMatchObject({
      title: '新标题',
      artist: '在线艺术家',
      album: '在线专辑',
      albumArtist: '在线艺术家',
      track: 3,
    });
  });

  it('没有在线匹配时用导入快照', () => {
    const fields = buildTagFieldsForSong(makeSong());
    expect(fields).toMatchObject({ title: '新标题', artist: '导入艺术家', album: '导入专辑', albumArtist: '导入艺术家' });
    expect(fields.track).toBeUndefined();
  });

  it('多艺术家用 " / " 连接', () => {
    const fields = buildTagFieldsForSong(makeSong({
      onlineMetadata: {
        source: 'netease' as never,
        artists: [{ name: 'A' }, { name: 'B' }],
        matchMode: 'manual',
        matchedAt: 0,
      },
    }));
    expect(fields.artist).toBe('A / B');
  });
});

describe('renderRenameTemplate', () => {
  it('渲染变量、清洗非法字符', () => {
    expect(renderRenameTemplate('{artist} - {title}', {
      title: '歌名', artist: 'A/B:C', album: '', track: '', year: '',
    })).toBe('A B C - 歌名');
  });

  it('全空渲染返回 null', () => {
    expect(renderRenameTemplate('{title}', { title: '', artist: '', album: '', track: '', year: '' })).toBeNull();
  });
});

describe('nextAvailableName', () => {
  it('冲突自动加序号且大小写不敏感', () => {
    expect(nextAvailableName(['a.mp3'], 'a', '.mp3')).toBe('a (2).mp3');
    expect(nextAvailableName(['A.MP3'], 'a', '.mp3')).toBe('a (2).mp3');
    expect(nextAvailableName([], 'a', '.mp3')).toBe('a.mp3');
  });
});

describe('collectTagWriteBackPreview / executeTagWriteBack', () => {
  const setupElectron = (readImpl: (filePath: string) => unknown, writeImpl?: (filePath: string, tags: unknown) => unknown) => {
    const write = vi.fn(writeImpl ?? ((_path, _tags) => ({ ok: true })));
    const electron = {
      webUtils: { getPathForFile: (file: { name: string }) => `/music/${file.name}` },
      localTags: {
        read: vi.fn(readImpl),
        write,
        renameFiles: vi.fn(),
      },
    };
    (globalThis as { electron?: unknown }).electron = electron;
    (globalThis as { window?: unknown }).window = { electron };
    return write;
  };

  const makeSongWithPath = (song: LocalSong) => ({
    ...song,
    fileHandle: { getFile: async () => ({ name: song.fileName }) } as unknown as FileSystemFileHandle,
  });

  it('算出旧值 → 新值 diff，未变化的字段不进 changes', async () => {
    setupElectron(() => ({ ok: true, tags: { title: '旧标题', artist: null, album: '在线专辑', albumArtist: null, track: 3, year: null } }));
    const items = await collectTagWriteBackPreview([
      makeSongWithPath(makeSong({
        onlineMetadata: {
          source: 'netease' as never,
          artists: [{ name: '在线艺术家' }],
          album: { name: '在线专辑' },
          matchMode: 'manual',
          matchedAt: 0,
        },
        trackNumber: 3,
      })),
    ]);
    expect(items[0].error).toBeUndefined();
    const changed = items[0].changes.map(change => change.field);
    expect(changed).toEqual(['title', 'artist', 'albumArtist']);
  });

  it('拿不到绝对路径时标记 no-path 且执行时跳过', async () => {
    setupElectron(() => ({ ok: true, tags: {} }));
    const items = await collectTagWriteBackPreview([makeSong()]);
    expect(items[0].error).toBe('no-path');
    const results = await executeTagWriteBack(items as TagWriteBackPreviewItem[]);
    expect(results[0].ok).toBe(false);
  });

  it('执行逐文件调用主进程并透传结果', async () => {
    const write = setupElectron(
      () => ({ ok: true, tags: { title: null, artist: null, album: null, albumArtist: null, track: null, year: null } }),
      (filePath) => ({ ok: filePath !== '/music/bad.mp3', error: filePath === '/music/bad.mp3' ? 'EACCES' : undefined }),
    );
    const items = await collectTagWriteBackPreview([
      makeSongWithPath(makeSong({ id: 'good' })),
      makeSongWithPath(makeSong({ id: 'bad', fileName: 'bad.mp3' })),
    ]);
    const results = await executeTagWriteBack(items);
    expect(results.map(result => result.ok)).toEqual([true, false]);
    expect(write).toHaveBeenCalledTimes(2);
  });
});
