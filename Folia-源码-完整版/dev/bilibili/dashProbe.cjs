// dev/bilibili/dashProbe.cjs
// 路线 A（B站 DASH 自研拉流）的端到端验证：在一个 Electron 窗口里加载一条 DASH 视频流，
// 读出 <video> 解出来的画面尺寸与播放进度，并截一张图。
//
// 用法：
//   node_modules/electron/dist/electron.exe dev/bilibili/dashProbe.cjs <videoUrl> [outPng]
//
// 传 http(s) 的地址时脚本会像 electron/bilibili/mediaPolicy.cjs 那样注入 Referer
// （B站防盗链：无 Referer 是 403）。传本地文件服务地址则不需要。
//
// 已知：本机沙箱会掐断到 bilivideo CDN 的长连接，直连公网地址可能进程被杀；
// 那种情况下先把流用 curl（带 Referer）下到本地，再用本地文件服务喂进来。
const electron = require('electron');
const path = require('path');
const fs = require('fs');

const videoUrl = process.argv[2];
const outPng = process.argv[3] || path.join(__dirname, 'dashProbe.png');
if (!videoUrl) { console.error('usage: dashProbe.cjs <videoUrl> [outPng]'); process.exit(2); }

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

electron.app.disableHardwareAcceleration();
electron.app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
electron.app.whenReady().then(async () => {
  const { app, BrowserWindow, session } = electron;
  // 防盗链：B站要 Referer 在 bilibili.com 域下，否则 403。这与 electron/bilibili/mediaPolicy.cjs 同款。
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details.requestHeaders || {};
    headers.Referer = ['https://www.bilibili.com/'];
    headers['User-Agent'] = [UA];
    details.requestHeaders = headers;
    callback({ requestHeaders: details.requestHeaders });
  });

  const win = new BrowserWindow({ width: 960, height: 540, show: false });
  const htmlPath = path.join(__dirname, 'probe.html');
  fs.writeFileSync(htmlPath, '<html><body style="margin:0;background:#000">'
    + '<video id="v" autoplay muted playsinline style="width:100vw;height:100vh"></video></body></html>');
  await win.loadFile(htmlPath);

  const result = await win.webContents.executeJavaScript(`(async () => {
    const v = document.getElementById('v');
    v.src = ${JSON.stringify(videoUrl)};
    v.muted = true;
    try { await v.play(); } catch (e) {}
    const started = Date.now();
    while (Date.now() - started < 20000) {
      if (v.readyState >= 2 && v.videoWidth > 0) break;
      await new Promise(r => setTimeout(r, 250));
    }
    return { readyState: v.readyState, videoWidth: v.videoWidth, videoHeight: v.videoHeight,
      duration: v.duration, currentTime: v.currentTime,
      error: v.error ? { code: v.error.code, message: v.error.message } : null, networkState: v.networkState };
  })()`);

  console.log('PROBE_RESULT ' + JSON.stringify(result));
  if (result.videoWidth > 0) {
    await new Promise(r => setTimeout(r, 3000));
    const image = await win.webContents.capturePage();
    fs.writeFileSync(outPng, image.toPNG());
    console.log('PROBE_SCREENSHOT ' + outPng);
  }
  app.exit(result.videoWidth > 0 ? 0 : 1);
}).catch(error => { console.error('PROBE_ERROR ' + (error && error.stack || error)); electron.app.exit(3); });
