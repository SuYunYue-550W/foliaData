// 鲸鱼开屏（Splash）。
//
// 【两种模式，本轮起彻底分开】
//
// A. 浮层模式（Android 悬浮窗）—— 用户要的「同一个鲸鱼」：
//    屏幕上**从头到尾只有浮层窗口这一只鲸鱼**。它以「屏幕中央放大态」建窗并播 initialAnim，
//    这本身就是开屏大鲸鱼。主 WebView **只铺黑幕 + 跳过提示，绝不渲染第二个 <video>**。
//    3 秒后调用接管钩子 → 原生把同一个窗口的 x/y/width/height 连续插值到常驻落点；
//    黑幕在同一时刻开始渐隐，界面随鲸鱼飞行一起浮现。
//    全程零接管、零交叉淡化、零坐标换算：过渡终点就是原生算好的落点，因此不会在结束后
//    「再向下移动一段距离」（旧方案主 WebView video 的 morph 终点按 16:9 魔数换算，与
//    浮层窗口 object-fit:contain 的真实中心差了约 0.22×size，接管时就会跳一下）。
//
// B. 非浮层兜底（桌面 / 无悬浮窗权限）—— 保留原版完整动画：
//    黑幕 + 中央大 <video> 播 3s → CSS transform 缩小飞到应用内桌宠位置 → takeOver 接管。
//
// 跳过：双击屏幕（手机/平板）或连按两下空格（电脑）。跳过同样走过渡，只是立刻开始。
import { WHALE_PET_ANIMS } from './catalog';
import { WHALE_PET_ASSET_BASE, whalePetTargetRect, attachWhaleSplashTakeover } from './init';

const SPLASH_POOL = ['clicks', 'music', 'fun', 'magic', 'special'];

const SPLASH_HOLD_MS = 3000;      // 开屏播放时长
/** 过渡时长：Web 侧黑幕渐隐、原生窗口几何动画、init.ts 的 animateWhaleToRest 三处必须一致。 */
const MORPH_MS = 680;
const BG_DELAY_MS = 120;          // 黑底比窗口起飞晚一点点：先见鲸鱼动，再见界面浮现
const FADE_MS = 220;              // 非浮层：开屏 video 淡出时长
const EASE = 'cubic-bezier(.25,.1,.25,1)';

const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

export interface SplashResult {
    animId: string;
    category: string;
    /** true = 用户跳过 */
    skipped: boolean;
}

export interface SplashAnim { id: string; name: string; nameZh?: string; category: string; }

/** 选一段开屏动画（提前选出，浮层可先预载同一段，过渡时零等待） */
export function pickWhaleSplashAnim(): SplashAnim {
    const pool = WHALE_PET_ANIMS.filter(a => SPLASH_POOL.includes(a.category));
    return pick(pool.length ? pool : WHALE_PET_ANIMS);
}

/** 播放开屏；黑幕移除、过渡完成时 resolve。重复调用幂等（已有 #whale-splash 直接返回 null）。 */
export function playWhaleSplash(
    prePicked?: SplashAnim,
    opts?: { floating?: boolean },
): Promise<SplashResult | null> {
    if (opts?.floating === true) return playFloatingSplash(prePicked);
    return playInlineSplash(prePicked);
}

/** 用户关了桌宠或关了开屏动画 → 无需开屏。 */
function shouldSkipSplash(): boolean {
    try {
        const saved = JSON.parse(localStorage.getItem('whale-pet-settings') || 'null');
        if (saved && (saved.enabled === false || saved.splash === false)) return true;
    } catch { /* 读不到就按开启处理 */ }
    return false;
}

function prefersReducedMotion(): boolean {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

/** 两种模式共用的样式（浮层模式没有 video/halo 元素，相关规则无害）。 */
function installSplashStyle(): void {
    if (document.getElementById('whale-splash-style')) return;
    const style = document.createElement('style');
    style.id = 'whale-splash-style';
    style.textContent = `
#whale-splash{position:fixed;inset:0;z-index:2147483647;background:transparent;overflow:hidden;
  display:flex;align-items:center;justify-content:center;
  transition:opacity ${FADE_MS}ms linear;}
#whale-splash.whale-splash--out{opacity:0;pointer-events:none;}
/* 黑底独立成层：与原生窗口过渡同一条缓动、只晚 ${BG_DELAY_MS}ms 起步、同时结束。 */
#whale-splash .whale-splash-bg{position:absolute;inset:0;background:#000;z-index:0;
  transition:opacity ${MORPH_MS - BG_DELAY_MS}ms ${EASE} ${BG_DELAY_MS}ms;}
#whale-splash.whale-splash--morph .whale-splash-bg{opacity:0;}
#whale-splash video{position:relative;z-index:1;
  width:min(86vmin,540px);aspect-ratio:16/9;object-fit:contain;display:block;}
#whale-splash .whale-splash-halo{position:absolute;z-index:2;left:50%;top:50%;
  width:min(46vmin,300px);height:min(9vmin,60px);transform:translate(-50%,155%);
  border-radius:999px;pointer-events:none;
  background:radial-gradient(ellipse,rgba(110,160,255,.5),rgba(110,160,255,0) 70%);
  filter:blur(4px);animation:whale-splash-halo 1.4s ease-in-out infinite;
  transition:transform ${MORPH_MS}ms ${EASE},opacity ${MORPH_MS * 0.7}ms ease;}
@keyframes whale-splash-halo{0%,100%{opacity:.45;transform:translate(-50%,155%) scaleX(.88);}
  50%{opacity:1;transform:translate(-50%,155%) scaleX(1.1);}}
#whale-splash .whale-splash-skip{position:absolute;z-index:2;bottom:max(24px,env(safe-area-inset-bottom));
  left:0;right:0;text-align:center;color:#4a4f66;font-size:12px;pointer-events:none;
  font-family:system-ui,sans-serif;transition:opacity 200ms ease;}
#whale-splash .whale-splash-skip em{font-style:normal;}
@media (hover:none) and (pointer:coarse){#whale-splash .whale-splash-skip em{display:none;}}
#whale-splash.whale-splash--morph .whale-splash-skip{opacity:0;}
#whale-splash.whale-splash--morph video{transition:transform ${MORPH_MS}ms ${EASE};}
@media (prefers-reduced-motion: reduce){#whale-splash .whale-splash-halo{animation:none;}
  #whale-splash.whale-splash--morph video{transition:none;}
  #whale-splash .whale-splash-bg{transition:none;}}`;
    document.head.appendChild(style);
}

/** 注册双击 / 连按空格跳过。返回一个「要求立刻过渡」的回调绑定器。 */
function bindSkip(overlay: HTMLElement, onSkip: () => void, holdMs: number): void {
    let lastTap = 0;
    const tap = () => {
        const now = Date.now();
        if (now - lastTap < 450) {
            overlay.querySelector('.whale-splash-skip')?.remove();
            onSkip();
        }
        lastTap = now;
    };
    overlay.addEventListener('dblclick', tap);
    overlay.addEventListener('touchend', (e) => {
        const now = Date.now();
        if (now - lastTap < 350) { e.preventDefault(); tap(); }
        lastTap = now;
    }, { passive: false });
    const onKey = (e: KeyboardEvent) => {
        if (e.code !== 'Space' && e.key !== ' ') return;
        const now = Date.now();
        if (now - lastTap < 500) onSkip();
        lastTap = now;
    };
    window.addEventListener('keydown', onKey);
    setTimeout(() => window.removeEventListener('keydown', onKey), holdMs + MORPH_MS + FADE_MS + 600);
}

// ---------------------------------------------------------------- A. 浮层模式：单一鲸鱼

/**
 * 浮层模式开屏：只有黑幕，没有任何 <video>。开屏鲸鱼 = 浮层窗口（它在放大态播放）。
 * 3 秒（或跳过）后触发原生窗口几何过渡，黑幕同步渐隐。
 */
function playFloatingSplash(prePicked?: SplashAnim): Promise<SplashResult | null> {
    return new Promise((resolve) => {
        if (typeof document === 'undefined' || document.getElementById('whale-splash') || shouldSkipSplash()) {
            resolve(null);
            return;
        }
        const reduced = prefersReducedMotion();
        const anim = prePicked ?? pickWhaleSplashAnim();

        const overlay = document.createElement('div');
        overlay.id = 'whale-splash';
        // 刻意不建 video / halo：屏幕上唯一的鲸鱼是浮层窗口，主 WebView 只负责黑幕与跳过提示。
        overlay.innerHTML = `<div class="whale-splash-bg"></div>
            <div class="whale-splash-skip">双击屏幕<em> / 连按两次空格</em> 跳过</div>`;
        document.body.appendChild(overlay);
        installSplashStyle();

        let finished = false;
        let skipped = false;
        let safetyTimer = 0;

        const startTransition = () => {
            if (finished) return;
            finished = true;
            clearTimeout(safetyTimer);

            // ① 黑底按 MORPH_MS 渐隐：与原生窗口过渡同曲线、同起点（晚 120ms）、同终点。
            overlay.classList.add('whale-splash--morph');
            // 黑幕不再吃触摸，避免过渡结束后那几十毫秒挡住 App 操作。
            overlay.style.pointerEvents = 'none';

            // ② 触发原生窗口过渡：同一个鲸鱼从「屏幕中央放大态」连续变换到常驻落点。
            //    浮层分支的接管钩子忽略 target（位置全由原生算），传占位值只为满足类型。
            //    任何异常都要兜底：floating.ts 的 animateWhaleToRest 重试耗尽后会自动 settleNow，
            //    绝不让窗口停在放大态或 NOT_TOUCHABLE。
            try {
                Promise.resolve(attachWhaleSplashTakeover?.({ centerX: 0, top: 0, size: 0 }, anim.id))
                    .catch(() => {});
            } catch { /* 钩子缺失也不能让黑幕残留 */ }

            const dur = reduced ? 60 : MORPH_MS;
            setTimeout(() => {
                overlay.remove();
                resolve({ animId: anim.id, category: anim.category, skipped });
            }, dur + 40);
        };

        // 安全网：即使 IPC / 钩子彻底失效，5s 后黑幕也一定退场。
        safetyTimer = window.setTimeout(startTransition, 5000);
        setTimeout(startTransition, reduced ? 1200 : SPLASH_HOLD_MS);
        bindSkip(overlay, () => { skipped = true; startTransition(); }, reduced ? 1200 : SPLASH_HOLD_MS);
    });
}

// ---------------------------------------------------------------- B. 非浮层：原版完整动画

function playInlineSplash(prePicked?: SplashAnim): Promise<SplashResult | null> {
    return new Promise((resolve) => {
        if (typeof document === 'undefined' || document.getElementById('whale-splash') || shouldSkipSplash()) {
            resolve(null);
            return;
        }
        const reduced = prefersReducedMotion();
        const anim = prePicked ?? pickWhaleSplashAnim();
        const src = `${WHALE_PET_ASSET_BASE}/${anim.category}/${anim.id}.webm`;

        const overlay = document.createElement('div');
        overlay.id = 'whale-splash';
        overlay.innerHTML = `<div class="whale-splash-bg"></div>
            <video muted autoplay loop playsinline src="${src}"></video>
            <div class="whale-splash-halo"></div>
            <div class="whale-splash-skip">双击屏幕<em> / 连按两次空格</em> 跳过</div>`;
        document.body.appendChild(overlay);
        installSplashStyle();

        const video = overlay.querySelector('video') as HTMLVideoElement | null;
        let finished = false;
        let skipped = false;
        let safetyTimer = 0;

        const exitOnce = () => { if (!finished) void morphToPet(); };
        video?.play().catch((err) => {
            console.warn('[whalePet] splash video.play() 被拒绝，走退场兜底', err);
            exitOnce();
        });
        video?.addEventListener('error', () => exitOnce(), { once: true });

        const morphToPet = async () => {
            clearTimeout(safetyTimer);
            if (finished) return;
            finished = true;

            const target = whalePetTargetRect();
            const rect = video!.getBoundingClientRect();
            const scale = target.size / Math.max(rect.width, 1);
            const dx = target.centerX - (rect.left + rect.width / 2);
            const dy = (target.top + target.size * 0.28125) - (rect.top + rect.height / 2);

            overlay.classList.add('whale-splash--morph');
            const halo = overlay.querySelector('.whale-splash-halo') as HTMLElement | null;
            if (halo) {
                halo.style.transformOrigin = '50% 50%';
                halo.style.animation = 'none';
                halo.style.transform = `translate(-50%, 155%) translate(${dx}px, ${dy + (rect.height * (1 - scale)) / 2}px) scale(${scale})`;
                halo.style.opacity = '0';
            }
            video!.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;

            const morphDur = reduced ? 60 : MORPH_MS;
            setTimeout(() => {
                let faded = false;
                const finishFade = () => {
                    if (faded) return;
                    faded = true;
                    overlay.classList.add('whale-splash--out');
                    setTimeout(() => {
                        overlay.remove();
                        resolve({ animId: anim.id, category: anim.category, skipped });
                    }, FADE_MS);
                };
                try {
                    Promise.resolve(attachWhaleSplashTakeover?.(
                        { centerX: target.centerX, top: target.top, size: target.size, time: video?.currentTime },
                        anim.id,
                    )).then(finishFade, finishFade);
                } catch { finishFade(); }
                setTimeout(finishFade, 120);
            }, morphDur);
        };

        safetyTimer = window.setTimeout(() => {
            if (!finished) { console.warn('[whalePet] splash 安全网触发，强制退场'); exitOnce(); }
        }, 5000);

        setTimeout(() => void morphToPet(), reduced ? 1200 : SPLASH_HOLD_MS);
        bindSkip(overlay, () => { skipped = true; void morphToPet(); }, reduced ? 1200 : SPLASH_HOLD_MS);
    });
}
