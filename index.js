// SKTorrent + Real-Debrid Stremio Addon
// Hash se extrahuje z odkazů na stránce - BEZ přihlášení
const { decode } = require("entities");
const axios = require("axios");
const cheerio = require("cheerio");
const express = require("express");

const BASE_URL = "https://sktorrent.eu";
const SEARCH_URL = `${BASE_URL}/torrent/torrents_v2.php`;
const RD_API = "https://api.real-debrid.com/rest/1.0";
const PORT = process.env.PORT || 7000;

// ============ HELPERS ============
const langToFlag = {
    CZ: "🇨🇿", SK: "🇸🇰", EN: "🇬🇧", US: "🇺🇸",
    DE: "🇩🇪", FR: "🇫🇷", IT: "🇮🇹", ES: "🇪🇸",
    RU: "🇷🇺", PL: "🇵🇱", HU: "🇭🇺", JP: "🇯🇵"
};

const VIDEO_EXTENSIONS = [".mkv", ".mp4", ".avi", ".mov", ".wmv", ".flv", ".webm", ".ts", ".m4v"];

function removeDiacritics(str) {
    return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function shortenTitle(title, wordCount = 3) {
    return title.split(/\s+/).slice(0, wordCount).join(" ");
}

function isMultiSeason(title) {
    return /(S\d{2}E\d{2}-\d{2}|Complete|All Episodes|Season \d+(-\d+)?)/i.test(title);
}

function isVideoFile(filename) {
    return VIDEO_EXTENSIONS.some(ext => filename.toLowerCase().endsWith(ext));
}

// ============ IMDb TITLE ============
async function getTitleFromIMDb(imdbId) {
    try {
        const apiKey = "91fa16b4";
        const res = await axios.get(`https://www.omdbapi.com/?i=${imdbId}&apikey=${apiKey}`, { timeout: 5000 });
        if (res.data && res.data.Title) {
            console.log(`[OMDb] "${res.data.Title}"`);
            return { title: res.data.Title, originalTitle: res.data.Title };
        }
    } catch (e) {}

    try {
        const res = await axios.get(`https://www.imdb.com/title/${imdbId}/`, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
            timeout: 8000
        });
        const $ = cheerio.load(res.data);
        const titleRaw = $('title').text().split(' - ')[0].trim();
        const title = decode(titleRaw);
        const ldJson = $('script[type="application/ld+json"]').html();
        let originalTitle = title;
        if (ldJson) {
            try {
                const json = JSON.parse(ldJson);
                if (json && json.name) originalTitle = decode(json.name.trim());
            } catch (e) {}
        }
        return { title, originalTitle };
    } catch (err) {
        console.error("[IMDb] Chyba:", err.message);
        return null;
    }
}

// ============ SKTORRENT SEARCH (BEZ PŘIHLÁŠENÍ) ============
async function searchSKTorrent(query) {
    console.log(`[SKT] 🔎 "${query}"`);
    try {
        const res = await axios.get(SEARCH_URL, {
            params: { search: query, category: 0, active: 0 },
            headers: { "User-Agent": "Mozilla/5.0" },
            timeout: 10000
        });
        const $ = cheerio.load(res.data);
        const results = [];

        $('a[href*="details.php?id="]').each((i, el) => {
            const href = $(el).attr("href") || "";
            const hashMatch = href.match(/id=([a-fA-F0-9]{40})/);
            if (!hashMatch) return;

            const infoHash = hashMatch[1].toLowerCase();
            const tooltip = $(el).attr("title") || "";
            const name = tooltip || $(el).text().trim();
            if (!name) return;

            const outerTd = $(el).closest("td");
            const fullBlock = outerTd.text().replace(/\s+/g, ' ').trim();
            const category = outerTd.find("b").first().text().trim();
            const sizeMatch = fullBlock.match(/Velkost\s([^|]+)/i);
            const seedMatch = fullBlock.match(/Odosielaju\s*:\s*(\d+)/i);
            const size = sizeMatch ? sizeMatch[1].trim() : "?";
            const seeds = seedMatch ? parseInt(seedMatch[1]) : 0;

            const catLower = category.toLowerCase();
            if (catLower && !catLower.includes("film") && !catLower.includes("seri") && !catLower.includes("dokument") && !catLower.includes("tv")) return;

            if (results.find(r => r.infoHash === infoHash)) return;
            results.push({ name, infoHash, size, seeds, category });
        });

        // Fallback: tabulka
        if (results.length === 0) {
            $("table.lista tr").each((i, row) => {
                const cells = $(row).find("td.lista");
                if (cells.length < 2) return;
                const linkEl = cells.eq(1).find("a[href*='details.php']");
                const href = linkEl.attr("href") || "";
                const hashMatch = href.match(/id=([a-fA-F0-9]{40})/);
                if (!hashMatch) return;
                const infoHash = hashMatch[1].toLowerCase();
                const title = linkEl.text().trim();
                const seeds = parseInt(cells.eq(6).text().trim()) || 0;
                const size = cells.eq(5).text().trim() || "?";
                const category = cells.eq(0).text().trim();
                if (results.find(r => r.infoHash === infoHash)) return;
                results.push({ name: title, infoHash, size, seeds, category });
            });
        }

        console.log(`[SKT] Nalezeno: ${results.length}`);
        return results;
    } catch (err) {
        console.error("[SKT] Chyba:", err.message);
        return [];
    }
}

// ============ REAL-DEBRID ============
async function rdAddMagnet(token, infoHash) {
    const magnet = `magnet:?xt=urn:btih:${infoHash}&tr=udp://tracker.opentrackr.org:1337/announce&tr=udp://tracker.openbittorrent.com:80/announce&tr=udp://ipv4announce.sktorrent.eu:6969/announce`;
    try {
        const res = await axios.post(`${RD_API}/torrents/addMagnet`, `magnet=${encodeURIComponent(magnet)}`, {
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
            timeout: 15000
        });
        return res.data.id;
    } catch (err) {
        console.error("[RD] addMagnet:", err.response?.data?.error || err.message);
        return null;
    }
}

async function rdSelectFiles(token, torrentId, fileId = "all") {
    try {
        await axios.post(`${RD_API}/torrents/selectFiles/${torrentId}`, `files=${fileId}`, {
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
            timeout: 10000
        });
        return true;
    } catch (err) {
        console.error("[RD] selectFiles:", err.response?.data?.error || err.message);
        return false;
    }
}

async function rdGetInfo(token, torrentId) {
    try {
        const res = await axios.get(`${RD_API}/torrents/info/${torrentId}`, {
            headers: { Authorization: `Bearer ${token}` }, timeout: 10000
        });
        return res.data;
    } catch (err) { return null; }
}

async function rdUnrestrict(token, link) {
    try {
        const res = await axios.post(`${RD_API}/unrestrict/link`, `link=${encodeURIComponent(link)}`, {
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
            timeout: 10000
        });
        return res.data.download;
    } catch (err) { return null; }
}

async function rdDelete(token, id) {
    try { await axios.delete(`${RD_API}/torrents/delete/${id}`, { headers: { Authorization: `Bearer ${token}` }, timeout: 5000 }); } catch (e) {}
}

async function rdVerify(token) {
    try {
        const res = await axios.get(`${RD_API}/user`, { headers: { Authorization: `Bearer ${token}` }, timeout: 5000 });
        return res.data;
    } catch (e) { return null; }
}

async function resolveWithRD(token, infoHash, season, episode) {
    const torrentId = await rdAddMagnet(token, infoHash);
    if (!torrentId) return null;

    let info = await rdGetInfo(token, torrentId);
    if (!info || !info.files) { await rdDelete(token, torrentId); return null; }

    const videoFiles = info.files.filter(f => isVideoFile(f.path));
    let fileId;

    if (season !== undefined && episode !== undefined && videoFiles.length > 1) {
        const patterns = [
            new RegExp(`S${String(season).padStart(2,'0')}E${String(episode).padStart(2,'0')}`, 'i'),
            new RegExp(`${season}x${String(episode).padStart(2,'0')}`, 'i'),
            new RegExp(`[Ee]${String(episode).padStart(2,'0')}[^0-9]`, 'i')
        ];
        let m = null;
        for (const p of patterns) { m = videoFiles.find(f => p.test(f.path)); if (m) break; }
        fileId = m ? String(m.id) : String(videoFiles.reduce((a,b) => a.bytes > b.bytes ? a : b).id);
    } else if (videoFiles.length > 0) {
        fileId = String(videoFiles.reduce((a,b) => a.bytes > b.bytes ? a : b).id);
    } else {
        fileId = "all";
    }

    if (!(await rdSelectFiles(token, torrentId, fileId))) { await rdDelete(token, torrentId); return null; }

    for (let i = 0; i < 30; i++) {
        info = await rdGetInfo(token, torrentId);
        if (!info) return null;
        if (info.status === "downloaded" && info.links?.length > 0) {
            const url = await rdUnrestrict(token, info.links[0]);
            if (url) { console.log(`[RD] ✅ Ready`); return url; }
            return null;
        }
        if (["magnet_error","error","virus","dead"].includes(info.status)) {
            await rdDelete(token, torrentId); return null;
        }
        await new Promise(r => setTimeout(r, 1000));
    }
    return null;
}

// ============ QUERY BUILDER ============
function buildQueries(title, originalTitle, type, season, episode) {
    const queries = new Set();
    const bases = [title, originalTitle]
        .map(t => t.replace(/\(.*?\)/g, '').replace(/TV (Mini )?Series/gi, '').trim())
        .filter(Boolean);

    bases.forEach(base => {
        const noDia = removeDiacritics(base);
        const short = shortenTitle(noDia);
        if (type === 'series' && season && episode) {
            const ep = ` S${String(season).padStart(2,'0')}E${String(episode).padStart(2,'0')}`;
            [base, noDia, short].forEach(b => { queries.add(b + ep); queries.add((b + ep).replace(/[':]/g, '')); });
            [base, noDia, short].forEach(b => queries.add(b));
        } else {
            [base, noDia, short].forEach(b => { queries.add(b); queries.add(b.replace(/[':]/g, '')); });
        }
    });
    return [...queries];
}

// ============ EXPRESS ROUTES ============
const app = express();

app.get("/", (req, res) => { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.send(configPage()); });
app.get("/configure", (req, res) => { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.send(configPage()); });

app.get("/:token/manifest.json", (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json({
        id: "org.stremio.sktorrent.rd", version: "2.0.0", name: "SKTorrent+RD",
        description: "CZ/SK torrenty ze sktorrent.eu přes Real-Debrid",
        types: ["movie", "series"], catalogs: [], resources: ["stream"],
        idPrefixes: ["tt"], logo: "https://i.imgur.com/qlfRkLj.png",
        behaviorHints: { configurable: true }
    });
});

app.get("/:token/stream/:type/:id.json", async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    const { token, type, id } = req.params;
    const [imdbId, sRaw, eRaw] = id.split(":");
    const season = sRaw ? parseInt(sRaw) : undefined;
    const episode = eRaw ? parseInt(eRaw) : undefined;

    console.log(`\n🎬 ${type} ${imdbId} S${season||'-'}E${episode||'-'}`);

    try {
        const titles = await getTitleFromIMDb(imdbId);
        if (!titles) return res.json({ streams: [] });

        const queries = buildQueries(titles.title, titles.originalTitle, type, season, episode);
        let torrents = [];
        for (const q of queries) { torrents = await searchSKTorrent(q); if (torrents.length > 0) break; }
        if (torrents.length === 0) return res.json({ streams: [] });

        const streams = [];
        const seen = new Set();

        for (const t of torrents) {
            if (isMultiSeason(t.name) || seen.has(t.infoHash)) continue;
            seen.add(t.infoHash);

            const langMatches = t.name.match(/\b([A-Z]{2})\b/g) || [];
            const flags = langMatches.map(c => langToFlag[c]).filter(Boolean);
            const flagsText = flags.length ? ` ${flags.join("/")}` : "";
            const cleanName = t.name.replace(/^Stiahni si\s*/i, "").trim();

            const streamUrl = await resolveWithRD(token, t.infoHash, season, episode);

            if (streamUrl) {
                streams.push({
                    name: `SKT+RD\n${t.category}`,
                    title: `${cleanName}\n👤${t.seeds}  📀${t.size}${flagsText}\n⚡ Real-Debrid`,
                    url: streamUrl,
                    behaviorHints: { bingeGroup: `skt-${t.infoHash.slice(0,8)}`, notWebReady: false }
                });
            } else {
                streams.push({
                    name: `SKTorrent\n${t.category}`,
                    title: `${cleanName}\n👤${t.seeds}  📀${t.size}${flagsText}\n🧲 Magnet`,
                    infoHash: t.infoHash,
                    sources: [`magnet:?xt=urn:btih:${t.infoHash}&tr=udp://tracker.opentrackr.org:1337/announce&tr=udp://tracker.openbittorrent.com:80/announce&tr=udp://ipv4announce.sktorrent.eu:6969/announce`]
                });
            }
            if (streams.length >= 10) break;
        }

        console.log(`✅ ${streams.length} streamů`);
        return res.json({ streams });
    } catch (err) {
        console.error("Error:", err.message);
        return res.json({ streams: [] });
    }
});

app.get("/api/verify/:token", async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    const user = await rdVerify(req.params.token);
    res.json(user ? { success: true, username: user.username, type: user.type, expiration: user.expiration } : { success: false });
});

// ============ CONFIG PAGE ============
function configPage() {
    return `<!DOCTYPE html>
<html lang="cs"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SKTorrent+RD | Stremio</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:linear-gradient(135deg,#0f0c29,#1a1a3e,#24243e);color:#e0e0e0;min-height:100vh;display:flex;justify-content:center;align-items:center;padding:20px}
.c{background:rgba(30,30,60,.85);backdrop-filter:blur(20px);border-radius:20px;padding:40px;max-width:500px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.5);border:1px solid rgba(255,255,255,.08)}
h1{font-size:26px;background:linear-gradient(to right,#fff,#8b5cf6);-webkit-background-clip:text;-webkit-text-fill-color:transparent;text-align:center;margin-bottom:6px}
.sub{text-align:center;color:#9ca3af;font-size:13px;margin-bottom:24px}
.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;margin:0 3px}
.b-rd{background:#059669;color:#fff}.b-sk{background:#dc2626;color:#fff}
.info{background:rgba(139,92,246,.1);border:1px solid rgba(139,92,246,.3);border-radius:12px;padding:14px;margin-bottom:20px;font-size:13px;line-height:1.5;color:#c4b5fd}
.info a{color:#a78bfa}
label{display:block;margin-bottom:6px;font-size:14px;color:#d1d5db;font-weight:500}
input{width:100%;padding:14px;border-radius:12px;border:1px solid rgba(255,255,255,.12);background:rgba(0,0,0,.3);color:#fff;font-size:15px;outline:none;margin-bottom:16px}
input:focus{border-color:#8b5cf6}
.btn{width:100%;padding:14px;border:none;border-radius:14px;font-size:16px;font-weight:600;cursor:pointer;margin-bottom:10px;color:#fff;transition:all .2s}
.bv{background:linear-gradient(135deg,#059669,#10b981)}.bi{background:linear-gradient(135deg,#7c3aed,#8b5cf6);display:none}
.btn:hover{opacity:.9;transform:translateY(-1px)}
.st{text-align:center;margin:12px 0;font-size:14px;min-height:20px}
.ok{color:#34d399}.er{color:#f87171}.lo{color:#fbbf24}
.url{background:rgba(0,0,0,.4);border-radius:10px;padding:12px;margin-top:10px;word-break:break-all;font-family:monospace;font-size:12px;color:#a78bfa;display:none}
.cp{display:inline-block;padding:4px 12px;font-size:12px;background:rgba(139,92,246,.2);border:1px solid rgba(139,92,246,.4);color:#c4b5fd;border-radius:6px;cursor:pointer;margin-top:8px}
.ft{margin-top:20px;padding-top:16px;border-top:1px solid rgba(255,255,255,.08);display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:13px;color:#d1d5db}
.ft div::before{content:"✓ ";color:#34d399}
</style></head><body>
<div class="c">
<h1>SKTorrent + Real-Debrid</h1>
<div class="sub">Stremio Addon <span class="badge b-sk">SKT</span><span class="badge b-rd">RD</span></div>
<div class="info">
Prohledává <b>sktorrent.eu</b> a streamuje přes <b>Real-Debrid</b>. Bez registrace na SKT.<br><br>
API klíč: <a href="https://real-debrid.com/apitoken" target="_blank">real-debrid.com/apitoken</a>
</div>
<label>Real-Debrid API Token</label>
<input type="text" id="t" placeholder="Vlož API token..." autocomplete="off">
<button class="btn bv" onclick="verify()">🔑 Ověřit token</button>
<div class="st" id="s"></div>
<button class="btn bi" id="ib" onclick="install()">📦 Nainstalovat do Stremio</button>
<div class="url" id="u"></div>
<div class="ft">
<div>CZ/SK torrenty</div><div>Real-Debrid stream</div>
<div>Filmy & seriály</div><div>Bez registrace SKT</div>
<div>Auto výběr epizod</div><div>Magnet fallback</div>
</div></div>
<script>
const B=location.origin;
async function verify(){
const t=document.getElementById('t').value.trim(),s=document.getElementById('s'),ib=document.getElementById('ib'),u=document.getElementById('u');
if(!t){s.className='st er';s.textContent='❌ Zadej token';return}
s.className='st lo';s.textContent='⏳ Ověřuji...';
try{const r=await(await fetch(B+'/api/verify/'+t)).json();
if(r.success){const d=new Date(r.expiration).toLocaleDateString('cs-CZ');
s.className='st ok';s.textContent='✅ '+r.username+' ('+r.type+') | do: '+d;
ib.style.display='block';u.style.display='block';
const m=B+'/'+t+'/manifest.json';
u.innerHTML=m+'<br><span class="cp" onclick="navigator.clipboard.writeText(\\''+m+'\\').then(()=>{this.textContent=\\'✅ Zkopírováno\\';setTimeout(()=>this.textContent=\\'📋 Kopírovat\\',2e3)})">📋 Kopírovat</span>'}
else{s.className='st er';s.textContent='❌ Neplatný token';ib.style.display='none';u.style.display='none'}}
catch(e){s.className='st er';s.textContent='❌ Chyba: '+e.message}}
function install(){const t=document.getElementById('t').value.trim();if(!t)return;location.href='stremio://'+B.replace(/https?:\\/\\//,'')+'/'+t+'/manifest.json'}
document.getElementById('t').addEventListener('keypress',e=>{if(e.key==='Enter')verify()});
</script></body></html>`;
}

app.listen(PORT, () => console.log('🚀 SKTorrent+RD http://localhost:'+PORT));
