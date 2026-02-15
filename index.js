// SKTorrent + Real-Debrid Stremio Addon v2.1
// Hash z odkazů na stránce - BEZ přihlášení na SKT
const { decode } = require("entities");
const axios = require("axios");
const cheerio = require("cheerio");
const express = require("express");

const BASE_URL = "https://sktorrent.eu";
const SEARCH_URL = `${BASE_URL}/torrent/torrents_v2.php`;
const RD_API = "https://api.real-debrid.com/rest/1.0";
const PORT = process.env.PORT || 7000;

const langToFlag = {
    CZ: "🇨🇿", SK: "🇸🇰", EN: "🇬🇧", US: "🇺🇸",
    DE: "🇩🇪", FR: "🇫🇷", IT: "🇮🇹", ES: "🇪🇸",
    RU: "🇷🇺", PL: "🇵🇱", HU: "🇭🇺", JP: "🇯🇵"
};

const VIDEO_EXT = [".mkv", ".mp4", ".avi", ".mov", ".wmv", ".flv", ".webm", ".ts", ".m4v"];

function removeDiacritics(s) { return s.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }
function shortenTitle(s, n = 3) { return s.split(/\s+/).slice(0, n).join(" "); }
function isMultiSeason(s) { return /(S\d{2}E\d{2}-\d{2}|Complete|All Episodes|Season \d+(-\d+)?)/i.test(s); }
function isVideo(f) { return VIDEO_EXT.some(e => f.toLowerCase().endsWith(e)); }

// ============ IMDb ============
async function getTitle(imdbId) {
    try {
        const r = await axios.get(`https://www.omdbapi.com/?i=${imdbId}&apikey=91fa16b4`, { timeout: 5000 });
        if (r.data?.Title) { console.log(`[OMDb] "${r.data.Title}"`); return { title: r.data.Title, original: r.data.Title }; }
    } catch (e) {}
    try {
        const r = await axios.get(`https://www.imdb.com/title/${imdbId}/`, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }, timeout: 8000
        });
        const $ = cheerio.load(r.data);
        const title = decode($('title').text().split(' - ')[0].trim());
        let orig = title;
        const ld = $('script[type="application/ld+json"]').html();
        if (ld) { try { const j = JSON.parse(ld); if (j?.name) orig = decode(j.name.trim()); } catch (e) {} }
        return { title, original: orig };
    } catch (e) { console.error("[IMDb]", e.message); return null; }
}

// ============ SKTORRENT (bez přihlášení) ============
async function searchSKT(query) {
    console.log(`[SKT] 🔎 "${query}"`);
    try {
        const r = await axios.get(SEARCH_URL, {
            params: { search: query, category: 0, active: 0 },
            headers: { "User-Agent": "Mozilla/5.0" }, timeout: 10000
        });
        const $ = cheerio.load(r.data);
        const results = [];

        $('a[href*="details.php?id="]').each((i, el) => {
            const href = $(el).attr("href") || "";
            const m = href.match(/id=([a-fA-F0-9]{40})/);
            if (!m) return;
            const hash = m[1].toLowerCase();
            if (results.find(r => r.hash === hash)) return;

            const name = $(el).attr("title") || $(el).text().trim();
            if (!name || name.length < 3) return;

            const td = $(el).closest("td");
            const block = td.text().replace(/\s+/g, ' ').trim();
            const cat = td.find("b").first().text().trim();
            const szM = block.match(/Velkost\s([^|]+)/i);
            const sdM = block.match(/Odosielaju\s*:\s*(\d+)/i);

            const catL = cat.toLowerCase();
            if (catL && !catL.includes("film") && !catL.includes("seri") && !catL.includes("dokument") && !catL.includes("tv")) return;

            results.push({ name, hash, size: szM ? szM[1].trim() : "?", seeds: sdM ? parseInt(sdM[1]) : 0, cat });
        });

        if (results.length === 0) {
            $("table.lista tr").each((i, row) => {
                const cells = $(row).find("td.lista");
                if (cells.length < 2) return;
                const link = cells.eq(1).find("a[href*='details.php']");
                const href = link.attr("href") || "";
                const m = href.match(/id=([a-fA-F0-9]{40})/);
                if (!m) return;
                const hash = m[1].toLowerCase();
                if (results.find(r => r.hash === hash)) return;
                results.push({ name: link.text().trim(), hash, size: cells.eq(5)?.text().trim() || "?", seeds: parseInt(cells.eq(6)?.text().trim()) || 0, cat: cells.eq(0)?.text().trim() || "" });
            });
        }

        console.log(`[SKT] Nalezeno: ${results.length}`);
        return results;
    } catch (e) { console.error("[SKT]", e.message); return []; }
}

// ============ REAL-DEBRID ============
function rdH(t) { return { Authorization: `Bearer ${t}`, "Content-Type": "application/x-www-form-urlencoded" }; }

async function rdAddMagnet(token, hash) {
    const magnet = `magnet:?xt=urn:btih:${hash}&tr=udp://tracker.opentrackr.org:1337/announce&tr=udp://tracker.openbittorrent.com:80/announce&tr=udp://ipv4announce.sktorrent.eu:6969/announce`;
    try {
        const r = await axios.post(`${RD_API}/torrents/addMagnet`, `magnet=${encodeURIComponent(magnet)}`, { headers: rdH(token), timeout: 15000 });
        console.log(`[RD] Magnet added: ${r.data.id}`);
        return r.data.id;
    } catch (e) { console.error("[RD] addMagnet:", e.response?.data?.error || e.message); return null; }
}

async function rdInfo(token, id) {
    try { return (await axios.get(`${RD_API}/torrents/info/${id}`, { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 })).data; }
    catch (e) { return null; }
}

async function rdSelect(token, id, files) {
    try {
        await axios.post(`${RD_API}/torrents/selectFiles/${id}`, `files=${files}`, { headers: rdH(token), timeout: 10000 });
        console.log(`[RD] Selected: ${files}`);
        return true;
    } catch (e) { console.error("[RD] select:", e.response?.data?.error || e.message); return false; }
}

async function rdUnrestrict(token, link) {
    try { return (await axios.post(`${RD_API}/unrestrict/link`, `link=${encodeURIComponent(link)}`, { headers: rdH(token), timeout: 10000 })).data.download; }
    catch (e) { console.error("[RD] unrestrict:", e.response?.data?.error || e.message); return null; }
}

async function rdDelete(token, id) {
    try { await axios.delete(`${RD_API}/torrents/delete/${id}`, { headers: { Authorization: `Bearer ${token}` }, timeout: 5000 }); } catch (e) {}
}

async function rdVerify(token) {
    try { return (await axios.get(`${RD_API}/user`, { headers: { Authorization: `Bearer ${token}` }, timeout: 5000 })).data; }
    catch (e) { return null; }
}

async function resolveRD(token, hash, season, episode) {
    const tid = await rdAddMagnet(token, hash);
    if (!tid) return null;

    let info;
    // 1. Čekej na správný status
    for (let i = 0; i < 15; i++) {
        info = await rdInfo(token, tid);
        if (!info) { await rdDelete(token, tid); return null; }

        if (info.status === "downloaded" && info.links?.length > 0) {
            const url = await rdUnrestrict(token, info.links[0]);
            if (url) { console.log("[RD] ✅ Cached"); return url; }
            await rdDelete(token, tid); return null;
        }
        if (info.status === "waiting_files_selection") break;
        if (["magnet_error", "error", "virus", "dead"].includes(info.status)) {
            console.error(`[RD] ❌ ${info.status}`); await rdDelete(token, tid); return null;
        }
        await new Promise(r => setTimeout(r, 1000));
    }

    // 2. Vyber soubory
    if (info.status === "waiting_files_selection" && info.files?.length > 0) {
        const videos = info.files.filter(f => isVideo(f.path));
        let fid;
        if (videos.length === 0) { fid = "all"; }
        else if (season !== undefined && episode !== undefined && videos.length > 1) {
            const pats = [
                new RegExp(`S${String(season).padStart(2,'0')}E${String(episode).padStart(2,'0')}`, 'i'),
                new RegExp(`${season}x${String(episode).padStart(2,'0')}`, 'i'),
                new RegExp(`[._\\-\\s]E${String(episode).padStart(2,'0')}[._\\-\\s]`, 'i')
            ];
            let hit = null;
            for (const p of pats) { hit = videos.find(f => p.test(f.path)); if (hit) break; }
            fid = hit ? String(hit.id) : String(videos.reduce((a,b) => a.bytes > b.bytes ? a : b).id);
        } else {
            fid = String(videos.reduce((a,b) => a.bytes > b.bytes ? a : b).id);
        }
        if (!(await rdSelect(token, tid, fid))) { await rdDelete(token, tid); return null; }
    } else if (info.status !== "downloaded") {
        await rdDelete(token, tid); return null;
    }

    // 3. Čekej na stažení
    for (let i = 0; i < 30; i++) {
        info = await rdInfo(token, tid);
        if (!info) return null;
        if (info.status === "downloaded" && info.links?.length > 0) {
            const url = await rdUnrestrict(token, info.links[0]);
            if (url) { console.log("[RD] ✅ Ready"); return url; }
            return null;
        }
        if (["magnet_error", "error", "virus", "dead"].includes(info.status)) { await rdDelete(token, tid); return null; }
        await new Promise(r => setTimeout(r, 1000));
    }
    return null;
}

// ============ QUERIES ============
function buildQueries(title, original, type, season, episode) {
    const q = new Set();
    [title, original].map(t => t.replace(/\(.*?\)/g, '').replace(/TV (Mini )?Series/gi, '').trim()).filter(Boolean).forEach(base => {
        const nd = removeDiacritics(base), sh = shortenTitle(nd);
        if (type === 'series' && season && episode) {
            const ep = ` S${String(season).padStart(2,'0')}E${String(episode).padStart(2,'0')}`;
            [base, nd, sh].forEach(b => { q.add(b + ep); q.add((b + ep).replace(/[':]/g, '')); });
            [base, nd, sh].forEach(b => q.add(b));
        } else { [base, nd, sh].forEach(b => { q.add(b); q.add(b.replace(/[':]/g, '')); }); }
    });
    return [...q];
}

// ============ EXPRESS ============
const app = express();

app.get("/", (req, res) => { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.send(html()); });
app.get("/configure", (req, res) => { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.send(html()); });

app.get("/:token/manifest.json", (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Content-Type", "application/json");
    res.json({
        id: "org.stremio.sktorrent.rd", version: "2.1.0", name: "SKTorrent+RD",
        description: "CZ/SK torrenty ze sktorrent.eu s Real-Debrid",
        types: ["movie", "series"], catalogs: [], resources: ["stream"],
        idPrefixes: ["tt"], behaviorHints: { configurable: true, configurationRequired: false }
    });
});

app.get("/:token/stream/:type/:id.json", async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Content-Type", "application/json");

    const { token, type, id } = req.params;
    const [imdbId, sRaw, eRaw] = id.split(":");
    const season = sRaw ? parseInt(sRaw) : undefined;
    const episode = eRaw ? parseInt(eRaw) : undefined;

    console.log(`\n🎬 ${type} ${imdbId} S${season ?? '-'}E${episode ?? '-'}`);

    try {
        const titles = await getTitle(imdbId);
        if (!titles) return res.json({ streams: [] });

        const queries = buildQueries(titles.title, titles.original, type, season, episode);
        let torrents = [];
        for (const q of queries) { torrents = await searchSKT(q); if (torrents.length > 0) break; }
        if (!torrents.length) return res.json({ streams: [] });

        const streams = [];
        const seen = new Set();

        for (const t of torrents) {
            if (isMultiSeason(t.name) || seen.has(t.hash)) continue;
            seen.add(t.hash);

            const flags = (t.name.match(/\b([A-Z]{2})\b/g) || []).map(c => langToFlag[c]).filter(Boolean);
            const flagStr = flags.length ? ` ${flags.join("/")}` : "";
            const clean = t.name.replace(/^Stiahni si\s*/i, "").trim();

            const url = await resolveRD(token, t.hash, season, episode);

            if (url) {
                streams.push({
                    name: "SKT+RD",
                    description: `${clean}\n👤 ${t.seeds}  📀 ${t.size}${flagStr}\n⚡ Real-Debrid | ${t.cat}`,
                    url: url,
                    behaviorHints: { bingeGroup: `skt-rd-${t.hash.slice(0,8)}`, notWebReady: false }
                });
            } else {
                streams.push({
                    name: "SKTorrent",
                    description: `${clean}\n👤 ${t.seeds}  📀 ${t.size}${flagStr}\n🧲 Magnet | ${t.cat}`,
                    infoHash: t.hash,
                    sources: [
                        "tracker:udp://tracker.opentrackr.org:1337/announce",
                        "tracker:udp://tracker.openbittorrent.com:80/announce",
                        "tracker:udp://ipv4announce.sktorrent.eu:6969/announce"
                    ]
                });
            }
            if (streams.length >= 8) break;
        }

        console.log(`✅ ${streams.length} streams`);
        return res.json({ streams });
    } catch (e) { console.error("Error:", e.message); return res.json({ streams: [] }); }
});

app.get("/api/verify/:token", async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    const u = await rdVerify(req.params.token);
    res.json(u ? { success: true, username: u.username, type: u.type, expiration: u.expiration } : { success: false });
});

function html() {
    return `<!DOCTYPE html><html lang="cs"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SKTorrent+RD | Stremio</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:linear-gradient(135deg,#0f0c29,#1a1a3e,#24243e);color:#e0e0e0;min-height:100vh;display:flex;justify-content:center;align-items:center;padding:20px}.c{background:rgba(30,30,60,.85);backdrop-filter:blur(20px);border-radius:20px;padding:40px;max-width:500px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.5);border:1px solid rgba(255,255,255,.08)}h1{font-size:26px;background:linear-gradient(to right,#fff,#8b5cf6);-webkit-background-clip:text;-webkit-text-fill-color:transparent;text-align:center;margin-bottom:6px}.sub{text-align:center;color:#9ca3af;font-size:13px;margin-bottom:24px}.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;margin:0 3px}.b-rd{background:#059669;color:#fff}.b-sk{background:#dc2626;color:#fff}.info{background:rgba(139,92,246,.1);border:1px solid rgba(139,92,246,.3);border-radius:12px;padding:14px;margin-bottom:20px;font-size:13px;line-height:1.5;color:#c4b5fd}.info a{color:#a78bfa}label{display:block;margin-bottom:6px;font-size:14px;color:#d1d5db;font-weight:500}input{width:100%;padding:14px;border-radius:12px;border:1px solid rgba(255,255,255,.12);background:rgba(0,0,0,.3);color:#fff;font-size:15px;outline:none;margin-bottom:16px}input:focus{border-color:#8b5cf6}.btn{width:100%;padding:14px;border:none;border-radius:14px;font-size:16px;font-weight:600;cursor:pointer;margin-bottom:10px;color:#fff;transition:all .2s}.bv{background:linear-gradient(135deg,#059669,#10b981)}.bi{background:linear-gradient(135deg,#7c3aed,#8b5cf6);display:none}.btn:hover{opacity:.9;transform:translateY(-1px)}.st{text-align:center;margin:12px 0;font-size:14px;min-height:20px}.ok{color:#34d399}.er{color:#f87171}.lo{color:#fbbf24}.url{background:rgba(0,0,0,.4);border-radius:10px;padding:12px;margin-top:10px;word-break:break-all;font-family:monospace;font-size:12px;color:#a78bfa;display:none}.cp{display:inline-block;padding:4px 12px;font-size:12px;background:rgba(139,92,246,.2);border:1px solid rgba(139,92,246,.4);color:#c4b5fd;border-radius:6px;cursor:pointer;margin-top:8px}.ft{margin-top:20px;padding-top:16px;border-top:1px solid rgba(255,255,255,.08);display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:13px;color:#d1d5db}.ft div::before{content:"✓ ";color:#34d399}
</style></head><body>
<div class="c">
<h1>SKTorrent + Real-Debrid</h1>
<div class="sub">Stremio Addon <span class="badge b-sk">SKT</span><span class="badge b-rd">RD</span></div>
<div class="info">Prohledává <b>sktorrent.eu</b> a streamuje přes <b>Real-Debrid</b>.<br>Bez registrace na SKTorrent.<br><br>API klíč: <a href="https://real-debrid.com/apitoken" target="_blank">real-debrid.com/apitoken</a></div>
<label>Real-Debrid API Token</label>
<input type="text" id="t" placeholder="Vlož API token..." autocomplete="off">
<button class="btn bv" onclick="verify()">🔑 Ověřit token</button>
<div class="st" id="s"></div>
<button class="btn bi" id="ib" onclick="install()">📦 Nainstalovat do Stremio</button>
<div class="url" id="u"></div>
<div class="ft"><div>CZ/SK torrenty</div><div>Real-Debrid stream</div><div>Filmy & seriály</div><div>Bez registrace SKT</div><div>Auto výběr epizod</div><div>Magnet fallback</div></div>
</div>
<script>
const B=location.origin;
async function verify(){const t=document.getElementById('t').value.trim(),s=document.getElementById('s'),ib=document.getElementById('ib'),u=document.getElementById('u');if(!t){s.className='st er';s.textContent='❌ Zadej token';return}s.className='st lo';s.textContent='⏳ Ověřuji...';try{const r=await(await fetch(B+'/api/verify/'+t)).json();if(r.success){const d=new Date(r.expiration).toLocaleDateString('cs-CZ');s.className='st ok';s.textContent='✅ '+r.username+' ('+r.type+') | do: '+d;ib.style.display='block';u.style.display='block';const m=B+'/'+t+'/manifest.json';u.innerHTML=m+'<br><span class="cp" onclick="copyUrl()">📋 Kopírovat URL</span>'}else{s.className='st er';s.textContent='❌ Neplatný token';ib.style.display='none';u.style.display='none'}}catch(e){s.className='st er';s.textContent='❌ Chyba: '+e.message}}
function install(){const t=document.getElementById('t').value.trim();if(!t)return;window.location.href='stremio://'+B.replace(/https?:\\/\\//,'')+'/'+t+'/manifest.json'}
function copyUrl(){const t=document.getElementById('t').value.trim();navigator.clipboard.writeText(B+'/'+t+'/manifest.json').then(()=>{const c=document.querySelector('.cp');c.textContent='✅ Zkopírováno';setTimeout(()=>c.textContent='📋 Kopírovat URL',2000)})}
document.getElementById('t').addEventListener('keypress',e=>{if(e.key==='Enter')verify()});
</script></body></html>`;
}

app.listen(PORT, () => console.log(`🚀 SKTorrent+RD http://localhost:${PORT}`));
