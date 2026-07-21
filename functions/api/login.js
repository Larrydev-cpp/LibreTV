// functions/api/login.js — POST 登录：校验 user:<id> 的 PBKDF2 记录，发会话 cookie。
import { json, getKV, normalizeUser, pbkdf2Verify, issueSession, getSessionSecret, buildSessionCookie, isSecure, DEFAULT_TTL } from './_auth.js';

export async function onRequest(context) {
    // 兜底捕获：Workers 未捕获异常只会给用户一个空白 1101，这里转成结构化错误便于排障
    try {
        return await handle(context);
    } catch (e) {
        return json({ error: 'server error', detail: String((e && e.message) || e) }, 500);
    }
}

async function handle(context) {
    const { request, env } = context;
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);

    const kv = getKV(env);
    if (!kv) return json({ error: 'KV 未绑定' }, 500);

    const body = await request.json().catch(() => null);
    if (!body) return json({ error: 'bad body' }, 400);

    const userId = normalizeUser(body.username);
    // 通用失败文案，避免用户枚举
    const fail = () => json({ error: '用户名或密码错误' }, 401);
    if (!userId || typeof body.password !== 'string') return fail();

    const raw = await kv.get('user:' + userId);
    if (!raw) return fail();
    let rec;
    try { rec = JSON.parse(raw); } catch (e) { return fail(); }
    if (!(await pbkdf2Verify(body.password, rec))) return fail();

    const secret = await getSessionSecret(env, kv);
    if (!secret) return json({ error: '服务端无法生成会话密钥' }, 500);
    const token = await issueSession(userId, secret, DEFAULT_TTL);
    return json({ ok: true, userId }, 200, { 'Set-Cookie': buildSessionCookie(token, DEFAULT_TTL, isSecure(request)) });
}
