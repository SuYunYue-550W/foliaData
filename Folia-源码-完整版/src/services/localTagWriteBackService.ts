import type { LocalSong } from '../types';
import type { LocalAudioTagsSnapshot, LocalSongTitleOrigin } from '../types/localLibrary';
import { isAndroidNativeRuntime } from './nativeLocalMusic';

// src/services/localTagWriteBackService.ts
// 本地曲库「写回文件标签 / 按模板重命名文件」。
//
// 分工：文件字节在主进程（electron/localTagWrite.cjs，IPC window.electron.localTags），
// 这里只做三件纯逻辑 + 编排的事：
//   1. 从曲库实体上已有的元数据算出每首歌的目标标签（buildTagFieldsForSong）；
//   2. 收集预览（解析绝对路径 → 读旧标签 → 与目标做 diff）；
//   3. 执行（逐文件调用主进程，失败逐文件返回）。
// 模板渲染与冲突序号在主进程实现并测试，这里负责把每首歌的字段喂给它。
//
// 平台：只有桌面端（Electron）能拿到绝对路径并写任意文件；安卓/Capacitor 上
// isTagWriteBackAvailable() 返回 false，UI 不显示入口。

export type TagWriteField = 'title' | 'artist' | 'album' | 'albumArtist' | 'track' | 'year';

export interface TagFieldChange {
  field: TagWriteField;
  from: string | null;
  to: string;
}

export interface TagWriteBackPreviewItem {
  songId: string;
  fileName: string;
  absolutePath: string;
  tags: Partial<Record<TagWriteField, string | number>>;
  changes: TagFieldChange[];
  /** 路径解析不了 / 格式不支持等：这一首不会执行。 */
  error?: 'no-path' | 'unsupported' | 'read-failed';
}

export interface TagWriteBackFileResult {
  songId: string;
  fileName: string;
  ok: boolean;
  error?: string;
}

export const isTagWriteBackAvailable = (): boolean => (
  typeof window !== 'undefined'
  && Boolean(window.electron?.localTags)
  && !isAndroidNativeRuntime()
);

/**
 * 目标标签来源 = 曲库实体上已有的元数据：
 * 标题用规范 title（在线匹配后就是在线标题）；艺术家/专辑优先在线匹配结果，
 * 否则退回导入快照；专辑艺术家取第一艺术家；音轨号用 trackNumber。
 * 库实体上没有「年份」字段 —— year 目标恒为空，写回时跳过该字段（保留文件旧值）。
 */
export const buildTagFieldsForSong = (song: LocalSong): Partial<Record<TagWriteField, string | number>> => {
  const online = song.onlineMetadata;
  const artistNames = online?.artists?.map(artist => artist.name).filter(Boolean)
    ?? song.importedMetadata?.artistNames?.filter(Boolean)
    ?? [];
  const album = online?.album?.name || song.importedMetadata?.albumName || undefined;
  const fields: Partial<Record<TagWriteField, string | number>> = {
    title: song.title || undefined,
    artist: artistNames.length > 0 ? artistNames.join(' / ') : undefined,
    album,
    albumArtist: artistNames[0],
  };
  if (Number.isInteger(song.trackNumber) && (song.trackNumber ?? 0) > 0) {
    fields.track = song.trackNumber;
  }
  return fields;
};

/** 比较口径：track 按数字，其余按字符串；from 为 null 表示文件里原本没有。 */
const fieldEquals = (a: string | number | null | undefined, b: string | number | null | undefined) => {
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  return String(a ?? '').trim() === String(b ?? '').trim();
};

/**
 * 收集批量预览。逐首歌解析绝对路径（Electron 下从文件句柄拿 File 再走
 * webUtils.getPathForFile），读当前标签，算出「旧值 → 新值」diff。
 * 单首失败不中断整批 —— 预览里标 error，执行时跳过。
 */
export const collectTagWriteBackPreview = async (songs: LocalSong[]): Promise<TagWriteBackPreviewItem[]> => {
  const electron = typeof window === 'undefined' ? undefined : window.electron;
  if (!electron?.localTags || !electron.webUtils) return [];
  const items: TagWriteBackPreviewItem[] = [];
  for (const song of songs) {
    const fileName = song.fileName;
    let absolutePath = '';
    try {
      const file = await song.fileHandle?.getFile();
      absolutePath = file ? electron.webUtils.getPathForFile(file) : '';
    } catch {
      absolutePath = '';
    }
    if (!absolutePath) {
      items.push({ songId: song.id, fileName, absolutePath: '', tags: {}, changes: [], error: 'no-path' });
      continue;
    }
    if (!/\.(mp3|flac|ogg|oga|m4a)$/i.test(absolutePath)) {
      items.push({ songId: song.id, fileName, absolutePath, tags: {}, changes: [], error: 'unsupported' });
      continue;
    }
    const current = await electron.localTags.read(absolutePath);
    if (!current.ok) {
      items.push({ songId: song.id, fileName, absolutePath, tags: {}, changes: [], error: 'read-failed' });
      continue;
    }
    const targets = buildTagFieldsForSong(song);
    const changes: TagFieldChange[] = [];
    (Object.keys(targets) as TagWriteField[]).forEach((field) => {
      const to = targets[field];
      if (to === undefined || to === null || to === '') return;
      const from = current.tags[field];
      if (!fieldEquals(from, to)) {
        changes.push({ field, from: from === null || from === undefined ? null : String(from), to: String(to) });
      }
    });
    items.push({ songId: song.id, fileName, absolutePath, tags: targets, changes });
  }
  return items;
};


/** 执行标签写回。预览里有 error 的项直接跳过并作为失败返回；逐文件独立报告。 */
export const executeTagWriteBack = async (items: TagWriteBackPreviewItem[]): Promise<TagWriteBackFileResult[]> => {
  const electron = typeof window === 'undefined' ? undefined : window.electron;
  if (!electron?.localTags) return [];
  const results: TagWriteBackFileResult[] = [];
  for (const item of items) {
    if (item.error || !item.absolutePath) {
      results.push({ songId: item.songId, fileName: item.fileName, ok: false, error: item.error ?? 'no-path' });
      continue;
    }
    const stringField = (field: 'title' | 'artist' | 'album' | 'albumArtist' | 'year'): string | undefined => {
      const value = item.tags[field];
      return value === undefined || value === null || value === '' ? undefined : String(value);
    };
    const payload: Partial<LocalAudioTagsSnapshot> = {
      title: stringField('title'),
      artist: stringField('artist'),
      album: stringField('album'),
      albumArtist: stringField('albumArtist'),
      year: stringField('year'),
      track: item.tags.track ? Number(item.tags.track) : undefined,
    };
    const response = await electron.localTags.write(item.absolutePath, payload);
    results.push({ songId: item.songId, fileName: item.fileName, ok: response.ok, error: response.error });
  }
  return results;
};

// ——— 模板重命名（预览在渲染进程，落盘在主进程做冲突序号） ———

export interface RenamePreviewItem {
  songId: string;
  fileName: string;
  absolutePath: string;
  newBaseName: string;
  error?: 'no-path' | 'unsupported' | 'template-empty';
}

/** 模板重命名预览：字段同标签写回（year 库实体上没有，变量渲染为空）。 */
export const collectRenamePreview = async (
  songs: LocalSong[],
  template: string,
): Promise<RenamePreviewItem[]> => {
  const electron = typeof window === 'undefined' ? undefined : window.electron;
  if (!electron?.webUtils) return [];
  const items: RenamePreviewItem[] = [];
  for (const song of songs) {
    let absolutePath = '';
    try {
      const file = await song.fileHandle?.getFile();
      absolutePath = file ? electron.webUtils.getPathForFile(file) : '';
    } catch {
      absolutePath = '';
    }
    if (!absolutePath) {
      items.push({ songId: song.id, fileName: song.fileName, absolutePath: '', newBaseName: '', error: 'no-path' });
      continue;
    }
    if (!/\.(mp3|flac|ogg|oga|m4a)$/i.test(absolutePath)) {
      items.push({ songId: song.id, fileName: song.fileName, absolutePath, newBaseName: '', error: 'unsupported' });
      continue;
    }
    const fields = buildTagFieldsForSong(song);
    const base = renderRenameTemplate(template, {
      title: String(fields.title ?? ''),
      artist: String(fields.artist ?? ''),
      album: String(fields.album ?? ''),
      track: fields.track ? String(fields.track) : '',
      year: String(fields.year ?? ''),
    });
    if (!base) {
      items.push({ songId: song.id, fileName: song.fileName, absolutePath, newBaseName: '', error: 'template-empty' });
      continue;
    }
    items.push({ songId: song.id, fileName: song.fileName, absolutePath, newBaseName: base });
  }
  return items;
};

export const executeTemplateRename = async (items: RenamePreviewItem[]): Promise<TagWriteBackFileResult[]> => {
  const electron = typeof window === 'undefined' ? undefined : window.electron;
  if (!electron?.localTags) return [];
  const valid = items.filter(item => !item.error && item.absolutePath && item.newBaseName);
  const skipped = items.filter(item => item.error || !item.absolutePath || !item.newBaseName);
  const responses = valid.length > 0
    ? await electron.localTags.renameFiles(valid.map(item => ({ filePath: item.absolutePath, newBaseName: item.newBaseName })))
    : [];
  const results: TagWriteBackFileResult[] = valid.map((item, index) => ({
    songId: item.songId,
    fileName: item.fileName,
    ok: responses[index]?.ok === true,
    error: responses[index]?.error,
  }));
  skipped.forEach(item => results.push({ songId: item.songId, fileName: item.fileName, ok: false, error: item.error ?? 'no-path' }));
  return results;
};

// ——— 纯逻辑（主进程也有一份同语义实现；这里供渲染侧单测与预览展示用） ———

const sanitizeFileNamePart = (value: string): string => (
  String(value ?? '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
);

export const RENAME_TEMPLATE_VARIABLES = ['title', 'artist', 'album', 'track', 'year'] as const;

export type RenameTemplateFields = Record<'title' | 'artist' | 'album' | 'track' | 'year', string>;

export const renderRenameTemplate = (template: string, fields: RenameTemplateFields): string | null => {
  if (!template || !/\{[a-z]+\}/i.test(template)) return null;
  const rendered = template.replace(/\{([a-zA-Z]+)\}/g, (match, rawName: string) => {
    const name = rawName.toLowerCase();
    if (!(RENAME_TEMPLATE_VARIABLES as readonly string[]).includes(name)) return match;
    return sanitizeFileNamePart(fields[name as keyof RenameTemplateFields] ?? '');
  });
  const cleaned = rendered.replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');
  if (!cleaned || cleaned === '.' || cleaned === '..') return null;
  return cleaned;
};

/** 同目录冲突自动加序号：`name (2).ext`、`name (3).ext`……（大小写不敏感）。 */
export const nextAvailableName = (takenNames: Iterable<string>, baseName: string, extension: string): string => {
  const taken = new Set(Array.from(takenNames, name => name.toLowerCase()));
  if (!taken.has(`${baseName}${extension}`.toLowerCase())) return `${baseName}${extension}`;
  for (let index = 2; ; index += 1) {
    const candidate = `${baseName} (${index})${extension}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
};

// 供本地曲库其它入口判断「这批歌里有没有可写回的」（titleOrigin 仅做日志参考）。
export const describeTagWriteSource = (song: LocalSong): LocalSongTitleOrigin => song.titleOrigin;
