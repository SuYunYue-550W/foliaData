// src/services/jam/jamRelayCrypto.ts
// 公共中继上的房间隔离与载荷加密。
//
// 威胁模型：公共 MQTT broker 是不可信转发者，任何人都可能订阅通配 topic 抓包。
// 因此：① 频道名由房间码 SHA-256 派生，不泄漏房间码本身；② 所有载荷用房间码派生
// 的 AES-GCM 密钥加密，中继只看得到密文与随机 IV，GCM 的认证标签同时防篡改。
//
// 安全边界（如实说明）：房间码是 6 位短码，本身就是「知道码即可加入」的共享秘密，
// 与原有 sync-server 版一致。本模块保护的是「第三方抓包者看不到歌名/队列/进度」，
// 不提供针对已知房间码的强机密性。房间码只在参与者之间私下传递。

import type { JamEvent, JamMember, JamSnapshot } from './jamProtocol';

const APP_SALT = 'folia-jam-v1';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const subtle = (): SubtleCrypto => {
    const api = globalThis.crypto?.subtle;
    if (!api) throw new Error('jam_crypto_unavailable');
    return api;
};

// TS 6 起 SubtleCrypto 只接受 Uint8Array<ArrayBuffer>（BufferSource），统一锚定。
type Bytes = Uint8Array<ArrayBuffer>;

const toHex = (bytes: Uint8Array): string => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

const toBase64 = (bytes: Uint8Array): string => {
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
};

const fromBase64 = (value: string): Bytes => {
    const binary = atob(value);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out as Bytes;
};

const normalizeCode = (roomCode: string): string => roomCode.trim().toUpperCase();

/** 频道名：只由房间码派生，公共中继上不出现房间码明文。 */
export const deriveRoomChannel = async (roomCode: string): Promise<string> => {
    const digest = await subtle().digest('SHA-256', encoder.encode(`${APP_SALT}:channel:${normalizeCode(roomCode)}`));
    return `folia/jam/v1/${toHex(new Uint8Array(digest)).slice(0, 32)}`;
};

/** 房间密钥：由房间码派生的 256 位 AES-GCM 密钥，不落盘。 */
const deriveRoomKey = async (roomCode: string): Promise<CryptoKey> => {
    const material = await subtle().digest('SHA-256', encoder.encode(`${APP_SALT}:key:${normalizeCode(roomCode)}`));
    return subtle().importKey('raw', new Uint8Array(material), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
};

/** 中继上传输的一帧。加密前是明文 JSON，加密后是 base64(iv):base64(ciphertext+tag)。 */
export type JamRelayFrame = {
    /** 发送方 clientId，房主用来去重/判定自己。 */
    from: string;
    /** 单调递增序号，用于丢弃乱序/重复帧。 */
    seq: number;
    /** 房间创建者的 clientId，客机只接受来自房主的 state 帧。 */
    host: string;
    /** 帧类型。 */
    kind: 'hello' | 'state' | 'bye';
    /** 房主发布的事件（客机应用）。 */
    events?: JamEvent[];
    /** 房主的全量快照（客机对齐）。 */
    snapshot?: JamSnapshot | null;
    /** 当前成员列表（由房主维护后广播）。 */
    members?: JamMember[];
    /** 发送墙钟，客机补偿时钟偏移。 */
    ts: number;
};

export const sealRelayFrame = async (roomCode: string, frame: JamRelayFrame): Promise<string> => {
    const key = await deriveRoomKey(roomCode);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = await subtle().encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(JSON.stringify(frame)));
    return `${toBase64(iv)}:${toBase64(new Uint8Array(cipher))}`;
};

export const openRelayFrame = async (roomCode: string, payload: string): Promise<JamRelayFrame | null> => {
    try {
        const [ivPart, dataPart, ...rest] = payload.split(':');
        if (!ivPart || !dataPart || rest.length) return null;
        const key = await deriveRoomKey(roomCode);
        const plain = await subtle().decrypt(
            { name: 'AES-GCM', iv: fromBase64(ivPart) },
            key,
            fromBase64(dataPart),
        );
        const parsed = JSON.parse(decoder.decode(plain)) as JamRelayFrame;
        if (!parsed || typeof parsed.from !== 'string' || typeof parsed.seq !== 'number'
            || typeof parsed.host !== 'string' || typeof parsed.kind !== 'string') return null;
        return parsed;
    } catch {
        // 认证失败 / 别人的房间 / 格式错误：一律当作无关帧丢弃。
        return null;
    }
};
