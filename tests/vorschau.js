"use strict";
// Lokale Vorschau der App mit Fake-Backend und erfundenen Daten.
//   node tests/vorschau.js [Port]            -> http://localhost:8765/index.html
//   http://localhost:8765/index.html?neu     setzt den gespeicherten Fake-Zustand zurueck
// Keine Verbindung zur echten Datenbank, nichts wird veroeffentlicht.
// Alle Daten kommen aus tests/synthetisch.js (erfunden). Die Vorschau meldet
// dich automatisch als Admin an. Tresor (WebCrypto, IndexedDB) laeuft echt im
// Browser, weil localhost als sicherer Kontext gilt.
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const S = require("./synthetisch.js");

const root = path.join(__dirname, "..");
const ziel = path.join(os.tmpdir(), "fedex-vorschau");
const PORT = Number(process.env.VORSCHAU_PORT || process.argv[2]) || 8765; // z. B. node tests/vorschau.js 8766

fs.rmSync(ziel, { recursive: true, force: true });
fs.mkdirSync(path.join(ziel, "vendor"), { recursive: true });
["planung-solver.js", "dispo-export.js", "tresor.js", "minijob.js"].forEach((f) => fs.copyFileSync(path.join(root, f), path.join(ziel, f)));
fs.readdirSync(path.join(root, "vendor")).forEach((f) =>
  fs.copyFileSync(path.join(root, "vendor", f), path.join(ziel, "vendor", f)));

// Planungswoche = naechster Montag, damit die Vorschau wie der echte Betrieb aussieht.
function naechsterMontag() {
  const d = new Date();
  const heute = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const wt = heute.getUTCDay() || 7;
  heute.setUTCDate(heute.getUTCDate() + (8 - wt));
  return heute.toISOString().slice(0, 10);
}
const START = naechsterMontag();
const json = S.exportJson(START);
const daten = S.datenbank(json);
const DATEN_STAND = "v2-" + START;

// erfundene Stammliste zum Ausprobieren (Passwoerter sind Platzhalter)
try {
  const XLSX = require(path.join(root, "vendor", "xlsx-0.20.3.full.min.js"));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(S.stammliste(json)), "Stamm");
  fs.writeFileSync(path.join(ziel, "stamm_synthetisch.xlsx"), XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
} catch (e) {
  console.log("Hinweis: erfundene Stammliste nicht erzeugt:", e.message.slice(0, 80));
}

// ---------------------------------------------------------------------
// Fake-Backend: kleiner Abfrage-Interpreter mit Filtern, Sortierung,
// insert/update/upsert/delete, single/maybeSingle; RPCs und Edge Functions
// als Stubs mit den wichtigsten Serverregeln.
// ---------------------------------------------------------------------
const fake = `<script>
window.__DATA=${JSON.stringify(daten)};
window.__STAND=${JSON.stringify(DATEN_STAND)};
window.__LOG=[];
(function(){
 if(location.search.indexOf("neu")>=0){
   try{localStorage.removeItem("__fake_store");localStorage.removeItem("zig_namenzuordnung_v1");}catch(e){}
   try{indexedDB.deleteDatabase("zig_tresor");}catch(e){}
   history.replaceState(null,"",location.pathname);
 }
 function kopieTief(x){return JSON.parse(JSON.stringify(x));}
 let gespeichert=null;
 try{gespeichert=JSON.parse(localStorage.getItem("__fake_store"));}catch(e){}
 window.__store=(gespeichert&&gespeichert.__stand===__STAND)?gespeichert:Object.assign(kopieTief(__DATA),{__stand:__STAND});
 window.__save=function(){try{localStorage.setItem("__fake_store",JSON.stringify(__store));}catch(e){}};
 const SCHLUESSEL={employees:["personalnummer"],weeks:["kw_start_datum"],week_days:["datum"],week_shifts:["datum","schicht_id"],
   submissions:["kw_start_datum","personalnummer"],availability:["kw_start_datum","personalnummer","datum","schicht_id"],
   planung:["id"],planung_stand:["kw_start_datum"],planung_historie:["id"],app_dateien:["schluessel"],app_einstellungen:["schluessel"],
   shift_types:["schicht_id"],shift_templates:["schicht_id","wochentag"]};
 let folge=1000;
 function gleich(a,b){return String(a)===String(b);}
 function schluesselGleich(t,a,b){return (SCHLUESSEL[t]||[]).every(k=>gleich(a[k],b[k]));}
 function standard(t){
   if(t==="app_dateien")return{version:1,aktualisiert_am:new Date().toISOString()};
   if(t==="planung"||t==="planung_historie")return{id:++folge};
   return{};
 }
 function nachUpdate(t,r){
   if(t==="app_dateien"){r.version=(r.version||1)+1;r.aktualisiert_am=new Date().toISOString();}
 }
 function kopie(r){const o=Object.assign({},r);delete o.__pw;return o;}
 function ausfuehren(t,q){
   const alle=__store[t]=__store[t]||[];
   const passt=r=>q.f.every(f=>f(r));
   let erg;
   if(q.modus==="select"){
     let rows=alle.filter(passt);
     if(q.ord.length){rows=rows.slice().sort((a,b)=>{for(const [k,auf] of q.ord){if(a[k]<b[k])return auf?-1:1;if(a[k]>b[k])return auf?1:-1;}return 0;});}
     if(q.rng)rows=rows.slice(q.rng[0],q.rng[1]+1);
     if(q.lim!=null)rows=rows.slice(0,q.lim);
     erg=rows.map(kopie);
   }else if(q.modus==="insert"){
     const rows=[].concat(q.daten).map(r=>Object.assign(standard(t),r));
     for(const r of rows){if(alle.some(x=>schluesselGleich(t,x,r)))return{data:null,error:{code:"23505",message:"duplicate key value violates unique constraint"}};alle.push(r);}
     erg=rows.map(kopie);
   }else if(q.modus==="upsert"){
     const rows=[].concat(q.daten);erg=[];
     for(const r of rows){const i=alle.findIndex(x=>schluesselGleich(t,x,r));
       if(i>=0){Object.assign(alle[i],r);nachUpdate(t,alle[i]);erg.push(kopie(alle[i]));}
       else{const n=Object.assign(standard(t),r);alle.push(n);erg.push(kopie(n));}}
   }else if(q.modus==="update"){
     const treffer=alle.filter(passt);treffer.forEach(r=>{Object.assign(r,q.daten);nachUpdate(t,r);});erg=treffer.map(kopie);
   }else if(q.modus==="delete"){
     const treffer=alle.filter(passt);__store[t]=alle.filter(r=>!passt(r));erg=treffer.map(kopie);
   }
   __save();
   if(q.einzel==="single"){if(erg.length!==1)return{data:null,error:{code:"PGRST116",message:"JSON object requested, multiple (or no) rows returned"}};return{data:erg[0],error:null};}
   if(q.einzel==="maybe"){if(erg.length>1)return{data:null,error:{code:"PGRST116",message:"multiple rows returned"}};return{data:erg[0]||null,error:null};}
   return{data:erg,error:null};
 }
 function builder(t){
   const q={f:[],ord:[],lim:null,rng:null,modus:"select",daten:null,einzel:null};
   const b={};
   const filt=fn=>{q.f.push(fn);return b;};
   b.select=()=>b;
   b.eq=(k,v)=>filt(r=>gleich(r[k],v));
   b.neq=(k,v)=>filt(r=>!gleich(r[k],v));
   b.in=(k,arr)=>filt(r=>(arr||[]).some(v=>gleich(r[k],v)));
   b.gte=(k,v)=>filt(r=>r[k]>=v);b.lte=(k,v)=>filt(r=>r[k]<=v);b.gt=(k,v)=>filt(r=>r[k]>v);b.lt=(k,v)=>filt(r=>r[k]<v);
   b.order=(k,o)=>{q.ord.push([k,!(o&&o.ascending===false)]);return b;};
   b.limit=n=>{q.lim=n;return b;};
   b.range=(a,z)=>{q.rng=[a,z];return b;};
   b.single=()=>{q.einzel="single";return b;};
   b.maybeSingle=()=>{q.einzel="maybe";return b;};
   b.insert=rows=>{q.modus="insert";q.daten=rows;return b;};
   b.update=obj=>{q.modus="update";q.daten=obj;return b;};
   b.upsert=rows=>{q.modus="upsert";q.daten=rows;return b;};
   b.delete=()=>{q.modus="delete";return b;};
   b.then=(res,rej)=>Promise.resolve().then(()=>ausfuehren(t,q)).then(res,rej);
   return b;
 }
 function plusTage(iso,n){const d=new Date(iso+"T00:00:00Z");d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);}
 function wocheAnlegen(kw){
   if(!__store.weeks.some(w=>w.kw_start_datum===kw)){
     __store.weeks.push({kw_start_datum:kw,abgabefrist:plusTage(kw,-3)+"T11:00:00+00:00"});
     for(let i=0;i<5;i++)__store.week_days.push({kw_start_datum:kw,datum:plusTage(kw,i),wochentag:i+1,gesperrt:false,grund:null});
     schichtenAusStandard(kw);
   }
 }
 function schichtenAusStandard(kw){
   __store.week_shifts=__store.week_shifts.filter(s=>s.kw_start_datum!==kw);
   __store.shift_templates.forEach(v=>{const typ=__store.shift_types.find(x=>x.schicht_id===v.schicht_id)||{};
     const [b1,b2]=v.beginn.split(":").map(Number),[e1,e2]=v.ende.split(":").map(Number);
     __store.week_shifts.push({kw_start_datum:kw,datum:plusTage(kw,v.wochentag-1),wochentag:v.wochentag,schicht_id:v.schicht_id,
       name:typ.name||v.schicht_id,beginn:v.beginn,ende:v.ende,dauer_h:((e1*60+e2)-(b1*60+b2))/60,aktiv:!!(v.aktiv&&typ.aktiv!==false),sortierung:typ.sortierung||9});});
 }
 const START=${JSON.stringify(START)};
 const PN_MUSTER=/^[A-Za-z0-9._-]{1,20}$/;
 function rpc(n,a){
   a=a||{};
   if(n==="is_admin")return{data:true,error:null};
   if(n==="current_personalnummer")return{data:null,error:null};
   if(n==="muss_passwort_aendern")return{data:false,error:null};
   if(n==="aktive_woche"||n==="get_or_create_week")return{data:START,error:null};
   if(n==="wochen_vorausanlegen"){for(let i=0;i<4;i++)wocheAnlegen(plusTage(START,7*i));__save();return{data:4,error:null};}
   if(n==="woche_aus_standard_neu_laden"){schichtenAusStandard(a.p_kw_start);__save();__LOG.push("neu_laden "+a.p_kw_start);return{data:15,error:null};}
   if(n==="tag_sperren"){const t=__store.week_days.find(x=>x.datum===a.p_datum);if(!t)return{data:null,error:{message:"Tag nicht gefunden"}};
     t.gesperrt=!!a.p_gesperrt;t.grund=a.p_gesperrt?(a.p_grund||null):null;
     if(a.p_gesperrt)__store.availability=__store.availability.filter(v=>v.datum!==a.p_datum);__save();return{data:null,error:null};}
   if(n==="planung_ersetzen"){
     const kw=a.kw,liste=a.eintraege||[];
     if(!kw||new Date(kw+"T00:00:00Z").getUTCDay()!==1)return{data:null,error:{message:"kw muss ein Montag sein"}};
     const aktiv=new Set(__store.employees.filter(e=>e.aktiv).map(e=>e.personalnummer));
     for(const e of liste){if(!aktiv.has(e.personalnummer))return{data:null,error:{message:"Personalnummer "+e.personalnummer+" ist nicht aktiv"}};}
     __store.planung.filter(p=>p.kw_start_datum===kw).forEach(p=>__store.planung_historie.push(Object.assign({},p,{id:++folge,gesichert_am:new Date().toISOString()})));
     __store.planung=__store.planung.filter(p=>p.kw_start_datum!==kw).concat(liste.map(e=>Object.assign({id:++folge,kw_start_datum:kw},e)));
     const st=__store.planung_stand.find(s=>s.kw_start_datum===kw);const stand={kw_start_datum:kw,aktualisiert_am:new Date().toISOString(),anzahl:liste.length};
     if(st)Object.assign(st,stand);else __store.planung_stand.push(stand);
     __save();return{data:{erwartet:liste.length,eingefuegt:liste.length},error:null};}
   return{data:null,error:{message:"RPC "+n+" ist in der Vorschau nicht vorhanden"}};
 }
 function funktion(name,opts){
   const body=(opts&&opts.body)||{};
   if(name==="import-stammliste"){
     const liste=body.eintraege||[];const fehler=[];const gesehen=new Set();
     if(!liste.length)fehler.push("Die Liste ist leer.");
     liste.forEach((e,i)=>{const pn=String(e.personalnummer||"");const pw=String(e.passwort||"");
       if(!PN_MUSTER.test(pn))fehler.push("Zeile "+(i+2)+": Personalnummer \\""+pn+"\\" ist ungültig.");
       else if(gesehen.has(pn.toLowerCase()))fehler.push("Zeile "+(i+2)+": Personalnummer "+pn+" doppelt.");
       gesehen.add(pn.toLowerCase());
       if(pw.length<6||pw.length>72)fehler.push("Zeile "+(i+2)+": Passwort für "+pn+" muss 6 bis 72 Zeichen haben.");});
     if(fehler.length)return{data:{ok:false,fehler:fehler.slice(0,25)},error:null};
     const vorhanden=new Map(__store.employees.map(e=>[e.personalnummer,e]));
     const neu=[],geaendert=[],reaktiviert=[],unveraendert=[];
     liste.forEach(e=>{const v=vorhanden.get(e.personalnummer);
       if(!v)neu.push(e.personalnummer);else if(!v.aktiv)reaktiviert.push(e.personalnummer);
       else if(v.__pw!==e.passwort)geaendert.push(e.personalnummer);else unveraendert.push(e.personalnummer);});
     const inListe=new Set(liste.map(e=>e.personalnummer));
     const deaktiviert=__store.employees.filter(e=>e.aktiv&&!inListe.has(e.personalnummer)).map(e=>e.personalnummer);
     if(body.modus==="anwenden"){
       liste.forEach(e=>{const v=vorhanden.get(e.personalnummer);if(v){v.aktiv=true;v.__pw=e.passwort;}else __store.employees.push({personalnummer:e.personalnummer,aktiv:true,__pw:e.passwort});});
       deaktiviert.forEach(pn=>{vorhanden.get(pn).aktiv=false;});
       __save();
     }
     return{data:{ok:true,modus:body.modus,zusammenfassung:{neu:neu.length,geaendert:geaendert.length,deaktiviert:deaktiviert.length,reaktiviert:reaktiviert.length,unveraendert:unveraendert.length},neu,geaendert,deaktiviert,reaktiviert},error:null};
   }
   if(name==="reset-passwort"){
     const v=__store.employees.find(e=>e.personalnummer===body.personalnummer);
     if(!v)return{data:{ok:false,fehler:["Personalnummer unbekannt."]},error:null};
     if(!v.aktiv)return{data:{ok:false,fehler:["Zugang ist deaktiviert."]},error:null};
     if(String(body.passwort||"").length<6)return{data:{ok:false,fehler:["Passwort zu kurz."]},error:null};
     v.__pw=body.passwort;__save();return{data:{ok:true,personalnummer:v.personalnummer},error:null};
   }
   if(name==="passwort-setzen")return{data:{ok:true},error:null};
   return{data:{ok:false,fehler:["Funktion "+name+" ist in der Vorschau nicht vorhanden."]},error:null};
 }
 const client={
  auth:{
    getSession:()=>Promise.resolve({data:{session:{user:{id:"vorschau-admin-0001"}}},error:null}),
    getUser:()=>Promise.resolve({data:{user:{id:"vorschau-admin-0001"}},error:null}),
    signInWithPassword:()=>Promise.resolve({data:{},error:null}),
    signOut:()=>Promise.resolve({error:null})
  },
  from:builder,
  rpc:(n,a)=>Promise.resolve(rpc(n,a)),
  functions:{invoke:(n,o)=>Promise.resolve(funktion(n,o))}
 };
 window.supabase={createClient:()=>client};
})();
</script>`;
// index.html und die Modul-Dateien werden bei jedem Aufruf frisch aus dem Projekt gelesen,
// damit Aenderungen ohne Neustart sichtbar sind (Strg+F5 im Browser genuegt).
function indexBauen() {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8")
    .replace('<script src="vendor/supabase-js-2.45.4.js"></script>', fake);
  if (html.indexOf("window.__DATA") < 0) throw new Error("Supabase-Skriptzeile in index.html nicht gefunden");
  return html;
}
indexBauen();
const LIVE = { "/index.html": indexBauen };
["tresor.js", "planung-solver.js", "dispo-export.js", "minijob.js"].forEach((f) => { LIVE["/" + f] = () => fs.readFileSync(path.join(root, f), "utf8"); });

const typen = { ".html": "text/html;charset=utf-8", ".js": "text/javascript", ".xlsx": "application/octet-stream" };
http.createServer((q, r) => {
  const rel = q.url.split("?")[0].replace(/^\/$/, "/index.html");
  const f = path.join(ziel, path.normalize(rel).replace(/^(\.\.[\\/])+/, ""));
  if (!f.startsWith(ziel)) { r.writeHead(403); r.end(); return; }
  if (LIVE[rel]) {
    try { r.writeHead(200, { "content-type": typen[path.extname(rel)] }); r.end(LIVE[rel]()); }
    catch (e) { r.writeHead(500); r.end(String(e.message)); }
    return;
  }
  fs.readFile(f, (e, d) => {
    if (e) { r.writeHead(404); r.end(); return; }
    r.writeHead(200, { "content-type": typen[path.extname(f)] || "application/octet-stream" });
    r.end(d);
  });
}).listen(PORT, "127.0.0.1", () => {
  console.log("Vorschau laeuft: http://localhost:" + PORT + "/index.html   (Zuruecksetzen: ...index.html?neu)");
  console.log("Planungswoche: " + START + "  |  Erfundene Stammliste: " + path.join(ziel, "stamm_synthetisch.xlsx"));
  console.log("Beenden mit Strg+C. Nichts wird an die echte Datenbank gesendet.");
});
