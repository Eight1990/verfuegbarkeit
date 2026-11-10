"use strict";
// Aufruf: node tests/solver.test.js   (nur synthetische Daten, keine Namen)
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const S = require("../planung-solver.js");

let bestanden = 0;
function test(name, fn) {
  try { fn(); bestanden++; console.log("ok   " + name); }
  catch (e) { console.error("FAIL " + name + "\n     " + e.message); process.exitCode = 1; }
}

// Erfundene Daten (tests/synthetisch.js) statt der frueheren Testdaten-Datei
const json = require("./synthetisch.js").exportJson("2026-10-19");

function bedarf(f, s) {
  const b = {};
  json.tage.forEach((t) => { b[t.datum] = { FRUEH: f, SPAET: s, LANG: 0 }; });
  return b;
}
function lauf(opts) {
  const e = S.ausExport(json, opts && opts.profile);
  e.bedarf = (opts && opts.bedarf) || bedarf(2, 3);
  return { eingabe: e, erg: S.loese(e) };
}
const fehler = (erg) => erg.verstoesse.filter((v) => v.art === "fehler");

test("keine harten Verstöße auf den erfundenen Daten", () => {
  const { erg } = lauf();
  assert.deepStrictEqual(fehler(erg), []);
});

test("Standardbedarf: nie nicht-verfügbar, nie Spät→Früh am Folgetag", () => {
  const e = S.ausExport(json);
  const erg = S.loese(e);
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

test("deterministisch: gleicher Lauf, gleiches Ergebnis", () => {
  const a = lauf().erg, b = lauf().erg;
  assert.deepStrictEqual(a.zuweisung, b.zuweisung);
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
  const { eingabe, erg } = lauf({ profile, bedarf: bedarf(3, 4) });
  const tz = viele.map((pn) => erg.stunden[pn]);
  const rest = eingabe.personen.filter((p) => viele.indexOf(p.personalnummer) < 0)
    .map((p) => erg.stunden[p.personalnummer]);
  const schnitt = rest.reduce((a, b) => a + b, 0) / rest.length;
  tz.forEach((h) => assert.ok(h >= schnitt, "Teilzeit " + h + " h < Schnitt " + schnitt));
  assert.deepStrictEqual(fehler(erg), []);
});

test("Fairness: niedriger Schnitt bekommt mehr als hoher Schnitt (gleiche Lage)", () => {
  const tage = ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"];
  const schichten = tage.map((d) => ({ datum: d, schicht_id: "SPAET", beginn: "18:30", ende: "22:30" }));
  const verf = tage.map((d) => ({ datum: d, schicht_id: "SPAET" }));
  const bed = {}; tage.forEach((d) => { bed[d] = { SPAET: 1 }; });
  const e = { schichten, tage: [], bedarf: bed, personen: [
    { personalnummer: "A", verfuegbar: verf, schnitt_h: 20 },
    { personalnummer: "B", verfuegbar: verf, schnitt_h: 4 }
  ] };
  const erg = S.loese(e);
  assert.ok(erg.stunden.B > erg.stunden.A, "B (Schnitt 4) sollte mehr bekommen als A (Schnitt 20)");
});

test("Minijobber ohne Historie: Verteilung höchstens 1 Schicht Unterschied", () => {
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
  const { eingabe, erg } = lauf();
  let geprueft = 0;
  erg.slots.forEach((s) => {
    (erg.alternativen[s.id] || []).forEach((pn) => {
      const z = Object.assign({}, erg.zuweisung);
      z[s.id] = pn;
      const v = S.pruefe(eingabe, erg.slots, z)
        .filter((x) => x.art === "fehler" && x.pn === pn && x.typ !== "limit");
      assert.deepStrictEqual(v, [], pn + " als Alternative für " + s.id);
      geprueft++;
    });
  });
  assert.ok(geprueft > 0, "keine Alternativen erzeugt");
});

test("Profil: nur Früh / gesperrter Freitag wird eingehalten", () => {
  const e0 = S.ausExport(json);
  const pn = e0.personen.slice().sort((a, b) => b.verfuegbar.length - a.verfuegbar.length)[0].personalnummer;
  const { erg } = lauf({ profile: { [pn]: { nur_schicht: "FRUEH", gesperrte_tage: [5] } }, bedarf: bedarf(3, 4) });
  erg.slots.forEach((s) => {
    if (erg.zuweisung[s.id] === pn) {
      assert.strictEqual(s.schicht_id, "FRUEH");
      assert.notStrictEqual(S.wochentagVon(s.datum), 5);
    }
  });
});

test("Lücke und Alternative schließen sich aus (Standardbedarf und kleiner Bedarf)", () => {
  [undefined, bedarf(2, 3), bedarf(4, 6)].forEach((b) => {
    const e = S.ausExport(json);
    if (b) e.bedarf = b;
    const erg = S.loese(e);
    erg.unbesetzt.forEach((id) => {
      assert.deepStrictEqual(erg.alternativen[id], [], "unbesetzt " + id + " hat Alternativen");
    });
    assert.deepStrictEqual(fehler(erg), []);
  });
});

test("Wunschgrenze wird nur überschritten, um eine Lücke zu füllen", () => {
  const tage = ["2026-10-20", "2026-10-21"];
  const schichten = tage.map((d) => ({ datum: d, schicht_id: "SPAET", beginn: "18:30", ende: "22:30" }));
  const verf = tage.map((d) => ({ datum: d, schicht_id: "SPAET" }));
  const bed = {}; tage.forEach((d) => { bed[d] = { SPAET: 1 }; });
  // einzige Person, Wunschgrenze 1, zwei Plätze: zweiter Platz nur per Überschreitung besetzbar
  const e = { schichten, tage: [], bedarf: bed, personen: [
    { personalnummer: "A", verfuegbar: verf, max_schichten: 1 } ] };
  const erg = S.loese(e);
  assert.strictEqual(erg.unbesetzt.length, 0, "Lücke bleibt trotz verfügbarer Person");
  assert.ok(erg.verstoesse.some((v) => v.typ === "limit" && v.art === "hinweis"));
  assert.deepStrictEqual(fehler(erg), []);
});

console.log(bestanden + " Tests bestanden");
