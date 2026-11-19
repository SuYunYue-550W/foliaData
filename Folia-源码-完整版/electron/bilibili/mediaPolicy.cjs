// electron/bilibili/mediaPolicy.cjs
// B站 DASH 流（*.m4s / *.flv）要求 Referer 在 bilibili.com 域下且 UA 非空，
// 否则 403。Web 端不做这件事（浏览器自动带），Electron 里必须显式注入。
//
// 只对本 provider 登记过的 URL 生效：不给任意第三方域名乱加 Referer，
// 避免把用户带去别的站点时带上 bilibili 的来源信息。

function createBilibiliMediaPolicy({ now = Date.now } = {}) {
    const issued = new Map();
    const ttl = 1000 * 60 * 90; // 与 transport 的取流有效期一致

    const normalize = value => {
        try {
            const url = new URL(value);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
            url.hash = '';
            return url;
        } catch {
            return null;
        }
    };

    const isBiliHost = url => {
        const host = url.hostname;
        return host === 'bilibili.com' || host.endsWith('.bilibili.com')
            || host.endsWith('.bilivideo.com') || host.endsWith('.bilivideo.cn');
    };

    const register = value => {
        const url = normalize(value);
        if (!url || !isBiliHost(url)) return;
        issued.set(url.href, now() + ttl);
        while (issued.size > 2048) issued.delete(issued.keys().next().value);
    };

    const allows = details => {
        if (!['media', 'xhr'].includes(details.resourceType)) return false;
        if (!['GET', 'HEAD'].includes(details.method)) return false;
        const url = normalize(details.url);
        if (!url || !isBiliHost(url)) return false;
        const expiry = issued.get(url.href);
        if (expiry === undefined) return false;
        if (expiry <= now()) {
            issued.delete(url.href);
            return false;
        }
        return true;
    };

    return {
        register,
        allows,
        /** 给匹配的请求注入 Referer 与浏览器 UA。 */
        applyHeaders(details) {
            if (!allows(details)) return false;
            const headers = details.requestHeaders || {};
            headers.Referer = ['https://www.bilibili.com/'];
            headers['User-Agent'] = ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'];
            details.requestHeaders = headers;
            return true;
        },
        /** 给 CORS 响应加 Allow-Origin（DASH 的 fetch 需要）。 */
        applyResponse(details) {
            if (!allows(details)) return false;
            const headers = details.responseHeaders || {};
            headers['Access-Control-Allow-Origin'] = ['*'];
            headers['Access-Control-Allow-Credentials'] = ['true'];
            details.responseHeaders = headers;
            return true;
        },
        followRedirect(details) {
            if (allows(details) && details.redirectURL) register(details.redirectURL);
        },
    };
}

module.exports = { createBilibiliMediaPolicy };
