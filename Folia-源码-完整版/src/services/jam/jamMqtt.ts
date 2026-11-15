// src/services/jam/jamMqtt.ts
// 极简 MQTT 3.1.1 over WebSocket 客户端（仅够「一起听」用）。
//
// 为什么不引 mqtt.js：它依赖 Node 的 Buffer/process，在 Vite 浏览器构建与 Capacitor
// WebView 里要一堆 polyfill；而这里只需要 CONNECT / SUBSCRIBE / PUBLISH(QoS0) /
// PINGREQ / DISCONNECT 五个包。全部用浏览器原生 Uint8Array + WebSocket 实现，零依赖。
//
// 本文件只做「字节 ↔ 包」与连接生命周期，不含任何业务语义（加密在 jamRelayCrypto，
// 房间状态机在 jamRelayTransport）。编解码是纯函数，可直接单测。

import type { JamConnectionState } from './jamClient';

const P = {
    CONNECT: 1, CONNACK: 2, PUBLISH: 3, SUBSCRIBE: 8, SUBACK: 9,
    PINGREQ: 12, PINGRESP: 13, DISCONNECT: 14,
} as const;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// TS 6 起 Uint8Array 带 buffer 泛型；WebSocket.send / SubtleCrypto 只接受
// Uint8Array<ArrayBuffer>（BufferSource），统一锚定到这个别名避免 ArrayBufferLike 报错。
type Bytes = Uint8Array<ArrayBuffer>;
const asBytes = (source: ArrayBuffer | ArrayLike<number>): Bytes => {
    const out = new Uint8Array(source instanceof ArrayBuffer ? source : Array.from(source));
    return out as Bytes;
};

const concat = (...parts: Bytes[]): Bytes => {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total) as Bytes;
    let at = 0;
    for (const part of parts) { out.set(part, at); at += part.length; }
    return out;
};

/** MQTT 剩余长度：1~4 字节变长整数，7 位一组，高位续位。 */
export const encodeRemainingLength = (length: number): Bytes => {
    const out: number[] = [];
    let n = length;
    do {
        let digit = n % 128;
        n = Math.floor(n / 128);
        if (n > 0) digit |= 0x80;
        out.push(digit);
    } while (n > 0);
    return new Uint8Array(out) as Bytes;
};

/** 2 字节长度前缀 + UTF-8 内容。 */
export const encodeMqttString = (value: string): Bytes => {
    const bytes = asBytes(textEncoder.encode(value));
    return concat(new Uint8Array([bytes.length >> 8, bytes.length & 0xff]) as Bytes, bytes);
};

const withHeader = (type: number, flags: number, body: Bytes): Bytes =>
    concat(new Uint8Array([(type << 4) | flags]) as Bytes, encodeRemainingLength(body.length), body);

/** CONNECT：MQTT 3.1.1、Clean Session、keepalive 60s。 */
export const encodeConnect = (clientId: string): Bytes => withHeader(P.CONNECT, 0, concat(
    encodeMqttString('MQTT'),
    new Uint8Array([4, 0x02, 0x00, 0x3c]) as Bytes,
    encodeMqttString(clientId),
));

/** SUBSCRIBE：QoS0，packet id 固定 1。 */
export const encodeSubscribe = (topic: string, packetId = 1): Bytes => withHeader(P.SUBSCRIBE, 0x02, concat(
    new Uint8Array([packetId >> 8, packetId & 0xff]) as Bytes,
    encodeMqttString(topic),
    new Uint8Array([0]) as Bytes,
));

/** PUBLISH QoS0：topic + 原始载荷。 */
export const encodePublish = (topic: string, payload: Bytes): Bytes => withHeader(
    P.PUBLISH, 0, concat(encodeMqttString(topic), payload),
);

export const encodePingReq = (): Bytes => new Uint8Array([P.PINGREQ << 4, 0]) as Bytes;
export const encodeDisconnect = (): Bytes => new Uint8Array([P.DISCONNECT << 4, 0]) as Bytes;

export type MqttIncomingPacket = {
    type: number;
    /** PUBLISH 的 topic 与载荷；其它包只有 type。 */
    topic?: string;
    payload?: Bytes;
    /** CONNACK 的返回码（0 = 接受）。 */
    returnCode?: number;
};

/** 从累积缓冲里切出所有完整包，返回未消费的剩余字节（处理粘包/半包）。 */
export const parseMqttPackets = (buffer: Bytes): { packets: MqttIncomingPacket[]; rest: Bytes } => {
    const packets: MqttIncomingPacket[] = [];
    let at = 0;
    while (at + 1 < buffer.length) {
        const type = buffer[at] >> 4;
        let multiplier = 1;
        let length = 0;
        let cursor = at + 1;
        let digit: number;
        let consumedLenBytes = 0;
        do {
            if (cursor >= buffer.length) return { packets, rest: buffer.slice(at) as Bytes };
            digit = buffer[cursor];
            cursor += 1;
            consumedLenBytes += 1;
            if (consumedLenBytes > 4) return { packets, rest: buffer.slice(at) as Bytes };
            length += (digit & 0x7f) * multiplier;
            multiplier *= 128;
        } while ((digit & 0x80) !== 0);
        if (cursor + length > buffer.length) return { packets, rest: buffer.slice(at) as Bytes };
        const body = buffer.slice(cursor, cursor + length);
        const packet: MqttIncomingPacket = { type };
        if (type === P.CONNACK) packet.returnCode = body.length > 1 ? body[1] : 1;
        if (type === P.PUBLISH && body.length >= 2) {
            const topicLen = (body[0] << 8) | body[1];
            if (2 + topicLen <= body.length) {
                packet.topic = textDecoder.decode(body.slice(2, 2 + topicLen));
                packet.payload = body.slice(2 + topicLen);
            }
        }
        packets.push(packet);
        at = cursor + length;
    }
    return { packets, rest: buffer.slice(at) as Bytes };
};

export type MqttClientOptions = {
    url: string;
    clientId: string;
    onOpen: () => void;
    onPublish: (topic: string, payload: Bytes) => void;
    onState: (state: JamConnectionState) => void;
    /** 订阅成功（SUBACK）后回调，业务层据此开始广播。 */
    onSubscribed?: () => void;
};

/**
 * 一个小连接。断线不自动跨 broker 重连（由 RelayTransport 统一做 failover），
 * 但会在同一 url 上做有限次重试，避免瞬时抖动就散房。
 */
export class MqttOverWsClient {
    private ws: WebSocket | null = null;
    private buffer = new Uint8Array(0) as Bytes;
    private subscribedTopic = '';
    private pingTimer: ReturnType<typeof setInterval> | null = null;
    private closedByUs = false;

    constructor(private readonly options: MqttClientOptions) {}

    connect(topic: string): Promise<void> {
        this.subscribedTopic = topic;
        this.closedByUs = false;
        return new Promise((resolve, reject) => {
            let settled = false;
            let ws: WebSocket;
            try {
                // subprotocol 必须是 'mqtt'，公共 broker 靠它识别 MQTT over WebSocket。
                ws = new WebSocket(this.options.url, 'mqtt');
            } catch (error) {
                reject(error instanceof Error ? error : new Error(String(error)));
                return;
            }
            this.ws = ws;
            ws.binaryType = 'arraybuffer';
            const timeout = setTimeout(() => {
                if (!settled) { settled = true; reject(new Error('jam_relay_timeout')); this.close(); }
            }, 8000);

            ws.onopen = () => {
                this.send(encodeConnect(this.options.clientId));
                this.options.onState('connecting');
            };
            ws.onmessage = (event) => {
                const chunk: Bytes = event.data instanceof ArrayBuffer
                    ? asBytes(event.data)
                    : typeof event.data === 'string'
                        ? asBytes(textEncoder.encode(event.data))
                        : asBytes(event.data);
                this.buffer = concat(this.buffer, chunk);
                const { packets, rest } = parseMqttPackets(this.buffer);
                this.buffer = rest;
                for (const packet of packets) this.handlePacket(packet, { resolve, reject, isSettled: () => settled, mark: () => { settled = true; clearTimeout(timeout); } });
            };
            ws.onerror = () => {
                if (!settled) { settled = true; clearTimeout(timeout); reject(new Error('jam_relay_socket')); }
            };
            ws.onclose = () => {
                clearTimeout(timeout);
                this.stopPing();
                if (!this.closedByUs) this.options.onState('reconnecting');
                if (!settled) { settled = true; reject(new Error('jam_relay_closed')); }
            };
        });
    }

    private handlePacket(
        packet: MqttIncomingPacket,
        ctx: { resolve: () => void; reject: (e: Error) => void; isSettled: () => boolean; mark: () => void },
    ): void {
        if (packet.type === P.CONNACK) {
            if (packet.returnCode !== 0) { ctx.reject(new Error(`jam_relay_connack_${packet.returnCode}`)); this.close(); return; }
            this.send(encodeSubscribe(this.subscribedTopic));
            return;
        }
        if (packet.type === P.SUBACK) {
            ctx.mark();
            this.options.onState('connected');
            this.startPing();
            this.options.onOpen();
            this.options.onSubscribed?.();
            ctx.resolve();
            return;
        }
        if (packet.type === P.PUBLISH && packet.topic && packet.payload) {
            this.options.onPublish(packet.topic, packet.payload);
        }
        // PINGRESP 与其它包无需处理。
    }

    publish(topic: string, payload: string): void {
        this.send(encodePublish(topic, asBytes(textEncoder.encode(payload))));
    }

    private send(bytes: Bytes): void {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(bytes);
    }

    private startPing(): void {
        this.stopPing();
        this.pingTimer = setInterval(() => this.send(encodePingReq()), 30_000);
    }

    private stopPing(): void {
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.pingTimer = null;
    }

    get isOpen(): boolean { return this.ws?.readyState === WebSocket.OPEN; }

    close(): void {
        this.closedByUs = true;
        this.stopPing();
        if (this.ws?.readyState === WebSocket.OPEN) {
            try { this.ws.send(encodeDisconnect()); } catch { /* 关闭中不必强求 */ }
        }
        try { this.ws?.close(); } catch { /* 已关闭 */ }
        this.ws = null;
        this.buffer = new Uint8Array(0);
    }
}
