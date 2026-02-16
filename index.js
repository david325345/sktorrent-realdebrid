// SKTorrent + Real-Debrid Stremio Addon v2.3
// Hledání je rychlé (bez RD). Resolve + proxy až po kliknutí.
const { decode } = require("entities");
const axios = require("axios");
const cheerio = require("cheerio");
const express = require("express");

const BASE_URL = "https://sktorrent.eu";
const SEARCH_URL = `${BASE_URL}/torrent/torrents_v2.php`;
const RD_API = "https://api.real-debrid.com/rest/1.0";
const PORT = process.env.PORT || 7000;
const SKT_UID = process.env.SKT_UID || "";
const SKT_PASS = process.env.SKT_PASS || "";

const langToFlag = { CZ:"🇨🇿",SK:"🇸🇰",EN:"🇬🇧",US:"🇺🇸",DE:"🇩🇪",FR:"🇫🇷",IT:"🇮🇹",ES:"🇪🇸",RU:"🇷🇺",PL:"🇵🇱",HU:"🇭🇺",JP:"🇯🇵" };
const VIDEO_EXT = [".mkv",".mp4",".avi",".mov",".wmv",".flv",".webm",".ts",".m4v"];
function removeDiacritics(s){return s.normalize("NFD").replace(/[\u0300-\u036f]/g,"");}
function shortenTitle(s,n=3){return s.split(/\s+/).slice(0,n).join(" ");}
function isMultiSeason(s){return /(S\d{2}E\d{2}-\d{2}|Complete|All Episodes|Season \d+(-\d+)?)/i.test(s);}
function isVideo(f){return VIDEO_EXT.some(e=>f.toLowerCase().endsWith(e));}

const resolveCache=new Map();
const CACHE_TTL=3600000;

async function getTitle(imdbId){
    try{const r=await axios.get(`https://www.omdbapi.com/?i=${imdbId}&apikey=91fa16b4`,{timeout:5000});if(r.data?.Title){console.log(`[OMDb] "${r.data.Title}" (${r.data.Year})`);return{title:r.data.Title,original:r.data.Title,year:r.data.Year||""};}}catch(e){}
    try{const r=await axios.get(`https://www.imdb.com/title/${imdbId}/`,{headers:{"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"},timeout:8000});const $=cheerio.load(r.data);const title=decode($('title').text().split(' - ')[0].trim());let orig=title;const ld=$('script[type="application/ld+json"]').html();if(ld){try{const j=JSON.parse(ld);if(j?.name)orig=decode(j.name.trim());}catch(e){}}return{title,original:orig,year:""};}catch(e){console.error("[IMDb]",e.message);return null;}
}

async function searchSKT(query){
    console.log(`[SKT] 🔎 "${query}"`);
    try{
        const hdrs={"User-Agent":"Mozilla/5.0"};
        if(SKT_UID&&SKT_PASS) hdrs.Cookie=`uid=${SKT_UID}; pass=${SKT_PASS}`;
        const r=await axios.get(SEARCH_URL,{params:{search:query,category:0,active:0},headers:hdrs,timeout:10000});
        const $=cheerio.load(r.data);const results=[];

        // Metoda 1: obrázková verze torrents_v2 - jen odkazy s posterem (img)
        $('a[href*="details.php"] img').each((i,img)=>{
            const el=$(img).closest('a');
            const href=el.attr("href")||"";
            const m=href.match(/id=([a-fA-F0-9]{40})/);
            if(!m)return;
            const hash=m[1].toLowerCase();
            if(results.find(r=>r.hash===hash))return;

            // Název z title atributu odkazu (tooltip)
            const name=el.attr("title")||"";
            if(!name||name.length<3)return;

            // Metadata z okolního TD
            const td=el.closest("td");
            const block=td.text().replace(/\s+/g,' ').trim();

            // Skutečný torrent musí mít "Velkost" (velikost) v bloku - komentáře to nemají
            const szM=block.match(/Velkost\s([^|]+)/i);
            if(!szM)return;

            const cat=td.find("b").first().text().trim();
            const sdM=block.match(/Odosielaju\s*:\s*(\d+)/i);

            results.push({name,hash,size:szM[1].trim(),seeds:sdM?parseInt(sdM[1]):0,cat});
        });

        // Metoda 2: fallback tabulková verze (torrents.php)
        if(results.length===0){
            $("table.lista tr").each((i,row)=>{
                const cells=$(row).find("td.lista");
                if(cells.length<2)return;
                const link=cells.eq(1).find("a[href*='details.php']");
                const href=link.attr("href")||"";
                const m=href.match(/id=([a-fA-F0-9]{40})/);
                if(!m)return;
                const hash=m[1].toLowerCase();
                if(results.find(r=>r.hash===hash))return;
                results.push({name:link.text().trim(),hash,size:cells.eq(5)?.text().trim()||"?",seeds:parseInt(cells.eq(6)?.text().trim())||0,cat:cells.eq(0)?.text().trim()||""});
            });
        }

        console.log(`[SKT] Nalezeno: ${results.length}`);
        return results;
    }catch(e){console.error("[SKT]",e.message);return[];}
}

function rdH(t){return{Authorization:`Bearer ${t}`,"Content-Type":"application/x-www-form-urlencoded"};}

async function rdAddMagnet(token,hash){
    const magnet=`magnet:?xt=urn:btih:${hash}&tr=udp://tracker.opentrackr.org:1337/announce&tr=udp://tracker.openbittorrent.com:80/announce&tr=udp://ipv4announce.sktorrent.eu:6969/announce`;
    try{const r=await axios.post(`${RD_API}/torrents/addMagnet`,`magnet=${encodeURIComponent(magnet)}`,{headers:rdH(token),timeout:15000});return r.data.id;}
    catch(e){console.error("[RD] addMagnet:",e.response?.data?.error||e.message);return null;}
}
async function rdInfo(token,id){try{return(await axios.get(`${RD_API}/torrents/info/${id}`,{headers:{Authorization:`Bearer ${token}`},timeout:10000})).data;}catch(e){return null;}}
async function rdSelect(token,id,files){try{await axios.post(`${RD_API}/torrents/selectFiles/${id}`,`files=${files}`,{headers:rdH(token),timeout:10000});return true;}catch(e){console.error("[RD] select:",e.response?.data?.error||e.message);return false;}}
async function rdUnrestrict(token,link){try{return(await axios.post(`${RD_API}/unrestrict/link`,`link=${encodeURIComponent(link)}`,{headers:rdH(token),timeout:10000})).data.download;}catch(e){return null;}}
async function rdDelete(token,id){try{await axios.delete(`${RD_API}/torrents/delete/${id}`,{headers:{Authorization:`Bearer ${token}`},timeout:5000});}catch(e){}}
async function rdVerify(token){try{return(await axios.get(`${RD_API}/user`,{headers:{Authorization:`Bearer ${token}`},timeout:5000})).data;}catch(e){return null;}}

async function resolveRD(token,hash,season,episode){
    const ck=`${hash}-${season}-${episode}`;const cached=resolveCache.get(ck);
    if(cached&&Date.now()-cached.ts<CACHE_TTL){console.log("[RD] ✅ Cache hit");return cached.url;}
    console.log(`[RD] Resolving: ${hash}`);
    const tid=await rdAddMagnet(token,hash);if(!tid)return null;
    let info;
    for(let i=0;i<15;i++){info=await rdInfo(token,tid);if(!info){await rdDelete(token,tid);return null;}
        if(info.status==="downloaded"&&info.links?.length>0){const url=await rdUnrestrict(token,info.links[0]);if(url){resolveCache.set(ck,{url,ts:Date.now()});console.log("[RD] ✅ Cached");return url;}await rdDelete(token,tid);return null;}
        if(info.status==="waiting_files_selection")break;
        if(["magnet_error","error","virus","dead"].includes(info.status)){await rdDelete(token,tid);return null;}
        await new Promise(r=>setTimeout(r,1000));
    }
    if(info.status==="waiting_files_selection"&&info.files?.length>0){
        const videos=info.files.filter(f=>isVideo(f.path));let fid;
        if(videos.length===0)fid="all";
        else if(season!==undefined&&episode!==undefined&&videos.length>1){
            const pats=[new RegExp(`S${String(season).padStart(2,'0')}E${String(episode).padStart(2,'0')}`,'i'),new RegExp(`${season}x${String(episode).padStart(2,'0')}`,'i'),new RegExp(`[._\\-\\s]E${String(episode).padStart(2,'0')}[._\\-\\s]`,'i')];
            let hit=null;for(const p of pats){hit=videos.find(f=>p.test(f.path));if(hit)break;}
            fid=hit?String(hit.id):String(videos.reduce((a,b)=>a.bytes>b.bytes?a:b).id);
        }else{fid=String(videos.reduce((a,b)=>a.bytes>b.bytes?a:b).id);}
        if(!(await rdSelect(token,tid,fid))){await rdDelete(token,tid);return null;}
    }else if(info.status!=="downloaded"){await rdDelete(token,tid);return null;}
    for(let i=0;i<30;i++){info=await rdInfo(token,tid);if(!info)return null;
        if(info.status==="downloaded"&&info.links?.length>0){const url=await rdUnrestrict(token,info.links[0]);if(url){resolveCache.set(ck,{url,ts:Date.now()});console.log("[RD] ✅ Ready");return url;}return null;}
        if(["magnet_error","error","virus","dead"].includes(info.status)){await rdDelete(token,tid);return null;}
        await new Promise(r=>setTimeout(r,1000));
    }
    return null;
}

function buildQueries(title,original,type,season,episode){
    const q=[];
    const bases=[...new Set([title,original].map(t=>t.replace(/\(.*?\)/g,'').replace(/TV (Mini )?Series/gi,'').trim()).filter(Boolean))];
    
    for(const base of bases){
        const nd=removeDiacritics(base),sh=shortenTitle(nd);
        const variants=[...new Set([base,nd,sh].flatMap(b=>[b,b.replace(/[':]/g,'')]).filter(Boolean))];
        
        if(type==='series'&&season&&episode){
            const ep=`S${String(season).padStart(2,'0')}E${String(episode).padStart(2,'0')}`;
            const se=`S${String(season).padStart(2,'0')}`;
            const sn=String(season);
            // 1. Přesná epizoda: "Archer S01E01"
            for(const v of variants){if(!q.includes(v+' '+ep))q.push(v+' '+ep);}
            // 2. Celá série (batch): "Archer S01"
            for(const v of variants){if(!q.includes(v+' '+se))q.push(v+' '+se);}
            // 3. CZ/SK formáty: "Archer 1.serie", "Archer 1. seria", "Archer serie 1"
            for(const v of variants){
                const a=v+' '+sn+'.serie';if(!q.includes(a))q.push(a);
                const b=v+' '+sn+'. serie';if(!q.includes(b))q.push(b);
                const c=v+' '+sn+'.seria';if(!q.includes(c))q.push(c);
                const d=v+' '+sn+'. seria';if(!q.includes(d))q.push(d);
                const e2=v+' serie '+sn;if(!q.includes(e2))q.push(e2);
                const f=v+' seria '+sn;if(!q.includes(f))q.push(f);
            }
            // 4. Holý název jako poslední fallback: "Archer"
            for(const v of variants){if(!q.includes(v))q.push(v);}
        } else {
            for(const v of variants){if(!q.includes(v))q.push(v);}
        }
    }
    return q;
}

const app=express();
app.get("/",(req,res)=>{res.setHeader("Content-Type","text/html; charset=utf-8");res.send(html());});
app.get("/configure",(req,res)=>{res.setHeader("Content-Type","text/html; charset=utf-8");res.send(html());});

app.get("/:token/manifest.json",(req,res)=>{
    res.setHeader("Access-Control-Allow-Origin","*");res.setHeader("Access-Control-Allow-Headers","*");res.setHeader("Content-Type","application/json");
    res.json({id:"org.stremio.sktorrent.rd",version:"2.3.0",name:"SKTorrent+RD",description:"CZ/SK torrenty ze sktorrent.eu s Real-Debrid",types:["movie","series"],catalogs:[],resources:["stream"],idPrefixes:["tt"],behaviorHints:{configurable:true,configurationRequired:false}});
});

// STREAM - jen zobrazí torrenty, žádné RD volání
app.get("/:token/stream/:type/:id.json",async(req,res)=>{
    res.setHeader("Access-Control-Allow-Origin","*");res.setHeader("Access-Control-Allow-Headers","*");res.setHeader("Content-Type","application/json");
    const{token,type,id}=req.params;const[imdbId,sRaw,eRaw]=id.split(":");
    const season=sRaw?parseInt(sRaw):undefined;const episode=eRaw?parseInt(eRaw):undefined;
    console.log(`\n🎬 ${type} ${imdbId} S${season??'-'}E${episode??'-'}`);
    try{
        const titles=await getTitle(imdbId);if(!titles)return res.json({streams:[]});
        const queries=buildQueries(titles.title,titles.original,type,season,episode);
        let torrents=[];
        let batchTorrents=[];
        const epTag=season!==undefined?`S${String(season).padStart(2,'0')}E${String(episode).padStart(2,'0')}`:'';
        const seTag=season!==undefined?`S${String(season).padStart(2,'0')}`:'';
        const sn=season!==undefined?String(season):'';
        
        // Kontrola jestli název obsahuje správnou sezónu (S01 nebo 1.serie/seria)
        const matchesSeason=(name)=>{
            const up=name.toUpperCase();
            if(up.includes(seTag))return true;
            // CZ/SK: "1.serie", "1. serie", "1.seria", "serie 1", "seria 1"
            const czPat=new RegExp(`(^|\\W)${sn}\\s*\\.?\\s*seri[ea]|seri[ea]\\s*${sn}(\\W|$)`,'i');
            return czPat.test(name);
        };
        const matchesEpisode=(name)=>name.toUpperCase().includes(epTag);
        
        if(type==='series'&&season!==undefined){
            // 1. Hledej přesnou epizodu
            for(const q of queries){
                if(!q.toUpperCase().includes(epTag))continue;
                const found=await searchSKT(q);
                if(found.length>0){
                    const filtered=found.filter(t=>matchesEpisode(t.name)||matchesSeason(t.name));
                    if(filtered.length>0){torrents=filtered;break;}
                }
            }
            // 2. Hledej i batch (S01, 1.serie) — vždy, i když máme epizodu
            for(const q of queries){
                const qu=q.toUpperCase();
                if(qu.includes(epTag))continue;
                if(!qu.includes(seTag)&&!/\bseri[ea]\b/i.test(q)&&!new RegExp(`\\b${sn}\\b`).test(q))continue;
                const found=await searchSKT(q);
                if(found.length>0){
                    const filtered=found.filter(t=>matchesSeason(t.name)&&!matchesEpisode(t.name));
                    if(filtered.length>0){batchTorrents=filtered;break;}
                }
            }
            // 3. Fallback: holý název filtrovaný na sezónu
            if(torrents.length===0&&batchTorrents.length===0){
                for(const q of queries){
                    const qu=q.toUpperCase();
                    if(qu.includes(seTag)||qu.includes(epTag)||/seri[ea]/i.test(q))continue;
                    const found=await searchSKT(q);
                    if(found.length>0){
                        const epF=found.filter(t=>matchesEpisode(t.name));
                        const seF=found.filter(t=>matchesSeason(t.name)&&!matchesEpisode(t.name));
                        if(epF.length>0)torrents=epF;
                        if(seF.length>0)batchTorrents=seF;
                        if(torrents.length>0||batchTorrents.length>0)break;
                    }
                }
            }
        } else {
            for(const q of queries){torrents=await searchSKT(q);if(torrents.length>0)break;}
        }
        
        if(!torrents.length&&!batchTorrents.length)return res.json({streams:[]});
        const proto=req.headers['x-forwarded-proto']||req.protocol;
        const host=req.headers['x-forwarded-host']||req.get('host');
        const baseUrl=`${proto}://${host}`;
        const streams=[];const seen=new Set();
        // Rok z OMDb - kontroluj jen u filmů
        const omdbYear=(type==='movie'&&titles.year)?titles.year.replace(/[–-].*$/,'').trim():"";
        
        // Pomocná funkce pro přidání torrentu do streams
        const addStream=(t,isBatch)=>{
            if(isMultiSeason(t.name)||seen.has(t.hash))return;seen.add(t.hash);
            if(omdbYear){
                const yearMatches=t.name.match(/\b(19|20)\d{2}\b/g);
                if(yearMatches&&yearMatches.length>0&&!yearMatches.some(y=>y===omdbYear)){
                    console.log(`[SKT] ⏭️ Rok nesedí: "${t.name}" (hledám ${omdbYear})`);return;
                }
            }
            const flags=(t.name.match(/\b([A-Z]{2})\b/g)||[]).map(c=>langToFlag[c]).filter(Boolean);
            const flagStr=flags.length?` ${flags.join("/")}`:"";
            let clean=t.name.replace(/^Stiahni si\s*/i,"").trim();
            // Odstraň kategorii ze začátku názvu (např. "Filmy Kreslené Zootropolis..." → "Zootropolis...")
            if(t.cat&&clean.startsWith(t.cat)){
                clean=clean.slice(t.cat.length).trim();
            }
            const se=season!==undefined?`/${season}/${episode}`:'';
            const proxyUrl=`${baseUrl}/${token}/play/${t.hash}${se}/video.mp4`;
            const batchLabel=isBatch?` 📦 ${epTag} Batch`:'';
            const cat=t.cat||'SKT';
            streams.push({
                name:`SKT+RD\n${cat}`,
                description:`${clean}${batchLabel}\n👤 ${t.seeds}  📀 ${t.size}${flagStr}\n⚡ Real-Debrid`,
                url:proxyUrl,
                behaviorHints:{bingeGroup:`skt-rd-${t.hash.slice(0,8)}`,notWebReady:true}
            });
        };
        
        // Nejdřív přesné epizody
        for(const t of torrents){addStream(t,false);if(streams.length>=12)break;}
        // Pak batch výsledky
        for(const t of batchTorrents){addStream(t,true);if(streams.length>=15)break;}
        
        console.log(`✅ ${streams.length} streams`);return res.json({streams});
    }catch(e){console.error("Error:",e.message);return res.json({streams:[]});}
});

// PLAY - resolve RD a redirect (žádný proxy)
app.get("/:token/play/:hash/:season?/:episode?/video.mp4",async(req,res)=>{
    const{token,hash}=req.params;
    const season=req.params.season?parseInt(req.params.season):undefined;
    const episode=req.params.episode?parseInt(req.params.episode):undefined;
    console.log(`\n▶️ Play: ${hash} S${season??'-'}E${episode??'-'}`);
    const streamUrl=await resolveRD(token,hash,season,episode);
    if(!streamUrl){console.error("[Play] ❌ Failed");return res.status(502).send("Failed to resolve via Real-Debrid");}
    console.log(`[Play] ✅ Redirect → ${streamUrl.slice(0,80)}...`);
    return res.redirect(302,streamUrl);
});

app.get("/api/verify/:token",async(req,res)=>{res.setHeader("Access-Control-Allow-Origin","*");const u=await rdVerify(req.params.token);res.json(u?{success:true,username:u.username,type:u.type,expiration:u.expiration}:{success:false});});

function html(){return`<!DOCTYPE html><html lang="cs"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SKTorrent+RD | Stremio</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:linear-gradient(135deg,#0f0c29,#1a1a3e,#24243e);color:#e0e0e0;min-height:100vh;display:flex;justify-content:center;align-items:center;padding:20px}.c{background:rgba(30,30,60,.85);backdrop-filter:blur(20px);border-radius:20px;padding:40px;max-width:500px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.5);border:1px solid rgba(255,255,255,.08)}h1{font-size:26px;background:linear-gradient(to right,#fff,#8b5cf6);-webkit-background-clip:text;-webkit-text-fill-color:transparent;text-align:center;margin-bottom:6px}.sub{text-align:center;color:#9ca3af;font-size:13px;margin-bottom:24px}.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;margin:0 3px}.b-rd{background:#059669;color:#fff}.b-sk{background:#dc2626;color:#fff}.info{background:rgba(139,92,246,.1);border:1px solid rgba(139,92,246,.3);border-radius:12px;padding:14px;margin-bottom:20px;font-size:13px;line-height:1.5;color:#c4b5fd}.info a{color:#a78bfa}label{display:block;margin-bottom:6px;font-size:14px;color:#d1d5db;font-weight:500}input{width:100%;padding:14px;border-radius:12px;border:1px solid rgba(255,255,255,.12);background:rgba(0,0,0,.3);color:#fff;font-size:15px;outline:none;margin-bottom:16px}input:focus{border-color:#8b5cf6}.btn{width:100%;padding:14px;border:none;border-radius:14px;font-size:16px;font-weight:600;cursor:pointer;margin-bottom:10px;color:#fff;transition:all .2s}.bv{background:linear-gradient(135deg,#059669,#10b981)}.bi{background:linear-gradient(135deg,#7c3aed,#8b5cf6);display:none}.btn:hover{opacity:.9;transform:translateY(-1px)}.st{text-align:center;margin:12px 0;font-size:14px;min-height:20px}.ok{color:#34d399}.er{color:#f87171}.lo{color:#fbbf24}.url{background:rgba(0,0,0,.4);border-radius:10px;padding:12px;margin-top:10px;word-break:break-all;font-family:monospace;font-size:12px;color:#a78bfa;display:none}.cp{display:inline-block;padding:4px 12px;font-size:12px;background:rgba(139,92,246,.2);border:1px solid rgba(139,92,246,.4);color:#c4b5fd;border-radius:6px;cursor:pointer;margin-top:8px}.ft{margin-top:20px;padding-top:16px;border-top:1px solid rgba(255,255,255,.08);display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:13px;color:#d1d5db}.ft div::before{content:"✓ ";color:#34d399}</style></head><body><div class="c"><h1>SKTorrent + Real-Debrid</h1><div class="sub">Stremio Addon <span class="badge b-sk">SKT</span><span class="badge b-rd">RD</span></div><div class="info">Prohledává <b>sktorrent.eu</b> a streamuje přes <b>Real-Debrid</b>.<br>Bez registrace na SKTorrent.<br><br>API klíč: <a href="https://real-debrid.com/apitoken" target="_blank">real-debrid.com/apitoken</a></div><label>Real-Debrid API Token</label><input type="text" id="t" placeholder="Vlož API token..." autocomplete="off"><button class="btn bv" onclick="verify()">🔑 Ověřit token</button><div class="st" id="s"></div><button class="btn bi" id="ib" onclick="install()">📦 Nainstalovat do Stremio</button><div class="url" id="u"></div><div class="ft"><div>CZ/SK torrenty</div><div>Real-Debrid stream</div><div>Filmy & seriály</div><div>Bez registrace SKT</div><div>Auto výběr epizod</div><div>Rychlé zobrazení</div></div></div><script>const B=location.origin;async function verify(){const t=document.getElementById('t').value.trim(),s=document.getElementById('s'),ib=document.getElementById('ib'),u=document.getElementById('u');if(!t){s.className='st er';s.textContent='❌ Zadej token';return}s.className='st lo';s.textContent='⏳ Ověřuji...';try{const r=await(await fetch(B+'/api/verify/'+t)).json();if(r.success){const d=new Date(r.expiration).toLocaleDateString('cs-CZ');s.className='st ok';s.textContent='✅ '+r.username+' ('+r.type+') | do: '+d;ib.style.display='block';u.style.display='block';const m=B+'/'+t+'/manifest.json';u.innerHTML=m+'<br><span class="cp" onclick="copyUrl()">📋 Kopírovat URL</span>'}else{s.className='st er';s.textContent='❌ Neplatný token';ib.style.display='none';u.style.display='none'}}catch(e){s.className='st er';s.textContent='❌ Chyba: '+e.message}}function install(){const t=document.getElementById('t').value.trim();if(!t)return;window.location.href='stremio://'+B.replace(/https?:\\/\\//,'')+'/'+t+'/manifest.json'}function copyUrl(){const t=document.getElementById('t').value.trim();navigator.clipboard.writeText(B+'/'+t+'/manifest.json').then(()=>{const c=document.querySelector('.cp');c.textContent='✅ Zkopírováno';setTimeout(()=>c.textContent='📋 Kopírovat URL',2000)})}document.getElementById('t').addEventListener('keypress',e=>{if(e.key==='Enter')verify()});</script></body></html>`;}

app.listen(PORT,()=>console.log(`🚀 SKTorrent+RD http://localhost:${PORT}`));
