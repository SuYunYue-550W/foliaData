// electron/jamLanRelay.cjs
// 「一起听」局域网内置中继：电脑端零部署的汇合点。
//
// 桌面端点「创建房间」时，主进程在 0.0.0.0 上起一个极简 WebSocket 服务；同一 WiFi 的
// 手机把面板显示的地址（ws://192.168.x.x:端口）填进去即可直连，数据不出内网、不经公网。
//
// 协议刻意极简：客户端发 {type:'join',channel} 加入、{type:'pub',channel,payload} 广播，
// 服务端把 payload 原样转给同频道的其它连接（{type:'frame',payload}）。房间码本身不进
// 这里：channel 是房间码的 SHA-256 派生值，payload 是 AES-GCM 密文，服务端无从解读。
//
// 生命周期：随 Jam 会话启停；窗口关闭 / 退出房间时 stop。端口 0 = 系统分配，避免占用冲突。

const { WebSocketServer } = require('ws');
const os = require('os');

const MAX_FRAME_BYTES = 256 * 1024; // 一帧最多 256KB，防滥用
const MAX_CHANNEL_CLIENTS = 16;     // 单个房间最多 16 人，够用且防刷

/** 取本机所有非回环 IPv4，按常见内网段优先排序，供面板展示给手机。 */
const listLanAddresses = (port) => {
  const candidates = [];
  for (const interfaces of Object.values(os.networkInterfaces() || {})) {
    for (const item of interfaces || []) {
      if (item.family !== 'IPv4' || item.internal) continue;
      candidates.push(item.address);
    }
  }
  const rank = (address) => {
    if (address.startsWith('192.168.')) return 0;
    if (/^10\./.test(address)) return 1;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return 2;
    return 3;
  };
  return [...new Set(candidates)].sort((a, b) => rank(a) - rank(b)).map(address => `ws://${address}:${port}`);
};

const createJamLanRelay = () => {
  let server = null;
  let port = 0;
  /** channel -> Set<WebSocket> */
  const channels = new Map();
  /** WebSocket -> channel */
  const peerChannel = new WeakMap();

  const drop = (ws) => {
    const channel = peerChannel.get(ws);
    if (!channel) return;
    peerChannel.delete(ws);
    const peers = channels.get(channel);
    if (!peers) return;
    peers.delete(ws);
    if (peers.size === 0) channels.delete(channel);
  };

  const send = (ws, message) => {
    if (ws.readyState === 1) {
      try { ws.send(JSON.stringify(message)); } catch { /* 对端已断 */ }
    }
  };

  const start = () => new Promise((resolve, reject) => {
    if (server) { resolve({ addresses: listLanAddresses(port), port }); return; }
    let wss;
    try {
      wss = new WebSocketServer({ host: '0.0.0.0', port: 0, maxPayload: MAX_FRAME_BYTES });
    } catch (error) { reject(error); return; }
    server = wss;

    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        let message;
        try { message = JSON.parse(String(raw)); } catch { return; }
        if (!message || typeof message.channel !== 'string' || message.channel.length > 128) return;

        if (message.type === 'join') {
          drop(ws); // 一个连接只属于一个频道
          let peers = channels.get(message.channel);
          if (!peers) { peers = new Set(); channels.set(message.channel, peers); }
          if (peers.size >= MAX_CHANNEL_CLIENTS) {
            send(ws, { type: 'error', code: 'room_full' });
            ws.close();
            return;
          }
          peers.add(ws);
          peerChannel.set(ws, message.channel);
          send(ws, { type: 'joined', channel: message.channel });
          return;
        }

        if (message.type === 'pub' && typeof message.payload === 'string') {
          const channel = peerChannel.get(ws);
          if (!channel || channel !== message.channel) return;
          if (message.payload.length > MAX_FRAME_BYTES) return;
          const peers = channels.get(channel);
          if (!peers) return;
          const frame = JSON.stringify({ type: 'frame', payload: message.payload });
          for (const peer of peers) if (peer !== ws && peer.readyState === 1) {
            try { peer.send(frame); } catch { /* 忽略单个断连 */ }
          }
        }
      });
      ws.on('close', () => drop(ws));
      ws.on('error', () => drop(ws));
    });

    wss.on('error', (error) => {
      if (!server) return; // 已经 stop 过
      server = null;
      reject(error);
    });
    wss.on('listening', () => {
      const address = wss.address();
      port = typeof address === 'object' && address ? address.port : 0;
      resolve({ addresses: listLanAddresses(port), port });
    });
  });

  const stop = () => {
    if (!server) return;
    const closing = server;
    server = null;
    port = 0;
    for (const ws of closing.clients) { try { ws.terminate(); } catch { /* 忽略 */ } }
    try { closing.close(); } catch { /* 已关闭 */ }
    channels.clear();
  };

  return { start, stop, getStatus: () => ({ running: Boolean(server), port, addresses: listLanAddresses(port) }) };
};

module.exports = { createJamLanRelay, listLanAddresses };
