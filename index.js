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

const langToFlag = { CZ:"🇨🇿",SK:"🇸🇰",EN:"🇬🇧",US:"🇺🇸",DE:"🇩🇪",FR:"🇫🇷",IT:"🇮🇹",ES:"🇪🇸",RU:"🇷🇺",PL:"🇵🇱",HU:"🇭🇺",JP:"🇯🇵" };
const VIDEO_EXT = [".mkv",".mp4",".avi",".mov",".wmv",".flv",".webm",".ts",".m4v"];
function removeDiacritics(s){return s.normalize("NFD").replace(/[\u0300-\u036f]/g,"");}
function shortenTitle(s,n=3){return s.split(/\s+/).slice(0,n).join(" ");}
function isMultiSeason(s){return /(S\d{2}E\d{2}-\d{2}|Complete|All Episodes|Season \d+(-\d+)?)/i.test(s);}
function isVideo(f){return VIDEO_EXT.some(e=>f.toLowerCase().endsWith(e));}

const resolveCache=new Map();
const CACHE_TTL=3600000;

// Token format: "RDTOKEN--TMDBKEY--SKTUID--SKTPASS--SKTSEARCH" (TMDB, SKT, search volitelné)
function parseToken(token){
    const parts=token.split("--");
    return { rdToken: parts[0]||"", tmdbKey: parts[1]||"", sktUid: parts[2]||"", sktPass: parts[3]||"", sktSearch: parts[4]==="1" };
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

async function searchSKT(query, sktUid, sktPass){
    if(sktRateLimited){console.log(`[SKT] ⏸️ Rate limited, skip "${query}"`);return[];}
    console.log(`[SKT] 🔎 "${query}"`);
    try{
        const hdrs={"User-Agent":"Mozilla/5.0"};
        if(sktUid&&sktPass) hdrs.Cookie=`uid=${sktUid}; pass=${sktPass}`;
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
            // Obrázek - src z img tagu
            let poster=$(img).attr("src")||"";
            if(poster&&!poster.startsWith("http"))poster=`${BASE_URL}/${poster.replace(/^\//,'')}`;
            results.push({name,hash,size:szM[1].trim(),seeds:sdM?parseInt(sdM[1]):0,cat,poster});
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

// Downloading video URL - nahradit vlastní URL po uploadu na GitHub
// Info video - stáhne z GitHub jednou při startu, servíruje lokálně
const fs=require('fs');
const INFO_VIDEO_PATH='/tmp/downloading.mp4';
const DOWNLOADING_VIDEO_URL='https://raw.githubusercontent.com/david325345/sktorrent-realdebrid/main/public/downloading.mp4';

async function downloadInfoVideo(){
    try{
        const r=await axios.get(DOWNLOADING_VIDEO_URL,{responseType:'arraybuffer',timeout:15000});
        fs.writeFileSync(INFO_VIDEO_PATH,Buffer.from(r.data));
        console.log(`[INFO] ✅ Info video staženo (${Math.round(r.data.byteLength/1024)}KB)`);
    }catch(e){
        console.log('[INFO] ⚠️ Nelze stáhnout info video:',e.message);
    }
}
downloadInfoVideo();

async function resolveRD(token,hash,season,episode){
    const ck=`${hash}-${season}-${episode}`;const cached=resolveCache.get(ck);
    if(cached&&Date.now()-cached.ts<CACHE_TTL){console.log("[RD] ✅ Cache hit");return cached.url;}
    console.log(`[RD] Resolving: ${hash}`);
    const tid=await rdAddMagnet(token,hash);if(!tid)return null;
    let info;
    // Krátké čekání na status (max 5s)
    for(let i=0;i<5;i++){
        info=await rdInfo(token,tid);if(!info){await rdDelete(token,tid);return null;}
        if(info.status==="downloaded"&&info.links?.length>0){
            const url=await rdUnrestrict(token,info.links[0]);
            if(url){resolveCache.set(ck,{url,ts:Date.now()});console.log("[RD] ✅ Cached");return url;}
            await rdDelete(token,tid);return null;
        }
        if(info.status==="waiting_files_selection")break;
        if(["magnet_error","error","virus","dead"].includes(info.status)){await rdDelete(token,tid);return null;}
        await new Promise(r=>setTimeout(r,1000));
    }
    // Výběr souborů
    if(info.status==="waiting_files_selection"&&info.files?.length>0){
        const videos=info.files.filter(f=>isVideo(f.path));let fid;
        if(videos.length===0)fid="all";
        else if(season!==undefined&&episode!==undefined&&videos.length>1){
            const pats=[new RegExp(`S${String(season).padStart(2,'0')}E${String(episode).padStart(2,'0')}`,'i'),new RegExp(`${season}x${String(episode).padStart(2,'0')}`,'i'),new RegExp(`[._\\-\\s]E${String(episode).padStart(2,'0')}[._\\-\\s]`,'i')];
            let hit=null;for(const p of pats){hit=videos.find(f=>p.test(f.path));if(hit)break;}
            fid=hit?String(hit.id):String(videos.reduce((a,b)=>a.bytes>b.bytes?a:b).id);
        }else{fid=String(videos.reduce((a,b)=>a.bytes>b.bytes?a:b).id);}
        if(!(await rdSelect(token,tid,fid))){await rdDelete(token,tid);return null;}
    }else if(info.status!=="downloaded"){
        // Torrent se stahuje, nečekej — vrať null → info video
        console.log(`[RD] 🕐 Status: ${info.status} → stahuje se`);
        return null;
    }
    // Rychlé čekání na hotový stav (max 5s pro už-cached torrenty)
    for(let i=0;i<5;i++){
        info=await rdInfo(token,tid);if(!info)return null;
        if(info.status==="downloaded"&&info.links?.length>0){
            const url=await rdUnrestrict(token,info.links[0]);
            if(url){resolveCache.set(ck,{url,ts:Date.now()});console.log("[RD] ✅ Ready");return url;}
            return null;
        }
        if(["magnet_error","error","virus","dead"].includes(info.status)){await rdDelete(token,tid);return null;}
        await new Promise(r=>setTimeout(r,1000));
    }
    // Stále se stahuje → info video
    console.log(`[RD] 🕐 Stále se stahuje po 5s`);
    return null;
}

// ============ QUERIES ============
// Vrací { en: [...], cz: [...] } — oddělené EN a CZ názvy
function buildSearchNames(titles){
    const enNames=[], czNames=[];
    const addTo=(arr,s)=>{s=s?.trim();if(s&&s.length>=2&&!arr.includes(s))arr.push(s);};
    
    const en=(titles.en||titles.title||'').replace(/\(.*?\)/g,'').replace(/TV (Mini )?Series/gi,'').trim();
    if(en){
        addTo(enNames,en);
        addTo(enNames,removeDiacritics(en));
        if(en.includes(':'))addTo(enNames,en.split(':')[0].trim());
        if(en.includes(' - '))addTo(enNames,en.split(' - ')[0].trim());
    }
    
    const cz=(titles.cz||'').replace(/\(.*?\)/g,'').replace(/TV (Mini )?Series/gi,'').trim();
    const isLatin=(s)=>/[a-zA-Z]/.test(s);
    if(cz&&cz!==en&&isLatin(cz)){
        addTo(czNames,cz);
        addTo(czNames,removeDiacritics(cz));
        if(cz.includes(':'))addTo(czNames,cz.split(':')[0].trim());
        if(cz.includes(':'))addTo(czNames,removeDiacritics(cz.split(':')[0].trim()));
    }
    
    return {en:enNames, cz:czNames};
}

// ============ EXPRESS ============
const app=express();
app.get("/",(req,res)=>{res.setHeader("Content-Type","text/html; charset=utf-8");res.send(html());});
app.get("/configure",(req,res)=>{res.setHeader("Content-Type","text/html; charset=utf-8");res.send(html());});

app.get("/:token/manifest.json",(req,res)=>{
    res.setHeader("Access-Control-Allow-Origin","*");res.setHeader("Access-Control-Allow-Headers","*");res.setHeader("Content-Type","application/json");
    const{sktSearch}=parseToken(req.params.token);
    const catalogs=sktSearch?[{type:"movie",id:"skt-search",name:"SKTorrent",extra:[{name:"search",isRequired:true}]}]:[];
    const resources=sktSearch?["stream","catalog","meta"]:["stream"];
    res.json({
        id:"org.stremio.sktorrent.rd",
        version:"2.5.0",
        name:"SKTorrent+RD",
        description:"CZ/SK torrenty ze sktorrent.eu s Real-Debrid",
        logo:"https://raw.githubusercontent.com/david325345/sktorrent-realdebrid/main/public/logo.png",
        types:["movie","series"],
        catalogs,
        resources,
        idPrefixes:["tt","skt:"],
        behaviorHints:{configurable:true,configurationRequired:false}
    });
});

// ============ SKT SEARCH CACHE ============
// Cache SKT výsledků pro meta endpoint (search → klik na výsledek)
const sktSearchCache=new Map();
// Vyčisti cache každou hodinu (max 1000 záznamů)
setInterval(()=>{if(sktSearchCache.size>1000)sktSearchCache.clear();},3600000);

// ============ CATALOG (SKT přímé hledání) ============
app.get("/:token/catalog/:type/:id/:extra.json",async(req,res)=>{
    res.setHeader("Access-Control-Allow-Origin","*");res.setHeader("Access-Control-Allow-Headers","*");res.setHeader("Content-Type","application/json");
    const{sktUid,sktPass}=parseToken(req.params.token);
    const extraStr=req.params.extra||"";
    const searchMatch=extraStr.match(/search=([^&]+)/);
    if(!searchMatch)return res.json({metas:[]});
    const query=decodeURIComponent(searchMatch[1]);
    console.log(`\n🔍 Catalog search: "${query}"`);
    
    const results=await searchSKT(query,sktUid,sktPass);
    if(!results.length)return res.json({metas:[]});
    
    const metas=results.map(t=>{
        // Uložit do cache pro meta/stream endpoint
        sktSearchCache.set(t.hash,t);
        
        let clean=t.name.replace(/^Stiahni si\s*/i,"").trim();
        if(t.cat&&clean.startsWith(t.cat))clean=clean.slice(t.cat.length).trim();
        
        const flags=(t.name.match(/\b([A-Z]{2})\b/g)||[]).map(c=>langToFlag[c]).filter(Boolean);
        const flagStr=flags.length?` ${flags.join("/")}`:""
        
        return{
            id:`skt:${t.hash}`,
            type:"movie",
            name:clean,
            poster:t.poster||undefined,
            description:`📁 ${t.cat||'SKT'}  📀 ${t.size}  👤 ${t.seeds}${flagStr}`,
            posterShape:"regular"
        };
    });
    
    console.log(`🔍 Catalog: ${metas.length} výsledků`);
    return res.json({metas});
});

// ============ META (detail SKT torrentu) ============
app.get("/:token/meta/:type/:id.json",async(req,res)=>{
    res.setHeader("Access-Control-Allow-Origin","*");res.setHeader("Access-Control-Allow-Headers","*");res.setHeader("Content-Type","application/json");
    const{id}=req.params;
    
    if(!id.startsWith("skt:"))return res.json({meta:null});
    const hash=id.replace("skt:","");
    const t=sktSearchCache.get(hash);
    
    if(!t)return res.json({meta:{id,type:"movie",name:hash,description:"Torrent z SKTorrent"}});
    
    let clean=t.name.replace(/^Stiahni si\s*/i,"").trim();
    if(t.cat&&clean.startsWith(t.cat))clean=clean.slice(t.cat.length).trim();
    
    const flags=(t.name.match(/\b([A-Z]{2})\b/g)||[]).map(c=>langToFlag[c]).filter(Boolean);
    const flagStr=flags.length?` ${flags.join("/")}`:""
    
    return res.json({meta:{
        id,
        type:"movie",
        name:clean,
        poster:t.poster||undefined,
        posterShape:"regular",
        description:`📁 Kategorie: ${t.cat||'SKT'}\n📀 Velikost: ${t.size}\n👤 Seeds: ${t.seeds}${flagStr}\n\n${t.name}`,
        background:t.poster||undefined
    }});
});

// STREAM
app.get("/:token/stream/:type/:id.json",async(req,res)=>{
    res.setHeader("Access-Control-Allow-Origin","*");res.setHeader("Access-Control-Allow-Headers","*");res.setHeader("Content-Type","application/json");
    const{type,id}=req.params;
    const{rdToken,tmdbKey,sktUid,sktPass}=parseToken(req.params.token);
    
    // SKT přímý stream (z catalog search)
    if(id.startsWith("skt:")){
        const hash=id.replace("skt:","");
        const t=sktSearchCache.get(hash);
        const proto=req.headers['x-forwarded-proto']||req.protocol;
        const host=req.headers['x-forwarded-host']||req.get('host');
        const baseUrl=`${proto}://${host}`;
        const proxyUrl=`${baseUrl}/${req.params.token}/play/${hash}/video.mp4`;
        
        let name='SKT+RD';
        let desc='⚡ Real-Debrid';
        if(t){
            let clean=t.name.replace(/^Stiahni si\s*/i,"").trim();
            if(t.cat&&clean.startsWith(t.cat))clean=clean.slice(t.cat.length).trim();
            const flags=(t.name.match(/\b([A-Z]{2})\b/g)||[]).map(c=>langToFlag[c]).filter(Boolean);
            const flagStr=flags.length?` ${flags.join("/")}`:""
            name=`SKT+RD\n${t.cat||'SKT'}`;
            desc=`${clean}\n👤 ${t.seeds}  📀 ${t.size}${flagStr}\n⚡ Real-Debrid`;
        }
        
        console.log(`\n🎬 SKT stream: ${hash}`);
        return res.json({streams:[{
            name,description:desc,url:proxyUrl,
            behaviorHints:{bingeGroup:`skt-rd-${hash.slice(0,8)}`,notWebReady:true}
        }]});
    }
    
    // Normální IMDb stream (stávající logika)
    const[imdbId,sRaw,eRaw]=id.split(":");
    const season=sRaw?parseInt(sRaw):undefined;const episode=eRaw?parseInt(eRaw):undefined;
    console.log(`\n🎬 ${type} ${imdbId} S${season??'-'}E${episode??'-'}`);
    try{
        const titles=await getTitle(imdbId,tmdbKey);if(!titles)return res.json({streams:[]});
        let torrents=[];
        let batchTorrents=[];
        const epTag=season!==undefined?`S${String(season).padStart(2,'0')}E${String(episode).padStart(2,'0')}`:'';
        const seTag=season!==undefined?`S${String(season).padStart(2,'0')}`:'';
        const sn=season!==undefined?String(season):'';

        const matchesExactEpisode=(name)=>name.toUpperCase().includes(epTag);
        const hasAnyEpisode=(name)=>new RegExp(seTag+'E\\d{2}','i').test(name);
        const isBatchSeason=(name)=>{
            const up=name.toUpperCase();
            // Má sezónu (S01, 1.serie) a nemá epizodu
            const hasSe=up.includes(seTag)||(new RegExp(`(^|\\W)${sn}\\s*\\.?\\s*seri[ea]|seri[ea]\\s*${sn}(\\W|$)`,'i')).test(name);
            if(hasSe&&!hasAnyEpisode(name))return true;
            // "komplet", "complete" = celá série (batch bez čísla sezóny)
            if(/\b(komplet|complete)\b/i.test(name)&&!hasAnyEpisode(name))return true;
            return false;
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
                    const found=filterYear(await searchSKT(name+' '+epTag,sktUid,sktPass));
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
                    const found=filterYear(await searchSKT(name+' '+seTag,sktUid,sktPass));
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
                // 3. Holý název - hledej batch i když máme epizody
                if(!batchTorrents.length&&!sktRateLimited){
                    const found=filterYear(await searchSKT(name,sktUid,sktPass));
                    if(found.length>0){
                        const ep=found.filter(t=>matchesExactEpisode(t.name));
                        const batch=found.filter(t=>isBatchSeason(t.name));
                        if(!torrents.length&&ep.length>0)torrents=ep;
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
                    torrents=filterYear(await searchSKT(name,sktUid,sktPass));
                    await delay(300);
                }
            }
        }

        // Hledej EN názvy, jen pokud nic nenajde zkus CZ
        const {en:enNames, cz:czNames}=buildSearchNames(titles);
        
        // 1. EN názvy
        for(const name of enNames){
            await searchWithName(name);
            if(torrents.length>0||batchTorrents.length>0)break;
        }
        // 2. CZ názvy — jen pokud EN nic nenašel
        if(!torrents.length&&!batchTorrents.length){
            for(const name of czNames){
                await searchWithName(name);
                if(torrents.length>0||batchTorrents.length>0)break;
            }
        }

        if(!torrents.length&&!batchTorrents.length)return res.json({streams:[]});
        
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
            const cat=t.cat||'SKT';
            streams.push({
                name:`SKT+RD\n${cat}`,
                description:`${clean}${batchLabel}\n👤 ${t.seeds}  📀 ${t.size}${flagStr}\n⚡ Real-Debrid`,
                url:proxyUrl,
                behaviorHints:{bingeGroup:`skt-rd-${t.hash.slice(0,8)}`,notWebReady:true}
            });
        };

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
    if(!streamUrl){
        console.log("[Play] 🕐 Torrent se stahuje → info video");
        if(fs.existsSync(INFO_VIDEO_PATH)){
            res.setHeader('Content-Type','video/mp4');
            res.setHeader('Content-Length',fs.statSync(INFO_VIDEO_PATH).size);
            return fs.createReadStream(INFO_VIDEO_PATH).pipe(res);
        }
        return res.redirect(302,DOWNLOADING_VIDEO_URL);
    }
    console.log(`[Play] ✅ Redirect → ${streamUrl.slice(0,80)}...`);
    return res.redirect(302,streamUrl);
});

app.get("/api/verify/:token",async(req,res)=>{
    res.setHeader("Access-Control-Allow-Origin","*");
    const u=await rdVerify(req.params.token);
    res.json(u?{success:true,username:u.username,type:u.type,expiration:u.expiration}:{success:false});
});

// SKT Login - přihlásí se na sktorrent.eu a vrátí cookies
app.post("/api/skt-login",express.json(),async(req,res)=>{
    res.setHeader("Access-Control-Allow-Origin","*");
    const{username,password}=req.body||{};
    if(!username||!password)return res.json({success:false,error:"Zadej jméno a heslo"});
    try{
        const r=await axios.post(`${BASE_URL}/torrent/login.php`,
            `uid=${encodeURIComponent(username)}&pwd=${encodeURIComponent(password)}`,
            {headers:{"Content-Type":"application/x-www-form-urlencoded","User-Agent":"Mozilla/5.0","Referer":`${BASE_URL}/torrent/login.php`},
             maxRedirects:0,validateStatus:()=>true,timeout:10000});
        
        console.log(`[SKT] Login response: status=${r.status}, cookies=${(r.headers['set-cookie']||[]).length}`);
        
        const cookies=r.headers['set-cookie']||[];
        let uid="",pass="";
        for(const c of cookies){
            const um=c.match(/uid=([^;]+)/);if(um)uid=um[1];
            const pm=c.match(/pass=([^;]+)/);if(pm)pass=pm[1];
        }
        if(uid&&pass){
            console.log(`[SKT] ✅ Login OK: ${username}`);
            return res.json({success:true,uid,pass});
        }
        console.log(`[SKT] ❌ Login failed: ${username} (no cookies)`);
        return res.json({success:false,error:"Špatné jméno nebo heslo"});
    }catch(e){
        console.error("[SKT] Login error:",e.message);
        return res.json({success:false,error:"Chyba připojení k SKTorrent"});
    }
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
.sep{border:none;border-top:1px solid rgba(255,255,255,.08);margin:20px 0}
.sec{font-size:16px;font-weight:600;margin-bottom:12px;color:#c4b5fd}
.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.btn{width:100%;padding:14px;border:none;border-radius:14px;font-size:16px;font-weight:600;cursor:pointer;margin-bottom:10px;color:#fff;transition:all .2s}
.bv{background:linear-gradient(135deg,#059669,#10b981)}.bi{background:linear-gradient(135deg,#7c3aed,#8b5cf6);display:none}.bs{background:linear-gradient(135deg,#dc2626,#ef4444)}.btn:hover{opacity:.9;transform:translateY(-1px)}
.st{text-align:center;margin:12px 0;font-size:14px;min-height:20px}.ok{color:#34d399}.er{color:#f87171}.lo{color:#fbbf24}
.url{background:rgba(0,0,0,.4);border-radius:10px;padding:12px;margin-top:10px;word-break:break-all;font-family:monospace;font-size:12px;color:#a78bfa;display:none}
.cp{display:inline-block;padding:4px 12px;font-size:12px;background:rgba(139,92,246,.2);border:1px solid rgba(139,92,246,.4);color:#c4b5fd;border-radius:6px;cursor:pointer;margin-top:8px}
.ft{margin-top:20px;padding-top:16px;border-top:1px solid rgba(255,255,255,.08);display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:13px;color:#d1d5db}.ft div::before{content:"✓ ";color:#34d399}
</style></head><body>
<div class="c">
<h1>SKTorrent + Real-Debrid</h1>
<div class="sub">Stremio Addon <span class="badge b-sk">SKT</span><span class="badge b-rd">RD</span><span class="badge b-tm">TMDB</span></div>
<div class="info">Prohledává <b>sktorrent.eu</b> a streamuje přes <b>Real-Debrid</b>.<br>TMDB pro české/slovenské názvy filmů.</div>

<div class="sec">🔑 Real-Debrid *</div>
<label>API Token</label>
<input type="text" id="rd" placeholder="Vlož RD API token..." autocomplete="off">
<div class="opt">Získej na <a href="https://real-debrid.com/apitoken" target="_blank" style="color:#a78bfa">real-debrid.com/apitoken</a></div>

<hr class="sep">
<div class="sec">🎬 TMDB (volitelné)</div>
<label>API Key</label>
<input type="text" id="tmdb" placeholder="Vlož TMDB API key..." autocomplete="off">
<div class="opt">Bez TMDB se hledá jen anglicky. S TMDB i česky/slovensky.<br>Získej na <a href="https://www.themoviedb.org/settings/api" target="_blank" style="color:#a78bfa">themoviedb.org/settings/api</a></div>

<hr class="sep">
<div class="sec">🔓 SKTorrent účet (volitelné)</div>
<div class="opt" style="margin-top:0;margin-bottom:12px">⚠️ Bez účtu najde addon méně výsledků. S účtem na sktorrent.eu se zobrazí i omezený obsah.</div>
<div class="row">
<div><label>Jméno</label><input type="text" id="skt_user" name="username" placeholder="SKT jméno..." autocomplete="username"></div>
<div><label>Heslo</label><input type="password" id="skt_pass" name="password" placeholder="SKT heslo..." autocomplete="current-password"></div>
</div>
<button class="btn bs" onclick="sktLogin()" id="skt_btn">🔓 Přihlásit na SKTorrent</button>
<div class="st" id="skt_st"></div>

<hr class="sep">
<div class="sec">🔍 Přímé hledání na SKT</div>
<div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
<label class="toggle" style="margin:0;cursor:pointer;display:flex;align-items:center;gap:10px">
<input type="checkbox" id="skt_search" style="width:auto;margin:0;accent-color:#8b5cf6;transform:scale(1.4)">
<span style="font-size:14px">Povolit hledání přímo na SKTorrent</span>
</label>
</div>
<div class="opt" style="margin-top:-8px">Zobrazí výsledky ze SKTorrent přímo ve Stremio vyhledávání. Po kliknutí přehraje přes Real-Debrid.</div>

<hr class="sep">
<button class="btn bv" onclick="verify()">🔑 Ověřit a nainstalovat</button>
<div class="st" id="s"></div>
<button class="btn bi" id="ib" onclick="install()">📦 Nainstalovat do Stremio</button>
<div class="url" id="u"></div>
<div class="ft"><div>CZ/SK torrenty</div><div>Real-Debrid stream</div><div>TMDB CZ/SK názvy</div><div>SKT přihlášení</div><div>Přímé hledání SKT</div><div>Auto výběr epizod</div></div>
</div>
<script>
const B=location.origin;
let sktUid='',sktPass='';

async function sktLogin(){
    const user=document.getElementById('skt_user').value.trim();
    const pass=document.getElementById('skt_pass').value.trim();
    const st=document.getElementById('skt_st');
    if(!user||!pass){st.className='st er';st.textContent='❌ Zadej jméno a heslo';return}
    st.className='st lo';st.textContent='⏳ Přihlašuji...';
    try{
        const r=await(await fetch(B+'/api/skt-login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:user,password:pass})})).json();
        if(r.success){
            sktUid=r.uid;sktPass=r.pass;
            st.className='st ok';st.textContent='✅ Přihlášeno na SKTorrent';
            document.getElementById('skt_btn').textContent='✅ SKT přihlášeno';
        }else{st.className='st er';st.textContent='❌ '+(r.error||'Přihlášení selhalo')}
    }catch(e){st.className='st er';st.textContent='❌ Chyba: '+e.message}
}

function getToken(){
    const rd=document.getElementById('rd').value.trim();
    const tmdb=document.getElementById('tmdb').value.trim();
    const search=document.getElementById('skt_search').checked?'1':'0';
    let tok=rd;
    // Vždy přidej všechny části (i prázdné) aby se zachovalo pořadí
    tok+='--'+(tmdb||'');
    tok+='--'+(sktUid||'');
    tok+='--'+(sktPass||'');
    tok+='--'+search;
    return tok;
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
            let extra='';
            if(tmdb)extra+=' + TMDB';
            if(sktUid)extra+=' + SKT';
            if(document.getElementById('skt_search').checked)extra+=' + Hledání';
            s.className='st ok';s.textContent='✅ '+r.username+' ('+r.type+') | do: '+d+extra;
            ib.style.display='block';u.style.display='block';
            const tok=getToken();const m=B+'/'+tok+'/manifest.json';
            u.innerHTML=m+'<br><span class="cp" onclick="copyUrl()">📋 Kopírovat URL</span>';
        }else{s.className='st er';s.textContent='❌ Neplatný RD token';ib.style.display='none';u.style.display='none'}
    }catch(e){s.className='st er';s.textContent='❌ Chyba: '+e.message}
}
function install(){const tok=getToken();if(!tok)return;window.location.href='stremio://'+B.replace(/https?:\\/\\//,'')+'/'+tok+'/manifest.json'}
function copyUrl(){const tok=getToken();navigator.clipboard.writeText(B+'/'+tok+'/manifest.json').then(()=>{const c=document.querySelector('.cp');c.textContent='✅ Zkopírováno';setTimeout(()=>c.textContent='📋 Kopírovat URL',2000)})}
document.getElementById('rd').addEventListener('keypress',e=>{if(e.key==='Enter')verify()});
</script></body></html>`;}

// ============ KEEP-ALIVE ============
let keepAliveInterval=null;
let serviceUrl='';

function startKeepAlive(url){
    if(keepAliveInterval)return; // Už běží
    serviceUrl=url;
    const now=new Date();
    // Kolik ms do půlnoci
    const midnight=new Date(now);
    midnight.setHours(24,0,0,0);
    const msUntilMidnight=midnight.getTime()-now.getTime();
    
    console.log(`[KeepAlive] ✅ Aktivní do půlnoci (${Math.round(msUntilMidnight/60000)} min)`);
    
    // Ping každých 10 minut
    keepAliveInterval=setInterval(async()=>{
        try{await axios.get(serviceUrl,{timeout:5000});console.log('[KeepAlive] 🏓 ping');}
        catch(e){}
    },600000); // 10 min
    
    // Zastav o půlnoci
    setTimeout(()=>{
        if(keepAliveInterval){
            clearInterval(keepAliveInterval);
            keepAliveInterval=null;
            console.log('[KeepAlive] 😴 Půlnoc → usínám');
        }
    },msUntilMidnight);
}

// Middleware: první request aktivuje keep-alive
app.use((req,res,next)=>{
    if(!keepAliveInterval&&req.headers.host){
        const proto=req.headers['x-forwarded-proto']||req.protocol;
        startKeepAlive(`${proto}://${req.headers.host}/`);
    }
    next();
});

app.listen(PORT,()=>console.log(`🚀 SKTorrent+RD http://localhost:${PORT}`));
