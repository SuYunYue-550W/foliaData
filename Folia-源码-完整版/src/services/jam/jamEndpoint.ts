// src/services/jam/jamEndpoint.ts
// 「一起听」连接端点配置：决定房间走哪条通道汇合。
//
// 三种模式：
//   public   — 默认。内置公共 MQTT-over-WSS 中继，双端零部署、跨公网/异地异网。
//   lan      — 同一 WiFi 下直连电脑端内置的 WS 中继，数据不出内网、延迟最低。
//   selfhost — 沿用用户自建的 sync-server（HTTP 轮询），高级用户保留原有能力。
//
// 房间码不出现在中继上：真实频道名由房间码经 SHA-256 派生（jamCrypto），
// 载荷再用房间码派生密钥 AES-GCM 加密，公共中继只看到不可读的密文。

const ENDPOINT_KEY = 'folia_jam_endpoint_v1';

export type JamEndpointMode = 'public' | 'lan' | 'selfhost';

export type JamEndpointConfig = {
    mode: JamEndpointMode;
    /** lan 模式下的电脑端地址（手机填），如 ws://192.168.1.8:45331。桌面端留空表示由主进程自动起服务。 */
    lanUrl: string;
};

/**
 * 公共 WSS 中继，按优先级自动 failover。全部是免费、无需注册、支持 MQTT over WebSocket 的
 * 公共 broker；实测（2026-11）EMQX / EMQX-CN / HiveMQ 均可完成 CONNECT→SUBSCRIBE→PUBLISH 往返。
 * 只用来转发密文，不承载任何服务端状态。
 */
export const PUBLIC_RELAY_URLS: readonly string[] = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker-cn.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
];

const DEFAULT_CONFIG: JamEndpointConfig = { mode: 'public', lanUrl: '' };

const isBrowser = () => typeof window !== 'undefined';

export const getJamEndpointConfig = (): JamEndpointConfig => {
    if (!isBrowser()) return { ...DEFAULT_CONFIG };
    try {
        const raw = window.localStorage.getItem(ENDPOINT_KEY);
        if (!raw) return { ...DEFAULT_CONFIG };
        const parsed = JSON.parse(raw) as Partial<JamEndpointConfig>;
        const mode: JamEndpointMode = parsed.mode === 'lan' || parsed.mode === 'selfhost'
            ? parsed.mode
            : 'public';
        return { mode, lanUrl: typeof parsed.lanUrl === 'string' ? parsed.lanUrl.trim() : '' };
    } catch {
        return { ...DEFAULT_CONFIG };
    }
};

export const saveJamEndpointConfig = (next: JamEndpointConfig): void => {
    if (!isBrowser()) return;
    const mode: JamEndpointMode = next.mode === 'lan' || next.mode === 'selfhost' ? next.mode : 'public';
    window.localStorage.setItem(ENDPOINT_KEY, JSON.stringify({
        mode,
        lanUrl: (next.lanUrl ?? '').trim(),
    }));
    window.dispatchEvent(new Event('folia-jam-endpoint-changed'));
};

/** 规范化用户填的局域网地址，容错 http(s)://、缺协议、尾斜杠。 */
export const normalizeLanUrl = (raw: string): string => {
    let value = raw.trim().replace(/\/+$/, '');
    if (!value) return '';
    if (/^https:\/\//i.test(value)) value = `wss://${value.slice(8)}`;
    else if (/^http:\/\//i.test(value)) value = `ws://${value.slice(7)}`;
    else if (!/^wss?:\/\//i.test(value)) value = `ws://${value}`;
    return value;
};

/** 当前端点的人类可读描述，用于面板状态行。 */
export const describeJamEndpoint = (config = getJamEndpointConfig()): string => {
    if (config.mode === 'lan') return config.lanUrl || 'LAN';
    if (config.mode === 'selfhost') return 'sync-server';
    return 'public relay';
};
