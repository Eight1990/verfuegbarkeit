/*
 * minijob.js – harte Minijob-Grenze für die Auto-Planung.
 *
 * Liest den Minijob-Stand (CSV aus dem DocuWare-Skript, monatlich nach der
 * Lohnabrechnung) und berechnet daraus je Minijobber eine Wochen-Obergrenze in
 * Minuten, die der Solver als harte Regel nutzt (personen[i].max_minuten_hart).
 * Geprüft wird nur „nicht zu viel verdienen“, nicht „zu wenig“.
 *
 * Reine Logik: kein DOM, kein Netzwerk, keine Uhr (kein „heute“) – gleiche
 * Eingabe, gleiches Ergebnis. Läuft im Browser (window.MinijobStand) und unter
 * Node (require) für die Tests. Datumsrechnung nur mit ganzen Kalendertagen auf
 * ISO-Texten, ohne Uhrzeit und ohne Zeitzone.
 *
 * Regeln (Entscheidungen vom 11.11.2026):
 *   - Grenze je Kalendermonat nach Jahr (GRENZEN); unbekanntes späteres Jahr →
 *     letzter bekannter Wert. Teilmonate anteilig nach Tagen.
 *   - Verträge laufen immer 9 Monate (übliche Monatsfrist): derselbe Kalendertag
 *     9 Monate nach dem Eintritt, Ende am Tag davor; fehlt der Tag im Zielmonat,
 *     Ende am Monatsletzten. Ist ein Austritt eingetragen, gilt das frühere Datum.
 *   - Es zählt nur der Verdienst seit dem aktuellen Eintritt (so liefert ihn die
 *     CSV). Ohne abgerechneten Monat (Neue): keine Grenze.
 *   - Restbudget = Grenze von Eintritt bis Befristungsende − abgerechnetes
 *     SV-Brutto, gleichmäßig verteilt auf alle Tage vom 1. des ersten nicht
 *     abgerechneten Monats bis zum Befristungsende; je Woche nie mehr als das
 *     ganze Restbudget. Nichts schätzen.
 *   - Euro → Minuten über den eigenen Satz (SV-Brutto / Stunden); ohne Stunden
 *     über einen Ersatzsatz (höchster Satz im Stand, sonst 16 €/h).
 *
 * Minijob-Stand (liegt verschlüsselt im Tresor, Abschnitt minijob):
 *   { stand: "YYYY-MM-DD", dateiname, personen: { <Personalnummer>: {
 *       eintritt: "YYYY-MM-DD"|null, austritt: "YYYY-MM-DD"|null,
 *       abgerechnetBis: "YYYY-MM"|null, svBrutto: Euro, stunden: Stunden,
 *       minijobMerkmal: "ja"|"nein"|"?" } } }
 */
(function (wurzel, fabrik) {
  if (typeof module === "object" && module.exports) module.exports = fabrik();
  else wurzel.MinijobStand = fabrik();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Monatliche Verdienstgrenze in Euro je Kalenderjahr. Neues Jahr: hier ergänzen.
  var GRENZEN = Object.freeze({ 2025: 556, 2026: 603, 2027: 633 });
  var GRENZ_JAHRE = Object.keys(GRENZEN).map(Number).sort(function (a, b) { return a - b; });
  var LAUFZEIT_MONATE = 9;
  var SATZ_STANDARD = 16;                    // €/h, wenn im Stand kein Satz berechenbar ist
  var TAG_MS = 86400000;
  var PN_MUSTER = /^[A-Za-z0-9._-]{1,20}$/;  // wie beim Stammlisten-Import

  // CSV-Spalten, gefunden über den Anfang des Kopfzeilen-Texts (nicht über die Position).
  var SPALTEN = [
    { feld: "pn", kopf: "Personalnummer", pflicht: true },
    { feld: "eintritt", kopf: "Eintritt", pflicht: true },
    { feld: "austritt", kopf: "Austritt", pflicht: false },
    { feld: "letzterMonat", kopf: "Letzter Monat", pflicht: true },
    { feld: "svBrutto", kopf: "SV-Brutto im Zeitraum", pflicht: true },
    { feld: "stunden", kopf: "Stunden im Zeitraum", pflicht: true },
    { feld: "merkmal", kopf: "Minijob-Merkmal", pflicht: true }
  ];

  // ---------- Kalender: ganze Tage { j, m, t } ----------
  function schaltjahr(j) { return (j % 4 === 0 && j % 100 !== 0) || j % 400 === 0; }
  function tageImMonat(j, m) {
    if (m === 2) return schaltjahr(j) ? 29 : 28;
    return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
  }
  // Gültiges Kalenderdatum oder null (31.02. und Ähnliches fallen durch).
  function datum(j, m, t) {
    if (!(j >= 1900 && j <= 2999 && m >= 1 && m <= 12 && t >= 1 && t <= tageImMonat(j, m))) return null;
    return { j: j, m: m, t: t };
  }
  function zweistellig(n) { return (n < 10 ? "0" : "") + n; }
  function isoText(d) { return d.j + "-" + zweistellig(d.m) + "-" + zweistellig(d.t); }
  function isoLesen(text) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text));
    return m ? datum(+m[1], +m[2], +m[3]) : null;
  }
  function tagNr(d) { return Math.round(Date.UTC(d.j, d.m - 1, d.t) / TAG_MS); }
  function vergleich(a, b) { return (a.j - b.j) || (a.m - b.m) || (a.t - b.t); }
  function leer(x) { return x === null || x === undefined || String(x).trim() === ""; }
  function eigen(obj, k) { return !!obj && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, k); }

  function isoPflicht(wert, was) {
    var d = isoLesen(wert);
    if (!d) throw new Error(was + " „" + wert + "“ ist kein gültiges Datum (JJJJ-MM-TT).");
    return d;
  }
  function monatPflicht(wert, was) {
    var m = /^(\d{4})-(\d{2})$/.exec(String(wert));
    var d = m ? datum(+m[1], +m[2], 1) : null;
    if (!d) throw new Error(was + " „" + wert + "“ ist kein gültiger Monat (JJJJ-MM).");
    return d;
  }
  function zahlPflicht(wert, was) {
    if (typeof wert !== "number" || !isFinite(wert) || wert < 0) {
      throw new Error(was + " „" + wert + "“ ist keine Zahl ≥ 0.");
    }
    return wert;
  }

  // ---------- Grenze ----------
  // Monatsgrenze im Jahr j: letzter bekannter Wert bis j. Jahre vor der Tabelle
  // bekommen den ersten bekannten Wert (kommt bei 9-Monats-Verträgen nicht vor).
  function monatsGrenze(j) {
    var wert = GRENZEN[GRENZ_JAHRE[0]];
    GRENZ_JAHRE.forEach(function (k) { if (k <= j) wert = GRENZEN[k]; });
    return wert;
  }

  // Summe der Monatsgrenzen von a bis b (beide Tage inklusive) in Cent:
  // Teilmonate anteilig nach Tagen, ungerundet summiert, einmal gerundet.
  function grenzeCent(a, b) {
    if (vergleich(a, b) > 0) return 0;
    var summe = 0, j = a.j, m = a.m;
    while (j < b.j || (j === b.j && m <= b.m)) {
      var tim = tageImMonat(j, m);
      var von = (j === a.j && m === a.m) ? a.t : 1;
      var bis = (j === b.j && m === b.m) ? b.t : tim;
      summe += monatsGrenze(j) * (bis - von + 1) / tim;
      if (++m > 12) { m = 1; j++; }
    }
    return Math.round(summe * 100);
  }

  // Befristungsende nach der üblichen Monatsfrist (wie § 188 BGB): derselbe
  // Kalendertag 9 Monate nach dem Eintritt; gibt es ihn im Zielmonat, endet der
  // Vertrag am Tag davor, sonst am letzten Tag des Zielmonats.
  // 02.02.2026 → 01.11.2026; 01.03.2026 → 30.11.2026; 31.05.2026 → 28.02.2027.
  function befristungsende(eintrittIso) {
    var e = isoPflicht(eintrittIso, "Eintritt");
    var m = e.m + LAUFZEIT_MONATE;
    var j = e.j + Math.floor((m - 1) / 12);
    m = (m - 1) % 12 + 1;
    var letzter = tageImMonat(j, m);
    if (e.t > letzter) return isoText({ j: j, m: m, t: letzter }); // Tag fehlt → Monatsletzter
    if (e.t > 1) return isoText({ j: j, m: m, t: e.t - 1 });       // Tag davor
    if (--m < 1) { m = 12; j--; }                                  // vor dem 1. → Letzter des Vormonats
    return isoText({ j: j, m: m, t: tageImMonat(j, m) });
  }

  // Grenze in Euro für den Zeitraum von..bis (beide inklusive), auf Cent gerundet.
  function grenzeImZeitraum(vonIso, bisIso) {
    return grenzeCent(isoPflicht(vonIso, "Beginn"), isoPflicht(bisIso, "Ende")) / 100;
  }

  // ---------- Wochen-Obergrenze ----------
  // Minuten je Woche (ganzzahlig, abgerundet) oder null = keine Grenze (kein
  // Eintritt, kein abgerechneter Monat oder Beginn A nach Befristungsende B).
  //   E = Eintritt, B = min(Befristungsende(E), Austritt),
  //   A = max(E, 1. Tag des Monats nach abgerechnetBis)
  //   rest = Grenze(E..B) − svBrutto;  tage = A..B inklusive
  //   euroProWoche = min(rest, rest · 7 / tage) mit rest ≥ 0 (unter 7 Resttagen
  //                  nie mehr als das ganze Restbudget)
  //   satz = svBrutto / stunden (ohne Stunden oder ohne Brutto: satzErsatz, sonst 16)
  //   minuten = floor(euroProWoche / satz · 60)
  // Wirft bei kaputten Werten (csvLesen liefert nur gültige).
  function wochenGrenzeMinuten(person, satzErsatz) {
    var p = person || {};
    if (leer(p.eintritt) || leer(p.abgerechnetBis)) return null;
    var e = isoPflicht(p.eintritt, "Eintritt");
    var abgerechnet = monatPflicht(p.abgerechnetBis, "Abgerechnet bis");
    var b = isoLesen(befristungsende(p.eintritt));
    if (!leer(p.austritt)) {
      var austritt = isoPflicht(p.austritt, "Austritt");
      if (vergleich(austritt, b) < 0) b = austritt;
    }
    var naechster = abgerechnet.m === 12 ? { j: abgerechnet.j + 1, m: 1, t: 1 } : { j: abgerechnet.j, m: abgerechnet.m + 1, t: 1 };
    var a = vergleich(e, naechster) > 0 ? e : naechster;
    if (vergleich(a, b) > 0) return null;

    var svCent = Math.round(zahlPflicht(p.svBrutto, "SV-Brutto") * 100);
    var stundenH = leer(p.stunden) ? 0 : Math.round(zahlPflicht(p.stunden, "Stunden") * 100);
    var restCent = Math.max(0, grenzeCent(e, b) - svCent);
    var tage = tagNr(b) - tagNr(a) + 1;
    // min(rest, rest · 7/tage) = rest · 7 / max(tage, 7)
    var teiler = Math.max(tage, 7);
    // floor(restCent/100 · 7/teiler / satz · 60) = floor(restCent · 420 / (100 · teiler · satz))
    if (stundenH > 0 && svCent > 0) {
      // eigener Satz svBrutto / stunden – in Cent und 1/100 h ganzzahlig, also exakt
      return Math.floor(restCent * 420 * stundenH / (100 * teiler * svCent));
    }
    var ersatz = typeof satzErsatz === "number" && isFinite(satzErsatz) && satzErsatz > 0 ? satzErsatz : SATZ_STANDARD;
    return Math.floor(restCent * 420 / (100 * teiler * ersatz));
  }

  function personenVon(stand) {
    return stand && typeof stand === "object" && stand.personen && typeof stand.personen === "object" ? stand.personen : {};
  }

  // Minijobber? Kategorie aus dem Profil; fehlt das Profil (oder dort die
  // Kategorie), entscheidet das Minijob-Merkmal aus der CSV.
  function istMinijobber(pn, person, profile) {
    var pr = eigen(profile, pn) ? profile[pn] : null;
    if (pr && !leer(pr.kategorie)) return String(pr.kategorie).trim().toLowerCase() === "minijob";
    return !!person && person.minijobMerkmal === "ja";
  }

  // Ersatzsatz für Personen ohne Stunden: höchster Satz im Stand (vorsichtig), sonst 16 €/h.
  function satzErsatzVon(personen) {
    var hoechster = 0;
    Object.keys(personen).forEach(function (pn) {
      var p = personen[pn] || {};
      var sv = p.svBrutto, st = p.stunden;
      if (typeof sv === "number" && typeof st === "number" && isFinite(sv) && isFinite(st) && sv > 0 && st > 0) {
        hoechster = Math.max(hoechster, sv / st);
      }
    });
    return hoechster > 0 ? hoechster : SATZ_STANDARD;
  }

  function grenzeVon(pn, person, ersatz) {
    try { return wochenGrenzeMinuten(person, ersatz); }
    catch (e) { throw new Error("Minijob-Stand, Personalnummer " + pn + ": " + e.message); }
  }

  // { <pn>: Minuten } für alle Minijobber mit Grenze; ohne Grenze (null) fehlt der Eintrag.
  function wochenGrenzen(stand, profile) {
    var personen = personenVon(stand), ersatz = satzErsatzVon(personen), erg = {};
    Object.keys(personen).forEach(function (pn) {
      if (!istMinijobber(pn, personen[pn], profile)) return;
      var min = grenzeVon(pn, personen[pn], ersatz);
      if (min !== null) erg[pn] = min;
    });
    return erg;
  }

  // Für die Anzeige. stand darf auch das Ergebnis von csvLesen sein (dann stand: null).
  //   abgerechnetBis: häufigster Monat im Stand (bei Gleichstand der spätere)
  //   minijobberMitGrenze: Minijobber mit Wochen-Obergrenze (auch 0)
  //   ohneAbrechnung: Minijobber ohne abgerechneten Monat (keine Grenze)
  //   ohneRestbudget: Minijobber mit Obergrenze 0
  function zusammenfassung(stand, profile) {
    var personen = personenVon(stand), ersatz = satzErsatzVon(personen), anzahl = {};
    var z = {
      stand: stand && typeof stand === "object" && typeof stand.stand === "string" && stand.stand ? stand.stand : null,
      abgerechnetBis: null, minijobberMitGrenze: 0, ohneAbrechnung: 0, ohneRestbudget: 0
    };
    Object.keys(personen).forEach(function (pn) {
      var p = personen[pn] || {};
      if (typeof p.abgerechnetBis === "string" && /^\d{4}-\d{2}$/.test(p.abgerechnetBis)) {
        anzahl[p.abgerechnetBis] = (anzahl[p.abgerechnetBis] || 0) + 1;
      }
      if (!istMinijobber(pn, p, profile)) return;
      if (leer(p.abgerechnetBis)) { z.ohneAbrechnung++; return; }
      var min = grenzeVon(pn, p, ersatz);
      if (min === null) return;
      z.minijobberMitGrenze++;
      if (min === 0) z.ohneRestbudget++;
    });
    Object.keys(anzahl).forEach(function (monat) {
      var bisher = z.abgerechnetBis;
      if (bisher === null || anzahl[monat] > anzahl[bisher] || (anzahl[monat] === anzahl[bisher] && monat > bisher)) {
        z.abgerechnetBis = monat;
      }
    });
    return z;
  }

  // ---------- CSV ----------
  // Zerlegt CSV-Text (Trennzeichen ";", Anführungszeichen wie in Excel, auch mit
  // Zeilenumbruch darin) in Datensätze samt Nummer ihrer ersten Zeile.
  function csvZerlegen(text) {
    var saetze = [], zellen = [], zelle = "", zitiert = false, feldAnfang = true;
    var zeile = 1, start = 1, offenSeit = 0;
    for (var i = 0; i < text.length; i++) {
      var c = text.charAt(i);
      if (zitiert) {
        if (c === '"') {
          if (text.charAt(i + 1) === '"') { zelle += '"'; i++; } else zitiert = false;
        } else {
          if (c === "\n" || (c === "\r" && text.charAt(i + 1) !== "\n")) zeile++;
          zelle += c;
        }
      } else if (c === '"' && feldAnfang) {
        zitiert = true; feldAnfang = false; offenSeit = zeile;
      } else if (c === ";") {
        zellen.push(zelle); zelle = ""; feldAnfang = true;
      } else if (c === "\n" || c === "\r") {
        if (c === "\r" && text.charAt(i + 1) === "\n") i++;
        zellen.push(zelle);
        saetze.push({ zeile: start, zellen: zellen });
        zellen = []; zelle = ""; feldAnfang = true;
        start = ++zeile;
      } else {
        zelle += c; feldAnfang = false;
      }
    }
    if (zelle !== "" || zellen.length || zitiert) { zellen.push(zelle); saetze.push({ zeile: start, zellen: zellen }); }
    return { saetze: saetze, offenSeit: zitiert ? offenSeit : 0 };
  }

  function kopfNorm(text) { return String(text).replace(/\s+/g, " ").trim().toLowerCase(); }

  // Zahl im deutschen Format („2.950,00“, „210,50“, „7“): Zahl, null (leer) oder NaN (ungültig).
  function zahlLesen(text) {
    var t = text.replace(/\s+/g, "").replace(/€/g, "");
    if (t === "") return null;
    if (!/^[-+]?(\d{1,3}(\.\d{3})+|\d+)(,\d+)?$/.test(t)) return NaN;
    return Number(t.replace(/\./g, "").replace(",", "."));
  }
  // „TT.MM.JJJJ“ (auch JJJJ-MM-TT) → "YYYY-MM-DD"; leer → null; ungültig → undefined.
  function datumLesen(text) {
    if (text === "") return null;
    var m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(text);
    var d = m ? datum(+m[3], +m[2], +m[1]) : isoLesen(text);
    return d ? isoText(d) : undefined;
  }
  // „JJJJ-MM“ → "YYYY-MM"; leer → null; ungültig → undefined.
  function monatLesen(text) {
    if (text === "") return null;
    var m = /^(\d{4})-(\d{1,2})$/.exec(text);
    var d = m ? datum(+m[1], +m[2], 1) : null;
    return d ? d.j + "-" + zweistellig(d.m) : undefined;
  }

  function zeileLesen(satz, spalte, personen, fehler, ersteZeile) {
    function wert(feld) {
      var x = spalte[feld] === undefined ? undefined : satz.zellen[spalte[feld]];
      return x === undefined ? "" : String(x).trim();
    }
    var pn = wert("pn");
    if (pn === "") return;                       // Zeilen ohne Personalnummer (auch Leerzeilen) überspringen
    var ort = "Zeile " + satz.zeile;
    if (!PN_MUSTER.test(pn) || pn === "__proto__") { fehler.push(ort + ": Personalnummer „" + pn + "“ ist ungültig."); return; }
    ort += " (Personalnummer " + pn + ")";
    if (eigen(ersteZeile, pn)) {
      fehler.push(ort + ": doppelt (zuerst in Zeile " + ersteZeile[pn] + ") – diese Zeile wird ignoriert.");
      return;
    }
    ersteZeile[pn] = satz.zeile;

    var probleme = [];
    var eintritt = datumLesen(wert("eintritt"));
    if (eintritt === undefined) probleme.push("Eintritt „" + wert("eintritt") + "“ ist kein gültiges Datum (TT.MM.JJJJ)");
    var austritt = datumLesen(wert("austritt"));
    if (austritt === undefined) probleme.push("Austritt „" + wert("austritt") + "“ ist kein gültiges Datum (TT.MM.JJJJ)");
    var bis = monatLesen(wert("letzterMonat"));
    if (bis === undefined) probleme.push("Letzter Monat „" + wert("letzterMonat") + "“ ist kein gültiger Monat (JJJJ-MM)");
    var sv = zahlLesen(wert("svBrutto"));
    if (sv === null && bis) probleme.push("SV-Brutto im Zeitraum fehlt, obwohl bis " + bis + " abgerechnet ist");
    else if (sv !== null && !(sv >= 0)) probleme.push("SV-Brutto im Zeitraum „" + wert("svBrutto") + "“ ist keine Zahl ≥ 0 (Format 1.234,56)");
    var stunden = zahlLesen(wert("stunden"));
    if (stunden !== null && !(stunden >= 0)) probleme.push("Stunden im Zeitraum „" + wert("stunden") + "“ ist keine Zahl ≥ 0 (Format 1.234,56)");
    if (probleme.length) { fehler.push(ort + ": " + probleme.join("; ") + "."); return; }

    var merkmal = wert("merkmal").toLowerCase();
    personen[pn] = {
      eintritt: eintritt,
      austritt: austritt,
      abgerechnetBis: bis,
      svBrutto: sv || 0,
      stunden: stunden || 0,
      minijobMerkmal: merkmal === "ja" ? "ja" : merkmal === "nein" ? "nein" : "?"
    };
  }

  // CSV aus dem DocuWare-Skript (UTF-8 mit BOM, ";", Dezimalkomma) →
  // { personen: { <pn>: {...} }, fehler: [lesbare Meldungen], anzahl }.
  // Wirft nie. Zeilen mit Fehlern fehlen in personen und stehen in fehler.
  function csvLesen(text) {
    var personen = {}, fehler = [];
    var erg = { personen: personen, fehler: fehler, anzahl: 0 };
    if (typeof text !== "string") { fehler.push("Keine Textdatei übergeben."); return erg; }
    var z = csvZerlegen(text.charAt(0) === "﻿" ? text.slice(1) : text);
    if (z.offenSeit) fehler.push("Zeile " + z.offenSeit + ": Anführungszeichen wird nicht geschlossen.");

    // Kopfzeile = erster Datensatz mit einer Zelle, die mit „Personalnummer“ beginnt
    var k = -1;
    for (var i = 0; i < z.saetze.length && k < 0; i++) {
      if (z.saetze[i].zellen.some(function (c) { return kopfNorm(c).indexOf("personalnummer") === 0; })) k = i;
    }
    if (k < 0) {
      fehler.push("Kopfzeile mit „Personalnummer“ nicht gefunden – ist das die CSV aus dem DocuWare-Skript?");
      return erg;
    }
    var kopf = z.saetze[k].zellen.map(kopfNorm), spalte = {}, ok = true;
    SPALTEN.forEach(function (s) {
      var gesucht = kopfNorm(s.kopf), genau = [], anfang = [];
      kopf.forEach(function (h, idx) {
        if (h === gesucht) genau.push(idx);
        if (h.indexOf(gesucht) === 0) anfang.push(idx);
      });
      var treffer = genau.length ? genau : anfang;
      if (treffer.length === 1) spalte[s.feld] = treffer[0];
      else if (treffer.length > 1) {
        ok = false;
        fehler.push("Spalte „" + s.kopf + "“ ist mehrdeutig (Spalten " + treffer.map(function (x) { return x + 1; }).join(", ") + ").");
      } else if (s.pflicht) {
        ok = false;
        fehler.push("Spalte „" + s.kopf + "“ fehlt.");
      }
    });
    if (!ok) return erg;

    var ersteZeile = {};
    for (var r = k + 1; r < z.saetze.length; r++) zeileLesen(z.saetze[r], spalte, personen, fehler, ersteZeile);
    erg.anzahl = Object.keys(personen).length;
    if (!erg.anzahl && !fehler.length) fehler.push("Keine Zeile mit Personalnummer gefunden.");
    return erg;
  }

  return {
    GRENZEN: GRENZEN,
    befristungsende: befristungsende,
    grenzeImZeitraum: grenzeImZeitraum,
    csvLesen: csvLesen,
    wochenGrenzeMinuten: wochenGrenzeMinuten,
    wochenGrenzen: wochenGrenzen,
    zusammenfassung: zusammenfassung
  };
});
