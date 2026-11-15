// 桌宠独立窗口的 preload。主窗口用的是 preload.cjs；这里只暴露桌宠窗口需要的窄接口，
// 避免把整个 electron 桥接暴露给一个只显示鲸鱼的窗口。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('whalePetHost', {
    // 主进程转发来的桌宠实例方法
    onInvoke: (callback) => {
        const listener = (_event, data) => callback(data);
        ipcRenderer.on('whale-pet:invoke', listener);
        return () => ipcRenderer.removeListener('whale-pet:invoke', listener);
    },
    ready: () => ipcRenderer.send('whale-pet:ready'),
    // 拖拽：按下时记录窗口起点，移动时上报相对按下点的位移，松手持久化
    dragStart: () => ipcRenderer.send('whale-pet:drag-start'),
    drag: (dx, dy) => ipcRenderer.send('whale-pet:drag', { dx, dy }),
    dragEnd: () => ipcRenderer.send('whale-pet:drag-end'),
    dragAnim: () => ipcRenderer.send('whale-pet:drag-anim'),
});
