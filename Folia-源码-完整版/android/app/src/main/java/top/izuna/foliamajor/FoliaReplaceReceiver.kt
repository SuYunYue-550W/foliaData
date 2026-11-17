package top.izuna.foliamajor

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * 包被替换（覆盖安装）或被移除时，把应用自己起的前台服务收掉。
 *
 * **为什么需要它**：MIUI 的安装器在覆盖安装时会先卸载旧版本。旧版本的进程还在、
 * 前台服务（播放服务、Apple Music 保活服务、悬浮窗）还占着文件时，卸载这一步会失败，
 * 手机上弹的是 "Failed to uninstall old application files. Please try running the
 * installer again. -2" —— 装不上去，而且重试多少次都一样。系统发
 * `ACTION_PACKAGE_REPLACED` / `ACTION_PACKAGE_FULLY_REMOVED` 时，旧进程还能收到，
 * 这时主动收尾，卸载就能干净地走完。
 *
 * 别的系统（原生 AOSP）在覆盖安装时是直接换 apk、根本不卸载，所以这个问题只在小米的
 * 安装流程里出现；但收尾本身没有副作用，顺手做掉更稳。
 *
 * 走清单注册的接收器：应用可能整体在后台，只靠 Activity 的回调收不到这些广播。
 */
class FoliaReplaceReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action
        if (action != Intent.ACTION_PACKAGE_REPLACED && action != Intent.ACTION_PACKAGE_FULLY_REMOVED) {
            return
        }
        // 只认自己：别的应用被替换/卸载时跟我们无关。
        // 这两个广播的 data 是 "package:<包名>"，比取 EXTRA_REPLACING_PACKAGE 干净
        // （后者在 API 33 之后取法变了，还带类型限制）。
        val target = intent.data?.schemeSpecificPart
        if (target != null && target != context.packageName) {
            return
        }
        Log.i(TAG, "package $action for ${context.packageName}: stopping the services before it is replaced")
        stopAll(context)
    }

    /** 把本应用起的服务都停掉：停服务任何状态下都可用，服务的 onDestroy 会收掉前台状态与通知。 */
    private fun stopAll(context: Context) {
        for (service in arrayOf(
            FoliaPlaybackService::class.java,
            AppleMusicHoldService::class.java,
            FloatingWhaleService::class.java,
        )) {
            try {
                context.stopService(Intent(context, service))
            } catch (error: Exception) {
                Log.w(TAG, "stopping ${service.simpleName} failed", error)
            }
        }
    }

    companion object {
        private const val TAG = "FoliaReplaceReceiver"
    }
}
