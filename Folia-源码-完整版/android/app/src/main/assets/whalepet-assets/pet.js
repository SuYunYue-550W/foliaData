/**
 * WhalePet —— 可复用桌宠组件（改自 luweiyabo/dsh-whale-pet 的动画目录与交互思路）
 *
 * 特性：
 *  - 启动动画：每次进入页面从「登场动画池」随机抽一个，次次不同
 *  - 固定悬浮在页面上方（top-center，可拖拽左右移动）
 *  - 事件驱动：宿主应用可调用 pet.react('play_music') 等触发对应动作
 *  - 空闲自主行为：无事件时按概率随机播放日常/趣味/移动动作
 *  - 点击回应 / 双击特殊动作 / 悬停朝向
 *  - 开关状态与位置持久化到 localStorage（供设置页绑定）
 *  - 尊重 prefers-reduced-motion（减弱动态时只保留待机呼吸）
 *
 * 零依赖，纯 JS，可直接 <script> 引入，也可包一层供 React 使用。
 * 动画资源：assets/thumb/<category>/<id>.webm（640×360 透明 VP9，脚底线 y=330）
 */
(function (global) {
  'use strict';

  var CANVAS_W = 640, CANVAS_H = 360, FEET_Y = 330; // 与原目录一致的画布几何

  // 轻量调试日志：默认零输出；localStorage['whalePetDebug']==='1' 时才打 console.debug。
  // 仅用于空 catch 的可观测性，不弹错误、不影响生产行为。
  var petDebug = function (tag, detail) {
    try {
      if (localStorage.getItem('whalePetDebug') !== '1') return;
      var c = global.console;
      (c && c.debug ? c.debug : c.log).call(c, '[whalePet] ' + tag, detail || '');
    } catch (e) { /* 忽略日志本身异常 */ }
  };
  var HIT_BOX = { x0: 200, y0: 50, x1: 440, y1: 335 };

  // 默认事件 → 动作映射（category 表示"从该分类里随机抽"，数组表示指定动作）
  var DEFAULT_EVENT_MAP = {
    boot:        { pool: ['clicks', 'music', 'fun', 'magic', 'special'], once: true, label: '登场' },
    play_music:  { pool: ['music'], label: '播放音乐' },
    pause_music: { pool: ['idle', 'daily'], label: '暂停音乐' },
    next_track:  { pool: ['clicks'], label: '切歌' },
    like:        { pool: ['clicks'], label: '收藏' },
    search:      { pool: ['work'], label: '搜索' },
    download:    { pool: ['moves'], label: '下载' },
    error:       { pool: ['games'], priority: 2, label: '出错' },
    login:       { pool: ['clicks', 'magic'], once: true, label: '登录' },
    idle:        { pool: ['idle', 'daily', 'fun', 'moves'], label: '空闲' },
    drag:        { pool: ['drag'], priority: 3, label: '被拖起来了' },
    drag_end:    { pool: ['clicks'], label: '就放这儿' }
  };

  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  /**
   * 带兜底的 video.play()：rejection 只记 petDebug 日志；
   * 若是 AutoplayPolicy 拒绝（NotAllowedError）且视频未静音，强制 muted 后重试一次。
   * 本组件的 video 本就带 muted 属性，正常情况下重试分支不会走到，仅作防御。
   */
  WhalePet.prototype._safePlay = function (v, tag) {
    return v.play().catch(function (err) {
      petDebug('play-fail:' + tag, err && (err.name || err.message));
      if (err && err.name === 'NotAllowedError' && !v.muted) {
        v.muted = true;
        return v.play().catch(function (e2) { petDebug('play-retry-fail:' + tag, e2 && (e2.name || e2.message)); });
      }
    });
  };

  function WhalePet(options) {
    options = options || {};
    this.assetBase = options.assetBase || 'assets/thumb';
    this.size = options.size || 240;
    this.eventMap = Object.assign({}, DEFAULT_EVENT_MAP, options.eventMap || {});
    this.introHold = options.introHoldSec || 3.2;
    this.initialAnim = options.initialAnim || ''; // 开屏接续：跳过随机登场，直接续播这段
    this.idleMin = options.idleMinMs || 18000; // 空闲行为最小间隔
    this.idleMax = options.idleMaxMs || 35000;
    this.animList = options.animList || [];   // [{id, nameZh, category}]
    this.animById = {};
    this.byCategory = {};
    this._timer = null;
    this._current = null;
    this._currentOneShot = false;
    this._dragging = false;
    this._petEnabled = true;
    // 浮窗内由原生层接管触摸（拖拽/戳一戳）：此时 pet 本体不处理指针事件，需关掉内部交互。
    // 桌面宠物默认 interactive=true，鲸鱼本体可直接点击/拖拽。
    this.interactive = options.interactive !== false;
    // 浮窗不写共享 localStorage（与桌面宠物共用 key 会互相覆盖位置）；桌面宠物默认持久化。
    this.persistence = options.persistence !== false;
    this.onSettle = null;      // 宿主可注入：交互/空闲结束后按播放状态恢复正确动画
    this._settleTimer = null;
    // 漫游状态（屏幕漫游用）
    this._roamRAF = 0;
    this._roamTick = null;
    this._roamTX = null;       // 漫游目标（中心偏移 x / 距顶 y）
    this._roamTY = null;
    this._roamLast = 0;
    this._roamReachedAt = 0;
    this._roamResting = false;
    this._roamPaused = false;  // 反应/拖拽时临时暂停移动
    this._roamResume = 0;
    this._activeMusic = false; // 播放音乐时原地跳舞、不漫游
    this._introSettled = false; // 登场/接管未完成前不漫游，避免登场动画期间乱跑

    var saved = null;
    try { saved = JSON.parse(localStorage.getItem('whale-pet-settings') || 'null'); } catch (e) { petDebug('load-settings', e && e.message); }
    var W = (typeof window !== 'undefined' && window.innerWidth) || 1280;
    var H = (typeof window !== 'undefined' && window.innerHeight) || 720;
    var defX = Math.max(0, W / 2 - this.size / 2 - 12);   // 默认贴屏幕右边（x 为相对居中偏移）
    var defY = Math.max(0, H - this.size * 0.5625 - 12);  // 默认贴屏幕底边
    this.settings = Object.assign(
      { enabled: true, size: this.size, x: defX, y: defY,
        tips: true, idle: true, dragAnim: true, opacity: 1, splash: true,
        beatDance: true, lyricBubble: true, sittingReminder: true, sittingReminderMin: 45,
        roam: false, roamSpeed: 60, duckBehindModal: true },
      saved || {});
    this.settings.homeY = 0;   // 复位位置：页面顶部居中
    if (typeof options.enabled === 'boolean') this.settings.enabled = options.enabled;
    // 允许宿主显式指定初始位置（悬浮窗内鲸鱼由原生定位在窗口左上角，需传 x:0,y:0 居中）。
    if (typeof options.x === 'number') this.settings.x = options.x;
    if (typeof options.y === 'number') this.settings.y = options.y;

    this._buildDom(options.mount);
    this._attachGlobalListeners();
    this._indexAnims();
    this.applySettings(this.settings);
    // 开屏接续模式：先静默预载同一段动画（不上屏、不播光效），
    // 等开屏鲸鱼飞到位后由 takeOver() 瞬间接管 —— 视觉上是同一只鲸鱼落下来
    if (this.initialAnim) {
      var seed = this._resolve(this.initialAnim);
      if (seed) {
        this._current = seed;
        this._preload(seed);
        // 开屏接续：桌宠与开屏同时启动同一段动画 → 天生同步；开屏结束 takeOver 再
        // seek 到开屏时间点（基本一致，无跳变）。桌宠关闭（enabled:false）则只预载不播。
        if (this.settings.enabled) {
          this._currentOneShot = false;
          this._safePlay(this.video, 'intro-continue');
          this._scheduleIdle();
        }
      }
    } else if (this.settings.enabled) {
      this.boot();
    }
    return this;
  }

  WhalePet.prototype._buildDom = function (mount) {
    var root = this.root = document.createElement('div');
    root.className = 'whale-pet';
    // 浮窗模式（原生接管触摸）：pet 本体不处理指针，由原生层做拖拽/戳一戳
    if (!this.interactive) root.classList.add('whale-pet--no-input');
    root.innerHTML =
      '<div class="whale-pet-stage">' +
        '<video class="whale-pet-v whale-pet-v--a" muted autoplay loop playsinline></video>' +
        '<video class="whale-pet-v whale-pet-v--b" muted autoplay loop playsinline></video>' +
      '</div>' +
      '<div class="whale-pet-tip" role="status"></div>';
    (mount || document.body).appendChild(root);

    // 弹窗避让：桌宠所在区域被遮罩/弹窗盖住时自动隐身，弹窗关掉后自己回来。
    // 用几何命中判断（elementFromPoint），不依赖各弹窗的 DOM 特征，样式改版也不会失效。
    //
    // 浮层模式（interactive:false）整段跳过：浮层是独立 WebView，整页只有鲸鱼一个元素，
    // 没有主应用的弹窗可避让，且 TYPE_APPLICATION_OVERLAY 天然置顶不会挡。若照搬，
    // MutationObserver 会在每次切视频 class（is-on）时触发，加上 1.2s 定时器，每次空跑
    // 3 次 elementFromPoint —— 对常驻前台服务是持续无效开销。
    if (this.interactive) {
      var petRef = this;   // 闭包捕获实例：checkModal 作为普通函数被回调时 this 非实例（严格模式下 undefined）
      var checkModal = function () {
        if (!root.isConnected) return;
        var covered = false;
        try {
          var r = root.getBoundingClientRect();
          var pts = [
            [r.left + r.width / 2, r.top + r.height / 2],
            [r.left + r.width / 4, r.top + r.height * 0.7],
            [r.right - r.width / 4, r.top + r.height * 0.7],
          ];
          for (var i = 0; i < pts.length; i++) {
            var el = document.elementFromPoint(pts[i][0], pts[i][1]);
            if (el && el !== root && !root.contains(el)) {
              // 命中的不是桌宠自己 → 看它是不是全屏遮罩层（高度接近视口且带 fixed 定位）
              var box = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
              if (box && box.height >= window.innerHeight * 0.9 && box.width >= window.innerWidth * 0.9) { covered = true; break; }
            }
          }
        } catch (e) { petDebug('check-modal', e && e.message); }
        root.classList.toggle('whale-pet--modal', covered && petRef.settings.duckBehindModal);
      };
      var mo = this._modalObserver = new MutationObserver(function () { checkModal(); });
      mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'aria-hidden'] });
      setTimeout(checkModal, 600);
      this._onWinResize = checkModal;
      window.addEventListener('resize', this._onWinResize);
      // 兜底：有些弹窗靠 transform 显隐，属性监听不到
      this._modalTimer = setInterval(checkModal, 1200);
    }

    this.videoA = root.querySelector('.whale-pet-v--a');
    this.videoB = root.querySelector('.whale-pet-v--b');
    this.video = this.videoA;
    this._usingA = true;
    this.videoA.classList.add('is-on');   // A 默认上屏，播放时再交接给 B
    this.tip = root.querySelector('.whale-pet-tip');
    this.stage = root.querySelector('.whale-pet-stage');

    var style = document.createElement('style');
    style.textContent = [
      '.whale-pet{position:fixed;top:0;left:50%;z-index:2147483646;width:var(--pet-size,240px);',
      '  margin-left:calc(var(--pet-size,240px) / -2);',
      '  height:calc(var(--pet-size,240px) * 0.5625);user-select:none;',
      '  transition:opacity .25s;pointer-events:none;-webkit-tap-highlight-color:transparent;',
      '  touch-action:none;backface-visibility:hidden;cursor:default;}',
      // 只在拖动时提升合成层；常驻 will-change 会让视频在移动时反复重传纹理（残缺/闪烁）
      '.whale-pet.whale-pet--dragging{will-change:transform;}',
      '.whale-pet.whale-pet--hidden{opacity:0!important;pointer-events:none;}',
      // 浮窗内由原生接管触摸：pet 本体完全不接收指针（含鲸鱼本体），避免与原生拖拽/戳一戳打架
      '.whale-pet--no-input,.whale-pet--no-input .whale-pet-stage{pointer-events:none;cursor:default;}',
      '.whale-pet--dragging .whale-pet-stage{cursor:grabbing!important;}',
      '.whale-pet--dragging .whale-pet-stage{transform:scale(1.06);',
      '  filter:drop-shadow(0 12px 26px rgba(80,110,255,.45));}',
      '.whale-pet--dragging .whale-pet-stage{transition:transform .18s ease,filter .18s ease;}',
      '.whale-pet{opacity:var(--pet-opacity,1);}',
      '.whale-pet.whale-pet--no-tip .whale-pet-tip{display:none;}',
      // 弹窗打开时自动隐身，不挡弹窗按钮；关闭后自动回来
      '.whale-pet.whale-pet--modal{opacity:0!important;pointer-events:none;}',
      // 登场：放大聚光 + 地面光圈，缩放原点定在底部中心（角色的脚），落位更自然
      '.whale-pet-stage{transform-origin:50% 92%;transition:transform .7s cubic-bezier(.22,1,.36,1),',
      '  filter .7s ease;will-change:transform;}',
      '.whale-pet--intro .whale-pet-stage{transform:scale(1);',
      '  filter:drop-shadow(0 6px 18px rgba(80,110,255,.5));}',
      '.whale-pet--rise .whale-pet-stage{animation:whale-pet-rise .62s cubic-bezier(.18,1.2,.4,1) both;}',
      '@keyframes whale-pet-rise{0%{transform:scale(.55) translateY(26px);opacity:0;}',
      '  60%{opacity:1;}100%{transform:scale(1) translateY(0);opacity:1;}}',

      // 地面光环
      '.whale-pet--intro::after{content:"";position:absolute;left:50%;bottom:-4%;',
      '  width:96%;height:22px;transform:translateX(-50%);border-radius:999px;',
      '  background:radial-gradient(ellipse,rgba(110,160,255,.85),rgba(110,160,255,.25) 45%,rgba(110,160,255,0) 72%);',
      '  filter:blur(3px);animation:whale-pet-halo 1.4s ease-in-out infinite;}',
      // 身后聚光柱
      '.whale-pet--intro .whale-pet-stage::before{content:"";position:absolute;left:50%;bottom:0;',
      '  width:74%;height:120%;transform:translateX(-50%);pointer-events:none;',
      '  background:radial-gradient(ellipse at 50% 92%,rgba(120,170,255,.28),rgba(120,170,255,0) 66%);',
      '  animation:whale-pet-beam 1.4s ease-in-out infinite;}',
      '@keyframes whale-pet-halo{0%,100%{opacity:.5;transform:translateX(-50%) scaleX(.86);}',
      '  50%{opacity:1;transform:translateX(-50%) scaleX(1.12);}}',
      // 节拍脉冲（鼓点起舞）：stage 短促放大再回位，不与 transform 过渡叠加
      '.whale-pet--pulse{animation:whale-pet-pulse .2s ease-out;}',
      '@keyframes whale-pet-pulse{0%{transform:scale(1);}45%{transform:scale(1.06);}',
      '  100%{transform:scale(1);}}',
      '@keyframes whale-pet-beam{0%,100%{opacity:.55;}50%{opacity:1;}}',
      '@media (prefers-reduced-motion: reduce){.whale-pet--intro .whale-pet-stage{transform:scale(1.25);}',
      '  .whale-pet-stage{transition:none;} .whale-pet--intro::after{animation:none;}',
      '  .whale-pet--pulse{animation:none;}}',
      // 关键：容器 .whale-pet 整体 pointer-events:none（穿透，不挡下层 UI），
      // 仅鲸鱼本体 .whale-pet-stage 设为 auto —— 鲸鱼永远可点击/拖拽，点击空白处照常穿透。
      // 这是 dsh-whale-pet 参考实现的做法（容器穿透 + 本体可交互），比「document 监听 move 再临时切换」稳健，
      // 否则触屏轻点（无前置 move）会收不到 pointerdown，导致桌宠点不动、拖不起。
      '.whale-pet-stage{position:relative;width:100%;height:100%;pointer-events:auto;cursor:grab;}',
      '.whale-pet-v{position:absolute;inset:0;width:100%;height:100%;display:block;',
      '  object-fit:contain;opacity:0;transition:opacity .22s linear;',
      '  transform:translateZ(0);backface-visibility:hidden;}',
      '.whale-pet-v.is-on{opacity:1;}',
      // 漫游朝向同步：向左游动时水平镜像鲸鱼（资源默认朝右），碰边反弹即转向
      '.whale-pet--flip .whale-pet-v{transform:scaleX(-1)!important;}',
      // 快速拖动：去掉放大/滤镜/淡入淡出，画面直给，不糊不顿（必须放在基础规则之后才覆盖得住）
      '.whale-pet--fast-drag .whale-pet-stage{transform:none!important;filter:none!important;transition:none!important;}',
      '.whale-pet--fast-drag .whale-pet-v{transition:none!important;}',
      '.whale-pet-tip{position:absolute;top:78%;left:50%;transform:translateX(-50%);',
      '  background:rgba(20,20,30,.82);color:#fff;font-size:12px;line-height:1;padding:6px 10px;',
      '  border-radius:999px;white-space:nowrap;opacity:0;transition:opacity .2s;pointer-events:none;}',
      '.whale-pet-tip.whale-pet-tip--show{opacity:1;}',
      '@media (prefers-reduced-motion: reduce){.whale-pet{transition:none;}}'
    ].join('');
    document.head.appendChild(style);

    // 拖拽（自由，横纵皆可）+ 点击回应
    // 关键：拖动中只改 transform、只做"夹取到可视区"，不做任何额外定位/过渡，
    // 保证手指（或鼠标）在哪儿鲸鱼就在哪儿；越界时压缩位移（阻尼），不会出现追赶/跳动。
    var startX = 0, startY = 0, startLeft = 0, startTop = 0, moved = false, self = this;
    var dragRaf = 0, pendingX = 0, pendingY = 0, hasPending = false;

    var flushDrag = function () {
      dragRaf = 0;
      if (!hasPending) return;
      hasPending = false;
      self._setPos(pendingX, pendingY, { clampOnly: true });
    };

    root.addEventListener('pointerdown', function (e) {
      if (!self.settings.enabled) return;
      if (e.button !== undefined && e.button > 0) return;   // 只响应主键/单指
      self._dragging = true; moved = false;
      clearTimeout(self._settleTimer);
      startX = e.clientX; startY = e.clientY;
      startLeft = self.settings.x; startTop = self.settings.y;
      root.style.transition = 'none';
    try { self.stage.setPointerCapture(e.pointerId); } catch (err) { petDebug('set-pointer-capture', err && err.message); }
      self.stage.style.cursor = 'grabbing';
      root.classList.add('whale-pet--dragging');
      self._draggingAnim = false;
    });

    root.addEventListener('pointermove', function (e) {
      if (!self._dragging) return;
      var dx = e.clientX - startX, dy = e.clientY - startY;
      if (!moved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
        moved = true;
        if (self.settings.dragAnim) self._playDragAnim();   // 立刻换一次，之后靠 play() 去重
        self._showTip('');           // 拖动中不显示文字气泡
      }
      if (!moved) return;
      pendingX = startLeft + dx;
      pendingY = startTop + dy;
      hasPending = true;
      // 每帧最多写一次 transform：高频 pointermove（120Hz 屏）也不会堆帧
      if (!dragRaf) dragRaf = (window.requestAnimationFrame || setTimeout)(flushDrag);

      // 快速拖动感知（有意为之，非临时方案）：位移速度超过阈值时关掉淡入淡出与放大滤镜。
      // 高速移动时这两者会让画面"糊一下 / 顿一下"；停下 240ms 后自动恢复正常渲染管线。
      // 阈值检测只在 pointermove 里做，每个事件 O(1)，不会引入 resize/重排风暴。
      var now = (window.performance && performance.now) ? performance.now() : Date.now();
      var dt = now - (self._moveTime || now);
      var dist = Math.abs(e.clientX - (self._moveX == null ? e.clientX : self._moveX))
               + Math.abs(e.clientY - (self._moveY == null ? e.clientY : self._moveY));
      self._moveTime = now; self._moveX = e.clientX; self._moveY = e.clientY;
      if (dt > 0 && dist / dt > 0.55 && !self._fastDragging) {   // px/ms ≈ 0.55 → 约 550px/s
        self._fastDragging = true;
        root.classList.add('whale-pet--fast-drag');
      }
      clearTimeout(self._fastTimer);
      self._fastTimer = setTimeout(function () {
        self._fastDragging = false;
        root.classList.remove('whale-pet--fast-drag');
      }, 240);
    });

    var endDrag = function (e, cancelled) {
      if (!self._dragging) return;
      self._dragging = false;
      self._draggingAnim = false;
      hasPending = false;
      if (dragRaf) { (window.cancelAnimationFrame || clearTimeout)(dragRaf); dragRaf = 0; }
      self.stage.style.cursor = 'grab';
      root.classList.remove('whale-pet--dragging');
      root.classList.remove('whale-pet--fast-drag');
      self._fastDragging = false;
      clearTimeout(self._fastTimer);
      try { self.stage.releasePointerCapture(e.pointerId); } catch (err) { petDebug('release-pointer-capture', err && err.message); }
      if (!moved) { self._onClick(e); return; }
      // 松手：原地停住（越界部分带过渡弹回可视区），不回到顶部
      root.style.transition = 'transform .26s cubic-bezier(.34,1.3,.64,1)';
      self._setPos(self.settings.x, self.settings.y);
      setTimeout(function () { if (!self._dragging) root.style.transition = ''; }, 300);
      // 落定：按播放状态恢复跳舞/待机。中间不再插"松开回应"的点击动作 ——
      // 拖着拖着一松手就切到另一个动作，看起来像卡了一下，是"不连贯"的主要来源。
      clearTimeout(self._settleTimer);
      self._settleTimer = setTimeout(function () {
        if (self._dragging) return;
        if (typeof self.onSettle === 'function') self.onSettle();
        else self.play('breathing', { label: '' });
      }, 260);
      self._persist();
    };

    root.addEventListener('pointerup', function (e) { endDrag(e, false); });
    root.addEventListener('pointercancel', function (e) { endDrag(e, true); });
    // 指针被系统抢走（来电、手势导航）时也要复位状态，否则会卡在"拖动中"
    root.addEventListener('lostpointercapture', function (e) {
      if (self._dragging) endDrag(e, true);
    });
    root.addEventListener('dblclick', function () { self._onDblClick(); });
    // pointerenter/leave 不冒泡，必须挂在真正可交互的 stage 上（root 是穿透的）
    self.stage.addEventListener('pointerenter', function () { self._showTip(self._hoverHint() || ''); });
    self.stage.addEventListener('pointerleave', function () { self._showTip(''); });
  };

  WhalePet.prototype._indexAnims = function () {
    var self = this;
    this.animList.forEach(function (a) {
      self.animById[a.id] = a;
      (self.byCategory[a.category] = self.byCategory[a.category] || []).push(a);
    });
    // 兜底：若宿主未传清单，按约定路径懒注册（id 即文件名）
    if (!this.animList.length) {
      ['idle', 'clicks', 'daily', 'work', 'fun', 'moves', 'music', 'magic', 'special', 'turn',
       'games', 'food', 'memes', 'seasonal', 'festivals', 'drag'].forEach(function (c) {
        self.byCategory[c] = [];
      });
    }
  };

  WhalePet.prototype._url = function (anim) {
    if (anim.url) return anim.url; // 宿主直接给定完整地址时优先
    return this.assetBase + '/' + anim.category + '/' + anim.id + '.webm';
  };

  WhalePet.prototype._resolve = function (spec) {
    // spec 可以是具体动作 id，也可以是分类名
    if (this.animById[spec]) return this.animById[spec];
    var pool = this.byCategory[spec] || [];
    if (pool.length) return pick(pool);
    if (!this.animList.length) return { id: spec, category: 'idle' }; // 懒路径兜底
    return null;
  };

  /**
   * 交叉淡入播放：两块 video 交替上屏，新动画解码出首帧后再淡入，
   * 旧动画淡出后暂停 —— 换动作时不会闪黑。
   */
  /** 静默预载：把动画装进当前视频但不显示（开屏过渡前用） */
  WhalePet.prototype._preload = function (anim) {
    var v = this.video;
    v.muted = true;
    v.src = this._url(anim);
    try { v.load(); } catch (e) { petDebug('preload-load', e && e.message); }
  };

  /**
   * 开屏鲸鱼飞到位后接管：把桌宠瞬间摆到 target 位置与尺寸，
   * 并把当前视频切到开屏那段动画的相同进度，再淡出黑幕。
   * 这样"开屏的鲸鱼"就是"落到主页的鲸鱼"，中间不会跳一下。
   */
  WhalePet.prototype.takeOver = function (target, animId) {
    if (!target) return;
    // 开屏期间桌宠可能被隐藏（enabled:false）：接管时先显示，再续播同一段动画，
    // 避免「先 applySettings(enabled:true) 触发 boot 从 0 重播」与 takeOver 抢视频导致过渡跳变。
    if (!this.settings.enabled) {
      this.settings.enabled = true;
      try { this.root.classList.remove('whale-pet--hidden'); } catch (e) {}
    }
    this._introSettled = true; // 开屏已接管，无登场动画待结算，允许后续漫游
    var anim = (animId && this._resolve(animId)) || this._current;

    // 浮层模式（interactive=false）：开屏那只鲸鱼就是本窗口自身，屏幕上只有一个渲染源。
    // 开屏时窗口以放大态播 initialAnim，随后由原生 ValueAnimator 连续改变窗口 x/y/width/height
    // 飞到常驻落点 —— 全程没有接管、没有第二个 video、没有视频进度对齐。
    // 这里**什么都不能做**：切换视频层（classList add/remove）、_safePlay、seek 都会让画面
    // 闪一帧。直接 return，让本来就在播的那段动画原封不动地续下去。
    if (!this.interactive) {
      this._introSettled = true;
      this.initialAnim = null;   // 清除接续标记：后续 enable 切回走正常 boot
      return;
    }

    this.settings.size = target.size;
    this.root.style.setProperty('--pet-size', target.size + 'px');
    this.settings.x = Math.max(-window.innerWidth / 2, Math.min(window.innerWidth / 2, (target.centerX || window.innerWidth / 2) - window.innerWidth / 2));
    this.settings.y = Math.max(0, target.top || 0);
    this.root.classList.remove('whale-pet--intro', 'whale-pet--rise');
    try { window.__whaleSplashTookOver = true; } catch (e) { petDebug('splash-flag', e && e.message); }
    this.root.style.transition = 'none';
    this._setPos(this.settings.x, this.settings.y);
    this._persist();

    if (!anim) return;
    this._current = anim;
    this._currentOneShot = false;
    var v = this.video;
    var self = this;
    var swapped = false;
    var start = function () {
      if (swapped) return;
      swapped = true;
      v.classList.add('is-on');
      (self._usingA ? self.videoB : self.videoA).classList.remove('is-on');
      self._safePlay(v, 'takeover');
      // 接续：若时间点大体一致就不打断循环，让动作继续走
      if (typeof target.time === 'number' && isFinite(target.time) && Math.abs(v.currentTime - target.time) > 0.35) {
        try { v.currentTime = target.time; } catch (e) { petDebug('seek-takeover', e && e.message); }
      }
      self._scheduleIdle();
    };
    if (v.readyState >= 2 && v.getAttribute('src') === this._url(anim)) start();
    else {
      v.addEventListener('loadeddata', start, { once: true });
      setTimeout(start, 220);   // 兜底：解码稍慢也要准时上屏
    }
  };


  WhalePet.prototype.play = function (spec, opts) {
    if (!this.settings.enabled) return;
    var anim = this._resolve(spec);
    if (!anim) return;
    opts = opts || {};
    var self = this;
    var url = this._url(anim);
    this._current = anim;
    this._currentOneShot = !!opts.once;

    // 同一个动作正在播（循环动作的重复触发）：绝不重设 src ——
    // 重设会让解码器清零、画面跳回首帧，快速拖动时就是"卡一下/顿一下"。
    if (this.video && this.video.getAttribute('src') === url && !this.video.paused) {
      this._showTip(opts.label || anim.nameZh || anim.id);
      // 一次性动作去重时也要确保不循环（可能上一轮已 loop=false，但这里稳妥起见再置一次）
      if (opts.once) { this.video.loop = false; this._armOneShot(opts); }
      return;
    }

    var next = this._usingA ? this.videoB : this.videoA;
    var prev = this._usingA ? this.videoA : this.videoB;
    this._usingA = !this._usingA;
    this.video = next;
    this._showTip(opts.label || anim.nameZh || anim.id);
    if (opts.once) this._armOneShot(opts);

    // 已经装好这条片源（另一块 video 里还是它）：直接接着播，避免二次解码
    if (next.getAttribute('src') === url && next.readyState >= 2) {
      next.currentTime = 0;
      var restart = function () {
        next.classList.add('is-on');
        prev.classList.remove('is-on');
        self._retire(prev);
      };
      self._safePlay(next, 'reuse').then(restart).catch(function () { next.addEventListener('playing', restart, { once: true }); });
      return;
    }

    var swapped = false;
    var swap = function () {
      if (swapped) return;
      swapped = true;
      next.classList.add('is-on');
      prev.classList.remove('is-on');
      // 旧视频等淡出真正结束（220ms）再收：早停会让它在淡出末段露出静帧
      self._retire(prev);
    };
    // 首帧就换：loadeddata 说明已有画面可画，比 canplay 更快也更可靠
    next.addEventListener('loadeddata', swap, { once: true });
    next.addEventListener('playing', swap, { once: true });
    // 一次性动作不循环：播完自动结束，回到待机（见 ended 收尾）；环境动画照常循环。
    next.loop = !opts.once;
    if (opts.once) {
      var onEnded = function () {
        next.removeEventListener('ended', onEnded);
        if (self._currentOneShot && self.video === next) {
          self._currentOneShot = false;
          clearTimeout(self._timer);
          // 回到自然待机：有宿主接管（如随音乐起舞）时交给宿主，否则原地呼吸
          if (typeof self.onSettle === 'function') self.onSettle();
          else self.play('breathing', { label: '' });
        }
      };
      next.addEventListener('ended', onEnded, { once: true });
    }
    next.src = url;
    next.load();
    self._safePlay(next, 'swap');
    // 兜底：任何情况下 400ms 内都要上屏，避免一直停在黑帧/空白
    setTimeout(swap, 400);
  };

  /**
   * 收掉已经淡出的那块 video：先彻底移出绘制、再暂停。
   * 顺序很关键 —— 还在淡出的那一刻就 pause()，浏览器会画出这张静帧，
   * 快速拖动时看到的"突然僵住 / 像暂停"就是这个。
   * 同时清掉 src：双缓冲只留当前这一段，切换时不用重新解码整段动画。
   */
  WhalePet.prototype._retire = function (el) {
    if (!el || el === this.video) return;
    var self = this;
    clearTimeout(el._retireTimer);
    el._retireTimer = setTimeout(function () {
      if (el === self.video) return;
      el.classList.remove('is-on');
      if (!el.paused) { try { el.pause(); } catch (e) { petDebug('retire-pause', e && e.message); } }
      el.removeAttribute('src');
      try { el.load(); } catch (e) { petDebug('retire-load', e && e.message); }
    }, 300);
  };

  /** 一次性动作的兜底计时（与换动作解耦，避免被复用路径跳过） */
  WhalePet.prototype._armOneShot = function (opts) {
    var self = this;
    clearTimeout(this._timer);
    if (!opts.once) return;
    this._timer = setTimeout(function () {
      // 已被 ended 收尾（_currentOneShot 已复位）则不重复触发，避免回到待机后又被强行打断
      if (!self._currentOneShot) return;
      self._idleChain();
    }, opts.holdMs || 10000);
  };

  /**
   * 拖动时的反馈动作。
   * 用 dragged_in_midair：动作本身幅度很小（几乎就是被拎着悬空晃），
   * 拖动时"不动"是对的 —— 画面稳定比动作丰富更重要，乱换动作反而像卡顿。
   */
  WhalePet.prototype._playDragAnim = function () {
    var rule = this.eventMap.drag || {};
    var spec = this.animById['dragged_in_midair'] ? 'dragged_in_midair' : 'drag';
    this.play(spec, { label: rule.label || '' });
  };

  /** 用户/系统是否要求减弱动态 */
  WhalePet.prototype.isReducedMotion = function () {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) { return false; }
  };

  /** 事件入口：pet.react('play_music') / pet.react('like') */
  WhalePet.prototype.react = function (event) {
    // 漫游协同：播放音乐时原地跳舞不漫游；其它一次性反应时短暂暂停移动，反应结束自动恢复
    if (event === 'play_music') this._activeMusic = true;
    else if (event === 'pause_music' || event === 'idle') this._activeMusic = false;
    else {
      this._roamPaused = true;
      var selfR = this;
      clearTimeout(this._roamResume);
      this._roamResume = setTimeout(function () { selfR._roamPaused = false; }, 2600);
    }
    var rule = this.eventMap[event];
    if (!rule) return;
    var reduced = this.isReducedMotion();
    if (reduced) { this.play('breathing', { label: rule.label }); return; }
    var spec = pick(rule.pool || ['idle']);
    this.play(spec, { once: !!rule.once, label: rule.label });
  };

  /**
   * 启动序列（对齐参考视频）：
   *   1) 随机抽一个登场动作，在"上次放置的位置"（默认页面顶部居中）闪亮登场：
   *      从 0.55 倍 / 下移 26px / 全透明弹到 1 倍，脚下地面光环 + 身后聚光柱脉动
   *   2) 这段动作播约 3 秒（10 秒动画不等满），期间不抢播其它动作
   *   3) 收起光效，尺寸不变，直接切待机呼吸 —— 就是"现在这个位置的鲸鱼正常状态"
   */
  WhalePet.prototype.boot = function () {
    if (!this.settings.enabled) return;
    var self = this;
    var rule = this.eventMap.boot || { pool: ['clicks'] };
    // 开屏接续：直接播开屏那段动画（视觉连续），其余照常随机
    var anim = this.initialAnim ? this._resolve(this.initialAnim) : this._resolve(pick(rule.pool || ['clicks']));
    if (!anim) return;

    // 1) 登场：停在用户上次放置的位置（没有则页面顶部居中）
    //    减弱动效时只去掉弹跳和光效，"登场动作"本身照常播放（不影响随机登场）
    var reduced = this.isReducedMotion() || !!this.initialAnim;  // 接续模式下不再弹跳（开屏已过渡）
    this._introSettled = false;
    this.root.style.transition = 'none';
    this.root.classList.toggle('whale-pet--intro', !reduced);
    this._setPos(this.settings.x, this.settings.y);
    if (!reduced) {
      void this.root.offsetWidth;
      this.root.classList.add('whale-pet--rise');
      var riseStage = this.root.querySelector('.whale-pet-stage');
      var clearRise = function () { self.root.classList.remove('whale-pet--rise'); };
      if (riseStage) riseStage.addEventListener('animationend', clearRise, { once: true });
      setTimeout(clearRise, 900);
    }
    this._introStart = Date.now();
    this._current = anim;
    this._currentOneShot = true;
    this.video.src = this._url(anim);
    this._safePlay(this.video, 'boot');
    this._showTip(anim.nameZh || anim.id);

    clearTimeout(this._timer);
    // 2) 播完这段登场动作的"高潮"（约 3 秒 / 短动画则整段）再落位，不必等满 10 秒
    var finish = function () {
      var dur = isFinite(self.video.duration) && self.video.duration > 0 ? self.video.duration : 10;
      var hold = Math.min(dur, self.introHold) * 1000;
      self._timer = setTimeout(function () { self._settleIntro(); }, Math.max(hold, 1800));
    };
    if (this.video.readyState >= 1) finish();
    else this.video.addEventListener('loadedmetadata', finish, { once: true });
    // 兜底：元数据迟迟不来也不卡住
    this._introGuard = setTimeout(function () {
      if (self.root.classList.contains('whale-pet--intro')) self._settleIntro();
    }, 12000);
  };

  /** 3) 从聚光尺寸落位到正常桌宠 */
  WhalePet.prototype._settleIntro = function () {
    clearTimeout(this._introGuard);
    var self = this;
    if (this._introSettled) return;      // 只结算一次
    this._introSettled = true;
    // 登场结束后只收光效，尺寸保持 1 —— 不再做大→小的缩放跳动
    this.root.classList.remove('whale-pet--intro');
    this.root.classList.remove('whale-pet--rise');
    // 等过渡结束 → 待机
    var done = function () {
      if (typeof self.onSettle === 'function') self.onSettle();
      else self.play('breathing', { label: '' });
      self._scheduleIdle();
    };
    this._timer = setTimeout(done, 760);
  };

  /** 空闲自主行为链 */
  WhalePet.prototype._idleChain = function () {
    if (!this.settings.enabled || !this.settings.idle) return;
    // 空闲动作要"看场景"：音乐在放就继续跳舞，否则才播日常/待机
    if (typeof this.onSettle === 'function') this.onSettle();
    else this.react('idle');
    this._scheduleIdle();
    this._startRoam();   // 空闲自主：启动/接管屏幕漫游（已在跑则幂等返回）
  };

  WhalePet.prototype._scheduleIdle = function () {
    var self = this;
    clearTimeout(this._timer);
    this._timer = setTimeout(function () { self._idleChain(); },
      this.idleMin + Math.random() * (this.idleMax - this.idleMin));
  };

  /**
   * 屏幕漫游（融合参考项目 dsh-whale-pet 的「屏幕漫游 / 边界反弹 / 朝向同步」）：
   * 空闲时随机选屏内目标点平滑游走，触边反弹转向，游动方向水平镜像鲸鱼使其面朝前进方向。
   * 不另跑计时器：一个 rAF 循环自管；稳态闸门（关/减弱动效/空闲关）直接停循环，
   * 瞬时闸门（拖拽/反应/播放音乐/弹窗遮挡）则跳过位移、保持循环以便自动恢复。
   */
  WhalePet.prototype._pickRoamTarget = function () {
    var b = this._bounds();
    this._roamTX = (Math.random() * 2 - 1) * b.maxX; // 横向：居中偏移，可达左右贴边
    this._roamTY = Math.random() * b.maxY;            // 纵向：距顶，可达上下边
  };

  /** 行走动画池：用 moves 类里"真在走"的两段，排除原地摔倒/预备 */
  WhalePet.prototype._roamMovePool = function () {
    return (this.byCategory['moves'] || []).filter(function (a) {
      return a.id !== 'running_trip' && a.id !== 'target_point_run';
    });
  };

  /** 启动漫游循环（幂等：已在跑则直接返回） */
  WhalePet.prototype._startRoam = function () {
    if (!this.settings.enabled || !this.settings.roam || !this.settings.idle || this.isReducedMotion()) return;
    // 浮层模式（interactive:false）：漫游由桌面端主进程的置顶窗口负责
    // （electron/whalePetWindow.cjs 的 startRoam() 按 workArea 夹取坐标后 setBounds 移动窗口）。
    // 这里再用 CSS transform 在固定尺寸 WebView 里移动 DOM，只会和主进程双份循环抢同一个窗口，
    // 所以这一侧只保留原地动画 —— 浮层漫游本身已经实装，不是待补功能。
    if (!this.interactive) return;
    if (this._roamRAF) return;
    if (typeof this._roamTX !== 'number') this._pickRoamTarget();
    if (!this._activeMusic && !this._roamPaused) {
      var pool = this._roamMovePool();
      if (pool.length) this.play(pick(pool).id, { label: '' });
    }
    var self = this;
    this._roamLast = (window.performance && performance.now) ? performance.now() : Date.now();
    this._roamTick = function (now) { self._roamFrame(now); };
    this._roamRAF = requestAnimationFrame(this._roamTick);
  };

  /** 停止漫游并复位临时状态 */
  WhalePet.prototype._stopRoam = function () {
    if (this._roamRAF) {
      try { (window.cancelAnimationFrame || clearTimeout)(this._roamRAF); } catch (e) { petDebug('stop-roam', e && e.message); }
      this._roamRAF = 0;
    }
    this.root.classList.remove('whale-pet--flip');
    this._roamResting = false;
    this._roamReachedAt = 0;
  };

  /** 漫游逐帧：dt 限幅避免后台标签页回切时的"瞬移" */
  WhalePet.prototype._roamFrame = function (now) {
    if (!this._roamRAF) return;
    // 稳态闸门：关闭/减弱动效/空闲关 → 停循环（这些是有意的长态，不必空转）
    if (!this.settings.roam || !this.settings.idle || !this.settings.enabled || this.isReducedMotion()) {
      this._stopRoam(); return;
    }
    var dt = Math.min(48, now - this._roamLast); this._roamLast = now;
    // 瞬时闸门：拖拽 / 反应暂停 / 播放音乐 / 被弹窗遮住（且开启 duck）→ 不位移，但保留循环以便自动恢复
    var transient = this._dragging || this._roamPaused || this._activeMusic || !this._introSettled ||
      (this.settings.duckBehindModal && this.root.classList.contains('whale-pet--modal'));
    if (!transient && typeof this._roamTX === 'number') {
      var cx = this.settings.x, cy = this.settings.y;
      var dx = this._roamTX - cx, dy = this._roamTY - cy;
      var dist = Math.sqrt(dx * dx + dy * dy);
      var pxPerMs = (this.settings.roamSpeed || 60) / 100 * 0.12; // 60 → ~0.072px/ms ≈ 72px/s
      var step = pxPerMs * dt;
      if (dist <= step || dist < 0.5) {
        // 到达：原地歇一会儿（呼吸），到点再选下一处并换行走动画
        if (!this._roamResting) { this._roamResting = true; this.play('breathing', { label: '' }); }
        if (this._roamReachedAt === 0) this._roamReachedAt = now;
        if (now - this._roamReachedAt > 1100) {
          this._roamResting = false; this._roamReachedAt = 0; this._pickRoamTarget();
          var pool = this._roamMovePool();
          if (pool.length) this.play(pick(pool).id, { label: '' });
        }
      } else {
        var nx = cx + dx / dist * step, ny = cy + dy / dist * step;
        this.root.classList.toggle('whale-pet--flip', dx < 0); // 向左游 → 镜像，碰边反弹后自动转向
        this._setPos(nx, ny);
      }
    }
    var self = this;
    this._roamRAF = requestAnimationFrame(this._roamTick);
  };

  WhalePet.prototype._onClick = function (e) {
    // 命中人物区域才回应（按缩放比换算 HIT_BOX）
    var rect = this.root.getBoundingClientRect();
    var scale = rect.width / CANVAS_W;
    var x = (e.clientX - rect.left) / scale, y = (e.clientY - rect.top) / scale;
    if (x < HIT_BOX.x0 || x > HIT_BOX.x1 || y < HIT_BOX.y0 || y > HIT_BOX.y1) return;
    var pool = this.byCategory['clicks'] || [];
    if (pool.length) this.play(pick(pool), { once: true });
  };

  WhalePet.prototype._onDblClick = function () {
    var pool = this.byCategory['special'] && this.byCategory['special'].length
      ? this.byCategory['special']
      : (this.byCategory['magic'] || []);
    if (pool.length) this.play(pick(pool), { once: true, label: '双击彩蛋！' });
  };

  /**
   * 戳一戳：播放一个俏皮回应。悬浮窗原生层在「轻点」时调用（见 FloatingWhaleService.poke）；
   * 桌面宠物也可被宿主代码直接调用。优先用 eventMap.poke（若存在），否则回退到 clicks 池。
   */
  WhalePet.prototype.poke = function () {
    if (!this.settings.enabled) return;
    var rule = (this.eventMap && this.eventMap.poke) || { pool: ['clicks'], label: '戳一下' };
    // 快速连戳：当前已在播「戳一下」反应就只刷新提示，不再切视频缓冲 ——
    // 否则每次戳都重新换片源，双缓冲切换的瞬间会露出一帧空白（闪一下播放按钮）。
    if (this._current && this._current.category === 'clicks' && !this.video.paused) {
      this._showTip(rule.label || '戳一下');
      return;
    }
    var spec = pick(rule.pool || ['clicks']);
    this.play(spec, { once: true, label: rule.label || '戳一下' });
  };

  WhalePet.prototype._hoverHint = function () {
    return '点我回应 · 双击彩蛋 · 拖动可随手摆放';
  };

  WhalePet.prototype._showTip = function (text) {
    var tip = this.tip;
    if (!text || !this.settings.tips) { tip.classList.remove('whale-pet-tip--show'); return; }
    tip.textContent = text;
    tip.classList.add('whale-pet-tip--show');
    clearTimeout(this._tipTimer);
    var self = this;
    this._tipTimer = setTimeout(function () { tip.classList.remove('whale-pet-tip--show'); }, 2200);
  };

  /** 对外气泡接口：歌词气泡 / 久坐提醒等联动从这里说话（内部走 _showTip，遵守 tips 开关） */
  WhalePet.prototype.showTip = function (text) {
    this._showTip(text);
  };

  /**
   * 节拍脉冲：stage 轻微 scale 蹦一下（约 200ms），不打断当前动画。
   * 鼓点起舞联动每拍调用；减弱动效时直接跳过。
   */
  WhalePet.prototype.pulse = function () {
    if (!this.settings.enabled || this.isReducedMotion()) return;
    var stage = this.root && this.root.querySelector('.whale-pet-stage');
    if (!stage) return;
    clearTimeout(this._pulseTimer);
    stage.classList.remove('whale-pet--pulse');
    void stage.offsetWidth;   // 重启动画
    stage.classList.add('whale-pet--pulse');
    var self = this;
    this._pulseTimer = setTimeout(function () { stage.classList.remove('whale-pet--pulse'); }, 240);
  };

  /** 当前可活动边界（夹取用）：留极小边距，鲸鱼可贴边、可到四角，范围最大化 */
  WhalePet.prototype._bounds = function () {
    var w = this.settings.size;
    var h = w * 0.5625;
    // 全屏任意放置：鲸鱼中心可抵达屏幕每个边角；同时始终保留 GRAB 像素在屏内，
    // 这样即便把鲸鱼拖到几乎完全出屏，也还能再抓回来（不会彻底丢失）。
    var GRAB = Math.max(40, Math.round(w * 0.18));
    return {
      maxX: window.innerWidth / 2 + w / 2 - GRAB,   // 左右：最多仅留 GRAB 像素在屏内
      maxY: window.innerHeight - GRAB,               // 向下：底部最多留 GRAB 像素
      overY: h - GRAB                               // 向上：顶部最多留 GRAB 像素
    };
  };

  /** 自由定位：x 为相对居中的偏移，y 为距视口顶部的距离；clampOnly 仅供拖动中使用 */
  WhalePet.prototype._setPos = function (x, y, opts) {
    // 浮层模式（interactive:false）：位置完全由原生 WindowManager 窗口 + 100vw/100vh 铺满控制，
    // pet 内部绝不写 transform。否则 resetPos/applySettings 会把鲸鱼在窗口内平移（如 homeY），
    // 超出窗口边界被裁切 —— 表现为「调大尺寸 / 复位后只显示一部分」。
    if (!this.interactive) return;
    var b = this._bounds();
    var nx = Math.max(-b.maxX, Math.min(b.maxX, x));
    var ny = Math.max(-b.overY, Math.min(b.maxY, y));
    this.settings.x = nx;
    this.settings.y = ny;
    this.root.style.transform = 'translate3d(' + nx + 'px,' + ny + 'px,0)';
  };

  // 页面切到后台（切标签/锁屏）时暂停视频省电，回来接着播当前动画
  // 视口变化（旋转屏幕 / 缩放窗口）时把桌宠夹回可视范围，避免留在屏幕外
  // 两类监听按实例注册并记录引用，destroy() 时一并注销，避免泄漏。
  WhalePet.prototype._attachGlobalListeners = function () {
    var self = this;
    if (this._onVisibility) return;   // 已注册过，防重复
    this._onVisibility = function () {
      if (!self.settings || !self.settings.enabled) return;
      if (document.hidden) {
        try { self.video.pause(); } catch (e) { petDebug('pause-hidden', e && e.message); }
      } else {
        self._safePlay(self.video, 'resume');
      }
    };
    this._onGlobalResize = function () {
      if (self.settings) self._setPos(self.settings.x, self.settings.y);
    };
    document.addEventListener('visibilitychange', this._onVisibility);
    window.addEventListener('resize', this._onGlobalResize);
  };

  /**
   * 点击穿透由 CSS 实现：容器 .whale-pet 整体 pointer-events:none，仅鲸鱼本体
   * .whale-pet-stage 为 auto（见 _buildDom 注入的样式）。因此鲸鱼永远可点击/拖拽，
   * 而空白处照常穿透到下层 UI —— 无需在 document 上监听 move 临时切换，触屏轻点也能命中。
   */

  /** 兼容旧接口 */
  WhalePet.prototype._setX = function (x) {
    this._setPos(x, this.settings.y);
    this._persist();
  };

  /** 设置页入口：开关 / 尺寸 */
  WhalePet.prototype.applySettings = function (s) {
    var self = this;
    if (typeof s.enabled === 'boolean') this.settings.enabled = s.enabled;
    if (typeof s.size === 'number') this.settings.size = s.size;
    // 可选项：提示气泡 / 空闲自主行为 / 拖动时换动作 / 透明度
    if (typeof s.tips === 'boolean') this.settings.tips = s.tips;
    if (typeof s.idle === 'boolean') this.settings.idle = s.idle;
    if (typeof s.dragAnim === 'boolean') this.settings.dragAnim = s.dragAnim;
    if (typeof s.opacity === 'number') this.settings.opacity = s.opacity;
    if (typeof s.splash === 'boolean') this.settings.splash = s.splash;
    // 联动扩展（鼓点起舞 / 歌词气泡 / 久坐提醒）：只存值，行为由 init.ts 的 linkage 驱动
    if (typeof s.beatDance === 'boolean') this.settings.beatDance = s.beatDance;
    if (typeof s.lyricBubble === 'boolean') this.settings.lyricBubble = s.lyricBubble;
    if (typeof s.sittingReminder === 'boolean') this.settings.sittingReminder = s.sittingReminder;
    if (typeof s.sittingReminderMin === 'number') this.settings.sittingReminderMin = s.sittingReminderMin;
    // 漫游 / 置顶相关
    if (typeof s.roam === 'boolean') this.settings.roam = s.roam;
    if (typeof s.roamSpeed === 'number') this.settings.roamSpeed = s.roamSpeed;
    if (typeof s.duckBehindModal === 'boolean') this.settings.duckBehindModal = s.duckBehindModal;

    this.root.style.setProperty('--pet-size', this.settings.size + 'px');
    this.root.style.setProperty('--pet-opacity', String(this.settings.opacity));
    this.root.classList.toggle('whale-pet--hidden', !this.settings.enabled);
    this.root.classList.toggle('whale-pet--no-tip', !this.settings.tips);
    if (!this.settings.enabled) {
      clearTimeout(this._timer);
      this.video.pause();
      this.video.removeAttribute('src');
    } else if (!this._current || this.video.paused) {
      // 开屏接续模式（initialAnim 已设置）：播放交给 takeOver，这里不 boot，
      // 否则会从 0 重播并与 takeOver 的 seek 抢视频，开屏过渡出现跳变。
      if (!this.initialAnim) this.boot();
    }
    // 关掉空闲行为后立刻取消已排队的空闲动作
    if (!this.settings.idle) clearTimeout(this._timer);
    else if (this._current && !this.video.paused && !this._timer) this._scheduleIdle();
    // 置顶：关闭 duckBehindModal 时永远显示在最上层（不随弹窗隐身）
    if (!this.settings.duckBehindModal) this.root.classList.remove('whale-pet--modal');
    // 漫游：满足条件即启动，否则停掉循环
    if (this.settings.roam && this.settings.idle && !this.isReducedMotion()) this._startRoam();
    else this._stopRoam();
    this._setPos(this.settings.x, this.settings.y);
    this._persist();
    void self;
  };
  /** 把桌宠送回页面上方中央（拖动后双击标题栏或设置里"复位"用） */
  WhalePet.prototype.resetPos = function () {
    this.root.style.transition = 'transform .32s cubic-bezier(.34,1.4,.64,1)';
    this.root.classList.remove('whale-pet--rise');
    this._setPos(0, this.settings.homeY);
    // 复位动画期间暂停漫游，避免循环覆盖 transform 过渡；结束时自动恢复
    var selfR = this;
    this._roamPaused = true;
    clearTimeout(this._roamResume);
    this._roamResume = setTimeout(function () { selfR._roamPaused = false; }, 460);
    this._persist();
  };

  WhalePet.prototype._persist = function () {
    // 浮窗模式（persistence:false）不写共享 localStorage，避免覆盖桌面宠物保存的位置
    if (!this.persistence) return;
    try {
      localStorage.setItem('whale-pet-settings',
        JSON.stringify({
          enabled: this.settings.enabled, size: this.settings.size, x: this.settings.x, y: this.settings.y,
          tips: this.settings.tips, idle: this.settings.idle, dragAnim: this.settings.dragAnim,
          opacity: this.settings.opacity, splash: this.settings.splash,
          beatDance: this.settings.beatDance, lyricBubble: this.settings.lyricBubble,
          sittingReminder: this.settings.sittingReminder, sittingReminderMin: this.settings.sittingReminderMin }));
    } catch (e) { petDebug('persist', e && e.message); }
  };

  /** 卸载：清定时器/监听器/Observer、停视频、移除节点（React effect cleanup 用）。销毁后可重新 new / ensureWhalePet */
  WhalePet.prototype.destroy = function () {
    clearTimeout(this._timer);
    clearTimeout(this._tipTimer);
    clearTimeout(this._fastTimer);
    clearTimeout(this._settleTimer);
    clearTimeout(this._introGuard);
    clearTimeout(this._pulseTimer);
    clearTimeout(this._roamResume);
    if (this._roamRAF) { try { (window.cancelAnimationFrame || clearTimeout)(this._roamRAF); } catch (e) { petDebug('destroy-roam', e && e.message); } this._roamRAF = 0; }
    clearInterval(this._modalTimer);
    if (this._modalObserver) { try { this._modalObserver.disconnect(); } catch (e) { petDebug('observer-disconnect', e && e.message); } }
    if (this._onWinResize) window.removeEventListener('resize', this._onWinResize);
    if (this._onVisibility) document.removeEventListener('visibilitychange', this._onVisibility);
    if (this._onGlobalResize) window.removeEventListener('resize', this._onGlobalResize);
    this._onVisibility = this._onGlobalResize = this._onWinResize = null;
    this._modalObserver = null;
    this._modalTimer = 0;
    try { this.video.pause(); } catch (e) { petDebug('destroy-pause', e && e.message); }
    this.video.removeAttribute('src');
    if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
    // 清掉宿主引用，让 ensureWhalePet 的幂等挡板放行，支持销毁后重建
    try { if (global.__whalePet === this) global.__whalePet = null; } catch (e) { petDebug('destroy-clear-ref', e && e.message); }
  };

  global.WhalePet = WhalePet;
})(window);
