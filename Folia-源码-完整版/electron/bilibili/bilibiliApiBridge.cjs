const crypto = require('node:crypto');

// electron/bilibili/bilibiliApiBridge.cjs
//
// B站登录态在主进程落地：渲染层的 fetch 拿不到 Set-Cookie（forbidden response
// header），手工拼的 Cookie 头又会被丢弃（forbidden request header）。主进程没有
// 这些限制，而且项目已经有 safeStorage 加密存储体系（见 bodian/session.cjs）。
//
// 这里只做登录态相关的三件事，其余 B站 API 仍走渲染层 transport：
//   qr-poll   主进程发请求 → 读 Set-Cookie → 加密存 SESSDATA/buvid3 → 返回业务码
//   get-session  渲染层取 opaque 的 cookie 头（用于拼手工 Cookie，Android 桥需要）
//   logout    清掉加密存储
//
// 不代理全部 API 是有意的：改动面小、风险低；B站 API 本身在渲染层已经能正常工作
// （只有 cookie 这一环断了）。等以后需要更彻底的能力再扩展 operation。

const { assertEncryptionAvailable, encryptionAvailable } = require('../osEncryption.cjs');

const SESSION_KEY = 'BILIBILI_SESSION_V2';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REFERER = 'https://www.bilibili.com/';
const POLL_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll';
const BILIBILI_HOSTS = ['api.bilibili.com', 'passport.bilibili.com', 'www.bilibili.com', 'api.live.bilibili.com'];

/** 从 Set-Cookie 里取指定名字的值。主进程 fetch 能直接读 set-cookie。 */
const cookieValue = (headers, name) => {
    if (typeof headers?.getSetCookie === 'function') {
        for (const entry of headers.getSetCookie()) {
            const match = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(entry);
            if (match) return decodeURIComponent(match[1]);
        }
    }
    const raw = headers?.get?.('set-cookie');
    if (!raw) return null;
    const match = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(raw);
    return match ? decodeURIComponent(match[1]) : null;
};

/** 只保留 B站域名，防止带凭据的请求被重定向到别处时泄漏。 */
const safeRedirect = (url) => {
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' && BILIBILI_HOSTS.some(host => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`));
    } catch {
        return false;
    }
};

function createBilibiliApiBridge({ store, safeStorage, platform = process.platform, warn = console.warn, fetchImpl = fetch }) {
    let loaded = false;
    let session = null;

    const canEncrypt = () => encryptionAvailable(safeStorage, platform);

    const read = () => {
        if (loaded) return session;
        loaded = true;
        try {
            const sealed = store.get(SESSION_KEY);
            if (typeof sealed !== 'string') return null;
            assertEncryptionAvailable(safeStorage, platform);
            const value = JSON.parse(safeStorage.decryptString(Buffer.from(sealed, 'base64')).toString('utf8'));
            if (value && typeof value.sessdata === 'string' && value.sessdata) session = value;
        } catch {
            warn('[BilibiliBridge] stored session could not be restored');
        }
        return session;
    };

    const write = (next) => {
        loaded = true;
        session = next;
        try {
            assertEncryptionAvailable(safeStorage, platform);
            store.set(SESSION_KEY, safeStorage.encryptString(JSON.stringify(next)).toString('base64'));
        } catch (error) {
            // 不能加密就不要落盘 —— SESSDATA 是完整凭据，明文存等于没有保护。
            store.delete(SESSION_KEY);
            warn('[BilibiliBridge] session is available for this run only; OS encryption is unavailable', error);
        }
    };

    const clear = () => {
        loaded = true;
        session = null;
        store.delete(SESSION_KEY);
    };

    /** poll 答复的处理：业务码原样带回，SESSDATA 从 Set-Cookie 取并加密存。 */
    const finishPoll = async (response, key) => {
        let json;
        try {
            json = await response.json();
        } catch {
            return { ok: false, error: { code: 'invalid-response', message: 'poll answer was not JSON' } };
        }
        const code = Number(json?.code);
        if (code !== 0) {
            return { ok: true, data: { code, message: String(json?.message || '') } };
        }
        // poll 成功响应体里没有 SESSDATA，它在 Set-Cookie 里。
        const sessdata = cookieValue(response.headers, 'SESSDATA');
        const previous = read();
        if (sessdata) {
            write({
                sessdata,
                buvid3: cookieValue(response.headers, 'buvid3') || previous?.buvid3 || '',
                biliJct: cookieValue(response.headers, 'bili_jct') || previous?.biliJct || '',
                savedAt: Date.now(),
            });
        }
        return { ok: true, data: {
            code,
            url: String(json?.url || ''),
            sessdataStored: Boolean(sessdata),
            // 渲染层要拼 Cookie 头，回传一份供它同步到现有 localStorage 路径。
            sessdata: sessdata || previous?.sessdata || '',
            buvid3: cookieValue(response.headers, 'buvid3') || previous?.buvid3 || '',
        } };
    };

    return {
        async request(operation, params = {}) {
            try {
                switch (operation) {
                    case 'qr-poll': {
                        const key = String(params.qrcode_key || '');
                        if (!key) return { ok: false, error: { code: 'invalid-params', message: 'missing qrcode_key' } };
                        const url = `${POLL_URL}?qrcode_key=${encodeURIComponent(key)}`;
                        const response = await fetchImpl(url, {
                            headers: { 'User-Agent': UA, Referer: REFERER, Accept: 'application/json' },
                            redirect: 'manual',
                        });
                        // 带凭据的请求绝不跟随跨站重定向。
                        if (response.status >= 300 && response.status < 400) {
                            const location = response.headers?.get?.('location');
                            const target = location ? new URL(location, url).toString() : '';
                            if (!target || !safeRedirect(target)) {
                                return { ok: false, error: { code: 'unsafe-redirect', message: 'unsafe redirect' } };
                            }
                            // 同域重定向是正常的（B站的接口偶尔换路径）：跟着走一次。
                            // 跨域已在上面挡掉，所以这里再跳不会把凭据带出去。
                            const followed = await fetchImpl(target, {
                                headers: { 'User-Agent': UA, Referer: REFERER, Accept: 'application/json' },
                                redirect: 'manual',
                            });
                            if (followed.status >= 300 && followed.status < 400) {
                                return { ok: false, error: { code: 'unsafe-redirect', message: 'redirect loop' } };
                            }
                            return finishPoll(followed, key);
                        }
                        return finishPoll(response, key);
                    }
                    case 'get-session': {
                        const current = read();
                        if (!current) return { ok: true, data: null };
                        return { ok: true, data: {
                            sessdata: current.sessdata,
                            buvid3: current.buvid3 || '',
                            biliJct: current.biliJct || '',
                        } };
                    }
                    case 'logout':
                        clear();
                        return { ok: true, data: {} };
                    case 'status':
                        return { ok: true, data: { hasSession: Boolean(read()), unreadable: false } };
                    default:
                        return { ok: false, error: { code: 'unsupported', message: 'unsupported operation' } };
                }
            } catch (error) {
                // 不把原始 error 直接回传：里面可能带 URL 或 cookie 片段。
                warn('[BilibiliBridge] operation failed', operation);
                return { ok: false, error: { code: 'network', message: `bilibili bridge ${operation} failed` } };
            }
        },
        // 测试与诊断用；不通过 IPC 暴露。
        _read: read,
        _clear: clear,
        _cookieValue: cookieValue,
    };
}

module.exports = { createBilibiliApiBridge, cookieValue, safeRedirect };
