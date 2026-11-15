// src/utils/microRender/renderClientRegistry.ts
//
// 渲染客户端注册表：让「谁此刻在占用 GPU」成为可查询的事实。
//
// 项目里 28 个可视化模式各自的渲染循环是独立写的（见 visualizer/registry.tsx），
// 调度层统一不到 pass 链那一层，但可以统一到**客户端**这一层：主可视化、壁纸叠层、
// 桌面歌词、OBS 源、预览缩略图注册进来，调度器就知道当前 document 里有几个 GPU 消费者、
// 优先级如何，从而在跨窗口协调时给出合理的预算折减。
//
// 注册表刻意不持有任何渲染句柄，也不调用 rAF —— 它只是一张带引用的表，注册方卸载时
// 调返回的注销函数。漏调也不会泄漏渲染循环，只是这个客户端的计数会一直算着，所以
// 用 WeakRef 兜底：拿不到对象就自动从表里摘掉。

export type RenderLayerPriority = 'primary' | 'overlay' | 'ambient' | 'preview';
export type RenderClientKind = 'webgl' | 'webgl2' | 'canvas2d' | 'pixi' | 'three' | 'dom';

export type RenderClient = {
    /** 同一 document 内唯一；重复注册会覆盖旧条目并返回旧条目的注销函数。 */
    id: string;
    priority: RenderLayerPriority;
    kind?: RenderClientKind;
    /** 是否真的占 GPU 上下文；纯 DOM 动画不该参与 GPU 预算折减。 */
    usesGpu?: boolean;
};

export const RENDER_PRIORITY_RANK: Record<RenderLayerPriority, number> = {
    primary: 0,
    overlay: 1,
    ambient: 2,
    preview: 3,
};

type Entry = {
    client: RenderClient;
    /** 注册方持有的生命周期令牌；被回收后条目失效。 */
    token: WeakRef<object>;
};

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();

const notify = () => {
    for (const listener of Array.from(listeners)) {
        try {
            listener();
        } catch (error) {
            console.error('[MicroRender] registry listener failed:', error);
        }
    }
};

/** 清理已被回收的条目。每次读表时顺手做，不额外开定时器。 */
const prune = () => {
    for (const [id, entry] of entries) {
        if (entry.token.deref() === undefined) entries.delete(id);
    }
};

/** 注册一个渲染客户端，返回注销函数（幂等，可重复调用）。 */
export const registerRenderClient = (client: RenderClient): (() => void) => {
    const token = {};
    entries.set(client.id, { client, token: new WeakRef(token) });
    notify();
    let released = false;
    return () => {
        if (released) return;
        released = true;
        const current = entries.get(client.id);
        // 只摘自己：同 id 被后来者覆盖时，旧注销函数不能把新的删掉。
        if (current?.token.deref() === token) entries.delete(client.id);
        notify();
    };
};

export const getActiveRenderClients = (): RenderClient[] => {
    prune();
    return Array.from(entries.values(), entry => entry.client);
};

/** 参与 GPU 预算折减的客户端数量（纯 DOM 的不算）。 */
export const countActiveGpuClients = (): number => (
    getActiveRenderClients().filter(client => client.usesGpu !== false).length
);

/** 本 document 的最高优先级；用于跨窗口协调时判断自己是不是该拿满预算的那一层。 */
export const getTopRenderPriority = (): RenderLayerPriority => {
    const clients = getActiveRenderClients();
    if (clients.length === 0) return 'ambient';
    return clients.reduce<RenderLayerPriority>((top, client) => (
        RENDER_PRIORITY_RANK[client.priority] < RENDER_PRIORITY_RANK[top] ? client.priority : top
    ), 'preview');
};

export const subscribeRenderClients = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
};
