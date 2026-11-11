/*
 * tresor.js – Verschlüsselung des Stammlisten-Tresors (Klarnamen und Profile).
 *
 * Reine Kryptografie mit WebCrypto: kein DOM, kein Netzwerk. Läuft im Browser
 * (window.Tresor, nur im Admin-Bereich nachgeladen) und unter Node ≥ 20
 * (require) für die Tests.
 *
 * So funktioniert es:
 *   - Aus dem Tresor-Passwort wird mit PBKDF2-HMAC-SHA-256 (600 000 Runden,
 *     16 Byte Salz) ein AES-GCM-256-Schlüssel abgeleitet. Der Schlüssel ist
 *     nicht exportierbar und verlässt den Browser nie.
 *   - Der Klartext (Profile + gemerkte Dispo-Schreibweisen) wird mit AES-GCM
 *     verschlüsselt. Die Kopfdaten der Hülle (Version, KDF, Salz, IV,
 *     Zeitstempel, Autor) sind als Zusatzdaten (AAD) an das Chiffrat gebunden:
 *     wer sie in der Datenbank ändert, bekommt einen Prüffehler.
 *   - Der Server (Supabase) sieht nur die Hülle: Chiffrat plus Kopfdaten.
 *   - Passwörter aus der Excel können strukturell nicht in den Tresor gelangen:
 *     nur die aufgelisteten Profilfelder werden übernommen, und jedes Feld,
 *     dessen Name "pass" enthält, stoppt den Vorgang.
 *
 * Hülle (liegt base64-kodiert in app_dateien.inhalt_base64):
 *   { v: 1, kdf: { name: "PBKDF2", hash: "SHA-256", iter: 600000 },
 *     salt: <base64, 16 Byte>, iv: <base64, 12 Byte>, ct: <base64>,
 *     updated_at: <ISO-Zeit>, by: <Admin-Kennung oder ""> }
 * Klartext (nur entschlüsselt im Browser):
 *   { v: 1, profile: [ {personalnummer, name, kategorie, fahrgemeinschaft,
 *                       einsatz_von, einsatz_bis} ],
 *     zuordnung: { <Dispo-Schreibweise>: <personalnummer> },
 *     quelle: { dateiname, zeilen, eingelesen_am },
 *     minijob: null | { stand: "JJJJ-MM-TT", dateiname,
 *       personen: { <personalnummer>: { eintritt, austritt, abgerechnetBis,
 *                                      svBrutto, stunden, minijobMerkmal } } } }
 *   minijob (seit 11.11.2026, optional) ist der Minijob-Stand aus der monatlichen
 *   Lohnabrechnung (seit Teil 5 aus den Lohndaten-Spalten der Stammliste): keine
 *   Namen, nur diese Felder. Inhalte ohne minijob laden weiter (minijob = null).
 *   einsatz_von/einsatz_bis (seit Teil 5): Einsatzzeitraum laut Stammliste,
 *   "JJJJ-MM-TT" oder null; ältere Profile ohne die Felder laden mit null.
 *   VERSION bleibt 1.
 */
(function (wurzel, fabrik) {
  if (typeof module === "object" && module.exports) module.exports = fabrik(globalThis.crypto);
  else wurzel.Tresor = fabrik(wurzel.crypto);
})(typeof self !== "undefined" ? self : this, function (webcrypto) {
  "use strict";

  var VERSION = 1;
  var KENNUNG = "zig-tresor";
  var KDF = { name: "PBKDF2", hash: "SHA-256", iter: 600000 };
  var ITER_MIN = 100000;
  var ITER_MAX = 5000000;
  var SALZ_BYTES = 16;
  var IV_BYTES = 12;
  var PASSWORT_MIN = 12;
  var HUELLE_FELDER = ["v", "kdf", "salt", "iv", "ct", "updated_at", "by"];
  // Seit 11.11.2026 nur noch diese Felder. Aeltere Inhalte (mit nur_schicht, gesperrte_tage,
  // max_schichten_woche, schnitt_h, notiz) laden weiter; die alten Felder fallen dabei weg.
  // Teil 5: Einsatzzeitraum laut Stammliste (ISO-Tag oder null); fehlt er in alten Inhalten, gilt null.
  var PROFIL_FELDER = ["personalnummer", "name", "kategorie", "fahrgemeinschaft", "einsatz_von", "einsatz_bis"];
  // Minijob-Stand je Personalnummer (Whitelist; alles andere aus der CSV faellt weg)
  var MINIJOB_FELDER = ["eintritt", "austritt", "abgerechnetBis", "svBrutto", "stunden", "minijobMerkmal"];
  var MINIJOB_MERKMALE = ["ja", "nein", "?"];
  var PN_MUSTER = /^[A-Za-z0-9._-]{1,20}$/; // wie in supabase/functions/import-stammliste
  var FEHLER_PASSWORT = "Tresor-Passwort falsch oder Tresor beschädigt.";

  function subtle() {
    if (!webcrypto || !webcrypto.subtle) {
      throw new Error("Verschlüsselung ist in diesem Browser nicht verfügbar (WebCrypto fehlt, z. B. ohne HTTPS).");
    }
    return webcrypto.subtle;
  }

  // ---------- Bytes, Text, Base64 ----------
  function textZuBytes(text) { return new TextEncoder().encode(String(text)); }
  function bytesZuText(bytes) { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  function b64(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function vonB64(text) {
    if (typeof text !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) {
      throw new Error("Tresor beschädigt: ungültige Base64-Daten.");
    }
    var s = atob(text);
    var b = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    return b;
  }

  // ---------- Passwort ----------
  function passwortNormalisieren(pw) {
    return String(pw == null ? "" : pw).normalize("NFC").trim();
  }
  // Rueckgabe: null = in Ordnung, sonst die Meldung fuer den Bildschirm.
  function passwortPruefen(pw) {
    var p = passwortNormalisieren(pw);
    if (p.length < PASSWORT_MIN) {
      return "Das Tresor-Passwort braucht mindestens " + PASSWORT_MIN + " Zeichen – am besten ein Satz aus vier Wörtern.";
    }
    var zeichen = {};
    for (var i = 0; i < p.length; i++) zeichen[p[i]] = true;
    if (Object.keys(zeichen).length < 5) {
      return "Das Tresor-Passwort ist zu einförmig – bitte einen Satz aus mehreren Wörtern wählen.";
    }
    return null;
  }

  function salzNeu() {
    if (!webcrypto || !webcrypto.getRandomValues) throw new Error("Zufallszahlen sind in diesem Browser nicht verfügbar.");
    return webcrypto.getRandomValues(new Uint8Array(SALZ_BYTES));
  }

  function iterPruefen(iter) {
    if (!Number.isInteger(iter) || iter < ITER_MIN || iter > ITER_MAX) {
      throw new Error("Tresor beschädigt: ungültige Schlüsselparameter (" + iter + " Runden).");
    }
    return iter;
  }

  // Nicht exportierbarer AES-GCM-256-Schluessel aus Passwort + Salz.
  async function schluesselAbleiten(passwort, salz, iter) {
    var s = subtle();
    if (!(salz instanceof Uint8Array) || salz.length !== SALZ_BYTES) {
      throw new Error("Tresor beschädigt: Salz hat die falsche Länge.");
    }
    iterPruefen(iter);
    var basis = await s.importKey("raw", textZuBytes(passwortNormalisieren(passwort)), "PBKDF2", false, ["deriveKey"]);
    return s.deriveKey(
      { name: "PBKDF2", salt: salz, iterations: iter, hash: KDF.hash },
      basis, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }

  // ---------- Huelle ----------
  function aadBauen(h) {
    return textZuBytes([KENNUNG, String(h.v), h.kdf.name, h.kdf.hash, String(h.kdf.iter),
      h.salt, h.iv, h.updated_at, h.by || ""].join("\n"));
  }

  // Prueft eine Huelle (Objekt oder JSON-Text) streng und gibt eine saubere Kopie zurueck.
  function huelleLesen(eingabe) {
    var h = eingabe;
    if (typeof h === "string") {
      try { h = JSON.parse(h); } catch (_) { throw new Error("Tresor beschädigt: kein gültiges JSON."); }
    }
    if (!h || typeof h !== "object" || Array.isArray(h)) throw new Error("Tresor beschädigt: keine Hülle.");
    var fremd = Object.keys(h).filter(function (k) { return HUELLE_FELDER.indexOf(k) < 0; });
    if (fremd.length) throw new Error("Tresor beschädigt: unerwartete Felder (" + fremd.join(", ") + ").");
    if (h.v !== VERSION) {
      throw new Error("Tresor-Format v" + h.v + " wird von dieser App-Version nicht gelesen – bitte die Seite neu laden (Strg+F5).");
    }
    if (!h.kdf || typeof h.kdf !== "object" || h.kdf.name !== KDF.name || h.kdf.hash !== KDF.hash) {
      throw new Error("Tresor beschädigt: unbekanntes Schlüsselverfahren.");
    }
    iterPruefen(h.kdf.iter);
    if (vonB64(h.salt).length !== SALZ_BYTES) throw new Error("Tresor beschädigt: Salz hat die falsche Länge.");
    if (vonB64(h.iv).length !== IV_BYTES) throw new Error("Tresor beschädigt: IV hat die falsche Länge.");
    if (typeof h.ct !== "string" || vonB64(h.ct).length < 16) throw new Error("Tresor beschädigt: Chiffrat fehlt.");
    if (typeof h.updated_at !== "string" || isNaN(Date.parse(h.updated_at))) throw new Error("Tresor beschädigt: Zeitstempel fehlt.");
    if (h.by !== undefined && typeof h.by !== "string") throw new Error("Tresor beschädigt: Autor-Feld ungültig.");
    return {
      v: VERSION,
      kdf: { name: KDF.name, hash: KDF.hash, iter: h.kdf.iter },
      salt: h.salt, iv: h.iv, ct: h.ct,
      updated_at: h.updated_at,
      by: h.by || ""
    };
  }

  async function verschluesseln(schluessel, salzB64, iter, klartext, meta) {
    var inhalt = inhaltPruefen(klartext);
    if (vonB64(salzB64).length !== SALZ_BYTES) throw new Error("Tresor: Salz hat die falsche Länge.");
    var iv = webcrypto.getRandomValues(new Uint8Array(IV_BYTES));
    var h = {
      v: VERSION,
      kdf: { name: KDF.name, hash: KDF.hash, iter: iterPruefen(iter) },
      salt: salzB64,
      iv: b64(iv),
      ct: "",
      updated_at: (meta && meta.updated_at) || new Date().toISOString(),
      by: (meta && meta.by) || ""
    };
    var ct = await subtle().encrypt(
      { name: "AES-GCM", iv: iv, additionalData: aadBauen(h), tagLength: 128 },
      schluessel, textZuBytes(JSON.stringify(inhalt)));
    h.ct = b64(new Uint8Array(ct));
    return huelleLesen(h);
  }

  async function entschluesseln(schluessel, huelle) {
    var h = huelleLesen(huelle);
    var klar;
    try {
      klar = await subtle().decrypt(
        { name: "AES-GCM", iv: vonB64(h.iv), additionalData: aadBauen(h), tagLength: 128 },
        schluessel, vonB64(h.ct));
    } catch (_) {
      throw new Error(FEHLER_PASSWORT);
    }
    var obj;
    try { obj = JSON.parse(bytesZuText(new Uint8Array(klar))); }
    catch (_) { throw new Error("Tresor beschädigt: Inhalt ist kein gültiges JSON."); }
    return inhaltPruefen(obj);
  }

  // Huelle <-> Text fuer die Spalte inhalt_base64
  function huelleKodieren(huelle) { return b64(textZuBytes(JSON.stringify(huelleLesen(huelle)))); }
  function huelleDekodieren(base64Text) { return huelleLesen(bytesZuText(vonB64(base64Text))); }

  // ---------- Klartext (Whitelist) ----------
  // Enthaelt der Wert eines der verbotenen Woerter (Excel-Passwoerter, ab 6 Zeichen) als Teilstring?
  function verbotenHat(liste, wert) {
    if (!liste) return false;
    var treffer = function (pw) { return typeof pw === "string" && pw.length >= 6 && wert.indexOf(pw) >= 0; };
    if (Array.isArray(liste)) return liste.some(treffer);
    if (typeof liste.forEach === "function") {
      var hit = false;
      liste.forEach(function (pw) { if (treffer(pw)) hit = true; });
      return hit;
    }
    return false;
  }

  function profilBauen(p, index, verboten) {
    if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error("Tresor: Profil Nr. " + (index + 1) + " ist kein Objekt.");
    Object.keys(p).forEach(function (k) {
      if (/pass/i.test(k)) throw new Error("Sicherheitsstopp: Das Feld \"" + k + "\" darf nicht in den Tresor.");
    });
    var pn = String(p.personalnummer == null ? "" : p.personalnummer).trim();
    var name = String(p.name == null ? "" : p.name).trim();
    if (!pn) throw new Error("Tresor: Profil Nr. " + (index + 1) + " hat keine Personalnummer.");
    if (!name) throw new Error("Tresor: Profil " + pn + " hat keinen Namen.");
    // Zusaetzliche Sperre: kein Freitextfeld darf ein Passwort aus der Excel enthalten
    // (Personalnummer ausgenommen: ein Startpasswort gleich der Nummer ist kein Leck)
    [p.name, p.fahrgemeinschaft].forEach(function (w) {
      if (w !== null && w !== undefined && String(w) !== "" && verbotenHat(verboten, String(w))) {
        throw new Error("Sicherheitsstopp: Im Profil " + pn + " steht ein Passwort.");
      }
    });
    var kategorie = p.kategorie === "teilzeit" ? "teilzeit" : "minijob";
    // Einsatzzeitraum: leer = null, sonst ein gueltiger ISO-Tag (nichts Kaputtes in den Tresor)
    var einsatz = function (feld, text) {
      var w = p[feld];
      if (w === null || w === undefined || w === "") return null;
      if (!isoTagGueltig(w)) throw new Error("Tresor: Profil " + pn + ": " + text + " ist kein gültiges Datum (JJJJ-MM-TT).");
      return w;
    };
    return {
      personalnummer: pn,
      name: name,
      kategorie: kategorie,
      fahrgemeinschaft: p.fahrgemeinschaft == null || String(p.fahrgemeinschaft).trim() === "" ? null : String(p.fahrgemeinschaft).trim(),
      einsatz_von: einsatz("einsatz_von", "Einsatz von"),
      einsatz_bis: einsatz("einsatz_bis", "Einsatz bis")
    };
  }

  // ---------- Minijob-Stand (Whitelist, streng geprueft) ----------
  function isoTagGueltig(t) {
    if (typeof t !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(t)) return false;
    var d = new Date(t + "T00:00:00Z");
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === t;
  }
  function monatGueltig(t) { return typeof t === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(t); }
  function zahlGueltig(z) { return typeof z === "number" && isFinite(z) && z >= 0; }

  // Prueft einen Minijob-Stand und gibt eine saubere Kopie zurueck (Personen nach
  // Personalnummer sortiert, damit die Gegenprobe nach dem Speichern stabil ist).
  // null/undefined = kein Stand. Ungueltige Werte brechen ab: nichts Kaputtes in den Tresor.
  function minijobPruefen(m) {
    if (m === null || m === undefined) return null;
    if (typeof m !== "object" || Array.isArray(m)) throw new Error("Tresor: Der Minijob-Stand ist kein Objekt.");
    if (!isoTagGueltig(m.stand)) throw new Error("Tresor: Der Minijob-Stand hat kein gültiges Datum (JJJJ-MM-TT).");
    var roh = m.personen;
    if (!roh || typeof roh !== "object" || Array.isArray(roh)) throw new Error("Tresor: Im Minijob-Stand fehlen die Personen.");
    var personen = {};
    Object.keys(roh).sort().forEach(function (pn) {
      var e = roh[pn];
      var wo = "Tresor: Minijob-Stand, Personalnummer " + JSON.stringify(String(pn).slice(0, 30)) + ": ";
      if (!PN_MUSTER.test(pn) || pn === "__proto__") throw new Error(wo + "ungültige Personalnummer.");
      if (!e || typeof e !== "object" || Array.isArray(e)) throw new Error(wo + "kein Objekt.");
      Object.keys(e).forEach(function (k) {
        if (/pass/i.test(k)) throw new Error("Sicherheitsstopp: Das Feld \"" + k + "\" darf nicht in den Tresor.");
      });
      var leer = function (w) { return w === null || w === undefined || w === ""; };
      var eintritt = leer(e.eintritt) ? null : e.eintritt;
      var austritt = leer(e.austritt) ? null : e.austritt;
      var bis = leer(e.abgerechnetBis) ? null : e.abgerechnetBis;
      if (eintritt !== null && !isoTagGueltig(eintritt)) throw new Error(wo + "Eintritt ist kein gültiges Datum.");
      if (austritt !== null && !isoTagGueltig(austritt)) throw new Error(wo + "Austritt ist kein gültiges Datum.");
      if (bis !== null && !monatGueltig(bis)) throw new Error(wo + "\"abgerechnet bis\" ist kein gültiger Monat (JJJJ-MM).");
      // Ohne Abrechnung duerfen Betrag und Stunden fehlen (= 0); mit Abrechnung muessen sie stimmen.
      var zahl = function (w, name) {
        if (leer(w) && bis === null) return 0;
        if (!zahlGueltig(w)) throw new Error(wo + name + " ist keine gültige Zahl (mindestens 0).");
        return w;
      };
      var merkmal = leer(e.minijobMerkmal) ? "?" : e.minijobMerkmal;
      if (MINIJOB_MERKMALE.indexOf(merkmal) < 0) throw new Error(wo + "Minijob-Merkmal muss ja, nein oder ? sein.");
      personen[pn] = {
        eintritt: eintritt,
        austritt: austritt,
        abgerechnetBis: bis,
        svBrutto: zahl(e.svBrutto, "SV-Brutto"),
        stunden: zahl(e.stunden, "Stunden"),
        minijobMerkmal: merkmal
      };
    });
    return {
      stand: m.stand,
      dateiname: m.dateiname == null ? "" : String(m.dateiname).slice(0, 200),
      personen: personen
    };
  }

  // Baut den Klartext aus Profilen (z. B. aus stammProfileLesen), gemerkten
  // Dispo-Schreibweisen und einer Quellenangabe. Nur Whitelist-Felder.
  // verboten (optional): Liste/Set der Excel-Passwoerter; gleicht ein Profilwert
  // einem davon, bricht der Aufbau ab (nichts davon darf in den Tresor).
  // minijob (optional): Minijob-Stand; wer den Tresor neu speichert, MUSS den
  // vorhandenen Stand hier durchreichen, sonst ist er danach weg.
  function inhaltBauen(profile, zuordnung, quelle, verboten, minijob) {
    if (!Array.isArray(profile)) throw new Error("Tresor: Profile fehlen.");
    var gesehen = {};
    var liste = profile.map(function (p, i) {
      var q = profilBauen(p, i, verboten);
      if (gesehen[q.personalnummer]) throw new Error("Tresor: Die Personalnummer " + q.personalnummer + " kommt mehrfach vor.");
      gesehen[q.personalnummer] = true;
      return q;
    });
    var zu = {};
    if (zuordnung && typeof zuordnung === "object" && !Array.isArray(zuordnung)) {
      Object.keys(zuordnung).forEach(function (k) {
        var pn = zuordnung[k];
        // Nur Zuordnungen auf Personen, die es noch gibt (Datenminimierung).
        if (typeof k === "string" && k.trim() && typeof pn === "string" && gesehen[pn]) zu[k] = pn;
      });
    }
    var q = quelle && typeof quelle === "object" ? quelle : {};
    return {
      v: VERSION,
      profile: liste,
      zuordnung: zu,
      quelle: {
        dateiname: q.dateiname == null ? "" : String(q.dateiname).slice(0, 200),
        zeilen: Number.isInteger(q.zeilen) ? q.zeilen : liste.length,
        eingelesen_am: typeof q.eingelesen_am === "string" ? q.eingelesen_am : ""
      },
      minijob: minijobPruefen(minijob)
    };
  }

  // Prueft einen (entschluesselten) Klartext und gibt ihn normalisiert zurueck.
  function inhaltPruefen(obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("Tresor beschädigt: Inhalt fehlt.");
    if (obj.v !== VERSION) {
      throw new Error("Tresor-Inhalt v" + obj.v + " wird von dieser App-Version nicht gelesen – bitte die Seite neu laden (Strg+F5).");
    }
    // minijob wird durchgereicht: Laden, Passwortwechsel und Gegenprobe behalten den Minijob-Stand
    return inhaltBauen(obj.profile, obj.zuordnung, obj.quelle, undefined, obj.minijob);
  }

  return {
    VERSION: VERSION,
    KDF: KDF,
    PASSWORT_MIN: PASSWORT_MIN,
    SALZ_BYTES: SALZ_BYTES,
    PROFIL_FELDER: PROFIL_FELDER.slice(),
    MINIJOB_FELDER: MINIJOB_FELDER.slice(),
    FEHLER_PASSWORT: FEHLER_PASSWORT,
    b64: b64,
    vonB64: vonB64,
    salzNeu: salzNeu,
    passwortNormalisieren: passwortNormalisieren,
    passwortPruefen: passwortPruefen,
    schluesselAbleiten: schluesselAbleiten,
    verschluesseln: verschluesseln,
    entschluesseln: entschluesseln,
    huelleLesen: huelleLesen,
    huelleKodieren: huelleKodieren,
    huelleDekodieren: huelleDekodieren,
    inhaltBauen: inhaltBauen,
    inhaltPruefen: inhaltPruefen,
    minijobPruefen: minijobPruefen
  };
});
