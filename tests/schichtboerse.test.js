"use strict";
// Aufruf: node tests/schichtboerse.test.js   (nur erfundene Personalnummern)
const assert = require("assert");
const B = require("../schichtboerse.js");

let bestanden = 0, gescheitert = 0;
function test(name, fn) {
  try { fn(); bestanden++; console.log("ok   " + name); }
  catch (e) { gescheitert++; console.error("FAIL " + name + "\n     " + e.message); process.exitCode = 1; }
}

const DO = "2026-11-19";
const verf = [
  { personalnummer: "90001", datum: DO, schicht_id: "SPAET" },
  { personalnummer: "90002", datum: DO, schicht_id: "SPAET" },
  { personalnummer: "90003", datum: DO, schicht_id: "SPAET" },
  { personalnummer: "90004", datum: DO, schicht_id: "SPAET" },
  { personalnummer: "90005", datum: DO, schicht_id: "FRUEH" },          // andere Schicht
  { personalnummer: "90006", datum: "2026-11-18", schicht_id: "SPAET" }, // anderer Tag
  { personalnummer: "90002", datum: DO, schicht_id: "SPAET" }           // doppelt gemeldet
];
const aktive = ["90001", "90002", "90003", "90005", "90006"];          // 90004 inaktiv
const planung = [
  { personalnummer: "90003", datum: DO },                               // schon eingeplant
  { personalnummer: "90002", datum: "2026-11-18" }                      // anderer Tag: zaehlt nicht
];

test("Kandidaten: nur verfuegbar fuer Tag+Schicht, aktiv, nicht eingeplant, nicht die Ausgefallene", () => {
  const k = B.kandidaten({ datum: DO, schicht_id: "SPAET", verfuegbar: verf, planung: planung, aktive: aktive, ausser: "90001" });
  assert.deepStrictEqual(k, ["90002"]);
});

test("Kandidaten: Zusatzschicht ohne ausgefallene Person", () => {
  const k = B.kandidaten({ datum: DO, schicht_id: "SPAET", verfuegbar: verf, planung: planung, aktive: aktive, ausser: null });
  assert.deepStrictEqual(k, ["90001", "90002"]);
});

test("Kandidaten: leere Eingaben ergeben leere Liste", () => {
  assert.deepStrictEqual(B.kandidaten({ datum: DO, schicht_id: "SPAET" }), []);
});

test("Ortszeit Winter (MEZ, UTC+1)", () => {
  assert.strictEqual(B.berlinZeit("2026-11-19", "16:00").toISOString(), "2026-11-19T15:00:00.000Z");
});

test("Ortszeit Sommer (MESZ, UTC+2), Sekunden in der Uhrzeit egal", () => {
  assert.strictEqual(B.berlinZeit("2026-07-02", "04:00:00").toISOString(), "2026-07-02T02:00:00.000Z");
});

test("Ortszeit an Tagen mit Zeitumstellung", () => {
  assert.strictEqual(B.berlinZeit("2026-03-29", "05:30").toISOString(), "2026-03-29T03:30:00.000Z");
  assert.strictEqual(B.berlinZeit("2026-10-25", "05:30").toISOString(), "2026-10-25T04:30:00.000Z");
});

test("Boersenschluss 1 Stunde vor Beginn", () => {
  assert.strictEqual(B.schluss("2026-11-19", "16:00").toISOString(), "2026-11-19T14:00:00.000Z");
});

test("Lage: offen, nicht besetzt, andere Status unveraendert", () => {
  const a = { status: "frei", datum: "2026-11-19", beginn: "16:00:00" };
  assert.strictEqual(B.lage(a, "2026-11-19T13:59:59Z"), "offen");
  assert.strictEqual(B.lage(a, "2026-11-19T14:00:00Z"), "nicht_besetzt");
  assert.strictEqual(B.lage(Object.assign({}, a, { status: "uebernommen" }), "2026-11-19T20:00:00Z"), "uebernommen");
  assert.strictEqual(B.lage(Object.assign({}, a, { status: "zurueckgenommen" }), "2026-11-01T00:00:00Z"), "zurueckgenommen");
});

test("Aenderungen seit letzter FedEx-Datei", () => {
  const l = [{ am: "2026-11-17T08:00:00Z" }, { am: "2026-11-17T09:00:00Z" }, { am: "2026-11-17T10:00:00Z" }];
  assert.strictEqual(B.aenderungenSeit(l, null), 3);
  assert.strictEqual(B.aenderungenSeit(l, "2026-11-17T09:00:00Z"), 1);
  assert.strictEqual(B.aenderungenSeit([], "2026-11-17T09:00:00Z"), 0);
});

test("FedEx-Eintraege: Art, fortlaufende Nr, offene Schicht als leere Zeile am Ende", () => {
  const planung = [
    { personalnummer: "90002", datum: "2026-11-23", schicht_id: "FRUEH", beginn: "04:00:00", ende: "07:00:00" },
    { personalnummer: "90001", datum: "2026-11-23", schicht_id: "FRUEH", beginn: "04:00:00", ende: "07:00:00" },
    { personalnummer: "90003", datum: "2026-11-23", schicht_id: "SPAET", beginn: "18:30", ende: "22:30" },
    { personalnummer: "90004", datum: "2026-11-24", schicht_id: "LANG", beginn: "16:00", ende: "22:30" }
  ];
  const offen = [{ datum: "2026-11-23", schicht_id: "FRUEH", beginn: "04:00", ende: "07:00" }];
  const namen = { "90001": "Zett", "90002": "Abel" };
  const r = B.fedexEintraege(planung, offen, "2026-11-23", (pn) => namen[pn] || pn);
  assert.deepStrictEqual(r.tage, ["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27"]);
  const am = r.eintraege.filter((e) => e.datum === "2026-11-23" && e.art === "AM");
  assert.deepStrictEqual(am.map((e) => [e.nr, e.personalnummer, e.beginn, e.ende]),
    [[1, "90002", "04:00", "07:00"], [2, "90001", "04:00", "07:00"], [3, null, "04:00", "07:00"]]);
  assert.deepStrictEqual(r.eintraege.filter((e) => e.art === "PM").map((e) => [e.nr, e.personalnummer]), [[1, "90003"]]);
  assert.deepStrictEqual(r.eintraege.filter((e) => e.art === "Office").map((e) => [e.datum, e.nr]), [["2026-11-24", 1]]);
  assert.deepStrictEqual(r.unbekannt, []);
});

test("FedEx-Eintraege: Datum ausserhalb der Woche wird gemeldet, nicht verschluckt", () => {
  const r = B.fedexEintraege([{ personalnummer: "1", datum: "2026-11-30", schicht_id: "FRUEH", beginn: "04:00", ende: "07:00" }], [], "2026-11-23");
  assert.strictEqual(r.eintraege.length, 0);
  assert.deepStrictEqual(r.unbekannt, ["2026-11-30 FRUEH"]);
});

if (gescheitert) console.error(gescheitert + " Tests fehlgeschlagen");
console.log(bestanden + " Tests bestanden");
