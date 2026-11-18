// src/services/jam/jamRelayTransport.ts
// 「一起听」免部署传输：无自建服务器，靠一个「汇合点」转发密文帧。
//
// 两种汇合点（同一个 JamChannel 接口，共用同一套房间状态机）：
//   MqttRelayChannel — 公共 MQTT-over-WSS broker，零配置、跨公网/异地异网（默认）。
//   LanRelayChannel  — 电脑端内置的 WS 中继，同 WiFi 直连，数据不出内网。
//
// 无服务器下的房间语义（房主权威，与 jamProtocol 的既有约定一致）：
//   · 房主是唯一发布者：publish() 只由房主调用，发 state 帧（事件 + 全量快照）。
//   · 房主另起 1s 定时广播「仅快照」帧，让后加入的客机立刻能对齐进度。
//   · 客机进房广播 hello 并周期性心跳；房主据 hello 维护成员表并随帧广播。
//   · 房主离房广播 bye；客机收到即映射到 closed，沿用会话层既有清理路径。
//   · 所有帧用房间码派生密钥 AES-GCM 加密，汇合点只看到密文。

import { getClientId, type JamConnectionState, type JamPollResult } from './jamClient';
import { PUBLIC_RELAY_URLS, getJamEndpointConfig, normalizeLanUrl } from './jamEndpoint';
import { MqttOverWsClient } from './jamMqtt';
import {
    deriveRoomChannel, openRelayFrame, sealRelayFrame, type JamRelayFrame,
} from './jamRelayCrypto';
import type { JamEvent, JamMember, JamServerEvent, JamSnapshot } from './jamProtocol';

const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const HELLO_INTERVAL_MS = 5000;
const HOST_BEACON_MS = 1000;
const MEMBER_STALE_MS = 30_000;
/** 输错码/房主不在线时最快给反馈；正常房间房主 1s 一播，5s 足够。 */
const JOIN_TIMEOUT_MS = 5000;
/** 加入期间补发 hello 的间隔：公共 broker 偶尔丢第一包，补发能救回这次加入。 */
const JOIN_HELLO_RETRY_MS = 1200;
const textDecoder = new TextDecoder();

/** 6 位短码，字符集与 sync-server/src/jamCore.ts 一致（去掉易混的 0/O/1/I）。 */
export const generateRelayRoomCode = (random: () => number = Math.random): string => {
    let code = '';
    for (let i = 0; i < 6; i += 1) code += ROOM_CODE_ALPHABET[Math.floor(random() * ROOM_CODE_ALPHABET.length)];
    return code;
};

export const isValidRelayRoomCode = (value: string): boolean =>
    /^[2-9A-HJKMNP-Z]{6}$/.test(value.trim().toUpperCase());

/** 汇合点的统一接口：订阅一个频道、往频道发帧、收帧回调。 */
export type JamChannel = {
    connect(channelName: string, onFrame: (payload: string) => void): Promise<void>;
    publish(channelName: string, payload: string): void;
    close(): void;
    readonly isOpen: boolean;
};

/** 公共中继：MQTT over WSS，逐个 broker failover。 */
export class MqttRelayChannel implements JamChannel {
    private client: MqttOverWsClient | null = null;
    private channelName = '';

    constructor(
        private readonly onState: (state: JamConnectionState) => void,
        private readonly clientId: string,
    ) {}

    async connect(channelName: string, onFrame: (payload: string) => void): Promise<void> {
        this.channelName = channelName;
        let lastError: unknown = null;
        for (const url of PUBLIC_RELAY_URLS) {
            const client = new MqttOverWsClient({
                url,
                clientId: `folia-${this.clientId.slice(0, 8)}`,
                onOpen: () => undefined,
                onState: this.onState,
                onPublish: (topic, payload) => {
                    if (topic === channelName) onFrame(textDecoder.decode(payload));
                },
            });
            try {
                await client.connect(channelName);
                this.client = client;
                return;
            } catch (error) {
                lastError = error;
                client.close();
            }
        }
        throw lastError instanceof Error ? lastError : new Error('jam_relay_unavailable');
    }

    publish(_channelName: string, payload: string): void { this.client?.publish(this.channelName, payload); }
    close(): void { this.client?.close(); this.client = null; }
    get isOpen(): boolean { return this.client?.isOpen ?? false; }
}

/** 局域网直连：电脑端主进程内置的中继，帧是极简 JSON 协议，不套 MQTT。 */
export class LanRelayChannel implements JamChannel {
    private ws: WebSocket | null = null;
    private closedByUs = false;

    constructor(private readonly url: string, private readonly onState: (state: JamConnectionState) => void) {}

    connect(channelName: string, onFrame: (payload: string) => void): Promise<void> {
        return new Promise((resolve, reject) => {
            this.closedByUs = false;
            this.onState('connecting');
            let ws: WebSocket;
            try { ws = new WebSocket(this.url); } catch (e) { reject(e); return; }
            this.ws = ws;
            const timer = setTimeout(() => { reject(new Error('jam_lan_timeout')); this.close(); }, JOIN_TIMEOUT_MS);
            ws.onopen = () => {
                ws.send(JSON.stringify({ type: 'join', channel: channelName }));
                this.onState('connected');
                clearTimeout(timer);
                resolve();
            };
            ws.onmessage = (event) => {
                try {
                    const msg = JSON.parse(String(event.data)) as { type?: string; payload?: string };
                    if (msg.type === 'frame' && typeof msg.payload === 'string') onFrame(msg.payload);
                } catch { /* 忽略无关帧 */ }
            };
            ws.onerror = () => { clearTimeout(timer); if (ws.readyState !== WebSocket.OPEN) reject(new Error('jam_lan_socket')); };
            ws.onclose = () => { clearTimeout(timer); if (!this.closedByUs) this.onState('reconnecting'); };
        });
    }

    publish(channelName: string, payload: string): void {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'pub', channel: channelName, payload }));
        }
    }

    close(): void {
        this.closedByUs = true;
        try { this.ws?.close(); } catch { /* 已关闭 */ }
        this.ws = null;
    }

    get isOpen(): boolean { return this.ws?.readyState === WebSocket.OPEN; }
}

/** 桌面端是否有内置中继能力（手机端没有，只能填电脑地址加入）。 */
export const hasJamLanHostBridge = (): boolean => (
    typeof window !== 'undefined' && typeof window.electron?.jamLanStart === 'function'
);

/**
 * 解析本次连接要用的局域网地址：
 *   · 桌面端当房主 → 自动拉起主进程内置中继，自己连 127.0.0.1（最稳，不依赖选哪块网卡）；
 *   · 其余（手机、或桌面端当客机）→ 用面板里填的电脑地址。
 * 返回 null 表示不是 lan 模式。
 */
const resolveLanUrl = async (isHost: boolean): Promise<string | null> => {
    const config = getJamEndpointConfig();
    if (config.mode !== 'lan') return null;
    if (isHost && hasJamLanHostBridge()) {
        const status = await window.electron!.jamLanStart!();
        if (status.port > 0) return `ws://127.0.0.1:${status.port}`;
    }
    return normalizeLanUrl(config.lanUrl);
};

export const createJamChannel = (
    onState: (state: JamConnectionState) => void,
    lanUrlOverride?: string | null,
    clientId: string = getClientId(),
): JamChannel => {
    const config = getJamEndpointConfig();
    if (config.mode === 'lan') {
        const url = lanUrlOverride || normalizeLanUrl(config.lanUrl);
        if (!url) throw new Error('jam_lan_not_configured');
        return new LanRelayChannel(url, onState);
    }
    return new MqttRelayChannel(onState, clientId);
};

type RelayOptions = {
    onPoll: (result: JamPollResult) => void;
    onStateChange: (state: JamConnectionState) => void;
    /** 注入 channel，便于单测；不传则按端点配置创建。 */
    channel?: JamChannel;
    /** 注入本机身份，便于单测在同一进程里模拟双端；不传则读 localStorage。 */
    clientId?: string;
};

/**
 * 与 JamRoomClient 同接口的免部署实现，会话层无需知道底层是哪个。
 * 方法签名刻意对齐 jamClient.ts，createJamTransport() 可以直接二选一。
 */
export class RelayJamTransport {
    private channel: JamChannel | null = null;
    private channelName = '';
    private roomCode = '';
    private role: 'host' | 'guest' | null = null;
    private seq = 0;
    private hostId: string | null = null;
    private stopped = true;
    private helloTimer: ReturnType<typeof setInterval> | null = null;
    private beaconTimer: ReturnType<typeof setInterval> | null = null;
    private members = new Map<string, number>();
    private lastSnapshot: JamSnapshot | null = null;
    private pendingJoin: ((snapshot: JamSnapshot | null) => void) | null = null;
    /** 本次会话是否由自己拉起过桌面端内置中继（退出时要停，别影响别的功能）。 */
    private ownsLanHost = false;

    constructor(private readonly options: RelayOptions) {}

    /** 本机身份。生产走 localStorage；注入值仅用于单测模拟双端。 */
    private selfId = (): string => this.options.clientId ?? getClientId();

    private nextSeq = (): number => { this.seq += 1; return this.seq; };

    private async send(frame: Omit<JamRelayFrame, 'from' | 'seq' | 'ts' | 'host'>): Promise<void> {
        if (!this.channel || !this.roomCode || this.stopped) return;
        const full: JamRelayFrame = {
            ...frame,
            from: this.selfId(),
            host: this.hostId ?? this.selfId(),
            seq: this.nextSeq(),
            ts: Date.now(),
        };
        const payload = await sealRelayFrame(this.roomCode, full);
        // sealRelayFrame 是异步的：等它的时候 stop() 可能已经把 channel 关掉。
        // 开头那次检查挡不住这个竞态，await 之后必须再看一次。
        if (!this.channel || this.stopped) return;
        this.channel.publish(this.channelName, payload);
    }

    private memberList(): JamMember[] {
        const now = Date.now();
        for (const [id, at] of this.members) if (now - at > MEMBER_STALE_MS) this.members.delete(id);
        if (!this.members.has(this.selfId())) this.members.set(this.selfId(), now);
        return Array.from(this.members.keys(), (clientId, i) => ({ clientId, name: `guest-${i + 1}` }));
    }

    private async handleFrame(raw: string): Promise<void> {
        const frame = await openRelayFrame(this.roomCode, raw);
        if (!frame || frame.from === this.selfId() || this.stopped) return; // 丢弃自己的回环与无关密文

        if (this.role === 'host') {
            if (frame.kind === 'hello') {
                this.members.set(frame.from, Date.now());
                // 有人进房：立刻回一份当前快照，别让他等下一个 beacon。
                void this.send({ kind: 'state', snapshot: this.lastSnapshot, members: this.memberList() });
            }
            return;
        }

        // 客机：只认房主的 state/bye。第一个 state 的发送者即房主（无需预先知道）。
        if (frame.kind === 'bye' && (!this.hostId || frame.from === this.hostId)) {
            this.options.onPoll({ closed: true, seq: frame.seq, events: [], members: [], snapshot: null });
            return;
        }
        if (frame.kind !== 'state') return;
        if (!this.hostId) this.hostId = frame.from;
        if (frame.from !== this.hostId) return;

        if (this.pendingJoin) { const done = this.pendingJoin; this.pendingJoin = null; done(frame.snapshot ?? null); }

        const events: JamServerEvent[] = (frame.events ?? []).map((event, i) => ({ ...event, seq: frame.seq * 1000 + i }));
        this.options.onPoll({
            closed: false,
            seq: frame.seq,
            events,
            members: frame.members ?? [],
            snapshot: frame.snapshot ?? null,
            forceSnapshot: events.length === 0 && Boolean(frame.snapshot),
        });
    }

    private async joinChannel(code: string, isHost: boolean): Promise<void> {
        this.roomCode = code;
        this.channelName = await deriveRoomChannel(code);
        let lanOverride: string | null = null;
        if (getJamEndpointConfig().mode === 'lan') {
            lanOverride = await resolveLanUrl(isHost);
            if (isHost && lanOverride?.includes('127.0.0.1')) this.ownsLanHost = true;
            if (!lanOverride) throw new Error('jam_lan_not_configured');
        }
        const channel = this.options.channel ?? createJamChannel(this.options.onStateChange, lanOverride, this.selfId());
        this.channel = channel;
        await channel.connect(this.channelName, (raw) => { void this.handleFrame(raw); });
    }

    async createRoom(): Promise<{ code: string; seq: number }> {
        this.stopped = false;
        this.hostId = this.selfId();
        this.role = 'host';
        const code = generateRelayRoomCode();
        await this.joinChannel(code, true);
        this.members.set(this.selfId(), Date.now());
        return { code, seq: 0 };
    }

    async joinRoom(code: string): Promise<{ seq: number; snapshot: JamSnapshot | null; members: JamMember[] }> {
        if (!isValidRelayRoomCode(code)) throw new Error('room_not_found');
        this.stopped = false;
        this.role = 'guest';
        await this.joinChannel(code.trim().toUpperCase(), false);
        // 发 hello 并等待房主的 state（等不到 = 房间不存在/房主不在线）。
        // 期间周期性补发 hello：房主 1s 一播仍可能因公共 broker 抖动丢包，补发能救回加入。
        const snapshot = await new Promise<JamSnapshot | null>((resolve, reject) => {
            const retry = setInterval(() => { void this.send({ kind: 'hello' }); }, JOIN_HELLO_RETRY_MS);
            const timer = setTimeout(() => {
                clearInterval(retry);
                this.pendingJoin = null;
                reject(new Error('room_not_found'));
            }, JOIN_TIMEOUT_MS);
            this.pendingJoin = (snap) => { clearInterval(retry); clearTimeout(timer); resolve(snap); };
            void this.send({ kind: 'hello' });
        });
        return { seq: this.seq, snapshot, members: this.memberList() };
    }

    async leaveRoom(_code: string): Promise<void> {
        if (this.role === 'host' && !this.stopped) {
            await this.send({ kind: 'bye' }).catch(() => undefined);
        }
        this.stop();
    }

    async publish(_roomCode: string, events: JamEvent[], snapshot?: JamSnapshot): Promise<void> {
        if (this.role !== 'host') return; // 防回环：客机没有发布路径
        if (snapshot) this.lastSnapshot = snapshot;
        await this.send({ kind: 'state', events, snapshot: snapshot ?? this.lastSnapshot, members: this.memberList() });
    }

    /** 房主持续广播快照（供后加入者对齐与客机进度校准）；客机持续心跳保活。 */
    start(_roomCode: string, role: 'host' | 'guest', _startSeq: number): void {
        this.role = role;
        this.stopped = false;
        this.stopTimers();
        if (role === 'host') {
            this.beaconTimer = setInterval(() => {
                void this.send({ kind: 'state', snapshot: this.lastSnapshot, members: this.memberList() });
            }, HOST_BEACON_MS);
        } else {
            this.helloTimer = setInterval(() => { void this.send({ kind: 'hello' }); }, HELLO_INTERVAL_MS);
        }
    }

    private stopTimers(): void {
        if (this.beaconTimer) clearInterval(this.beaconTimer);
        if (this.helloTimer) clearInterval(this.helloTimer);
        this.beaconTimer = null;
        this.helloTimer = null;
    }

    stop(): void {
        this.stopped = true;
        this.stopTimers();
        this.pendingJoin = null;
        this.channel?.close();
        this.channel = null;
        this.members.clear();
        if (this.ownsLanHost) {
            this.ownsLanHost = false;
            void window.electron?.jamLanStop?.().catch(() => undefined);
        }
    }
}

/**
 * 桌面端内置中继当前可供手机填写的地址列表（面板展示用）。手机端返回空数组。
 * 不自动 start：只在房主已创建房间后查询，避免用户只是打开面板就占端口。
 */
export const getJamLanHostAddresses = async (): Promise<string[]> => {
    if (!hasJamLanHostBridge()) return [];
    try {
        const status = await window.electron!.jamLanStatus!();
        return status.running ? status.addresses : [];
    } catch {
        return [];
    }
};
