'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// electron/localTagWrite.cjs
// 本地曲库「写回文件标签 / 按模板重命名文件」的主进程实现。
//
// 设计取舍（评审可对照）：
// · 不引新依赖。现有依赖里 music-metadata 只有读没有写（其 write 层不在依赖树里），
//   node-taglib 是原生模块（electron-builder npmRebuild=false，装不进去），所以四种
//   格式的标签读写全部手写最小实现 —— 只动 tag 帧/注释块，音频字节一字不改。
// · 备份策略（最简单可预期的一种）：写回前把原文件复制为同目录 `原文件名.bak`，
//   每次写回都覆盖旧备份（始终保留「最近一次写回前」的状态）。写回用临时文件 +
//   rename 原子替换，任何一步失败原文件都完好。
// · 字段：title / artist / album / albumArtist / track / year。值为空（库实体上没有）
//   的字段不写，保留文件里的旧值。
//
// 支持格式：
//   mp3  —— ID3v2.4。写：重建整个 ID3v2 标签，本模块不管的帧（APIC/USLT 等）原样保留；
//           读：v2.3/v2.4 文本帧（v2.3 的 TYER 归到 year）。
//   flac —— VORBIS_COMMENT 元数据块整体替换，其余块（含 PICTURE）原样保留。
//   ogg  —— Vorbis 注释头包（第 2 个逻辑包）替换后整流重新分页（lacing 由页面本身给出，
//           包边界可以精确恢复；音频包字节不动，只重排页框、页序号重排、CRC 重算）。
//           只支持单逻辑流；看到第二个 serial 直接报 unsupported。
//   m4a  —— moov.udta.meta.ilst 里替换/新增我们的六个键，其余项（covr 等）保留；
//           moov 变长时，若 moov 在 mdat 之前则按差值补丁 stco/co64 块偏移。

// ——— 通用 ———

const TEXT_FIELDS = ['title', 'artist', 'album', 'albumArtist', 'track', 'year'];
const SUPPORTED_EXTENSIONS = new Set(['.mp3', '.flac', '.ogg', '.oga', '.m4a']);

const isSupportedAudioFile = (filePath) => SUPPORTED_EXTENSIONS.has(path.extname(filePath || '').toLowerCase());

const normalizeWriteTags = (raw) => {
  const tags = {};
  if (!raw || typeof raw !== 'object') return tags;
  const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
  tags.title = text(raw.title);
  tags.artist = text(raw.artist);
  tags.album = text(raw.album);
  tags.albumArtist = text(raw.albumArtist);
  tags.year = text(raw.year);
  const track = Number(raw.track);
  tags.track = Number.isInteger(track) && track > 0 ? track : null;
  return tags;
};

const normalizeTagsForOutput = (tags) => ({
  title: tags.title ?? null,
  artist: tags.artist ?? null,
  album: tags.album ?? null,
  albumArtist: tags.albumArtist ?? null,
  track: Number.isFinite(tags.track) ? tags.track : null,
  year: tags.year ?? null,
});

// 备份 + 原子写：先把现文件复制成 .bak（每次覆盖，只留最近一次写回前的状态），
// 再写临时文件、rename 换掉原文件。任何一步失败，原文件都没动过。
async function backupAndReplace(filePath, writeTempFile) {
  const backupPath = `${filePath}.bak`;
  await fsp.copyFile(filePath, backupPath);
  const tempPath = `${filePath}.folia-tag-tmp`;
  try {
    await writeTempFile(tempPath);
    await fsp.rename(tempPath, filePath);
  } catch (error) {
    await fsp.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return backupPath;
}

// ——— Vorbis 注释（flac 与 ogg 共用） ———
// 结构：vendor 长度(LE32) + vendor + 条目数(LE32) + (条目长度(LE32) + "KEY=value")*。

function buildVorbisCommentPacket(comments) {
  const vendor = 'folia tag write-back';
  const vendorBytes = Buffer.from(vendor, 'utf8');
  const entries = [];
  for (const [key, value] of Object.entries(comments)) {
    if (value === null || value === undefined || value === '') continue;
    entries.push(Buffer.from(`${key.toUpperCase()}=${value}`, 'utf8'));
  }
  const size = 4 + vendorBytes.length + 4 + entries.reduce((sum, entry) => sum + 4 + entry.length, 0);
  const packet = Buffer.alloc(size);
  let offset = 0;
  offset = packet.writeUInt32LE(vendorBytes.length, offset);
  vendorBytes.copy(packet, offset);
  offset += vendorBytes.length;
  offset = packet.writeUInt32LE(entries.length, offset);
  for (const entry of entries) {
    offset = packet.writeUInt32LE(entry.length, offset);
    entry.copy(packet, offset);
    offset += entry.length;
  }
  return packet;
}

function parseVorbisCommentPacket(buffer) {
  const tags = {};
  if (buffer.length < 8) return tags;
  const vendorLength = buffer.readUInt32LE(0);
  let offset = 4 + vendorLength;
  if (offset + 4 > buffer.length) return tags;
  const count = buffer.readUInt32LE(offset);
  offset += 4;
  for (let index = 0; index < count && offset + 4 <= buffer.length; index += 1) {
    const length = buffer.readUInt32LE(offset);
    offset += 4;
    if (offset + length > buffer.length) break;
    const entry = buffer.subarray(offset, offset + length).toString('utf8');
    offset += length;
    const equals = entry.indexOf('=');
    if (equals <= 0) continue;
    const key = entry.slice(0, equals).toLowerCase();
    const value = entry.slice(equals + 1);
    if (key === 'tracknumber') {
      const parsed = parseInt(value, 10);
      if (Number.isFinite(parsed)) tags.track = parsed;
    } else if (key === 'date' || key === 'year') {
      tags.year = value.trim() || null;
    } else if (key === 'title') tags.title = value;
    else if (key === 'artist') tags.artist = tags.artist ? `${tags.artist}; ${value}` : value;
    else if (key === 'album') tags.album = value;
    else if (key === 'albumartist') tags.albumArtist = value;
  }
  return tags;
}

const vorbisCommentsFromTags = (tags) => {
  const comments = {};
  if (tags.title) comments.TITLE = tags.title;
  if (tags.artist) comments.ARTIST = tags.artist;
  if (tags.album) comments.ALBUM = tags.album;
  if (tags.albumArtist) comments.ALBUMARTIST = tags.albumArtist;
  if (tags.track) comments.TRACKNUMBER = String(tags.track);
  if (tags.year) comments.DATE = tags.year;
  return comments;
};

// ——— FLAC ———
// 元数据块：4 字节头（最高位 last-flag，低 7 位类型；类型 4 = VORBIS_COMMENT）+ 24 位大端长度。

function replaceFlacVorbisCommentBlock(buffer, tags) {
  if (buffer.length < 4 || buffer.toString('ascii', 0, 4) !== 'fLaC') {
    throw new Error('Not a FLAC file');
  }
  const commentPacket = buildVorbisCommentPacket(vorbisCommentsFromTags(tags));
  const blocks = [];
  let offset = 4;
  let replaced = false;
  while (offset + 4 <= buffer.length) {
    const header = buffer[offset];
    const type = header & 0x7f;
    const length = (buffer[offset + 1] << 16) | (buffer[offset + 2] << 8) | buffer[offset + 3];
    const body = buffer.subarray(offset + 4, offset + 4 + length);
    if (type === 4) {
      blocks.push({ type, last: header & 0x80, body: commentPacket });
      replaced = true;
    } else {
      blocks.push({ type, last: header & 0x80, body });
    }
    offset += 4 + length;
    if (header & 0x80) break;
  }
  if (!replaced) throw new Error('FLAC VORBIS_COMMENT block not found');
  const parts = [Buffer.from('fLaC', 'ascii')];
  blocks.forEach((block, index) => {
    const isLast = index === blocks.length - 1;
    const header = Buffer.alloc(4);
    header[0] = (isLast ? 0x80 : 0) | (block.type & 0x7f);
    header[1] = (block.body.length >> 16) & 0xff;
    header[2] = (block.body.length >> 8) & 0xff;
    header[3] = block.body.length & 0xff;
    parts.push(header, block.body);
  });
  parts.push(buffer.subarray(offset));
  return Buffer.concat(parts);
}

function parseFlacTags(buffer) {
  if (buffer.length < 4 || buffer.toString('ascii', 0, 4) !== 'fLaC') return {};
  let offset = 4;
  while (offset + 4 <= buffer.length) {
    const header = buffer[offset];
    const type = header & 0x7f;
    const length = (buffer[offset + 1] << 16) | (buffer[offset + 2] << 8) | buffer[offset + 3];
    if (type === 4) {
      return parseVorbisCommentPacket(buffer.subarray(offset + 4, offset + 4 + length));
    }
    offset += 4 + length;
    if (header & 0x80) break;
  }
  return {};
}

// ——— Ogg ———
// 页：'OggS' + 版本 + 头类型 + granule(LE64) + serial(LE32) + 序号(LE32) + CRC(LE32) + 段数 + lacing。

const OGG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index << 24;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 0x80000000) ? ((value << 1) ^ 0x04c11db7) : (value << 1);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function oggCrc(buffer) {
  let crc = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = ((crc << 8) ^ OGG_CRC_TABLE[((crc >>> 24) ^ buffer[index]) & 0xff]) >>> 0;
  }
  return crc >>> 0;
}

// 把字节流按页拆开，返回 { pages: [{granule, serial, isBos, isEos, packets: [Buffer]}], otherSerial }。
// lacing 值 255 表示包在本页未完（续到下一页），据此可精确恢复全部逻辑包边界。
function parseOggPages(buffer) {
  const pages = [];
  let offset = 0;
  while (offset + 27 <= buffer.length) {
    if (buffer.toString('ascii', offset, offset + 4) !== 'OggS') throw new Error('Corrupt Ogg page');
    const headerType = buffer[offset + 5];
    const granule = Number(buffer.readBigUInt64LE(offset + 6));
    const serial = buffer.readUInt32LE(offset + 14);
    const segmentCount = buffer[offset + 26];
    const segmentTable = buffer.subarray(offset + 27, offset + 27 + segmentCount);
    let payloadLength = 0;
    for (const value of segmentTable) payloadLength += value;
    const payloadStart = offset + 27 + segmentCount;
    if (payloadStart + payloadLength > buffer.length) throw new Error('Truncated Ogg page');
    pages.push({
      headerType,
      granule,
      serial,
      payload: buffer.subarray(payloadStart, payloadStart + payloadLength),
      lacing: segmentTable,
    });
    offset = payloadStart + payloadLength;
  }
  return pages;
}

function buildOggPage({ granule, serial, sequence, isBos, isEos, isContinued, segments }) {
  const segmentCount = segments.length;
  const headerSize = 27 + segmentCount;
  const payloadLength = segments.reduce((sum, segment) => sum + segment.length, 0);
  const page = Buffer.alloc(headerSize + payloadLength);
  page.write('OggS', 0, 'ascii');
  page[4] = 0;
  page[5] = (isBos ? 0x02 : 0) | (isEos ? 0x04 : 0) | (isContinued ? 0x01 : 0);
  page.writeBigUInt64LE(BigInt(Math.max(0, Math.floor(granule))), 6);
  page.writeUInt32LE(serial, 14);
  page.writeUInt32LE(sequence, 18);
  page.writeUInt32LE(0, 22); // CRC 先置零
  page[26] = segmentCount;
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

// 把一个（可能超过单页上限的）包拆成 255 字节段列表。
function packetToSegments(packet, pendingBytes) {
  const source = pendingBytes.length ? Buffer.concat([pendingBytes, packet]) : packet;
  const segments = [];
  for (let offset = 0; offset < source.length; offset += 255) {
    segments.push(source.subarray(offset, Math.min(offset + 255, source.length)));
  }
  if (source.length === 0) segments.push(Buffer.alloc(0));
  // 段序列的最后一个值决定包是否结束：不足 255 即结束；恰好 255 结尾则补一个 0 长段。
  if (segments[segments.length - 1].length === 255) segments.push(Buffer.alloc(0));
  return { segments, pending: Buffer.alloc(0) };
}

// 逻辑包重排成页：BOS 页只放标识头包；其余按 ≤255 段、≤64KB 贪心装页；
// 页 granule 取「在本页收尾的最后一个包」的收尾 granule；EOS 放最后一页。
function reframeOggPages(packets, serial) {
  const pages = [];
  let sequence = 0;
  const emitPage = ({ packets: group, isBos, isEos, isContinued, pendingBytes }) => {
    const segments = [];
    let pending = pendingBytes;
    for (const packet of group) {
      const split = packetToSegments(packet.packet, pending);
      pending = Buffer.alloc(0);
      segments.push(...split.segments);
    }
    const granule = group.length && group[group.length - 1].endGranule >= 0
      ? group[group.length - 1].endGranule
      : -1;
    pages.push(buildOggPage({ granule, serial, sequence, isBos, isEos, isContinued, segments }));
    sequence += 1;
  };

  // 第一页：只放标识头包。
  emitPage({ packets: [packets[0]], isBos: true, isEos: false, isContinued: false, pendingBytes: Buffer.alloc(0) });

  let index = 1;
  while (index < packets.length) {
    const group = [];
    let segmentCount = 0;
    let payloadBytes = 0;
    while (index < packets.length) {
      const packet = packets[index];
      const approxSegments = Math.max(1, Math.ceil(packet.packet.length / 255));
      if (group.length > 0 && (segmentCount + approxSegments > 255 || payloadBytes + packet.packet.length > 65025)) break;
      group.push(packet);
      segmentCount += approxSegments;
      payloadBytes += packet.packet.length;
      index += 1;
      if (segmentCount >= 255 || payloadBytes >= 65025) break;
    }
    emitPage({ packets: group, isBos: false, isEos: index >= packets.length, isContinued: false, pendingBytes: Buffer.alloc(0) });
  }
  return pages;
}

// 找到 vorbis 注释头包（0x03 + 'vorbis'）并替换，整流重新分页。
function replaceOggVorbisComment(buffer, tags) {
  const pages = parseOggPages(buffer);
  if (pages.length === 0) throw new Error('Empty Ogg stream');
  const serial = pages[0].serial;
  if (pages.some(page => page.serial !== serial)) throw new Error('Unsupported multiplexed Ogg stream');

  // 按页恢复逻辑包，并记录每个包「收尾页」的 granule。
  const packets = [];
  let pending = Buffer.alloc(0);
  for (const page of pages) {
    let segmentIndex = 0;
    while (segmentIndex < page.lacing.length) {
      const length = page.lacing[segmentIndex];
      pending = Buffer.concat([pending, page.payload.subarray(
        page.lacing.slice(0, segmentIndex).reduce((sum, value) => sum + value, 0),
        page.lacing.slice(0, segmentIndex).reduce((sum, value) => sum + value, 0) + length,
      )]);
      if (length < 255) {
        packets.push({ packet: pending, endGranule: page.granule });
        pending = Buffer.alloc(0);
      }
      segmentIndex += 1;
    }
  }

  const commentIndex = packets.findIndex(packet => packet.packet.length > 7
    && packet.packet[0] === 0x03
    && packet.packet.toString('ascii', 1, 7) === 'vorbis');
  if (commentIndex < 0) throw new Error('Vorbis comment header not found');
  packets[commentIndex] = {
    packet: Buffer.concat([
      Buffer.from([0x03]),
      Buffer.from('vorbis', 'ascii'),
      buildVorbisCommentPacket(vorbisCommentsFromTags(tags)),
    ]),
    endGranule: packets[commentIndex].endGranule,
  };

  return Buffer.concat(reframeOggPages(packets, serial));
}

function parseOggTags(buffer) {
  const pages = parseOggPages(buffer);
  const serial = pages.length ? pages[0].serial : 0;
  let pending = Buffer.alloc(0);
  let payloadOffsetInPage = 0;
  for (const page of pages) {
    if (page.serial !== serial) break;
    payloadOffsetInPage = 0;
    for (let index = 0; index < page.lacing.length; index += 1) {
      const length = page.lacing[index];
      pending = Buffer.concat([pending, page.payload.subarray(payloadOffsetInPage, payloadOffsetInPage + length)]);
      payloadOffsetInPage += length;
      if (length < 255) {
        if (pending.length > 7 && pending[0] === 0x03 && pending.toString('ascii', 1, 7) === 'vorbis') {
          return parseVorbisCommentPacket(pending.subarray(7));
        }
        pending = Buffer.alloc(0);
      }
    }
    if (pages.indexOf(page) > 4) break; // 注释头总在流的最前面
  }
  return {};
}

// ——— MP3 / ID3v2 ———
// 写 v2.4：帧头 10 字节，帧大小 syncsafe；文本帧 = 编码字节(0x03 UTF-8) + 文本 + \0。
// 读：v2.3/v2.4 都认；v2.3 的 TYER 归 year。

const ID3_TEXT_FRAMES = new Set(['TIT2', 'TPE1', 'TPE2', 'TALB', 'TRCK', 'TYER', 'TDRC', 'TDAT', 'TPE2', 'TPOS']);

const syncsafeEncode = (value) => Buffer.from([
  (value >> 21) & 0x7f,
  (value >> 14) & 0x7f,
  (value >> 7) & 0x7f,
  value & 0x7f,
]);

function buildId3TextFrame(frameId, text) {
  const body = Buffer.concat([Buffer.from([0x03]), Buffer.from(text, 'utf8'), Buffer.from([0x00])]);
  const frame = Buffer.alloc(10);
  frame.write(frameId, 0, 'ascii');
  frame[9] = 0; // 无标志
  syncsafeEncode(body.length).copy(frame, 4);
  return Buffer.concat([frame, body]);
}

function buildId3v2Tag({ frames, preservedFrames }) {
  const bodyParts = [...frames, ...preservedFrames];
  const body = Buffer.concat(bodyParts);
  const header = Buffer.alloc(10);
  header.write('ID3', 0, 'ascii');
  header[3] = 4; // v2.4
  header[4] = 0;
  header[5] = 0; // 无 unsync / 无 experimental / 无 footer
  syncsafeEncode(body.length).copy(header, 6);
  return Buffer.concat([header, body]);
}

// 返回 { size }：ID3v2 标签总长度；无标签时 null。
function findId3v2Size(buffer) {
  if (buffer.length < 10 || buffer.toString('ascii', 0, 3) !== 'ID3') return null;
  const size = ((buffer[6] & 0x7f) << 21) | ((buffer[7] & 0x7f) << 14) | ((buffer[8] & 0x7f) << 7) | (buffer[9] & 0x7f);
  return 10 + size;
}

// 解析既有 ID3v2（v2.3/v2.4）里本模块不管理的帧（APIC 等），原样返回字节。
function parseId3PreservedFrames(buffer) {
  const preserved = [];
  const tags = {};
  const total = findId3v2Size(buffer);
  if (total === null) return { preserved, tags };
  const major = buffer[3];
  let offset = 10;
  const end = Math.min(total, buffer.length);
  // 帧头 10 字节：4 帧标识 + 4 大小（v2.4 syncsafe / v2.3 普通大端，位于 position+4）+ 2 标志。
  const frameSize = (position) => (major >= 4
    ? ((buffer[position + 4] & 0x7f) << 21) | ((buffer[position + 5] & 0x7f) << 14) | ((buffer[position + 6] & 0x7f) << 7) | (buffer[position + 7] & 0x7f)
    : buffer.readUInt32BE(position + 4));
  while (offset + 10 <= end) {
    const frameId = buffer.toString('ascii', offset, offset + 4);
    if (!/^[A-Z0-9]{4}$/.test(frameId)) break;
    const size = frameSize(offset);
    if (size <= 0 || offset + 10 + size > end) break;
    const frameBody = buffer.subarray(offset + 10, offset + 10 + size);
    if (!ID3_TEXT_FRAMES.has(frameId)) {
      preserved.push(Buffer.from(buffer.subarray(offset, offset + 10 + size)));
    } else if (frameBody.length > 1) {
      // 编码字节：0x00/0x03 latin1/utf8 无 BOM，0x01/0x02 带 BOM。
      const encoding = frameBody[0];
      const textBytes = frameBody.subarray(1);
      const text = textBytes.toString(encoding === 0x03 ? 'utf8' : encoding === 0x00 ? 'latin1' : 'utf16le')
        .replace(/\u0000+$/, '')
        .trim();
      if (frameId === 'TIT2') tags.title = text;
      else if (frameId === 'TPE1') tags.artist = text;
      else if (frameId === 'TALB') tags.album = text;
      else if (frameId === 'TPE2') tags.albumArtist = text;
      else if (frameId === 'TRCK') tags.track = parseInt(text, 10) || null;
      else if (frameId === 'TYER' || frameId === 'TDRC') tags.year = text.slice(0, 4) || null;
    }
    offset += 10 + size;
  }
  return { preserved, tags };
}

function buildMp3WithTags(buffer, tags) {
  const { preserved } = parseId3PreservedFrames(buffer);
  const frames = [];
  if (tags.title) frames.push(buildId3TextFrame('TIT2', tags.title));
  if (tags.artist) frames.push(buildId3TextFrame('TPE1', tags.artist));
  if (tags.album) frames.push(buildId3TextFrame('TALB', tags.album));
  if (tags.albumArtist) frames.push(buildId3TextFrame('TPE2', tags.albumArtist));
  if (tags.track) frames.push(buildId3TextFrame('TRCK', String(tags.track)));
  if (tags.year) frames.push(buildId3TextFrame('TDRC', tags.year));
  const tag = buildId3v2Tag({ frames, preservedFrames: preserved });
  const oldSize = findId3v2Size(buffer) ?? 0;
  return Buffer.concat([tag, buffer.subarray(oldSize)]);
}

function parseMp3Tags(buffer) {
  const { tags } = parseId3PreservedFrames(buffer);
  return tags;
}

// ——— M4A ———
// ilst 项：4 字节大小 + 4 字节键 + 内层 'data' 原子（flags 0x01 = UTF-8 文本）。
// trkn 是二进制：8 字节，第 3-4 字节为音轨号（大端）。

const MP4_TEXT_KEYS = { title: '\u00a9nam', artist: '\u00a9ART', album: '\u00a9alb', albumArtist: 'aART', year: '\u00a9day' };
const MP4_KEY_TO_FIELD = { '\u00a9nam': 'title', '\u00a9ART': 'artist', '\u00a9alb': 'album', 'aART': 'albumArtist', '\u00a9day': 'year', 'trkn': 'track' };

function buildMp4DataAtom(payload, flags = 1) {
  const data = Buffer.alloc(16 + payload.length);
  data.writeUInt32BE(16 + payload.length, 0);
  data.write('data', 4, 'ascii');
  data.writeUInt32BE(flags, 8);
  data.writeUInt32BE(0, 12); // locale
  payload.copy(data, 16);
  return data;
}

function buildMp4Item(key, payload, flags) {
  const data = buildMp4DataAtom(payload, flags);
  const item = Buffer.alloc(8 + data.length);
  item.writeUInt32BE(item.length, 0);
  item.write(key, 4, 'latin1');
  data.copy(item, 8);
  return item;
}

const mp4TextPayload = (value) => Buffer.from(value, 'utf8');
const mp4TrackPayload = (track) => {
  const payload = Buffer.alloc(8);
  payload[2] = (track >> 8) & 0xff;
  payload[3] = track & 0xff;
  return payload;
};

function findAtom(buffer, start, end, name) {
  let offset = start;
  while (offset + 8 <= end) {
    const size = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const atomSize = size === 0 ? end - offset : size;
    if (atomSize < 8 || offset + atomSize > end) return null;
    if (type === name) return { start: offset, end: offset + atomSize, contentStart: offset + 8, contentEnd: offset + atomSize };
    offset += atomSize;
  }
  return null;
}

// 遍历 moov 内容里的 stco/co64，把块偏移加上 delta。
function patchMp4ChunkOffsets(moovContent, delta) {
  if (delta === 0) return;
  const walk = (start, end) => {
    let offset = start;
    while (offset + 8 <= end) {
      const size = moovContent.readUInt32BE(offset);
      const type = moovContent.toString('latin1', offset + 4, offset + 8);
      const atomSize = size === 0 ? end - offset : size;
      if (atomSize < 8 || offset + atomSize > end) return;
      if (type === 'stco') {
        const count = moovContent.readUInt32BE(offset + 12);
        for (let index = 0; index < count; index += 1) {
          const position = offset + 16 + index * 4;
          moovContent.writeUInt32BE((moovContent.readUInt32BE(position) + delta) >>> 0, position);
        }
      } else if (type === 'co64') {
        const count = moovContent.readUInt32BE(offset + 12);
        for (let index = 0; index < count; index += 1) {
          const position = offset + 16 + index * 8;
          moovContent.writeBigUInt64BE(moovContent.readBigUInt64BE(position) + BigInt(delta), position);
        }
      } else if (type !== 'mdat') {
        walk(offset + 8, offset + atomSize);
      }
      offset += atomSize;
    }
  };
  walk(0, moovContent.length);
}

// 重建 ilst：我们的六个键替换/新增，其余项原样保留。
function buildMp4Ilst(existingItems, tags) {
  const items = [];
  const managedKeys = new Set([...Object.values(MP4_TEXT_KEYS), 'trkn']);
  for (const item of existingItems) {
    if (!managedKeys.has(item.key)) items.push(item.buffer);
  }
  if (tags.title) items.push(buildMp4Item(MP4_TEXT_KEYS.title, mp4TextPayload(tags.title)));
  if (tags.artist) items.push(buildMp4Item(MP4_TEXT_KEYS.artist, mp4TextPayload(tags.artist)));
  if (tags.album) items.push(buildMp4Item(MP4_TEXT_KEYS.album, mp4TextPayload(tags.album)));
  if (tags.albumArtist) items.push(buildMp4Item(MP4_TEXT_KEYS.albumArtist, mp4TextPayload(tags.albumArtist)));
  if (tags.track) items.push(buildMp4Item('trkn', mp4TrackPayload(tags.track), 0));
  if (tags.year) items.push(buildMp4Item(MP4_TEXT_KEYS.year, mp4TextPayload(tags.year)));
  const body = Buffer.concat(items);
  const ilst = Buffer.alloc(8 + body.length);
  ilst.writeUInt32BE(ilst.length, 0);
  ilst.write('ilst', 4, 'ascii');
  body.copy(ilst, 8);
  return ilst;
}

function parseMp4ExistingIlstItems(buffer) {
  const items = [];
  const moov = findAtom(buffer, 0, buffer.length, 'moov');
  if (!moov) return items;
  const udta = findAtom(buffer, moov.contentStart, moov.contentEnd, 'udta');
  if (!udta) return items;
  // meta 原子开头有 4 字节 version/flags。
  const meta = findAtom(buffer, udta.contentStart, udta.contentEnd, 'meta');
  if (!meta) return items;
  const ilst = findAtom(buffer, meta.contentStart + 4, meta.contentEnd, 'ilst');
  if (!ilst) return items;
  let offset = ilst.contentStart;
  while (offset + 8 <= ilst.contentEnd) {
    const size = buffer.readUInt32BE(offset);
    if (size < 8 || offset + size > ilst.contentEnd) break;
    const key = buffer.toString('latin1', offset + 4, offset + 8);
    items.push({ key, buffer: Buffer.from(buffer.subarray(offset, offset + size)) });
    offset += size;
  }
  return items;
}

function parseMp4Tags(buffer) {
  const tags = {};
  for (const item of parseMp4ExistingIlstItems(buffer)) {
    const field = MP4_KEY_TO_FIELD[item.key];
    if (!field) continue;
    const data = findAtom(item.buffer, 8, item.buffer.length, 'data');
    if (!data) continue;
    if (field === 'track') {
      const payload = item.buffer.subarray(data.contentStart + 8, data.contentEnd);
      if (payload.length >= 4) tags.track = (payload[2] << 8) | payload[3];
    } else {
      const text = item.buffer.subarray(data.contentStart + 8, data.contentEnd).toString('utf8').trim();
      if (text) tags[field] = text;
    }
  }
  return tags;
}

// moov 变长时：moov 在 mdat 前则按差值补丁块偏移；整文件重组后经 backupAndReplace 换入。
function buildMp4WithTags(buffer, tags) {
  const moov = findAtom(buffer, 0, buffer.length, 'moov');
  if (!moov) throw new Error('MP4 moov atom not found');
  const mdat = findAtom(buffer, 0, buffer.length, 'mdat');
  const ilst = parseMp4ExistingIlstItems(buffer);
  const newIlst = buildMp4Ilst(ilst, tags);
  // moov 内容 = 原 moov 内容，把其中旧 ilst 换成新的。先按原结构定位再替换。
  const moovContent = Buffer.from(buffer.subarray(moov.contentStart, moov.contentEnd));
  const udta = findAtom(moovContent, 0, moovContent.length, 'udta');
  const meta = udta && findAtom(moovContent, udta.contentStart, udta.contentEnd, 'meta');
  const oldIlst = meta && findAtom(moovContent, meta.contentStart + 4, meta.contentEnd, 'ilst');
  if (!oldIlst) throw new Error('MP4 ilst atom not found');
  const newMoovContent = Buffer.concat([
    moovContent.subarray(0, oldIlst.start),
    newIlst,
    moovContent.subarray(oldIlst.end),
  ]);
  // ilst 变长后，外层 meta / udta 的大小字段也要跟着改（它们是容器原子）。
  const ilstDelta = newIlst.length - (oldIlst.end - oldIlst.start);
  [udta, meta].forEach((atom) => {
    if (!atom) return;
    newMoovContent.writeUInt32BE(newMoovContent.readUInt32BE(atom.start) + ilstDelta, atom.start);
  });
  const newMoov = Buffer.alloc(8 + newMoovContent.length);
  newMoov.writeUInt32BE(newMoov.length, 0);
  newMoov.write('moov', 4, 'ascii');
  newMoovContent.copy(newMoov, 8);
  const delta = newMoov.length - (moov.end - moov.start);
  if (delta !== 0 && mdat && moov.start < mdat.start) {
    patchMp4ChunkOffsets(newMoov, delta);
  }
  return Buffer.concat([
    buffer.subarray(0, moov.start),
    newMoov,
    buffer.subarray(moov.end),
  ]);
}

// ——— 对外接口 ———

async function readAudioTags(filePath) {
  if (!isSupportedAudioFile(filePath)) {
    return { ok: false, error: 'unsupported-format', tags: normalizeTagsForOutput({}) };
  }
  try {
    const buffer = await fsp.readFile(filePath);
    const extension = path.extname(filePath).toLowerCase();
    let tags = {};
    if (extension === '.mp3') tags = parseMp3Tags(buffer);
    else if (extension === '.flac') tags = parseFlacTags(buffer);
    else if (extension === '.ogg' || extension === '.oga') tags = parseOggTags(buffer);
    else if (extension === '.m4a') tags = parseMp4Tags(buffer);
    return { ok: true, tags: normalizeTagsForOutput(tags) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), tags: normalizeTagsForOutput({}) };
  }
}

// 写回前备份为同目录 `原文件名.bak`（每次覆盖，保留最近一次写回前的状态）。
async function writeAudioTags(filePath, rawTags) {
  if (!isSupportedAudioFile(filePath)) {
    return { ok: false, error: 'unsupported-format' };
  }
  const tags = normalizeWriteTags(rawTags);
  try {
    const buffer = await fsp.readFile(filePath);
    const extension = path.extname(filePath).toLowerCase();
    let next;
    if (extension === '.mp3') next = buildMp3WithTags(buffer, tags);
    else if (extension === '.flac') next = replaceFlacVorbisCommentBlock(buffer, tags);
    else if (extension === '.ogg' || extension === '.oga') next = replaceOggVorbisComment(buffer, tags);
    else if (extension === '.m4a') next = buildMp4WithTags(buffer, tags);
    else throw new Error('unsupported-format');
    const backupPath = await backupAndReplace(filePath, async (tempPath) => {
      await fsp.writeFile(tempPath, next);
    });
    return { ok: true, backupPath };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// ——— 模板重命名 ———

const TEMPLATE_VARIABLES = ['title', 'artist', 'album', 'track', 'year'];

// 文件名片段里不允许出现的字符（Windows 保留字符 + 路径分隔符），统一换成空格。
const sanitizeFileNamePart = (value) => (
  String(value ?? '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
);

// 渲染 `{title} - {artist}` 这类模板；未知变量、空的必填结果都算无效。
function renderRenameTemplate(template, fields) {
  if (typeof template !== 'string' || !/\{[a-z]+\}/i.test(template)) return null;
  const rendered = template.replace(/\{([a-zA-Z]+)\}/g, (match, rawName) => {
    const name = rawName.toLowerCase();
    if (!TEMPLATE_VARIABLES.includes(name)) return match;
    return sanitizeFileNamePart(fields[name] ?? '');
  });
  const cleaned = rendered.replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');
  if (!cleaned || cleaned === '.' || cleaned === '..') return null;
  return cleaned;
}

// 同目录冲突自动加序号：`name (2).ext`、`name (3).ext`…… 已占用的名字与批次内重复都让位。
function nextAvailableName(takenNames, baseName, extension) {
  const taken = new Set(Array.from(takenNames, name => name.toLowerCase()));
  if (!taken.has(`${baseName}${extension}`.toLowerCase())) return `${baseName}${extension}`;
  for (let index = 2; ; index += 1) {
    const candidate = `${baseName} (${index})${extension}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

// 批量重命名：冲突序号在同一批目标目录内解决，也考虑目录里已存在的其它文件。
async function renameAudioFiles(items) {
  if (!Array.isArray(items)) return [];
  const results = [];
  const takenByDirectory = new Map();
  for (const item of items) {
    const filePath = typeof item?.filePath === 'string' ? item.filePath : '';
    const baseName = typeof item?.newBaseName === 'string' ? sanitizeFileNamePart(item.newBaseName) : '';
    if (!filePath || !baseName || !isSupportedAudioFile(filePath)) {
      results.push({ filePath, ok: false, error: 'invalid-request' });
      continue;
    }
    try {
      const directory = path.dirname(filePath);
      const extension = path.extname(filePath);
      if (!takenByDirectory.has(directory)) {
        const existing = await fsp.readdir(directory);
        takenByDirectory.set(directory, new Set(existing));
      }
      const taken = takenByDirectory.get(directory);
      const finalName = nextAvailableName(taken, baseName, extension);
      const targetPath = path.join(directory, finalName);
      if (targetPath === filePath) {
        results.push({ filePath, ok: true, newName: path.basename(filePath), unchanged: true });
        continue;
      }
      await fsp.rename(filePath, targetPath);
      taken.delete(path.basename(filePath));
      taken.add(finalName);
      results.push({ filePath, ok: true, newName: finalName });
    } catch (error) {
      results.push({ filePath, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

module.exports = {
  TEXT_FIELDS,
  SUPPORTED_EXTENSIONS,
  isSupportedAudioFile,
  normalizeWriteTags,
  normalizeTagsForOutput,
  backupAndReplace,
  buildVorbisCommentPacket,
  parseVorbisCommentPacket,
  replaceFlacVorbisCommentBlock,
  parseFlacTags,
  replaceOggVorbisComment,
  parseOggTags,
  buildMp3WithTags,
  parseMp3Tags,
  buildMp4WithTags,
  parseMp4Tags,
  renderRenameTemplate,
  sanitizeFileNamePart,
  nextAvailableName,
  readAudioTags,
  writeAudioTags,
  renameAudioFiles,
};
