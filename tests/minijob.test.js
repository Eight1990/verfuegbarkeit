"use strict";
// Aufruf: node tests/minijob.test.js
// Prüft minijob.js gegen den Vertrag vom 11.11.2026 (harte Minijob-Grenze).
// Nur erfundene Daten: Personalnummern 1000x/2000x/3000x, keine Namen, keine
// echten Beträge. Erwartete Werte sind von Hand gerechnet (Rechenweg steht
// jeweils dabei), nicht mit dem Modul selbst.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const M = require("../minijob.js");

let bestanden = 0;
const faelle = [];
function test(name, fn) { faelle.push({ name, fn }); }
const mit = (basis, aenderung) => Object.assign({}, basis, aenderung);

// Kopfzeile und Beispielzeile aus dem Vertrag (erfunden)
const KOPF = "Personalnummer;Eintritt;Austritt;Erster Monat;Letzter Monat;Monate;SV-Brutto im Zeitraum (KV-pflichtig);" +
  "Gesamtbrutto im Zeitraum;Ø SV-Brutto je Monat;Grenze im Zeitraum (Summe Monatsgrenzen);Spielraum bis Grenze;" +
  "Stunden im Zeitraum;Ø Stundenlohn (Gesamtbrutto/Stunden);Minijob-Merkmal (ALV/PV = 0);Prüfung Jahressumme;Hinweis";
const BEISPIEL = "10001;02.02.2026;;2026-02;2026-09;8;2.950,00;3.120,00;368,75;4.824,00;1.874,00;210,50;14,82;ja;ok;";
const KURZKOPF = "Personalnummer;Eintritt;Letzter Monat;SV-Brutto im Zeitraum;Stunden im Zeitraum;Minijob-Merkmal";

// Von Hand gerechnetes Beispiel (siehe Test „Rechenbeispiel“)
const P = { eintritt: "2026-04-16", austritt: null, abgerechnetBis: "2026-09", svBrutto: 2520, stunden: 180, minijobMerkmal: "ja" };

// ---------------------------------------------------------------------
// Schnittstelle
// ---------------------------------------------------------------------
test("Schnittstelle: genau GRENZEN und die sechs Funktionen des Vertrags", () => {
  assert.deepStrictEqual(Object.keys(M).sort(), ["GRENZEN", "befristungsende", "csvLesen", "grenzeImZeitraum",
    "wochenGrenzeMinuten", "wochenGrenzen", "zusammenfassung"]);
  assert.deepStrictEqual(M.GRENZEN, { 2025: 556, 2026: 603, 2027: 633 });
  assert.ok(Object.isFrozen(M.GRENZEN), "GRENZEN soll unveränderlich sein");
});

test("Deterministisch: kein Zufall, keine aktuelle Uhrzeit im Modul", () => {
  const code = fs.readFileSync(path.join(__dirname, "..", "minijob.js"), "utf8");
  assert.ok(!/Math\.random|Date\.now|new Date\(\s*\)/.test(code), "Zufall oder „jetzt“ im Modul");
});

// ---------------------------------------------------------------------
// befristungsende
// ---------------------------------------------------------------------
test("befristungsende: Beispiele des Koordinators (übliche Monatsfrist)", () => {
  // derselbe Tag 9 Monate später; gibt es ihn, Ende am Tag davor, sonst am Monatsletzten
  assert.strictEqual(M.befristungsende("2026-02-02"), "2026-11-01"); // 02.11. → Tag davor
  assert.strictEqual(M.befristungsende("2026-03-01"), "2026-11-30"); // 01.12. → Tag davor
  assert.strictEqual(M.befristungsende("2026-05-01"), "2027-01-31"); // 01.02.2027 → Tag davor
  assert.strictEqual(M.befristungsende("2026-01-01"), "2026-09-30"); // 01.10. → Tag davor
  assert.strictEqual(M.befristungsende("2026-05-31"), "2027-02-28"); // 31.02. fehlt → Monatsletzter
  assert.strictEqual(M.befristungsende("2026-05-30"), "2027-02-28"); // 30.02. fehlt → Monatsletzter
  assert.strictEqual(M.befristungsende("2026-05-28"), "2027-02-27"); // 28.02.2027 → Tag davor
});

test("befristungsende: Monatsende, Jahreswechsel, Schaltjahr", () => {
  assert.strictEqual(M.befristungsende("2026-01-31"), "2026-10-30"); // 31.10. → Tag davor
  assert.strictEqual(M.befristungsende("2026-04-01"), "2026-12-31"); // 01.01.2027 → Tag davor
  assert.strictEqual(M.befristungsende("2026-07-01"), "2027-03-31"); // 01.04.2027 → Tag davor
  assert.strictEqual(M.befristungsende("2026-12-01"), "2027-08-31"); // 01.09.2027 → Tag davor
  assert.strictEqual(M.befristungsende("2026-12-31"), "2027-09-30"); // 31.09. fehlt → Monatsletzter
  assert.strictEqual(M.befristungsende("2026-04-16"), "2027-01-15"); // 16.01.2027 → Tag davor, über den Jahreswechsel
  assert.strictEqual(M.befristungsende("2026-06-01"), "2027-02-28"); // 01.03.2027 → Tag davor
  assert.strictEqual(M.befristungsende("2027-06-01"), "2028-02-29"); // 01.03.2028 → Tag davor (Schaltjahr)
  assert.strictEqual(M.befristungsende("2027-05-31"), "2028-02-29"); // 31.02.2028 fehlt → Monatsletzter (Schaltjahr)
  assert.strictEqual(M.befristungsende("2027-05-30"), "2028-02-29"); // 30.02.2028 fehlt → Monatsletzter (Schaltjahr)
  assert.strictEqual(M.befristungsende("2028-02-29"), "2028-11-28"); // Eintritt am Schalttag: 29.11. → Tag davor
});

test("befristungsende: 29.05.2027 → 28.02.2028 (Regel wörtlich; die Beispielliste nannte 29.02.)", () => {
  // Den 29.02.2028 gibt es (Schaltjahr) → Ende am Tag davor, genau wie 28.05.2026 → 27.02.2027
  // und wie § 188 BGB. Die Beispielliste nannte 29.02.2028 – das widerspricht der eigenen Regel
  // (im Bericht gemeldet).
  assert.strictEqual(M.befristungsende("2027-05-29"), "2028-02-28");
});

test("befristungsende: ungültige Eingaben werfen", () => {
  ["2026-02-30", "02.02.2026", "", null, undefined, "2026-2-2"].forEach((x) => {
    assert.throws(() => M.befristungsende(x), /Eintritt/, String(x));
  });
});

// ---------------------------------------------------------------------
// grenzeImZeitraum
// ---------------------------------------------------------------------
test("grenzeImZeitraum: volle Monate", () => {
  assert.strictEqual(M.grenzeImZeitraum("2026-01-01", "2026-12-31"), 7236); // 12 · 603
  assert.strictEqual(M.grenzeImZeitraum("2026-03-01", "2026-03-31"), 603);
  assert.strictEqual(M.grenzeImZeitraum("2025-01-01", "2025-12-31"), 6672); // 12 · 556
});

test("grenzeImZeitraum: Teilmonate anteilig nach Tagen, beide Tage inklusive", () => {
  assert.strictEqual(M.grenzeImZeitraum("2026-04-16", "2026-04-30"), 301.5);  // 15/30 · 603
  assert.strictEqual(M.grenzeImZeitraum("2026-04-16", "2026-05-31"), 904.5);  // 301,50 + 603
  assert.strictEqual(M.grenzeImZeitraum("2026-05-01", "2026-05-10"), 194.52); // 10/31 · 603 = 194,516…
  assert.strictEqual(M.grenzeImZeitraum("2026-02-10", "2026-02-16"), 150.75); // 7/28 · 603
  assert.strictEqual(M.grenzeImZeitraum("2026-02-01", "2026-02-01"), 21.54);  // 1/28 · 603 = 21,535…
});

test("grenzeImZeitraum: über den Jahreswechsel mit den Grenzen des jeweiligen Jahres", () => {
  // Nov 2025 15/30 · 556 = 278 + Dez 2025 556 + Jan 2026 603
  assert.strictEqual(M.grenzeImZeitraum("2025-11-16", "2026-01-31"), 1437);
  // Dez 2026 15/31 · 603 + Jan 2027 15/31 · 633 = 15 · 1236 / 31 = 598,0645…
  assert.strictEqual(M.grenzeImZeitraum("2026-12-17", "2027-01-15"), 598.06);
});

test("grenzeImZeitraum: unbekanntes späteres Jahr = letzter bekannter Wert, Schaltjahr", () => {
  assert.strictEqual(M.grenzeImZeitraum("2028-01-01", "2028-12-31"), 7596);  // 12 · 633
  assert.strictEqual(M.grenzeImZeitraum("2028-02-01", "2028-02-29"), 633);   // voller Schalt-Februar
  assert.strictEqual(M.grenzeImZeitraum("2028-02-29", "2028-02-29"), 21.83); // 633/29 = 21,827…
  assert.strictEqual(M.grenzeImZeitraum("2030-07-01", "2030-07-31"), 633);
  // Jahr vor der Tabelle: erster bekannter Wert (kommt bei 9-Monats-Verträgen nicht vor)
  assert.strictEqual(M.grenzeImZeitraum("2024-12-01", "2024-12-31"), 556);
});

test("grenzeImZeitraum: leerer Zeitraum und ungültige Eingaben", () => {
  assert.strictEqual(M.grenzeImZeitraum("2026-05-02", "2026-05-01"), 0);
  assert.throws(() => M.grenzeImZeitraum("2026-02-30", "2026-03-31"), /Beginn/);
  assert.throws(() => M.grenzeImZeitraum("2026-02-01", "31.03.2026"), /Ende/);
});

// ---------------------------------------------------------------------
// wochenGrenzeMinuten
// ---------------------------------------------------------------------
test("Rechenbeispiel von Hand (Eintritt am 16. eines 30-Tage-Monats, über den Jahreswechsel)", () => {
  // Eintritt E = 16.04.2026, abgerechnet bis 09/2026, SV-Brutto 2.520,00 €, 180,00 h
  // B: den 16.01.2027 gibt es → Tag davor = 15.01.2027
  assert.strictEqual(M.befristungsende(P.eintritt), "2027-01-15");
  // Grenze E..B: Apr 15/30 · 603 = 301,50 | Mai–Dez 8 · 603 = 4.824,00 | Jan 2027 15/31 · 633 = 306,29…
  //   = 5.431,790… → 5.431,79 €
  assert.strictEqual(M.grenzeImZeitraum(P.eintritt, "2027-01-15"), 5431.79);
  // rest = 5.431,79 − 2.520,00 = 2.911,79 €
  // A = max(16.04.2026, 01.10.2026) = 01.10.2026; tage = 31 + 30 + 31 + 15 = 107
  // euroProWoche = 2.911,79 · 7 / 107 = 190,4909… €;  satz = 2.520 / 180 = 14,00 €/h
  // minuten = floor(190,4909… / 14 · 60) = floor(816,3897…) = 816
  assert.strictEqual(M.wochenGrenzeMinuten(P), 816);
  assert.strictEqual(M.wochenGrenzeMinuten(P, 99), 816, "eigener Satz geht vor satzErsatz");
});

test("Beispielzeile des Vertrags: CSV → 2.950 € / 210,5 h → 2318 Minuten", () => {
  const r = M.csvLesen(KOPF + "\n" + BEISPIEL + "\n");
  assert.deepStrictEqual(r.fehler, []);
  const p = r.personen["10001"];
  assert.strictEqual(p.svBrutto, 2950, "SV-Brutto im Zeitraum, nicht Ø SV-Brutto je Monat");
  assert.strictEqual(p.stunden, 210.5, "Stunden im Zeitraum, nicht Ø Stundenlohn");
  // B = 01.11.2026; Grenze: Feb 27/28 · 603 = 581,46… + Mär–Okt 8 · 603 + Nov 1/30 · 603 = 20,10 → 5.425,56
  assert.strictEqual(M.grenzeImZeitraum("2026-02-02", "2026-11-01"), 5425.56);
  // rest 2.475,56; A = 01.10.2026, tage = 32; euroProWoche = 2.475,56 · 7/32 = 541,52875
  // satz = 2.950/210,5 = 14,0142…; minuten = floor(2318,478…) = 2318
  assert.strictEqual(M.wochenGrenzeMinuten(p), 2318);
});

test("wochenGrenzeMinuten: unter, knapp unter, genau auf und über der Grenze", () => {
  assert.strictEqual(M.wochenGrenzeMinuten(P), 816);
  // rest 50,00 €: 50 · 7/107 = 3,271 €/Wo; satz 5.381,79/180 = 29,899 €/h → 6,56 → 6
  assert.strictEqual(M.wochenGrenzeMinuten(mit(P, { svBrutto: 5381.79 })), 6);
  assert.strictEqual(M.wochenGrenzeMinuten(mit(P, { svBrutto: 5431.79 })), 0); // rest = 0
  assert.strictEqual(M.wochenGrenzeMinuten(mit(P, { svBrutto: 6000 })), 0);    // rest < 0 → 0
});

test("wochenGrenzeMinuten: null ohne abgerechneten Monat oder ohne Eintritt", () => {
  assert.strictEqual(M.wochenGrenzeMinuten(mit(P, { abgerechnetBis: null })), null);
  assert.strictEqual(M.wochenGrenzeMinuten(mit(P, { abgerechnetBis: "" })), null);
  assert.strictEqual(M.wochenGrenzeMinuten(mit(P, { eintritt: null })), null);
  assert.strictEqual(M.wochenGrenzeMinuten(null), null);
});

test("wochenGrenzeMinuten: null, wenn Beginn A nach Befristungsende B; A = B zählt einen Tag", () => {
  const Q = { eintritt: "2026-02-02", austritt: null, abgerechnetBis: "2026-11", svBrutto: 5300, stunden: 400, minijobMerkmal: "ja" };
  // B = 01.11.2026, A = 01.12.2026 > B
  assert.strictEqual(M.wochenGrenzeMinuten(Q), null);
  // abgerechnet bis 10/2026: A = B = 01.11.2026, tage = 1
  // rest = 5.425,56 − 5.300,00 = 125,56; euroProWoche = min(125,56, 125,56 · 7/1) = 125,56; satz 13,25
  // minuten = floor(125,56 / 13,25 · 60) = floor(568,57) = 568 (ohne Deckel wären es 3980)
  assert.strictEqual(M.wochenGrenzeMinuten(mit(Q, { abgerechnetBis: "2026-10" })), 568);
});

test("wochenGrenzeMinuten: unter 7 Resttagen je Woche höchstens das ganze Restbudget", () => {
  // P (Satz 14 €/h), A = 01.10.2026; der Austritt setzt B und damit tage
  // tage 6 (B 06.10.): Grenze 301,50 + 5 · 603 + 6/31 · 603 = 3.433,21 → rest 913,21
  //   min(913,21, 913,21 · 7/6) = 913,21 → floor(913,21 / 14 · 60) = floor(3913,76) = 3913 (ungedeckelt 4566)
  assert.strictEqual(M.wochenGrenzeMinuten(mit(P, { austritt: "2026-10-06" })), 3913);
  // tage 7 (B 07.10.): Grenze 3.452,66 → rest 932,66 · 7/7 → floor(3997,11) = 3997 (Deckel und Formel gleich)
  assert.strictEqual(M.wochenGrenzeMinuten(mit(P, { austritt: "2026-10-07" })), 3997);
  // tage 14 (B 14.10.): Grenze 3.588,82 → rest 1.068,82 · 7/14 = 534,41 → floor(2290,33) = 2290
  assert.strictEqual(M.wochenGrenzeMinuten(mit(P, { austritt: "2026-10-14" })), 2290);
  // Ersatzsatz-Weg ebenso gedeckelt: stunden 0, Satz 16, tage 6 → floor(91321 · 420 / (100 · 7 · 16)) = 3424
  assert.strictEqual(M.wochenGrenzeMinuten(mit(P, { austritt: "2026-10-06", stunden: 0 }), 16), 3424);
});

test("wochenGrenzeMinuten: A = Eintritt, wenn der erste offene Monat vor dem Eintritt beginnt", () => {
  // abgerechnet bis 03/2026, Eintritt 16.04.2026: A = max(16.04., 01.04.) = 16.04.2026
  // tage 16.04.2026–15.01.2027 = 15+31+30+31+31+30+31+30+31+15 = 275; rest 5.431,79 (noch nichts verdient)
  // satz = Ersatz 16 → floor(543179 · 420 / (100 · 275 · 16)) = floor(518,49) = 518 (ab 01.04. wären es 491)
  assert.strictEqual(M.wochenGrenzeMinuten(mit(P, { abgerechnetBis: "2026-03", svBrutto: 0, stunden: 0 }), 16), 518);
});

test("wochenGrenzeMinuten: Austritt vor dem Befristungsende begrenzt B", () => {
  // B = min(30.11.2026, 15.01.2027) = 30.11.2026
  // Grenze: Apr 301,50 + Mai–Nov 7 · 603 = 4.522,50; rest 2.002,50; A = 01.10., tage = 61
  // euroProWoche = 2.002,50 · 7/61 = 229,795…; / 14 · 60 = 984,83… → 984
  assert.strictEqual(M.wochenGrenzeMinuten(mit(P, { austritt: "2026-11-30" })), 984);
  // Austritt nach dem Befristungsende oder genau darauf ändert nichts
  assert.strictEqual(M.wochenGrenzeMinuten(mit(P, { austritt: "2027-03-31" })), 816);
  assert.strictEqual(M.wochenGrenzeMinuten(mit(P, { austritt: "2027-01-15" })), 816);
  assert.strictEqual(M.wochenGrenzeMinuten(mit(P, { austritt: "" })), 816);
  // Austritt vor dem ersten offenen Tag: A > B → null
  assert.strictEqual(M.wochenGrenzeMinuten(mit(P, { austritt: "2026-09-15" })), null);
});

test("wochenGrenzeMinuten: ohne Stunden gilt satzErsatz (Standard 16 €/h)", () => {
  // rest 2.911,79, tage 107: floor(291179 · 420 / (100 · 107 · satz))
  assert.strictEqual(M.wochenGrenzeMinuten(mit(P, { stunden: 0 }), 16), 714); // 714,34
  assert.strictEqual(M.wochenGrenzeMinuten(mit(P, { stunden: 0 }), 20), 571); // 571,47
  [undefined, null, 0, -3, NaN, Infinity, "20"].forEach((x) => {
    assert.strictEqual(M.wochenGrenzeMinuten(mit(P, { stunden: 0 }), x), 714, "satzErsatz " + String(x));
  });
  assert.strictEqual(M.wochenGrenzeMinuten(mit(P, { stunden: null }), 16), 714);
  // Stunden > 0, aber SV-Brutto 0 (Satz wäre 0): ebenfalls Ersatzsatz.
  // rest = 5.431,79 → floor(543179 · 420 / 171200) = floor(1332,57) = 1332
  assert.strictEqual(M.wochenGrenzeMinuten(mit(P, { svBrutto: 0, stunden: 10 }), 16), 1332);
});

test("wochenGrenzeMinuten: Ergebnis immer ganze Zahl ≥ 0 oder null (Raster)", () => {
  let gezaehlt = 0;
  ["2025-03-01", "2025-12-31", "2026-02-02", "2026-04-16", "2026-10-01", "2027-06-01"].forEach((eintritt) => {
    ["2025-06", "2026-01", "2026-09", "2026-12", "2027-12"].forEach((abgerechnetBis) => {
      [0, 0.01, 100, 2520, 99999.99].forEach((svBrutto) => {
        [0, 0.5, 180].forEach((stunden) => {
          [null, "2026-06-30", "2027-12-31"].forEach((austritt) => {
            [undefined, 0, 16, 25.5].forEach((ersatz) => {
              const m = M.wochenGrenzeMinuten({ eintritt, austritt, abgerechnetBis, svBrutto, stunden }, ersatz);
              assert.ok(m === null || (Number.isInteger(m) && m >= 0), JSON.stringify({ eintritt, abgerechnetBis, svBrutto, stunden, austritt, ersatz, m }));
              gezaehlt++;
            });
          });
        });
      });
    });
  });
  assert.strictEqual(gezaehlt, 6 * 5 * 5 * 3 * 3 * 4);
});

test("wochenGrenzeMinuten: kaputte Werte werfen statt still keine Grenze", () => {
  assert.throws(() => M.wochenGrenzeMinuten(mit(P, { eintritt: "16.04.2026" })), /Eintritt/);
  assert.throws(() => M.wochenGrenzeMinuten(mit(P, { abgerechnetBis: "2026-9" })), /Abgerechnet bis/);
  assert.throws(() => M.wochenGrenzeMinuten(mit(P, { austritt: "2026-11-31" })), /Austritt/);
  assert.throws(() => M.wochenGrenzeMinuten(mit(P, { svBrutto: undefined })), /SV-Brutto/);
  assert.throws(() => M.wochenGrenzeMinuten(mit(P, { svBrutto: -1 })), /SV-Brutto/);
  assert.throws(() => M.wochenGrenzeMinuten(mit(P, { stunden: NaN })), /Stunden/);
});

// ---------------------------------------------------------------------
// csvLesen
// ---------------------------------------------------------------------
test("csvLesen: BOM, CRLF, Vorspann, Anführungszeichen mit Semikolon, Dezimalkomma, Tausenderpunkt", () => {
  const csv = "﻿" + [
    "Minijob-Stand (erfunden);;",
    "",
    KOPF,
    BEISPIEL,
    // Spalte „Erster Monat“ zitiert mit Semikolon und "" – verschiebt sonst alle Spalten dahinter
    '10002;"16.04.2026";30.11.2026;"2026-04; ""geprüft""";2026-09;6;"1.234,56";1.300,00;205,76;3.316,50;2.081,94;"88,25";13,99;"JA";ok;"Hinweis; mit Semikolon"',
    "",
    "10003;01.10.2026;;;;0;;;;;;;;?;;neu",
    ";;;;;;;;;;;;;;;",
    ""
  ].join("\r\n");
  const r = M.csvLesen(csv);
  assert.deepStrictEqual(r.fehler, []);
  assert.strictEqual(r.anzahl, 3);
  assert.deepStrictEqual(r.personen, {
    10001: { eintritt: "2026-02-02", austritt: null, abgerechnetBis: "2026-09", svBrutto: 2950, stunden: 210.5, minijobMerkmal: "ja" },
    10002: { eintritt: "2026-04-16", austritt: "2026-11-30", abgerechnetBis: "2026-09", svBrutto: 1234.56, stunden: 88.25, minijobMerkmal: "ja" },
    10003: { eintritt: "2026-10-01", austritt: null, abgerechnetBis: null, svBrutto: 0, stunden: 0, minijobMerkmal: "?" }
  });
});

test("csvLesen: Spalten über den Kopfzeilen-Text in beliebiger Reihenfolge, Zusatzspalten, ohne Austritt", () => {
  const csv = "Hinweis;Minijob-Merkmal;Stunden im Zeitraum;Extra;SV-Brutto im Zeitraum;Letzter Monat;Eintritt;Personalnummer\n" +
    "x;nein;10,00;y;150,00;2026-9;1.9.2026;20001\n" +
    "x;Nein;1.234,5;y;12.345,67;2026-10;2026-09-15;20002";
  const r = M.csvLesen(csv);
  assert.deepStrictEqual(r.fehler, []);
  assert.deepStrictEqual(r.personen["20001"],
    { eintritt: "2026-09-01", austritt: null, abgerechnetBis: "2026-09", svBrutto: 150, stunden: 10, minijobMerkmal: "nein" });
  assert.deepStrictEqual(r.personen["20002"],
    { eintritt: "2026-09-15", austritt: null, abgerechnetBis: "2026-10", svBrutto: 12345.67, stunden: 1234.5, minijobMerkmal: "nein" });
  assert.strictEqual(r.anzahl, 2);
  // Nur der Anfang zählt: Köder-Spalten, die den Suchtext mitten im Namen tragen, stören nicht
  const k = M.csvLesen("Vorheriger Eintritt;Eintrittsdatum;Ø Stunden im Zeitraum je Monat;Stunden im Zeitraum (gesamt);" +
    "Ø SV-Brutto im Zeitraum;SV-Brutto im Zeitraum (KV-pflichtig);Letzter Monat;Minijob-Merkmal (ALV/PV = 0);Personalnummer\n" +
    "01.01.2020;02.02.2026;1,00;210,50;9,99;2.950,00;2026-09;ja;10001\n");
  assert.deepStrictEqual(k.fehler, []);
  assert.deepStrictEqual(k.personen["10001"],
    { eintritt: "2026-02-02", austritt: null, abgerechnetBis: "2026-09", svBrutto: 2950, stunden: 210.5, minijobMerkmal: "ja" });
});

test("csvLesen: fehlende Pflichtspalten → lesbare Fehler, keine Personen", () => {
  const r = M.csvLesen("Personalnummer;Eintritt;Letzter Monat;SV-Brutto im Zeitraum\n10001;02.02.2026;2026-09;100,00\n");
  assert.deepStrictEqual(r.personen, {});
  assert.strictEqual(r.anzahl, 0);
  assert.deepStrictEqual(r.fehler, ["Spalte „Stunden im Zeitraum“ fehlt.", "Spalte „Minijob-Merkmal“ fehlt."]);
  // ohne Kopfzeile
  const k = M.csvLesen("a;b;c\n1;2;3\n");
  assert.strictEqual(k.anzahl, 0);
  assert.ok(k.fehler.length === 1 && /Kopfzeile/.test(k.fehler[0]), k.fehler.join(" | "));
  // mehrdeutige Spalte
  const d = M.csvLesen("Personalnummer;Eintritt;Letzter Monat;SV-Brutto im Zeitraum (KV);SV-Brutto im Zeitraum (RV);" +
    "Stunden im Zeitraum;Minijob-Merkmal\n10001;02.02.2026;2026-09;1,00;2,00;1,00;ja\n");
  assert.strictEqual(d.anzahl, 0);
  assert.ok(d.fehler.length === 1 && /mehrdeutig \(Spalten 4, 5\)/.test(d.fehler[0]), d.fehler.join(" | "));
});

test("csvLesen: fehlerhafte Zeilen werden gemeldet und ausgelassen, Zeilen ohne Personalnummer still übersprungen", () => {
  const csv = [
    KURZKOPF,                                    // Zeile 1
    "30001;31.02.2026;2026-09;100,00;10,00;ja",  // 2: Datum unmöglich
    "30002;01.02.2026;2026-13;100,00;10,00;ja",  // 3: Monat unmöglich
    "30003;01.02.2026;2026-09;210.50;10,00;ja",  // 4: Punkt als Dezimalzeichen
    "30004;01.02.2026;2026-09;-5,00;10,00;ja",   // 5: negativ
    "30005;01.02.2026;2026-09;;10,00;ja",        // 6: SV-Brutto fehlt trotz Abrechnung
    ";01.02.2026;2026-09;100,00;10,00;ja",       // 7: ohne Personalnummer → still weg
    "30006;01.02.2026;2026-09;1.000,00;50,00;ja",// 8: gültig
    "30006;01.03.2026;2026-09;5,00;1,00;ja",     // 9: doppelt → erste Zeile gilt
    "300 07;01.02.2026;2026-09;1,00;1,00;ja",    // 10: Personalnummer ungültig
    "30008;01.02.2026;2026-09;1,00;1,2,3;ja"     // 11: Stunden ungültig
  ].join("\n");
  const r = M.csvLesen(csv);
  assert.deepStrictEqual(Object.keys(r.personen), ["30006"]);
  assert.strictEqual(r.personen["30006"].svBrutto, 1000);
  assert.strictEqual(r.anzahl, 1);
  const nr = r.fehler.map((f) => Number(/^Zeile (\d+)/.exec(f)[1]));
  assert.deepStrictEqual(nr, [2, 3, 4, 5, 6, 9, 10, 11], r.fehler.join(" | "));
  assert.ok(/Personalnummer 30001\): Eintritt „31\.02\.2026“/.test(r.fehler[0]), r.fehler[0]);
  assert.ok(/Letzter Monat „2026-13“/.test(r.fehler[1]), r.fehler[1]);
  assert.ok(/SV-Brutto im Zeitraum „210\.50“ ist keine Zahl/.test(r.fehler[2]), r.fehler[2]);
  assert.ok(/„-5,00“ ist keine Zahl ≥ 0/.test(r.fehler[3]), r.fehler[3]);
  assert.ok(/fehlt, obwohl bis 2026-09 abgerechnet/.test(r.fehler[4]), r.fehler[4]);
  assert.ok(/doppelt \(zuerst in Zeile 8\)/.test(r.fehler[5]), r.fehler[5]);
  assert.ok(/Personalnummer „300 07“ ist ungültig/.test(r.fehler[6]), r.fehler[6]);
  assert.ok(/Stunden im Zeitraum „1,2,3“/.test(r.fehler[7]), r.fehler[7]);
});

test("csvLesen: Zeilennummern zählen Umbrüche in Anführungszeichen mit; offene Anführungszeichen", () => {
  const r = M.csvLesen(KURZKOPF + ";Hinweis\n" +
    '10001;02.02.2026;2026-09;1,00;1,00;ja;"zwei\nZeilen"\n' +
    "10002;31.02.2026;2026-09;1,00;1,00;ja;\n");
  assert.deepStrictEqual(Object.keys(r.personen), ["10001"]);
  assert.strictEqual(r.fehler.length, 1);
  assert.ok(/^Zeile 4 /.test(r.fehler[0]), r.fehler[0]);
  const o = M.csvLesen(KURZKOPF + '\n10001;"02.02.2026;2026-09;1,00;1,00;ja\n');
  assert.ok(o.fehler.some((f) => /Zeile 2: Anführungszeichen/.test(f)), o.fehler.join(" | "));
  assert.deepStrictEqual(o.personen, {});
});

test("csvLesen: wirft nie – leere oder falsche Eingaben ergeben Fehlermeldungen", () => {
  [null, undefined, 42, {}].forEach((x) => {
    const r = M.csvLesen(x);
    assert.strictEqual(r.anzahl, 0);
    assert.strictEqual(r.fehler.length, 1);
  });
  ["", "﻿", "\r\n\r\n"].forEach((x) => assert.ok(/Kopfzeile/.test(M.csvLesen(x).fehler[0])));
  assert.deepStrictEqual(M.csvLesen(KURZKOPF + "\n\n").fehler, ["Keine Zeile mit Personalnummer gefunden."]);
});

// ---------------------------------------------------------------------
// wochenGrenzen und zusammenfassung
// ---------------------------------------------------------------------
const STAND = {
  stand: "2026-10-15",
  dateiname: "minijob_erfunden.csv",
  personen: {
    // Profil Minijob, eigener Satz 14 → 816 (Rechenbeispiel)
    10001: P,
    // Profil Minijob, ohne Stunden → Ersatzsatz = höchster Satz im Stand (10003: 3.000/150 = 20) → 571
    10002: mit(P, { stunden: 0 }),
    // Profil Teilzeit (Merkmal „ja“ zählt dann nicht) – liefert aber den höchsten Satz 20 €/h
    10003: { eintritt: "2026-03-01", austritt: null, abgerechnetBis: "2026-08", svBrutto: 3000, stunden: 150, minijobMerkmal: "ja" },
    // Profil Minijob, neu ohne Abrechnung → keine Grenze
    10004: { eintritt: "2026-10-05", austritt: null, abgerechnetBis: null, svBrutto: 0, stunden: 0, minijobMerkmal: "ja" },
    // ohne Profil, Merkmal „ja“: E 01.06.2026, B 28.02.2027, Grenze 7 · 603 + 2 · 633 = 5.487,00,
    // rest 3.987,00, A 01.10.2026, tage 151, satz 15 → floor(3.987 · 7/151 / 15 · 60) = floor(739,31) = 739
    10005: { eintritt: "2026-06-01", austritt: null, abgerechnetBis: "2026-09", svBrutto: 1500, stunden: 100, minijobMerkmal: "ja" },
    // ohne Profil, Merkmal „nein“ bzw. „?“ → kein Minijobber
    10006: { eintritt: "2026-05-01", austritt: null, abgerechnetBis: "2026-08", svBrutto: 1000, stunden: 80, minijobMerkmal: "nein" },
    10007: { eintritt: "2026-05-01", austritt: null, abgerechnetBis: "2026-08", svBrutto: 500, stunden: 40, minijobMerkmal: "?" },
    // Profil Minijob (Merkmal „nein“ zählt dann nicht), schon über der Grenze → 0
    10008: { eintritt: "2026-02-02", austritt: null, abgerechnetBis: "2026-09", svBrutto: 6000, stunden: 400, minijobMerkmal: "nein" }
  }
};
const PROFILE = {
  10001: { personalnummer: "10001", kategorie: "minijob", fahrgemeinschaft: null },
  10002: { personalnummer: "10002", kategorie: "minijob", fahrgemeinschaft: null },
  10003: { personalnummer: "10003", kategorie: "teilzeit", fahrgemeinschaft: null },
  10004: { personalnummer: "10004", kategorie: "minijob", fahrgemeinschaft: null },
  10008: { personalnummer: "10008", kategorie: "minijob", fahrgemeinschaft: null },
  10009: { personalnummer: "10009", kategorie: "minijob", fahrgemeinschaft: null } // nicht im Stand
};

test("wochenGrenzen: nur Minijobber laut Profil, sonst Minijob-Merkmal; ohne Grenze kein Eintrag", () => {
  assert.deepStrictEqual(M.wochenGrenzen(STAND, PROFILE), { 10001: 816, 10002: 571, 10005: 739, 10008: 0 });
});

test("wochenGrenzen: ohne Profile entscheidet das Merkmal; Profil ohne Kategorie wie fehlendes Profil", () => {
  // Merkmal „ja“: 10001, 10002, 10003 (Teilzeit-Profil fehlt jetzt), 10004 (ohne Grenze), 10005
  // 10003: E 01.03.2026, B 30.11.2026; Grenze Mär–Nov 9 · 603 = 5.427,00
  //   rest 2.427,00; A 01.09.2026, tage 30 + 31 + 30 = 91; satz 3.000/150 = 20
  //   → floor(2.427 · 7/91 / 20 · 60) = floor(560,08) = 560
  const erwartet = { 10001: 816, 10002: 571, 10003: 560, 10005: 739 };
  assert.deepStrictEqual(M.wochenGrenzen(STAND, null), erwartet);
  assert.deepStrictEqual(M.wochenGrenzen(STAND, {}), erwartet);
  const ohneKategorie = { 10006: { personalnummer: "10006", kategorie: "" }, 10007: { personalnummer: "10007", kategorie: null } };
  assert.deepStrictEqual(M.wochenGrenzen(STAND, ohneKategorie), erwartet);
  // Kategorie unabhängig von Groß-/Kleinschreibung
  assert.ok(Object.prototype.hasOwnProperty.call(M.wochenGrenzen(STAND, { 10006: { kategorie: "Minijob" } }), "10006"));
});

test("wochenGrenzen: Ersatzsatz ohne Stunden im ganzen Stand = 16 €/h; leerer Stand", () => {
  const s = { stand: "2026-10-15", personen: { 10002: mit(P, { stunden: 0 }) } };
  assert.deepStrictEqual(M.wochenGrenzen(s, { 10002: { kategorie: "minijob" } }), { 10002: 714 });
  assert.deepStrictEqual(M.wochenGrenzen(null, PROFILE), {});
  assert.deepStrictEqual(M.wochenGrenzen({ stand: "2026-10-15" }, PROFILE), {});
});

test("wochenGrenzen: kaputter Eintrag eines Minijobbers wirft mit Personalnummer", () => {
  const s = { personen: { 10001: mit(P, { eintritt: "2026-02-30" }) } };
  assert.throws(() => M.wochenGrenzen(s, PROFILE), /Personalnummer 10001: Eintritt/);
  // kein Minijobber → wird gar nicht gerechnet
  assert.deepStrictEqual(M.wochenGrenzen(s, { 10001: { kategorie: "teilzeit" } }), {});
});

test("zusammenfassung: Zählungen und häufigster Abrechnungsmonat", () => {
  assert.deepStrictEqual(M.zusammenfassung(STAND, PROFILE), {
    stand: "2026-10-15",
    abgerechnetBis: "2026-09",   // 4 × 2026-09 (10001, 10002, 10005, 10008) gegen 3 × 2026-08
    minijobberMitGrenze: 4,      // 10001, 10002, 10005, 10008
    ohneAbrechnung: 1,           // 10004
    ohneRestbudget: 1            // 10008
  });
  // Gleichstand: der spätere Monat
  const gleich = { personen: {
    20001: { abgerechnetBis: "2026-08", minijobMerkmal: "nein" },
    20002: { abgerechnetBis: "2026-09", minijobMerkmal: "nein" },
    20003: { abgerechnetBis: "2026-08", minijobMerkmal: "nein" },
    20004: { abgerechnetBis: "2026-09", minijobMerkmal: "nein" }
  } };
  assert.strictEqual(M.zusammenfassung(gleich, {}).abgerechnetBis, "2026-09");
  assert.deepStrictEqual(M.zusammenfassung(null, null),
    { stand: null, abgerechnetBis: null, minijobberMitGrenze: 0, ohneAbrechnung: 0, ohneRestbudget: 0 });
});

test("zusammenfassung: nimmt auch das Ergebnis von csvLesen (Upload-Vorschau, noch ohne Datum)", () => {
  const r = M.csvLesen(KOPF + "\n" + BEISPIEL + "\n10002;05.10.2026;;;;0;;;;;;;;ja;;\n10003;01.03.2026;;2026-03;2026-08;6;100,00;;;;;10,00;;nein;;\n");
  assert.deepStrictEqual(r.fehler, []);
  assert.deepStrictEqual(M.zusammenfassung(r, null),
    { stand: null, abgerechnetBis: "2026-09", minijobberMitGrenze: 1, ohneAbrechnung: 1, ohneRestbudget: 0 });
  assert.deepStrictEqual(M.wochenGrenzen(r, null), { 10001: 2318 });
});

for (const f of faelle) {
  try { f.fn(); bestanden++; console.log("ok   " + f.name); }
  catch (e) { console.error("FAIL " + f.name + "\n     " + e.message); process.exitCode = 1; }
}
console.log(bestanden + " von " + faelle.length + " Tests bestanden");
