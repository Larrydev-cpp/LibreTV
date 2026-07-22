// js/backup.js
// 一键备份/恢复本地用户数据（观看历史 + 收藏）为 JSON 文件，防止清缓存 / 换设备丢失。
// - 导出：把 viewingHistory + favorites 打包成一个 .json 文件下载到本地。
// - 导入：与现有本地记录**合并**（去重、较新 timestamp 胜），绝不覆盖；登录态下再推云端。
// 与 config 导出/导入（app.js）互不干扰：那个是整站配置且导入为覆盖，这个专做用户数据且合并。
(function (global) {
    const HIST_KEY = 'viewingHistory';
    const FAV_KEY = 'favorites';
    const HIST_MAX = 50;   // 与 history-sync.js 一致
    const FAV_MAX = 200;   // 与 favorites.js 一致

    function T(k) { return (typeof global.t === 'function') ? global.t(k) : k; }
    function toast(m, t) { if (typeof global.showToast === 'function') global.showToast(m, t); }
    function readLS(key) {
        try { const a = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(a) ? a : []; }
        catch (e) { return []; }
    }

    // 与 history-sync / favorites 相同的去重键与合并规则
    function histKey(it) { return (it && (it.showIdentifier || it.url || (it.title + '_' + (it.episodeIndex || 0)))) || String(Math.random()); }
    function favKey(it) { if (!it) return ''; if (it.sourceCode && it.vod_id) return it.sourceCode + '_' + it.vod_id; return 't_' + (it.title || ''); }
    function mergeArr(a, b, keyFn, max) {
        const map = new Map();
        [].concat(a || [], b || []).forEach(function (it) {
            if (!it) return;
            const k = keyFn(it);
            const prev = map.get(k);
            if (!prev || (it.timestamp || 0) >= (prev.timestamp || 0)) map.set(k, it);
        });
        return Array.from(map.values())
            .sort(function (x, y) { return (y.timestamp || 0) - (x.timestamp || 0); })
            .slice(0, max);
    }

    function exportData() {
        const payload = {
            app: 'LibreTV',
            type: 'libretv-backup',
            version: 1,
            exportedAt: new Date().toISOString(),
            viewingHistory: readLS(HIST_KEY),
            favorites: readLS(FAV_KEY),
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'libretv-backup-' + new Date().toISOString().slice(0, 10) + '.json';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { try { document.body.removeChild(a); } catch (e) {} URL.revokeObjectURL(url); }, 100);
        toast(T('backup.exported'), 'success');
    }

    function applyImport(data) {
        if (!data || (data.type && data.type !== 'libretv-backup')) { toast(T('backup.badFile'), 'error'); return; }
        let nH = 0, nF = 0;
        if (Array.isArray(data.viewingHistory)) {
            const merged = mergeArr(readLS(HIST_KEY), data.viewingHistory, histKey, HIST_MAX);
            try { localStorage.setItem(HIST_KEY, JSON.stringify(merged)); } catch (e) {}
            nH = data.viewingHistory.length;
        }
        if (Array.isArray(data.favorites)) {
            const merged = mergeArr(readLS(FAV_KEY), data.favorites, favKey, FAV_MAX);
            try { localStorage.setItem(FAV_KEY, JSON.stringify(merged)); } catch (e) {}
            nF = data.favorites.length;
        }
        // 刷新面板
        try { if (typeof global.loadViewingHistory === 'function') global.loadViewingHistory(); } catch (e) {}
        try { if (typeof global.loadFavorites === 'function') global.loadFavorites(); } catch (e) {}
        // 登录态下把合并结果推到云端（备份进账号）
        try { if (global.HistorySync && global.HistorySync.push) global.HistorySync.push(true); } catch (e) {}
        try { if (global.Favorites && global.Favorites.pushFav) global.Favorites.pushFav(true); } catch (e) {}
        toast(T('backup.imported1') + nH + T('backup.imported2') + nF + T('backup.imported3'), 'success');
    }

    function importFromFile(file) {
        if (!file) return;
        const reader = new FileReader();
        reader.onerror = function () { toast(T('backup.badFile'), 'error'); };
        reader.onload = function () {
            let data = null;
            try { data = JSON.parse(reader.result); } catch (e) { toast(T('backup.badFile'), 'error'); return; }
            applyImport(data);
        };
        reader.readAsText(file);
    }

    function pickAndImport() {
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.accept = 'application/json,.json';
        inp.onchange = function () { if (inp.files && inp.files[0]) importFromFile(inp.files[0]); };
        inp.click();
    }

    global.LibreBackup = { exportData, importFromFile, pickAndImport, applyImport };
    // 供设置面板按钮 onclick 直接调用
    global.exportLibreData = exportData;
    global.importLibreData = pickAndImport;
})(window);
