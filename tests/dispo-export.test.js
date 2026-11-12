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

const tage = ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"];

/*
 * Teil 1: Datei fuer FedEx (fedexDatei) mit einer kuenstlichen Mini-Vorlage, die hier gebaut wird.
 * Aufbau wie die echte Vorlage, nur kleiner: je Tag 9 Zeilen (Wochentag, Datum, AM 1-2, PM 1-2,
 * Office, 2 Leerzeilen), Bloecke ab Zeile 3, 12, 21, 30, 39. Alle Namen sind erfunden.
 */
function miniVorlage() {
  const texte = ["FedEx", "ZiG AM 1", "ZiG AM 2", "ZiG PM 1", "ZiG PM 2", "ZiG Office", "Alt Rest"];
  const t = (ref, i, s) => '<c r="' + ref + '" s="' + (s || 1) + '" t="s"><v>' + i + "</v></c>";
  let zeilen = '<row r="1">' + t("A1", 0) + "</row>";
  let si = 0;
  for (let k = 0; k < 5; k++) {
    const r0 = 3 + k * 9;
    zeilen += '<row r="' + r0 + '"><c r="A' + r0 + '" s="1"><f>A' + (r0 + 1) + "</f><v>" + (46000 + k) + "</v></c></row>";
    zeilen += '<row r="' + (r0 + 1) + '"><c r="A' + (r0 + 1) + '" s="1">' +
      (k === 0 ? "" : "<f>A" + (r0 - 8) + "+1</f>") + "<v>" + (46000 + k) + "</v></c></row>";
    [1, 2, 3, 4, 5].forEach((nr, j) => {
      const z = r0 + 2 + j;
      const formelE = k === 0 && j < 2 ? "(D" + z + "-C" + z + ")*24" : "D" + z + "-C" + z;
      // erste Zeile jeder Gruppe traegt die geteilte Formel, die zweite verweist nur darauf
      let e;
      if (j === 0 || j === 2) { si++; e = '<f t="shared" ref="E' + z + ":E" + (z + 1) + '" si="' + si + '">' + formelE + "</f>"; }
      else if (j === 1 || j === 3) e = '<f t="shared" si="' + si + '"/>';
      else e = "<f>" + formelE + "</f>";
      zeilen += '<row r="' + z + '" ht="18" customHeight="1">' + t("A" + z, nr) +
        '<c r="B' + z + '" s="1" t="s"><v>6</v></c><c r="C' + z + '" s="2"><v>0.5</v></c><c r="D' + z + '" s="2"><v>0.75</v></c>' +
        '<c r="E' + z + '" s="2">' + e + "<v>9</v></c>" +
        '<c r="H' + z + '" s="2"><f>G' + z + "-F" + z + "</f><v>0</v></c>" +
        '<c r="I' + z + '" s="1"><f>E' + z + "*2</f><v>1</v></c>" +
        '<c r="J' + z + '" s="1" t="s"><v>6</v></c></row>';
    });
  }
  const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const zip = new JSZip();
  zip.file("xl/workbook.xml", '<workbook xmlns="' + NS + '"><sheets><sheet name="FedEx" sheetId="1"/></sheets><calcPr calcId="1"/></workbook>');
  zip.file("xl/sharedStrings.xml", '<sst xmlns="' + NS + '">' + texte.map((x) => "<si><t>" + x + "</t></si>").join("") + "</sst>");
  zip.file("xl/worksheets/sheet1.xml", '<worksheet xmlns="' + NS + '"><cols><col min="1" max="8" width="12" style="1"/></cols>' +
    "<sheetData>" + zeilen + '</sheetData><mergeCells count="1"><mergeCell ref="C60:D60"/></mergeCells></worksheet>');
  zip.file("xl/styles.xml", '<styleSheet xmlns="' + NS + '"><numFmts count="1"><numFmt numFmtId="165" formatCode="h:mm;@"/></numFmts>' +
    '<fonts count="1"><font><sz val="10"/><name val="Arial"/></font></fonts>' +
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="1"/>' +
    '<xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="1" applyNumberFormat="1"/></cellXfs>' +
    '<cellStyles count="2"><cellStyle name="Standard" xfId="0" builtinId="0"/><cellStyle name="Ballast" xfId="1"/></cellStyles>' +
    '<dxfs count="1"><dxf><font><b/></font></dxf></dxfs></styleSheet>');
  zip.file("xl/vbaProject.bin", "makro");
  return zip.generateAsync({ type: "uint8array" });
}

async function fedexTest() {
  const plan = { tage, eintraege: [] };
  tage.forEach((d, i) => {
    [1, 2].forEach((n) => plan.eintraege.push({ datum: d, art: "AM", nr: n, name: "Test Frueh " + (i * 10 + n),
      beginn: i === 0 ? "04:00" : "05:30", ende: i === 0 ? "07:00" : "08:30", alternativen: ["Alt Eins"] }));
    plan.eintraege.push({ datum: d, art: "PM", nr: 1, name: i === 4 ? "=1+1" : "Test Spaet " + i,
      beginn: "18:30", ende: "22:30", alternativen: ["Alt Zwei"] });
  });
  plan.eintraege.push({ datum: tage[0], art: "AM", nr: 7, name: "Zu viel" });

  const r = await D.fedexDatei(JSZip, await miniVorlage(), plan, { kw: 43 });
  assert.strictEqual(r.bloecke, 5);
  assert.strictEqual(r.belegt, 15);
  assert.deepStrictEqual(r.nichtUntergebracht, ["2026-10-19 AM 7"]);

  const zip = await JSZip.loadAsync(r.bytes);
  const dateien = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();
  assert.deepStrictEqual(dateien, ["[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels",
    "xl/styles.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml"], "nur die Teile einer einfachen Mappe, kein Makro");
  const mappe = await zip.file("xl/workbook.xml").async("string");
  assert.ok(/<sheet name="KW43" /.test(mappe), "Blattname KW43");
  assert.strictEqual((mappe.match(/<sheet\b/g) || []).length, 1, "genau ein Blatt");
  assert.ok(/fullCalcOnLoad="1"/.test(mappe));

  const xml = await zip.file("xl/worksheets/sheet1.xml").async("string");
  const zelle = (ref) => {
    const m = new RegExp('<c r="' + ref + '"[^>]*?(?:/>|>([\\s\\S]*?)</c>)').exec(xml);
    if (!m) return null;
    const f = /<f>([\s\S]*?)<\/f>/.exec(m[1] || ""), v = /<v>([\s\S]*?)<\/v>/.exec(m[1] || ""), tx = /<t[^>]*>([\s\S]*?)<\/t>/.exec(m[1] || "");
    return { f: f ? f[1] : null, v: v ? v[1] : null, text: tx ? tx[1] : null, roh: m[0] };
  };
  const serie = D.serieAusIso(tage[0]);
  // links: Montag bis Mittwoch unveraendert an ihrem Platz
  assert.strictEqual(zelle("A4").v, String(serie), "Montag-Datum");
  assert.strictEqual(zelle("A13").f, "A4+1");
  assert.strictEqual(zelle("B5").text, "Test Frueh 1");
  assert.strictEqual(zelle("B14").text, "Test Frueh 11");
  // rechts: Donnerstag ab Zeile 3, Freitag darunter, Formeln mitverschoben
  assert.strictEqual(zelle("J3").f, "J4");
  assert.strictEqual(zelle("J4").f, "A22+1", "Donnerstag haengt am Mittwoch links");
  assert.strictEqual(zelle("J4").v, String(serie + 3));
  assert.strictEqual(zelle("J13").f, "J4+1", "Freitag haengt am verschobenen Donnerstag");
  assert.strictEqual(zelle("J13").v, String(serie + 4));
  assert.strictEqual(zelle("K5").text, "Test Frueh 31");
  assert.strictEqual(zelle("N5").f, "M5-L5");
  assert.strictEqual(zelle("N6").f, "M6-L6", "geteilte Formel ausgeschrieben und verschoben");
  assert.strictEqual(zelle("Q5").f, "P5-O5");
  assert.strictEqual(zelle("A30"), null, "Donnerstag steht nicht mehr links");
  // Montag-Korrektur: Bis-Von statt (Bis-Von)*24, im Zeitformat
  assert.strictEqual(zelle("E5").f, "D5-C5");
  assert.strictEqual(zelle("E6").f, "D6-C6");
  assert.ok(Math.abs(parseFloat(zelle("E5").v) - 0.125) < 1e-9, "3 Stunden als Tagesbruchteil");
  const stile = await zip.file("xl/styles.xml").async("string");
  const xfs = stile.slice(stile.indexOf("<cellXfs"), stile.indexOf("</cellXfs>")).match(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g);
  const sE5 = +/ s="(\d+)"/.exec(zelle("E5").roh)[1];
  assert.ok(/numFmtId="165"/.test(xfs[sE5]), "Montag-Stunden im Zeitformat h:mm");
  assert.ok(/numFmtId="2"/.test(xfs[+/ s="(\d+)"/.exec(zelle("E7").roh)[1]]), "andere Zellen behalten ihren Stil");
  // Summenkasten: zwei Zeilen unter dem Freitag-Block (Freitag endet in Zeile 18)
  assert.strictEqual(zelle("L20").text, " Summe Geplant");
  assert.strictEqual(zelle("O20").text, "Summe Anwesend");
  assert.strictEqual(zelle("L21").text, "Mo");
  assert.strictEqual(zelle("M21").f, "SUM(E5:E9)");
  assert.strictEqual(zelle("M23").f, "SUM(E23:E27)");
  assert.strictEqual(zelle("M24").f, "SUM(N5:N9)");
  assert.strictEqual(zelle("M25").f, "SUM(N14:N18)");
  assert.strictEqual(zelle("P21").f, "SUM(H5:H9)");
  assert.strictEqual(zelle("L26").f, "SUM(M21:M25)");
  assert.strictEqual(zelle("O26").text, "ttl");
  // Mo: 2 x 3 h + 4 h; Summe als Tagesbruchteil
  assert.ok(Math.abs(parseFloat(zelle("M21").v) - 10 / 24) < 1e-9, "Montag-Summe 10 Stunden");
  assert.ok(Math.abs(parseFloat(zelle("L26").v) - 50 / 24) < 1e-9, "Wochensumme 50 Stunden");
  assert.ok(/<mergeCells count="3"><mergeCell ref="L20:N20"\/><mergeCell ref="O20:Q20"\/><mergeCell ref="L26:M26"\/>/.test(xml));
  // nichts Internes: keine Ersatzleute, keine Auswertungsspalte, Reste der alten Planung geleert
  assert.ok(!/Alt Eins|Alt Zwei|Alt Rest/.test(xml), "keine Ersatzleute und keine alten Namen");
  assert.ok(!/<c r="I\d+"/.test(xml), "Spalte I bleibt leer");
  assert.ok(!/t="s"/.test(xml), "keine geteilten Texte, alles inline");
  // Name, der wie eine Formel aussieht, bleibt reiner Text
  assert.ok(/t="inlineStr"><is><t xml:space="preserve">=1\+1<\/t>/.test(zelle("K16").roh), "Formel-Einschleusung verhindert");
  // Ballast der benannten Formatvorlagen ist weg, Zellstile zeigen auf den einen Standard
  assert.ok(/<cellStyles count="1">/.test(stile) && /<cellStyleXfs count="1">/.test(stile) && /<dxfs count="0"\/>/.test(stile));
  assert.ok(!/xfId="1"/.test(stile));
  assert.strictEqual(+/<cellXfs[^>]*count="(\d+)"/.exec(stile)[1], xfs.length, "Zaehler der Zellstile stimmt");
  // keine Zeilenhoehen aus der Vorlage
  assert.ok(!/<row [^>]*ht=/.test(xml));

  // 4 statt 5 Tagesbloecke: klare Fehlermeldung
  const kaputt = await JSZip.loadAsync(await miniVorlage());
  const b = await kaputt.file("xl/worksheets/sheet1.xml").async("string");
  kaputt.file("xl/worksheets/sheet1.xml", b.replace(/<row r="39">[\s\S]*?<\/sheetData>/, "</sheetData>"));
  await assert.rejects(D.fedexDatei(JSZip, await kaputt.generateAsync({ type: "uint8array" }), plan, { kw: 43 }),
    /genau 5/);

  // die Dispo-Datei (.xlsm) aus derselben Vorlage behaelt Makro und Ersatzleute
  const dispo = await JSZip.loadAsync((await D.fuelleVorlage(JSZip, await miniVorlage(), plan)).bytes);
  assert.ok(dispo.file("xl/vbaProject.bin"), "Makro bleibt in der Dispo-Datei");
  assert.ok(/Alt Eins/.test(await dispo.file("xl/worksheets/sheet1.xml").async("string")));
  console.log("dispo-export (FedEx-Datei): alle Pruefungen bestanden");
}

const vorlagePfad = path.join(__dirname, "..", "Testdaten", "Dispo_Aktuell_Neues_Format.xlsm");
const vorlage = fs.existsSync(vorlagePfad) ? fs.readFileSync(vorlagePfad) : null;

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
  await fedexTest();
  if (!vorlage) {
    console.log("Echte Vorlage nicht vorhanden - Teil 2 (Dispo-Datei mit echter Vorlage) uebersprungen.");
    return;
  }
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
