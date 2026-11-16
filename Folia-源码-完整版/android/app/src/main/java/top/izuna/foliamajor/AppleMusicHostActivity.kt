package top.izuna.foliamajor

import android.annotation.SuppressLint
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

import androidx.appcompat.app.AppCompatActivity

import java.lang.ref.WeakReference

/**
 * 页面回话的汇：宿主只认这一个出口（插件在 load() 里装上），把 nonce 与 payload
 * 原样转交插件那张 pending 表。放在文件顶层而不是伴生对象里，是 Kotlin 的语法
 * 限制 —— 伴生对象里的嵌套类型没法用类名短引用。
 */
fun interface AppleMusicResultSink {
    fun onResult(nonce: String, payload: String)
}

/**
 * Apple Music 的宿主屏（一座独立 Activity 里装着 music.apple.com 的全屏 WebView）。
 *
 * 为什么必须有它：桌面版（Windows/macOS）用独立进程 companion（WebView2/WKWebView
 * 加载 music.apple.com）承载 Apple Music 的登录与 DRM 播放；安卓没有独立进程可开，
 * 就用一座独立 task 的 Activity 顶上 —— 登录凭据是 Apple 域的 cookie，DRM 音频也在
 * 这个真的页面里出声，主界面那个 WebView 既换不了源、也接不了 Apple 的播放管线。
 *
 * 与 [YtmSignInActivity] 的分工差别：那座是「登录一次就把 cookie 交出去」的临时屏，
 * 这座是**常驻宿主** —— 页面本身就是登录态与播放态，所以它不能被系统随手回收
 * （不进 noHistory，留在最近任务里），用户点「隐藏」只是把 task 退到后台，音频继续。
 *
 * 安全底线与登录屏同一套：只许 https、只许 Apple 的四个域（后缀界限匹配），带
 * userInfo 或非 443 端口的一律拦；file:// / content:// 全关；不伪装 UA。第三方
 * cookie 开着是刻意的 —— 登录串联 idmsa.apple.com 靠它。
 */
class AppleMusicHostActivity : AppCompatActivity() {
    companion object {
        private const val TAG = "FoliaAppleMusicHost"

        /** 顶栏文案的 extra 名（文案由插件用常量传入，原生侧自己没有文案表）。 */
        const val EXTRA_TITLE = "title"
        const val EXTRA_HIDE_LABEL = "hideLabel"

        /** 起点就是 Apple Music 本尊，登录由页面自己发起，跳转都在白名单里。 */
        private const val START_URL = "https://music.apple.com/"

        /** 页面只许去的四个 Apple 域（与桌面 companion 的 navigationPolicy 同一張表）。 */
        private val ALLOWED_DOMAINS = arrayOf(
            "music.apple.com", "account.apple.com", "appleid.apple.com", "idmsa.apple.com")

        /** 登出后要清 cookie 的四个 Apple 地址；别家（YouTube / 汽水）的一个不碰。 */
        private val ERASE_COOKIE_URLS = arrayOf(
            "https://music.apple.com/", "https://account.apple.com/", "https://appleid.apple.com/", "https://idmsa.apple.com/")

        /** 插件持有的、要注入页面的 script 源码（一个 function 表达式，定义 window.__foliaHandle）。 */
        @Volatile
        internal var hostScript: String? = null

        /** 当前页面是否已加载完（不含 about:blank）。 */
        @Volatile
        internal var pageLoaded = false

        /** 页面是否已加载完**并且**注入了 script —— 插件只认这个「就绪」。 */
        @Volatile
        internal var pageReady = false

        /** 当前页面里已经注入过的 script 源码（幂等用：没变就不重灌）。换一页即清零。 */
        @Volatile
        internal var injectedScript: String? = null

        /** 页面就绪那一下要通知的人（一次性，主线程上取走并清空；登出流程等重新就绪时用）。 */
        @Volatile
        internal var readyListener: Runnable? = null

        /** about:blank 落地那一下要通知的人（一次性；登出流程的中间那步用）。 */
        @Volatile
        internal var blankListener: Runnable? = null

        /** 页面算完的结果往哪儿交（插件在 load() 里装上，dispose/主屏销毁时卸掉）。 */
        @Volatile
        internal var resultSink: AppleMusicResultSink? = null

        /** 与 [YtmSignInActivity.active] 同款：插件经 WeakReference 摸到活着的宿主，不让静态字段直接钉住 Activity。 */
        private var active: WeakReference<AppleMusicHostActivity> = WeakReference<AppleMusicHostActivity>(null)

        @JvmStatic
        internal fun activeInstance(): AppleMusicHostActivity? {
            return active.get()
        }

        /** 域的后缀界限匹配 + https-only + 无 userInfo + 443 端口（参照 navigationPolicy.cs；about:blank 只有登出流程会用）。 */
        private fun isAllowedAddress(uri: Uri): Boolean {
            if ("about:blank" == uri.toString()) return true
            val host = uri.host ?: ""
            val https = "https" == uri.scheme
            val plainAddress = uri.userInfo == null && (uri.port == -1 || uri.port == 443)
            if (!https || !plainAddress || host.isEmpty()) return false
            for (domain in ALLOWED_DOMAINS) {
                if (host == domain || host.endsWith(".$domain")) return true
            }
            return false
        }

        /**
         * 登出后把 Apple 的 cookie 清掉（FoliaAppleMusic.logout 调）：只清这四个家的，
         * **绝不调 removeAllCookies** —— CookieManager 是全应用一罐的，YouTube / 汽水的
         * 会话也在里面，一清就都抹了。做法与 [YtmSignInActivity.eraseYouTubeCookies]
         * 完全同款：把查得到的每个 cookie 用自己的名再设一遍、积压过期；标了父域的
         * 再按父域清一遍。这一步是尽力清，不是拿保证。
         */
        @JvmStatic
        internal fun eraseAppleCookies(finished: Runnable) {
            val manager = CookieManager.getInstance()
            val expired = java.util.ArrayList<Array<String>>()
            for (source in ERASE_COOKIE_URLS) {
                // catch 分支里要给 host 兜 null，所以用 var 而不是「先声明后赋值」的 val。
                var host: String?
                try {
                    host = Uri.parse(source).host
                } catch (ignored: Exception) {
                    host = null
                }
                val cookies = manager.getCookie(source)
                if (cookies == null || cookies.isEmpty()) continue
                val dotDomain = if (host == null || host.isEmpty()) ""
                else if (host.startsWith(".")) host else ".$host"
                for (pair in cookies.split(";")) {
                    val split = pair.indexOf('=')
                    val name = (if (split <= 0) pair else pair.substring(0, split)).trim { it <= ' ' }
                    if (name.isEmpty()) continue
                    expired.add(arrayOf(source, name + "=; Max-Age=0; Path=/; Secure"))
                    if (dotDomain.isNotEmpty()) {
                        expired.add(arrayOf(source, name + "=; Max-Age=0; Path=/; Secure; Domain=" + dotDomain))
                    }
                }
            }
            if (expired.isEmpty()) { manager.flush(); finished.run(); return }
            val remaining = java.util.concurrent.atomic.AtomicInteger(expired.size)
            for (entry in expired) {
                manager.setCookie(entry[0], entry[1]) { ignored ->
                    if (remaining.decrementAndGet() == 0) { manager.flush(); finished.run() }
                }
            }
        }
    }

    private var webView: WebView? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        active = WeakReference<AppleMusicHostActivity>(this)

        val root = LinearLayout(this)
        root.orientation = LinearLayout.VERTICAL
        root.setBackgroundColor(Color.BLACK)

        root.addView(buildBar())

        webView = WebView(this)
        val settings = webView!!.settings
        settings.javaScriptEnabled = true
        // 登录态与页面自己的会话都靠 DOM storage；第三方 cookie 开着是刻意的：
        // 登录在 idmsa.apple.com 与 music.apple.com 之间串联，关了就登不上。
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)
        // 播放由插件从页面外触发（renderer 的播放按钮），不能等用户先点过屏幕。
        settings.mediaPlaybackRequiresUserGesture = false
        // 只许 https：Apple 的资源本来全在 https 上，混合内容没必要放行。
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        // 这一座 WebView 不给页面任何扩权：file://、content://、跨文件读写全关。
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.allowFileAccessFromFileURLs = false
        settings.allowUniversalAccessFromFileURLs = false
        // UA 保持系统 WebView 原样：Apple 若拒绝嵌入浏览器就明拒，不在这台设备上说谎。
        webView!!.addJavascriptInterface(HostBridge(), "foliaAppleNative")
        webView!!.webViewClient = HostClient()
        webView!!.layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
        root.addView(webView)

        setContentView(root)
        // 返回键不当「关掉」用：这页就是登录与播放本身，退到后台（与「隐藏」同款）才是对的。
        onBackPressedDispatcher.addCallback(this, object : androidx.activity.OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                moveTaskToBack(true)
            }
        })
        webView!!.loadUrl(START_URL)
    }

    // 刻意**不**调 webView.onPause() / pauseTimers()：音频是在这座 WebView 里出声的，
    // App 前台、宿主退到后台时（hideWindow / 用户按「隐藏」）它必须继续播。
    // pauseTimers 会把 JS 定时器与媒体管线一并挂起，Apple 的歌当场就停 ——
    // 这里宁可让 WebView 全速跑，靠前台保持服务（AppleMusicHoldService）托住进程。
    override fun onPause() {
        super.onPause()
    }

    /**
     * 把当前 script 灌进页面并翻「就绪」。
     *
     * script 是一个 function 表达式的源码（renderer 保证以 `function` 开头），直接拼在
     * `window.__foliaHandle = ` 后面执行；同一页面重复注入是幂等的（source 没变就跳过，
     * 只补翻就绪标志）。必须主线程调用。
     */
    internal fun injectCurrentScript() {
        val view = webView ?: return
        val script = hostScript
        if (script == null || script.isEmpty()) return
        if (script == injectedScript) {
            markReady()
            return
        }
        view.evaluateJavascript("window.__foliaHandle = " + script + "; void 0;", null)
        injectedScript = script
        markReady()
    }

    /** 只在 false→true 那一下触发一次就绪监听（登出流程靠它知道页面重新就绪了）。 */
    private fun markReady() {
        if (pageReady) return
        pageReady = true
        val listener = readyListener
        readyListener = null
        listener?.run()
    }

    /** 登出流程第一步：把页面踢到空白（调用方随后清 cookie 再回来）。 */
    internal fun loadBlank() {
        webView?.loadUrl("about:blank")
    }

    /** 登出流程最后一步：回到 Apple Music 本尊（onPageFinished 会重灌脚本、翻就绪）。 */
    internal fun loadStartUrl() {
        webView?.loadUrl(START_URL)
    }

    /** 插件往页面里送 JS（必须主线程；页面没就绪时插件自己会超时，这里不用兜）。 */
    internal fun evaluateInPage(script: String) {
        val view = webView ?: return
        view.evaluateJavascript(script, null)
    }

    /** 顶上一条：左边「隐藏」（把这一个 task 退到后台，音频继续），中间标题。样式与登录屏同款。 */
    private fun buildBar(): View {
        val bar = LinearLayout(this)
        val height = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, 52f, resources.displayMetrics).toInt()
        bar.layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, height)
        bar.orientation = LinearLayout.HORIZONTAL
        bar.gravity = Gravity.CENTER_VERTICAL
        bar.setBackgroundColor(Color.parseColor("#111111"))

        bar.addView(barButton(labelOr(EXTRA_HIDE_LABEL, "Hide"), View.OnClickListener { moveTaskToBack(true) }))
        val title = TextView(this)
        title.text = labelOr(EXTRA_TITLE, "Apple Music")
        title.setTextColor(Color.WHITE)
        title.textSize = 15f
        title.gravity = Gravity.CENTER
        title.layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        bar.addView(title)
        return bar
    }

    private fun labelOr(extra: String, fallback: String): String {
        val value = if (intent == null) null else intent.getStringExtra(extra)
        return if (value == null || value.trim { it <= ' ' }.isEmpty()) fallback else value
    }

    private fun barButton(text: String, onClick: View.OnClickListener): Button {
        val button = Button(this)
        button.text = text
        button.isAllCaps = false
        button.setTextColor(Color.WHITE)
        button.setBackgroundColor(Color.TRANSPARENT)
        button.setOnClickListener(onClick)
        return button
    }

    /** 页面回话的唯一入口：只把 nonce 与 payload 转交给插件，别的不暴露给页面。 */
    private inner class HostBridge {
        @JavascriptInterface
        fun result(nonce: String?, payload: String?) {
            if (nonce == null) return
            val sink = resultSink ?: return
            sink.onResult(nonce, payload ?: "")
        }
    }

    private inner class HostClient : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            // uri.host / uri.scheme 标可空；这里全部按非空缺省兜住（与登录屏同款）。
            val allowed = isAllowedAddress(request.url)
            if (!allowed) {
                Log.w(TAG, "the apple music host blocked a navigation to " + (request.url.host ?: ""))
                return true
            }
            return false
        }

        override fun onPageFinished(view: WebView, url: String) {
            if (url.startsWith("about:")) {
                // 登出流程在等 about:blank 落地那一步（清 cookie 之前先把页面停掉）。
                val pending = blankListener
                if (pending != null) {
                    blankListener = null
                    pending.run()
                }
                return
            }
            // 新的一页：页面上下文是新的，旧页注入过的东西作废，脚本要重灌（幂等由
            // injectedScript 那一份把着，同一页不会重复灌）。
            injectedScript = null
            pageLoaded = true
            injectCurrentScript()
        }

        /**
         * 渲染进程没了（API 26+）：**必须返回 true**，否则默认实现告诉系统「这个 App
         * 处理不了」，系统把整个进程带走（见 QishuiSignHost 那次真崩）。
         *
         * 这座 WebView 已经废了，登录态与播放都随渲染进程没了 —— 没法救，只能把这一屏
         * 收掉；插件的下一次 prepare 会重新起一座（cookie 还在罐里，登录未必丢）。
         */
        // 这个回调只在 API 26+ 上才会被系统调用，minSdk 24 上它永远不会被误触。
        @SuppressLint("NewApi")
        override fun onRenderProcessGone(view: WebView?, detail: RenderProcessGoneDetail?): Boolean {
            Log.w(TAG, "the apple music host lost its renderer (crashed=" + (detail != null && detail.didCrash()) + ")")
            if (active.get() === this@AppleMusicHostActivity) {
                pageLoaded = false
                pageReady = false
                injectedScript = null
            }
            finish()
            return true
        }
    }

    // 真正的销毁才收 WebView；旋转等配置重建（isFinishing 为 false）交给重建出来的那一屏
    // 接着守住 —— 就绪标志只在「这一屏就是 active 的那一个」时清，别把重建后的新屏误杀。
    override fun onDestroy() {
        if (active.get() === this) {
            active.clear()
            pageLoaded = false
            pageReady = false
            injectedScript = null
        }
        if (webView != null) {
            webView!!.webViewClient = WebViewClient()
            webView!!.destroy()
            webView = null
        }
        super.onDestroy()
    }
}
