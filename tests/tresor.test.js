"use strict";
// Aufruf: node tests/tresor.test.js   (nur erfundene Daten, keine echten Namen)
const assert = require("assert");
const T = require("../tresor.js");

const ITER = 100000; // Untergrenze des Moduls; im Browser gelten 600 000
let bestanden = 0;
const faelle = [];
function test(name, fn) { faelle.push({ name, fn }); }
async function erwarteFehler(fn, muster) {
  let fehler = null;
  try { await fn(); } catch (e) { fehler = e; }
  assert.ok(fehler, "es wurde kein Fehler geworfen");
  if (muster) assert.ok(muster.test(fehler.message), "falsche Meldung: " + fehler.message);
  return fehler;
}

const PROFILE = [
  { personalnummer: "10001", name: "Mustermann Anna", kategorie: "teilzeit", nur_schicht: null,
    gesperrte_tage: [3, 1], max_schichten_woche: 4, fahrgemeinschaft: "G1", schnitt_h: 24.5, notiz: "erfunden" },
  { personalnummer: "10002", name: "Beispiel Ben", kategorie: "minijob", nur_schicht: "FRUEH",
    gesperrte_tage: [], max_schichten_woche: null, fahrgemeinschaft: null, schnitt_h: null, notiz: null }
];
const ZUORDNUNG = { "anna mustermann": "10001", "fremd name": "99999" };
const QUELLE = { dateiname: "stamm.xlsx", zeilen: 2, eingelesen_am: "2026-11-10T08:00:00.000Z" };
const PW = "Vier Wörter sind ein Satz";

test("salzNeu liefert 16 zufällige Bytes", () => {
  const a = T.salzNeu(), b = T.salzNeu();
  assert.strictEqual(a.length, 16);
  assert.notStrictEqual(T.b64(a), T.b64(b));
});

test("passwortPruefen: kurz und einförmig abgelehnt, Satz erlaubt", () => {
  assert.ok(/mindestens 12/.test(T.passwortPruefen("kurz")));
  assert.ok(/einförmig/.test(T.passwortPruefen("aaaaaaaaaaaaaaaa")));
  assert.strictEqual(T.passwortPruefen(PW), null);
  assert.strictEqual(T.passwortPruefen("  " + PW + "  "), null);
});

test("inhaltBauen: Whitelist, Passwortfeld stoppt, fremde Zuordnung fällt weg", () => {
  const inhalt = T.inhaltBauen(PROFILE.map((p) => Object.assign({ extra: "x" }, p)), ZUORDNUNG, QUELLE);
  assert.deepStrictEqual(Object.keys(inhalt.profile[0]).sort(), T.PROFIL_FELDER.slice().sort());
  assert.deepStrictEqual(T.PROFIL_FELDER.slice().sort(), ["fahrgemeinschaft", "kategorie", "name", "personalnummer"]);
  // Alte Profilfelder (bis 10.11.2026) fallen still weg
  ["nur_schicht", "gesperrte_tage", "max_schichten_woche", "schnitt_h", "notiz"].forEach((f) => {
    assert.ok(!(f in inhalt.profile[0]) && !(f in inhalt.profile[1]), "altes Feld " + f + " noch da");
  });
  assert.strictEqual(inhalt.profile[0].fahrgemeinschaft, "G1");
  assert.deepStrictEqual(inhalt.zuordnung, { "anna mustermann": "10001" });
  assert.strictEqual(inhalt.quelle.dateiname, "stamm.xlsx");
  assert.ok(!JSON.stringify(inhalt).includes("extra"));
  assert.throws(() => T.inhaltBauen([Object.assign({ passwort: "geheim" }, PROFILE[0])]), /Sicherheitsstopp/);
  assert.throws(() => T.inhaltBauen([Object.assign({ Passwort: "geheim" }, PROFILE[0])]), /Sicherheitsstopp/);
  assert.throws(() => T.inhaltBauen([PROFILE[0], PROFILE[0]]), /mehrfach/);
  assert.throws(() => T.inhaltBauen([{ personalnummer: "1", name: "" }]), /keinen Namen/);
  assert.throws(() => T.inhaltBauen("nix"), /Profile fehlen/);
});

test("Verschlüsseln und Entschlüsseln: Rundreise, Hülle ohne Klartext", async () => {
  const salz = T.salzNeu();
  const key = await T.schluesselAbleiten(PW, salz, ITER);
  assert.strictEqual(key.extractable, false);
  const inhalt = T.inhaltBauen(PROFILE, ZUORDNUNG, QUELLE);
  const h = await T.verschluesseln(key, T.b64(salz), ITER, inhalt, { updated_at: "2026-11-10T08:00:00.000Z", by: "admin-1" });
  assert.deepStrictEqual(Object.keys(h).sort(), ["by", "ct", "iv", "kdf", "salt", "updated_at", "v"]);
  const text = JSON.stringify(h);
  assert.ok(!text.includes("Mustermann") && !text.includes("10001") && !text.includes("erfunden"), "Klartext in der Hülle");
  const zurueck = await T.entschluesseln(key, h);
  assert.deepStrictEqual(zurueck, inhalt);
  // Kodierung fuer inhalt_base64
  const b = T.huelleKodieren(h);
  assert.ok(/^[A-Za-z0-9+/]+=*$/.test(b));
  assert.deepStrictEqual(T.huelleDekodieren(b), h);
  assert.ok(b.length < 4000, "Hülle für 2 Profile unerwartet groß: " + b.length);
});

test("Falsches Passwort und manipulierte Hülle werden abgelehnt", async () => {
  const salz = T.salzNeu();
  const key = await T.schluesselAbleiten(PW, salz, ITER);
  const h = await T.verschluesseln(key, T.b64(salz), ITER, T.inhaltBauen(PROFILE, {}, QUELLE));
  const falsch = await T.schluesselAbleiten(PW + "x", salz, ITER);
  await erwarteFehler(() => T.entschluesseln(falsch, h), /Passwort falsch/);
  // Chiffrat manipuliert
  const ct = T.vonB64(h.ct); ct[5] ^= 1;
  await erwarteFehler(() => T.entschluesseln(key, Object.assign({}, h, { ct: T.b64(ct) })), /Passwort falsch/);
  // Kopfdaten manipuliert (AAD): Runden, Zeitstempel, Autor
  await erwarteFehler(() => T.entschluesseln(key, Object.assign({}, h, { kdf: { name: "PBKDF2", hash: "SHA-256", iter: ITER + 1 } })), /Passwort falsch/);
  await erwarteFehler(() => T.entschluesseln(key, Object.assign({}, h, { updated_at: "2027-01-01T00:00:00.000Z" })), /Passwort falsch/);
  await erwarteFehler(() => T.entschluesseln(key, Object.assign({}, h, { by: "jemand" })), /Passwort falsch/);
});

test("huelleLesen: strenge Prüfung der Hülle", async () => {
  const salz = T.salzNeu();
  const key = await T.schluesselAbleiten(PW, salz, ITER);
  const h = await T.verschluesseln(key, T.b64(salz), ITER, T.inhaltBauen(PROFILE, {}, QUELLE));
  assert.throws(() => T.huelleLesen(Object.assign({ profile: [] }, h)), /unerwartete Felder/);
  assert.throws(() => T.huelleLesen(Object.assign({}, h, { v: 2 })), /Tresor-Format v2/);
  assert.throws(() => T.huelleLesen(Object.assign({}, h, { kdf: { name: "PBKDF2", hash: "SHA-256", iter: 50000 } })), /Schlüsselparameter/);
  assert.throws(() => T.huelleLesen(Object.assign({}, h, { salt: T.b64(new Uint8Array(8)) })), /Salz/);
  assert.throws(() => T.huelleLesen(Object.assign({}, h, { ct: "" })), /Chiffrat fehlt/);
  assert.throws(() => T.huelleLesen("kein json"), /kein gültiges JSON/);
  assert.throws(() => T.huelleLesen(Object.assign({}, h, { salt: "###" })), /Base64/);
  assert.deepStrictEqual(T.huelleLesen(JSON.stringify(h)), h);
});

test("Passwort-Normalisierung: NFC/NFD und Leerzeichen am Rand ergeben denselben Schlüssel", async () => {
  const salz = T.salzNeu();
  const nfd = PW.normalize("NFD");
  assert.notStrictEqual(nfd, PW);
  const k1 = await T.schluesselAbleiten(PW, salz, ITER);
  const k2 = await T.schluesselAbleiten("  " + nfd + "\n", salz, ITER);
  const h = await T.verschluesseln(k1, T.b64(salz), ITER, T.inhaltBauen(PROFILE, {}, QUELLE));
  const zurueck = await T.entschluesseln(k2, h);
  assert.strictEqual(zurueck.profile.length, 2);
});

test("inhaltPruefen lehnt fremde Versionen und kaputte Inhalte ab", () => {
  assert.throws(() => T.inhaltPruefen({ v: 2, profile: [] }), /Tresor-Inhalt v2/);
  assert.throws(() => T.inhaltPruefen(null), /Inhalt fehlt/);
  assert.throws(() => T.inhaltPruefen({ v: 1, profile: "x" }), /Profile fehlen/);
  assert.deepStrictEqual(T.inhaltPruefen({ v: 1, profile: [] }),
    { v: 1, profile: [], zuordnung: {}, quelle: { dateiname: "", zeilen: 0, eingelesen_am: "" } });
});

test("Größe: 45 Profile bleiben klein", async () => {
  const viele = [];
  for (let i = 0; i < 45; i++) {
    viele.push({ personalnummer: String(10000 + i), name: "Erfunden Person" + i + " " + "x".repeat(40), kategorie: "minijob",
      fahrgemeinschaft: "FG" + (i % 10) });
  }
  const salz = T.salzNeu();
  const key = await T.schluesselAbleiten(PW, salz, ITER);
  const h = await T.verschluesseln(key, T.b64(salz), ITER, T.inhaltBauen(viele, {}, QUELLE));
  assert.ok(T.huelleKodieren(h).length < 30000);
});

test("inhaltBauen: Profilwert gleich Passwort stoppt", () => {
  // Traeger ist die Fahrgemeinschaft (Freitext) ...
  const p = Object.assign({}, PROFILE[0], { fahrgemeinschaft: "Start-10001!" });
  assert.throws(() => T.inhaltBauen([p], {}, QUELLE, ["Start-10001!"]), /Sicherheitsstopp/);
  assert.throws(() => T.inhaltBauen([p], {}, QUELLE, new Set(["Start-10001!"])), /Sicherheitsstopp/);
  assert.strictEqual(T.inhaltBauen([p], {}, QUELLE).profile[0].fahrgemeinschaft, "Start-10001!");
  assert.strictEqual(T.inhaltBauen([p], {}, QUELLE, ["anderes"]).profile.length, 1);
  // ... Teilstring stoppt ebenfalls, auch im Namen; Personalnummer gleich Passwort ist erlaubt
  const q = Object.assign({}, PROFILE[0], { fahrgemeinschaft: "PW: Start-10001! merken" });
  assert.throws(() => T.inhaltBauen([q], {}, QUELLE, ["Start-10001!"]), /Sicherheitsstopp/);
  const n = Object.assign({}, PROFILE[0], { name: "Mustermann Start-10001!" });
  assert.throws(() => T.inhaltBauen([n], {}, QUELLE, ["Start-10001!"]), /Sicherheitsstopp/);
  const r = Object.assign({}, PROFILE[0], { personalnummer: "1000123", fahrgemeinschaft: null });
  assert.strictEqual(T.inhaltBauen([r], {}, QUELLE, ["1000123"]).profile[0].personalnummer, "1000123");
  // Eine alte Notiz mit Passwort wird gar nicht mehr gespeichert (kein Leck, kein Abbruch)
  const alt = Object.assign({}, PROFILE[0], { notiz: "Start-10001!" });
  assert.ok(!JSON.stringify(T.inhaltBauen([alt], {}, QUELLE, ["Start-10001!"])).includes("Start-"));
});

test("Leck-Test mit erfundener Stammliste: Passwort-Marker nie in Hülle oder Klartext", async () => {
  const S = require("./synthetisch.js");
  const zeilen = S.stammliste(S.exportJson("2026-10-19"));
  const idx = (n) => zeilen[0].indexOf(n);
  assert.ok(idx("Fahrgemeinschaft") >= 0 && idx("Passwort") >= 0, "Testliste ohne Fahrgemeinschaft/Passwort – Test liefe ins Leere");
  const profile = zeilen.slice(1).map((z) => ({ personalnummer: String(z[idx("Personalnummer")]), name: z[idx("Name")],
    kategorie: String(z[idx("Kategorie")]).toLowerCase(), fahrgemeinschaft: z[idx("Fahrgemeinschaft")] || null }));
  assert.ok(profile.some((p) => p.fahrgemeinschaft), "keine Fahrgemeinschaft in der Testliste");
  const passwoerter = zeilen.slice(1).map((z) => z[idx("Passwort")]);
  const inhalt = T.inhaltBauen(profile, {}, QUELLE, passwoerter);
  const salz = T.salzNeu();
  const key = await T.schluesselAbleiten(PW, salz, ITER);
  const h = await T.verschluesseln(key, T.b64(salz), ITER, inhalt);
  assert.ok(!JSON.stringify(h).includes("Start-") && !JSON.stringify(inhalt).includes("Start-"), "Passwort-Marker gefunden");
  assert.ok(!JSON.stringify(h).includes("Mustermann"), "Name in der Hülle");
  assert.strictEqual(inhalt.profile.length, 32);
});

(async () => {
  for (const f of faelle) {
    try { await f.fn(); bestanden++; console.log("ok   " + f.name); }
    catch (e) { console.error("FAIL " + f.name + "\n     " + e.message); process.exitCode = 1; }
  }
  console.log(bestanden + " von " + faelle.length + " Tests bestanden");
})();
