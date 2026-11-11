"use strict";
// Aufruf: node tests/solver.test.js   (nur synthetische Daten, keine Namen)
//
// Prüft planung-solver.js gegen den Vertrag vom 11.11.2026 (Rangfolge strikt:
// harte Regeln > Lücken > Wunschgrenze > Fahrgemeinschaft > Rest).
//   Teil A  unabhängige Referenz der Zielfunktion [L, U, T] samt Selbsttests
//   Teil B  bisherige Tests (angepasst)
//   Teil C  Verhalten an kleinen, von Hand gebauten Fällen
//   Teil D  Brute-Force: Optimum auf vielen Mini-Instanzen (fester Startwert)
//   Teil E  Härtefall-Woche, Teil F Laufzeit
// Optional: BRUTE_N=200 (Zahl der Mini-Instanzen), BRUTE_VOLL=1 (Aufzählung
// zusätzlich ohne eigene Vorprüfung, nur mit S.pruefe – Selbstkontrolle, langsam).
const assert = require("assert");
const S = require("../planung-solver.js");
const synth = require("./synthetisch.js");

let bestanden = 0, gescheitert = 0;
function test(name, fn) {
  try { fn(); bestanden++; console.log("ok   " + name); }
  catch (e) { gescheitert++; console.error("FAIL " + name + "\n     " + e.message); process.exitCode = 1; }
}

// ======================================================================
// Teil A – unabhängige Referenz (solver-api.md). Nutzt nichts aus dem
// Solver: eigene Platzliste, eigener Standardbedarf, eigene Normalisierung,
// eigene Prüfung der harten Regeln.
// ======================================================================
const ZEIT = { FRUEH: ["05:30", "08:30"], SPAET: ["18:30", "22:30"], LANG: ["16:00", "22:30"] };
const ORD = { FRUEH: 0, SPAET: 1, LANG: 2 };
const RUHE_MIN = 11 * 60, TAG_MAX_MIN = 10 * 60, WOCHE_MAX_MIN = 48 * 60;

const hm = (t) => { const p = String(t).split(":"); return (+p[0] || 0) * 60 + (+p[1] || 0); };
const tagNr = (iso) => Math.round(Date.parse(iso + "T00:00:00Z") / 86400000);
const istMontag = (iso) => new Date(iso + "T00:00:00Z").getUTCDay() === 1;
const leer = (pn) => pn === null || pn === undefined;
const refNorm = (k) => (leer(k) ? "" : String(k).normalize("NFC").replace(/\s+/g, "").toUpperCase());

function refSlots(e) {
  const gesperrt = {};
  (e.tage || []).forEach((t) => { if (t.gesperrt) gesperrt[t.datum] = true; });
  let bed = e.bedarf;
  if (!bed) {  // Standardbedarf: Mo 9 früh / 10 spät, sonst 6 / 10, Office 0
    bed = {};
    (e.schichten || []).forEach((s) => { if (!bed[s.datum]) bed[s.datum] = { FRUEH: istMontag(s.datum) ? 9 : 6, SPAET: 10, LANG: 0 }; });
  }
  const out = [];
  (e.schichten || []).forEach((s) => {
    if (!Object.prototype.hasOwnProperty.call(ORD, s.schicht_id) || s.aktiv === false || gesperrt[s.datum]) return;
    const n = (bed[s.datum] && bed[s.datum][s.schicht_id]) | 0;
    const t0 = tagNr(s.datum) * 1440;
    for (let i = 1; i <= n; i++) {
      out.push({ id: s.datum + "|" + s.schicht_id + "|" + i, datum: s.datum, schicht_id: s.schicht_id, nr: i,
        start: t0 + hm(s.beginn), end: t0 + hm(s.ende), dauer: hm(s.ende) - hm(s.beginn) });
    }
  });
  return out.sort((a, b) => (a.datum < b.datum ? -1 : a.datum > b.datum ? 1 : 0) ||
    ORD[a.schicht_id] - ORD[b.schicht_id] || a.nr - b.nr);
}

function refKontext(e) {
  const slots = refSlots(e), P = {};
  (e.personen || []).forEach((p) => {
    const verf = {};
    (p.verfuegbar || []).forEach((x) => { verf[x.datum + "|" + x.schicht_id] = true; });
    P[String(p.personalnummer)] = { verf, wunsch: p.max_schichten > 0 ? Number(p.max_schichten) : Infinity,
      gruppe: refNorm(p.fahrgemeinschaft) };
  });
  const dauer = {}, plaetze = {}, tage = [];
  slots.forEach((s) => {
    const k = s.datum + "|" + s.schicht_id;
    dauer[k] = s.dauer;
    plaetze[k] = (plaetze[k] || 0) + 1;
    if (tage.indexOf(s.datum) < 0) tage.push(s.datum);
  });
  const gruppen = {};
  Object.keys(P).sort().forEach((pn) => { const g = P[pn].gruppe; if (g) (gruppen[g] = gruppen[g] || []).push(pn); });
  const paare = [];  // Gruppen mit < 2 Personen ergeben keine Paare
  Object.keys(gruppen).sort().forEach((g) => {
    const m = gruppen[g];
    for (let i = 0; i < m.length; i++) for (let j = i + 1; j < m.length; j++) paare.push({ p: m[i], q: m[j], g });
  });
  return { slots, P, dauer, plaetze, tage, gruppen, paare };
}

function refVerfuegbar(person, d, t) {
  return !!person && (!!person.verf[d + "|" + t] || (t === "SPAET" && !!person.verf[d + "|LANG"]));
}

// Kennzahlen eines Plans: kosten [L, U, T], getrennte Paar-Tage, Überschreitungen
function refAuswerten(ctx, zuw) {
  let L = 0;
  const anzahl = {}, minuten = {}, arten = {};
  ctx.slots.forEach((s) => {
    const pn = zuw[s.id];
    if (leer(pn)) { L += s.schicht_id === "LANG" ? 1 : 10; return; }
    anzahl[pn] = (anzahl[pn] || 0) + 1;
    minuten[pn] = (minuten[pn] || 0) + s.dauer;
    const a = (arten[pn] = arten[pn] || {});
    const l = (a[s.datum] = a[s.datum] || []);
    if (l.indexOf(s.schicht_id) < 0) l.push(s.schicht_id);
  });
  let U = 0;
  const ueber = [];
  Object.keys(anzahl).sort().forEach((pn) => {
    const w = ctx.P[pn] ? ctx.P[pn].wunsch : Infinity;
    if (anzahl[pn] > w) { U += anzahl[pn] - w; ueber.push({ pn, anzahl: anzahl[pn], grenze: w }); }
  });
  const artenVon = (pn, d) => ((arten[pn] || {})[d] || []).slice().sort();
  // koennte(x, eigene, andere, d, t) wörtlich nach Vertrag (präzisiert 11.11.)
  function koennte(x, eigene, andere, d, t, g) {
    if (!refVerfuegbar(ctx.P[x], d, t)) return false;
    const schonDa = ctx.gruppen[g].filter((m) => artenVon(m, d).indexOf(t) >= 0).length;
    if (!((ctx.plaetze[d + "|" + t] || 0) > schonDa)) return false;            // Kapazität
    if (eigene.length === 0) {                                                 // käme an d neu dazu
      return (anzahl[x] || 0) + 1 <= ctx.P[x].wunsch && (minuten[x] || 0) + ctx.dauer[d + "|" + t] <= WOCHE_MAX_MIN;
    }
    return eigene.some((a) => andere.indexOf(a) < 0);                          // Wechsel
  }
  const getrennt = [];
  ctx.paare.forEach(({ p, q, g }) => {
    ctx.tage.forEach((d) => {
      const A = artenVon(p, d), B = artenVon(q, d);
      if (A.join() === B.join()) return;
      if (A.some((t) => B.indexOf(t) < 0 && koennte(q, B, A, d, t, g)) ||
          B.some((t) => A.indexOf(t) < 0 && koennte(p, A, B, d, t, g))) {
        getrennt.push({ pn: p, partner: q, datum: d, gruppe: g, arten_pn: A, arten_partner: B });
      }
    });
  });
  return { kosten: [L, U, getrennt.length], getrennt, ueber, anzahl };
}
const referenz = (e, zuw) => refAuswerten(refKontext(e), zuw).kosten;

// Harte Regeln: verfügbar (LANG deckt SPAET), keine gleiche Art/Überlappung am Tag,
// Ruhezeit ≥ 11 h zwischen Tagen, ≤ 10 h/Tag, ≤ 48 h/Woche
function refPasst(ctx, pn, s, liste) {
  if (!refVerfuegbar(ctx.P[pn], s.datum, s.schicht_id)) return false;
  let tag = s.dauer, woche = s.dauer;
  for (const a of liste) {
    woche += a.dauer;
    if (a.datum === s.datum) {
      if (a.schicht_id === s.schicht_id || (a.start < s.end && s.start < a.end)) return false;
      tag += a.dauer;
    } else if ((a.end <= s.start ? s.start - a.end : a.start - s.end) < RUHE_MIN) return false;
  }
  return tag <= TAG_MAX_MIN && woche <= WOCHE_MAX_MIN;
}
function refZulaessig(ctx, zuw) {
  const proPn = {};
  for (const s of ctx.slots) {
    const pn = zuw[s.id];
    if (leer(pn)) continue;
    const l = (proPn[pn] = proPn[pn] || []);
    if (!ctx.P[pn] || !refPasst(ctx, pn, s, l)) return false;
    l.push(s);
  }
  return true;
}

function lexVgl(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}
const paarSchluessel = (x) => [String(x.pn), String(x.partner)].sort().join("+") + "@" + x.datum;
const schluesselMenge = (liste) => Array.from(new Set((liste || []).map(paarSchluessel))).sort();

// ---------- Bausteine für kleine Fälle ----------
const D0 = "2026-10-19", D1 = "2026-10-20", D2 = "2026-10-21", D3 = "2026-10-22";
const D4 = "2026-10-23", D5 = "2026-10-24", D6 = "2026-10-25";
const pl = (d, t, n) => d + "|" + t + "|" + n;
const v = (d, ...arten) => arten.map((t) => ({ datum: d, schicht_id: t }));
const kopie = (x) => JSON.parse(JSON.stringify(x));
function person(pn, verfuegbar, extra) {
  return Object.assign({ personalnummer: pn, verfuegbar, max_schichten: null, kategorie: "minijob", fahrgemeinschaft: null }, extra);
}
function schicht(d, t, beginn, ende) { return { datum: d, schicht_id: t, beginn: beginn || ZEIT[t][0], ende: ende || ZEIT[t][1] }; }
// Eingabe mit allen drei Schichtarten je Tag (Standardzeiten); fehlender Bedarf = 0
function instanz(bedarf, personen) {
  const tage = Object.keys(bedarf).sort(), schichten = [], bed = {};
  tage.forEach((d) => {
    bed[d] = Object.assign({ FRUEH: 0, SPAET: 0, LANG: 0 }, bedarf[d]);
    ["FRUEH", "SPAET", "LANG"].forEach((t) => schichten.push(schicht(d, t)));
  });
  return { schichten, tage: tage.map((d) => ({ datum: d, gesperrt: false })), bedarf: bed, personen };
}
// vollständige Zuweisung (alle Plätze, leer = null) aus einer Teilangabe
function plan(e, teil) {
  const z = {};
  refSlots(e).forEach((s) => { z[s.id] = null; });
  Object.keys(teil || {}).forEach((id) => {
    if (!(id in z)) throw new Error("Platz " + id + " gibt es nicht");
    z[id] = teil[id];
  });
  return z;
}
const artenAm = (z, pn, d) => Object.keys(z).filter((id) => z[id] === pn && id.split("|")[0] === d)
  .map((id) => id.split("|")[1]).filter((t, i, l) => l.indexOf(t) === i).sort();
const wer = (z, d, t) => Object.keys(z).filter((id) => { const k = id.split("|"); return k[0] === d && k[1] === t && !leer(z[id]); })
  .map((id) => z[id]).sort();
const kurz = (z) => Object.keys(z).sort().filter((id) => !leer(z[id])).map((id) => id + "=" + z[id]).join(" ");
const fehler = (erg) => erg.verstoesse.filter((x) => x.art === "fehler");
const hinweise = (erg, typ) => (erg.verstoesse || []).filter((x) => x.typ === typ);
const sSlotsVon = (e) => S.slotsBauen(e.schichten, e.bedarf || S.standardBedarf(e.schichten), e.tage);

// ---------- Referenzfälle mit bekannter Antwort ----------
const REF_FAELLE = [];
function refFall(gruppe, name, e, teil, soll, getrennt) { REF_FAELLE.push({ gruppe, name, e, z: plan(e, teil), soll, getrennt }); }

(function () {
  const e = instanz({ [D1]: { FRUEH: 2, SPAET: 1, LANG: 1 } }, [person("A", v(D1, "FRUEH", "SPAET", "LANG"))]);
  refFall("luecken", "alles leer: 2·10 + 10 + 1", e, {}, [31, 0, 0], []);
  refFall("luecken", "ein Früh besetzt", e, { [pl(D1, "FRUEH", 1)]: "A" }, [21, 0, 0], []);
  const e2 = instanz({ [D1]: { FRUEH: 1, SPAET: 1 }, [D2]: { FRUEH: 1 } }, [
    person("A", v(D1, "FRUEH", "SPAET").concat(v(D2, "FRUEH")), { max_schichten: 1 }),
    person("B", v(D1, "FRUEH", "SPAET"), { max_schichten: 0 }),
    person("C", v(D2, "FRUEH"))]);
  refFall("luecken", "Wunsch 1, drei Schichten → 2 Überschreitungen",
    e2, { [pl(D1, "FRUEH", 1)]: "A", [pl(D1, "SPAET", 1)]: "A", [pl(D2, "FRUEH", 1)]: "A" }, [0, 2, 0], []);
  refFall("luecken", "Wunsch 0 und null = unbegrenzt",
    e2, { [pl(D1, "FRUEH", 1)]: "B", [pl(D1, "SPAET", 1)]: "B", [pl(D2, "FRUEH", 1)]: "C" }, [0, 0, 0], []);
})();
(function () {
  const g1 = { fahrgemeinschaft: "G1" };
  const e = instanz({ [D1]: { FRUEH: 2 } }, [person("A", v(D1, "FRUEH"), g1), person("B", [], g1), person("C", v(D1, "FRUEH"))]);
  refFall("nichtVerf", "B nicht verfügbar → A allein ist nicht getrennt", e, { [pl(D1, "FRUEH", 1)]: "A", [pl(D1, "FRUEH", 2)]: "C" }, [0, 0, 0], []);
  const e2 = instanz({ [D1]: { FRUEH: 2 } }, [person("A", v(D1, "FRUEH"), g1), person("B", v(D1, "FRUEH"), g1), person("C", v(D1, "FRUEH"))]);
  refFall("nichtVerf", "B verfügbar → getrennt", e2, { [pl(D1, "FRUEH", 1)]: "A", [pl(D1, "FRUEH", 2)]: "C" }, [0, 0, 1], ["A+B@" + D1]);
  refFall("nichtVerf", "beide frei → nicht getrennt", e2, { [pl(D1, "FRUEH", 1)]: "C" }, [10, 0, 0], []);
  refFall("nichtVerf", "beide zusammen", e2, { [pl(D1, "FRUEH", 1)]: "A", [pl(D1, "FRUEH", 2)]: "B" }, [0, 0, 0], []);
})();
(function () {
  const mk = (wunschB) => instanz({ [D1]: { FRUEH: 2 }, [D2]: { FRUEH: 1 } }, [
    person("A", v(D1, "FRUEH"), { fahrgemeinschaft: "G1" }),
    person("B", v(D1, "FRUEH").concat(v(D2, "FRUEH")), { fahrgemeinschaft: "G1", max_schichten: wunschB }),
    person("C", v(D1, "FRUEH"))]);
  const teil = { [pl(D1, "FRUEH", 1)]: "A", [pl(D1, "FRUEH", 2)]: "C", [pl(D2, "FRUEH", 1)]: "B" };
  refFall("grenze", "B an Wunschgrenze 1 → nicht getrennt", mk(1), teil, [0, 0, 0], []);
  refFall("grenze", "B Wunsch 2 → getrennt", mk(2), teil, [0, 0, 1], ["A+B@" + D1]);
  refFall("grenze", "B ohne Wunsch → getrennt", mk(null), teil, [0, 0, 1], ["A+B@" + D1]);
  // 48 h: B hat 4 × 10 h + 5 h = 2700 min; Früh (180 min) passt genau noch (≤ 2880), mit 1 min mehr nicht
  const mk48 = (spaetEnde) => {
    const tage = [D1, D2, D3, D4];
    const bedarf = { [D5]: { SPAET: 1 }, [D6]: { FRUEH: 2 } };
    tage.forEach((d) => { bedarf[d] = { LANG: 1 }; });
    return {
      schichten: tage.map((d) => schicht(d, "LANG", "08:00", "18:00")).concat([schicht(D5, "SPAET", "16:00", spaetEnde), schicht(D6, "FRUEH")]),
      tage: tage.concat([D5, D6]).map((d) => ({ datum: d, gesperrt: false })), bedarf,
      personen: [person("A", v(D6, "FRUEH"), { fahrgemeinschaft: "G1" }),
        person("B", tage.map((d) => ({ datum: d, schicht_id: "LANG" })).concat(v(D5, "SPAET"), v(D6, "FRUEH")), { fahrgemeinschaft: "G1" })]
    };
  };
  const teil48 = { [pl(D1, "LANG", 1)]: "B", [pl(D2, "LANG", 1)]: "B", [pl(D3, "LANG", 1)]: "B", [pl(D4, "LANG", 1)]: "B",
    [pl(D5, "SPAET", 1)]: "B", [pl(D6, "FRUEH", 1)]: "A" };
  refFall("grenze", "48 h: 2700 + 180 = 2880 min → könnte noch → getrennt", mk48("21:00"), teil48, [10, 0, 1], ["A+B@" + D6]);
  refFall("grenze", "48 h: 2701 + 180 min → könnte nicht → nicht getrennt", mk48("21:01"), teil48, [10, 0, 0], []);
})();
(function () {
  const e = instanz({ [D0]: { SPAET: 1 }, [D1]: { FRUEH: 2 } }, [
    person("A", v(D1, "FRUEH"), { fahrgemeinschaft: "G1" }),
    person("B", v(D0, "SPAET").concat(v(D1, "FRUEH")), { fahrgemeinschaft: "G1" })]);
  refFall("ruhe", "B arbeitet Spät am Vortag, Früh ginge nur ohne Ruhezeit → trotzdem getrennt",
    e, { [pl(D0, "SPAET", 1)]: "B", [pl(D1, "FRUEH", 1)]: "A" }, [10, 0, 1], ["A+B@" + D1]);
})();
(function () {
  const leute = (bFrueh, aSpaet) => [
    person("A", v(D1, "FRUEH").concat(aSpaet ? v(D1, "SPAET") : []), { fahrgemeinschaft: "G1" }),
    person("B", v(D1, "SPAET").concat(bFrueh ? v(D1, "FRUEH") : []), { fahrgemeinschaft: "G1", max_schichten: 1 }),
    person("C", v(D1, "FRUEH"))];
  const teil = { [pl(D1, "FRUEH", 1)]: "A", [pl(D1, "FRUEH", 2)]: "C", [pl(D1, "SPAET", 1)]: "B" };
  refFall("wechsel", "B (an Wunschgrenze) könnte auf Früh wechseln → getrennt",
    instanz({ [D1]: { FRUEH: 2, SPAET: 1 } }, leute(true, false)), teil, [0, 0, 1], ["A+B@" + D1]);
  refFall("wechsel", "keiner ist für die Art des anderen verfügbar → nicht getrennt",
    instanz({ [D1]: { FRUEH: 2, SPAET: 1 } }, leute(false, false)), teil, [0, 0, 0], []);
  refFall("wechsel", "A könnte auf Spät wechseln (2 Spät-Plätze) → getrennt",
    instanz({ [D1]: { FRUEH: 1, SPAET: 2 } }, leute(false, true)), { [pl(D1, "FRUEH", 1)]: "A", [pl(D1, "SPAET", 1)]: "B" }, [10, 0, 1], ["A+B@" + D1]);
  refFall("wechsel", "je 1 Platz Früh/Spät, kein freier Platz zum Wechseln → nicht getrennt",
    instanz({ [D1]: { FRUEH: 1, SPAET: 1 } }, leute(true, true)), { [pl(D1, "FRUEH", 1)]: "A", [pl(D1, "SPAET", 1)]: "B" }, [0, 0, 0], []);
})();
(function () {
  const mk = (n) => instanz({ [D1]: { LANG: n } }, [person("A", v(D1, "LANG"), { fahrgemeinschaft: "G1" }), person("B", v(D1, "LANG"), { fahrgemeinschaft: "G1" })]);
  refFall("kapazitaet", "1 Office-Platz, A arbeitet ihn → B könnte nicht dazu", mk(1), { [pl(D1, "LANG", 1)]: "A" }, [0, 0, 0], []);
  refFall("kapazitaet", "2 Office-Plätze, A allein → getrennt", mk(2), { [pl(D1, "LANG", 1)]: "A" }, [1, 0, 1], ["A+B@" + D1]);
})();
(function () {
  const e = instanz({ [D1]: { FRUEH: 2, SPAET: 2 } }, ["A", "B"].map((pn) => person(pn, v(D1, "FRUEH", "SPAET"), { fahrgemeinschaft: "G1" })));
  refFall("doppel", "A Früh+Spät, B Früh (für Spät verfügbar) → nicht getrennt",
    e, { [pl(D1, "FRUEH", 1)]: "A", [pl(D1, "SPAET", 1)]: "A", [pl(D1, "FRUEH", 2)]: "B" }, [10, 0, 0], []);
  refFall("doppel", "A Früh+Spät, B frei → getrennt",
    e, { [pl(D1, "FRUEH", 1)]: "A", [pl(D1, "SPAET", 1)]: "A" }, [20, 0, 1], ["A+B@" + D1]);
})();
(function () {
  const e = instanz({ [D1]: { SPAET: 2, LANG: 1 } }, [
    person("A", v(D1, "SPAET", "LANG"), { fahrgemeinschaft: "G1" }), person("B", v(D1, "LANG"), { fahrgemeinschaft: "G1" })]);
  refFall("lang", "B nur LANG-verfügbar, A arbeitet Spät → B könnte Spät → getrennt", e, { [pl(D1, "SPAET", 1)]: "A" }, [11, 0, 1], ["A+B@" + D1]);
  const e2 = instanz({ [D1]: { SPAET: 2, LANG: 2 } }, [
    person("A", v(D1, "LANG"), { fahrgemeinschaft: "G1" }), person("B", v(D1, "SPAET"), { fahrgemeinschaft: "G1" })]);
  refFall("lang", "B nur Spät-verfügbar, A arbeitet LANG → B könnte nicht → nicht getrennt", e2, { [pl(D1, "LANG", 1)]: "A" }, [21, 0, 0], []);
})();
(function () {
  const mk = (ka, kb) => instanz({ [D1]: { FRUEH: 2 } }, [person("A", v(D1, "FRUEH"), { fahrgemeinschaft: ka }), person("B", v(D1, "FRUEH"), { fahrgemeinschaft: kb })]);
  const teil = { [pl(D1, "FRUEH", 1)]: "A" };
  refFall("kennung", "„fg 1“ und „ FG1“ sind eine Gruppe", mk("fg 1", " FG1"), teil, [10, 0, 1], ["A+B@" + D1]);
  refFall("kennung", "NFC: „fa\\u0308 1“ und „F\\u00C41“ sind eine Gruppe", mk("fä 1", "FÄ1"), teil, [10, 0, 1], ["A+B@" + D1]);
  refFall("kennung", "„FG1“ und „FG2“: zwei Einzelkennungen zählen nicht", mk("FG1", "FG2"), teil, [10, 0, 0], []);
  refFall("kennung", "leere Kennung ist keine Gruppe", mk(" ", ""), teil, [10, 0, 0], []);
})();
(function () {
  const mk = (n) => instanz({ [D1]: { FRUEH: n } }, ["A", "B", "C"].map((pn) => person(pn, v(D1, "FRUEH"), { fahrgemeinschaft: "G3" })));
  refFall("gruppe3", "A allein (3 Plätze) → A+B und A+C getrennt", mk(3), { [pl(D1, "FRUEH", 1)]: "A" }, [20, 0, 2], ["A+B@" + D1, "A+C@" + D1]);
  refFall("gruppe3", "A und B (3 Plätze) → A+C und B+C getrennt", mk(3), { [pl(D1, "FRUEH", 1)]: "A", [pl(D1, "FRUEH", 2)]: "B" }, [10, 0, 2], ["A+C@" + D1, "B+C@" + D1]);
  refFall("gruppe3", "A und B (nur 2 Plätze) → C könnte nicht dazu", mk(2), { [pl(D1, "FRUEH", 1)]: "A", [pl(D1, "FRUEH", 2)]: "B" }, [0, 0, 0], []);
  refFall("gruppe3", "alle drei zusammen", mk(3), { [pl(D1, "FRUEH", 1)]: "A", [pl(D1, "FRUEH", 2)]: "B", [pl(D1, "FRUEH", 3)]: "C" }, [0, 0, 0], []);
  const e2 = instanz({ [D1]: { FRUEH: 2, SPAET: 2 }, [D2]: { FRUEH: 2, SPAET: 2 } },
    ["A", "B"].map((pn) => person(pn, v(D1, "FRUEH", "SPAET").concat(v(D2, "FRUEH", "SPAET")), { fahrgemeinschaft: "G1" })));
  refFall("gruppe3", "beide Richtungen am selben Tag zählen einmal, jeder Tag einzeln",
    e2, { [pl(D1, "FRUEH", 1)]: "A", [pl(D1, "SPAET", 1)]: "B", [pl(D2, "FRUEH", 1)]: "A", [pl(D2, "SPAET", 1)]: "B" }, [40, 0, 2], ["A+B@" + D1, "A+B@" + D2]);
})();

// ---------- Selbsttests der Referenz (ohne Solver) ----------
test("Referenz: Plätze und Standardbedarf (Mo 9/10, sonst 6/10, Office 0; inaktiv/gesperrt ohne Plätze)", () => {
  const schichten = [D0, D1, D2, D3].reduce((l, d) => l.concat(["FRUEH", "SPAET", "LANG"].map((t) => schicht(d, t))), []);
  schichten.find((s) => s.datum === D2 && s.schicht_id === "FRUEH").aktiv = false;
  const e = { schichten, tage: [{ datum: D0 }, { datum: D1 }, { datum: D2 }, { datum: D3, gesperrt: true }], personen: [] };
  const zahl = {};
  refSlots(e).forEach((s) => { const k = s.datum + " " + s.schicht_id; zahl[k] = (zahl[k] || 0) + 1; });
  assert.deepStrictEqual(zahl, { [D0 + " FRUEH"]: 9, [D0 + " SPAET"]: 10, [D1 + " FRUEH"]: 6, [D1 + " SPAET"]: 10, [D2 + " SPAET"]: 10 });
  assert.deepStrictEqual(refSlots(instanz({ [D1]: { FRUEH: 1, SPAET: 1, LANG: 1 } }, [])).map((s) => s.dauer), [180, 240, 390]);
});

[["luecken", "Referenz: Lücken zählen 10 (Früh/Spät) bzw. 1 (Office); Überschreitungen je Schicht über dem Wunsch"],
  ["nichtVerf", "Referenz: Partner nicht verfügbar → nicht getrennt; beide frei → nicht getrennt"],
  ["grenze", "Referenz: Partner an Wunschgrenze oder über 48 h → nicht getrennt (2880 min zählt noch)"],
  ["ruhe", "Referenz: Ruhezeit entschuldigt nicht"],
  ["wechsel", "Referenz: Wechsel auf freien Platz möglich → getrennt, auch an der Wunschgrenze"],
  ["kapazitaet", "Referenz: Kapazität – nur ein Office-Platz → nicht getrennt"],
  ["doppel", "Referenz: Doppelschicht – niemand wird in eine zweite Schicht gedrängt"],
  ["lang", "Referenz: LANG-Verfügbarkeit deckt SPAET ab (nicht umgekehrt)"],
  ["kennung", "Referenz: Kennungen normalisiert („fg 1“ = „FG1“, NFC), Einzelkennungen zählen nicht"],
  ["gruppe3", "Referenz: 3er-Gruppe paarweise, je Paar und Tag höchstens 1"]
].forEach(([gruppe, name]) => test(name, () => {
  REF_FAELLE.filter((f) => f.gruppe === gruppe).forEach((f) => {
    const r = refAuswerten(refKontext(f.e), f.z);
    assert.deepStrictEqual(r.kosten, f.soll, f.name + ": " + JSON.stringify(r.kosten) + " statt " + JSON.stringify(f.soll));
    assert.deepStrictEqual(schluesselMenge(r.getrennt), f.getrennt.slice().sort(), f.name + ": getrennte Paar-Tage");
  });
}));

test("Referenz: eigene Prüfung der harten Regeln", () => {
  const e = instanz({ [D0]: { SPAET: 1 }, [D1]: { FRUEH: 2, SPAET: 1, LANG: 1 } }, [
    person("A", v(D0, "SPAET").concat(v(D1, "FRUEH", "SPAET", "LANG"))), person("B", v(D1, "LANG"))]);
  const ctx = refKontext(e);
  const ok = (teil) => refZulaessig(ctx, plan(e, teil));
  assert.ok(ok({ [pl(D1, "FRUEH", 1)]: "A", [pl(D1, "SPAET", 1)]: "A" }), "Früh + Spät am Tag (7 h) ist erlaubt");
  assert.ok(ok({ [pl(D1, "FRUEH", 1)]: "A", [pl(D1, "LANG", 1)]: "A" }), "Früh + Office (9,5 h) ist erlaubt");
  assert.ok(ok({ [pl(D1, "SPAET", 1)]: "B" }), "LANG-Verfügbarkeit deckt Spät");
  assert.ok(!ok({ [pl(D1, "FRUEH", 1)]: "B" }), "nicht verfügbar");
  assert.ok(!ok({ [pl(D1, "FRUEH", 1)]: "A", [pl(D1, "FRUEH", 2)]: "A" }), "zweimal dieselbe Art");
  assert.ok(!ok({ [pl(D1, "SPAET", 1)]: "A", [pl(D1, "LANG", 1)]: "A" }), "Überlappung Spät/Office");
  assert.ok(!ok({ [pl(D0, "SPAET", 1)]: "A", [pl(D1, "FRUEH", 1)]: "A" }), "Ruhezeit Spät → Früh");
  assert.ok(ok({ [pl(D0, "SPAET", 1)]: "A", [pl(D1, "SPAET", 1)]: "A" }), "Spät → Spät");
  const lang = (ende) => {
    const e2 = { schichten: [schicht(D1, "FRUEH"), schicht(D1, "LANG", "09:00", ende)], tage: [{ datum: D1 }],
      bedarf: { [D1]: { FRUEH: 1, LANG: 1 } }, personen: [person("A", v(D1, "FRUEH", "LANG"))] };
    return refZulaessig(refKontext(e2), plan(e2, { [pl(D1, "FRUEH", 1)]: "A", [pl(D1, "LANG", 1)]: "A" }));
  };
  assert.ok(lang("16:00") && !lang("16:01"), "10 h am Tag: genau 10 h erlaubt, mehr nicht");
  const woche = (letzteEnde) => {
    const tage = [D1, D2, D3, D4, D5], bedarf = {};
    tage.forEach((d) => { bedarf[d] = { LANG: 1 }; });
    const e3 = { schichten: tage.map((d, i) => schicht(d, "LANG", "08:00", i === 4 ? letzteEnde : "18:00")),
      tage: tage.map((d) => ({ datum: d })), bedarf, personen: [person("A", tage.map((d) => ({ datum: d, schicht_id: "LANG" })))] };
    const teil = {}; tage.forEach((d) => { teil[pl(d, "LANG", 1)] = "A"; });
    return refZulaessig(refKontext(e3), plan(e3, teil));
  };
  assert.ok(woche("16:00") && !woche("16:01"), "48 h in der Woche: genau 48 h erlaubt, mehr nicht");
});

// ======================================================================
// Teil B – bisherige Tests (angepasst)
// ======================================================================
// Erfundene Daten (tests/synthetisch.js) statt der frueheren Testdaten-Datei
const json = synth.exportJson("2026-10-19");

function bedarf(f, s) {
  const b = {};
  json.tage.forEach((t) => { b[t.datum] = { FRUEH: f, SPAET: s, LANG: 0 }; });
  return b;
}
// Profile aus der erfundenen Stammliste (Kategorie, Fahrgemeinschaft)
function stammProfile(j) {
  const profile = {};
  synth.stammliste(j).slice(1).forEach((z) => {
    profile[z[0]] = { kategorie: String(z[3]).toLowerCase(), fahrgemeinschaft: z[4] || null };
  });
  return profile;
}
// Härtefall: jede Gruppe mit ≥ 2 abgegebenen Mitgliedern bekommt die vereinigte
// Verfügbarkeit der Gruppe und keinen Wunsch (max_schichten = null); Standardbedarf.
// alleMinijob: ohne Teilzeit – so hat der Plan am 11.11. gemessen (alter Solver: 9 von
// 25 Paar-Tagen getrennt nach alter Definition, 7 nach der präzisierten).
function haertefallEingabe(alleMinijob) {
  const j = synth.exportJson("2026-10-19");
  const profile = stammProfile(j);
  if (alleMinijob) Object.keys(profile).forEach((pn) => { profile[pn].kategorie = "minijob"; });
  const e = S.ausExport(j, profile);
  const gruppen = {};
  e.personen.forEach((p) => { const g = refNorm(p.fahrgemeinschaft); if (g) (gruppen[g] = gruppen[g] || []).push(p); });
  Object.keys(gruppen).forEach((g) => {
    const m = gruppen[g];
    if (m.length < 2) return;
    const alle = {};
    m.forEach((p) => (p.verfuegbar || []).forEach((x) => { alle[x.datum + "|" + x.schicht_id] = { datum: x.datum, schicht_id: x.schicht_id }; }));
    const liste = Object.keys(alle).sort().map((k) => alle[k]);
    m.forEach((p) => { p.verfuegbar = liste.map((x) => Object.assign({}, x)); p.max_schichten = null; });
  });
  return e;
}
// Ganze Testwochen nur einmal lösen (der neue Solver darf bis 2 s brauchen)
const WOCHEN = {
  std23: () => { const e = S.ausExport(json); e.bedarf = bedarf(2, 3); return e; },
  standard: () => S.ausExport(json),
  std46: () => { const e = S.ausExport(json); e.bedarf = bedarf(4, 6); return e; },
  haerte: () => haertefallEingabe(false),
  haerteMini: () => haertefallEingabe(true)
};
const wochenErg = {};
function woche(k) {
  if (!wochenErg[k]) {
    const eingabe = WOCHEN[k](), t0 = Date.now();
    const erg = S.loese(WOCHEN[k]());
    wochenErg[k] = { eingabe, erg, ms: Date.now() - t0 };
  }
  return wochenErg[k];
}

test("keine harten Verstöße auf den erfundenen Daten", () => {
  const { eingabe, erg } = woche("std23");
  assert.deepStrictEqual(fehler(erg), []);
  assert.ok(refZulaessig(refKontext(eingabe), erg.zuweisung), "eigene Prüfung findet einen harten Verstoß");
});

test("Standardbedarf: nie nicht-verfügbar, nie Spät→Früh am Folgetag", () => {
  const { erg } = woche("standard");
  assert.deepStrictEqual(fehler(erg), []);
  const proPn = {};
  erg.slots.forEach((s) => {
    const pn = erg.zuweisung[s.id];
    if (pn) (proPn[pn] = proPn[pn] || []).push(s);
  });
  Object.values(proPn).forEach((l) => {
    l.sort((a, b) => a.start - b.start);
    for (let i = 1; i < l.length; i++) {
      if (l[i].datum !== l[i - 1].datum) {
        assert.ok(l[i].start - l[i - 1].end >= S.RUHEZEIT_MIN, "Ruhezeit verletzt");
      }
    }
  });
});

test("deterministisch: gleicher Lauf, gleiches Ergebnis (auch mit Fahrgemeinschaften)", () => {
  ["std23", "haerte"].forEach((k) => {
    const a = woche(k).erg, b = S.loese(WOCHEN[k]());
    assert.deepStrictEqual(b.zuweisung, a.zuweisung, k);
    assert.deepStrictEqual(b.kosten, a.kosten, k);
  });
});

test("Ruhezeit: Spät Montag und Früh Dienstag nie bei derselben Person", () => {
  const schichten = [
    { datum: "2026-10-19", schicht_id: "SPAET", beginn: "18:30", ende: "22:30" },
    { datum: "2026-10-20", schicht_id: "FRUEH", beginn: "05:30", ende: "08:30" }
  ];
  const e = {
    schichten, tage: [],
    bedarf: { "2026-10-19": { SPAET: 1 }, "2026-10-20": { FRUEH: 1 } },
    personen: [{ personalnummer: "1", verfuegbar: [
      { datum: "2026-10-19", schicht_id: "SPAET" }, { datum: "2026-10-20", schicht_id: "FRUEH" }] }]
  };
  const erg = S.loese(e);
  assert.strictEqual(erg.unbesetzt.length, 1);
  assert.deepStrictEqual(fehler(erg), []);
});

test("Teilzeit bekommt mehr Stunden als der Durchschnitt der Übrigen", () => {
  const e0 = S.ausExport(json);
  const viele = e0.personen
    .slice().sort((a, b) => b.verfuegbar.length - a.verfuegbar.length)
    .slice(0, 2).map((p) => p.personalnummer);
  const profile = {};
  viele.forEach((pn) => { profile[pn] = { kategorie: "teilzeit" }; });
  const eingabe = S.ausExport(json, profile);
  eingabe.bedarf = bedarf(3, 4);
  const erg = S.loese(eingabe);
  const tz = viele.map((pn) => erg.stunden[pn]);
  const rest = eingabe.personen.filter((p) => viele.indexOf(p.personalnummer) < 0)
    .map((p) => erg.stunden[p.personalnummer]);
  const schnitt = rest.reduce((a, b) => a + b, 0) / rest.length;
  tz.forEach((h) => assert.ok(h >= schnitt, "Teilzeit " + h + " h < Schnitt " + schnitt));
  assert.deepStrictEqual(fehler(erg), []);
});

test("Minijobber: Verteilung höchstens 1 Schicht Unterschied", () => {
  const tage = ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24"];
  const schichten = tage.map((d) => ({ datum: d, schicht_id: "SPAET", beginn: "18:30", ende: "22:30" }));
  const verf = tage.map((d) => ({ datum: d, schicht_id: "SPAET" }));
  const bed = {}; tage.forEach((d) => { bed[d] = { SPAET: 2 }; });
  const e = { schichten, tage: [], bedarf: bed, personen:
    ["A", "B", "C", "D", "E"].map((pn) => ({ personalnummer: pn, verfuegbar: verf, kategorie: "minijob" })) };
  const erg = S.loese(e);
  const h = Object.values(erg.stunden);
  assert.ok(Math.max(...h) - Math.min(...h) <= 4, "Spreizung zu groß: " + h.join(","));
  assert.strictEqual(erg.unbesetzt.length, 0);
});

test("Alternativen: verfügbar, nicht geplant am Tag, brechen keine harte Regel", () => {
  const { eingabe, erg } = woche("std23");
  const ctx = refKontext(eingabe);
  let geprueft = 0;
  erg.slots.forEach((s) => {
    (erg.alternativen[s.id] || []).forEach((pn) => {
      const z = Object.assign({}, erg.zuweisung);
      z[s.id] = pn;
      const v2 = S.pruefe(eingabe, erg.slots, z).filter((x) => x.art === "fehler" && x.pn === pn);
      assert.deepStrictEqual(v2, [], pn + " als Alternative für " + s.id);
      assert.ok(refVerfuegbar(ctx.P[pn], s.datum, s.schicht_id), pn + " ist für " + s.id + " nicht verfügbar");
      assert.deepStrictEqual(artenAm(erg.zuweisung, pn, s.datum), [], pn + " ist am " + s.datum + " schon eingeplant");
      geprueft++;
    });
  });
  assert.ok(geprueft > 0, "keine Alternativen erzeugt");
});

test("Altfelder werden ignoriert (nur_schicht, gesperrte_tage, max_schichten_woche, schnitt_h, notiz)", () => {
  const j = synth.exportJson("2026-10-19");
  const profil = stammProfile(j);
  const ohne = S.ausExport(j, profil);
  ohne.bedarf = bedarf(3, 4);
  const alt = (i) => ({ nur_schicht: i % 2 ? "FRUEH" : "SPAET", gesperrte_tage: [1 + (i % 5)],
    max_schichten_woche: 1, schnitt_h: (i * 7) % 30, notiz: "Notiz " + i });
  const profilAlt = {};
  Object.keys(profil).forEach((pn, i) => { profilAlt[pn] = Object.assign({}, profil[pn], alt(i)); });
  const mit = S.ausExport(j, profilAlt);  // Altfelder im Profil …
  mit.bedarf = bedarf(3, 4);
  mit.personen.forEach((p, i) => Object.assign(p, alt(i + 1)));  // … und direkt an der Person
  const a = S.loese(ohne), b = S.loese(mit);
  assert.deepStrictEqual(b.zuweisung, a.zuweisung);
  assert.deepStrictEqual(b.kosten, a.kosten);
  assert.ok(!b.verstoesse.some((x) => x.typ === "profil"), "Fehlertyp „profil“ gibt es nicht mehr");
});

test("Lücke und Alternative schließen sich aus (Standardbedarf und kleiner Bedarf)", () => {
  ["standard", "std23", "std46"].forEach((k) => {
    const { erg } = woche(k);
    erg.unbesetzt.forEach((id) => {
      assert.deepStrictEqual(erg.alternativen[id], [], "unbesetzt " + id + " hat Alternativen");
    });
    assert.deepStrictEqual(fehler(erg), []);
  });
});

test("Wunschgrenze wird nur überschritten, um eine Lücke zu füllen (Hinweis mit Grund Lücke)", () => {
  const tage = ["2026-10-20", "2026-10-21"];
  const schichten = tage.map((d) => ({ datum: d, schicht_id: "SPAET", beginn: "18:30", ende: "22:30" }));
  const verf = tage.map((d) => ({ datum: d, schicht_id: "SPAET" }));
  const bed = {}; tage.forEach((d) => { bed[d] = { SPAET: 1 }; });
  // einzige Person, Wunschgrenze 1, zwei Plätze: zweiter Platz nur per Überschreitung besetzbar
  const e = { schichten, tage: [], bedarf: bed, personen: [
    { personalnummer: "A", verfuegbar: verf, max_schichten: 1 } ] };
  const erg = S.loese(e);
  assert.strictEqual(erg.unbesetzt.length, 0, "Lücke bleibt trotz verfügbarer Person");
  assert.deepStrictEqual(fehler(erg), []);
  const lim = hinweise(erg, "limit");
  assert.strictEqual(lim.length, 1, JSON.stringify(erg.verstoesse));
  assert.deepStrictEqual([lim[0].art, lim[0].pn, lim[0].anzahl, lim[0].grenze], ["hinweis", "A", 2, 1]);
  const g = lim[0].grund;
  assert.ok(g && g.typ === "luecke", "grund: " + JSON.stringify(g));
  assert.strictEqual(erg.zuweisung[g.slot], "A", "grund.slot " + g.slot + " ist kein Platz von A");
});

// ======================================================================
// Teil C – Verhalten an kleinen Fällen. Jede Erwartung wird zuerst gegen das
// Brute-Force-Optimum (bzw. einen zulässigen Beweisplan) abgesichert.
// ======================================================================
const VOLL = process.env.BRUTE_VOLL === "1";

// Zählt alle Pläne auf (je Platz leer oder eine verfügbare Person) und liefert das
// lexikografische Minimum der Referenz [L, U, T] über die zulässigen.
// Standard: eigene Vorprüfung der harten Regeln + Symmetriebruch bei gleichen Plätzen;
// jeder Plan, der das bisherige Minimum echt unterbietet, wird zusätzlich mit
// S.pruefe bestätigt (Uneinigkeit wird gemeldet). opt.voll: ohne eigene Vorprüfung,
// jeder Plan geht durch S.pruefe (Selbstkontrolle). opt.alle: alle Optima sammeln.
function bruteForce(e, sSlots, opt) {
  opt = opt || {};
  const ctx = refKontext(e), slots = ctx.slots, n = slots.length, pns = Object.keys(ctx.P).sort();
  const optionen = slots.map((s) => [null].concat(pns.filter((pn) => refVerfuegbar(ctx.P[pn], s.datum, s.schicht_id))));
  const zuw = {}, proPn = {};
  slots.forEach((s) => { zuw[s.id] = null; });
  pns.forEach((pn) => { proPn[pn] = []; });
  const erg = { min: null, beispiel: null, optimal: [], blaetter: 0, uneinig: [] };
  const amtlichOk = () => !S.pruefe(e, sSlots, Object.assign({}, zuw)).some((b) => b.art === "fehler");
  function blatt() {
    erg.blaetter++;
    if (opt.voll) {
      const ok = amtlichOk();
      if (ok !== refZulaessig(ctx, zuw)) erg.uneinig.push({ zuweisung: Object.assign({}, zuw), pruefeOk: ok });
      if (!ok) return;
    }
    const k = refAuswerten(ctx, zuw).kosten;
    const vgl = erg.min ? lexVgl(k, erg.min) : -1;
    if (vgl > 0) return;
    if ((vgl < 0 || opt.alle) && !opt.voll && !amtlichOk()) {
      erg.uneinig.push({ zuweisung: Object.assign({}, zuw), pruefeOk: false });
      return;
    }
    if (vgl < 0) { erg.min = k; erg.beispiel = Object.assign({}, zuw); erg.optimal = []; }
    if (opt.alle) erg.optimal.push(Object.assign({}, zuw));
  }
  function rek(i) {
    if (i === n) { blatt(); return; }
    const s = slots[i], o = optionen[i];
    const gleich = !opt.voll && i > 0 && slots[i - 1].datum === s.datum && slots[i - 1].schicht_id === s.schicht_id;
    for (let k = gleich ? o.indexOf(zuw[slots[i - 1].id]) : 0; k < o.length; k++) {
      const pn = o[k];
      if (pn !== null && !opt.voll) {
        if (!refPasst(ctx, pn, s, proPn[pn])) continue;
        proPn[pn].push(s);
      }
      zuw[s.id] = pn;
      rek(i + 1);
      zuw[s.id] = null;
      if (pn !== null && !opt.voll) proPn[pn].pop();
    }
  }
  rek(0);
  return erg;
}

// Sichert die Erwartung ab: per Brute-Force (klein) oder per zulässigem Beweisplan mit [0,0,0].
function erwartetesOptimum(e, soll, beweis) {
  if (beweis) {
    assert.ok(soll.every((x) => x === 0) && refZulaessig(refKontext(e), beweis), "Beweisplan unzulässig");
    assert.deepStrictEqual(referenz(e, beweis), soll, "Beweisplan erreicht die Erwartung nicht");
    return null;
  }
  const bf = bruteForce(e, sSlotsVon(e), { alle: true });
  assert.deepStrictEqual(bf.uneinig, [], "eigene Prüfung und pruefe() uneinig");
  assert.deepStrictEqual(bf.min, soll, "Erwartung " + JSON.stringify(soll) + " ist nicht das Optimum " + JSON.stringify(bf.min));
  return bf;
}
function loeseFall(e, soll) {
  const erg = S.loese(kopie(e));
  assert.deepStrictEqual(fehler(erg), [], "harte Verstöße");
  assert.ok(refZulaessig(refKontext(e), erg.zuweisung), "eigene Prüfung: harter Verstoß in " + kurz(erg.zuweisung));
  const ist = referenz(e, erg.zuweisung);
  assert.deepStrictEqual(ist, soll, "Löser " + JSON.stringify(ist) + " statt " + JSON.stringify(soll) + ": " + kurz(erg.zuweisung));
  return erg;
}
function befundFgPasst(b, z) {
  assert.strictEqual(b.art, "hinweis");
  assert.deepStrictEqual((b.arten_pn || []).slice().sort(), artenAm(z, b.pn, b.datum), "arten_pn " + JSON.stringify(b));
  assert.deepStrictEqual((b.arten_partner || []).slice().sort(), artenAm(z, b.partner, b.datum), "arten_partner " + JSON.stringify(b));
}

// ---------- Mini-Instanzen (Teil D, auch in Teil C genutzt) ----------
function mulberry32(a) {
  a = a >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function mischen(liste, r) {
  for (let i = liste.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); const t = liste[i]; liste[i] = liste[j]; liste[j] = t; }
  return liste;
}
const sortiert = (z) => Object.keys(z).sort().map((id) => [id, leer(z[id]) ? null : z[id]]);

// 1–2 Tage (meist 2), Früh/Spät (manchmal Office mit Bedarf 0–1), Bedarf 0–2 je Art
// (oft 2), höchstens 5 Plätze, 3–5 Personen, Wunsch null/1/2, meist Minijob, 0–2
// Gruppen (2–3 Personen, Kennung in wechselnder Schreibweise, Partner meist wie das
// erste Mitglied verfügbar bis auf eine Zelle) und oft ein Engpass: ein Gruppenmitglied
// ist als Einziger für einen gebrauchten Platz verfügbar. So entstehen echte
// Abwägungen Lücke / Wunsch / Trennung (gemessen 11.11. an Seeds 1–1000: bei 20 % der
// Instanzen entscheidet die Fahrgemeinschaft mit, bei 41 % die Wunschgrenze; Optimum
// mit Trennung 17-mal, mit Überschreitung 95-mal).
// Reihenfolge der Zufallszüge NICHT ändern: Seeds sind Fehlernummern.
const SCHREIBWEISEN = [["G1", "g1", " G 1", "g 1 "], ["FG2", "fg 2", "Fg2", "F G2"]];
function miniInstanz(seed) {
  const r = mulberry32(seed * 7919 + 13), ganz = (n) => Math.floor(r() * n);
  const tage = [D1, D2].slice(0, r() < 0.85 ? 2 : 1);
  const arten = r() < 0.35 ? ["FRUEH", "SPAET", "LANG"] : ["FRUEH", "SPAET"];
  const schichten = [], bedarf = {}, zellen = [];
  tage.forEach((d) => {
    bedarf[d] = { FRUEH: 0, SPAET: 0, LANG: 0 };
    arten.forEach((t) => {
      schichten.push(schicht(d, t));
      bedarf[d][t] = t === "LANG" ? ganz(2) : r() < 0.5 ? 2 : ganz(2);
      zellen.push([d, t]);
    });
  });
  const summe = () => zellen.reduce((m, z) => m + bedarf[z[0]][z[1]], 0);
  while (summe() > 5) { const z = zellen[ganz(zellen.length)]; if (bedarf[z[0]][z[1]] > 0) bedarf[z[0]][z[1]]--; }
  if (summe() === 0) { const z = zellen[ganz(zellen.length)]; bedarf[z[0]][z[1]] = 1; }
  const personen = [], nP = 3 + ganz(3);
  for (let i = 0; i < nP; i++) {
    const verfuegbar = [];
    tage.forEach((d) => arten.forEach((t) => { if (r() < (t === "LANG" ? 0.35 : 0.55)) verfuegbar.push({ datum: d, schicht_id: t }); }));
    const w = r();
    personen.push({ personalnummer: "P" + (i + 1), verfuegbar, max_schichten: w < 0.35 ? null : w < 0.75 ? 1 : 2,
      kategorie: r() < 0.2 ? "teilzeit" : "minijob", fahrgemeinschaft: null });
  }
  const frei = personen.slice(), nG = r() < 0.15 ? 0 : 1 + ganz(2), mitGruppe = [];
  for (let g = 0; g < nG && frei.length >= 2; g++) {
    const groesse = Math.min(2 + ganz(2), frei.length), mitglieder = [];
    for (let k = 0; k < groesse; k++) mitglieder.push(frei.splice(ganz(frei.length), 1)[0]);
    mitglieder.forEach((p, k) => {
      p.fahrgemeinschaft = SCHREIBWEISEN[g][ganz(4)];
      mitGruppe.push(p);
      if (k > 0 && r() < 0.8) {
        p.verfuegbar = mitglieder[0].verfuegbar.map((x) => Object.assign({}, x));
        const z = zellen[ganz(zellen.length)];
        const i = p.verfuegbar.findIndex((x) => x.datum === z[0] && x.schicht_id === z[1]);
        if (i >= 0) p.verfuegbar.splice(i, 1); else p.verfuegbar.push({ datum: z[0], schicht_id: z[1] });
      }
    });
  }
  if (frei.length && r() < 0.2) frei[ganz(frei.length)].fahrgemeinschaft = "solo 9";
  if (mitGruppe.length && r() < 0.6) {
    const q = mitGruppe[ganz(mitGruppe.length)];
    const offen = zellen.filter((z) => bedarf[z[0]][z[1]] > 0), z = offen[ganz(offen.length)];
    const weg = z[1] === "SPAET" ? ["SPAET", "LANG"] : [z[1]];  // LANG deckt SPAET: auch das entfernen
    personen.forEach((p) => { if (p !== q) p.verfuegbar = p.verfuegbar.filter((x) => !(x.datum === z[0] && weg.indexOf(x.schicht_id) >= 0)); });
    if (!q.verfuegbar.some((x) => x.datum === z[0] && x.schicht_id === z[1])) q.verfuegbar.push({ datum: z[0], schicht_id: z[1] });
  }
  return { schichten, tage: tage.map((d) => ({ datum: d, gesperrt: false })), bedarf, personen };
}

// Feste Fundfälle (vom Generator unabhängig, bleiben auch bei geändertem Generator erhalten)
const FUNDFAELLE = [
  { name: "Trio, Optimum braucht Doppelschicht + ruhezeitgerechten Tausch (Fund 11.11., Löser [10,0,1] statt [10,0,0])",
    e: { schichten: [schicht(D1, "FRUEH"), schicht(D1, "SPAET"), schicht(D2, "FRUEH"), schicht(D2, "SPAET")],
      tage: [{ datum: D1, gesperrt: false }, { datum: D2, gesperrt: false }],
      bedarf: { [D1]: { FRUEH: 1, SPAET: 2, LANG: 0 }, [D2]: { FRUEH: 2, SPAET: 0, LANG: 0 } },
      personen: [
        person("P1", v(D1, "FRUEH", "SPAET").concat(v(D2, "FRUEH", "SPAET")), { kategorie: "teilzeit", fahrgemeinschaft: "G1" }),
        person("P2", v(D1, "FRUEH", "SPAET").concat(v(D2, "FRUEH", "SPAET")), { max_schichten: 1, fahrgemeinschaft: " G 1" }),
        person("P3", v(D1, "FRUEH", "SPAET").concat(v(D2, "FRUEH", "SPAET")), { max_schichten: 2, fahrgemeinschaft: "G1" })] } },
  { name: "Paar G1 + Trio FG2, Optimum braucht Doppelschicht P3 und Umbau über zwei Tage (Fund 11.11. bei BRUTE_N=6000, Seed 4148; Löser [0,0,1] statt [0,0,0])",
    e: { schichten: [schicht(D1, "FRUEH"), schicht(D1, "SPAET"), schicht(D2, "FRUEH"), schicht(D2, "SPAET")],
      tage: [{ datum: D1, gesperrt: false }, { datum: D2, gesperrt: false }],
      bedarf: { [D1]: { FRUEH: 1, SPAET: 2, LANG: 0 }, [D2]: { FRUEH: 2, SPAET: 0, LANG: 0 } },
      personen: [
        person("P1", v(D2, "FRUEH", "SPAET"), { max_schichten: 2, fahrgemeinschaft: "fg 2" }),
        person("P2", v(D1, "SPAET").concat(v(D2, "SPAET")), { fahrgemeinschaft: "Fg2" }),
        person("P3", v(D1, "FRUEH", "SPAET").concat(v(D2, "SPAET", "FRUEH")), { fahrgemeinschaft: "g1" }),
        person("P4", v(D1, "SPAET").concat(v(D2, "FRUEH", "SPAET")), { kategorie: "teilzeit", fahrgemeinschaft: "F G2" }),
        person("P5", v(D1, "FRUEH", "SPAET").concat(v(D2, "SPAET")), { max_schichten: 1, fahrgemeinschaft: "g1" })] } }
];

const MINI_N = Number(process.env.BRUTE_N) || 1000;
const miniDaten = {};
let miniMsLoese = 0, miniMsBf = 0;
function mini(seed) {
  if (!miniDaten[seed]) {
    const e = miniInstanz(seed);
    const m = { seed, e, ctx: refKontext(e), sSlots: null, erg: null, fehler: null, bf: null };
    try {
      m.sSlots = sSlotsVon(e);
      const t0 = process.hrtime.bigint();
      m.erg = S.loese(miniInstanz(seed));
      miniMsLoese += Number(process.hrtime.bigint() - t0) / 1e6;
    } catch (ex) { m.fehler = String(ex && ex.stack || ex); }
    miniDaten[seed] = m;
  }
  return miniDaten[seed];
}
function miniBf(m) {
  if (!m.bf) {
    const t0 = process.hrtime.bigint();
    m.bf = bruteForce(m.e, m.sSlots);
    miniMsBf += Number(process.hrtime.bigint() - t0) / 1e6;
  }
  return m.bf;
}
function fallText(m, ist, bf) {
  let kv = "";
  try {
    if (typeof S.kostenVon === "function") {
      kv = "\n       kostenVon(Löser) = " + JSON.stringify(S.kostenVon(m.e, m.erg.slots, m.erg.zuweisung)) +
        ", kostenVon(Optimum) = " + JSON.stringify(S.kostenVon(m.e, m.sSlots, bf.beispiel));
    }
  } catch (ex) { kv = "\n       kostenVon wirft: " + ex.message; }
  return "Seed " + m.seed + ": Löser " + JSON.stringify(ist) + ", Optimum " + JSON.stringify(bf.min) +
    "\n       Löser:   " + kurz(m.erg.zuweisung) + "\n       Optimum: " + kurz(bf.beispiel) + kv +
    "\n       Instanz: " + JSON.stringify(m.e);
}

test("Fahrgemeinschaft: zwei Paare mit gleicher Verfügbarkeit werden an allen Tagen zusammen geplant", () => {
  const tage = [D1, D2, D3], bed = {};
  tage.forEach((d) => { bed[d] = { FRUEH: 2, SPAET: 2 }; });
  const verf = tage.reduce((l, d) => l.concat(v(d, "FRUEH", "SPAET")), []);
  const fg = { A: "G1", C: "G1", B: "G2", F: "G2" };
  const e = instanz(bed, ["A", "B", "C", "D", "E", "F"].map((pn) => person(pn, verf, { fahrgemeinschaft: fg[pn] || null })));
  erwartetesOptimum(e, [0, 0, 0], plan(e, {
    [pl(D1, "FRUEH", 1)]: "A", [pl(D1, "FRUEH", 2)]: "C", [pl(D1, "SPAET", 1)]: "B", [pl(D1, "SPAET", 2)]: "F",
    [pl(D2, "FRUEH", 1)]: "D", [pl(D2, "FRUEH", 2)]: "E", [pl(D2, "SPAET", 1)]: "A", [pl(D2, "SPAET", 2)]: "C",
    [pl(D3, "FRUEH", 1)]: "B", [pl(D3, "FRUEH", 2)]: "F", [pl(D3, "SPAET", 1)]: "D", [pl(D3, "SPAET", 2)]: "E" }));
  const erg = loeseFall(e, [0, 0, 0]);
  tage.forEach((d) => [["A", "C"], ["B", "F"]].forEach(([p, q]) =>
    assert.deepStrictEqual(artenAm(erg.zuweisung, p, d), artenAm(erg.zuweisung, q, d), p + "/" + q + " am " + d)));
  assert.deepStrictEqual(hinweise(erg, "fahrgemeinschaft"), []);
});

test("Partner nicht verfügbar: der andere arbeitet allein – keine Trennung, kein Hinweis", () => {
  const e = instanz({ [D1]: { FRUEH: 2 }, [D2]: { FRUEH: 2 } }, [
    person("C", v(D1, "FRUEH").concat(v(D2, "FRUEH"))),
    person("D", v(D1, "FRUEH"), { fahrgemeinschaft: "G1" }),
    person("E", v(D2, "FRUEH"), { fahrgemeinschaft: "G1" })]);
  erwartetesOptimum(e, [0, 0, 0]);
  const erg = loeseFall(e, [0, 0, 0]);
  assert.strictEqual(erg.unbesetzt.length, 0);
  assert.deepStrictEqual(hinweise(erg, "fahrgemeinschaft"), []);
});

test("Partner nicht verfügbar: Solver nimmt den, dessen Partner nicht kann, statt ein Paar zu trennen", () => {
  const e = instanz({ [D1]: { FRUEH: 2, SPAET: 1 }, [D2]: { FRUEH: 1 } }, [
    person("A", v(D1, "FRUEH"), { fahrgemeinschaft: "G2" }),
    person("B", v(D1, "FRUEH", "SPAET"), { fahrgemeinschaft: "G2", max_schichten: 1 }),
    person("C", v(D1, "FRUEH")),
    person("D", v(D1, "FRUEH"), { fahrgemeinschaft: "G1" }),
    person("E", v(D2, "FRUEH"), { fahrgemeinschaft: "G1" })]);
  const bf = erwartetesOptimum(e, [0, 0, 0]);
  bf.optimal.forEach((z) => assert.deepStrictEqual(wer(z, D1, "FRUEH"), ["C", "D"], "Erwartung nicht eindeutig: " + kurz(z)));
  const erg = loeseFall(e, [0, 0, 0]);
  assert.deepStrictEqual(wer(erg.zuweisung, D1, "FRUEH"), ["C", "D"]);
  assert.deepStrictEqual(hinweise(erg, "fahrgemeinschaft"), []);
});

test("Partner an seiner Wunschgrenze: der andere arbeitet allein – keine Trennung, kein Hinweis", () => {
  const e = instanz({ [D1]: { SPAET: 2 }, [D2]: { SPAET: 2 } }, [
    person("A", v(D1, "SPAET").concat(v(D2, "SPAET")), { fahrgemeinschaft: "G1" }),
    person("B", v(D1, "SPAET").concat(v(D2, "SPAET")), { fahrgemeinschaft: "G1", max_schichten: 1 }),
    person("C", v(D2, "SPAET"))]);
  const bf = erwartetesOptimum(e, [0, 0, 0]);
  bf.optimal.forEach((z) => assert.deepStrictEqual(wer(z, D2, "SPAET"), ["A", "C"], "Erwartung nicht eindeutig: " + kurz(z)));
  const erg = loeseFall(e, [0, 0, 0]);
  assert.deepStrictEqual(wer(erg.zuweisung, D2, "SPAET"), ["A", "C"]);
  assert.deepStrictEqual(hinweise(erg, "fahrgemeinschaft").concat(hinweise(erg, "limit")), []);
});

test("Lücke erzwingt Trennung: Platz wird besetzt, Hinweis „fahrgemeinschaft“ mit Grund Lücke", () => {
  // B muss Montag spät arbeiten (sonst niemand) und kann deshalb Dienstag früh nicht mit A
  const e = instanz({ [D0]: { SPAET: 1 }, [D1]: { FRUEH: 2 } }, [
    person("A", v(D1, "FRUEH"), { fahrgemeinschaft: "G1" }),
    person("B", v(D0, "SPAET").concat(v(D1, "FRUEH")), { fahrgemeinschaft: "G1" }),
    person("C", v(D1, "FRUEH"))]);
  erwartetesOptimum(e, [0, 0, 1]);
  const erg = loeseFall(e, [0, 0, 1]);
  assert.strictEqual(erg.unbesetzt.length, 0);
  const fg = hinweise(erg, "fahrgemeinschaft");
  assert.deepStrictEqual(schluesselMenge(fg), ["A+B@" + D1]);
  fg.forEach((b) => {
    befundFgPasst(b, erg.zuweisung);
    assert.ok(b.grund && b.grund.typ === "luecke" && erg.slots.some((s) => s.id === b.grund.slot), "grund: " + JSON.stringify(b.grund));
  });
});

test("Lücke nur per Trennung oder per Überschreitung besetzbar → Trennung (Wunschgrenze geht vor)", () => {
  const e = instanz({ [D0]: { SPAET: 1 }, [D1]: { FRUEH: 2 }, [D2]: { FRUEH: 1 } }, [
    person("A", v(D1, "FRUEH"), { fahrgemeinschaft: "G1" }),
    person("B", v(D0, "SPAET").concat(v(D1, "FRUEH")), { fahrgemeinschaft: "G1" }),
    person("C", v(D1, "FRUEH").concat(v(D2, "FRUEH")), { max_schichten: 1 }),
    person("D", v(D1, "FRUEH"))]);
  const bf = erwartetesOptimum(e, [0, 0, 1]);
  bf.optimal.forEach((z) => assert.deepStrictEqual(wer(z, D1, "FRUEH"), ["A", "D"], "Erwartung nicht eindeutig: " + kurz(z)));
  const erg = loeseFall(e, [0, 0, 1]);
  assert.deepStrictEqual(wer(erg.zuweisung, D1, "FRUEH"), ["A", "D"]);
  assert.deepStrictEqual(hinweise(erg, "limit"), []);
  const fg = hinweise(erg, "fahrgemeinschaft");
  assert.deepStrictEqual(schluesselMenge(fg), ["A+B@" + D1]);
  // ehrlich ist beides: ohne Trennung läge C über dem Wunsch (bester Ersatz) oder ein Platz bliebe leer
  fg.forEach((b) => assert.ok(b.grund && ((b.grund.typ === "limit" && b.grund.pn === "C") || b.grund.typ === "luecke"),
    "grund: " + JSON.stringify(b.grund)));
});

test("Lücke nur per Überschreitung besetzbar → Überschreitung mit Hinweis (Grund Lücke), Paar bleibt zusammen", () => {
  const e = instanz({ [D1]: { FRUEH: 2 }, [D2]: { FRUEH: 2 } },
    ["A", "B"].map((pn) => person(pn, v(D1, "FRUEH").concat(v(D2, "FRUEH")), { fahrgemeinschaft: "G1", max_schichten: 1 })));
  erwartetesOptimum(e, [0, 2, 0]);
  const erg = loeseFall(e, [0, 2, 0]);
  const lim = hinweise(erg, "limit");
  assert.deepStrictEqual(lim.map((b) => b.pn + ":" + b.anzahl + "/" + b.grenze).sort(), ["A:2/1", "B:2/1"]);
  lim.forEach((b) => assert.ok(b.art === "hinweis" && b.grund && b.grund.typ === "luecke", "grund: " + JSON.stringify(b.grund)));
  assert.deepStrictEqual(hinweise(erg, "fahrgemeinschaft"), []);
});

test("3er-Gruppe wird an beiden Tagen zusammen geplant", () => {
  const tage = [D1, D2], bed = {};
  tage.forEach((d) => { bed[d] = { FRUEH: 3, SPAET: 3 }; });
  const verf = tage.reduce((l, d) => l.concat(v(d, "FRUEH", "SPAET")), []);
  const e = instanz(bed, ["A", "B", "C", "D", "E", "F"].map((pn) => person(pn, verf, { fahrgemeinschaft: "ACE".indexOf(pn) >= 0 ? "G3" : null })));
  const beweis = {};
  tage.forEach((d) => {
    ["A", "C", "E"].forEach((pn, i) => { beweis[pl(d, "FRUEH", i + 1)] = pn; });
    ["B", "D", "F"].forEach((pn, i) => { beweis[pl(d, "SPAET", i + 1)] = pn; });
  });
  erwartetesOptimum(e, [0, 0, 0], plan(e, beweis));
  const erg = loeseFall(e, [0, 0, 0]);
  tage.forEach((d) => {
    const a = artenAm(erg.zuweisung, "A", d);
    assert.ok(artenAm(erg.zuweisung, "C", d).join() === a.join() && artenAm(erg.zuweisung, "E", d).join() === a.join(), "Gruppe am " + d + " getrennt");
  });
});

test("3er-Gruppe: ein Mitglied kann nicht dazukommen (Ruhezeit) → zwei getrennte Paar-Tage mit Grund Lücke", () => {
  const e = instanz({ [D0]: { SPAET: 1 }, [D1]: { FRUEH: 3 } }, [
    person("A", v(D1, "FRUEH"), { fahrgemeinschaft: "G3" }),
    person("C", v(D1, "FRUEH"), { fahrgemeinschaft: "G3" }),
    person("D", v(D1, "FRUEH")),
    person("E", v(D0, "SPAET").concat(v(D1, "FRUEH")), { fahrgemeinschaft: "G3" })]);
  erwartetesOptimum(e, [0, 0, 2]);
  const erg = loeseFall(e, [0, 0, 2]);
  const fg = hinweise(erg, "fahrgemeinschaft");
  assert.deepStrictEqual(schluesselMenge(fg), ["A+E@" + D1, "C+E@" + D1]);
  fg.forEach((b) => assert.ok(b.grund && b.grund.typ === "luecke", "grund: " + JSON.stringify(b.grund)));
});

test("Kennungen „fg 1“ und „FG1“ bilden eine Fahrgemeinschaft (gruppeNorm, auch NFC)", () => {
  assert.strictEqual(S.gruppeNorm("fg 1"), "FG1");
  assert.strictEqual(S.gruppeNorm(" f g 1 "), "FG1");
  assert.strictEqual(S.gruppeNorm("fä 1"), S.gruppeNorm("FÄ1"));
  assert.ok(!S.gruppeNorm(null) && !S.gruppeNorm("   "), "leere Kennung muss leer bleiben");
  const e = instanz({ [D1]: { FRUEH: 2, SPAET: 2 } }, [
    person("A", v(D1, "FRUEH", "SPAET"), { fahrgemeinschaft: "fg 1" }),
    person("B", v(D1, "FRUEH", "SPAET")),
    person("C", v(D1, "FRUEH", "SPAET"), { fahrgemeinschaft: "FG1" }),
    person("D", v(D1, "FRUEH", "SPAET"))]);
  erwartetesOptimum(e, [0, 0, 0]);
  const erg = loeseFall(e, [0, 0, 0]);
  assert.deepStrictEqual(artenAm(erg.zuweisung, "A", D1), artenAm(erg.zuweisung, "C", D1));
});

test("Kennungen „fg 1“ und „FG1“: erzwungene Trennung wird als eine Gruppe gemeldet", () => {
  const e = instanz({ [D0]: { SPAET: 1 }, [D1]: { FRUEH: 2 } }, [
    person("A", v(D1, "FRUEH"), { fahrgemeinschaft: "fg 1" }),
    person("B", v(D1, "FRUEH")),
    person("C", v(D0, "SPAET").concat(v(D1, "FRUEH")), { fahrgemeinschaft: "FG1" })]);
  erwartetesOptimum(e, [0, 0, 1]);
  const erg = loeseFall(e, [0, 0, 1]);
  assert.deepStrictEqual(schluesselMenge(hinweise(erg, "fahrgemeinschaft")), ["A+C@" + D1]);
});

test("Kapazität: nur ein Office-Platz – einer arbeitet ihn, der Partner gilt nicht als getrennt", () => {
  const e = instanz({ [D1]: { LANG: 1 } }, ["A", "B"].map((pn) => person(pn, v(D1, "LANG"), { fahrgemeinschaft: "G1" })));
  erwartetesOptimum(e, [0, 0, 0]);
  const erg = loeseFall(e, [0, 0, 0]);
  assert.strictEqual(erg.unbesetzt.length, 0);
  assert.deepStrictEqual(hinweise(erg, "fahrgemeinschaft"), []);
});

test("Doppelschicht: A Früh+Spät, Partner B Früh – B wird nicht in eine zweite Schicht gedrängt", () => {
  const e = instanz({ [D1]: { FRUEH: 2, SPAET: 1 } }, ["A", "B"].map((pn) => person(pn, v(D1, "FRUEH", "SPAET"), { fahrgemeinschaft: "G1" })));
  erwartetesOptimum(e, [0, 0, 0]);
  const erg = loeseFall(e, [0, 0, 0]);
  assert.strictEqual(erg.unbesetzt.length, 0);
  assert.deepStrictEqual(hinweise(erg, "fahrgemeinschaft"), []);
});

test("pruefe() meldet Trennung und Überschreitung nach Handänderung (ohne Grund); begruenden(): „vermeidbar“", () => {
  // a) Trennung von Hand; ein Tausch B ↔ C würde sie ohne Nebenwirkung aufheben
  const e = instanz({ [D1]: { FRUEH: 2, SPAET: 2 } }, [
    person("A", v(D1, "FRUEH", "SPAET"), { fahrgemeinschaft: "G1" }), person("B", v(D1, "FRUEH", "SPAET")),
    person("C", v(D1, "FRUEH", "SPAET"), { fahrgemeinschaft: "G1" }), person("D", v(D1, "FRUEH", "SPAET"))]);
  const erg = S.loese(kopie(e));
  const z = Object.assign({}, erg.zuweisung, { [pl(D1, "FRUEH", 1)]: "A", [pl(D1, "FRUEH", 2)]: "B", [pl(D1, "SPAET", 1)]: "C", [pl(D1, "SPAET", 2)]: "D" });
  assert.deepStrictEqual(referenz(e, z), [0, 0, 1]);
  const bef = S.pruefe(e, erg.slots, z);
  assert.deepStrictEqual(bef.filter((b) => b.art === "fehler"), []);
  const fg = bef.filter((b) => b.typ === "fahrgemeinschaft");
  assert.deepStrictEqual(schluesselMenge(fg), ["A+C@" + D1]);
  fg.forEach((b) => { befundFgPasst(b, z); assert.strictEqual(b.grund, undefined, "pruefe() setzt keinen Grund"); });
  assert.strictEqual(S.begruenden(e, erg.slots, z, bef), bef, "begruenden() liefert dasselbe Array");
  fg.forEach((b) => assert.strictEqual(b.grund && b.grund.typ, "vermeidbar", "grund: " + JSON.stringify(b.grund)));
  // b) Überschreitung von Hand; G könnte einen der Plätze übernehmen
  const e2 = instanz({ [D1]: { FRUEH: 1 }, [D2]: { FRUEH: 1 } }, [
    person("E", v(D1, "FRUEH").concat(v(D2, "FRUEH")), { max_schichten: 1 }),
    person("G", v(D1, "FRUEH").concat(v(D2, "FRUEH")))]);
  const erg2 = S.loese(kopie(e2));
  assert.deepStrictEqual(referenz(e2, erg2.zuweisung), [0, 0, 0]);
  const z2 = Object.assign({}, erg2.zuweisung, { [pl(D1, "FRUEH", 1)]: "E", [pl(D2, "FRUEH", 1)]: "E" });
  const bef2 = S.pruefe(e2, erg2.slots, z2);
  const lim = bef2.filter((b) => b.typ === "limit");
  assert.strictEqual(lim.length, 1, JSON.stringify(bef2));
  assert.deepStrictEqual([lim[0].art, lim[0].pn, lim[0].anzahl, lim[0].grenze], ["hinweis", "E", 2, 1]);
  assert.ok(Array.isArray(lim[0].slots) && lim[0].slots.length > 0 && lim[0].slots.every((id) => z2[id] === "E"), "slots: " + JSON.stringify(lim[0].slots));
  assert.strictEqual(lim[0].grund, undefined, "pruefe() setzt keinen Grund");
  S.begruenden(e2, erg2.slots, z2, bef2);
  assert.strictEqual(lim[0].grund && lim[0].grund.typ, "vermeidbar", "grund: " + JSON.stringify(lim[0].grund));
});

// erwartete Kennzeichen eines Tauschs laut Referenz
function refWahl(e, z, id, pn) {
  const ctx = refKontext(e), vorher = refAuswerten(ctx, z);
  const z2 = Object.assign({}, z);
  z2[id] = pn;
  const nach = refAuswerten(ctx, z2);
  return { ueber: pn !== null && nach.anzahl[pn] > ctx.P[pn].wunsch, trennt: nach.kosten[2] > vorher.kosten[2] };
}

test("bewertung().wahl(): Kennzeichen „über Wunsch“ und „trennt“ (Handfall und systematisch)", () => {
  const e = instanz({ [D1]: { FRUEH: 2 }, [D2]: { FRUEH: 1 } }, [
    person("A", v(D1, "FRUEH"), { fahrgemeinschaft: "G1" }),
    person("B", v(D1, "FRUEH").concat(v(D2, "FRUEH")), { max_schichten: 1 }),
    person("C", v(D1, "FRUEH"), { fahrgemeinschaft: "G1" }),
    person("D", v(D1, "FRUEH").concat(v(D2, "FRUEH")))]);
  const zusammen = plan(e, { [pl(D1, "FRUEH", 1)]: "A", [pl(D1, "FRUEH", 2)]: "C", [pl(D2, "FRUEH", 1)]: "B" });
  const getrennt = plan(e, { [pl(D1, "FRUEH", 1)]: "A", [pl(D1, "FRUEH", 2)]: "D", [pl(D2, "FRUEH", 1)]: "B" });
  const faelle = [
    [zusammen, pl(D1, "FRUEH", 2), "D", { ueber: false, trennt: true }],
    [zusammen, pl(D1, "FRUEH", 2), "B", { ueber: true, trennt: true }],
    [zusammen, pl(D1, "FRUEH", 2), null, { ueber: false, trennt: true }],
    [zusammen, pl(D2, "FRUEH", 1), "D", { ueber: false, trennt: false }],
    [getrennt, pl(D1, "FRUEH", 2), "C", { ueber: false, trennt: false }],
    [getrennt, pl(D1, "FRUEH", 1), "B", { ueber: true, trennt: false }]];
  faelle.forEach(([z, id, pn, soll]) => assert.deepStrictEqual(refWahl(e, z, id, pn), soll, "Erwartung " + id + " ← " + pn));
  const slots = sSlotsVon(e);
  faelle.forEach(([z, id, pn, soll]) => {
    const w = S.bewertung(e, slots, z).wahl(id, pn);
    assert.deepStrictEqual({ ueber: !!(w && w.ueber), trennt: !!(w && w.trennt) }, soll, id + " ← " + pn + ": " + JSON.stringify(w));
  });
  // systematisch: jede zulässige Wahl auf den ersten 100 Mini-Instanzen (Basis: Brute-Force-Optimum)
  const probleme = [];
  for (let seed = 1; seed <= Math.min(100, MINI_N); seed++) {
    const m = mini(seed);
    if (m.fehler) continue;
    const z = miniBf(m).beispiel, b = S.bewertung(m.e, m.sSlots, z);
    m.ctx.slots.forEach((s) => [null].concat(Object.keys(m.ctx.P).sort()).forEach((pn) => {
      if (pn === z[s.id] || (pn !== null && !refVerfuegbar(m.ctx.P[pn], s.datum, s.schicht_id))) return;
      const z2 = Object.assign({}, z);
      z2[s.id] = pn;
      if (!refZulaessig(m.ctx, z2)) return;
      const soll = refWahl(m.e, z, s.id, pn), w = b.wahl(s.id, pn);
      if (!w || !!w.ueber !== soll.ueber || !!w.trennt !== soll.trennt) {
        probleme.push("Seed " + seed + " " + s.id + " ← " + pn + ": " + JSON.stringify(w) + " statt " + JSON.stringify(soll) + "; Plan " + kurz(z));
      }
    }));
  }
  assert.ok(!probleme.length, probleme.length + " Abweichungen, z. B.\n     " + probleme.slice(0, 5).join("\n     "));
});

// Vergleicht die Hilfsfunktionen des Solvers für einen Plan z mit der Referenz
function abgleich(e, slots, z) {
  const ref = refAuswerten(refKontext(e), z), p = [];
  const kv = S.kostenVon(e, slots, z);
  if (lexVgl(kv.slice(0, 3), ref.kosten) !== 0) p.push("kostenVon " + JSON.stringify(kv.slice(0, 3)) + " ≠ Referenz " + JSON.stringify(ref.kosten));
  if (!kv.every(Number.isInteger)) p.push("kostenVon nicht ganzzahlig: " + JSON.stringify(kv));
  const refKeys = schluesselMenge(ref.getrennt).join(", ");
  const gt = S.getrenntePaarTage(e, slots, z);
  if (schluesselMenge(gt).join(", ") !== refKeys) p.push("getrenntePaarTage [" + schluesselMenge(gt).join(", ") + "] ≠ Referenz [" + refKeys + "]");
  gt.forEach((x) => {
    if ((x.arten_pn || []).slice().sort().join() !== artenAm(z, String(x.pn), x.datum).join() ||
        (x.arten_partner || []).slice().sort().join() !== artenAm(z, String(x.partner), x.datum).join()) {
      p.push("getrenntePaarTage: Schichtarten falsch bei " + paarSchluessel(x));
    }
  });
  const bef = S.pruefe(e, slots, z);
  const fg = bef.filter((b) => b.typ === "fahrgemeinschaft");
  if (schluesselMenge(fg).join(", ") !== refKeys) p.push("pruefe-Hinweise Fahrgemeinschaft [" + schluesselMenge(fg).join(", ") + "] ≠ Referenz [" + refKeys + "]");
  if (fg.some((b) => b.art !== "hinweis")) p.push("Fahrgemeinschaft-Befund ist kein Hinweis");
  const lim = bef.filter((b) => b.typ === "limit").map((b) => b.pn + ":" + b.anzahl + "/" + b.grenze).sort().join(", ");
  const refLim = ref.ueber.map((x) => x.pn + ":" + x.anzahl + "/" + x.grenze).sort().join(", ");
  if (lim !== refLim) p.push("pruefe-Hinweise Wunschgrenze [" + lim + "] ≠ Referenz [" + refLim + "]");
  return p;
}

test("kostenVon, getrenntePaarTage und pruefe-Hinweise = Referenz (alle Referenzfälle)", () => {
  const probleme = [];
  REF_FAELLE.forEach((f) => abgleich(f.e, sSlotsVon(f.e), f.z).forEach((x) => probleme.push(f.name + ": " + x)));
  assert.ok(!probleme.length, probleme.length + " Abweichungen:\n     " + probleme.join("\n     "));
});

test("loese().kosten = kostenVon() = Referenz [L,U,T] (Testwochen, Härtefall, gestörte Härtefall-Pläne)", () => {
  const probleme = [];
  ["std23", "standard", "haerte", "haerteMini"].forEach((k) => {
    const { eingabe, erg } = woche(k);
    const kv = S.kostenVon(eingabe, erg.slots, erg.zuweisung);
    if (JSON.stringify(kv) !== JSON.stringify(erg.kosten)) probleme.push(k + ": loese().kosten " + JSON.stringify(erg.kosten) + " ≠ kostenVon " + JSON.stringify(kv));
    abgleich(eingabe, erg.slots, erg.zuweisung).forEach((x) => probleme.push(k + ": " + x));
  });
  // gestörte Pläne: viele Trennungen und Überschreitungen auf realistischer Woche
  const { eingabe, erg } = woche("haerte");
  const ctx = refKontext(eingabe), r = mulberry32(2026), pns = Object.keys(ctx.P).sort();
  let trennungen = 0;
  for (let n = 0; n < 12; n++) {
    const z = Object.assign({}, erg.zuweisung);
    for (let i = 0; i < 25; i++) {
      const s = ctx.slots[Math.floor(r() * ctx.slots.length)];
      const kand = [null].concat(pns.filter((pn) => refVerfuegbar(ctx.P[pn], s.datum, s.schicht_id)));
      const alt = z[s.id];
      z[s.id] = kand[Math.floor(r() * kand.length)];
      if (!refZulaessig(ctx, z)) z[s.id] = alt;
    }
    trennungen += refAuswerten(ctx, z).kosten[2];
    abgleich(eingabe, erg.slots, z).forEach((x) => probleme.push("gestört " + n + ": " + x));
  }
  assert.ok(trennungen > 0, "Störung erzeugt keine Trennungen – Test zu schwach");
  assert.ok(!probleme.length, probleme.length + " Abweichungen:\n     " + probleme.slice(0, 8).join("\n     "));
});

test("Plätze: slotsBauen/loese bauen dieselben Plätze wie die Referenz (Standardbedarf, inaktiv, gesperrt)", () => {
  const schichten = [D0, D1, D2, D3].reduce((l, d) => l.concat(["FRUEH", "SPAET", "LANG"].map((t) => schicht(d, t))), []);
  schichten.find((s) => s.datum === D2 && s.schicht_id === "FRUEH").aktiv = false;
  const e = { schichten, tage: [{ datum: D0 }, { datum: D1 }, { datum: D2 }, { datum: D3, gesperrt: true }], personen: [] };
  const soll = refSlots(e).map((s) => s.id + "/" + s.dauer).sort();
  assert.deepStrictEqual(sSlotsVon(e).map((s) => s.id + "/" + s.dauer).sort(), soll);
  assert.deepStrictEqual(S.loese(kopie(e)).slots.map((s) => s.id + "/" + s.dauer).sort(), soll);
  const { eingabe, erg } = woche("std23");
  assert.deepStrictEqual(erg.slots.map((s) => s.id).sort(), refSlots(eingabe).map((s) => s.id).sort());
});

test("Eingabereihenfolge der Personen ändert das Ergebnis nicht", () => {
  const h = woche("haerte").erg, e = haertefallEingabe();
  mischen(e.personen, mulberry32(4711));
  const erg = S.loese(e);
  assert.deepStrictEqual(erg.zuweisung, h.zuweisung, "Härtefall-Woche");
  assert.deepStrictEqual(erg.kosten, h.kosten, "Härtefall-Woche");
  const abw = [];
  for (let seed = 1; seed <= Math.min(80, MINI_N); seed++) {
    const m = mini(seed);
    if (m.fehler) continue;
    const e2 = miniInstanz(seed);
    mischen(e2.personen, mulberry32(seed + 99));
    if (JSON.stringify(sortiert(S.loese(e2).zuweisung)) !== JSON.stringify(sortiert(m.erg.zuweisung))) abw.push(seed);
  }
  assert.deepStrictEqual(abw, [], "Mini-Instanzen mit anderem Ergebnis (Seeds)");
});

// ======================================================================
// Teil D – Brute-Force auf Mini-Instanzen (deterministischer Zufall)
// Ein Treffer daneben bedeutet einen fehlenden Zug im Solver – nicht lockern.
// (Generator und Zwischenspeicher stehen vor Teil C, weil Teil C sie mitnutzt.)
// ======================================================================
test("Brute-Force: Löser trifft auf " + MINI_N + " Mini-Instanzen das Optimum [Lücken, Überschreitungen, Trennungen]", () => {
  const verfehlt = [], unterBoden = [], uneinig = [], kaputt = [];
  let gleich = 0, mitL = 0, mitU = 0, mitT = 0, gemeinsam = 0, blaetter = 0;
  for (let seed = 1; seed <= MINI_N; seed++) {
    const m = mini(seed);
    if (m.fehler) { kaputt.push("Seed " + seed + ": " + m.fehler.split("\n")[0]); continue; }
    const bf = miniBf(m);
    blaetter += bf.blaetter;
    if (bf.uneinig.length) uneinig.push("Seed " + seed + ": " + JSON.stringify(bf.uneinig[0]));
    if (VOLL) {
      const voll = bruteForce(m.e, m.sSlots, { voll: true });
      if (lexVgl(voll.min, bf.min) !== 0) uneinig.push("Seed " + seed + ": Minimum voll " + JSON.stringify(voll.min) + " ≠ " + JSON.stringify(bf.min));
      voll.uneinig.forEach((x) => uneinig.push("Seed " + seed + " (voll): " + JSON.stringify(x)));
    }
    if (bf.min[0] > 0) mitL++;
    if (bf.min[1] > 0) mitU++;
    if (bf.min[2] > 0) mitT++;
    if (m.ctx.paare.some(({ p, q }) => Object.keys(m.ctx.P[p].verf).some((k) => m.ctx.P[q].verf[k]))) gemeinsam++;
    const ist = refAuswerten(m.ctx, m.erg.zuweisung).kosten, vgl = lexVgl(ist, bf.min);
    if (vgl === 0) gleich++;
    else (vgl > 0 ? verfehlt : unterBoden).push({ m, ist, bf });
  }
  console.log("     " + gleich + "/" + MINI_N + " optimal; Optimum mit Lücke " + mitL + ", mit Überschreitung " + mitU +
    ", mit Trennung " + mitT + "; Gruppen mit gemeinsamer Verfügbarkeit " + gemeinsam + "; " + blaetter +
    " Pläne; loese " + miniMsLoese.toFixed(0) + " ms, Aufzählung " + miniMsBf.toFixed(0) + " ms" + (VOLL ? " (mit Vollkontrolle)" : ""));
  assert.ok(!kaputt.length, kaputt.length + " Instanzen werfen:\n     " + kaputt.slice(0, 3).join("\n     "));
  assert.ok(!uneinig.length, "eigene Prüfung und pruefe() uneinig:\n     " + uneinig.slice(0, 5).join("\n     "));
  assert.ok(!unterBoden.length, unterBoden.length + " Löser-Pläne liegen UNTER dem Brute-Force-Minimum (Prüfer uneinig?):\n     " +
    unterBoden.slice(0, 3).map((x) => fallText(x.m, x.ist, x.bf)).join("\n     "));
  assert.ok(!verfehlt.length, verfehlt.length + " von " + MINI_N + " verfehlt (Seeds " + verfehlt.map((x) => x.m.seed).join(", ") + "):\n     " +
    verfehlt.slice(0, 3).map((x) => fallText(x.m, x.ist, x.bf)).join("\n     "));
});

test("Brute-Force: feste Fundfälle", () => {
  const probleme = [];
  FUNDFAELLE.forEach((f) => {
    const bf = bruteForce(f.e, sSlotsVon(f.e));
    const erg = S.loese(kopie(f.e));
    const ist = referenz(f.e, erg.zuweisung);
    if (bf.uneinig.length || lexVgl(ist, bf.min) !== 0) {
      probleme.push(f.name + ": Löser " + JSON.stringify(ist) + ", Optimum " + JSON.stringify(bf.min) +
        "\n       Löser:   " + kurz(erg.zuweisung) + "\n       Optimum: " + kurz(bf.beispiel) +
        "\n       Instanz: " + JSON.stringify(f.e));
    }
  });
  assert.ok(!probleme.length, probleme.join("\n     "));
});

test("Mini-Instanzen: Ergebnis zulässig, Plätze wie Referenz, unbesetzt ⇔ leer, Lücke ⇒ keine Alternative, Alternativen zulässig", () => {
  const probleme = [];
  for (let seed = 1; seed <= MINI_N; seed++) {
    const m = mini(seed);
    if (m.fehler) { probleme.push("Seed " + seed + " wirft: " + m.fehler.split("\n")[0]); continue; }
    const { erg, ctx } = m, z = erg.zuweisung;
    const ids = erg.slots.map((s) => s.id).sort().join(), refIds = ctx.slots.map((s) => s.id).sort();
    if (ids !== refIds.join()) probleme.push("Seed " + seed + ": Plätze " + ids + " ≠ " + refIds.join());
    const f = S.pruefe(m.e, erg.slots, z).concat(erg.verstoesse).filter((b) => b.art === "fehler");
    if (f.length) probleme.push("Seed " + seed + ": harte Verstöße " + JSON.stringify(f));
    if (!refZulaessig(ctx, z)) probleme.push("Seed " + seed + ": eigene Prüfung findet harten Verstoß in " + kurz(z));
    if (refIds.filter((id) => leer(z[id])).join() !== erg.unbesetzt.slice().sort().join()) probleme.push("Seed " + seed + ": unbesetzt " + erg.unbesetzt);
    ctx.slots.forEach((s) => (erg.alternativen[s.id] || []).forEach((pn) => {
      const z2 = Object.assign({}, z);
      z2[s.id] = pn;
      if (leer(z[s.id])) probleme.push("Seed " + seed + ": unbesetzt " + s.id + " hat Alternative " + pn);
      if (!refZulaessig(ctx, z2) || artenAm(z, pn, s.datum).length) probleme.push("Seed " + seed + ": Alternative " + pn + " für " + s.id + " unzulässig");
    }));
  }
  assert.ok(!probleme.length, probleme.length + " Probleme, z. B.\n     " + probleme.slice(0, 5).join("\n     "));
});

test("Mini-Instanzen: kosten/kostenVon/getrenntePaarTage/Hinweise = Referenz; Gründe vorhanden, im Optimum nie „vermeidbar“", () => {
  const probleme = [];
  for (let seed = 1; seed <= MINI_N; seed++) {
    const m = mini(seed);
    if (m.fehler) continue;
    const bf = miniBf(m), ref = refAuswerten(m.ctx, m.erg.zuweisung);
    if (lexVgl(m.erg.kosten.slice(0, 3), ref.kosten) !== 0) probleme.push("Seed " + seed + ": loese().kosten " + JSON.stringify(m.erg.kosten) + " ≠ Referenz " + JSON.stringify(ref.kosten));
    [["Löser", m.erg.zuweisung], ["Optimum", bf.beispiel]].forEach(([was, z]) =>
      abgleich(m.e, m.sSlots, z).forEach((x) => probleme.push("Seed " + seed + " " + was + ": " + x)));
    const optimal = lexVgl(ref.kosten, bf.min) === 0;
    m.erg.verstoesse.filter((b) => b.typ === "limit" || b.typ === "fahrgemeinschaft").forEach((b) => {
      const g = b.grund;
      if (!g || ["luecke", "limit", "fahrgemeinschaft", "vermeidbar"].indexOf(g.typ) < 0) probleme.push("Seed " + seed + ": " + b.typ + " ohne gültigen Grund " + JSON.stringify(g));
      else if (optimal && g.typ === "vermeidbar") probleme.push("Seed " + seed + ": " + b.typ + " im Optimum als „vermeidbar“ begründet");
    });
  }
  assert.ok(!probleme.length, probleme.length + " Abweichungen, z. B.\n     " + probleme.slice(0, 6).join("\n     "));
});

// ======================================================================
// Teil E – Härtefall-Woche, Teil F – Laufzeit
// ======================================================================
test("Härtefall-Woche: Gruppen mit gemeinsamer breiter Verfügbarkeit werden zusammen geplant", () => {
  [["haerte", "mit Teilzeit"], ["haerteMini", "alle Minijob"]].forEach(([k, was]) => {
    const { eingabe, erg, ms } = woche(k);
    const ctx = refKontext(eingabe), r = refAuswerten(ctx, erg.zuweisung);
    const gruppen = Object.keys(ctx.gruppen).filter((g) => ctx.gruppen[g].length >= 2);
    console.log("     Härtefall " + was + ": " + Object.keys(ctx.P).length + " Personen, " + gruppen.length + " Gruppen, " + ctx.paare.length +
      " Paare, " + ctx.paare.length * ctx.tage.length + " Paar-Tage; Lücken " + erg.unbesetzt.length + " (L=" + r.kosten[0] +
      "), Überschreitungen " + r.kosten[1] + ", getrennt " + r.kosten[2] + "; loese " + ms + " ms");
    assert.deepStrictEqual(fehler(erg), [], was);
    const fg = hinweise(erg, "fahrgemeinschaft");
    assert.deepStrictEqual(schluesselMenge(fg), schluesselMenge(r.getrennt), was + ": Hinweise ≠ Referenz");
    if (r.kosten[2] > 0) {
      const ohne = fg.filter((b) => !(b.grund && b.grund.typ === "luecke"));
      assert.ok(!ohne.length, was + ": " + r.kosten[2] + " Trennungen, nicht alle mit Grund Lücke: " +
        JSON.stringify(fg.map((b) => [b.pn, b.partner, b.datum, b.grund])));
    }
  });
});

test("Laufzeit: loese auf der erfundenen Standardwoche mit Profilen unter 2000 ms", () => {
  const j = synth.exportJson("2026-10-19");
  const e = S.ausExport(j, stammProfile(j));
  const t0 = process.hrtime.bigint();
  const erg = S.loese(e);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log("     Standardwoche mit Profilen: " + ms.toFixed(0) + " ms (" + erg.slots.length + " Plätze)");
  assert.ok(ms < 2000, ms.toFixed(0) + " ms");
});

if (gescheitert) console.error(gescheitert + " Tests fehlgeschlagen");
console.log(bestanden + " Tests bestanden");
