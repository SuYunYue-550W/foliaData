// harmony/folia/entry/src/main/ets/bridge/FoliaHttpHandlers.ets
//
// FoliaNative.httpRequest / cookiesSet / cookiesRemove 的实现。
//
// 为什么需要：WebView 里的页面是有来源的（页面跑在 https://localhost），
// 跨域请求照样走浏览器的同源检查 —— 服务端没给 Access-Control-Allow-Origin 就是一句
// 毫无特征的 "TypeError: Failed to fetch"。桌面端靠 Electron 主进程转发绕开，
// Android 靠原生 OkHttp 桥；鸿蒙这边缺的正是这一环。
//
// 前端无需改动：src/services/nativeHttpFetch.ts 的平台判定是
// 「不是 native 平台 **且** 平台不是 android」才判不可用，鸿蒙的 isNativePlatform() 为 true，
// 且 cap.isPluginAvailable('FoliaNative') 查的是本桥上报的 pluginHeaders —— 都成立。
// 所以这里把 httpRequest 实现出来，在线音乐的跨域请求就自动走上原生通道。
//
// 契约（src/platform/foliaNative.ts 的 FoliaNativePlugin）：
//   httpRequest({url, method, headers, bodyText, bodyBase64, redirect, timeoutMs?})
//     → {status, headers?: Array<{name?, value?}>, bodyBase64?}
//   cookiesSet({url, name, value, path?, domain?}) → {ok?}
//   cookiesRemove({url, name}) → {ok?}

import { http } from '@kit.NetworkKit';
import { buffer } from '@kit.ArkTS';
import { webview } from '@kit.ArkWeb';
import { Handler } from './FoliaNativePlayerHandlers';
import { optString, optNumber } from './FoliaBridgeOptions';

/** 响应头条目（前端接受数组或 Record，这里给数组）。 */
class HeaderEntry {
  name: string = '';
  value: string = '';
  constructor(name: string, value: string) {
    this.name = name;
    this.value = value;
  }
}

/** httpRequest 的返回形状。 */
class NativeHttpResponse {
  status: number = 0;
  headers: HeaderEntry[] = [];
  bodyBase64: string = '';
}

/** cookiesSet / cookiesRemove 的返回形状。 */
class CookieResult {
  ok: boolean = false;
}

/** ArkTS 不允许把任意结构当 Object 传，headers 用中间结构承载。 */
class HeaderBag {
  entries: HeaderEntry[] = [];
}

export class FoliaHttpHandlers {
  register(handlers: Map<string, Handler>): void {
    handlers.set('FoliaNative.httpRequest', async (o) => {
      const url: string = optString(o, 'url');
      if (!url) throw new Error('httpRequest requires a url');
      const methodText: string = (optString(o, 'method') || 'GET').toUpperCase();
      const method: http.RequestMethod = this.toRequestMethod(methodText);
      const bodyText: string = optString(o, 'bodyText');
      const bodyBase64: string = optString(o, 'bodyBase64');
      const timeoutMs: number = optNumber(o, 'timeoutMs');

      const request = http.createHttp();
      try {
        const options: http.HttpRequestOptions = {
          method: method,
          expectDataType: http.HttpDataType.STRING,
          usingCache: false,
          priority: 5,
          connectTimeout: timeoutMs > 0 ? timeoutMs : 45000,
          readTimeout: timeoutMs > 0 ? timeoutMs : 45000
        };

        // 请求头：前端已把头名转成小写，这里原样带上。
        const headers: HeaderBag = new HeaderBag();
        const rawHeaders: ESObject = o['headers'];
        if (rawHeaders !== undefined && rawHeaders !== null && typeof rawHeaders === 'object') {
          const names: string[] = Object.keys(rawHeaders);
          for (const name of names) {
            const value: ESObject = rawHeaders[name];
            if (value === undefined || value === null) continue;
            headers.entries.push(new HeaderEntry(name, String(value)));
          }
        }
        for (const entry of headers.entries) {
          options.header = options.header ?? {};
          options.header[entry.name] = entry.value;
        }

        // 请求体：优先用调用方给的 base64（二进制），否则用文本。
        let body: string = bodyText;
        if (bodyBase64) {
          const decoded: ArrayBuffer = buffer.from(bodyBase64, 'base64').buffer;
          options.extraData = decoded;
        } else if (body && method !== 'GET' && method !== 'HEAD') {
          options.extraData = body;
        }

        const response: http.HttpResponse = await request.request(url, options);
        const result: NativeHttpResponse = new NativeHttpResponse();
        result.status = response.responseCode;

        // 响应头：Object → 数组
        const bag: HeaderBag = new HeaderBag();
        const responseHeader: ESObject = response.header;
        if (responseHeader !== undefined && responseHeader !== null && typeof responseHeader === 'object') {
          const names: string[] = Object.keys(responseHeader);
          for (const name of names) {
            const value: ESObject = responseHeader[name];
            if (value === undefined || value === null) continue;
            bag.entries.push(new HeaderEntry(name, String(value)));
          }
        }
        result.headers = bag.entries;

        // 响应体统一给 base64：前端那边自己解，二进制与文本都能走同一条路。
        const payload: string = this.stringifyResult(response.result);
        result.bodyBase64 = payload.length ? buffer.from(payload, 'utf-8').toString('base64') : '';
        return result;
      } finally {
        request.destroy();
      }
    });

    handlers.set('FoliaNative.cookiesSet', async (o) => {
      const url: string = optString(o, 'url');
      const name: string = optString(o, 'name');
      const value: string = optString(o, 'value');
      if (!url || !name) throw new Error('cookiesSet requires url and name');
      const path: string = optString(o, 'path') || '/';
      const domain: string = optString(o, 'domain');
      let cookie: string = `${name}=${value}; path=${path}`;
      if (domain) cookie += `; domain=${domain}`;
      webview.WebCookieManager.setCookie(url, cookie);
      const result: CookieResult = new CookieResult();
      result.ok = true;
      return result;
    });

    handlers.set('FoliaNative.cookiesRemove', async (o) => {
      const url: string = optString(o, 'url');
      const name: string = optString(o, 'name');
      if (!url || !name) throw new Error('cookiesRemove requires url and name');
      // 覆盖成空值 + 过期，等价于删掉这条。
      webview.WebCookieManager.setCookie(url, `${name}=; Max-Age=0; path=/`);
      const result: CookieResult = new CookieResult();
      result.ok = true;
      return result;
    });
  }

  /** 方法名 → RequestMethod 枚举（未知方法一律按 GET 处理）。 */
  private toRequestMethod(text: string): http.RequestMethod {
    switch (text) {
      case 'POST': return http.RequestMethod.POST;
      case 'PUT': return http.RequestMethod.PUT;
      case 'DELETE': return http.RequestMethod.DELETE;
      case 'PATCH': return http.RequestMethod.PATCH;
      case 'HEAD': return http.RequestMethod.HEAD;
      case 'OPTIONS': return http.RequestMethod.OPTIONS;
      case 'TRACE': return http.RequestMethod.TRACE;
      case 'CONNECT': return http.RequestMethod.CONNECT;
      default: return http.RequestMethod.GET;
    }
  }

  /** HttpResponse.result 可能是 string / Object / ArrayBuffer，统一成字符串。 */
  private stringifyResult(result: string | Object | ArrayBuffer): string {
    if (typeof result === 'string') return result;
    if (result instanceof ArrayBuffer) {
      return buffer.from(new Uint8Array(result)).toString('utf-8');
    }
    return JSON.stringify(result);
  }
}
