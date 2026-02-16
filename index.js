// SKTorrent + Real-Debrid Stremio Addon v2.4
// TMDB pro CZ/SK názvy, OMDb jako záloha
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

// Token format: "RDTOKEN--TMDBKEY" nebo jen "RDTOKEN"
function parseToken(token){
    const parts=token.split("--");
    return { rdToken: parts[0], tmdbKey: parts[1]||"" };
}

// ============ TMDB API ============
async function getTitleTMDB(imdbId, tmdbKey){
    try{
        // Find by IMDb ID
        const find=await axios.get(`https://api.themoviedb.org/3/find/${imdbId}?api_key=${tmdbKey}&external_source=imdb_id`,{timeout:5000});
        const d=find.data;
        let item=d.movie_results?.[0]||d.tv_results?.[0];
        if(!item)return null;

        const isTV=!!d.tv_results?.[0];
        const enTitle=isTV?(item.name||item.original_name):(item.title||item.original_title);
        const origTitle=item.original_title||item.original_name||enTitle;
        const year=isTV?(item.first_air_date||"").slice(0,4):(item.release_date||"").slice(0,4);

        // Fetch CZ title
        const tmdbId=item.id;
        const type=isTV?"tv":"movie";
        let czTitle="",skTitle="";
        try{
            const cz=await axios.get(`https://api.themoviedb.org/3/${type}/${tmdbId}?api_key=${tmdbKey}&language=cs-CZ`,{timeout:5000});
            czTitle=isTV?(cz.data.name||""):(cz.data.title||"");
        }catch(e){}
        try{
            const sk=await axios.get(`https://api.themoviedb.org/3/${type}/${tmdbId}?api_key=${tmdbKey}&language=sk-SK`,{timeout:5000});
            skTitle=isTV?(sk.data.name||""):(sk.data.title||"");
        }catch(e){}

        const titles=[enTitle,origTitle,czTitle,skTitle].filter(Boolean);
        console.log(`[TMDB] EN:"${enTitle}" CZ:"${czTitle}" SK:"${skTitle}" (${year})`);
        return { title:czTitle||enTitle, original:origTitle, en:enTitle, cz:czTitle, sk:skTitle, year, all:[...new Set(titles)] };
    }catch(e){console.error("[TMDB]",e.message);return null;}
}

// ============ OMDb (záloha) ============
async function getTitleOMDB(imdbId){
    try{
        const r=await axios.get(`https://www.omdbapi.com/?i=${imdbId}&apikey=91fa16b4`,{timeout:5000});
        if(r.data?.Title){
            console.log(`[OMDb] "${r.data.Title}" (${r.data.Year})`);
            return { title:r.data.Title, original:r.data.Title, en:r.data.Title, cz:"", sk:"", year:r.data.Year||"", all:[r.data.Title] };
        }
    }catch(e){}
    return null;
}

// Hlavní funkce - TMDB first, OMDb fallback
async function getTitle(imdbId, tmdbKey){
    if(tmdbKey){
        const t=await getTitleTMDB(imdbId, tmdbKey);
        if(t)return t;
        console.log("[TMDB] Fallback na OMDb");
    }
    return await getTitleOMDB(imdbId);
}

// ============ SKTORRENT ============
let sktRateLimited=false;

async function searchSKT(query){
    if(sktRateLimited){console.log(`[SKT] ⏸️ Rate limited, skip "${query}"`);return[];}
    console.log(`[SKT] 🔎 "${query}"`);
    try{
        const hdrs={"User-Agent":"Mozilla/5.0"};
        if(SKT_UID&&SKT_PASS) hdrs.Cookie=`uid=${SKT_UID}; pass=${SKT_PASS}`;
        const r=await axios.get(SEARCH_URL,{params:{search:query,category:0,active:0},headers:hdrs,timeout:10000});
        const $=cheerio.load(r.data);const results=[];

        $('a[href*="details.php"] img').each((i,img)=>{
            const el=$(img).closest('a');
            const href=el.attr("href")||"";
            const m=href.match(/id=([a-fA-F0-9]{40})/);
            if(!m)return;
            const hash=m[1].toLowerCase();
            if(results.find(r=>r.hash===hash))return;
            const name=el.attr("title")||"";
            if(!name||name.length<3)return;
            const td=el.closest("td");
            const block=td.text().replace(/\s+/g,' ').trim();
            const szM=block.match(/Velkost\s([^|]+)/i);
            if(!szM)return;
            const cat=td.find("b").first().text().trim();
            const sdM=block.match(/Odosielaju\s*:\s*(\d+)/i);
            results.push({name,hash,size:szM[1].trim(),seeds:sdM?parseInt(sdM[1]):0,cat});
        });

        if(results.length===0){
            $("table.lista tr").each((i,row)=>{
                const cells=$(row).find("td.lista");if(cells.length<2)return;
                const link=cells.eq(1).find("a[href*='details.php']");
                const href=link.attr("href")||"";const m=href.match(/id=([a-fA-F0-9]{40})/);if(!m)return;
                const hash=m[1].toLowerCase();if(results.find(r=>r.hash===hash))return;
                results.push({name:link.text().trim(),hash,size:cells.eq(5)?.text().trim()||"?",seeds:parseInt(cells.eq(6)?.text().trim())||0,cat:cells.eq(0)?.text().trim()||""});
            });
        }
        console.log(`[SKT] Nalezeno: ${results.length}`);return results;
    }catch(e){
        if(e.response?.status===403){
            console.error("[SKT] ⛔ 403 Rate limit - pausing");
            sktRateLimited=true;
            setTimeout(()=>{sktRateLimited=false;},60000); // Reset po 60s
        }else{console.error("[SKT]",e.message);}
        return[];
    }
}

// Delay helper
const delay=(ms)=>new Promise(r=>setTimeout(r,ms));

// ============ REAL-DEBRID ============
function rdH(t){return{Authorization:`Bearer ${t}`,"Content-Type":"application/x-www-form-urlencoded"};}
async function rdAddMagnet(token,hash){
    const magnet=`magnet:?xt=urn:btih:${hash}&tr=udp://tracker.opentrackr.org:1337/announce&tr=udp://tracker.openbittorrent.com:80/announce&tr=udp://ipv4announce.sktorrent.eu:6969/announce`;
    try{const r=await axios.post(`${RD_API}/torrents/addMagnet`,`magnet=${encodeURIComponent(magnet)}`,{headers:rdH(token),timeout:15000});console.log(`[RD] Magnet added: ${r.data.id}`);return r.data.id;}
    catch(e){console.error("[RD] addMagnet:",e.response?.data?.error||e.message);return null;}
}
async function rdInfo(token,id){try{return(await axios.get(`${RD_API}/torrents/info/${id}`,{headers:{Authorization:`Bearer ${token}`},timeout:10000})).data;}catch(e){return null;}}
async function rdSelect(token,id,files){try{await axios.post(`${RD_API}/torrents/selectFiles/${id}`,`files=${files}`,{headers:rdH(token),timeout:10000});console.log(`[RD] Selected: ${files}`);return true;}catch(e){console.error("[RD] select:",e.response?.data?.error||e.message);return false;}}
async function rdUnrestrict(token,link){try{return(await axios.post(`${RD_API}/unrestrict/link`,`link=${encodeURIComponent(link)}`,{headers:rdH(token),timeout:10000})).data.download;}catch(e){return null;}}
async function rdDelete(token,id){try{await axios.delete(`${RD_API}/torrents/delete/${id}`,{headers:{Authorization:`Bearer ${token}`},timeout:5000});}catch(e){}}
async function rdVerify(token){try{return(await axios.get(`${RD_API}/user`,{headers:{Authorization:`Bearer ${token}`},timeout:5000})).data;}catch(e){return null;}}

// RD Instant Availability - zjistí které hashe jsou v cache bez stahování
async function rdInstantAvail(token,hashes){
    if(!hashes.length)return new Set();
    try{
        const url=`${RD_API}/torrents/instantAvailability/${hashes.join('/')}`;
        const r=await axios.get(url,{headers:{Authorization:`Bearer ${token}`},timeout:8000});
        const cached=new Set();
        for(const[hash,data] of Object.entries(r.data||{})){
            // Pokud má 'rd' pole s aspoň jedním záznamem → je v cache
            if(data?.rd?.length>0)cached.add(hash.toLowerCase());
        }
        console.log(`[RD] ⚡ Cache: ${cached.size}/${hashes.length}`);
        return cached;
    }catch(e){console.error("[RD] instantAvail:",e.response?.data?.error||e.message);return new Set();}
}

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

// ============ QUERIES ============
// Generuje minimální sadu queries: EN název, CZ název, zkrácené varianty
function buildSearchNames(titles){
    const names=[];
    const add=(s)=>{s=s?.trim();if(s&&s.length>=2&&!names.includes(s))names.push(s);};
    
    // EN název (primární)
    const en=(titles.en||titles.title||'').replace(/\(.*?\)/g,'').replace(/TV (Mini )?Series/gi,'').trim();
    if(en){
        add(en);
        add(removeDiacritics(en));
        // Bez subtitle
        if(en.includes(':'))add(en.split(':')[0].trim());
        if(en.includes(' - '))add(en.split(' - ')[0].trim());
    }
    
    // CZ název (sekundární) - jen pokud se liší od EN a je v latince
    const cz=(titles.cz||'').replace(/\(.*?\)/g,'').replace(/TV (Mini )?Series/gi,'').trim();
    const isLatin=(s)=>/[a-zA-Z]/.test(s); // Musí obsahovat aspoň jedno latinské písmeno
    if(cz&&cz!==en&&isLatin(cz)){
        add(cz);
        add(removeDiacritics(cz));
        if(cz.includes(':'))add(cz.split(':')[0].trim());
        if(cz.includes(':'))add(removeDiacritics(cz.split(':')[0].trim()));
    }
    
    return names;
}

// ============ EXPRESS ============
const app=express();
app.get("/",(req,res)=>{res.setHeader("Content-Type","text/html; charset=utf-8");res.send(html());});
app.get("/configure",(req,res)=>{res.setHeader("Content-Type","text/html; charset=utf-8");res.send(html());});

app.get("/:token/manifest.json",(req,res)=>{
    res.setHeader("Access-Control-Allow-Origin","*");res.setHeader("Access-Control-Allow-Headers","*");res.setHeader("Content-Type","application/json");
    res.json({id:"org.stremio.sktorrent.rd",version:"2.4.0",name:"SKTorrent+RD",description:"CZ/SK torrenty ze sktorrent.eu s Real-Debrid",types:["movie","series"],catalogs:[],resources:["stream"],idPrefixes:["tt"],behaviorHints:{configurable:true,configurationRequired:false}});
});

// STREAM
app.get("/:token/stream/:type/:id.json",async(req,res)=>{
    res.setHeader("Access-Control-Allow-Origin","*");res.setHeader("Access-Control-Allow-Headers","*");res.setHeader("Content-Type","application/json");
    const{type,id}=req.params;
    const{rdToken,tmdbKey}=parseToken(req.params.token);
    const[imdbId,sRaw,eRaw]=id.split(":");
    const season=sRaw?parseInt(sRaw):undefined;const episode=eRaw?parseInt(eRaw):undefined;
    console.log(`\n🎬 ${type} ${imdbId} S${season??'-'}E${episode??'-'}`);
    try{
        const titles=await getTitle(imdbId,tmdbKey);if(!titles)return res.json({streams:[]});
        const names=buildSearchNames(titles);
        let torrents=[];
        let batchTorrents=[];
        const epTag=season!==undefined?`S${String(season).padStart(2,'0')}E${String(episode).padStart(2,'0')}`:'';
        const seTag=season!==undefined?`S${String(season).padStart(2,'0')}`:'';
        const sn=season!==undefined?String(season):'';

        const matchesExactEpisode=(name)=>name.toUpperCase().includes(epTag);
        const hasAnyEpisode=(name)=>new RegExp(seTag+'E\\d{2}','i').test(name);
        const isBatchSeason=(name)=>{
            const up=name.toUpperCase();
            const hasSe=up.includes(seTag)||(new RegExp(`(^|\\W)${sn}\\s*\\.?\\s*seri[ea]|seri[ea]\\s*${sn}(\\W|$)`,'i')).test(name);
            return hasSe&&!hasAnyEpisode(name);
        };

        // Rok z TMDB - pro filtrování (jen filmy)
        const omdbYear=(type==='movie'&&titles.year)?titles.year.replace(/[–-].*$/,'').trim():"";
        
        // Filtr roku - vrátí jen torrenty se správným rokem (nebo bez roku)
        const filterYear=(list)=>{
            if(!omdbYear)return list;
            return list.filter(t=>{
                const yearMatches=t.name.match(/\b(19|20)\d{2}\b/g);
                if(!yearMatches||yearMatches.length===0)return true; // Nemá rok → projde
                const ok=yearMatches.some(y=>y===omdbYear);
                if(!ok)console.log(`[SKT] ⏭️ Rok nesedí: "${t.name}" (hledám ${omdbYear})`);
                return ok;
            });
        };

        // Hledej postupně každý název
        async function searchWithName(name){
            if(sktRateLimited)return;
            if(type==='series'&&season!==undefined){
                // 1. Přesná epizoda
                if(!torrents.length){
                    const found=filterYear(await searchSKT(name+' '+epTag));
                    if(found.length>0){
                        const ep=found.filter(t=>matchesExactEpisode(t.name));
                        const batch=found.filter(t=>isBatchSeason(t.name));
                        if(ep.length>0)torrents=ep;
                        if(batch.length>0&&!batchTorrents.length)batchTorrents=batch;
                    }
                    await delay(300);
                }
                // 2. Sezóna batch
                if(!batchTorrents.length&&!sktRateLimited){
                    const found=filterYear(await searchSKT(name+' '+seTag));
                    if(found.length>0){
                        const batch=found.filter(t=>isBatchSeason(t.name));
                        if(batch.length>0)batchTorrents=batch;
                        if(!torrents.length){
                            const ep=found.filter(t=>matchesExactEpisode(t.name));
                            if(ep.length>0)torrents=ep;
                        }
                    }
                    await delay(300);
                }
                // 3. Holý název - pokud najde ale nic nemá S01/epizodu, ber jako batch
                if(!torrents.length&&!batchTorrents.length&&!sktRateLimited){
                    const found=filterYear(await searchSKT(name));
                    if(found.length>0){
                        const ep=found.filter(t=>matchesExactEpisode(t.name));
                        const batch=found.filter(t=>isBatchSeason(t.name));
                        if(ep.length>0)torrents=ep;
                        if(batch.length>0)batchTorrents=batch;
                        // Pokud nic nemá sezónu/epizodu — filtruj: nesmí obsahovat JINOU sezónu
                        if(!torrents.length&&!batchTorrents.length){
                            const noSeason=found.filter(t=>{
                                if(hasAnyEpisode(t.name))return false;
                                const up=t.name.toUpperCase();
                                // Pokud torrent obsahuje S[číslo], musí to být naše sezóna
                                const sMatch=up.match(/S(\d{2})/g);
                                if(sMatch){
                                    const hasMy=sMatch.some(s=>s===seTag);
                                    if(!hasMy)return false; // Obsahuje jinou sezónu (S38) → vyřadit
                                }
                                // Pokud obsahuje "[číslo].serie/seria", musí být naše
                                const czMatch=t.name.match(/(\d+)\s*\.?\s*seri[ea]/i);
                                if(czMatch&&czMatch[1]!==sn)return false;
                                return true;
                            });
                            if(noSeason.length>0){
                                batchTorrents=noSeason;
                                console.log(`[SKT] 📦 ${noSeason.length}x batch (z ${found.length} nalezených)`);
                            }
                        }
                    }
                    await delay(300);
                }
            } else {
                if(!torrents.length&&!sktRateLimited){
                    torrents=filterYear(await searchSKT(name));
                    await delay(300);
                }
            }
        }

        for(const name of names){
            await searchWithName(name);
            if(torrents.length>=3)break;
        }

        if(!torrents.length&&!batchTorrents.length)return res.json({streams:[]});
        
        // RD Instant Availability check
        const allHashes=[...new Set([...torrents,...batchTorrents].map(t=>t.hash))];
        const cachedHashes=await rdInstantAvail(rdToken,allHashes);
        
        const proto=req.headers['x-forwarded-proto']||req.protocol;
        const host=req.headers['x-forwarded-host']||req.get('host');
        const baseUrl=`${proto}://${host}`;
        const streams=[];const seen=new Set();

        const addStream=(t,isBatch)=>{
            if(isMultiSeason(t.name)||seen.has(t.hash))return;seen.add(t.hash);
            const flags=(t.name.match(/\b([A-Z]{2})\b/g)||[]).map(c=>langToFlag[c]).filter(Boolean);
            const flagStr=flags.length?` ${flags.join("/")}`:"";
            let clean=t.name.replace(/^Stiahni si\s*/i,"").trim();
            if(t.cat&&clean.startsWith(t.cat)) clean=clean.slice(t.cat.length).trim();
            const se=season!==undefined?`/${season}/${episode}`:'';
            const proxyUrl=`${baseUrl}/${req.params.token}/play/${t.hash}${se}/video.mp4`;
            const batchLabel=isBatch?` 📦 ${epTag} Batch`:'';
            const isCached=cachedHashes.has(t.hash);
            const cacheIcon=isCached?'⚡ Instant':'🕐 Stahování';
            const cat=t.cat||'SKT';
            streams.push({
                name:`SKT+RD\n${cat}`,
                description:`${clean}${batchLabel}\n👤 ${t.seeds}  📀 ${t.size}${flagStr}\n${cacheIcon}`,
                url:proxyUrl,
                behaviorHints:{bingeGroup:`skt-rd-${t.hash.slice(0,8)}`,notWebReady:true}
            });
        };

        // Seřaď cached torrenty nahoru
        const sortByCache=(a,b)=>(cachedHashes.has(b.hash)?1:0)-(cachedHashes.has(a.hash)?1:0);
        torrents.sort(sortByCache);
        batchTorrents.sort(sortByCache);
        
        for(const t of torrents){addStream(t,false);if(streams.length>=12)break;}
        for(const t of batchTorrents){addStream(t,true);if(streams.length>=15)break;}

        console.log(`✅ ${streams.length} streams`);return res.json({streams});
    }catch(e){console.error("Error:",e.message);return res.json({streams:[]});}
});

// PLAY
app.get("/:token/play/:hash/:season?/:episode?/video.mp4",async(req,res)=>{
    const{hash}=req.params;
    const{rdToken}=parseToken(req.params.token);
    const season=req.params.season?parseInt(req.params.season):undefined;
    const episode=req.params.episode?parseInt(req.params.episode):undefined;
    console.log(`\n▶️ Play: ${hash} S${season??'-'}E${episode??'-'}`);
    const streamUrl=await resolveRD(rdToken,hash,season,episode);
    if(!streamUrl){console.error("[Play] ❌ Failed");return res.status(502).send("Failed to resolve via Real-Debrid");}
    console.log(`[Play] ✅ Redirect → ${streamUrl.slice(0,80)}...`);
    return res.redirect(302,streamUrl);
});

app.get("/api/verify/:token",async(req,res)=>{
    res.setHeader("Access-Control-Allow-Origin","*");
    const u=await rdVerify(req.params.token);
    res.json(u?{success:true,username:u.username,type:u.type,expiration:u.expiration}:{success:false});
});

// ============ HTML ============
function html(){return `<!DOCTYPE html><html lang="cs"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SKTorrent+RD | Stremio</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:linear-gradient(135deg,#0f0c29,#1a1a3e,#24243e);color:#e0e0e0;min-height:100vh;display:flex;justify-content:center;align-items:center;padding:20px}
.c{background:rgba(30,30,60,.85);backdrop-filter:blur(20px);border-radius:20px;padding:40px;max-width:500px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.5);border:1px solid rgba(255,255,255,.08)}
h1{font-size:26px;background:linear-gradient(to right,#fff,#8b5cf6);-webkit-background-clip:text;-webkit-text-fill-color:transparent;text-align:center;margin-bottom:6px}
.sub{text-align:center;color:#9ca3af;font-size:13px;margin-bottom:24px}
.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;margin:0 3px}.b-rd{background:#059669;color:#fff}.b-sk{background:#dc2626;color:#fff}.b-tm{background:#01b4e4;color:#fff}
.info{background:rgba(139,92,246,.1);border:1px solid rgba(139,92,246,.3);border-radius:12px;padding:14px;margin-bottom:20px;font-size:13px;line-height:1.5;color:#c4b5fd}.info a{color:#a78bfa}
label{display:block;margin-bottom:6px;font-size:14px;color:#d1d5db;font-weight:500}
input{width:100%;padding:14px;border-radius:12px;border:1px solid rgba(255,255,255,.12);background:rgba(0,0,0,.3);color:#fff;font-size:15px;outline:none;margin-bottom:16px}input:focus{border-color:#8b5cf6}
.opt{font-size:12px;color:#9ca3af;margin:-10px 0 16px;line-height:1.4}
.btn{width:100%;padding:14px;border:none;border-radius:14px;font-size:16px;font-weight:600;cursor:pointer;margin-bottom:10px;color:#fff;transition:all .2s}
.bv{background:linear-gradient(135deg,#059669,#10b981)}.bi{background:linear-gradient(135deg,#7c3aed,#8b5cf6);display:none}.btn:hover{opacity:.9;transform:translateY(-1px)}
.st{text-align:center;margin:12px 0;font-size:14px;min-height:20px}.ok{color:#34d399}.er{color:#f87171}.lo{color:#fbbf24}
.url{background:rgba(0,0,0,.4);border-radius:10px;padding:12px;margin-top:10px;word-break:break-all;font-family:monospace;font-size:12px;color:#a78bfa;display:none}
.cp{display:inline-block;padding:4px 12px;font-size:12px;background:rgba(139,92,246,.2);border:1px solid rgba(139,92,246,.4);color:#c4b5fd;border-radius:6px;cursor:pointer;margin-top:8px}
.ft{margin-top:20px;padding-top:16px;border-top:1px solid rgba(255,255,255,.08);display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:13px;color:#d1d5db}.ft div::before{content:"✓ ";color:#34d399}
</style></head><body>
<div class="c">
<h1>SKTorrent + Real-Debrid</h1>
<div class="sub">Stremio Addon <span class="badge b-sk">SKT</span><span class="badge b-rd">RD</span><span class="badge b-tm">TMDB</span></div>
<div class="info">Prohledává <b>sktorrent.eu</b> a streamuje přes <b>Real-Debrid</b>.<br>TMDB pro české/slovenské názvy filmů.<br><br>
RD klíč: <a href="https://real-debrid.com/apitoken" target="_blank">real-debrid.com/apitoken</a><br>
TMDB klíč: <a href="https://www.themoviedb.org/settings/api" target="_blank">themoviedb.org/settings/api</a></div>

<label>Real-Debrid API Token *</label>
<input type="text" id="rd" placeholder="Vlož RD API token..." autocomplete="off">

<label>TMDB API Key (volitelné)</label>
<input type="text" id="tmdb" placeholder="Vlož TMDB API key..." autocomplete="off">
<div class="opt">Bez TMDB se hledá jen anglicky (OMDb). S TMDB se hledá i česky a slovensky.</div>

<button class="btn bv" onclick="verify()">🔑 Ověřit a nastavit</button>
<div class="st" id="s"></div>
<button class="btn bi" id="ib" onclick="install()">📦 Nainstalovat do Stremio</button>
<div class="url" id="u"></div>
<div class="ft"><div>CZ/SK torrenty</div><div>Real-Debrid stream</div><div>TMDB CZ/SK názvy</div><div>Bez registrace SKT</div><div>Auto výběr epizod</div><div>Rychlé zobrazení</div></div>
</div>
<script>
const B=location.origin;
function getToken(){
    const rd=document.getElementById('rd').value.trim();
    const tmdb=document.getElementById('tmdb').value.trim();
    return tmdb?rd+'--'+tmdb:rd;
}
async function verify(){
    const rd=document.getElementById('rd').value.trim();
    const s=document.getElementById('s'),ib=document.getElementById('ib'),u=document.getElementById('u');
    if(!rd){s.className='st er';s.textContent='❌ Zadej RD token';return}
    s.className='st lo';s.textContent='⏳ Ověřuji...';
    try{
        const r=await(await fetch(B+'/api/verify/'+rd)).json();
        if(r.success){
            const d=new Date(r.expiration).toLocaleDateString('cs-CZ');
            const tmdb=document.getElementById('tmdb').value.trim();
            const tmdbStatus=tmdb?' + TMDB ✅':' (bez TMDB)';
            s.className='st ok';s.textContent='✅ '+r.username+' ('+r.type+') | do: '+d+tmdbStatus;
            ib.style.display='block';u.style.display='block';
            const tok=getToken();const m=B+'/'+tok+'/manifest.json';
            u.innerHTML=m+'<br><span class="cp" onclick="copyUrl()">📋 Kopírovat URL</span>';
        }else{s.className='st er';s.textContent='❌ Neplatný RD token';ib.style.display='none';u.style.display='none'}
    }catch(e){s.className='st er';s.textContent='❌ Chyba: '+e.message}
}
function install(){const tok=getToken();if(!tok)return;window.location.href='stremio://'+B.replace(/https?:\\/\\//,'')+'/'+tok+'/manifest.json'}
function copyUrl(){const tok=getToken();navigator.clipboard.writeText(B+'/'+tok+'/manifest.json').then(()=>{const c=document.querySelector('.cp');c.textContent='✅ Zkopírováno';setTimeout(()=>c.textContent='📋 Kopírovat URL',2000)})}
document.getElementById('rd').addEventListener('keypress',e=>{if(e.key==='Enter')verify()});
document.getElementById('tmdb').addEventListener('keypress',e=>{if(e.key==='Enter')verify()});
</script></body></html>`;}

app.listen(PORT,()=>console.log(`🚀 SKTorrent+RD http://localhost:${PORT}`));
