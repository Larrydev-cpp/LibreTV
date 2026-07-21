// functions/api/account-reset.js — 删除某账号及其数据（用站点密码把关，供站主管理/找回用户名）。
// POST {username}，请求头 X-Auth-Hash = sha256(PASSWORD)。删除 user/history/favorites/settings/media-index。
import { json, getKV, normalizeUser, sha256Hex, timingSafeEqual } from './_auth.js';

export async function onRequest(context) {
    const { request, env } = context;
    try {
        if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
        const kv = await getKV(env);
        if (!kv) return json({ error: 'KV 未绑定' }, 500);

        // 门槛：站点密码哈希（未设 PASSWORD 则拒绝，避免公开站被人清号）
        const pw = env.PASSWORD || '';
        if (!pw) return json({ error: '未设置站点密码，重置功能不可用' }, 403);
        const sent = (request.headers.get('X-Auth-Hash') || '').toLowerCase();
        if (!sent || !timingSafeEqual(sent, (await sha256Hex(pw)).toLowerCase())) {
            return json({ error: '需站点密码验证' }, 403);
        }

        const body = await request.json().catch(() => null);
        const userId = normalizeUser(body && body.username);
        if (!userId) return json({ error: 'invalid username' }, 400);

        for (const k of ['user:' + userId, 'history:' + userId, 'favorites:' + userId, 'settings:' + userId, 'media-index:' + userId]) {
            try { await kv.delete(k); } catch (e) {}
        }
        return json({ ok: true, deleted: userId });
    } catch (e) {
        return json({ error: 'server error', detail: String((e && e.message) || e) }, 500);
    }
}
