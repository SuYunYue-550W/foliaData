package top.izuna.foliamajor

import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.util.Log

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

import org.json.JSONObject

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * Apple Music 宿主的原生桥（FoliaAppleMusic）。
 *
 * 桌面版由独立进程 companion（WebView2/WKWebView + JSON 行协议）承载 music.apple.com
 * 的登录与 DRM 播放；安卓版这里不重造协议层，只做三件事：
 *
 *   1. 把宿主 Activity（[AppleMusicHostActivity] 里的全屏 WebView）拉起来并等它就绪；
 *   2. 把 renderer 的 operation 递给页面里的 `window.__foliaHandle`，等页面算完经
 *      `window.foliaAppleNative.result(nonce, payload)` 按原路带回 —— 信封与桌面版
 *      同构（{ok:true,data:…} / {ok:false,error:…}），渲染层两边不用分叉；
 *   3. 播放期间用一个极简前台服务（[AppleMusicHoldService]）保住进程，退后台音频不断。
 *
 * 插件方法一律不阻塞桥线程：request 只发一个 evaluateJavascript，结果由页面的回调
 * 带回（见 FoliaQishuiPlugin 那条「占住桥线程会让别家登录集体超时」的教训）。
 */
@CapacitorPlugin(name = "FoliaAppleMusic")
class FoliaAppleMusicPlugin : Plugin() {
    companion object {
        private const val TAG = "FoliaAppleMusic"

        /** prepare 等页面就绪的上限（页面冷加载一次足够；到点没就绪就明说，别让界面一直转）。 */
        private const val READY_TIMEOUT_MS = 20000L

        /** 一次 request 等页面回话的上限。 */
        private const val REQUEST_TIMEOUT_MS = 25000L

        /** 登出全程（blank 落地 + 清 cookie + 回页就绪）的上限。 */
        private const val LOGOUT_TIMEOUT_MS = 30000L

        /** 页面回传 payload 的上限（8MB）：Apple 的歌单整包也远小于它，超过的一律当坏响应。 */
        private const val PAYLOAD_LIMIT = 8 * 1024 * 1024

        /** 在途请求上限：超过就报 busy，别把 WebView 的 JS 队列压塌。 */
        private const val PENDING_LIMIT = 8

        /** 宿主顶栏的兜底文案（prepare 只带 script，没有文案字段，原生侧自己给英文）。 */
        private const val DEFAULT_TITLE = "Apple Music"
        private const val DEFAULT_HIDE_LABEL = "Hide"

        /** 登出流程也走 pending 那张表，用它自己的键（与请求的 req_N 命名空间不撞）。 */
        private const val LOGOUT_KEY = "logout"
    }

    private val handler = Handler(Looper.getMainLooper())
    /** nonce → 在途调用（结果由 foliaAppleNative.result 按原路带回；登出也借这张表等）。 */
    private val pending = ConcurrentHashMap<String, PluginCall>()
    private val nonceSeq = AtomicInteger(1)

    /** load() 里装进宿主的那个结果汇（handleOnDestroy 时凭它认出是不是自己）。 */
    private val sink = AppleMusicResultSink { nonce, payload -> onHostResult(nonce, payload) }

    override fun load() {
        super.load()
        // 页面算完的结果从 JavascriptInterface 桥线程进来，宿主只认这一个静态汇；
        // 插件实例只有一个（MainActivity registerPlugin 一次），装上就是它。
        AppleMusicHostActivity.resultSink = sink
    }

    override fun handleOnDestroy() {
        // 主屏销毁（多半是进程要没了）：在途的请求都给个明确结局，别让 JS 侧干等到超时。
        if (AppleMusicHostActivity.resultSink === sink) AppleMusicHostActivity.resultSink = null
        // ConcurrentHashMap 的 keys() 返回 Enumeration（kotlin 迭代它有歧义），用 Map 的 keys 属性。
        for (nonce in java.util.ArrayList<String>(pending.keys)) {
            failPending(nonce, "not-ready")
        }
    }

    /**
     * 保存 renderer 给的 script，并确保宿主已起、页面已就绪。
     *
     * 答 `{ ready: true }`；20 秒没就绪 reject 'timeout'。幂等：script 没变就不重灌
     * （同一页面上重复 prepare 不重复注入）。
     */
    @PluginMethod
    fun prepare(call: PluginCall) {
        val script = call.getString("script")
        if (script == null || script.isEmpty()) {
            call.reject("script is required")
            return
        }
        call.setKeepAlive(true)
        AppleMusicHostActivity.hostScript = script
        val host = AppleMusicHostActivity.activeInstance()
        if (host == null) {
            // 宿主没起：起它。Android 12+ 的后台起 Activity 限制下这一步只在 App 前台
            // 时发生 —— renderer 在用户操作之后才调 prepare，这里不替它承担后台场景。
            startHostActivity()
        } else if (AppleMusicHostActivity.pageLoaded) {
            // 宿主已在、页面已加载：script 变没变由宿主自己判（幂等），这里只催一遍注入。
            handler.post { host.injectCurrentScript() }
        }
        waitForReady(call, 0)
    }

    /** 页面就绪前每 200ms 看一眼；到点没就绪就 reject（与 QishuiSignHost 的等待同款）。 */
    private fun waitForReady(call: PluginCall, waitedMs: Long) {
        if (AppleMusicHostActivity.pageReady) {
            call.setKeepAlive(false)
            val result = JSObject()
            result.put("ready", true)
            call.resolve(result)
            return
        }
        if (waitedMs >= READY_TIMEOUT_MS) {
            call.setKeepAlive(false)
            call.reject("timeout")
            return
        }
        handler.postDelayed({ waitForReady(call, waitedMs + 200) }, 200)
    }

    /**
     * 把一个 operation 交给页面里的 `window.__foliaHandle`，等它算完带回来。
     *
     * 传给页面的是 `{ operation, params }` 的 JSON 字面量；页面侧回话走
     * `window.foliaAppleNative.result(nonce, payload)`，payload 解析成 JSObject 原样
     * resolve 给 renderer（{ok:true,data:…} 或 {ok:false,error:…,httpStatus:…,
     * playbackStage:…} 的结构一层不动）。宿主没起 / 页面没就绪 reject 'not-ready'；
     * 在途满 8 个 reject 'busy'；25 秒没回话 reject 'timeout'；payload 超 8MB 或
     * 不是合法 JSON reject 'invalid-response'（页面内 throw 由注入的那段壳折成
     * {ok:false,error:'request-failed'}）。
     *
     * 特例：showWindow / hideWindow 不进 WebView —— 前者把宿主带到前台，后者把它
     * 退到后台（页面在后台照样出声，show 只是「把窗口给人看」）。
     */
    @PluginMethod
    fun request(call: PluginCall) {
        val operation = call.getString("operation")
        if (operation == null || operation.isEmpty()) {
            call.reject("operation is required")
            return
        }
        if ("showWindow" == operation) {
            showHostActivity()
            call.resolve(okData())
            return
        }
        if ("hideWindow" == operation) {
            hideHostActivity()
            call.resolve(okData())
            return
        }
        val host = AppleMusicHostActivity.activeInstance()
        if (host == null || !AppleMusicHostActivity.pageReady) {
            call.reject("not-ready")
            return
        }
        if (pending.size >= PENDING_LIMIT) {
            call.reject("busy")
            return
        }
        val nonce = "req_" + nonceSeq.getAndIncrement()
        val literal = JSONObject()
        literal.put("operation", operation)
        literal.put("params", readParams(call))
        val nonceJson = JSONObject.quote(nonce)
        // 壳里自己带兜底：页面 throw（网络被拦、Apple 拒答）也要按同一条路带回一个
        // 明确的信封，不能让 nonce 悬着等原生那边的 25 秒超时。
        val js = "(async () => { try { const r = await window.__foliaHandle(" + literal.toString() + "); " +
            "window.foliaAppleNative.result(" + nonceJson + ", JSON.stringify(r)); } catch (e) { " +
            "window.foliaAppleNative.result(" + nonceJson + ", JSON.stringify({ok:false, error:'request-failed'})); } })()"
        call.setKeepAlive(true)
        pending.put(nonce, call)
        // handler 就是主线程：WebView 的 evaluateJavascript 必须在主线程发。
        handler.post {
            val page = AppleMusicHostActivity.activeInstance()
            if (page == null || !AppleMusicHostActivity.pageReady) {
                failPending(nonce, "not-ready")
                return@post
            }
            page.evaluateInPage(js)
        }
        handler.postDelayed({ failPending(nonce, "timeout") }, REQUEST_TIMEOUT_MS)
    }

    /**
     * params 的契约是对象；兼容字符串形态（个别调用方把整包 params 序列化成字符串，
     * 见 FoliaQishuiPlugin 的同类处理），两种都接，都没有就给空对象。
     */
    private fun readParams(call: PluginCall): JSONObject {
        val direct = call.getObject("params", null)
        if (direct != null) return direct
        val asString = call.getString("params")
        if (asString != null && asString.isNotEmpty()) {
            try {
                return JSONObject(asString)
            } catch (ignored: Exception) {
            }
        }
        return JSONObject()
    }

    /** 页面回话（JavascriptInterface 桥线程）：pending 按 nonce 匹配，迟到的（已超时）没人认领就丢掉。 */
    private fun onHostResult(nonce: String, payload: String) {
        val entry = pending.remove(nonce) ?: return
        entry.setKeepAlive(false)
        if (payload.length > PAYLOAD_LIMIT) {
            entry.reject("invalid-response")
            return
        }
        try {
            entry.resolve(JSObject(payload))
        } catch (error: Exception) {
            entry.reject("invalid-response")
        }
    }

    /** 在途的那一个按消息收掉（超时、宿主没了都走这里；已被收掉的迟来消息自然成空操作）。 */
    private fun failPending(nonce: String, message: String) {
        val entry = pending.remove(nonce) ?: return
        entry.setKeepAlive(false)
        entry.reject(message)
    }

    /**
     * 播放保持：true 起一个极简前台服务（进程拿到前台优先级，退后台后 WebView 的音频
     * 才不被系统回收），false 停掉。Android 12+ 上 renderer 只在 App 前台时才会因
     * 播放开始调它，这里不替它承担后台起前台服务的场景（那条路系统会直接抛）。
     */
    @PluginMethod
    fun setForeground(call: PluginCall) {
        val active = java.lang.Boolean.TRUE.equals(call.getBoolean("active", true))
        if (active) {
            val intent = Intent(context, AppleMusicHoldService::class.java)
            intent.action = AppleMusicHoldService.ACTION_HOLD
            try {
                androidx.core.content.ContextCompat.startForegroundService(context, intent)
            } catch (error: Exception) {
                Log.w(TAG, "starting the apple music hold service failed", error)
            }
        } else {
            // 停服务不走 startService（App 在后台时那条路直接抛 IllegalStateException），
            // stopService 任何状态下都可用，服务的 onDestroy 会把前台状态与通知一并收掉。
            try {
                context.stopService(Intent(context, AppleMusicHoldService::class.java))
            } catch (error: Exception) {
                Log.w(TAG, "stopping the apple music hold service failed", error)
            }
        }
        call.resolve(ok())
    }

    /**
     * 登出：宿主先 navigate about:blank（把页面停住），清掉 Apple 四家的 cookie
     * （**只**这四家，YouTube / 汽水的一个不碰），再 navigate 回 music.apple.com，
     * 等页面重新就绪（脚本重灌）后 resolve `{ ok: true }`；30 秒走不完 reject 'timeout'。
     */
    @PluginMethod
    fun logout(call: PluginCall) {
        // 上一场登出还在走：这一场先拒「正忙」，两场搅在一起说不清 cookie 清到哪一步。
        if (pending.containsKey(LOGOUT_KEY)) {
            call.reject("busy")
            return
        }
        pending.put(LOGOUT_KEY, call)
        call.setKeepAlive(true)
        handler.postDelayed({ failPending(LOGOUT_KEY, "timeout") }, LOGOUT_TIMEOUT_MS)
        handler.post { performLogout() }
    }

    private fun performLogout() {
        // 超时已经先一步把这一场收掉（failPending 移除了键）：流程就别再往下走。
        if (!pending.containsKey(LOGOUT_KEY)) return
        // 页面与脚本状态先归零：登出期间它不许再当「就绪」。
        AppleMusicHostActivity.pageReady = false
        AppleMusicHostActivity.pageLoaded = false
        AppleMusicHostActivity.injectedScript = null
        val host = AppleMusicHostActivity.activeInstance()
        if (host == null) {
            // 宿主没在跑：页面里的登录态不存在，但 cookie 可能还留在罐里 —— 照清，然后直接收。
            AppleMusicHostActivity.eraseAppleCookies(Runnable { finishLogout() })
            return
        }
        // 回页重灌脚本、翻就绪那一刻收尾（onPageFinished → injectCurrentScript → markReady）。
        AppleMusicHostActivity.readyListener = Runnable { finishLogout() }
        // about:blank 一落地 → 清 cookie → 回 music.apple.com。
        AppleMusicHostActivity.blankListener = Runnable {
            AppleMusicHostActivity.eraseAppleCookies(Runnable {
                // setCookie 的回调不在主线程，WebView 的 loadUrl 必须回主线程发。
                handler.post { host.loadStartUrl() }
            })
        }
        host.loadBlank()
    }

    private fun finishLogout() {
        handler.post {
            val entry = pending.remove(LOGOUT_KEY) ?: return@post
            entry.setKeepAlive(false)
            entry.resolve(ok())
        }
    }

    /** 收摊：结束宿主 Activity、停掉前台保持、把在途请求全部作废，resolve `{}`。 */
    @PluginMethod
    fun dispose(call: PluginCall) {
        for (nonce in java.util.ArrayList<String>(pending.keys)) {
            failPending(nonce, "not-ready")
        }
        call.setKeepAlive(true)
        handler.post {
            AppleMusicHostActivity.hostScript = null
            AppleMusicHostActivity.readyListener = null
            AppleMusicHostActivity.blankListener = null
            val host = AppleMusicHostActivity.activeInstance()
            if (host != null) host.finish()
            try {
                context.stopService(Intent(context, AppleMusicHoldService::class.java))
            } catch (error: Exception) {
                Log.w(TAG, "stopping the apple music hold service on dispose failed", error)
            }
            call.setKeepAlive(false)
            call.resolve(JSObject())
        }
    }

    // ─── 宿主窗口的起停 ────────────────────────────────────────────────────

    /** 起宿主（或把它带成新的一座）；文案用常量兜底（prepare 只带 script，没有文案字段）。 */
    private fun startHostActivity() {
        val intent = Intent(context, AppleMusicHostActivity::class.java)
        intent.putExtra(AppleMusicHostActivity.EXTRA_TITLE, DEFAULT_TITLE)
        intent.putExtra(AppleMusicHostActivity.EXTRA_HIDE_LABEL, DEFAULT_HIDE_LABEL)
        // 宿主自己一个 task（清单里 taskAffinity + singleTask）：NEW_TASK 让它落进
        // 自己的 affinity，不带就默认并进主界面那个 task，hide 就退不了「自己」。
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        // 静默准备：这一座不该抢前台。查登录态（provider 的 getLoginStatus）在启动时
        // 就会走到 prepare，Apple 站点未登录时又自动重定向到 idmsa 登录页 ——
        // 不静默的话，每次启动都先蹦一个登录网页出来。showWindow 会再把它带到前台。
        AppleMusicHostActivity.startHidden = true
        try {
            context.startActivity(intent)
        } catch (error: Exception) {
            AppleMusicHostActivity.startHidden = false
            Log.w(TAG, "starting the apple music host failed", error)
        }
    }

    /** showWindow：宿主已在跑就把它带到前台（singleTask 落回原实例）；没在跑就当一次 prepare 的起屏。 */
    private fun showHostActivity() {
        val intent = Intent(context, AppleMusicHostActivity::class.java)
        intent.putExtra(AppleMusicHostActivity.EXTRA_TITLE, DEFAULT_TITLE)
        intent.putExtra(AppleMusicHostActivity.EXTRA_HIDE_LABEL, DEFAULT_HIDE_LABEL)
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
        // 用户主动点了「登录」：这一座要真显示在前台，别再被静默准备那套逻辑藏起来。
        AppleMusicHostActivity.startHidden = false
        try {
            context.startActivity(intent)
        } catch (error: Exception) {
            Log.w(TAG, "bringing the apple music host to the front failed", error)
        }
    }

    /** hideWindow：只把宿主这一个 task 退到后台（音频继续出声），不动主界面。 */
    private fun hideHostActivity() {
        val host = AppleMusicHostActivity.activeInstance() ?: return
        host.runOnUiThread { host.moveTaskToBack(true) }
    }

    private fun ok(): JSObject {
        val result = JSObject()
        result.put("ok", true)
        return result
    }

    /** showWindow / hideWindow 的返回信封：与页面上回来的 {ok:true,data:{}} 同构。 */
    private fun okData(): JSObject {
        val data = JSObject()
        val result = JSObject()
        result.put("ok", true)
        result.put("data", data)
        return result
    }
}
