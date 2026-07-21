// functions/api/register.js — POST 注册。
// 门槛（由宽到严）：
//   · 默认：设了站点密码 PASSWORD 时，需请求头 X-Auth-Hash = sha256(PASSWORD)
//     ——客户端自动携带（__ENV__.PASSWORD 注入的同一哈希），进了站的人无感注册；
//     未设 PASSWORD 则完全开放。
//   · env.REQUIRE_INVITE === 'true'：恢复旧行为，需管理员密码哈希当邀请口令。
// 会话密钥零配置：getSessionSecret（env.SESSION_SECRET > 站点密码派生 > KV 持久化随机串）。
import { json, getKV, normalizeUser, sha256Hex, timingSafeEqual, pbkdf2Hash, issueSession, getSessionSecret, buildSessionCookie, isSecure, DEFAULT_TTL } from './_auth.js';

export async function onRequest(context) {
    try {
        return await handle(context);
    } catch (e) {
        return json({ error: 'server error', detail: String((e && e.message) || e) }, 500);
    }
}

async function handle(context) {
    const { request, env } = context;
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);

    const kv = await getKV(env);
    if (!kv) return json({ error: 'KV 未绑定（需在 Cloudflare 绑定一个 KV 命名空间）' }, 500);

    const body = await request.json().catch(() => null);
    if (!body) return json({ error: 'bad body' }, 400);

    const userId = normalizeUser(body.username);
    if (!userId) return json({ error: '用户名非法（仅 a-z 0-9 . _ -，1–64 位）' }, 400);
    if (typeof body.password !== 'string' || body.password.length < 6) return json({ error: '密码至少 6 位' }, 400);

    if (env.REQUIRE_INVITE === 'true') {
        // 可选的旧式门槛：管理员密码当邀请口令
        const admin = env.ADMINPASSWORD || '';
        if (!admin) return json({ error: '未开放注册（服务端未配置 ADMINPASSWORD）' }, 403);
        const sent = String(body.inviteSecret || '').toLowerCase();
        if (!sent || !timingSafeEqual(sent, (await sha256Hex(admin)).toLowerCase())) {
            return json({ error: '邀请口令（管理员密码）不正确' }, 403);
        }
    } else if (env.PASSWORD) {
        // 默认门槛：站点密码哈希（客户端自动携带，用户无感）
        const sent = (request.headers.get('X-Auth-Hash') || '').toLowerCase();
        if (!sent || !timingSafeEqual(sent, (await sha256Hex(env.PASSWORD)).toLowerCase())) {
            return json({ error: '请先通过站点密码验证后再注册' }, 403);
        }
    }

    const key = 'user:' + userId;
    if (await kv.get(key)) return json({ error: '该用户名已存在' }, 409);

    const rec = await pbkdf2Hash(body.password);
    await kv.put(key, JSON.stringify({ salt: rec.salt, hash: rec.hash, iter: rec.iter, createdAt: Date.now() }));

    const secret = await getSessionSecret(env, kv);
    if (!secret) return json({ error: '服务端无法生成会话密钥' }, 500);
    const token = await issueSession(userId, secret, DEFAULT_TTL);
    return json({ ok: true, userId }, 200, { 'Set-Cookie': buildSessionCookie(token, DEFAULT_TTL, isSecure(request)) });
}
