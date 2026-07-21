// js/auth-ui.js
// 多用户账号客户端：登录/注册弹窗 + window.Account（isLoggedIn/currentUser/login/register/logout/refresh）。
// 未登录时不影响任何现有功能（历史/收藏仍走本地）。注册需管理员密码（邀请口令）。
(function (global) {
    function T(k) { return (typeof global.t === 'function') ? global.t(k) : k; }
    function toast(m, t) { if (typeof global.showToast === 'function') global.showToast(m, t); }

    const state = { loggedIn: false, userId: null };
    function isLoggedIn() { return !!state.loggedIn; }
    function currentUser() { return state.userId; }

    async function api(path, opts) {
        opts = opts || {};
        opts.credentials = 'include';
        opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
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
    async function refresh() {
        const r = await api('/api/me', { method: 'GET' });
        state.loggedIn = !!(r.ok && r.data && r.data.loggedIn);
        state.userId = state.loggedIn ? r.data.userId : null;
        updateButton();
        try { document.dispatchEvent(new CustomEvent('lt-auth-changed', { detail: Object.assign({}, state) })); } catch (e) {}
        return state;
    }
    async function login(username, password) {
        const r = await api('/api/login', { method: 'POST', body: JSON.stringify({ username, password }) });
        if (r.ok) await refresh();
        return r;
    }
    async function register(username, password) {
        const r = await api('/api/register', { method: 'POST', body: JSON.stringify({ username, password }) });
        if (r.ok) await refresh();
        return r;
    }
    async function logout() {
        await api('/api/logout', { method: 'POST' });
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

    global.Account = { isLoggedIn, currentUser, login, register, logout, refresh, open };
    global.openAccountModal = open;

    document.addEventListener('DOMContentLoaded', function () { updateButton(); refresh(); });
})(window);
