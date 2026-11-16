/*
 * schichtboerse.js – Rechenregeln der Schichtboerse (Migration 0016).
 *
 * Reine Logik: kein DOM, kein Netzwerk. Laeuft im Browser
 * (window.Schichtboerse) und unter Node (require) fuer die Tests.
 * Keine Namen: nur Personalnummern, Datum (JJJJ-MM-TT) und Uhrzeiten.
 *
 * Regeln (Entscheidungen Max 2026-11-16):
 *   - Wer passt: an dem Tag fuer genau diese Schicht als verfuegbar gemeldet,
 *     aktiv, an dem Tag noch nicht eingeplant, nicht die ausgefallene Person.
 *     Die Minijob-Grenze wird NICHT geprueft (nur Hinweis im Admin).
 *   - Boerse laeuft bis 1 Stunde vor Schichtbeginn (Ortszeit Muenchen).
 *     Danach ist ein nicht uebernommenes Angebot "nicht besetzt".
 */
(function (wurzel, fabrik) {
  if (typeof module === "object" && module.exports) module.exports = fabrik();
  else wurzel.Schichtboerse = fabrik();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const VORLAUF_MS = 60 * 60 * 1000;   // Boersenschluss: 1 Stunde vor Beginn
  const ZONE = "Europe/Berlin";

  function uhr(t) { return String(t || "").slice(0, 5); }

  // Wer darf das Angebot sehen? Rueckgabe: sortierte Personalnummern.
  //   o.datum, o.schicht_id   die freie Schicht
  //   o.verfuegbar            [{personalnummer, datum, schicht_id}] (Abgaben der Woche)
  //   o.planung               [{personalnummer, datum}] (veroeffentlichte Planung)
  //   o.aktive                [personalnummer] (aktive Zugaenge)
  //   o.ausser                Personalnummer der ausgefallenen Person (oder null)
  function kandidaten(o) {
    const aktiv = new Set((o.aktive || []).map(String));
    const belegt = new Set((o.planung || [])
      .filter((p) => p.datum === o.datum)
      .map((p) => String(p.personalnummer)));
    const raus = o.ausser === null || o.ausser === undefined ? null : String(o.ausser);
    const treffer = new Set();
    (o.verfuegbar || []).forEach((v) => {
      const pn = String(v.personalnummer);
      if (v.datum !== o.datum || v.schicht_id !== o.schicht_id) return;
      if (!aktiv.has(pn) || belegt.has(pn) || pn === raus) return;
      treffer.add(pn);
    });
    return Array.from(treffer).sort();
  }

  // Ortszeit Muenchen (Datum + Uhrzeit) -> Zeitpunkt (Date). Beachtet Sommerzeit.
  const fmt = (typeof Intl !== "undefined") ? new Intl.DateTimeFormat("en-US", {
    timeZone: ZONE, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  }) : null;

  function versatzMs(ms) {
    const t = {};
    fmt.formatToParts(new Date(ms)).forEach((p) => { t[p.type] = p.value; });
    const alsUtc = Date.UTC(+t.year, +t.month - 1, +t.day, +t.hour % 24, +t.minute, +t.second);
    return alsUtc - Math.floor(ms / 1000) * 1000;
  }

  function berlinZeit(datum, zeit) {
    const d = String(datum).split("-").map(Number);
    const z = uhr(zeit).split(":").map(Number);
    const naiv = Date.UTC(d[0], d[1] - 1, d[2], z[0] || 0, z[1] || 0, 0);
    let ms = naiv - versatzMs(naiv);
    ms = naiv - versatzMs(ms);          // zweiter Schritt fuer Tage mit Zeitumstellung
    return new Date(ms);
  }

  function schluss(datum, beginn) {
    return new Date(berlinZeit(datum, beginn).getTime() - VORLAUF_MS);
  }

  // Lage eines Angebots aus Sicht des Admins:
  //   "offen"          frei und Boerse laeuft noch
  //   "nicht_besetzt"  frei, aber Boersenschluss vorbei (rot, telefonisch regeln)
  //   sonst der Status: "uebernommen", "zurueckgenommen", "geschlossen"
  function lage(angebot, jetzt) {
    if (angebot.status !== "frei") return angebot.status;
    const j = jetzt instanceof Date ? jetzt : new Date(jetzt);
    return j < schluss(angebot.datum, angebot.beginn) ? "offen" : "nicht_besetzt";
  }

  // Anzahl Aenderungen nach dem Zeitpunkt seit (ISO-Text oder null = alle)
  function aenderungenSeit(liste, seit) {
    const grenze = seit ? new Date(seit).getTime() : -Infinity;
    return (liste || []).filter((a) => new Date(a.am).getTime() > grenze).length;
  }

  // FedEx-Datei aus der veroeffentlichten Planung (nach Boersen-Aenderungen).
  // Zeilen je Tag und Art wie in der Vorlage: FRUEH=AM, SPAET=PM, LANG/BUERO=Office,
  // nr fortlaufend ab 1 (sortiert nach Beginn, dann Name). Offene Angebote
  // (frei oder nicht besetzt) bleiben als leere Zeile mit Uhrzeit stehen.
  //   planung  [{personalnummer, datum, schicht_id, beginn, ende}]
  //   offen    [{datum, schicht_id, beginn, ende}]
  //   kw       Montag (JJJJ-MM-TT)
  //   nameVon  function(pn) -> Text fuer die Sortierung (optional)
  // Rueckgabe: { tage:[5 Daten], eintraege:[{datum, art, nr, personalnummer|null, beginn, ende}], unbekannt:[...] }
  const FEDEX_ART = { FRUEH: "AM", SPAET: "PM", LANG: "Office", BUERO: "Office" };
  function plusTage(iso, n) {
    const d = String(iso).split("-").map(Number);
    return new Date(Date.UTC(d[0], d[1] - 1, d[2] + n)).toISOString().slice(0, 10);
  }
  function fedexEintraege(planung, offen, kw, nameVon) {
    const tage = [0, 1, 2, 3, 4].map((i) => plusTage(kw, i));
    const name = typeof nameVon === "function" ? nameVon : (pn) => String(pn);
    const gruppen = {};
    const unbekannt = [];
    const rein = (x, pn) => {
      const art = FEDEX_ART[x.schicht_id];
      if (!art || tage.indexOf(x.datum) < 0) { unbekannt.push(x.datum + " " + x.schicht_id); return; }
      const k = x.datum + "|" + art;
      (gruppen[k] = gruppen[k] || []).push({ datum: x.datum, art: art, personalnummer: pn, beginn: uhr(x.beginn), ende: uhr(x.ende) });
    };
    (planung || []).forEach((p) => rein(p, String(p.personalnummer)));
    (offen || []).forEach((a) => rein(a, null));
    const eintraege = [];
    Object.keys(gruppen).sort().forEach((k) => {
      gruppen[k].sort((a, b) =>
        (a.personalnummer === null) - (b.personalnummer === null) ||
        a.beginn.localeCompare(b.beginn) ||
        (a.personalnummer === null ? 0 : String(name(a.personalnummer)).localeCompare(String(name(b.personalnummer)), "de")));
      gruppen[k].forEach((e, i) => eintraege.push(Object.assign({ nr: i + 1 }, e)));
    });
    return { tage: tage, eintraege: eintraege, unbekannt: unbekannt };
  }

  return {
    fedexEintraege: fedexEintraege,
    kandidaten: kandidaten,
    berlinZeit: berlinZeit,
    schluss: schluss,
    lage: lage,
    aenderungenSeit: aenderungenSeit,
    VORLAUF_MS: VORLAUF_MS
  };
});
