package top.izuna.foliamajor

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.util.Log

import androidx.core.app.NotificationCompat

/**
 * Apple Music 宿主的「前台保持」服务。
 *
 * 为什么必须有它：宿主里的音频由 WebView 播放（Apple 的 DRM 只肯在页面里出声），
 * 应用退到后台后系统随时可能收进程，音频就断了。startForeground 让进程拿到前台
 * 优先级，音频才稳 —— 动机与 [FoliaPlaybackService] 同源，但它只为 Apple Music
 * 宿主存在：不挂 MediaSession、不接控制按钮，通知只有一行。它也不动
 * FoliaPlaybackService 本身的任何逻辑（那条通知与队列是本地播放的事）。
 *
 * 生命周期完全由插件驱动：FoliaAppleMusic.setForeground(true) 起服务，(false) /
 * dispose 停服务，服务自己没有任何主意（不会被 START_STICKY 无端复活）。
 */
class AppleMusicHoldService : Service() {
    companion object {
        private const val TAG = "FoliaAppleHold"

        /** 通知渠道：与播放控制（folia_playback）分开，用户可以在系统里单独关掉它。 */
        private const val CHANNEL_ID = "folia_apple_music_hold"
        private const val NOTIFICATION_ID = 0x1F0A

        /** 起服务的 action（stop 走 stopService，不需要 action）。 */
        const val ACTION_HOLD = "top.izuna.foliamajor.action.APPLE_MUSIC_HOLD"
    }

    override fun onBind(intent: Intent?): IBinder? {
        return null
    }

    override fun onCreate() {
        super.onCreate()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // 通知渠道是 8+ 的硬要求，缺了 startForeground 直接静默不出通知。
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Apple Music 播放",
                NotificationManager.IMPORTANCE_LOW)
            channel.description = "Apple Music 在后台播放时保持应用存活"
            // 保持性通知不该出声、震动，也不进用户的视线顶部（LOW 足够保活）。
            channel.setSound(null, null)
            channel.enableVibration(false)
            manager.createNotificationChannel(channel)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // 不是「保持」的启动（本服务用 START_NOT_STICKY，正常不会有空 intent 的重启）：
        // 这个服务没有别的职责，直接收，别空挂一个前台。
        if (intent == null || ACTION_HOLD != intent.action) {
            stopSelf()
            return START_NOT_STICKY
        }
        // 5 秒规则：startForegroundService 一开出来，startForeground 必须在 5 秒内兑现，
        // 超时系统抛 ForegroundServiceDidNotStartInTimeException 直接杀进程（见
        // FoliaPlaybackService.onCreate 那段的血泪史）。所以放在任何分支的最前面，
        // 兑现失败也只是没有通知，不把整个应用带走。
        try {
            startForeground(NOTIFICATION_ID, buildNotification())
        } catch (error: Throwable) {
            Log.e(TAG, "startForeground failed; the hold service gives up", error)
            stopSelf()
        }
        return START_NOT_STICKY
    }

    private fun buildNotification(): Notification {
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("Folia")
            .setContentText("Apple Music 正在播放")
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOnlyAlertOnce(true)
            .setOngoing(true)
            .build()
    }

    override fun onDestroy() {
        // 正常停（stopService）时系统会收掉通知；这里再显式退一次前台，
        // 兜个别 ROM 把通知残留成死键。
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }
}
