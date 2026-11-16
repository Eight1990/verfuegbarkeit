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
["planung-solver.js", "dispo-export.js", "tresor.js", "minijob.js", "schichtboerse.js"].forEach((f) => fs.copyFileSync(path.join(root, f), path.join(ziel, f)));
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
   shift_types:["schicht_id"],shift_templates:["schicht_id","wochentag"],nachfrist:["personalnummer","kw_start_datum"],
   boerse_angebot:["id"],boerse_berechtigt:["angebot_id","personalnummer"],planung_aenderungen:["id"]};
 // Fortlaufende Nummern: nach dem Neuladen hinter der groessten vorhandenen weiterzaehlen
 let folge=Object.keys(__store).reduce((m,t)=>Array.isArray(__store[t])?__store[t].reduce((n,r)=>typeof r.id==="number"&&r.id>n?r.id:n,m):m,1000);
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
 // Vorschau als Mitarbeiter: localStorage "__fake_als" = Personalnummer (leer = Admin)
 const ALS=(function(){try{return localStorage.getItem("__fake_als")||null;}catch(e){return null;}})();
 function u5(t){return String(t||"").slice(0,5);}
 function schlussMs(datum,beginn){return new Date(datum+"T"+u5(beginn)+":00").getTime()-3600000;}
 function nachzaehlen(kw){const st=(__store.planung_stand||[]).find(s=>s.kw_start_datum===kw);if(st)st.anzahl=__store.planung.filter(p=>p.kw_start_datum===kw).length;}
 function aenderung(a,aktion,pn,von){__store.planung_aenderungen=__store.planung_aenderungen||[];__store.planung_aenderungen.push({id:++folge,kw_start_datum:a.kw_start_datum,datum:a.datum,schicht_id:a.schicht_id,beginn:a.beginn,ende:a.ende,aktion:aktion,personalnummer:pn,ausgeloest_von:von,angebot_id:a.id,am:new Date().toISOString()});}
 function rpc(n,a){
   a=a||{};
   if(n==="is_admin")return{data:!ALS,error:null};
   if(n==="current_personalnummer")return{data:ALS,error:null};
   if(n==="boerse_freigeben"){
     if(ALS)return{data:null,error:{message:"Nur fuer Admins."}};
     if(Date.now()>=schlussMs(a.p_datum,a.p_beginn))return{data:null,error:{message:"Zu spaet: Die Schicht beginnt in weniger als 1 Stunde. Bitte telefonisch regeln."}};
     if(a.p_von){const i=__store.planung.findIndex(p=>p.personalnummer===a.p_von&&p.datum===a.p_datum&&u5(p.beginn)===u5(a.p_beginn));
       if(i<0)return{data:null,error:{message:"Diese Schicht ist in der veroeffentlichten Planung nicht (mehr) vorhanden. Bitte neu laden."}};__store.planung.splice(i,1);}
     const ang={id:++folge,kw_start_datum:a.p_kw,datum:a.p_datum,schicht_id:a.p_schicht_id,beginn:u5(a.p_beginn)+":00",ende:u5(a.p_ende)+":00",status:"frei",frei_von:a.p_von||null,uebernommen_von:null,erstellt_am:new Date().toISOString(),erledigt_am:null};
     __store.boerse_angebot=__store.boerse_angebot||[];__store.boerse_angebot.push(ang);
     const aktiv=new Set(__store.employees.filter(e=>e.aktiv).map(e=>e.personalnummer));
     const ber=Array.from(new Set(a.p_berechtigt||[])).filter(pn=>aktiv.has(pn)&&pn!==a.p_von&&!__store.planung.some(p=>p.personalnummer===pn&&p.datum===a.p_datum));
     __store.boerse_berechtigt=(__store.boerse_berechtigt||[]).concat(ber.map(pn=>({angebot_id:ang.id,personalnummer:pn})));
     aenderung(ang,a.p_von?"freigegeben":"zusatz",a.p_von||null,"admin");nachzaehlen(a.p_kw);__save();__LOG.push("freigeben "+ang.id+" "+ber.length);
     return{data:{id:ang.id,berechtigt:ber.length},error:null};}
   if(n==="boerse_zuruecknehmen"){
     if(ALS)return{data:null,error:{message:"Nur fuer Admins."}};
     const ang=(__store.boerse_angebot||[]).find(x=>x.id===a.p_id);if(!ang)return{data:null,error:{message:"Angebot nicht gefunden."}};
     if(ang.status!=="frei")return{data:{ok:false,status:ang.status},error:null};
     ang.status="zurueckgenommen";ang.erledigt_am=new Date().toISOString();aenderung(ang,"zurueckgenommen",null,"admin");__save();return{data:{ok:true,status:ang.status},error:null};}
   if(n==="boerse_meine_angebote"){
     if(!ALS)return{data:[],error:null};
     const ids=new Set((__store.boerse_berechtigt||[]).filter(b=>b.personalnummer===ALS).map(b=>b.angebot_id));
     const l=(__store.boerse_angebot||[]).filter(x=>ids.has(x.id)&&x.status==="frei"&&Date.now()<schlussMs(x.datum,x.beginn)&&!__store.planung.some(p=>p.personalnummer===ALS&&p.datum===x.datum))
       .map(x=>({id:x.id,datum:x.datum,schicht_id:x.schicht_id,beginn:x.beginn,ende:x.ende}));
     return{data:l,error:null};}
   if(n==="boerse_uebernehmen"){
     if(!ALS)return{data:null,error:{message:"Nicht angemeldet."}};
     const ang=(__store.boerse_angebot||[]).find(x=>x.id===a.p_id);
     if(!ang)return{data:{ok:false,grund:"vergeben"},error:null};
     if(!(__store.boerse_berechtigt||[]).some(b=>b.angebot_id===ang.id&&b.personalnummer===ALS))return{data:{ok:false,grund:"nicht_berechtigt"},error:null};
     if(ang.status!=="frei")return{data:{ok:false,grund:"vergeben"},error:null};
     if(Date.now()>=schlussMs(ang.datum,ang.beginn))return{data:{ok:false,grund:"zu_spaet"},error:null};
     if(__store.planung.some(p=>p.personalnummer===ALS&&p.datum===ang.datum))return{data:{ok:false,grund:"schon_eingeplant"},error:null};
     __store.planung.push({id:++folge,personalnummer:ALS,datum:ang.datum,schicht_id:ang.schicht_id,beginn:ang.beginn,ende:ang.ende,kw_start_datum:ang.kw_start_datum});
     ang.status="uebernommen";ang.uebernommen_von=ALS;ang.erledigt_am=new Date().toISOString();aenderung(ang,"uebernommen",ALS,"boerse");nachzaehlen(ang.kw_start_datum);__save();
     return{data:{ok:true,datum:ang.datum,beginn:ang.beginn,ende:ang.ende},error:null};}
   if(n==="fedex_datei_vermerken"){
     if(ALS)return{data:null,error:{message:"Nur fuer Admins."}};
     const am=new Date().toISOString();const st=(__store.planung_stand||[]).find(s=>s.kw_start_datum===a.p_kw);if(st)st.fedex_datei_am=am;__save();return{data:am,error:null};}
   if(n==="muss_passwort_aendern")return{data:false,error:null};
   if(n==="aktive_woche"||n==="get_or_create_week")return{data:START,error:null};
   if(n==="wochen_vorausanlegen"){for(let i=0;i<4;i++)wocheAnlegen(plusTage(START,7*i));__save();return{data:4,error:null};}
   if(n==="woche_aus_standard_neu_laden"){schichtenAusStandard(a.p_kw_start);__save();__LOG.push("neu_laden "+a.p_kw_start);return{data:15,error:null};}
   if(n==="tag_sperren"){const t=__store.week_days.find(x=>x.datum===a.p_datum);if(!t)return{data:null,error:{message:"Tag nicht gefunden"}};
     t.gesperrt=!!a.p_gesperrt;t.grund=a.p_gesperrt?(a.p_grund||null):null;
     if(a.p_gesperrt)__store.availability=__store.availability.filter(v=>v.datum!==a.p_datum);__save();return{data:null,error:null};}
   if(n==="nachfrist_oeffnen"){
     const min=a.p_minuten==null?10:a.p_minuten;
     if(min<0||min>60)return{data:null,error:{message:"Minuten muessen zwischen 0 und 60 liegen."}};
     if(!__store.employees.some(e=>e.aktiv&&e.personalnummer===a.p_personalnummer))return{data:null,error:{message:"Personalnummer ist nicht aktiv."}};
     const bis=new Date(Date.now()+min*60000).toISOString();
     __store.nachfrist=__store.nachfrist||[];
     const v=__store.nachfrist.find(x=>x.personalnummer===a.p_personalnummer&&x.kw_start_datum===START);
     if(v){v.bis=bis;v.geoeffnet_am=new Date().toISOString();}else __store.nachfrist.push({personalnummer:a.p_personalnummer,kw_start_datum:START,bis:bis,geoeffnet_am:new Date().toISOString()});
     __save();__LOG.push("nachfrist "+a.p_personalnummer+" "+min);return{data:{kw_start_datum:START,bis:bis},error:null};}
   if(n==="planung_ersetzen"){
     const kw=a.kw,liste=a.eintraege||[];
     if(!kw||new Date(kw+"T00:00:00Z").getUTCDay()!==1)return{data:null,error:{message:"kw muss ein Montag sein"}};
     const aktiv=new Set(__store.employees.filter(e=>e.aktiv).map(e=>e.personalnummer));
     for(const e of liste){if(!aktiv.has(e.personalnummer))return{data:null,error:{message:"Personalnummer "+e.personalnummer+" ist nicht aktiv"}};}
     __store.planung.filter(p=>p.kw_start_datum===kw).forEach(p=>__store.planung_historie.push(Object.assign({},p,{id:++folge,gesichert_am:new Date().toISOString()})));
     __store.planung=__store.planung.filter(p=>p.kw_start_datum!==kw).concat(liste.map(e=>Object.assign({id:++folge,kw_start_datum:kw},e)));
     const st=__store.planung_stand.find(s=>s.kw_start_datum===kw);const stand={kw_start_datum:kw,aktualisiert_am:new Date().toISOString(),anzahl:liste.length};
     if(st)Object.assign(st,stand);else __store.planung_stand.push(stand);
     (__store.boerse_angebot||[]).filter(x=>x.kw_start_datum===kw&&x.status==="frei").forEach(x=>{aenderung(x,"geschlossen",null,"admin");x.status="geschlossen";x.erledigt_am=new Date().toISOString();});
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
   if(name==="mitarbeiter-verwalten"){
     // gleiche Regeln wie supabase/functions/mitarbeiter-verwalten
     const a=body.aktion;
     if(a==="anlegen"||a==="reaktivieren"){
       const pn=String(body.personalnummer||"").trim(),pw=String(body.passwort||"").trim();
       if(!PN_MUSTER.test(pn))return{data:{ok:false,fehler:["Personalnummer \\""+pn+"\\" enthaelt unerlaubte Zeichen."]},error:null};
       if(pw.length<10||pw.length>72)return{data:{ok:false,fehler:["Startpasswort muss mindestens 10 Zeichen haben."]},error:null};
       const v=__store.employees.find(e=>e.personalnummer===pn);
       if(v&&v.aktiv)return{data:{ok:false,fehler:["Personalnummer "+pn+" hat bereits einen aktiven Zugang."]},error:null};
       if(a==="reaktivieren"&&!v)return{data:{ok:false,fehler:["Personalnummer "+pn+" ist nicht angelegt."]},error:null};
       if(__store.employees.some(e=>e.personalnummer!==pn&&e.personalnummer.toLowerCase()===pn.toLowerCase()))return{data:{ok:false,fehler:["Nur Gross/Klein verschieden."]},error:null};
       if(v){v.aktiv=true;v.__pw=pw;}else __store.employees.push({personalnummer:pn,aktiv:true,__pw:pw});
       __save();__LOG.push("mv "+a+" "+pn);return{data:{ok:true,aktion:a,personalnummer:pn,reaktiviert:!!v},error:null};
     }
     if(a==="deaktivieren"){
       const pns=Array.from(new Set((body.personalnummern||[]).map(x=>String(x||"").trim()).filter(x=>x)));
       if(!pns.length)return{data:{ok:false,fehler:["Keine Personalnummer angegeben."]},error:null};
       const unbekannt=pns.filter(pn=>!__store.employees.some(e=>e.personalnummer===pn));
       if(unbekannt.length)return{data:{ok:false,fehler:["Nicht angelegt: "+unbekannt.join(", ")]},error:null};
       const ziel=pns.filter(pn=>__store.employees.find(e=>e.personalnummer===pn).aktiv);
       const aktivVorher=__store.employees.filter(e=>e.aktiv).length;
       if(ziel.length>=3&&ziel.length>aktivVorher/2&&Number(body.bestaetigt)!==ziel.length)return{data:{ok:false,fehler:["Das wuerde "+ziel.length+" von "+aktivVorher+" aktiven Zugaengen deaktivieren. Bitte ausdruecklich bestaetigen."]},error:null};
       ziel.forEach(pn=>{__store.employees.find(e=>e.personalnummer===pn).aktiv=false;});
       __save();__LOG.push("mv deaktivieren "+ziel.join(","));return{data:{ok:true,aktion:a,deaktiviert:ziel.length,schon_inaktiv:pns.length-ziel.length,probleme:[]},error:null};
     }
     return{data:{ok:false,fehler:["Unbekannte Aktion."]},error:null};
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
["tresor.js", "planung-solver.js", "dispo-export.js", "minijob.js", "schichtboerse.js"].forEach((f) => { LIVE["/" + f] = () => fs.readFileSync(path.join(root, f), "utf8"); });

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
