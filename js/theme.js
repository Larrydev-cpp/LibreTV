// js/theme.js
// 主题选择：海景(seaside) / 深夜影院(midnight) / 樱花(sakura) / 森林(forest) / 高对比度(contrast)，持久化到 localStorage。
// 主题以 <html data-theme="..."> 表达，由 css/glass-theme.css 提供对应配色。
// 点击顶部主题按钮弹出色板菜单；toggleTheme() 仍保留（按顺序循环），兼容旧调用。

(function (global) {
    const KEY = 'ltTheme';
    const DEFAULT = 'seaside';
    // swatch：色板预览用的两色渐变（与各主题主色/背景一致）
    const THEMES = [
        { id: 'seaside',  zh: '海景',     en: 'Seaside',       swatch: ['#fdfcf6', '#1fb3c4'] },
        { id: 'midnight', zh: '深夜影院', en: 'Midnight',      swatch: ['#161a38', '#8b7cf6'] },
        { id: 'sakura',   zh: '樱花',     en: 'Sakura',        swatch: ['#fffafb', '#e0679a'] },
        { id: 'forest',   zh: '森林',     en: 'Forest',        swatch: ['#fbfcf6', '#3f9a6b'] },
        { id: 'contrast', zh: '高对比',   en: 'High Contrast', swatch: ['#000000', '#ffd60a'] },
    ];
    const IDS = THEMES.map((t) => t.id);

    function isEn() { return document.documentElement.getAttribute('lang') === 'en'; }
    function label(id) {
        const t = THEMES.find((x) => x.id === id) || THEMES[0];
        return isEn() ? t.en : t.zh;
    }
    function normalize(t) { return IDS.includes(t) ? t : DEFAULT; }

    function getTheme() {
        let t = DEFAULT;
        try { t = localStorage.getItem(KEY) || DEFAULT; } catch (e) {}
        return normalize(t);
    }

    function applyTheme(t) {
        t = normalize(t);
        document.documentElement.setAttribute('data-theme', t);
        const btn = document.getElementById('themeToggleBtn');
        if (btn) btn.title = isEn() ? `Theme: ${label(t)}` : `当前主题：${label(t)}`;
        const menu = document.getElementById('ltThemeMenu');
        if (menu) {
            menu.querySelectorAll('.lt-theme-option').forEach((o) => {
                o.setAttribute('aria-checked', o.dataset.theme === t ? 'true' : 'false');
            });
        }
    }

    function setTheme(t) {
        t = normalize(t);
        try { localStorage.setItem(KEY, t); } catch (e) {}
        // 切换时短暂开启颜色过渡，避免常驻 transition 影响页面其它动画性能
        const root = document.documentElement;
        root.classList.add('lt-theme-anim');
        setTimeout(() => root.classList.remove('lt-theme-anim'), 450);
        applyTheme(t);
        if (typeof global.showToast === 'function') {
            global.showToast(isEn() ? `Theme: ${label(t)}` : `已切换到「${label(t)}」主题`, 'success');
        }
    }

    function toggleTheme() {
        const i = IDS.indexOf(getTheme());
        setTheme(IDS[(i + 1) % IDS.length]);
    }

    // ===== 色板菜单 =====
    function buildMenu() {
        let menu = document.getElementById('ltThemeMenu');
        if (menu) return menu;
        menu = document.createElement('div');
        menu.id = 'ltThemeMenu';
        menu.className = 'lt-theme-menu';
        menu.setAttribute('role', 'menu');
        menu.hidden = true;
        THEMES.forEach((t) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'lt-theme-option';
            b.dataset.theme = t.id;
            b.setAttribute('role', 'menuitemradio');
            const sw = document.createElement('span');
            sw.className = 'lt-theme-swatch';
            sw.style.background = `linear-gradient(135deg, ${t.swatch[0]} 0 48%, ${t.swatch[1]} 52% 100%)`;
            const name = document.createElement('span');
            name.className = 'lt-theme-name';
            const check = document.createElement('span');
            check.className = 'lt-theme-check';
            check.setAttribute('aria-hidden', 'true');
            check.textContent = '✓';
            b.append(sw, name, check);
            b.addEventListener('click', () => { setTheme(t.id); closeMenu(true); });
            menu.appendChild(b);
        });
        menu.addEventListener('keydown', (e) => {
            const opts = Array.from(menu.querySelectorAll('.lt-theme-option'));
            const i = opts.indexOf(document.activeElement);
            if (e.key === 'ArrowDown') { e.preventDefault(); opts[(i + 1) % opts.length].focus(); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); opts[(i - 1 + opts.length) % opts.length].focus(); }
            else if (e.key === 'Escape') { e.preventDefault(); closeMenu(true); }
            else if (e.key === 'Tab') { closeMenu(false); }
        });
        document.body.appendChild(menu);
        return menu;
    }

    function positionMenu(menu, btn) {
        const r = btn.getBoundingClientRect();
        const w = menu.offsetWidth;
        const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
        menu.style.left = left + 'px';
        menu.style.top = (r.bottom + 8) + 'px';
    }

    function openMenu() {
        const btn = document.getElementById('themeToggleBtn');
        if (!btn) { toggleTheme(); return; }
        const menu = buildMenu();
        menu.querySelectorAll('.lt-theme-option').forEach((o) => {
            o.querySelector('.lt-theme-name').textContent = label(o.dataset.theme);
        });
        applyTheme(getTheme());
        menu.hidden = false;
        positionMenu(menu, btn);
        btn.setAttribute('aria-expanded', 'true');
        const cur = menu.querySelector('[aria-checked="true"]') || menu.querySelector('.lt-theme-option');
        if (cur) cur.focus();
    }

    function closeMenu(refocus) {
        const menu = document.getElementById('ltThemeMenu');
        if (!menu || menu.hidden) return;
        menu.hidden = true;
        const btn = document.getElementById('themeToggleBtn');
        if (btn) {
            btn.setAttribute('aria-expanded', 'false');
            if (refocus) btn.focus();
        }
    }

    function toggleThemeMenu(e) {
        if (e) e.stopPropagation();
        const menu = document.getElementById('ltThemeMenu');
        if (menu && !menu.hidden) closeMenu(false); else openMenu();
    }

    document.addEventListener('click', (e) => {
        const menu = document.getElementById('ltThemeMenu');
        if (!menu || menu.hidden) return;
        const btn = document.getElementById('themeToggleBtn');
        if (menu.contains(e.target) || (btn && btn.contains(e.target))) return;
        closeMenu(false);
    });
    window.addEventListener('resize', () => closeMenu(false));

    // 立即应用（脚本可能在 body 末尾加载；早期内联脚本已先设过属性以防闪烁）
    applyTheme(getTheme());
    document.addEventListener('DOMContentLoaded', () => {
        applyTheme(getTheme());
        const btn = document.getElementById('themeToggleBtn');
        if (btn) {
            btn.setAttribute('aria-haspopup', 'menu');
            btn.setAttribute('aria-expanded', 'false');
        }
    });

    global.LT_THEMES = IDS.slice();
    global.toggleTheme = toggleTheme;
    global.toggleThemeMenu = toggleThemeMenu;
    global.setTheme = setTheme;
    global.getTheme = getTheme;
})(window);
