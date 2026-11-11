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
  // Teil 5 (11.11.2026): Einsatzzeitraum kam dazu
  assert.deepStrictEqual(T.PROFIL_FELDER.slice().sort(), ["einsatz_bis", "einsatz_von", "fahrgemeinschaft", "kategorie", "name", "personalnummer"]);
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
    { v: 1, profile: [], zuordnung: {}, quelle: { dateiname: "", zeilen: 0, eingelesen_am: "" }, minijob: null });
});

// ---------- Minijob-Stand (Abschnitt minijob, seit 11.11.2026; erfundene Werte) ----------
const MINIJOB = {
  stand: "2026-11-05",
  dateiname: "minijob_stand_erfunden.csv",
  personen: {
    "10002": { eintritt: "2026-02-02", austritt: "2026-10-15", abgerechnetBis: "2026-09", svBrutto: 2950, stunden: 210.5, minijobMerkmal: "ja" },
    "10001": { eintritt: "2026-05-31", abgerechnetBis: "2026-10", svBrutto: 1200.25, stunden: 81, minijobMerkmal: "nein" },
    "10003": { eintritt: "2026-10-15", abgerechnetBis: null, svBrutto: null, stunden: null, minijobMerkmal: "?" }
  }
};

// Huelle wie von der bisherigen App-Version (Klartext OHNE minijob), direkt mit WebCrypto gebaut.
// aad entspricht aadBauen in tresor.js – aendert sich das, laden auch alte Tresore nicht mehr.
async function alteHuelle(key, salzB64, iter, klartext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const h = { v: 1, kdf: { name: "PBKDF2", hash: "SHA-256", iter: iter }, salt: salzB64, iv: T.b64(iv), ct: "",
    updated_at: "2026-11-10T08:00:00.000Z", by: "" };
  const aad = new TextEncoder().encode(["zig-tresor", "1", "PBKDF2", "SHA-256", String(iter), h.salt, h.iv, h.updated_at, ""].join("\n"));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv, additionalData: aad, tagLength: 128 }, key,
    new TextEncoder().encode(JSON.stringify(klartext)));
  h.ct = T.b64(new Uint8Array(ct));
  return h;
}

test("Minijob: Rundreise durch Ver- und Entschlüsselung, sortiert, ohne Klartext in der Hülle", async () => {
  const inhalt = T.inhaltBauen(PROFILE, ZUORDNUNG, QUELLE, null, MINIJOB);
  const m = inhalt.minijob;
  assert.strictEqual(m.stand, "2026-11-05");
  assert.strictEqual(m.dateiname, "minijob_stand_erfunden.csv");
  assert.deepStrictEqual(Object.keys(m.personen), ["10001", "10002", "10003"]);
  assert.deepStrictEqual(m.personen["10001"], { eintritt: "2026-05-31", austritt: null, abgerechnetBis: "2026-10",
    svBrutto: 1200.25, stunden: 81, minijobMerkmal: "nein" });
  // ohne Abrechnung: fehlende Zahlen werden 0
  assert.deepStrictEqual(m.personen["10003"], { eintritt: "2026-10-15", austritt: null, abgerechnetBis: null,
    svBrutto: 0, stunden: 0, minijobMerkmal: "?" });
  const salz = T.salzNeu();
  const key = await T.schluesselAbleiten(PW, salz, ITER);
  const h = await T.verschluesseln(key, T.b64(salz), ITER, inhalt);
  const text = JSON.stringify(h);
  assert.ok(!text.includes("svBrutto") && !text.includes("abgerechnetBis") && !text.includes("minijob_stand"), "Minijob-Klartext in der Hülle");
  const zurueck = await T.entschluesseln(key, h);
  assert.deepStrictEqual(zurueck, inhalt);
  // Austritt ueberlebt Speichern/Laden (sonst rechnete minijob.js still mit dem 9-Monats-Ende)
  assert.strictEqual(zurueck.minijob.personen["10002"].austritt, "2026-10-15");
  assert.deepStrictEqual(T.MINIJOB_FELDER, ["eintritt", "austritt", "abgerechnetBis", "svBrutto", "stunden", "minijobMerkmal"]);
  // Gegenprobe in tresorSchreiben vergleicht JSON-Texte: Normalisierung muss stabil sein
  assert.strictEqual(JSON.stringify(T.inhaltPruefen(JSON.parse(JSON.stringify(inhalt)))), JSON.stringify(inhalt));
  // Passwortwechsel (tresorSchreiben(tresor.inhalt, ...)) behält den Stand
  assert.deepStrictEqual(T.inhaltPruefen(zurueck).minijob, inhalt.minijob);
});

test("Minijob: Whitelist – fremde Felder und Namen fallen weg", () => {
  const roh = JSON.parse(JSON.stringify(MINIJOB));
  roh.name = "Mustermann Anna";
  roh.notiz = "erfunden";
  roh.personen["10002"].name = "Beispiel Ben";
  roh.personen["10002"].gesamtBrutto = 3120;
  roh.personen["10002"].hinweis = "Text aus der CSV";
  const m = T.inhaltBauen(PROFILE, {}, QUELLE, null, roh).minijob;
  assert.deepStrictEqual(Object.keys(m).sort(), ["dateiname", "personen", "stand"]);
  assert.deepStrictEqual(Object.keys(m.personen["10002"]).sort(), T.MINIJOB_FELDER.slice().sort());
  const t = JSON.stringify(m);
  assert.ok(!t.includes("Mustermann") && !t.includes("Beispiel") && !t.includes("3120") && !t.includes("Text aus"), "fremdes Feld im Stand: " + t);
  // Passwortfeld stoppt wie bei den Profilen
  const pw = JSON.parse(JSON.stringify(MINIJOB));
  pw.personen["10001"].Passwort = "Start-10001!";
  assert.throws(() => T.inhaltBauen(PROFILE, {}, QUELLE, null, pw), /Sicherheitsstopp/);
});

test("Minijob: ungültige Werte werden abgelehnt", () => {
  const mit = (pn, feld, wert) => {
    const m = JSON.parse(JSON.stringify(MINIJOB));
    m.personen[pn][feld] = wert;
    return m;
  };
  const bau = (m) => () => T.inhaltBauen(PROFILE, {}, QUELLE, null, m);
  [NaN, -1, Infinity, -Infinity, "2950,00", "12", true, {}].forEach((w) => {
    assert.throws(bau(mit("10002", "svBrutto", w)), /SV-Brutto/, "svBrutto " + String(w));
    assert.throws(bau(mit("10002", "stunden", w)), /Stunden/, "stunden " + String(w));
  });
  // mit Abrechnung muessen Betrag und Stunden da sein
  assert.throws(bau(mit("10002", "svBrutto", null)), /SV-Brutto/);
  assert.throws(bau(mit("10002", "stunden", undefined)), /Stunden/);
  ["02.02.2026", "2026-02-30", "2026-2-2", 20260202].forEach((w) => {
    assert.throws(bau(mit("10002", "eintritt", w)), /Eintritt/, "eintritt " + w);
    assert.throws(bau(mit("10002", "austritt", w)), /Austritt/, "austritt " + w);
  });
  ["2026-13", "2026-9", "09/2026", "2026-09-30"].forEach((w) => {
    assert.throws(bau(mit("10002", "abgerechnetBis", w)), /abgerechnet bis/, "abgerechnetBis " + w);
  });
  ["vielleicht", "Ja", 1].forEach((w) => {
    assert.throws(bau(mit("10002", "minijobMerkmal", w)), /Minijob-Merkmal/, "merkmal " + w);
  });
  // Personalnummer: Muster wie beim Server (keine Leerzeichen, also auch keine "Vorname Nachname")
  const pnFalsch = JSON.parse(JSON.stringify(MINIJOB));
  pnFalsch.personen["Anna Mustermann"] = pnFalsch.personen["10001"];
  assert.throws(bau(pnFalsch), /ungültige Personalnummer/);
  const proto = JSON.parse('{"stand":"2026-11-05","personen":{"__proto__":{"eintritt":null,"abgerechnetBis":null,"minijobMerkmal":"?"}}}');
  assert.throws(bau(proto), /ungültige Personalnummer/);
  // Kopf: Datum, Personen
  assert.throws(bau(Object.assign({}, MINIJOB, { stand: "05.11.2026" })), /gültiges Datum/);
  assert.throws(bau(Object.assign({}, MINIJOB, { stand: undefined })), /gültiges Datum/);
  assert.throws(bau(Object.assign({}, MINIJOB, { personen: [] })), /Personen/);
  assert.throws(bau("Stand"), /kein Objekt/);
  assert.throws(bau(Object.assign({}, MINIJOB, { personen: { "10001": null } })), /kein Objekt/);
  // gueltige Grenzfaelle
  assert.strictEqual(T.inhaltBauen(PROFILE, {}, QUELLE, null, mit("10002", "svBrutto", 0)).minijob.personen["10002"].svBrutto, 0);
  assert.strictEqual(T.inhaltBauen(PROFILE, {}, QUELLE, null, mit("10002", "austritt", "2026-12-31")).minijob.personen["10002"].austritt, "2026-12-31");
  assert.strictEqual(T.inhaltBauen(PROFILE, {}, QUELLE, null, mit("10002", "minijobMerkmal", null)).minijob.personen["10002"].minijobMerkmal, "?");
  assert.deepStrictEqual(T.inhaltBauen(PROFILE, {}, QUELLE, null, Object.assign({}, MINIJOB, { personen: {} })).minijob.personen, {});
  // dieselbe Pruefung steht fuer die Upload-Vorschau einzeln zur Verfuegung
  assert.strictEqual(T.minijobPruefen(null), null);
  assert.throws(() => T.minijobPruefen(mit("10001", "svBrutto", -5)), /SV-Brutto/);
});

test("Minijob: alter Tresor-Inhalt ohne Abschnitt lädt weiter (minijob = null)", async () => {
  const alt = { v: 1, profile: PROFILE, zuordnung: { "anna mustermann": "10001" }, quelle: QUELLE }; // ohne minijob, wie bis 11.11.2026
  const geladen = T.inhaltPruefen(alt);
  assert.strictEqual(geladen.minijob, null);
  assert.strictEqual(geladen.profile.length, 2);
  // echter Weg: alte Huelle entschluesseln
  const salz = T.salzNeu();
  const key = await T.schluesselAbleiten(PW, salz, ITER);
  const h = await alteHuelle(key, T.b64(salz), ITER, alt);
  const zurueck = await T.entschluesseln(key, h);
  assert.strictEqual(zurueck.minijob, null);
  assert.deepStrictEqual(zurueck.zuordnung, { "anna mustermann": "10001" });
  assert.strictEqual(zurueck.profile[0].name, "Mustermann Anna");
});

test("Minijob: Stammlisten-Upload und Zuordnung behalten den Stand, Einspielen behält Namen", () => {
  const vorher = T.inhaltBauen(PROFILE, ZUORDNUNG, QUELLE, null, MINIJOB);
  // Stammliste neu (wie index.html: vorhandenen Stand als 5. Argument durchreichen)
  const neueProfile = [PROFILE[1], { personalnummer: "10009", name: "Neu Nina", kategorie: "minijob", fahrgemeinschaft: null }];
  const nachStamm = T.inhaltBauen(neueProfile, vorher.zuordnung, { dateiname: "stamm2.xlsx", zeilen: 2, eingelesen_am: "" }, [], vorher.minijob);
  assert.deepStrictEqual(nachStamm.minijob, vorher.minijob);
  // Zuordnung speichern (zuordnungSpeichern)
  const nachZu = T.inhaltBauen(vorher.profile, Object.assign({}, vorher.zuordnung, { "ben beispiel": "10002" }), vorher.quelle, null, vorher.minijob);
  assert.deepStrictEqual(nachZu.minijob, vorher.minijob);
  // Minijob-Stand einspielen: Namen, Zuordnung und Quelle bleiben
  const neuStand = Object.assign({}, MINIJOB, { stand: "2026-12-04", personen: { "10002": MINIJOB.personen["10002"] } });
  const nachMj = T.inhaltBauen(vorher.profile, vorher.zuordnung, vorher.quelle, null, neuStand);
  assert.deepStrictEqual(nachMj.profile, vorher.profile);
  assert.deepStrictEqual(nachMj.zuordnung, vorher.zuordnung);
  assert.deepStrictEqual(nachMj.quelle, vorher.quelle);
  assert.strictEqual(nachMj.minijob.stand, "2026-12-04");
  assert.deepStrictEqual(Object.keys(nachMj.minijob.personen), ["10002"]);
  // ohne 5. Argument ist der Stand weg – genau das darf index.html nie tun
  assert.strictEqual(T.inhaltBauen(vorher.profile, vorher.zuordnung, vorher.quelle).minijob, null);
});

// ---------- Einsatzzeitraum (Profilfelder einsatz_von/einsatz_bis, seit Teil 5; erfundene Werte) ----------
test("Einsatzzeitraum: gültig, fehlend und leer; Rundreise durch die Verschlüsselung", async () => {
  const mitEinsatz = [
    Object.assign({}, PROFILE[0], { einsatz_von: "2026-02-09", einsatz_bis: "2026-11-08" }),
    Object.assign({}, PROFILE[1], { einsatz_von: "", einsatz_bis: null })   // leer und null = kein Datum
  ];
  const inhalt = T.inhaltBauen(mitEinsatz, {}, QUELLE);
  assert.strictEqual(inhalt.profile[0].einsatz_von, "2026-02-09");
  assert.strictEqual(inhalt.profile[0].einsatz_bis, "2026-11-08");
  assert.strictEqual(inhalt.profile[1].einsatz_von, null);
  assert.strictEqual(inhalt.profile[1].einsatz_bis, null);
  // fehlende Felder (Profil wie bis Teil 4) → null
  const ohne = T.inhaltBauen([{ personalnummer: "10003", name: "Fiktiv Frida", kategorie: "minijob", fahrgemeinschaft: null }], {}, QUELLE);
  assert.deepStrictEqual(ohne.profile[0], { personalnummer: "10003", name: "Fiktiv Frida", kategorie: "minijob", fahrgemeinschaft: null,
    einsatz_von: null, einsatz_bis: null });
  // Reihenfolge der Felder stabil (Gegenprobe in tresorSchreiben vergleicht JSON-Texte)
  assert.deepStrictEqual(Object.keys(inhalt.profile[0]), T.PROFIL_FELDER);
  assert.strictEqual(JSON.stringify(T.inhaltPruefen(JSON.parse(JSON.stringify(inhalt)))), JSON.stringify(inhalt));
  const salz = T.salzNeu();
  const key = await T.schluesselAbleiten(PW, salz, ITER);
  const h = await T.verschluesseln(key, T.b64(salz), ITER, inhalt);
  assert.ok(!JSON.stringify(h).includes("2026-02-09"), "Einsatzdatum im Klartext der Hülle");
  assert.deepStrictEqual(await T.entschluesseln(key, h), inhalt);
});

test("Einsatzzeitraum: ungültige Werte werden abgelehnt", () => {
  const bau = (feld, wert) => () => T.inhaltBauen([Object.assign({}, PROFILE[0], { [feld]: wert })], {}, QUELLE);
  ["09.02.2026", "2026-02-30", "2026-2-9", "2026-13-01", 20260209, 46062, true, {}, "  "].forEach((w) => {
    assert.throws(bau("einsatz_von", w), /Profil 10001: Einsatz von ist kein gültiges Datum/, "einsatz_von " + JSON.stringify(w));
    assert.throws(bau("einsatz_bis", w), /Profil 10001: Einsatz bis ist kein gültiges Datum/, "einsatz_bis " + JSON.stringify(w));
  });
  // Grenzfaelle: Schalttag gueltig, 29.02. im Nicht-Schaltjahr nicht
  assert.strictEqual(T.inhaltBauen([Object.assign({}, PROFILE[0], { einsatz_bis: "2028-02-29" })], {}, QUELLE).profile[0].einsatz_bis, "2028-02-29");
  assert.throws(bau("einsatz_bis", "2027-02-29"), /Einsatz bis/);
});

test("Einsatzzeitraum: alter Tresor-Inhalt ohne die Felder lädt weiter (null)", async () => {
  // Klartext wie bis Teil 4: Profile mit vier Feldern, mit Minijob-Stand
  const alt = { v: 1, profile: [{ personalnummer: "10001", name: "Mustermann Anna", kategorie: "teilzeit", fahrgemeinschaft: "G1" }],
    zuordnung: { "anna mustermann": "10001" }, quelle: QUELLE, minijob: MINIJOB };
  const salz = T.salzNeu();
  const key = await T.schluesselAbleiten(PW, salz, ITER);
  const zurueck = await T.entschluesseln(key, await alteHuelle(key, T.b64(salz), ITER, alt));
  assert.deepStrictEqual(zurueck.profile[0], { personalnummer: "10001", name: "Mustermann Anna", kategorie: "teilzeit", fahrgemeinschaft: "G1",
    einsatz_von: null, einsatz_bis: null });
  assert.deepStrictEqual(Object.keys(zurueck.minijob.personen), ["10001", "10002", "10003"]);
  assert.deepStrictEqual(zurueck.zuordnung, { "anna mustermann": "10001" });
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
