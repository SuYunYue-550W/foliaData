package top.izuna.foliamajor

import android.animation.AnimatorListenerAdapter
import android.animation.ValueAnimator
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.graphics.Color
import android.graphics.PixelFormat
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import android.util.DisplayMetrics
import kotlin.math.min
import android.view.Choreographer
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.view.animation.PathInterpolator
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.core.app.NotificationCompat

/**
 * 鲸鱼桌宠的**系统级悬浮窗**：在应用之外（其他 App 之上）也能看到、拖动、戳一戳。
 *
 * 【单一渲染源 / 开屏过渡】—— 本轮重构的核心：
 *  - 屏幕上**从头到尾只有这一个窗口、一个 WebView、一段视频**。开屏动画里的那只鲸鱼，
 *    就是最终「显示在应用上层」的常驻桌宠本身，不是主 WebView 里的另一个 <video>。
 *  - splash=true 启动时，窗口直接以「屏幕中央 + 放大尺寸」addView 并 NOT_TOUCHABLE，
 *    播放 initialAnim —— 这就是开屏大鲸鱼。主 WebView 只铺黑幕，不渲染任何鲸鱼。
 *  - 3 秒后 Web 层调 animateToRest()：一条 ValueAnimator 把窗口的 x/y/width/height
 *    **连续插值**到「用户上次拖到的落点 + 真实尺寸」。鲸鱼一边缩小一边飞到该去的位置，
 *    同时主 WebView 黑幕渐隐、App 界面浮现。动画结束恢复可触摸，过渡完成。
 *  - 全程零接管、零交叉淡化、零坐标换算：窗口 x/y 从落点算出后就是动画终点，动画归零
 *    时鲸鱼**精确**停在 restorePos() 的位置，误差恒为 0 —— 彻底根治旧方案里「主 WebView
 *    morph 终点（按 16:9 魔数换算）与浮层窗口 object-fit:contain 真实中心不一致」导致的
 *    「过渡结束后鲸鱼又向下移动一段距离」。
 *
 * 为什么不逐帧改窗口会「越大越不全」：WebView 子控件恒为 MATCH_PARENT，浮层页把 .whale-pet
 * 强制成 100vw/100vh 铺满，video 用 object-fit:contain。窗口尺寸变化时 CSS 视口跟随变化，
 * 视频只做等比缩放、永不裁切；期间也不改 View 的 layoutParams / translation，无异步布局竞态。
 *
 * 关键约定：
 *  1. 所有拖拽/点击都在**原生层**处理（FrameLayout 的 onTouch），WebView 内部 pointer 被消费。
 *  2. 位置持久化到 SharedPreferences，重启服务后回到上次放置处。
 *  3. 始终保留 GRAB_PX 像素在屏内，确保鲸鱼再怎么出屏也能被重新抓回来。
 *  4. 前台服务：Android 8+ 后台服务会被限期回收，鲸鱼要常驻就必须前台化（带一条常驻通知）。
 */
class FloatingWhaleService : Service() {

    private lateinit var windowManager: WindowManager
    private lateinit var prefs: SharedPreferences
    private var rootView: FrameLayout? = null
    private var webView: WebView? = null
    private var params: WindowManager.LayoutParams? = null
    /** 桌宠设置（size/opacity/idle/dragAnim/tips/beatDance…），由启动 Intent 透传。 */
    private var settingsJson: String? = null
    /** 用户真实桌宠尺寸（dp）。 */
    private var realSizeDp = 0f

    /** 当前窗口尺寸（px）。会随开屏过渡连续变化；落位后恒等于 restW/restH。 */
    private var winW = 0
    private var winH = 0
    private var density = 1f
    private var screenW = 0
    private var screenH = 0
    private var grabPx = 0

    /** 开屏模式：窗口当前处于「屏幕中央放大态」，不吃触摸；过渡结束后置 false。 */
    private var splashMode = false
    /** 浮层首启兜底用的「应用内桌宠」上次位置（屏幕中心比例 0~1）；NaN 表示未提供。 */
    private var initFracX = Double.NaN
    private var initFracY = Double.NaN

    /** 常驻落点与真实尺寸（过渡终点，精确等于 restorePos() 与 realSizeDp）。 */
    private var restX = 0
    private var restY = 0
    private var restW = 0
    private var restH = 0
    /** 开屏放大态（过渡起点）：屏幕中央、短边 74% 宽。 */
    private var splashX = 0
    private var splashY = 0
    private var splashW = 0
    private var splashH = 0
    private var restAnimator: ValueAnimator? = null

    private var dragging = false
    private var downRawX = 0f
    private var downRawY = 0f
    private var startWinX = 0
    private var startWinY = 0

    private var dragScheduled = false
    private var pendingX = 0
    private var pendingY = 0
    private val dragFrame = Choreographer.FrameCallback {
        dragScheduled = false
        if (dragging && params != null) {
            params!!.x = pendingX
            params!!.y = pendingY
            try { windowManager.updateViewLayout(rootView, params) } catch (_: Throwable) {}
        }
    }
    private var pendingResizeDp = 0f
    private var resizeScheduled = false
    private val resizeFrame = Choreographer.FrameCallback {
        resizeScheduled = false
        val s = pendingResizeDp
        if (s > 0f && !splashMode) applyResize(s, false)
    }

    override fun onCreate() {
        super.onCreate()
        instance = this
        windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        prefs = getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
        refreshScreenSize()
        grabPx = (GRAB_DP * density).toInt()
        winW = (SIZE_DP * density).toInt()
        winH = (winW * 0.5625f).toInt()
    }

    private fun refreshScreenSize() {
        val dm = DisplayMetrics()
        @Suppress("DEPRECATION")
        windowManager.defaultDisplay.getMetrics(dm)
        screenW = dm.widthPixels
        screenH = dm.heightPixels
        density = dm.density
    }

    private fun parseSizeDp(json: String?): Float {
        if (json.isNullOrEmpty()) return 0f
        return try {
            val obj = org.json.JSONObject(json)
            val s = obj.optDouble("size", 0.0)
            if (s > 0) s.toFloat() else 0f
        } catch (_: Throwable) { 0f }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        settingsJson = intent?.getStringExtra("settings")
        val sizeDp = parseSizeDp(settingsJson)
        realSizeDp = if (sizeDp > 0) sizeDp else SIZE_DP
        val splash = intent?.getBooleanExtra("splash", false) ?: false
        val fx = intent?.getDoubleExtra("initFracX", Double.NaN)
        val fy = intent?.getDoubleExtra("initFracY", Double.NaN)
        if (fx != null && !fx.isNaN()) initFracX = fx
        if (fy != null && !fy.isNaN()) initFracY = fy

        computeRects()

        if (!hasOverlayPermission()) {
            isRunning = false
            stopSelf()
            return START_NOT_STICKY
        }
        try {
            startForeground(NOTIF_ID, buildNotification())
        } catch (e: Throwable) {
            isRunning = false
            try { rootView?.let { windowManager.removeView(it) } } catch (_: Throwable) {}
            rootView = null
            stopSelf()
            return START_NOT_STICKY
        }
        if (rootView == null) {
            splashMode = splash
            buildWindow()
        } else {
            // 服务复用（前台服务常驻、用户再次冷启动 App）：窗口已存在，按本次 splash 标志
            // 重新设回「开屏放大态」或直接落位，否则会停留在上次的常驻状态而开屏时冒出两只。
            if (splash) applySplashNow() else settleNow()
        }
        if (rootView == null) {
            isRunning = false
            stopSelf()
            return START_NOT_STICKY
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
        super.onConfigurationChanged(newConfig)
        // 旋转 / 折叠屏 / 分屏：屏幕尺寸变了，常驻落点矩形必须按新屏幕重算，
        // 否则 finishRest 会按旧屏幕把鲸鱼写到错误位置甚至屏外。
        // 开屏/过渡期间不直接改窗口几何（由动画接管），动画每帧读的 restX/restY 会自然指向新落点。
        refreshScreenSize()
        computeRects()
        if (splashMode) return
        params?.let {
            val (cx, cy) = clamp(it.x, it.y)
            it.x = cx
            it.y = cy
            try { windowManager.updateViewLayout(rootView, it) } catch (_: Throwable) {}
        }
    }

    override fun onDestroy() {
        isRunning = false
        try { restAnimator?.cancel() } catch (_: Throwable) {}
        restAnimator = null
        try { Choreographer.getInstance().removeFrameCallback(dragFrame) } catch (_: Throwable) {}
        try { Choreographer.getInstance().removeFrameCallback(resizeFrame) } catch (_: Throwable) {}
        dragScheduled = false
        stopForeground(STOP_FOREGROUND_REMOVE)
        try { rootView?.let { windowManager.removeView(it) } } catch (_: Throwable) {}
        rootView = null
        webView?.destroy()
        webView = null
        instance = null
        super.onDestroy()
    }

    /** 主 WebView 桥接转发：调用浮层鲸鱼 pet 实例上的方法。 */
    private fun handleInvoke(method: String, argsJson: String): Boolean {
        if (method == "applySettings") {
            try {
                val arr = org.json.JSONArray(argsJson)
                if (arr.length() > 0) {
                    val o = arr.optJSONObject(0)
                    if (o != null && o.has("size")) {
                        val s = o.optDouble("size", 0.0)
                        if (s > 0) resizeWindow(s.toFloat())
                    }
                }
            } catch (_: Throwable) { }
        } else if (method == "resetPos") {
            resetWindowPos()
        }
        val wv = webView ?: return false
        val js = """(function(){
            var attempt = function (n) {
                var p = window.__whalePet;
                if (!p || typeof p['$method'] !== 'function') {
                    if (n > 0) setTimeout(function(){ attempt(n - 1); }, 120);
                    return false;
                }
                try {
                    var args = $argsJson;
                    p['$method'].apply(p, args);
                    return true;
                } catch (e) { return false; }
            };
            attempt(15);
        })();"""
        val run = { try { wv.evaluateJavascript(js, null) } catch (_: Throwable) {} }
        if (Looper.myLooper() == Looper.getMainLooper()) run() else Handler(Looper.getMainLooper()).post(run)
        return true
    }

    // ---------------------------------------------------------------- 几何：落点 / 开屏放大态

    /** 算出「常驻落点矩形」与「开屏放大态矩形」。只在 onStartCommand 调一次。 */
    private fun computeRects() {
        if (screenW <= 0 || screenH <= 0) refreshScreenSize()
        restW = (realSizeDp * density).toInt().coerceAtLeast(1)
        restH = (restW * 0.5625f).toInt().coerceAtLeast(1)
        // clamp() 依赖 winW/winH，先按真实尺寸算落点。
        winW = restW
        winH = restH
        val (rx, ry) = restorePos()
        restX = rx
        restY = ry

        val big = (min(screenW, screenH) * SPLASH_SCALE_FRAC).toInt()
        splashW = big.coerceAtLeast(restW)
        splashH = (splashW * 0.5625f).toInt()
        splashX = (screenW - splashW) / 2
        splashY = ((screenH - splashH) / 2) - (screenH * 0.04f).toInt()
    }

    // ---------------------------------------------------------------- 构建悬浮窗

    private fun buildWindow() {
        if (rootView != null) return
        val ctx = this
        val frame = FrameLayout(ctx).apply {
            setBackgroundColor(Color.TRANSPARENT)
            // 唯一的鲸鱼：从建窗第一帧就可见（视频加载完即刻上屏）。没有隐藏态、没有接管淡入。
            alpha = 1f
        }

        val wv = WebView(ctx).apply {
            setBackgroundColor(Color.TRANSPARENT)
            setLayerType(View.LAYER_TYPE_HARDWARE, null)
            isHorizontalScrollBarEnabled = false
            isVerticalScrollBarEnabled = false
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                allowFileAccess = true
                allowContentAccess = true
                mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
                useWideViewPort = false
                loadWithOverviewMode = false
                cacheMode = WebSettings.LOAD_NO_CACHE
                mediaPlaybackRequiresUserGesture = false
            }
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(
                    view: WebView?, request: WebResourceRequest?
                ): Boolean = true

                override fun onPageFinished(view: WebView?, url: String?) {
                    super.onPageFinished(view, url)
                    val s = settingsJson
                    if (!s.isNullOrEmpty()) {
                        view?.evaluateJavascript("(function(){window.__WHALE_SETTINGS=$s;})();", null)
                    }
                }
            }
            setOnTouchListener { _: View, e: MotionEvent -> handleTouch(e) }
        }
        // 仅 debuggable 构建开放远程调试，release 包不允许 chrome://inspect 附加。
        if (0 != (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE)) {
            WebView.setWebContentsDebuggingEnabled(true)
        }
        wv.loadUrl("file:///android_asset/whale-float.html")

        // 恒为 MATCH_PARENT：窗口尺寸连续变化时 WebView 视口跟随，鲸鱼 100vw/100vh 铺满、
        // object-fit:contain 等比缩放，任何尺寸下都完整不裁切。
        val lp = FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        )
        frame.addView(wv, lp)

        val x0: Int
        val y0: Int
        val w0: Int
        val h0: Int
        if (splashMode) {
            x0 = splashX; y0 = splashY; w0 = splashW; h0 = splashH
        } else {
            x0 = restX; y0 = restY; w0 = restW; h0 = restH
        }
        winW = w0
        winH = h0
        val wlp = WindowManager.LayoutParams().apply {
            width = w0
            height = h0
            type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            else
                WindowManager.LayoutParams.TYPE_PHONE
            flags = (WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                    or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                    or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
                    or WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED)
            // 开屏/过渡期间不吃触摸：双击跳过由主 WebView 的黑幕接收。
            if (splashMode) flags = flags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
            format = PixelFormat.TRANSLUCENT
            gravity = Gravity.TOP or Gravity.START
            this.x = x0
            this.y = y0
        }

        try {
            windowManager.addView(frame, wlp)
            rootView = frame
            webView = wv
            params = wlp
            isRunning = true
        } catch (e: Throwable) {
            isRunning = false
        }
    }

    // ---------------------------------------------------------------- 开屏 → 落点 过渡

    /** 把已有窗口设回开屏放大态（服务复用 / 二次冷启动时用），一次 updateViewLayout。 */
    private fun applySplashNow() {
        val frame = rootView ?: return
        val p = params ?: return
        val a = restAnimator
        restAnimator = null
        // cancel() 也会回调 onAnimationEnd → finishRest()，必须先摘掉监听器，
        // 否则会先落位再读起点，导致第二次过渡从落点起跳、几何错乱。
        try { a?.removeAllListeners(); a?.cancel() } catch (_: Throwable) {}
        try { frame.animate().cancel() } catch (_: Throwable) {}
        splashMode = true
        frame.alpha = 1f
        winW = splashW; winH = splashH
        p.x = splashX; p.y = splashY; p.width = splashW; p.height = splashH
        p.flags = p.flags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
        try { windowManager.updateViewLayout(frame, p) } catch (_: Throwable) {}
    }

    /**
     * 开屏播放结束：把窗口从「屏幕中央放大态」连续变换到「常驻落点 + 真实尺寸」。
     *
     * 这是用户要的「同一个鲸鱼通过一个过渡变换到该去的位置」——一个 ValueAnimator 同时
     * 插值 x/y/width/height，全程只有这一个窗口、这一个 WebView、这一段视频，播放不中断。
     * 终点是建窗时就算好的 restX/restY/restW/restH（来自 restorePos()），因此动画归零时
     * 鲸鱼精确停在用户上次拖到的位置，不存在任何换算误差或「再向下挪一段」。
     */
    private fun animateToRest(durMs: Long): Boolean {
        if (!isRunning) return false
        val run = Runnable {
            if (!isRunning) return@Runnable
            val frame = rootView ?: return@Runnable
            val p = params ?: return@Runnable
            if (!splashMode) { settleNow(); return@Runnable }
            val old = restAnimator
            restAnimator = null
            try { old?.removeAllListeners(); old?.cancel() } catch (_: Throwable) {}

            val sX = p.x.toFloat()
            val sY = p.y.toFloat()
            val sW = p.width.toFloat()
            val sH = p.height.toFloat()
            // 逐帧改窗口几何会让 WebView 重测视口；取整后相邻帧常常完全相同，去重可省掉
            // 相当一部分无意义的 relayout（这是本方案唯一的重开销点）。
            var lastX = Int.MIN_VALUE
            var lastY = Int.MIN_VALUE
            var lastW = Int.MIN_VALUE
            var lastH = Int.MIN_VALUE
            val anim = ValueAnimator.ofFloat(0f, 1f).apply {
                duration = durMs.coerceAtLeast(120L)
                interpolator = PathInterpolator(0.25f, 0.1f, 0.25f, 1f)
                addUpdateListener { va ->
                    val t = va.animatedValue as Float
                    val nx = (sX + (restX - sX) * t).toInt()
                    val ny = (sY + (restY - sY) * t).toInt()
                    val nw = (sW + (restW - sW) * t).toInt().coerceAtLeast(1)
                    val nh = (sH + (restH - sH) * t).toInt().coerceAtLeast(1)
                    if (nx == lastX && ny == lastY && nw == lastW && nh == lastH) return@addUpdateListener
                    lastX = nx; lastY = ny; lastW = nw; lastH = nh
                    val q = params ?: return@addUpdateListener
                    q.x = nx
                    q.y = ny
                    q.width = nw
                    q.height = nh
                    try { windowManager.updateViewLayout(frame, q) } catch (_: Throwable) {}
                }
                addListener(object : AnimatorListenerAdapter() {
                    override fun onAnimationEnd(animation: android.animation.Animator) { finishRest() }
                })
            }
            restAnimator = anim
            anim.start()
        }
        if (Looper.myLooper() == Looper.getMainLooper()) run.run()
        else Handler(Looper.getMainLooper()).post(run)
        return true
    }

    /** 过渡正常结束：精确落到 rest 矩形、恢复可触摸。幂等。 */
    private fun finishRest() {
        val frame = rootView ?: return
        val p = params ?: return
        splashMode = false
        restAnimator = null
        winW = restW; winH = restH
        p.x = restX; p.y = restY; p.width = restW; p.height = restH
        p.flags = p.flags and WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE.inv()
        frame.alpha = 1f
        try { windowManager.updateViewLayout(frame, p) } catch (_: Throwable) {}
        // 开屏期间被推迟的尺寸变更，落位后补上。
        if (pendingResizeDp > 0f) {
            val s = pendingResizeDp
            pendingResizeDp = 0f
            resizeWindow(s)
        }
    }

    /** 立即落位（用户关了开屏 / 跳过 / 异常兜底）：取消动画并直达终点。 */
    private fun settleNow(): Boolean {
        if (!isRunning) return false
        val run = Runnable {
            val a = restAnimator
            restAnimator = null
            try { a?.removeAllListeners(); a?.cancel() } catch (_: Throwable) {}
            finishRest()
        }
        if (Looper.myLooper() == Looper.getMainLooper()) run.run()
        else Handler(Looper.getMainLooper()).post(run)
        return true
    }

    // ---------------------------------------------------------------- 触摸：拖拽 + 戳

    private fun handleTouch(e: MotionEvent): Boolean {
        // 开屏/过渡期间窗口不吃触摸（已 NOT_TOUCHABLE），这里再挡一道，避免与动画抢 x/y。
        if (splashMode) return true
        when (e.action) {
            MotionEvent.ACTION_DOWN -> {
                downRawX = e.rawX
                downRawY = e.rawY
                params?.let { startWinX = it.x; startWinY = it.y }
                dragging = false
                return true
            }
            MotionEvent.ACTION_MOVE -> {
                val dx = e.rawX - downRawX
                val dy = e.rawY - downRawY
                if (!dragging && Math.hypot(dx.toDouble(), dy.toDouble()) > SLOP_PX) dragging = true
                if (dragging) {
                    val (nx, ny) = clamp(startWinX + dx.toInt(), startWinY + dy.toInt())
                    pendingX = nx
                    pendingY = ny
                    if (!dragScheduled) {
                        dragScheduled = true
                        Choreographer.getInstance().postFrameCallback(dragFrame)
                    }
                }
                return true
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                if (dragging) {
                    dragging = false
                    params?.x = pendingX
                    params?.y = pendingY
                    try { windowManager.updateViewLayout(rootView, params) } catch (_: Throwable) {}
                    params?.let { savePos(it.x, it.y) }
                    return true
                }
                poke()
                return true
            }
        }
        return true
    }

    private fun poke() {
        try {
            webView?.evaluateJavascript(
                "(function(){var p=window.__whalePet;" +
                "if(p&&p.poke){p.poke();}" +
                "else if(p&&p.react){p.react('poke');}" +
                "return true;})();", null
            )
        } catch (_: Throwable) { }
    }

    // ---------------------------------------------------------------- 位置存取与夹取

    private fun clamp(x: Int, y: Int): Pair<Int, Int> {
        if (screenW <= 0 || screenH <= 0) refreshScreenSize()
        val minX = -(winW - grabPx)
        val maxX = screenW - grabPx
        val minY = -(winH - grabPx)
        val maxY = screenH - grabPx
        val cx = if (minX <= maxX) x.coerceIn(minX, maxX) else (minX + maxX) / 2
        val cy = if (minY <= maxY) y.coerceIn(minY, maxY) else (minY + maxY) / 2
        return cx to cy
    }

    /** 纯读：算出「用户上次放置的位置」。绝不写 prefs。 */
    private fun restorePos(): Pair<Int, Int> {
        if (screenW <= 0 || screenH <= 0) refreshScreenSize()
        val x = prefs.getInt(KEY_X, Integer.MIN_VALUE)
        val y = prefs.getInt(KEY_Y, Integer.MIN_VALUE)
        if (x != Integer.MIN_VALUE && y != Integer.MIN_VALUE) return clamp(x, y)
        if (!initFracX.isNaN() && !initFracY.isNaN()) {
            val landW = ((if (realSizeDp > 0) realSizeDp else SIZE_DP) * density).toInt()
            val sx = (initFracX * screenW - landW / 2).toInt()
            val sy = (initFracY * screenH - landW * 0.5625f / 2).toInt()
            return clamp(sx, sy)
        }
        val cx = (screenW - winW) / 2
        val cy = (screenH * 0.14f).toInt()
        return clamp(cx, cy)
    }

    private fun resizeWindow(sizeDp: Float) {
        if (sizeDp <= 0) return
        if (Looper.myLooper() != Looper.getMainLooper()) {
            Handler(Looper.getMainLooper()).post { resizeWindow(sizeDp) }
            return
        }
        pendingResizeDp = sizeDp
        if (splashMode) return   // 落位后由 finishRest 补上
        if (!resizeScheduled) {
            resizeScheduled = true
            Choreographer.getInstance().postFrameCallback(resizeFrame)
        }
    }

    private fun applyResize(sizeDp: Float, center: Boolean) {
        if (splashMode) return
        if (Looper.myLooper() != Looper.getMainLooper()) {
            Handler(Looper.getMainLooper()).post { applyResize(sizeDp, center) }
            return
        }
        val newW = (sizeDp * density).toInt()
        val newH = (newW * 0.5625f).toInt()
        if (newW <= 0 || newH <= 0) return
        val p = params ?: return
        // 尺寸变更必须同步「过渡终点」，否则下次开屏 computeRects()/finishRest()
        // 会把窗口写回旧尺寸。
        realSizeDp = sizeDp
        restW = newW
        restH = newH
        winW = newW
        winH = newH
        p.width = newW
        p.height = newH
        if (center) {
            if (screenW <= 0 || screenH <= 0) refreshScreenSize()
            val cx = (screenW - winW) / 2
            val cy = ((screenH - winH) / 2) - (screenH * 0.06f).toInt()
            val (nx, ny) = clamp(cx, cy)
            p.x = nx
            p.y = ny
        } else {
            val (cx, cy) = clamp(p.x, p.y)
            p.x = cx
            p.y = cy
        }
        try { windowManager.updateViewLayout(rootView, p) } catch (_: Throwable) { }
    }

    private fun resetWindowPos() {
        if (splashMode) return
        if (Looper.myLooper() != Looper.getMainLooper()) {
            Handler(Looper.getMainLooper()).post { resetWindowPos() }
            return
        }
        val p = params ?: return
        if (screenW <= 0 || screenH <= 0) refreshScreenSize()
        val cx = (screenW - winW) / 2
        val (nx, ny) = clamp(cx, 0)
        p.x = nx
        p.y = ny
        try { windowManager.updateViewLayout(rootView, p) } catch (_: Throwable) { }
        savePos(nx, ny)
    }

    private fun savePos(x: Int, y: Int) {
        prefs.edit().putInt(KEY_X, x).putInt(KEY_Y, y).apply()
    }

    private fun hasOverlayPermission(): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            return try { Settings.canDrawOverlays(this) } catch (_: Throwable) { false }
        }
        return true
    }

    // ---------------------------------------------------------------- 前台通知

    private fun buildNotification(): Notification {
        val chanId = "whale_pet_channel"
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val chan = NotificationChannel(chanId, "鲸鱼桌宠", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Folia 鲸鱼桌宠悬浮窗常驻通知"
                setShowBadge(false)
            }
            nm.createNotificationChannel(chan)
        }
        val launch = packageManager.getLaunchIntentForPackage(packageName) ?: Intent()
        val pi = PendingIntent.getActivity(
            this, 0, launch,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        return NotificationCompat.Builder(this, chanId)
            .setContentTitle("Folia 鲸鱼桌宠")
            .setContentText("正在其他应用之上显示 · 点按戳一戳，长按拖拽移动")
            .setSmallIcon(android.R.drawable.ic_menu_info_details)
            .setContentIntent(pi)
            .setOngoing(true)
            .build()
    }

    /** 供插件查询当前窗口矩形（CSS px）。Web 层已不再依赖它做 morph 对齐，保留兼容。 */
    private fun restRectCss(): FloatArray? {
        val p = params ?: return null
        if (screenW <= 0 || screenH <= 0) refreshScreenSize()
        val d = if (density > 0f) density else 1f
        return floatArrayOf(p.x / d, p.y / d, p.width / d, p.height / d, screenW / d, screenH / d)
    }

    companion object {
        const val PREF_NAME = "whale_float"
        const val KEY_X = "x"
        const val KEY_Y = "y"
        const val NOTIF_ID = 90210
        const val SIZE_DP = 168f
        const val GRAB_DP = 40f
        const val SLOP_PX = 8f
        /** 开屏放大态占屏幕短边的比例（与旧版主 WebView 开屏大鲸鱼观感一致）。 */
        const val SPLASH_SCALE_FRAC = 0.74f

        @Volatile
        var isRunning: Boolean = false
            internal set

        @Volatile
        var instance: FloatingWhaleService? = null
            private set

        fun invoke(method: String, argsJson: String): Boolean =
            instance?.handleInvoke(method, argsJson) ?: false

        /** 开屏播放结束：启动「居中放大态 → 常驻落点」的单一连续过渡。 */
        fun animateToRest(durMs: Long): Boolean = instance?.animateToRest(durMs) ?: false

        /** 跳过开屏 / 异常兜底：窗口立即落到常驻位并可触摸。 */
        fun settleNow(): Boolean = instance?.settleNow() ?: false

        fun restRectCss(): FloatArray? = instance?.restRectCss()
    }
}
