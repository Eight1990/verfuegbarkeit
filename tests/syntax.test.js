"use strict";
// Aufruf: node tests/syntax.test.js
// Prueft, ob alle Inline-Skripte in index.html und die Modul-Dateien
// syntaktisch gueltig sind (ohne sie auszufuehren). Schnelle Sicherung
// waehrend groesserer Umbauten an der einen HTML-Datei.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
let fehler = 0;

function pruefe(name, code, versatz) {
  try {
    new vm.Script(code, { filename: name });
    console.log("ok   " + name);
  } catch (e) {
    fehler++;
    const m = /:(\d+)$/.exec((e.stack || "").split("\n")[0] || "");
    const zeile = m ? Number(m[1]) + (versatz || 0) : "?";
    console.error("FAIL " + name + " (Zeile " + zeile + "): " + e.message);
  }
}

const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const re = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g;
let m, nr = 0;
while ((m = re.exec(html)) !== null) {
  nr++;
  const vorher = html.slice(0, m.index + m[0].indexOf(">") + 1);
  const zeilenVorher = vorher.split("\n").length - 1;
  pruefe("index.html <script> Nr. " + nr, m[1], zeilenVorher);
}
["tresor.js", "planung-solver.js", "dispo-export.js", "minijob.js", "tests/vorschau.js", "tests/synthetisch.js"].forEach((f) => {
  pruefe(f, fs.readFileSync(path.join(root, f), "utf8"), 0);
});
if (fehler) { console.error(fehler + " Datei(en) mit Syntaxfehler"); process.exitCode = 1; }
else console.log("Alle Skripte syntaktisch in Ordnung");
