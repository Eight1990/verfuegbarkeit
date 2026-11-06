"use strict";
// Aufruf: node tests/dispo-export.test.js
// Benoetigt Testdaten/Dispo_Aktuell_Neues_Format.xlsm (enthaelt echte Namen,
// liegt nie im Repository). Fehlt die Datei, wird uebersprungen. Es werden
// keine Namen aus der Vorlage ausgegeben.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const JSZip = require("../vendor/jszip-3.10.1.min.js");
const D = require("../dispo-export.js");

const vorlagePfad = path.join(__dirname, "..", "Testdaten", "Dispo_Aktuell_Neues_Format.xlsm");
if (!fs.existsSync(vorlagePfad)) {
  console.log("Vorlage nicht vorhanden - Test uebersprungen.");
  process.exit(0);
}
const vorlage = fs.readFileSync(vorlagePfad);

const tage = ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"];
const eintraege = [];
tage.forEach((d, i) => {
  for (let n = 1; n <= (i === 0 ? 9 : 6); n++) {
    eintraege.push({ datum: d, art: "AM", nr: n, name: "Test Person " + (i * 20 + n),
      beginn: i === 0 ? "04:00" : "05:30", ende: i === 0 ? "07:00" : "08:30",
      alternativen: ["Alt Eins", "Alt Zwei"] });
  }
  for (let n = 1; n <= 10; n++) {
    eintraege.push({ datum: d, art: "PM", nr: n, name: "Test Spaet " + (i * 20 + n),
      beginn: "18:30", ende: "22:30", alternativen: [] });
  }
});
eintraege.push({ datum: tage[0], art: "AM", nr: 15, name: "Zu viel" });

(async () => {
  const r = await D.fuelleVorlage(JSZip, vorlage, { tage, eintraege });
  assert.strictEqual(r.bloecke, 5, "5 Tagesbloecke erwartet");
  assert.strictEqual(r.belegt, 9 + 4 * 6 + 50, "belegte Plaetze");
  assert.deepStrictEqual(r.nichtUntergebracht, ["2026-10-19 AM 15"]);

  const a = await JSZip.loadAsync(vorlage), b = await JSZip.loadAsync(r.bytes);
  // Makro und alles ausser Blatt FedEx + workbook.xml bleibt bytegleich
  for (const name of Object.keys(a.files)) {
    if (a.files[name].dir) continue;
    if (name === "xl/worksheets/sheet1.xml" || name === "xl/workbook.xml") continue;
    const x = Buffer.from(await a.file(name).async("uint8array"));
    const y = Buffer.from(await b.file(name).async("uint8array"));
    assert.ok(x.equals(y), name + " wurde veraendert");
  }
  const mappe = await b.file("xl/workbook.xml").async("string");
  assert.ok(/fullCalcOnLoad="1"/.test(mappe), "Neuberechnung beim Oeffnen gesetzt");

  const xml = await b.file("xl/worksheets/sheet1.xml").async("string");
  assert.ok(/Test Person 1</.test(xml));
  assert.ok(/Alt Eins, Alt Zwei/.test(xml), "Alternativen in Spalte J");
  const serie = D.serieAusIso("2026-10-19");
  assert.ok(new RegExp("<v>" + serie + "</v>").test(xml), "Datum der Woche gesetzt");

  // Formel-Zellen bleiben Formeln
  const formelnVorher = (await a.file("xl/worksheets/sheet1.xml").async("string")).match(/<f\b/g).length;
  const formelnNachher = xml.match(/<f\b/g).length;
  assert.strictEqual(formelnNachher, formelnVorher, "Formeln unveraendert");

  console.log("dispo-export: alle Pruefungen bestanden");
})().catch((e) => { console.error("FAIL " + e.message); process.exit(1); });
