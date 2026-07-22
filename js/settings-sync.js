// js/settings-sync.js
// 登录态下把白名单设置同步到 KV（/api/settings）：登录时 pull 应用到本地，
// 切后台/刷新时 push 当前快照。未登录纯本地、行为不变。
(function (global) {
    const API = '/api/settings';
    const KEYS = [
        'selectedAPIs', 'customAPIs', 'yellowFilterEnabled', 'doubanEnabled',
        'tmdbApiKey', 'tmdbRegion', 'ltTheme', 'ltLang', 'playerEnhanceLevel',
        'maxPerfEnhance', 'autoplayEnabled', 'episodesReversed', 'userMovieTags',
        'userTvTags', 'enhanceStrength', 'playerQualityTarget', 'customProxyUrl',
    ];
    function T(k) { return (typeof global.t === 'function') ? global.t(k) : k; }
    function enabled() {
        try { return !!(global.Account && global.Account.isLoggedIn && global.Account.isLoggedIn()); } catch (e) { return false; }
    }
    function collect() {
        const o = {};
        for (const k of KEYS) { try { const v = localStorage.getItem(k); if (v !== null) o[k] = v; } catch (e) {} }
        return o;
    }
    function apply(obj) {
        if (!obj) return;
        Object.keys(obj).forEach(function (k) {
            if (KEYS.indexOf(k) === -1) return;
            try { const v = obj[k]; if (v != null) localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)); } catch (e) {}
        });
    }
    function hdr(base) {
        const h = Object.assign({}, base || {});
        try { if (global.Account && global.Account.authHeaders) Object.assign(h, global.Account.authHeaders()); } catch (e) {}
        return h;
    }
    let pushTimer = null;
    function doPush() {
        return fetch(API, {
            method: 'PUT', credentials: 'include',
            headers: hdr({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ settings: collect() }), keepalive: true,
        }).catch(function () {});
    }
    function push(immediate) {
        if (!enabled()) return;
        if (immediate) { if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; } doPush(); return; }
        if (pushTimer) clearTimeout(pushTimer);
        pushTimer = setTimeout(doPush, 1500);
    }
    // 同 history-sync.js 的 pull()：保留真实失败原因，不再压成 null
    function pull() {
        if (!enabled()) return Promise.resolve({ ok: false, status: -1, error: 'sync disabled' });
        return fetch(API, { credentials: 'include', headers: hdr() })
            .then(function (r) {
                return r.text().then(function (raw) {
                    let d = null;
                    try { d = raw ? JSON.parse(raw) : null; } catch (e) {}
                    if (r.ok && d && d.settings) return { ok: true, data: d.settings };
                    let detail;
                    if (d && d.error) detail = d.error;
                    else if (!raw) detail = '(空响应体)';
                    else if (d == null) detail = '响应不是合法 JSON：' + raw.slice(0, 120);
                    else detail = '响应结构不对：' + raw.slice(0, 120);
                    return { ok: false, status: r.status, error: detail };
                });
            })
            .catch(function (e) { return { ok: false, status: 0, error: (e && e.message) || String(e) }; });
    }
    // 登录后：云端有则拉下来应用（部分需刷新生效，主题即时生效）；云端空则把本地推上去
    function syncOnLogin() {
        if (!enabled()) return Promise.resolve(false);
        return pull().then(function (res) {
            if (!res.ok || Object.keys(res.data).length === 0) { push(true); return false; }
            const remote = res.data;
            apply(remote);
            try { if (remote.ltTheme) document.documentElement.setAttribute('data-theme', remote.ltTheme === 'contrast' ? 'contrast' : 'seaside'); } catch (e) {}
            if (typeof global.showToast === 'function') global.showToast(T('toast.settingsSynced'), 'info');
            return true;
        });
    }
    document.addEventListener('lt-auth-changed', function () { syncOnLogin(); });
    global.addEventListener('pagehide', function () { push(true); });
    global.SettingsSync = { push, pull, syncOnLogin };
})(window);
