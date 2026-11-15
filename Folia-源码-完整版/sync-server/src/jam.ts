import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import type { Env } from './app.js';
import {
    MAX_EVENTS_PER_ROOM,
    generateRoomCode,
    isValidRoomCode,
    pruneCutoffs,
    shouldDissolveRoom,
    type JamEvent,
    type JamSnapshot,
} from './jamCore.js';

// sync-server/src/jamCore.ts 旁边的路由层：把「一起听」房间的加入/离开/事件广播
// 落到 D1（Workers）/ SQLite（Node）里，客户端靠轮询拉增量。
//
// 全部挂在 /api/jam 下，走 app.ts 末尾之前挂载 + 现有 bearer 校验（和 /api/settings
// 同一道门：SYNC_TOKEN 就是房间的准入凭据，短码只用来在成员之间指路）。

type JamEventRow = { seq: number; payload_json: string };

const isRecord = (value: unknown): value is Record<string, unknown> => (
    Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const parseEvents = (value: unknown): JamEvent[] => {
    if (!Array.isArray(value)) return [];
    return value
        .filter(isRecord)
        .filter(event => typeof event.kind === 'string' && typeof event.ts === 'number')
        .slice(0, 50)
        .map(event => ({
            kind: event.kind as JamEvent['kind'],
            ts: event.ts as number,
            position: typeof event.position === 'number' ? event.position : undefined,
            song: 'song' in event ? event.song : undefined,
            queue: Array.isArray(event.queue) ? event.queue : undefined,
        }));
};

const parseSnapshot = (value: unknown): JamSnapshot | null => {
    if (!isRecord(value) || typeof value.ts !== 'number') return null;
    return {
        ts: value.ts,
        song: 'song' in value ? value.song : undefined,
        playing: value.playing === true,
        position: typeof value.position === 'number' ? value.position : 0,
        queue: Array.isArray(value.queue) ? value.queue : [],
    };
};

export const jamRoutes = new Hono<{ Bindings: Env }>();

/*
 * 这里是自己挂的 bearer 门，不是从 app.route 的挂载点继承的 —— Hono 的中间件
 * 挂在子应用内部，直接 mount 到 app 上不会带上 /api 那组的校验。短码只是成员
 * 之间指路用的，准入凭据和主题同步一样是 SYNC_TOKEN。
 */
jamRoutes.use('*', async (c, next) => {
  const auth = bearerAuth({ token: c.env.SYNC_TOKEN });
  return auth(c as any, next);
});

/* 建房：分配一个不撞车的 6 位短码。 */
jamRoutes.post('/rooms', async (c) => {
    const body = await c.req.json<{ clientId?: unknown }>().catch(() => null);
    if (!isRecord(body) || typeof body.clientId !== 'string' || !body.clientId) {
        return c.json({ ok: false, error: 'invalid_client' }, 400);
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
        const code = generateRoomCode();
        const existing = await c.env.FOLIA_SYNC_DB
            .prepare('SELECT code FROM jam_rooms WHERE code = ?')
            .bind(code)
            .first();
        if (existing) continue;
        const now = new Date().toISOString();
        await c.env.FOLIA_SYNC_DB.batch([
            c.env.FOLIA_SYNC_DB.prepare(
                'INSERT INTO jam_rooms (code, host_id, state_json, state_seq, created_at, updated_at) VALUES (?, ?, NULL, 0, ?, ?)',
            ).bind(code, body.clientId, now, now),
            c.env.FOLIA_SYNC_DB.prepare(
                'INSERT INTO jam_members (room_code, client_id, name, last_seen) VALUES (?, ?, ?, ?)',
            ).bind(code, body.clientId, 'host', now),
        ]);
        return c.json({ ok: true, code, role: 'host', seq: 0 });
    }
    return c.json({ ok: false, error: 'code_exhausted' }, 500);
});

/*
 * 加入：写入成员行并返回当前快照与最新 seq。
 * 房间不存在（从未建过或已解散）返回 room_not_found，客机据此提示。
 */
jamRoutes.post('/rooms/:code/join', async (c) => {
    const code = c.req.param('code');
    if (!isValidRoomCode(code)) return c.json({ ok: false, error: 'invalid_code' }, 400);
    const body = await c.req.json<{ clientId?: unknown; name?: unknown }>().catch(() => null);
    if (!isRecord(body) || typeof body.clientId !== 'string' || !body.clientId) {
        return c.json({ ok: false, error: 'invalid_client' }, 400);
    }
    const name = typeof body.name === 'string' && body.name ? body.name.slice(0, 32) : 'guest';
    const room = await c.env.FOLIA_SYNC_DB
        .prepare('SELECT host_id, state_json, state_seq FROM jam_rooms WHERE code = ?')
        .bind(code)
        .first<{ host_id: string; state_json: string | null; state_seq: number }>();
    if (!room) return c.json({ ok: false, error: 'room_not_found' }, 404);
    const now = new Date().toISOString();
    await c.env.FOLIA_SYNC_DB.prepare(
        `INSERT INTO jam_members (room_code, client_id, name, last_seen) VALUES (?, ?, ?, ?)
         ON CONFLICT(room_code, client_id) DO UPDATE SET last_seen = excluded.last_seen, name = excluded.name`,
    ).bind(code, body.clientId, name, now).run();
    const members = await c.env.FOLIA_SYNC_DB
        .prepare('SELECT client_id, name FROM jam_members WHERE room_code = ?')
        .bind(code)
        .all<{ client_id: string; name: string }>();
    return c.json({
        ok: true,
        role: body.clientId === room.host_id ? 'host' : 'guest',
        seq: room.state_seq,
        snapshot: room.state_json ? JSON.parse(room.state_json) : null,
        members: members.results ?? [],
    });
});

/*
 * 离开：房主离开 → 解散（注释见 jamCore.shouldDissolveRoom —— 短码房间没有
 * 房主就没有意义，转交的选举/接管成本和脑裂风险都不值得）；成员离开只删行。
 */
jamRoutes.post('/rooms/:code/leave', async (c) => {
    const code = c.req.param('code');
    if (!isValidRoomCode(code)) return c.json({ ok: false, error: 'invalid_code' }, 400);
    const body = await c.req.json<{ clientId?: unknown }>().catch(() => null);
    if (!isRecord(body) || typeof body.clientId !== 'string' || !body.clientId) {
        return c.json({ ok: false, error: 'invalid_client' }, 400);
    }
    const room = await c.env.FOLIA_SYNC_DB
        .prepare('SELECT host_id FROM jam_rooms WHERE code = ?')
        .bind(code)
        .first<{ host_id: string }>();
    if (!room) return c.json({ ok: true, closed: true });
    if (shouldDissolveRoom(body.clientId, room.host_id)) {
        await deleteRoom(c.env.FOLIA_SYNC_DB, code);
        return c.json({ ok: true, closed: true });
    }
    await c.env.FOLIA_SYNC_DB
        .prepare('DELETE FROM jam_members WHERE room_code = ? AND client_id = ?')
        .bind(code, body.clientId)
        .run();
    return c.json({ ok: true, closed: false });
});

/*
 * 房主发布：追加事件（seq 单调自增）+ 可选地覆盖最新快照。只认房主。
 * 事件流封顶 MAX_EVENTS_PER_ROOM，超过把最旧的挤掉 —— 对齐靠快照，事件只是增量。
 */
jamRoutes.post('/rooms/:code/publish', async (c) => {
    const code = c.req.param('code');
    if (!isValidRoomCode(code)) return c.json({ ok: false, error: 'invalid_code' }, 400);
    const body = await c.req.json<{ clientId?: unknown; events?: unknown; snapshot?: unknown }>().catch(() => null);
    if (!isRecord(body) || typeof body.clientId !== 'string' || !body.clientId) {
        return c.json({ ok: false, error: 'invalid_client' }, 400);
    }
    const room = await c.env.FOLIA_SYNC_DB
        .prepare('SELECT host_id, state_seq, updated_at FROM jam_rooms WHERE code = ?')
        .bind(code)
        .first<{ host_id: string; state_seq: number; updated_at: string }>();
    if (!room) return c.json({ ok: false, error: 'room_not_found' }, 404);
    if (body.clientId !== room.host_id) return c.json({ ok: false, error: 'not_host' }, 403);

    const events = parseEvents(body.events);
    const snapshot = parseSnapshot(body.snapshot);
    const now = new Date().toISOString();
    const db = c.env.FOLIA_SYNC_DB;
    const statements = [];
    let seq = room.state_seq;
    for (const event of events) {
        seq += 1;
        statements.push(db.prepare(
            'INSERT INTO jam_events (room_code, seq, payload_json, created_at) VALUES (?, ?, ?, ?)',
        ).bind(code, seq, JSON.stringify(event), now));
    }
    if (snapshot) {
        statements.push(db.prepare(
            'UPDATE jam_rooms SET state_json = ?, state_seq = ?, updated_at = ? WHERE code = ?',
        ).bind(JSON.stringify(snapshot), seq, now, code));
    } else {
        statements.push(db.prepare(
            'UPDATE jam_rooms SET state_seq = ?, updated_at = ? WHERE code = ?',
        ).bind(seq, now, code));
    }
    await db.batch(statements);
    // 事件流裁剪：只留最近 MAX_EVENTS_PER_ROOM 条。
    await db.prepare(
        `DELETE FROM jam_events WHERE room_code = ? AND seq <= (
             SELECT seq - ? FROM jam_rooms WHERE code = ?
         )`,
    ).bind(code, MAX_EVENTS_PER_ROOM, code).run();
    return c.json({ ok: true, seq });
});

/*
 * 轮询：拉 since 之后的增量事件 + 最新快照 + 在线成员，同时充当心跳
 * （每个轮询都刷新 last_seen）。顺带做清理：掉线成员、房主掉线 → 解散。
 */
jamRoutes.post('/rooms/:code/events', async (c) => {
    const code = c.req.param('code');
    if (!isValidRoomCode(code)) return c.json({ ok: false, error: 'invalid_code' }, 400);
    const body = await c.req.json<{ clientId?: unknown; since?: unknown }>().catch(() => null);
    if (!isRecord(body) || typeof body.clientId !== 'string' || !body.clientId) {
        return c.json({ ok: false, error: 'invalid_client' }, 400);
    }
    const since = typeof body.since === 'number' && Number.isFinite(body.since) ? Math.max(0, Math.trunc(body.since)) : 0;
    const db = c.env.FOLIA_SYNC_DB;
    const now = new Date().toISOString();
    const cutoffs = pruneCutoffs(Date.now());
    const isoCutoff = new Date(cutoffs.memberCutoff).toISOString();

    const room = await db.prepare('SELECT host_id, state_json, state_seq, updated_at FROM jam_rooms WHERE code = ?')
        .bind(code)
        .first<{ host_id: string; state_json: string | null; state_seq: number; updated_at: string }>();
    if (!room) return c.json({ ok: true, closed: true, events: [], seq: since, members: [], snapshot: null });

    await db.prepare(
        `INSERT INTO jam_members (room_code, client_id, name, last_seen) VALUES (?, ?, 'guest', ?)
         ON CONFLICT(room_code, client_id) DO UPDATE SET last_seen = excluded.last_seen`,
    ).bind(code, body.clientId, now).run();

    // 清掉线成员；房主掉线 → 解散（同 leave 的取舍）。
    await db.prepare('DELETE FROM jam_members WHERE room_code = ? AND last_seen < ?').bind(code, isoCutoff).run();
    const hostGone = await db.prepare(
        'SELECT 1 AS present FROM jam_members WHERE room_code = ? AND client_id = ?',
    ).bind(code, room.host_id).first();
    if (!hostGone) {
        await deleteRoom(db, code);
        return c.json({ ok: true, closed: true, events: [], seq: since, members: [], snapshot: null });
    }

    const events = await db.prepare(
        'SELECT seq, payload_json FROM jam_events WHERE room_code = ? AND seq > ? ORDER BY seq ASC LIMIT 100',
    ).bind(code, since).all<JamEventRow>();
    const members = await db.prepare('SELECT client_id, name FROM jam_members WHERE room_code = ?')
        .bind(code)
        .all<{ client_id: string; name: string }>();
    return c.json({
        ok: true,
        closed: false,
        seq: room.state_seq,
        events: (events.results ?? []).map(row => ({ seq: row.seq, ...JSON.parse(row.payload_json) })),
        members: members.results ?? [],
        snapshot: room.state_json ? JSON.parse(room.state_json) : null,
    });
});

const deleteRoom = async (db: Env['FOLIA_SYNC_DB'], code: string) => {
    await db.batch([
        db.prepare('DELETE FROM jam_events WHERE room_code = ?').bind(code),
        db.prepare('DELETE FROM jam_members WHERE room_code = ?').bind(code),
        db.prepare('DELETE FROM jam_rooms WHERE code = ?').bind(code),
    ]);
};
