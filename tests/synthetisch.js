"use strict";
// Erfundene Testdaten fuer Solver-Test und Vorschau. Keine echten Personen,
// keine echten Personalnummern. Deterministisch (fester Zufalls-Startwert),
// damit Tests reproduzierbar bleiben.
//
// exportJson(start)  -> dieselbe Struktur wie der JSON-Export der App
//                       (meta, tage, schichten, mitarbeiter[].verfuegbar)
// stammliste(json)   -> Zeilen fuer eine erfundene Stammliste (mit Kopfzeile)
// datenbank(json)    -> Tabellen fuer das Fake-Backend der Vorschau

function zufall(startwert) {
  let a = startwert >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SCHICHTEN = {
  FRUEH: { name: "Frühschicht", sortierung: 1, zeiten: (wt) => (wt === 1 ? ["04:00", "07:00", 3] : ["05:30", "08:30", 3]) },
  SPAET: { name: "Spätschicht", sortierung: 2, zeiten: () => ["18:30", "22:30", 4] },
  LANG:  { name: "Lange Spätschicht", sortierung: 3, zeiten: () => ["16:00", "22:30", 6.5] }
};
const WOCHENTAGE = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag"];

function plusTage(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function isoKw(iso) {
  const d = new Date(iso + "T00:00:00Z");
  const tag = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - tag);
  const jahrStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return { jahr: d.getUTCFullYear(), kw: Math.ceil(((d - jahrStart) / 86400000 + 1) / 7) };
}

function exportJson(start, anzahl) {
  start = start || "2026-10-19";
  anzahl = anzahl || 32;
  const r = zufall(43);
  const k = isoKw(start);
  const tage = [], schichten = [];
  for (let i = 0; i < 5; i++) {
    const datum = plusTage(start, i);
    tage.push({ datum, wochentag: i + 1, gesperrt: false, grund: null });
    Object.keys(SCHICHTEN).forEach((id) => {
      const [beginn, ende, dauer] = SCHICHTEN[id].zeiten(i + 1);
      schichten.push({ datum, wochentag: i + 1, schicht_id: id, name: SCHICHTEN[id].name,
        beginn, ende, dauer_h: dauer, aktiv: true, sortierung: SCHICHTEN[id].sortierung });
    });
  }
  const mitarbeiter = [];
  for (let n = 0; n < anzahl; n++) {
    const pn = String(10001 + n);
    const abgegeben = r() < 0.8;
    const verfuegbar = [];
    if (abgegeben) {
      tage.forEach((t) => {
        const frueh = r() < 0.45, lang = r() < 0.3, spaet = lang || r() < 0.5;
        if (frueh) verfuegbar.push({ datum: t.datum, schicht_id: "FRUEH" });
        if (spaet) verfuegbar.push({ datum: t.datum, schicht_id: "SPAET" });
        if (lang) verfuegbar.push({ datum: t.datum, schicht_id: "LANG" });
      });
    }
    const abgabeTag = plusTage(start, -7 + Math.floor(r() * 4));
    mitarbeiter.push({
      personalnummer: pn,
      abgegeben,
      abgegeben_am: abgegeben ? abgabeTag + "T" + String(8 + Math.floor(r() * 10)).padStart(2, "0") + ":15:00.000Z" : null,
      max_schichten_woche: abgegeben && r() < 0.3 ? 2 + Math.floor(r() * 3) : null,
      hinweis: null,
      verfuegbar
    });
  }
  return {
    meta: { kw: k.jahr + "-W" + String(k.kw).padStart(2, "0"), kw_nummer: k.kw, jahr: k.jahr, start,
      ende: plusTage(start, 4), exportiert_am: start + "T12:00:00.000Z",
      hinweis: "Erfundene Testdaten. Angaben sind maximale Verfügbarkeit." },
    tage: tage.map((t) => Object.assign({}, t, { wochentag_name: WOCHENTAGE[t.wochentag - 1] })),
    schichten,
    mitarbeiter
  };
}

// Erfundene Stammliste: Kopfzeile + eine Zeile je Mitarbeiter (Passwort nur Platzhalter).
function stammliste(json) {
  const vor = ["Anna", "Ben", "Clara", "David", "Eva", "Felix", "Greta", "Hannes", "Ida", "Jonas", "Klara", "Lukas",
    "Mia", "Noah", "Olga", "Paul", "Rita", "Sven", "Tina", "Uwe", "Vera", "Willi", "Xenia", "Yannik"];
  const nach = ["Mustermann", "Beispiel", "Testfrau", "Probst", "Erfunden", "Demo", "Platzhalter", "Fiktiv"];
  // Seit 11.11.2026 nur noch Kategorie und Fahrgemeinschaft als Profilspalten.
  const kopf = ["Personalnummer", "Passwort", "Name", "Kategorie", "Fahrgemeinschaft"];
  return [kopf].concat(json.mitarbeiter.map((m, i) =>
    [m.personalnummer, "Start-" + m.personalnummer + "!", nach[i % nach.length] + " " + vor[i % vor.length],
      i % 3 === 0 ? "Teilzeit" : "Minijob", i % 6 < 2 ? "G" + (i % 4) : ""]));
}

// Tabellen fuer das Fake-Backend (Spaltennamen wie in Supabase).
function datenbank(json) {
  const kw = json.meta.start;
  const frist = plusTage(kw, -3) + "T10:00:00+00:00";
  return {
    weeks: [{ kw_start_datum: kw, abgabefrist: frist }],
    week_days: json.tage.map((t) => ({ kw_start_datum: kw, datum: t.datum, wochentag: t.wochentag, gesperrt: t.gesperrt, grund: t.grund })),
    week_shifts: json.schichten.map((s) => ({ kw_start_datum: kw, datum: s.datum, wochentag: s.wochentag, schicht_id: s.schicht_id,
      name: s.name, beginn: s.beginn, ende: s.ende, dauer_h: s.dauer_h, aktiv: s.aktiv, sortierung: s.sortierung })),
    shift_types: Object.keys(SCHICHTEN).map((id) => ({ schicht_id: id, name: SCHICHTEN[id].name, symbol: id === "FRUEH" ? "sonne" : "mond",
      sortierung: SCHICHTEN[id].sortierung, aktiv: true })),
    shift_templates: [].concat(...Object.keys(SCHICHTEN).map((id) => [1, 2, 3, 4, 5].map((wt) => {
      const [beginn, ende] = SCHICHTEN[id].zeiten(wt);
      return { schicht_id: id, wochentag: wt, beginn, ende, aktiv: true };
    }))),
    employees: json.mitarbeiter.map((m) => ({ personalnummer: m.personalnummer, aktiv: true, __pw: "Start-" + m.personalnummer + "!" })),
    submissions: json.mitarbeiter.filter((m) => m.abgegeben).map((m) => ({ kw_start_datum: kw, personalnummer: m.personalnummer,
      max_schichten: m.max_schichten_woche, hinweis: "", abgegeben_am: m.abgegeben_am })),
    availability: [].concat(...json.mitarbeiter.map((m) => m.verfuegbar.map((v) =>
      ({ kw_start_datum: kw, personalnummer: m.personalnummer, datum: v.datum, schicht_id: v.schicht_id })))),
    planung: [],
    planung_stand: [],
    planung_historie: [],
    app_dateien: [],
    app_einstellungen: [{ schluessel: "kontakt_handy", wert: "0170 0000000" }]
  };
}

module.exports = { exportJson, stammliste, datenbank, plusTage, isoKw };
