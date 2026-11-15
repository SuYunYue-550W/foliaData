import { createRequire } from 'module';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { afterAll, describe, expect, it } from 'vitest';

// test/unit/electron/localTagWrite.test.ts
// 主进程标签读写模块：纯函数（模板/冲突序号）+ Node 环境造的最小样本文件（mp3/flac/ogg/m4a）。

const require = createRequire(import.meta.url);
const module = require('../../../electron/localTagWrite.cjs') as typeof import('../../../electron/localTagWrite.cjs');

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'folia-tag-'));
afterAll(() => {
  fs.rmSync(WORK, { recursive: true, force: true });
});

const TAGS = { title: '测试标题', artist: '测试艺术家', album: '测试专辑', albumArtist: '专辑艺术家', track: 7, year: '2001' };

// —— 样本构造 ——

function findAtomLength(buffer: Buffer, name: string): number {
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset);
    if (buffer.toString('latin1', offset + 4, offset + 8) === name) return size;
    if (size < 8) break;
    offset += size;
  }
  return 0;
}

function makeId3v2Mp3(preservedFrameId?: string): Buffer {
  const frames: Buffer[] = [];
  if (preservedFrameId) {
    // 一帧 APIC 样式的二进制帧（内容随意），验证写回时保留。
    const body = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    const frame = Buffer.alloc(10 + body.length);
    frame.write(preservedFrameId, 0, 'ascii');
    frame.writeUInt32BE(body.length, 4);
    body.copy(frame, 10);
    frames.push(frame);
  }
  const body = Buffer.concat(frames);
  const header = Buffer.alloc(10);
  header.write('ID3', 0, 'ascii');
  header[3] = 4;
  const size = body.length;
  header[6] = (size >> 21) & 0x7f;
  header[7] = (size >> 14) & 0x7f;
  header[8] = (size >> 7) & 0x7f;
  header[9] = size & 0x7f;
  return Buffer.concat([header, body, Buffer.from([0xff, 0xfb, 0x90, 0x00])]);
}

function makeFlac(): Buffer {
  const vendor = Buffer.from('test', 'utf8');
  const comment = Buffer.alloc(4 + vendor.length + 4);
  comment.writeUInt32LE(vendor.length, 0);
  vendor.copy(comment, 4);
  comment.writeUInt32LE(0, 4 + vendor.length);
  const streamInfo = Buffer.alloc(34, 7);
  const blockHeader = (last: number, type: number, length: number) => Buffer.from([last << 7 | type, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff]);
  return Buffer.concat([
    Buffer.from('fLaC', 'ascii'),
    blockHeader(0, 0, streamInfo.length), streamInfo,
    blockHeader(1, 4, comment.length), comment,
  ]);
}

function makeOggPacket(bytes: Buffer, chunks = 255): Buffer[] {
  // 拆成 ≤255 字节的段（模拟跨页包）
  const segments: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunks) {
    segments.push(bytes.subarray(offset, Math.min(offset + chunks, bytes.length)));
  }
  return segments.length ? segments : [Buffer.alloc(0)];
}

function oggCrc(buffer: Buffer): number {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let v = i << 24;
    for (let b = 0; b < 8; b += 1) v = (v & 0x80000000) ? ((v << 1) ^ 0x04c11db7) : (v << 1);
    table[i] = v >>> 0;
  }
  let crc = 0;
  for (const byte of buffer) crc = ((crc << 8) ^ table[((crc >>> 24) ^ byte) & 0xff]) >>> 0;
  return crc >>> 0;
}

function buildOggPage({ granule, serial, sequence, isBos, segments }: {
  granule: number; serial: number; sequence: number; isBos: boolean; segments: Buffer[];
}): Buffer {
  const headerSize = 27 + segments.length;
  const payloadLength = segments.reduce((sum, s) => sum + s.length, 0);
  const page = Buffer.alloc(headerSize + payloadLength);
  page.write('OggS', 0, 'ascii');
  page[5] = isBos ? 0x02 : 0;
  page.writeBigInt64LE(BigInt(granule), 6);
  page.writeUInt32LE(serial, 14);
  page.writeUInt32LE(sequence, 18);
  page[26] = segments.length;
  let offset = 27;
  for (const segment of segments) {
    page[offset] = segment.length === 255 ? 255 : segment.length;
    offset += 1;
  }
  for (const segment of segments) {
    segment.copy(page, offset);
    offset += segment.length;
  }
  page.writeUInt32LE(oggCrc(page), 22);
  return page;
}

function makeOgg(): Buffer {
  const ident = Buffer.concat([Buffer.from([0x01, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73]), Buffer.alloc(23)]);
  const commentBody = (() => {
    const vendor = Buffer.from('test', 'utf8');
    const packet = Buffer.alloc(4 + vendor.length + 4);
    packet.writeUInt32LE(vendor.length, 0);
    vendor.copy(packet, 4);
    packet.writeUInt32LE(0, 4 + vendor.length);
    return Buffer.concat([Buffer.from([0x03, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73]), packet]);
  })();
  const setup = Buffer.concat([Buffer.from([0x05, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73]), Buffer.alloc(100, 0xaa)]);
  const serial = 0x1234;
  return Buffer.concat([
    buildOggPage({ granule: 0, serial, sequence: 0, isBos: true, segments: makeOggPacket(ident) }),
    buildOggPage({ granule: 0, serial, sequence: 1, isBos: false, segments: makeOggPacket(commentBody) }),
    buildOggPage({ granule: 0, serial, sequence: 2, isBos: false, segments: makeOggPacket(setup) }),
    // 音频包跨页：两个 255 段的包 + 收尾包
    buildOggPage({ granule: 100, serial, sequence: 3, isBos: false, segments: [...makeOggPacket(Buffer.alloc(300, 0x11))].slice(0, 2) }),
    buildOggPage({ granule: 200, serial, sequence: 4, isBos: false, segments: makeOggPacket(Buffer.alloc(10, 0x22)) }),
  ]);
}

function makeM4a(): Buffer {
  const item = (key: string, text: string) => {    const payload = Buffer.from(text, 'utf8');
    const data = Buffer.alloc(16 + payload.length);
    data.writeUInt32BE(data.length, 0);
    data.write('data', 4, 'ascii');
    data.writeUInt32BE(1, 8);
    payload.copy(data, 16);
    const atom = Buffer.alloc(8 + data.length);
    atom.writeUInt32BE(atom.length, 0);
    atom.write(key, 4, 'latin1');
    data.copy(atom, 8);
    return atom;
  };
  const covr = item('covr', 'x');
  const ilstInner = Buffer.concat([item('\u00a9nam', 'old-title'), covr]);
  const ilst = Buffer.alloc(8 + ilstInner.length);
  ilst.writeUInt32BE(ilst.length, 0);
  ilst.write('ilst', 4, 'ascii');
  ilstInner.copy(ilst, 8);
  const metaBody = Buffer.concat([Buffer.alloc(4), ilst]);
  const meta = Buffer.alloc(8 + metaBody.length);
  meta.writeUInt32BE(meta.length, 0);
  meta.write('meta', 4, 'ascii');
  metaBody.copy(meta, 8);
  const udta = (() => {
    const atom = Buffer.alloc(8 + meta.length);
    atom.writeUInt32BE(atom.length, 0);
    atom.write('udta', 4, 'ascii');
    meta.copy(atom, 8);
    return atom;
  })();
  const moovBody = (() => {
    // stco 一个块偏移，写 1000
    // stco：version/flags(4) + count(4) + 1 个偏移(4)
    const stcoBody = Buffer.alloc(12);
    stcoBody.writeUInt32BE(1, 4);
    stcoBody.writeUInt32BE(1000, 8);
    const stco = Buffer.alloc(8 + stcoBody.length);
    stco.writeUInt32BE(stco.length, 0);
    stco.write('stco', 4, 'ascii');
    stcoBody.copy(stco, 8);
    return Buffer.concat([udta, stco]);
  })();
  const moov = Buffer.alloc(8 + moovBody.length);
  moov.writeUInt32BE(moov.length, 0);
  moov.write('moov', 4, 'ascii');
  moovBody.copy(moov, 8);
  const ftyp = (() => {
    const atom = Buffer.alloc(16);
    atom.writeUInt32BE(16, 0);
    atom.write('ftyp', 4, 'ascii');
    atom.write('M4A ', 8, 'ascii');
    return atom;
  })();
  const mdat = (() => {
    const atom = Buffer.alloc(8 + 10);
    atom.writeUInt32BE(atom.length, 0);
    atom.write('mdat', 4, 'ascii');
    return atom;
  })();
  return Buffer.concat([ftyp, moov, mdat]);
}

// —— 纯逻辑 ——

describe('renderRenameTemplate', () => {
  it('渲染变量并清理非法字符', () => {
    expect(module.renderRenameTemplate('{artist} - {title}', {
      title: 'Song', artist: 'A/B', album: '', track: '', year: '',
    })).toBe('A B - Song');
  });

  it('未知变量原样保留，空结果返回 null', () => {
    expect(module.renderRenameTemplate('{unknown}', { title: '', artist: '', album: '', track: '', year: '' })).toBe('{unknown}');
    expect(module.renderRenameTemplate('{title}', { title: '   ', artist: '', album: '', track: '', year: '' })).toBeNull();
    expect(module.renderRenameTemplate('no variables', { title: 'x', artist: '', album: '', track: '', year: '' })).toBeNull();
  });

  it('track 数字可用作变量', () => {
    expect(module.renderRenameTemplate('{track}. {title}', { title: 'Song', artist: '', album: '', track: '7', year: '' })).toBe('7. Song');
  });
});

describe('nextAvailableName', () => {
  it('无冲突直接用原名，冲突自动加序号', () => {
    expect(module.nextAvailableName([], 'a', '.mp3')).toBe('a.mp3');
    expect(module.nextAvailableName(['a.mp3'], 'a', '.mp3')).toBe('a (2).mp3');
    expect(module.nextAvailableName(['a.mp3', 'a (2).mp3', 'A (3).MP3'], 'a', '.mp3')).toBe('a (4).mp3');
  });
});

// —— 样本文件端到端 ——

describe('writeAudioTags / readAudioTags roundtrip', () => {
  const writeAndRead = async (name: string, source: Buffer) => {
    const filePath = path.join(WORK, name);
    fs.writeFileSync(filePath, source);
    const write = await module.writeAudioTags(filePath, TAGS);
    expect(write.ok).toBe(true);
    const read = await module.readAudioTags(filePath);
    expect(read.ok).toBe(true);
    return { read, filePath };
  };

  it('mp3（ID3v2.4）写回并可读回，未知帧保留', async () => {
    const { read, filePath } = await writeAndRead('sample.mp3', makeId3v2Mp3('APIC'));
    expect(read.tags).toMatchObject({ title: TAGS.title, artist: TAGS.artist, album: TAGS.album, albumArtist: TAGS.albumArtist, track: 7, year: '2001' });
    const buffer = fs.readFileSync(filePath);
    // APIC 帧体还在文件里
    expect(buffer.toString('hex').includes('00010203')).toBe(true);
    expect(fs.existsSync(`${filePath}.bak`)).toBe(true);
  });

  it('flac（VORBIS_COMMENT）写回并可读回，STREAMINFO 保留', async () => {
    const { read, filePath } = await writeAndRead('sample.flac', makeFlac());
    expect(read.tags).toMatchObject({ title: TAGS.title, track: 7, year: '2001' });
    expect(fs.readFileSync(filePath).subarray(4, 8)).toEqual(Buffer.from([0x00, 0, 0, 34]));
    expect(fs.existsSync(`${filePath}.bak`)).toBe(true);
  });

  it('ogg（vorbis 注释头）写回并可读回，音频字节保留', async () => {
    const { read, filePath } = await writeAndRead('sample.ogg', makeOgg());
    expect(read.tags).toMatchObject({ title: TAGS.title, artist: TAGS.artist });
    // 0x11 与 0x22 的音频包内容仍在
    const out = fs.readFileSync(filePath);
    expect(out.includes(Buffer.alloc(255, 0x11))).toBe(true);
    expect(out.includes(Buffer.alloc(10, 0x22))).toBe(true);
    expect(fs.existsSync(`${filePath}.bak`)).toBe(true);
  });

  it('m4a（ilst）写回并可读回，stco 偏移被补丁', async () => {
    const source = makeM4a();
    const filePath = path.join(WORK, 'sample.m4a');
    fs.writeFileSync(filePath, source);
    const write = await module.writeAudioTags(filePath, TAGS);
    expect(write.ok).toBe(true);
    const read = await module.readAudioTags(filePath);
    expect(read.tags).toMatchObject({ title: TAGS.title, artist: TAGS.artist, album: TAGS.album, albumArtist: TAGS.albumArtist, year: '2001' });
    const out = fs.readFileSync(filePath);
    const oldMoov = findAtomLength(source, 'moov');
    const newMoov = findAtomLength(out, 'moov');
    const moovStart = out.indexOf('moov') - 4;
    const moovEnd = moovStart + newMoov;
    const stcoIndex = out.indexOf('stco', moovStart) - 4;
    expect(out.readUInt32BE(stcoIndex + 12)).toBe(1);
    expect(out.readUInt32BE(stcoIndex + 16)).toBe(1000 + (newMoov - oldMoov));
    expect(fs.existsSync(`${filePath}.bak`)).toBe(true);
  });

  it('不支持的格式返回错误', async () => {
    const filePath = path.join(WORK, 'sample.wav');
    fs.writeFileSync(filePath, Buffer.from('RIFF'));
    expect((await module.readAudioTags(filePath)).ok).toBe(false);
    expect((await module.writeAudioTags(filePath, TAGS)).ok).toBe(false);
  });

  it('空值字段不覆盖旧值', async () => {
    const filePath = path.join(WORK, 'keep.mp3');
    fs.writeFileSync(filePath, makeId3v2Mp3());
    await module.writeAudioTags(filePath, { title: 'new', artist: '', album: '', albumArtist: '', track: 0, year: '' });
    const read = await module.readAudioTags(filePath);
    expect(read.tags.title).toBe('new');
    expect(read.tags.artist).toBeNull();
  });
});

describe('renameAudioFiles', () => {
  it('批量重命名并在同批内解决冲突', async () => {
    const dir = path.join(WORK, 'rename');
    fs.mkdirSync(dir);
    const first = path.join(dir, 'a.mp3');
    const second = path.join(dir, 'b.mp3');
    fs.writeFileSync(first, makeId3v2Mp3());
    fs.writeFileSync(second, makeId3v2Mp3());
    const results = await module.renameAudioFiles([
      { filePath: first, newBaseName: 'same' },
      { filePath: second, newBaseName: 'same' },
    ]);
    expect(results[0].ok).toBe(true);
    expect(results[0].newName).toBe('same.mp3');
    expect(results[1].ok).toBe(true);
    expect(results[1].newName).toBe('same (2).mp3');
    expect(fs.existsSync(path.join(dir, 'same.mp3'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'same (2).mp3'))).toBe(true);
  });
});
