// js/auth-ui.js
// 多用户账号客户端：登录/注册弹窗 + window.Account（isLoggedIn/currentUser/login/register/logout/refresh）。
// 未登录时不影响任何现有功能（历史/收藏仍走本地）。注册需管理员密码（邀请口令）。
(function (global) {
    function T(k) { return (typeof global.t === 'function') ? global.t(k) : k; }
    function toast(m, t) { if (typeof global.showToast === 'function') global.showToast(m, t); }

    const TOKEN_KEY = 'ltSessionToken';
    const state = { loggedIn: false, userId: null };
    function isLoggedIn() { return !!state.loggedIn; }
    function currentUser() { return state.userId; }
    function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } }
    function setToken(t) { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch (e) {} }
    // 供 history-sync / favorites / settings-sync 复用：登录态下带 Bearer token（绕开 cookie）
    function authHeaders() {
        const t = getToken();
        return t ? { 'Authorization': 'Bearer ' + t } : {};
    }
    // 解析会话 token 的 payload（不校验签名，仅取 userId 供本地即时显示；服务端仍会校验）
    function decodeToken(tok) {
        try {
            const p = String(tok || '').split('.')[0];
            if (!p) return null;
            let s = p.replace(/-/g, '+').replace(/_/g, '/');
            while (s.length % 4) s += '=';
            const obj = JSON.parse(atob(s));
            if (!obj || !obj.u) return null;
            if (obj.exp && Date.now() > obj.exp) return null; // 已过期
            return { userId: obj.u };
        } catch (e) { return null; }
    }
    // 页面加载即从本地 token 恢复登录态并更新按钮（不等 /api/me 往返，避免"登录态闪没"）；
    // token 过期或损坏才清掉。
    function restoreFromToken() {
        const tok = getToken();
        if (!tok) return false;
        const d = decodeToken(tok);
        if (!d) { setToken(''); return false; }
        state.loggedIn = true;
        state.userId = d.userId;
        updateButton();
        return true;
    }
    function emitAuthChanged(fresh) {
        try { document.dispatchEvent(new CustomEvent('lt-auth-changed', { detail: Object.assign({ fresh: !!fresh }, state) })); } catch (e) {}
    }

    async function api(path, opts) {
        opts = opts || {};
        opts.credentials = 'include';
        opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
        // 会话 token（首选，绕开 Safari cookie 限制）
        const tok = getToken();
        if (tok) opts.headers['Authorization'] = 'Bearer ' + tok;
        // 自动携带站点密码哈希（注册门槛用；占位符未替换或未设密码则不带）
        try {
            const hash = global.__ENV__ && global.__ENV__.PASSWORD;
            if (hash && hash.indexOf('{{') === -1 && hash.length === 64) opts.headers['X-Auth-Hash'] = hash;
        } catch (e) {}
        let r, data = null;
        try { r = await fetch(path, opts); } catch (e) { return { ok: false, status: 0, data: null }; }
        try { data = await r.json(); } catch (e) {}
        return { ok: r.ok, status: r.status, data };
    }
    // 校验会话：成功则确认登录态；仅在服务端"明确未登录"(401) 时才登出并清 token。
    // 网络失败(status 0)或服务器错误(5xx)一律保持现状，绝不把已登录用户"闪回"登录。
    async function refresh() {
        const r = await api('/api/me', { method: 'GET' });
        if (r.status === 0) return state;                       // 网络失败：不动现状
        if (r.ok && r.data && r.data.loggedIn) {
            state.loggedIn = true;
            state.userId = r.data.userId;
        } else if (r.status === 401) {                          // 明确未登录：令牌失效
            state.loggedIn = false; state.userId = null; setToken('');
        } else {
            return state;                                       // 其它(如 5xx)：保守不动
        }
        updateButton();
        emitAuthChanged(false);                                 // 页面加载校验，不弹合并提示
        return state;
    }
    // 登录/注册成功：立刻从响应体确立登录态并更新按钮（不依赖后续 /api/me 往返），
    // 存下 token 供之后所有请求用 Bearer 头携带；再 refresh() 兜底。
    // fresh:true 表示"刚刚登录/注册"——history-sync/favorites 据此弹一次合并提示。
    function onAuthed(data) {
        if (data && data.token) setToken(data.token);
        state.loggedIn = true;
        state.userId = (data && data.userId) || state.userId;
        updateButton();
        emitAuthChanged(true);
    }
    async function login(username, password) {
        const r = await api('/api/login', { method: 'POST', body: JSON.stringify({ username, password }) });
        if (r.ok) { onAuthed(r.data); refresh(); }
        return r;
    }
    async function register(username, password) {
        const r = await api('/api/register', { method: 'POST', body: JSON.stringify({ username, password }) });
        if (r.ok) { onAuthed(r.data); refresh(); }
        return r;
    }
    async function logout() {
        await api('/api/logout', { method: 'POST' });
        setToken('');
        await refresh();
    }

    function updateButton() {
        const label = document.querySelector('#accountBtn .account-label');
        if (label) label.textContent = state.loggedIn ? state.userId : T('account.login');
    }

    let modal = null;
    function buildModal() {
        if (modal) return modal;
        modal = document.createElement('div');
        modal.id = 'accountModal';
        modal.className = 'fixed inset-0 hidden items-center justify-center transition-opacity';
        // 层级/底色/宽度用内联样式写死：tailwind.css 是预编译产物，
        // z-[70]/max-w-sm 这类 JS 里拼的任意值类没被编译进去，会导致弹窗被页面元素穿透
        modal.style.cssText = 'z-index:10050;background:rgba(0,0,0,0.82);';
        modal.innerHTML =
            '<div class="bg-[#111] p-6 rounded-lg w-11/12 border border-[#333]" style="max-width:24rem;position:relative;z-index:10051;">'
          + '  <div class="flex justify-between items-center mb-4">'
          + '    <h3 class="text-xl font-bold gradient-text" id="acctTitle"></h3>'
          + '    <button id="acctClose" class="text-gray-400 hover:text-white text-2xl leading-none">&times;</button>'
          + '  </div>'
          + '  <div id="acctOut">'
          + '    <input id="acctUser" type="text" autocomplete="username" class="w-full bg-[#222] border border-[#333] text-white px-3 py-2 rounded mb-2">'
          + '    <input id="acctPass" type="password" autocomplete="current-password" class="w-full bg-[#222] border border-[#333] text-white px-3 py-2 rounded mb-2">'
          + '    <button id="acctSubmit" class="w-full bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded mt-1"></button>'
          + '    <div class="text-center mt-3 text-sm text-gray-400"><a href="#" id="acctSwitch" class="hover:text-white underline"></a></div>'
          + '  </div>'
          + '  <div id="acctIn" class="hidden text-center">'
          + '    <p class="text-gray-300 mb-4"><span id="acctWhoami" class="gradient-text font-bold"></span></p>'
          + '    <button id="acctLogout" class="w-full bg-[#333] hover:bg-[#444] text-white px-4 py-2 rounded"></button>'
          + '  </div>'
          + '</div>';
        document.body.appendChild(modal);
        const $ = (id) => modal.querySelector('#' + id);
        let mode = 'login';

        function placeholders() {
            $('acctUser').placeholder = T('account.username');
            $('acctPass').placeholder = T('account.password');
        }
        function setMode(m) {
            mode = m;
            $('acctTitle').textContent = m === 'register' ? T('account.register') : T('account.login');
            $('acctSubmit').textContent = m === 'register' ? T('account.register') : T('account.login');
            $('acctSwitch').textContent = m === 'register' ? T('account.toLogin') : T('account.toRegister');
        }
        function render() {
            placeholders();
            $('acctLogout').textContent = T('account.logout');
            if (state.loggedIn) {
                $('acctIn').classList.remove('hidden'); $('acctOut').classList.add('hidden');
                $('acctWhoami').textContent = state.userId;
                $('acctTitle').textContent = T('account.title');
            } else {
                $('acctIn').classList.add('hidden'); $('acctOut').classList.remove('hidden');
                setMode('login');
            }
        }
        $('acctClose').onclick = close;
        modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
        $('acctSwitch').onclick = (e) => { e.preventDefault(); setMode(mode === 'login' ? 'register' : 'login'); };
        $('acctLogout').onclick = async () => { await logout(); render(); toast(T('account.loggedOut'), 'info'); };
        $('acctSubmit').onclick = async () => {
            const u = $('acctUser').value.trim(), p = $('acctPass').value;
            if (!u || !p) { toast(T('account.needUserPass'), 'warning'); return; }
            const r = mode === 'register' ? await register(u, p) : await login(u, p);
            if (r.ok) { render(); toast(mode === 'register' ? T('account.registered') : T('account.welcome'), 'success'); }
            else { toast((r.data && r.data.error) || T('account.failed'), 'error'); }
        };
        modal._render = render;
        return modal;
    }
    function open() { buildModal(); modal._render(); modal.classList.remove('hidden'); modal.classList.add('flex'); }
    function close() { if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); } }

    global.Account = { isLoggedIn, currentUser, login, register, logout, refresh, open, authHeaders, getToken };
    global.openAccountModal = open;

    document.addEventListener('DOMContentLoaded', function () {
        restoreFromToken();  // 有 token 立刻显示用户名，避免刷新后"登录态闪没"
        updateButton();
        refresh();           // 后台校验；网络抖动不会把已登录用户登出
    });
})(window);
