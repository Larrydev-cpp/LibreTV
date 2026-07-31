// js/downloader.js
// 「下载本集」：把当前 HLS(m3u8) 分片经 /proxy 抓取、（必要时 AES-128 解密）后
// 合并为单个 .ts 文件下载。兼容三端部署（统一通过 PROXY_URL 取流）。
//
// 限制：整集分片会在内存中合并，长视频占用较大；加密仅支持 AES-128(CBC)，
// 不支持 SAMPLE-AES / DRM。失败会给出明确提示，不影响播放。

(function (global) {
    const PROXY = (typeof PROXY_URL === 'string' && PROXY_URL) ? PROXY_URL : '/proxy/';

    // 取当前集的原始 m3u8 地址
    function currentEpisodeUrl() {
        try {
            if (Array.isArray(currentEpisodes) && typeof currentEpisodeIndex === 'number') {
                return currentEpisodes[currentEpisodeIndex] || '';
            }
        } catch (e) {}
        return '';
    }

    function baseTitle() {
        const t = (document.getElementById('videoTitle') || {}).textContent || '视频';
        return t.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);
    }
    function episodeFilename(idx0) {
        return `${baseTitle()}_第${(idx0 | 0) + 1}集`;
    }
    function currentTitle() {
        let idx = 0;
        try { idx = currentEpisodeIndex | 0; } catch (e) { idx = 0; }
        return episodeFilename(idx);
    }

    // uri -> 原始绝对地址（处理已被代理重写的 /proxy/、绝对、相对三种情况）
    function toOriginalAbs(uri, baseAbs) {
        if (!uri) return '';
        if (uri.startsWith(PROXY)) return decodeURIComponent(uri.slice(PROXY.length));
        if (/^https?:\/\//i.test(uri)) return uri;
        try { return new URL(uri, baseAbs).href; } catch (e) { return uri; }
    }
    // 原始绝对地址 -> 经代理的可取地址
    function proxied(absUrl) {
        return PROXY + encodeURIComponent(absUrl);
    }

    // 直连优先：与播放器一致直接取源站（CORS 由源站提供，能播即能下）；
    // 失败再回退代理。注意：边缘代理可能按文本处理而损坏二进制，故二进制必须直连优先。
    //
    // 取流策略记忆：源站没有 CORS 时，"先直连再回退代理"会让**每个分片**都白跑一次
    // 必然失败的往返（整集耗时直接翻倍）。这里在首个分片探明结论后记住它，
    // 之后所有分片直接用对的方式取，不再重复试错。每次下载任务开始时重置。
    let segStrategy = 'unknown'; // 'unknown' | 'direct' | 'proxy'
    function resetStrategy() { segStrategy = 'unknown'; }

    async function fetchText(absUrl, signal) {
        try {
            const r = await fetch(absUrl, { signal, mode: 'cors' });
            if (r.ok) return await r.text();
        } catch (e) { /* 回退代理 */ }
        const r2 = await fetch(proxied(absUrl), { signal });
        if (!r2.ok) throw new Error(`播放列表获取失败(HTTP ${r2.status})`);
        return r2.text();
    }
    async function fetchBuffer(absUrl, signal) {
        // 已知需要走代理：直接走，省掉注定失败的直连
        if (segStrategy !== 'proxy') {
            try {
                const r = await fetch(absUrl, { signal, mode: 'cors' });
                if (r.ok) {
                    if (segStrategy === 'unknown') segStrategy = 'direct';
                    return await r.arrayBuffer();
                }
            } catch (e) {
                if (signal && signal.aborted) throw e; // 取消不算探测失败
            }
            if (segStrategy === 'unknown') segStrategy = 'proxy';
        }
        const r2 = await fetch(proxied(absUrl), { signal });
        if (!r2.ok) throw new Error(`分片获取失败(HTTP ${r2.status})`);
        return r2.arrayBuffer();
    }

    // 并发抓取分片：保持**结果顺序严格等于 segments 顺序**（转封装/拼接依赖顺序），
    // 但网络请求并发进行，且**同时最多只留 WINDOW 个分片在内存里**。
    //
    // 早先的实现是"先并发下载全部、再统一处理"，等于把整集（可能数 GB）全压在内存里，
    // 移动端极易内存耗尽导致失败或产出损坏文件。这里改成有界滑动窗口：
    // 窗口内并发下载，但**严格按下标顺序消费**（转封装/拼接依赖顺序），消费完立即释放。
    const SEG_CONCURRENCY = 6;
    const SEG_WINDOW = 8;
    // onChunk(arrayBuffer, index) 按序调用；可返回 Promise（会被 await）。
    async function streamSegments(urls, signal, onChunk, onProgress, startIndex, preloaded) {
        const inflight = new Map();
        let nextToStart = startIndex || 0;
        let nextToConsume = startIndex || 0;

        function fill() {
            while (inflight.size < SEG_WINDOW && nextToStart < urls.length) {
                const i = nextToStart++;
                const p = fetchBuffer(urls[i], signal);
                p.catch(function () {}); // 防止"未处理的拒绝"告警；await 时仍会正常抛出
                inflight.set(i, p);
            }
        }

        // 已预取的首片（用于编码探测）直接消费，避免重复下载
        if (preloaded !== undefined && preloaded !== null) {
            await onChunk(preloaded, nextToConsume);
            nextToConsume++;
            nextToStart = Math.max(nextToStart, nextToConsume);
            if (onProgress) onProgress(nextToConsume, urls.length);
        }

        fill();
        while (nextToConsume < urls.length) {
            if (signal.aborted) throw new Error('已取消');
            const p = inflight.get(nextToConsume);
            const buf = await p;
            inflight.delete(nextToConsume);
            await onChunk(buf, nextToConsume);
            nextToConsume++;
            if (onProgress) onProgress(nextToConsume, urls.length);
            fill(); // 补满窗口，保持并发
        }
    }

    // 解析媒体播放列表，返回 { segments:[abs], key, mapAbs, mediaSeq }
    function parseMedia(text, baseAbs) {
        const lines = text.split('\n').map((l) => l.trim());
        const segments = [];
        let key = null, mapAbs = '', mediaSeq = 0;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (!line) continue;
            if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
                mediaSeq = parseInt(line.split(':')[1], 10) || 0;
            } else if (line.startsWith('#EXT-X-KEY:')) {
                const attr = line.slice('#EXT-X-KEY:'.length);
                const method = (attr.match(/METHOD=([^,]+)/) || [])[1] || 'NONE';
                const uri = (attr.match(/URI="([^"]+)"/) || [])[1] || '';
                const ivHex = (attr.match(/IV=0x([0-9A-Fa-f]+)/) || [])[1] || '';
                key = method === 'NONE' ? null : { method, uri: toOriginalAbs(uri, baseAbs), ivHex };
            } else if (line.startsWith('#EXT-X-MAP:')) {
                const uri = (line.match(/URI="([^"]+)"/) || [])[1] || '';
                if (uri) mapAbs = toOriginalAbs(uri, baseAbs);
            } else if (!line.startsWith('#')) {
                segments.push(toOriginalAbs(line, baseAbs));
            }
        }
        return { segments, key, mapAbs, mediaSeq };
    }

    // ===== TS 编码探测（决定能不能用 mux.js 转封装）=====
    // mux.js 只实现了 H.264(avc1) + AAC(mp4a)，**完全不认识 H.265/HEVC**。
    // 拿 HEVC 去转封装，它往往能吐出一个结构合法、视频轨却无效的 MP4：
    // 音频能放、画面全白——这正是用户看到的现象。所以必须先探测真实编码再决定路线。
    //
    // 按 MPEG-TS 规范解析：188 字节一包、同步字节 0x47；
    // PID 0 → PAT 拿到 program_map_PID；该 PID → PMT 遍历 elementary stream 的 stream_type。
    const TS_PKT = 188;
    const STREAM_TYPES = {
        0x01: 'mpeg1v', 0x02: 'mpeg2v', 0x1B: 'h264', 0x24: 'hevc', 0x52: 'chinese-cast',
        0x03: 'mp2a', 0x04: 'mp2a', 0x0F: 'aac', 0x11: 'aac-latm', 0x81: 'ac3', 0x87: 'eac3',
    };
    const VIDEO_TYPES = { 0x01: 1, 0x02: 1, 0x1B: 1, 0x24: 1 };

    function detectTsCodecs(buf) {
        const b = new Uint8Array(buf);
        const out = { video: 'unknown', audio: 'unknown' };
        // 找到第一个同步字节对齐的偏移（有些分片前面带垃圾字节）。
        // 有下一个包时用"双同步"确认以避开偶然的 0x47；只剩最后一个包时接受单同步，
        // 否则很短的缓冲区会直接判定失败（进而白白放弃转封装）。
        let base = -1;
        for (let i = 0; i + TS_PKT <= b.length && i < 4096; i++) {
            if (b[i] !== 0x47) continue;
            if (i + TS_PKT * 2 <= b.length && b[i + TS_PKT] !== 0x47) continue;
            base = i; break;
        }
        if (base < 0) return out;

        let pmtPid = -1;
        for (let off = base; off + TS_PKT <= b.length; off += TS_PKT) {
            if (b[off] !== 0x47) break;
            const pid = ((b[off + 1] & 0x1f) << 8) | b[off + 2];
            const payloadStart = (b[off + 1] & 0x40) !== 0;
            const adaptation = (b[off + 3] >> 4) & 0x03; // 2bit: 1=仅载荷 2=仅调整 3=both
            if (adaptation === 0 || adaptation === 2) continue; // 无载荷
            let p = off + 4;
            if (adaptation === 3) p += 1 + b[p];            // 跳过 adaptation_field
            if (payloadStart) p += 1 + b[p];                // 跳过 pointer_field
            if (p >= off + TS_PKT) continue;

            if (pid === 0 && pmtPid < 0) {
                // PAT：section_length 后是若干 (program_number, PID) 4 字节组
                const sectionLen = ((b[p + 1] & 0x0f) << 8) | b[p + 2];
                const end = Math.min(p + 3 + sectionLen - 4, off + TS_PKT); // 去掉 CRC32
                for (let q = p + 8; q + 3 < end; q += 4) {
                    const prog = (b[q] << 8) | b[q + 1];
                    const pidv = ((b[q + 2] & 0x1f) << 8) | b[q + 3];
                    if (prog !== 0) { pmtPid = pidv; break; }   // 跳过 NIT(program 0)
                }
                continue;
            }
            if (pmtPid >= 0 && pid === pmtPid) {
                const sectionLen = ((b[p + 1] & 0x0f) << 8) | b[p + 2];
                const end = Math.min(p + 3 + sectionLen - 4, off + TS_PKT);
                const programInfoLen = ((b[p + 10] & 0x0f) << 8) | b[p + 11];
                let q = p + 12 + programInfoLen;
                while (q + 4 < end) {
                    const stype = b[q];
                    const esInfoLen = ((b[q + 3] & 0x0f) << 8) | b[q + 4];
                    const name = STREAM_TYPES[stype];
                    if (VIDEO_TYPES[stype]) {
                        if (out.video === 'unknown') out.video = name || ('0x' + stype.toString(16));
                    } else if (name && out.audio === 'unknown') {
                        out.audio = name;
                    }
                    q += 5 + esInfoLen;
                }
                if (out.video !== 'unknown') return out;       // 拿到视频轨即可
            }
        }
        return out;
    }

    // mux.js 能处理的组合：视频必须是 H.264
    function canTransmux(codecs) {
        return !!codecs && codecs.video === 'h264';
    }

    function hexToBytes(hex) {
        const a = new Uint8Array(hex.length / 2);
        for (let i = 0; i < a.length; i++) a[i] = parseInt(hex.substr(i * 2, 2), 16);
        return a;
    }
    function seqToIv(seq) {
        const iv = new Uint8Array(16);
        const dv = new DataView(iv.buffer);
        dv.setUint32(12, seq >>> 0); // 大端，低 32 位
        return iv;
    }

    async function decryptSeg(buf, cryptoKey, iv) {
        const dec = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, buf);
        return new Uint8Array(dec);
    }

    // 按需加载 mux.js（TS→MP4 无损转封装库），只在第一次下载时加载
    let muxLoading = null;
    function loadMux() {
        if (global.muxjs) return Promise.resolve(global.muxjs);
        if (muxLoading) return muxLoading;
        muxLoading = new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = '/libs/mux.min.js'; // 绝对路径，兼容 /player 这类无扩展名 clean URL
            s.onload = () => global.muxjs ? resolve(global.muxjs) : reject(new Error('mux.js 未就绪'));
            s.onerror = () => reject(new Error('转封装库加载失败(可能未部署或被缓存)'));
            document.head.appendChild(s);
        });
        return muxLoading;
    }

    // 保存 Blob 为文件
    function saveBlob(parts, mime, filename) {
        const blob = new Blob(parts, { type: mime });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
    }

    // ===== 进度 UI =====
    let ui = null, aborter = null;
    function showProgress() {
        if (ui) return ui;
        const el = document.createElement('div');
        el.className = 'lt-dl-progress';
        el.innerHTML =
            '<div class="lt-dl-card">' +
            '<div class="lt-dl-title">正在下载本集…</div>' +
            '<div class="lt-dl-bar"><div class="lt-dl-fill"></div></div>' +
            '<div class="lt-dl-text">准备中…</div>' +
            '<button class="lt-dl-cancel">取消</button>' +
            '</div>';
        document.body.appendChild(el);
        el.querySelector('.lt-dl-cancel').onclick = () => { if (aborter) aborter.abort(); };
        ui = {
            el,
            fill: el.querySelector('.lt-dl-fill'),
            text: el.querySelector('.lt-dl-text'),
            title: el.querySelector('.lt-dl-title'),
        };
        return ui;
    }
    function setProgress(done, total, extra) {
        if (!ui) return;
        const pct = total ? Math.floor((done / total) * 100) : 0;
        ui.fill.style.width = pct + '%';
        ui.text.textContent = `${done}/${total} 分片 (${pct}%)${extra ? ' · ' + extra : ''}`;
    }
    function closeProgress() {
        if (ui && ui.el && ui.el.parentElement) ui.el.parentElement.removeChild(ui.el);
        ui = null;
    }

    // 下载单集。preferTs=true 时直接保存原始 TS（必定完整、低内存）；
    // 否则用 mux.js 无损转封装为 MP4。返回实际格式 'mp4' | 'ts'。
    async function downloadOne(m3u8, filename, signal, preferTs) {
        resetStrategy(); // 每集重新探测取流方式（不同集可能来自不同 host）
        // 1) 取播放列表（可能是 master）
        let baseAbs = m3u8;
        let text = await fetchText(baseAbs, signal);
        if (text.includes('#EXT-X-STREAM-INF')) {
            const lines = text.split('\n').map((l) => l.trim());
            let best = '', bw = -1;
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
                    const b = parseInt((lines[i].match(/BANDWIDTH=(\d+)/) || [])[1] || '0', 10);
                    for (let j = i + 1; j < lines.length; j++) {
                        if (lines[j] && !lines[j].startsWith('#')) {
                            if (b >= bw) { bw = b; best = lines[j]; }
                            break;
                        }
                    }
                }
            }
            if (best) { baseAbs = toOriginalAbs(best, baseAbs); text = await fetchText(baseAbs, signal); }
        }

        // 1.5) 去插入式广告（与播放器同一逻辑），尊重"分片广告过滤"开关
        try {
            let adOn = true;
            try { adOn = localStorage.getItem('adFilteringEnabled') !== 'false'; } catch (e) {}
            if (adOn && typeof filterAdsFromM3U8 === 'function') text = filterAdsFromM3U8(text, true);
        } catch (e) {}

        // 2) 解析媒体列表
        const { segments, key, mapAbs, mediaSeq } = parseMedia(text, baseAbs);
        if (!segments.length) throw new Error('未解析到任何分片');
        if (key && key.method !== 'AES-128') throw new Error(`暂不支持的加密方式：${key.method}`);

        // 3) 准备解密
        let cryptoKey = null, explicitIv = null;
        if (key) {
            if (!(global.crypto && global.crypto.subtle)) {
                throw new Error('当前环境不支持解密(需 HTTPS)，无法下载加密流');
            }
            const keyBuf = await fetchBuffer(key.uri, signal);
            if (keyBuf.byteLength !== 16) {
                throw new Error(`密钥长度异常(${keyBuf.byteLength}字节)，疑似被代理损坏`);
            }
            try {
                cryptoKey = await crypto.subtle.importKey('raw', keyBuf, { name: 'AES-CBC' }, false, ['decrypt']);
            } catch (e) {
                throw new Error('密钥导入失败：' + (e && e.message || e));
            }
            if (key.ivHex) explicitIv = hexToBytes(key.ivHex);
        }

        const total = segments.length;
        const decrypt = async function (buf, i) {
            if (!cryptoKey) return buf;
            return (await decryptSeg(buf, cryptoKey, explicitIv || seqToIv(mediaSeq + i))).buffer;
        };
        const prog = (done) => setProgress(done, total);

        // —— 情况 A：源已是 fMP4 分片（含 EXT-X-MAP）→ 直接拼接为 .mp4 ——
        if (mapAbs) {
            const parts = [new Uint8Array(await fetchBuffer(mapAbs, signal))];
            await streamSegments(segments, signal, async function (buf, i) {
                parts.push(new Uint8Array(await decrypt(buf, i)));
            }, prog);
            saveBlob(parts, 'video/mp4', filename + '.mp4');
            return 'mp4';
        }

        // —— 情况 B：TS 分片 ——
        // 先探测首片的真实编码再决定路线：mux.js 只实现了 H.264(avc1)+AAC，
        // **不认识 H.265/HEVC**。硬喂 HEVC 时它常常能吐出一个结构合法、视频轨却无效的
        // MP4——音频正常、画面全白，还会提示"下载完成"。所以非 H.264 一律不转封装，
        // 直接保存原始 TS（无损保留原编码，VLC / Infuse 等都能播）。
        let firstBuf = await fetchBuffer(segments[0], signal);
        firstBuf = await decrypt(firstBuf, 0);
        const codecs = detectTsCodecs(firstBuf);

        let muxjs = null, muxErr = '';
        const codecOk = canTransmux(codecs);
        if (!preferTs && !codecOk) {
            muxErr = '片源编码为 ' + (codecs.video === 'unknown' ? '未知' : codecs.video.toUpperCase()) +
                     '，mux.js 只支持 H.264，跳过转封装';
        }
        if (!preferTs && codecOk) {
            try { muxjs = await loadMux(); } catch (e) { muxjs = null; muxErr = (e && e.message) || '加载失败'; }
        }

        if (muxjs && muxjs.mp4 && muxjs.mp4.Transmuxer) {
            // 关键：所有分片先 push、最后只 flush 一次，并让时间轴归零（默认）。
            // 否则逐片 flush + 保留原始时间戳会导致时长元数据错乱（如显示 100 天）。
            const transmuxer = new muxjs.mp4.Transmuxer();
            let initSeg = null;
            const dataParts = [];
            transmuxer.on('data', (seg) => {
                if (!initSeg && seg.initSegment) initSeg = new Uint8Array(seg.initSegment);
                if (seg.data) dataParts.push(new Uint8Array(seg.data));
            });

            // 有界窗口并发下载，但严格按原顺序 push（时间轴依赖顺序）
            await streamSegments(segments, signal, async function (buf, i) {
                transmuxer.push(new Uint8Array(await decrypt(buf, i)));
            }, prog, 0, firstBuf);
            firstBuf = null;
            if (ui) ui.text.textContent = '封装 MP4 中…';
            transmuxer.flush(); // 仅此一次：生成连续时间轴的 fMP4

            // 双保险：即便探测判为 H.264，也要确认输出里真有 avc1 视频样本条目，
            // 否则同样会得到一个"能放声音、画面全白"的坏 MP4。
            if (initSeg && dataParts.length && initHasAvc1(initSeg)) {
                saveBlob([initSeg, ...dataParts], 'video/mp4', filename + '.mp4');
                return 'mp4';
            }
            muxErr = initSeg && dataParts.length
                ? '转封装输出中没有有效的 H.264 视频轨'
                : '转封装无输出(可能非标准 H.264/AAC)';
            // 转封装结果不可用 → 回退 TS（下面会重新按序抓一遍）
            firstBuf = await fetchBuffer(segments[0], signal);
            firstBuf = await decrypt(firstBuf, 0);
        }

        // —— 保存为原始 TS（用户主动选 TS，或不能/不该转封装时回退）——
        const parts = [];
        await streamSegments(segments, signal, async function (buf, i) {
            parts.push(new Uint8Array(await decrypt(buf, i)));
        }, prog, 0, firstBuf);
        firstBuf = null;
        saveBlob(parts, 'video/mp2t', filename + '.ts');
        if (!preferTs) {
            console.warn('[Downloader] 回退 TS 原因:', muxErr || '未知');
            lastTsReason = muxErr || '';
        }
        return 'ts';
    }
    // 最近一次回退到 TS 的原因（供 start() 给用户一句人话解释）
    let lastTsReason = '';

    // 转封装输出的 initSegment 里必须含 'avc1' 样本条目，否则视频轨无效
    function initHasAvc1(initSeg) {
        const b = initSeg;
        for (let i = 0; i + 3 < b.length; i++) {
            if (b[i] === 0x61 && b[i + 1] === 0x76 && b[i + 2] === 0x63 && b[i + 3] === 0x31) return true; // 'avc1'
        }
        return false;
    }

    let busy = false;
    async function start(preferTs) {
        if (busy) return;
        const m3u8 = currentEpisodeUrl();
        if (!m3u8 || !/^https?:\/\//i.test(m3u8)) {
            global.showToast && global.showToast('未找到可下载的视频地址', 'error');
            return;
        }
        const tip = preferTs
            ? '将把整集分片合并为原始 TS（必定完整，可用 VLC/Infuse 播放）。是否继续？'
            : '将把整集分片下载并无损封装为 MP4（不重新编码），可能消耗较多流量与内存。是否继续？';
        if (!global.confirm(tip)) return;

        busy = true;
        aborter = new AbortController();
        const signal = aborter.signal;
        showProgress();
        try {
            const fmt = await downloadOne(m3u8, currentTitle(), signal, preferTs);
            if (fmt === 'ts' && !preferTs && /H(EVC|265)|未知|没有有效/i.test(lastTsReason)) {
                // 说清楚为什么不是 MP4——否则用户只会看到一个"奇怪的 .ts"，
                // 或者（改之前）一个能出声但画面全白的 MP4。
                global.showToast && global.showToast(
                    '此片源为 H.265/HEVC 编码，网页内无法无损转成 MP4（强转会画面全白），已保存为原始 TS，可用 VLC / Infuse / 手机播放器直接播放',
                    'warning');
            } else {
                global.showToast && global.showToast(
                    `下载完成（${(fmt || 'mp4').toUpperCase()}）${fmt === 'ts' ? '，可用 VLC/Infuse 播放' : ''}`,
                    'success');
            }
        } catch (e) {
            if (!signal.aborted) {
                console.warn('[Downloader]', e);
                global.showToast && global.showToast('下载失败：' + (e && e.message || '未知错误'), 'error');
            } else {
                global.showToast && global.showToast('已取消下载', 'info');
            }
        } finally {
            busy = false; aborter = null; closeProgress();
        }
    }
    function startTs() { return start(true); }

    // 整季：逐集顺序下载，每集一个 .ts 文件
    async function startSeason() {
        if (busy) return;
        let list = [];
        try { list = Array.isArray(currentEpisodes) ? currentEpisodes.slice() : []; } catch (e) {}
        list = list.filter((u) => /^https?:\/\//i.test(u));
        if (!list.length) {
            global.showToast && global.showToast('未找到可下载的剧集列表', 'error');
            return;
        }
        if (!global.confirm(`将顺序下载整季共 ${list.length} 集，每集封装为一个 MP4。浏览器可能弹出多文件下载许可，且耗时较长。是否继续？`)) return;

        busy = true;
        aborter = new AbortController();
        const signal = aborter.signal;
        showProgress();
        let ok = 0, fail = 0;
        try {
            for (let i = 0; i < list.length; i++) {
                if (signal.aborted) break;
                if (ui) ui.title.textContent = `下载整季 第 ${i + 1}/${list.length} 集`;
                try {
                    await downloadOne(list[i], episodeFilename(i), signal);
                    ok++;
                } catch (e) {
                    if (signal.aborted) break;
                    console.warn('[Downloader] 第' + (i + 1) + '集失败:', e);
                    fail++;
                }
            }
            global.showToast && global.showToast(`整季下载结束：成功 ${ok} 集，失败 ${fail} 集`, fail ? 'warning' : 'success');
        } finally {
            busy = false; aborter = null; closeProgress();
        }
    }

    // 在 ArtPlayer 控制栏添加下载按钮（下拉：本集 / 整季）
    function setup(art) {
        if (!art || !art.controls || typeof art.controls.add !== 'function') return;
        const icon = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
        try {
            art.controls.add({
                name: 'lt-download',
                position: 'right',
                html: icon,
                tooltip: '下载',
                selector: [
                    { html: '本集 MP4', value: 'one' },
                    { html: '本集 TS（保底）', value: 'ts' },
                    { html: '整季 MP4', value: 'season' },
                ],
                onSelect: function (item) {
                    if (item.value === 'season') startSeason();
                    else if (item.value === 'ts') startTs();
                    else start();
                    return icon; // 控件保持图标
                },
            });
        } catch (e) {
            // 退化为单击下载本集
            try {
                art.controls.add({
                    name: 'lt-download', position: 'right', tooltip: '下载本集',
                    html: icon, click: function () { start(); },
                });
            } catch (e2) { console.warn('[Downloader] 添加控件失败:', e2 && e2.message); }
        }
    }

    global.LTDownloader = { setup, start, startTs, startSeason };
})(window);
