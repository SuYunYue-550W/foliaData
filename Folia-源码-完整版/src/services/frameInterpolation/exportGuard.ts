// src/services/frameInterpolation/exportGuard.ts
//
// 导出补帧与 microRender 自适应降帧是**方向相反**的两件事：前者花算力把帧补密，
// 后者主动丢帧省 GPU。补帧真正跑起来时暂停调度器的采样决策，导出结束再恢复。
//
// 只用一个模块级计数器，不走 BroadcastChannel：补帧只在主窗口执行，调度器也按
// document 各自装配，主窗口那一实例读到 true 就够了。参考计数可容忍嵌套/重复调用。

let activeExports = 0;

export const beginFrameInterpolationExport = (): void => {
    activeExports += 1;
};

export const endFrameInterpolationExport = (): void => {
    activeExports = Math.max(0, activeExports - 1);
};

export const isFrameInterpolationExportActive = (): boolean => activeExports > 0;
