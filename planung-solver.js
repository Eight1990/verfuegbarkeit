/*
 * planung-solver.js – regelbasierte Wochenplanung (ohne KI, ohne API).
 *
 * Reine Logik, kein DOM, keine Netzwerkzugriffe. Läuft im Browser
 * (window.PlanungSolver) und unter Node (require) für die Tests.
 *
 * Rangfolge (strikt: eine niedrigere Stufe wiegt eine höhere nie auf;
 * Kostenvektor [L, U, T, TZ, W], nur ganze Zahlen, lexikografisch):
 *   0. Harte Regeln, werden nie gebrochen (lieber bleibt ein Platz leer):
 *      - nur eingesetzt, wer die Schicht als verfügbar abgegeben hat
 *        (Verfügbarkeit für die lange Spätschicht deckt die Spätschicht ab)
 *      - keine Überschneidung, keine zwei Schichten gleicher Art am Tag
 *      - Ruhezeit zwischen zwei Arbeitstagen mindestens 11 Stunden (ArbZG § 5)
 *      - höchstens 10 Stunden pro Tag, 48 Stunden pro Woche
 *   1. L  alle Plätze besetzen (leerer Früh-/Spät-Platz 10, Office-Platz 1)
 *   2. U  Wunschgrenze "max. Schichten" des Mitarbeiters (aus der Abgabe)
 *         nicht überschreiten. Sie ist weich: überschritten wird nur, wenn
 *         sonst ein Platz leer bliebe – der Bericht weist darauf hin.
 *   3. T  Fahrgemeinschaften nicht trennen (Regel unten)
 *   4. TZ Teilzeit zuerst / maximal (Summe der Teilzeit-Minuten)
 *   5. W  gleichmäßig verteilen: Minijob-Minuten² (gleichmäßig), keine
 *         Doppelschicht, Früh und Spät in einer Woche nicht mischen
 *
 * Fahrgemeinschaft: gleiche Kennung (ohne Leerzeichen, groß geschrieben,
 * nur Striche = keine) bildet eine Gruppe; die Regel gilt paarweise. Ein Paar
 * ist an einem Tag getrennt, wenn einer eine Schichtart arbeitet, die der
 * andere nicht hat, obwohl er könnte: Er hat sie als verfügbar abgegeben,
 * es gibt dort noch einen Platz für die Gruppe, und er käme entweder neu
 * dazu (dann nur unter seiner Wunschgrenze und unter 48 h) oder könnte von
 * einer anderen Art wechseln. In eine Doppelschicht wird niemand gedrängt.
 * Ruhezeit und 10 h/Tag entschuldigen nicht – um sie plant der Solver herum.
 * Getrennt wird also nur, wenn sonst ein Platz leer bliebe oder jemand über
 * seinen Wunsch käme; begruenden() nennt für jede Ausnahme den Grund.
 *
 * Vorgehen: Aufbau nach Knappheit (Partner werden nachgezogen), danach
 * lokale Suche (Übernahme, Tausch, Gruppenpaar, Reparaturketten bis Tiefe 3;
 * für Trennungen zusätzlich Gruppenwechsel, Blockzug, zwei Plätze zugleich),
 * vier deterministische Startvarianten, der beste Plan gewinnt. Bleiben
 * Trennungen, werden Fahrgemeinschaft und Nachbarn über zwei Tage exakt neu
 * verteilt (Fenster). Jeder Zug wird nur übernommen, wenn der Kostenvektor
 * echt besser wird. Der Suchumfang ist über die Zahl der Bewertungen
 * begrenzt, nie über die Uhrzeit – gleiche Eingabe, gleiches Ergebnis.
 */
(function (wurzel, fabrik) {
  if (typeof module === "object" && module.exports) module.exports = fabrik();
  else wurzel.PlanungSolver = fabrik();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var RUHEZEIT_MIN = 11 * 60;
  var MAX_TAG_MIN = 10 * 60;
  var MAX_WOCHE_MIN = 48 * 60;

  var ART = {
    FRUEH: { art: "AM", ord: 0 },
    SPAET: { art: "PM", ord: 1 },
    LANG: { art: "Office", ord: 2 }
  };
  var BIT = { FRUEH: 1, SPAET: 2, LANG: 4 };
  var BIT_NAME = { 1: "FRUEH", 2: "SPAET", 4: "LANG" };

  // Kostenvektor [L, U, T, TZ, W]
  var LUECKE_REGULAER = 10;   // leerer Früh-/Spät-Platz
  var LUECKE_OFFICE = 1;      // leerer Office-Platz (LANG)
  var W_DOPPEL = 2880000;     // je Person-Tag mit mehr als einer Schicht
  var W_MISCHUNG = 216000;    // je Person mit Früh und Spät in derselben Woche

  // Suchumfang: Zahl der Bewertungen (deterministisch, nie Uhrzeit)
  var BUDGET = 300000;        // je loese()-Aufruf, alle Startvarianten zusammen
  var GRUND_BUDGET = 20000;   // je Befund in begruenden()
  var MAX_RUNDEN = 60;
  var KETTE_TIEFE = 3;
  var VARIANTEN = [0, 1, 2, 3];
  var FENSTER_P = 6;          // Personen je Fenster (Gruppe + Nachbarn)
  var FENSTER_KNOTEN = 40000; // Suchknoten je Fenster
  var FENSTER_BUDGET = 150000; // Fensterknoten + Nachbessern zusammen je loese()
  var POLITUR = 30000;        // Bewertungen für das Nachbessern nach einem Fenster
  var SCHLUSS = 60000;        // Schlusslauf ohne Teilzeit-Ketten auf dem besten Plan

  // ---------- Zeit-Helfer ----------
  function minuten(zeit) {
    var t = String(zeit || "").split(":");
    return (parseInt(t[0], 10) || 0) * 60 + (parseInt(t[1], 10) || 0);
  }
  function tagNr(iso) {
    var p = String(iso).split("-");
    return Math.round(Date.UTC(+p[0], +p[1] - 1, +p[2]) / 86400000);
  }
  function wochentagVon(iso) {
    return ((tagNr(iso) + 3) % 7) + 1; // 1 = Montag
  }
  function uhr(t) { return String(t || "").slice(0, 5); }

  // ---------- Bedarf / Slots ----------
  // Standard aus der Dispo: Mo 9 früh / 10 spät, Di–Fr 6 früh / 10 spät.
  function standardBedarf(schichten) {
    var b = {};
    (schichten || []).forEach(function (s) {
      if (!b[s.datum]) {
        var mo = wochentagVon(s.datum) === 1;
        b[s.datum] = { FRUEH: mo ? 9 : 6, SPAET: 10, LANG: 0 };
      }
    });
    return b;
  }

  function slotsBauen(schichten, bedarf, tage) {
    var gesperrt = {};
    (tage || []).forEach(function (t) { if (t.gesperrt) gesperrt[t.datum] = true; });
    var out = [];
    (schichten || []).forEach(function (s) {
      var a = ART[s.schicht_id];
      if (!a || s.aktiv === false || gesperrt[s.datum]) return;
      var b = bedarf && bedarf[s.datum];
      var n = b ? (b[s.schicht_id] | 0) : 0;
      for (var i = 1; i <= n; i++) {
        var tag = tagNr(s.datum) * 1440;
        out.push({
          id: s.datum + "|" + s.schicht_id + "|" + i,
          datum: s.datum,
          schicht_id: s.schicht_id,
          art: a.art,
          ord: a.ord,
          nr: i,
          beginn: uhr(s.beginn),
          ende: uhr(s.ende),
          start: tag + minuten(s.beginn),
          end: tag + minuten(s.ende),
          dauer: minuten(s.ende) - minuten(s.beginn)
        });
      }
    });
    out.sort(function (x, y) {
      return x.datum < y.datum ? -1 : x.datum > y.datum ? 1 :
        x.ord - y.ord || x.nr - y.nr;
    });
    return out;
  }

  // ---------- Personen und Fahrgemeinschaften ----------
  // "fg 1" = "FG1"; nur Striche ("-", "–", "—") = keine Fahrgemeinschaft
  function gruppeNorm(text) {
    if (text === null || text === undefined) return "";
    var s = String(text);
    if (typeof s.normalize === "function") s = s.normalize("NFC");
    s = s.replace(/\s+/g, "").toUpperCase();
    return /^[-–—]*$/.test(s) ? "" : s;
  }

  // Personen nach Personalnummer sortiert (Ergebnis unabhängig von der
  // Eingabereihenfolge). Gruppen nur aus Personen der Eingabe, ab 2 Personen.
  function personenBauen(rohe) {
    var gesehen = Object.create(null), liste = [];
    (rohe || []).forEach(function (p) {
      if (!p) return;
      var roh = p.personalnummer !== undefined && p.personalnummer !== null ? p.personalnummer : p.pn;
      if (roh === undefined || roh === null) return;
      var pn = String(roh);
      if (gesehen[pn]) return;
      gesehen[pn] = true;
      var verf = Object.create(null), anzahl = 0;
      (p.verfuegbar || []).forEach(function (v) {
        if (!v) return;
        var key = v.datum + "|" + v.schicht_id;
        if (!verf[key]) { verf[key] = true; anzahl++; }
      });
      var m = Number(p.max_schichten);
      var hatWunsch = p.max_schichten !== null && p.max_schichten !== undefined &&
        p.max_schichten !== "" && isFinite(m) && m > 0;
      liste.push({
        pn: pn,
        verf: verf,
        anzahlVerf: anzahl,
        limit: hatWunsch ? Math.max(1, Math.floor(m)) : 99,   // 99 = unbegrenzt
        kategorie: String(p.kategorie || "").trim().toLowerCase() === "teilzeit" ? "teilzeit" : "minijob",
        gruppe: gruppeNorm(p.fahrgemeinschaft),
        partner: [],
        wocheMaxMin: MAX_WOCHE_MIN   // Platz für eine spätere harte Minijob-Grenze
      });
    });
    liste.sort(function (a, b) { return a.pn < b.pn ? -1 : a.pn > b.pn ? 1 : 0; });
    var nachPn = Object.create(null), proGruppe = Object.create(null), namen = [];
    liste.forEach(function (p) {
      nachPn[p.pn] = p;
      if (!p.gruppe) return;
      if (!proGruppe[p.gruppe]) { proGruppe[p.gruppe] = []; namen.push(p.gruppe); }
      proGruppe[p.gruppe].push(p);
    });
    namen.sort();
    var gruppen = [];
    namen.forEach(function (n) {
      var ms = proGruppe[n];
      if (ms.length < 2) { ms.forEach(function (p) { p.gruppe = ""; }); return; }
      ms.forEach(function (p) {
        p.partner = ms.filter(function (x) { return x !== p; }).map(function (x) { return x.pn; });
      });
      gruppen.push({ name: n, mitglieder: ms.map(function (p) { return p.pn; }) });
    });
    return { liste: liste, nachPn: nachPn, gruppen: gruppen };
  }

  function verfuegbarFuer(person, slot) {
    if (person.verf[slot.datum + "|" + slot.schicht_id]) return true;
    // LANG schließt SPAET ein
    return slot.schicht_id === "SPAET" && !!person.verf[slot.datum + "|LANG"];
  }

  // ---------- Regelprüfung für das Hinzufügen einer Schicht ----------
  // opt.keinDoppel: keine zweite Schicht am selben Tag zulassen
  function pruefeHinzufuegen(person, slot, zugewiesen, opt) {
    opt = opt || {};
    if (!verfuegbarFuer(person, slot)) return { ok: false, grund: "nicht_verfuegbar" };
    // Die Wunschgrenze ist weich (Stufe 2 der Rangfolge), keine harte Regel.
    var ueber = zugewiesen.length + 1 > person.limit;
    var doppelt = false;
    var tagMin = slot.dauer;
    var wocheMin = slot.dauer;
    for (var i = 0; i < zugewiesen.length; i++) {
      var a = zugewiesen[i];
      wocheMin += a.dauer;
      if (a.datum === slot.datum) {
        if (opt.keinDoppel) return { ok: false, grund: "doppel" };
        if (a.schicht_id === slot.schicht_id) return { ok: false, grund: "doppel" };
        if (a.start < slot.end && slot.start < a.end) return { ok: false, grund: "ueberlappung" };
        tagMin += a.dauer;
        doppelt = true;
      } else {
        var luecke = a.end <= slot.start ? slot.start - a.end :
          slot.end <= a.start ? a.start - slot.end : -1;
        if (luecke < RUHEZEIT_MIN) return { ok: false, grund: "ruhezeit" };
      }
    }
    if (tagMin > MAX_TAG_MIN) return { ok: false, grund: "tagesgrenze" };
    if (wocheMin > person.wocheMaxMin) return { ok: false, grund: "wochengrenze" };
    return { ok: true, doppelt: doppelt, ueber: ueber };
  }

  function lexKleiner(a, b) {
    for (var i = 0; i < a.length; i++) {
      if (a[i] < b[i]) return true;
      if (a[i] > b[i]) return false;
    }
    return false;
  }

  // ---------- Modell: Zustand, Bewertung, Züge ----------
  // Ein Modell gehört zu einer Eingabe und einer Slot-Liste. Personen und
  // Plätze sind durchnummeriert; Plätze derselben Schicht (Tag, Art) sind
  // gleichwertig. Bewertet wird inkrementell gegen den gespeicherten Stand.
  function Modell(eingabe, slots) {
    var P = personenBauen(eingabe.personen || []);
    var pers = P.liste, N = pers.length, S = slots.length;
    var i, j, k, p, d, s;

    var pnIdx = Object.create(null);
    for (p = 0; p < N; p++) pnIdx[pers[p].pn] = p;
    var slotIdx = Object.create(null);
    for (s = 0; s < S; s++) slotIdx[slots[s].id] = s;

    // Tage (nur Tage mit Plätzen)
    var tage = [], tagVon = Object.create(null);
    for (s = 0; s < S; s++) {
      if (tagVon[slots[s].datum] === undefined) { tagVon[slots[s].datum] = 0; tage.push(slots[s].datum); }
    }
    tage.sort();
    for (d = 0; d < tage.length; d++) tagVon[tage[d]] = d;
    var D = tage.length;

    // Schichten (Tag, Art)
    var K = 0, kVon = Object.create(null);
    var kTag = [], kBit = [], kDauer = [], kStart = [], kEnde = [], kSlots = [], kAnz = [];
    var slotK = new Int32Array(S), slotTag = new Int32Array(S), slotLuecke = new Int32Array(S);
    for (s = 0; s < S; s++) {
      var sl = slots[s], key = sl.datum + "|" + sl.schicht_id;
      k = kVon[key];
      if (k === undefined) {
        k = kVon[key] = K++;
        kTag.push(tagVon[sl.datum]); kBit.push(BIT[sl.schicht_id] || 0);
        kDauer.push(sl.dauer); kStart.push(sl.start); kEnde.push(sl.end);
        kSlots.push([]); kAnz.push(0);
      }
      kSlots[k].push(s); kAnz[k]++;
      slotK[s] = k; slotTag[s] = tagVon[sl.datum];
      slotLuecke[s] = sl.schicht_id === "LANG" ? LUECKE_OFFICE : LUECKE_REGULAER;
    }
    var kVonTagBit = new Int32Array(D * 8).fill(-1);
    for (k = 0; k < K; k++) kVonTagBit[kTag[k] * 8 + kBit[k]] = k;

    // Verträglichkeit zweier Schichten bei derselben Person
    // (gleicher Tag: keine Überschneidung; verschiedene Tage: Ruhezeit)
    var vertr = new Uint8Array(K * K);
    for (var a = 0; a < K; a++) {
      for (var b = 0; b < K; b++) {
        if (a === b) continue;
        var ok;
        if (kTag[a] === kTag[b]) ok = kEnde[a] <= kStart[b] || kEnde[b] <= kStart[a];
        else {
          var gap = kEnde[a] <= kStart[b] ? kStart[b] - kEnde[a] :
            kEnde[b] <= kStart[a] ? kStart[a] - kEnde[b] : -1;
          ok = gap >= RUHEZEIT_MIN;
        }
        vertr[a * K + b] = ok ? 1 : 0;
      }
    }

    // Mögliche gemeinsame Schichtarten eines Tages (für den Gruppenwechsel)
    var tauTag = [];
    for (d = 0; d < D; d++) {
      var bits = [], liste = [];
      for (var t = 1; t <= 4; t <<= 1) if (kVonTagBit[d * 8 + t] >= 0) bits.push(t);
      bits.forEach(function (x) { liste.push(x); });
      liste.push(0);
      for (i = 0; i < bits.length; i++) {
        for (j = i + 1; j < bits.length; j++) {
          var ka = kVonTagBit[d * 8 + bits[i]], kb = kVonTagBit[d * 8 + bits[j]];
          if (vertr[ka * K + kb] && kDauer[ka] + kDauer[kb] <= MAX_TAG_MIN) liste.push(bits[i] | bits[j]);
        }
      }
      tauTag.push(liste);
    }

    // Personen-Eigenschaften und Verfügbarkeit
    var lim = new Float64Array(N), teil = new Uint8Array(N), wmax = new Float64Array(N);
    var anzVerf = new Int32Array(N), grp = new Int32Array(N).fill(-1);
    var verfK = new Uint8Array(N * K), verfTag = new Int32Array(N * D);
    var kand = [];
    for (k = 0; k < K; k++) kand.push([]);
    for (p = 0; p < N; p++) {
      lim[p] = pers[p].limit;
      teil[p] = pers[p].kategorie === "teilzeit" ? 1 : 0;
      wmax[p] = pers[p].wocheMaxMin;
      anzVerf[p] = pers[p].anzahlVerf;
      for (k = 0; k < K; k++) {
        if (verfuegbarFuer(pers[p], slots[kSlots[k][0]])) {
          verfK[p * K + k] = 1;
          verfTag[p * D + kTag[k]] |= kBit[k];
          kand[k].push(p);
        }
      }
    }

    // Gruppen und Paare
    var G = P.gruppen.length, gMitglieder = [], gName = [], gPaare = [];
    var paarA = [], paarB = [], paarG = [];
    for (var g = 0; g < G; g++) {
      var ms = P.gruppen[g].mitglieder.map(function (pn) { return pnIdx[pn]; });
      gMitglieder.push(ms); gName.push(P.gruppen[g].name); gPaare.push([]);
      for (i = 0; i < ms.length; i++) grp[ms[i]] = g;
      for (i = 0; i < ms.length; i++) {
        for (j = i + 1; j < ms.length; j++) {
          gPaare[g].push(paarA.length);
          paarA.push(ms[i]); paarB.push(ms[j]); paarG.push(g);
        }
      }
    }
    var PA = paarA.length;
    var pPaare = [];
    for (p = 0; p < N; p++) pPaare.push([]);
    for (i = 0; i < PA; i++) { pPaare[paarA[i]].push(i); pPaare[paarB[i]].push(i); }

    // ----- Zustand -----
    var halter = new Int32Array(S).fill(-1);   // -1 leer, -2 unbekannte Pn, sonst Person
    var fest = new Uint8Array(S);
    var pl = [];                                // Plätze je Person, aufsteigend
    for (p = 0; p < N; p++) pl.push([]);
    var anz = new Int32Array(N), minW = new Int32Array(N);
    var pk = new Int32Array(N * K);
    var tagMaske = new Int32Array(N * D), tagAnz = new Int32Array(N * D), tagMin = new Int32Array(N * D);
    var gk = new Int32Array(Math.max(1, G * K));   // Mitglieder der Gruppe g auf Schicht k

    function setze(s, q) {
      var r = halter[s];
      if (r === q) return;
      var k = slotK[s], d = slotTag[s], du = kDauer[k], i, x;
      if (r >= 0) {
        var l = pl[r];
        for (i = 0; i < l.length; i++) if (l[i] === s) break;
        for (; i < l.length - 1; i++) l[i] = l[i + 1];
        l.length--;
        anz[r]--; minW[r] -= du;
        x = r * D + d; tagAnz[x]--; tagMin[x] -= du;
        if (--pk[r * K + k] === 0) {
          tagMaske[x] &= ~kBit[k];
          if (grp[r] >= 0) gk[grp[r] * K + k]--;
        }
      }
      halter[s] = q;
      if (q >= 0) {
        var l2 = pl[q], n = l2.length;
        l2.push(s);
        while (n > 0 && l2[n - 1] > s) { l2[n] = l2[n - 1]; n--; }
        l2[n] = s;
        anz[q]++; minW[q] += du;
        x = q * D + d; tagAnz[x]++; tagMin[x] += du;
        if (pk[q * K + k]++ === 0) {
          tagMaske[x] |= kBit[k];
          if (grp[q] >= 0) gk[grp[q] * K + k]++;
        }
      }
    }

    // Änderungsprotokoll für Züge (Rücknahme in umgekehrter Reihenfolge)
    var logS = new Int32Array(1024), logAlt = new Int32Array(1024), nLog = 0;
    function aendere(s, q) {
      if (nLog === logS.length) {   // selten: sehr großer Bedarf – Protokoll vergrößern
        var a = new Int32Array(nLog * 2), b = new Int32Array(nLog * 2);
        a.set(logS); b.set(logAlt); logS = a; logAlt = b;
      }
      logS[nLog] = s; logAlt[nLog] = halter[s]; nLog++; setze(s, q);
    }
    function zurueckBis(n) { while (nLog > n) { nLog--; setze(logS[nLog], logAlt[nLog]); } }

    // ----- harte Regeln -----
    function kannDazuK(p, k) {   // darf p zusätzlich einen Platz der Schicht k übernehmen?
      if (!verfK[p * K + k] || pk[p * K + k]) return false;
      var du = kDauer[k];
      if (tagMin[p * D + kTag[k]] + du > MAX_TAG_MIN || minW[p] + du > wmax[p]) return false;
      var l = pl[p];
      for (var i = 0; i < l.length; i++) if (!vertr[k * K + slotK[l[i]]]) return false;
      return true;
    }
    function neuOk(s, q) {       // q hält s bereits (Endzustand eines Zuges)
      var k = slotK[s];
      if (!verfK[q * K + k] || pk[q * K + k] > 1) return false;
      var l = pl[q];
      for (var i = 0; i < l.length; i++) {
        var b = l[i];
        if (b !== s && !vertr[k * K + slotK[b]]) return false;
      }
      return tagMin[q * D + slotTag[s]] <= MAX_TAG_MIN && minW[q] <= wmax[q];
    }
    function zulaessig() {
      for (var i = 0; i < nLog; i++) {
        var s = logS[i], q = halter[s];
        if (q >= 0 && q !== logAlt[i] && !neuOk(s, q)) return false;
      }
      return true;
    }

    // ----- Kosten -----
    function uVon(p) { var x = anz[p] - lim[p]; return x > 0 ? x : 0; }
    function tzVon(p) { return teil[p] ? -minW[p] : 0; }
    function wVon(p) {
      var w = teil[p] ? 0 : minW[p] * minW[p], f = 0, sp = 0, b = p * D;
      for (var d = 0; d < D; d++) {
        if (tagAnz[b + d] > 1) w += W_DOPPEL;
        var m = tagMaske[b + d];
        f |= m & 1; sp |= m & 6;
      }
      if (f && sp) w += W_MISCHUNG;
      return w;
    }
    // koennte(x, eigene, andere, d, t) aus dem Vertrag, für alle t in tBits
    function koennte(x, eigene, eigeneExtra, d, tBits, g) {
      var av = verfTag[x * D + d] & tBits;
      if (!av) return false;
      for (var t = 1; t <= 4; t <<= 1) {
        if (!(av & t)) continue;
        var k = kVonTagBit[d * 8 + t];
        if (k < 0 || gk[g * K + k] >= kAnz[k]) continue;          // kein Platz mehr für die Gruppe
        if (eigene === 0) {
          if (anz[x] + 1 <= lim[x] && minW[x] + kDauer[k] <= wmax[x]) return true;   // käme neu dazu
        } else if (eigeneExtra !== 0) return true;                 // könnte wechseln
      }
      return false;
    }
    function getrennt(pi, d) {
      var p = paarA[pi], q = paarB[pi];
      var A = tagMaske[p * D + d], B = tagMaske[q * D + d];
      if (A === B) return 0;
      var nurA = A & ~B, nurB = B & ~A, g = paarG[pi];
      if (nurA !== 0 && koennte(q, B, nurB, d, nurA, g)) return 1;
      if (nurB !== 0 && koennte(p, A, nurA, d, nurB, g)) return 1;
      return 0;
    }

    var cU = new Float64Array(N), cTZ = new Float64Array(N), cW = new Float64Array(N);
    var cAnz = new Int32Array(N), cMin = new Int32Array(N);   // Anzahl/Minuten im gespeicherten Stand
    var cT = new Uint8Array(Math.max(1, PA * D));
    var gesL = 0, gesU = 0, gesT = 0, gesTZ = 0, gesW = 0;
    var dauern = [];   // verschiedene Schichtdauern (für den Spielraum-Wechsel)
    for (k = 0; k < K; k++) if (dauern.indexOf(kDauer[k]) < 0) dauern.push(kDauer[k]);

    function neuBerechnen() {
      gesL = 0; gesU = 0; gesT = 0; gesTZ = 0; gesW = 0;
      for (var s = 0; s < S; s++) if (halter[s] === -1) gesL += slotLuecke[s];
      for (var p = 0; p < N; p++) {
        cU[p] = uVon(p); cTZ[p] = tzVon(p); cW[p] = wVon(p); cAnz[p] = anz[p]; cMin[p] = minW[p];
        gesU += cU[p]; gesTZ += cTZ[p]; gesW += cW[p];
      }
      for (var pi = 0; pi < PA; pi++) {
        for (var d = 0; d < D; d++) { var t = getrennt(pi, d); cT[pi * D + d] = t; gesT += t; }
      }
      nLog = 0;
    }

    // Inkrementelle Bewertung des protokollierten Zuges gegen den Stand.
    // Ein Paar-Tag kann sich nur ändern, wenn an diesem Tag ein Platz eines
    // Gruppenmitglieds wechselt (Arten, Kapazität) oder wenn bei einem der
    // beiden der Spielraum "Anzahl+1 ≤ Wunsch und Minuten+Dauer ≤ 48 h" kippt.
    var mark = new Int32Array(N), sMark = new Int32Array(Math.max(1, S));
    var epoche = 0, betr = new Int32Array(Math.max(1, N)), nBetr = 0;
    var pdMark = new Int32Array(Math.max(1, PA * D)), pdListe = new Int32Array(Math.max(1, PA * D)), nPD = 0;
    var neuU = new Float64Array(N), neuTZ = new Float64Array(N), neuW = new Float64Array(N);
    var neuT = new Uint8Array(Math.max(1, PA * D));
    var dL = 0, dU = 0, dT = 0, dTZ = 0, dW = 0;

    function betroffen(p) {
      if (p < 0 || mark[p] === epoche) return;
      mark[p] = epoche; betr[nBetr++] = p;
    }
    function tagMarkieren(h, d) {
      var g = grp[h];
      if (g < 0) return;
      var pp = gPaare[g];
      for (var j = 0; j < pp.length; j++) {
        var x = pp[j] * D + d;
        if (pdMark[x] !== epoche) { pdMark[x] = epoche; pdListe[nPD++] = x; }
      }
    }
    function spielraumKippt(p) {
      var a0 = cAnz[p] + 1 <= lim[p], a1 = anz[p] + 1 <= lim[p];
      if (!a0 && !a1) return false;
      for (var i = 0; i < dauern.length; i++) {
        if ((a0 && cMin[p] + dauern[i] <= wmax[p]) !== (a1 && minW[p] + dauern[i] <= wmax[p])) return true;
      }
      return false;
    }
    function bewerte() {   // -1 besser, 0 gleich, 1 schlechter
      epoche++; nBetr = 0; nPD = 0;
      dL = 0; dU = 0; dT = 0; dTZ = 0; dW = 0;
      var i, j, d, p, x;
      for (i = 0; i < nLog; i++) {
        var s = logS[i], alt = logAlt[i], neu = halter[s];
        d = slotTag[s];
        if (sMark[s] !== epoche) {
          sMark[s] = epoche;
          if (alt === -1 && neu !== -1) dL -= slotLuecke[s];
          else if (alt !== -1 && neu === -1) dL += slotLuecke[s];
        }
        if (alt >= 0) { betroffen(alt); tagMarkieren(alt, d); }
        if (neu >= 0) { betroffen(neu); tagMarkieren(neu, d); }
      }
      for (i = 0; i < nBetr; i++) {
        p = betr[i];
        var u = uVon(p), tz = tzVon(p), w = wVon(p);
        neuU[p] = u; neuTZ[p] = tz; neuW[p] = w;
        dU += u - cU[p]; dTZ += tz - cTZ[p]; dW += w - cW[p];
        if (grp[p] >= 0 && spielraumKippt(p)) {
          var pp = pPaare[p];
          for (j = 0; j < pp.length; j++) {
            for (d = 0; d < D; d++) {
              x = pp[j] * D + d;
              if (pdMark[x] !== epoche) { pdMark[x] = epoche; pdListe[nPD++] = x; }
            }
          }
        }
      }
      for (i = 0; i < nPD; i++) {
        x = pdListe[i];
        var pi = (x / D) | 0, t = getrennt(pi, x - pi * D);
        neuT[x] = t; dT += t - cT[x];
      }
      if (dL !== 0) return dL < 0 ? -1 : 1;
      if (dU !== 0) return dU < 0 ? -1 : 1;
      if (dT !== 0) return dT < 0 ? -1 : 1;
      if (dTZ !== 0) return dTZ < 0 ? -1 : 1;
      if (dW !== 0) return dW < 0 ? -1 : 1;
      return 0;
    }
    function uebernehme() {   // nach bewerte(): Zug festschreiben
      var i;
      for (i = 0; i < nBetr; i++) {
        var p = betr[i];
        cU[p] = neuU[p]; cTZ[p] = neuTZ[p]; cW[p] = neuW[p]; cAnz[p] = anz[p]; cMin[p] = minW[p];
      }
      for (i = 0; i < nPD; i++) cT[pdListe[i]] = neuT[pdListe[i]];
      gesL += dL; gesU += dU; gesT += dT; gesTZ += dTZ; gesW += dW;
      nLog = 0;
    }
    function deltaVektor() { return [dL, dU, dT, dTZ, dW]; }

    // ----- Laden -----
    function laden(zuw) {
      for (var s = 0; s < S; s++) {
        var v = zuw ? zuw[slots[s].id] : null;
        if (v === null || v === undefined || v === "") continue;
        var q = pnIdx[String(v)];
        if (q === undefined) { halter[s] = -2; fest[s] = 1; continue; }
        setze(s, q);
      }
      neuBerechnen();
    }
    function festSetzen(f) {
      Object.keys(f || {}).forEach(function (id) {
        var s = slotIdx[id];
        if (s === undefined) return;
        var q = pnIdx[String(f[id])];
        if (q === undefined) return;
        setze(s, q); fest[s] = 1;
      });
    }

    // ----- Hilfen für die Züge -----
    function ersterLeer(k) {
      var l = kSlots[k];
      for (var i = 0; i < l.length; i++) if (halter[l[i]] === -1 && !fest[l[i]]) return l[i];
      return -1;
    }
    function tagesSlots(m, d) {
      var out = [], l = pl[m];
      for (var i = 0; i < l.length; i++) if (slotTag[l[i]] === d) out.push(l[i]);
      return out;
    }
    function partnerVon(pi, p) { return paarA[pi] === p ? paarB[pi] : paarA[pi]; }

    var auswertungen = 0, budget = 0, abbruch = false;
    function besuchLoesen() {
      if (++auswertungen > budget) { abbruch = true; return 2; }
      if (!zulaessig()) return 0;
      if (bewerte() < 0) { uebernehme(); return 1; }
      return 0;
    }

    // Reparaturkette: s geht an q; ist q Fahrgemeinschaftsmitglied, über
    // seinem Wunsch oder im Konflikt mit s (gleicher Tag / Ruhezeit), darf q
    // einen anderen Platz b abgeben, der an jemand anderen oder leer geht –
    // bis Tiefe 3. Bewertet wird nur der jeweilige Gesamtzustand.
    // Rückgabe: 0 weiter, 1 übernommen (Zustand bleibt), 2 Abbruch.
    var puffer = new Int32Array((KETTE_TIEFE + 2) * (S + 1));
    function kette(s, q, tiefe, besuch) {
      var n0 = nLog;
      aendere(s, q);
      var r = besuch();
      if (r === 1) return 1;
      if (r === 0 && tiefe < KETTE_TIEFE && q >= 0) {
        var mitglied = grp[q] >= 0, ueber = anz[q] > lim[q];
        var basis = tiefe * (S + 1), m = 0, l = pl[q], ks = slotK[s];
        for (var i = 0; i < l.length; i++) puffer[basis + m++] = l[i];
        for (i = 0; i < m && r === 0; i++) {
          var b = puffer[basis + i];
          if (b === s || fest[b] || halter[b] !== q) continue;
          var konflikt = slotTag[b] === slotTag[s] || !vertr[ks * K + slotK[b]];
          if (!(mitglied || ueber || konflikt)) continue;
          var kb = slotK[b], kl = kand[kb];
          for (var j = 0; j < kl.length && r === 0; j++) {
            var z = kl[j];
            if (z === q || pk[z * K + kb]) continue;
            r = kette(b, z, tiefe + 1, besuch);
          }
          if (r === 0) r = kette(b, -1, tiefe + 1, besuch);
        }
        if (r === 1) return 1;
      }
      zurueckBis(n0);
      return r;
    }

    // m übernimmt einen Platz der Schicht k (leer oder von jemand anderem)
    function aufSchicht(k, m, besuch) {
      var l = kSlots[k], leer = false, r;
      for (var i = 0; i < l.length; i++) {
        var s = l[i], h = halter[s];
        if (fest[s] || h === -2 || h === m) continue;
        if (h === -1) { if (leer) continue; leer = true; }
        r = kette(s, m, 1, besuch);
        if (r) return r;
      }
      return 0;
    }

    // Frei gewordene Plätze bekommt jeweils der beste Kandidat (oder keiner)
    function bestBesetzen(frei, ausserGruppe) {
      for (var i = 0; i < frei.length; i++) {
        var s = frei[i];
        if (halter[s] !== -1) continue;
        var k = slotK[s], kl = kand[k], best = -1, bv = null;
        for (var j = 0; j < kl.length; j++) {
          var z = kl[j];
          if ((ausserGruppe >= 0 && grp[z] === ausserGruppe) || !kannDazuK(z, k)) continue;
          var n0 = nLog;
          aendere(s, z); auswertungen++; bewerte();
          var vec = deltaVektor();
          zurueckBis(n0);
          if (best < 0 || lexKleiner(vec, bv)) { best = z; bv = vec; }
        }
        if (best >= 0) aendere(s, best);
      }
    }

    // Blockzug: x verlegt seine Schichtarten von Tag d1 auf Tag d2 (dort frei).
    // Wer dort verdrängt wird, rückt auf einen frei gewordenen Platz an d1;
    // übrige frei gewordene Plätze bekommt der beste Kandidat.
    function blockZug(x, d1, d2, besuch) {
      var tau = tagMaske[x * D + d1];
      if (!tau || tagMaske[x * D + d2]) return 0;
      var weg = tagesSlots(x, d1), i, t, r;
      for (i = 0; i < weg.length; i++) if (fest[weg[i]]) return 0;
      var opt = [];
      for (t = 1; t <= 4; t <<= 1) {
        if (!(tau & t)) continue;
        var k2 = kVonTagBit[d2 * 8 + t];
        if (k2 < 0 || !verfK[x * K + k2]) return 0;
        var o = [], leer = false, l = kSlots[k2];
        for (var j = 0; j < l.length; j++) {
          var s = l[j], h = halter[s];
          if (fest[s] || h === -2) continue;
          if (h === -1) { if (leer) continue; leer = true; }
          o.push(s);
        }
        if (!o.length) return 0;
        opt.push(o);
      }
      var idx = [];
      for (i = 0; i < opt.length; i++) idx.push(0);
      for (;;) {
        var n0 = nLog, verdraengt = [];
        for (i = 0; i < weg.length; i++) aendere(weg[i], -1);
        for (i = 0; i < opt.length; i++) {
          var c = opt[i][idx[i]], hh = halter[c];
          aendere(c, x);
          if (hh >= 0) verdraengt.push(hh);
        }
        r = zuordnen(verdraengt, 0, weg, besuch);
        if (r === 1) return 1;
        zurueckBis(n0);
        if (r === 2) return 2;
        for (i = 0; i < opt.length; i++) {
          if (++idx[i] < opt[i].length) break;
          idx[i] = 0;
        }
        if (i === opt.length) return 0;
      }
    }
    function zuordnen(H, i, V, besuch) {
      var r;
      if (i === H.length) {
        var n2 = nLog;
        bestBesetzen(V, -1);
        r = besuch();
        if (r === 1) return 1;
        zurueckBis(n2);
        return r;
      }
      var h = H[i];
      for (var j = 0; j < V.length; j++) {
        var v = V[j];
        if (halter[v] !== -1 || !kannDazuK(h, slotK[v])) continue;
        var n1 = nLog;
        aendere(v, h);
        r = zuordnen(H, i + 1, V, besuch);
        if (r === 1) return 1;
        zurueckBis(n1);
        if (r === 2) return 2;
      }
      return zuordnen(H, i + 1, V, besuch);
    }

    // Fenster: Fahrgemeinschaft g plus Nachbarn (wer eine Schicht der Tage dA/dB
    // übernehmen könnte, deren Inhaber, usw., höchstens FENSTER_P Personen).
    // Deren Plätze an dA/dB (und leere Plätze dort) werden exakt neu verteilt;
    // nie mehr leere Plätze als vorher. blatt(F) wird je vollständiger
    // Belegung gerufen (Rückgabe 2 = Abbruch).
    function fenster(g, dA, dB, blatt, knotenMax) {
      var inX = new Uint8Array(N), X = [], i, j, k, l, h;
      var ms = gMitglieder[g];
      for (i = 0; i < ms.length; i++) { X.push(ms[i]); inX[ms[i]] = 1; }
      for (i = 0; i < X.length && X.length < FENSTER_P; i++) {
        var y = X[i];
        for (k = 0; k < K && X.length < FENSTER_P; k++) {
          if ((kTag[k] !== dA && kTag[k] !== dB) || !verfK[y * K + k]) continue;
          l = kSlots[k];
          for (j = 0; j < l.length && X.length < FENSTER_P; j++) {
            h = halter[l[j]];
            if (h >= 0 && !inX[h] && !fest[l[j]]) { inX[h] = 1; X.push(h); }
          }
        }
      }
      var F = [], lOrig = 0, s;
      for (s = 0; s < S; s++) {
        if (fest[s] || (slotTag[s] !== dA && slotTag[s] !== dB)) continue;
        h = halter[s];
        if (h === -1) { F.push(s); lOrig += slotLuecke[s]; }
        else if (h >= 0 && inX[h]) F.push(s);
      }
      var pos = new Int32Array(N);
      for (i = 0; i < X.length; i++) pos[X[i]] = i;
      var n0 = nLog, knoten = 0, stopp = false;
      if (knotenMax > FENSTER_KNOTEN) knotenMax = FENSTER_KNOTEN;
      for (i = 0; i < F.length; i++) if (halter[F[i]] !== -1) aendere(F[i], -1);
      function rec(i, lp) {
        if (++knoten > knotenMax) { stopp = true; return; }
        if (i === F.length) { if (blatt(F) === 2) stopp = true; return; }
        var s = F[i], k = slotK[s], ab = 0;
        if (i > 0 && slotK[F[i - 1]] === k) {   // gleichwertige Plätze: Reihenfolge fest
          var vh = halter[F[i - 1]];
          if (vh === -1) { if (lp + slotLuecke[s] <= lOrig) rec(i + 1, lp + slotLuecke[s]); return; }
          ab = pos[vh] + 1;
        }
        for (var xi = ab; xi < X.length && !stopp; xi++) {
          var x = X[xi];
          if (!kannDazuK(x, k)) continue;
          aendere(s, x);
          rec(i + 1, lp);
          zurueckBis(nLog - 1);
        }
        if (!stopp && lp + slotLuecke[s] <= lOrig) rec(i + 1, lp + slotLuecke[s]);
      }
      rec(0, 0);
      zurueckBis(n0);
      return { stopp: stopp, knoten: knoten };
    }
    // Bestes Fenster-Ergebnis übernehmen, falls es den Kostenvektor senkt
    var fensterRest = 0;
    function fensterLoesen(g, dA, dB) {
      if (fensterRest <= 0) return false;
      var bestV = null, bestH = null, Fb = null;
      var e = fenster(g, dA, dB, function (F) {
        if (bewerte() < 0) {
          var v = deltaVektor();
          if (bestV === null || lexKleiner(v, bestV)) {
            bestV = v; Fb = F;
            bestH = F.map(function (s) { return halter[s]; });
          }
        }
        return 0;
      }, fensterRest);
      fensterRest -= e.knoten;
      if (!bestH) return false;
      for (var i = 0; i < Fb.length; i++) if (halter[Fb[i]] !== bestH[i]) aendere(Fb[i], bestH[i]);
      bewerte();
      uebernehme();
      return true;
    }
    // Für verbliebene Trennungen: Fenster über den Tag und einen Nachbartag,
    // danach Nachbessern; alles zusammen höchstens FENSTER_BUDGET Schritte.
    function fensterPhase() {
      fensterRest = FENSTER_BUDGET;
      while (fensterRest > 0) {
        var besser = false;
        for (var pi = 0; pi < PA && !besser && fensterRest > 0; pi++) {
          for (var d = 0; d < D && !besser && fensterRest > 0; d++) {
            if (!cT[pi * D + d]) continue;
            var g = paarG[pi];
            if (d > 0 && fensterLoesen(g, d - 1, d)) besser = true;
            else if (d + 1 < D && fensterLoesen(g, d, d + 1)) besser = true;
            else if (D === 1 && fensterLoesen(g, d, d)) besser = true;
          }
        }
        if (!besser || fensterRest <= 0) break;
        var vorher = auswertungen;
        abbruch = false;
        budget = auswertungen + Math.min(POLITUR, fensterRest);
        verbessere();
        fensterRest -= auswertungen - vorher;
      }
    }

    // m übernimmt zwei Plätze an anderen Tagen zugleich (erreicht so seine
    // Wunschgrenze und "könnte" am Tag d nicht mehr dazukommen)
    function zweiPlaetze(m, d, besuch) {
      var c = [], s, k, h, leerK = [], i, j, r;
      for (s = 0; s < S; s++) {
        k = slotK[s]; h = halter[s];
        if (kTag[k] === d || fest[s] || h === -2 || h === m || !verfK[m * K + k] || pk[m * K + k]) continue;
        if (h === -1) { if (leerK.indexOf(k) >= 0) continue; leerK.push(k); }
        c.push(s);
      }
      for (i = 0; i < c.length; i++) {
        for (j = i + 1; j < c.length; j++) {
          if (slotK[c[i]] === slotK[c[j]]) continue;
          var n0 = nLog;
          aendere(c[i], m); aendere(c[j], m);
          r = besuch();
          if (r === 1) return 1;
          zurueckBis(n0);
          if (r === 2) return 2;
        }
      }
      return 0;
    }

    // Zwei Mitglieder einer Fahrgemeinschaft übernehmen zugleich zwei Plätze
    // derselben Schicht (nurTag < 0: alle Tage)
    function gruppenPaar(g, nurTag, besuch) {
      var ms = gMitglieder[g], c = [], r;
      for (var i = 0; i < ms.length; i++) {
        for (var j = i + 1; j < ms.length; j++) {
          var m1 = ms[i], m2 = ms[j];
          for (var k = 0; k < K; k++) {
            if (nurTag >= 0 && kTag[k] !== nurTag) continue;
            if (!verfK[m1 * K + k] || !verfK[m2 * K + k] || pk[m1 * K + k] || pk[m2 * K + k]) continue;
            c.length = 0;
            var leer = 0, l = kSlots[k], x, y;
            for (x = 0; x < l.length; x++) {
              var s = l[x], h = halter[s];
              if (fest[s] || h === -2) continue;
              if (h === -1) { if (leer >= 2) continue; leer++; }
              else if (grp[h] === g) continue;
              c.push(s);
            }
            for (x = 0; x < c.length; x++) {
              for (y = x + 1; y < c.length; y++) {
                var n0 = nLog;
                aendere(c[x], m1); aendere(c[y], m2);
                r = besuch();
                if (r === 1) return 1;
                zurueckBis(n0);
                if (r === 2) return 2;
              }
            }
          }
        }
      }
      return 0;
    }

    // Die ganze Fahrgemeinschaft arbeitet an Tag d gemeinsam die Arten tau
    // (soweit verfügbar); bisherige Inhaber rücken auf frei gewordene Plätze,
    // übrige frei gewordene Plätze bekommt der jeweils beste Kandidat.
    function gruppenWechsel(g, d, tau, besuch) {
      var n0 = nLog, ms = gMitglieder[g], frei = [], i, j, m, s, l, k, t, ziel;
      for (i = 0; i < ms.length; i++) {
        m = ms[i]; ziel = tau & verfTag[m * D + d];
        l = tagesSlots(m, d);
        for (j = 0; j < l.length; j++) {
          s = l[j];
          if (kBit[slotK[s]] & ziel) continue;
          if (fest[s]) { zurueckBis(n0); return 0; }
          aendere(s, -1); frei.push(s);
        }
      }
      var geaendert = frei.length > 0;
      for (i = 0; i < ms.length; i++) {
        m = ms[i]; ziel = tau & verfTag[m * D + d];
        for (t = 1; t <= 4; t <<= 1) {
          if (!(ziel & t)) continue;
          k = kVonTagBit[d * 8 + t];
          if (k < 0 || pk[m * K + k] || !kannDazuK(m, k)) continue;
          s = ersterLeer(k);
          if (s >= 0) { aendere(s, m); geaendert = true; continue; }
          var kl = kSlots[k], erster = -1, erledigt = false;
          for (j = 0; j < kl.length && !erledigt; j++) {
            var s2 = kl[j], h = halter[s2];
            if (fest[s2] || h < 0 || grp[h] === g) continue;
            if (erster < 0) erster = s2;
            var n1 = nLog;
            aendere(s2, m);
            for (var f = 0; f < frei.length; f++) {
              var v = frei[f];
              if (halter[v] === -1 && kannDazuK(h, slotK[v])) { aendere(v, h); erledigt = true; break; }
            }
            if (!erledigt) zurueckBis(n1);
          }
          if (!erledigt && erster >= 0) { aendere(erster, m); erledigt = true; }
          if (erledigt) geaendert = true;
        }
      }
      if (!geaendert) { zurueckBis(n0); return 0; }
      bestBesetzen(frei, g);
      var r = besuch();
      if (r === 1) return 1;
      zurueckBis(n0);
      return r;
    }

    // Reparaturversuche für ein getrenntes Paar pi an Tag d
    function paarZuege(pi, d, besuch, mitLeer) {
      var g = paarG[pi], ms = [paarA[pi], paarB[pi]], r, mi, m, k, t, l, i, j;
      // dazukommen: ein Mitglied übernimmt am Tag einen leeren oder fremden Platz
      for (mi = 0; mi < 2; mi++) {
        m = ms[mi];
        for (t = 1; t <= 4; t <<= 1) {
          k = kVonTagBit[d * 8 + t];
          if (k < 0 || !verfK[m * K + k] || pk[m * K + k]) continue;
          r = aufSchicht(k, m, besuch);
          if (r) return r;
        }
      }
      // gehen: ein Außenstehender übernimmt den Platz eines Mitglieds
      for (mi = 0; mi < 2; mi++) {
        m = ms[mi];
        l = tagesSlots(m, d);
        for (i = 0; i < l.length; i++) {
          var s = l[i];
          if (fest[s] || halter[s] !== m) continue;
          k = slotK[s];
          var kl = kand[k];
          for (j = 0; j < kl.length; j++) {
            var o = kl[j];
            if (grp[o] === g || pk[o * K + k]) continue;
            r = kette(s, o, 1, besuch);
            if (r) return r;
          }
          if (mitLeer) { r = kette(s, -1, 1, besuch); if (r) return r; }
        }
      }
      // Wunschgrenze: ein Mitglied übernimmt einen Platz an einem anderen Tag
      for (mi = 0; mi < 2; mi++) {
        m = ms[mi];
        for (k = 0; k < K; k++) {
          if (kTag[k] === d || !verfK[m * K + k] || pk[m * K + k]) continue;
          r = aufSchicht(k, m, besuch);
          if (r) return r;
        }
      }
      r = gruppenPaar(g, d, besuch);
      if (r) return r;
      var taus = tauTag[d];
      for (i = 0; i < taus.length; i++) {
        r = gruppenWechsel(g, d, taus[i], besuch);
        if (r) return r;
      }
      // Blockzüge aller Mitglieder auf den Tag d bzw. von ihm weg
      var gm = gMitglieder[g];
      for (i = 0; i < gm.length; i++) {
        for (var d2 = 0; d2 < D; d2++) {
          if (d2 === d) continue;
          r = blockZug(gm[i], d2, d, besuch);
          if (r) return r;
          r = blockZug(gm[i], d, d2, besuch);
          if (r) return r;
        }
      }
      // Wunschgrenze in zwei Schritten
      for (mi = 0; mi < 2; mi++) {
        m = ms[mi];
        if (lim[m] - anz[m] !== 2) continue;
        r = zweiPlaetze(m, d, besuch);
        if (r) return r;
      }
      return 0;
    }

    // ----- Aufbau -----
    function mischt(p, k) {
      var f = 0, sp = 0;
      for (var d = 0; d < D; d++) { var m = tagMaske[p * D + d]; f |= m & 1; sp |= m & 6; }
      return kBit[k] === 1 ? sp !== 0 : f !== 0;
    }
    function ziehbar(q, k) {
      return tagAnz[q * D + kTag[k]] === 0 && anz[q] + 1 <= lim[q] && kannDazuK(q, k);
    }
    // Partner, die getrennt würden und nicht nachgezogen werden können,
    // minus Partner, die schon auf derselben Schicht sind
    function partnerSchluessel(p, s) {
      var pp = pPaare[p];
      if (!pp.length) return 0;
      var k = slotK[s], d = slotTag[s], x = 0, frei = 0, l = kSlots[k], i;
      setze(s, p);
      for (i = 0; i < l.length; i++) if (halter[l[i]] === -1 && !fest[l[i]]) frei++;
      for (i = 0; i < pp.length; i++) {
        var q = partnerVon(pp[i], p);
        if (pk[q * K + k]) { x--; continue; }
        if (getrennt(pp[i], d)) {
          if (frei > 0 && ziehbar(q, k)) frei--;
          else x++;
        }
      }
      setze(s, -1);
      return x;
    }
    function nachziehen(p, k) {
      var pp = pPaare[p];
      for (var i = 0; i < pp.length; i++) {
        var q = partnerVon(pp[i], p);
        if (pk[q * K + k] || !ziehbar(q, k)) continue;
        var f = ersterLeer(k);
        if (f < 0) return;
        setze(f, q);
      }
    }
    function konstruiere(v) {
      var ord = [], s, i, j;
      for (s = 0; s < S; s++) if (!fest[s] && halter[s] === -1) ord.push(s);
      ord.sort(function (a, b) {
        if (v !== 3) {
          var x = kand[slotK[a]].length - kand[slotK[b]].length;
          if (x !== 0) return x;
          if (slotTag[a] !== slotTag[b]) return v === 1 ? slotTag[b] - slotTag[a] : slotTag[a] - slotTag[b];
        }
        return a - b;
      });
      for (i = 0; i < ord.length; i++) {
        s = ord[i];
        if (halter[s] !== -1) continue;   // schon durch Nachziehen besetzt
        var k = slotK[s], d = slotTag[s], kl = kand[k];
        var best = -1, b0 = 0, b1 = 0, b2 = 0, b3 = 0;
        for (j = 0; j < kl.length; j++) {
          var p = kl[j];
          if (!kannDazuK(p, k)) continue;
          var k0 = anz[p] + 1 > lim[p] ? 1 : 0;
          var k1 = partnerSchluessel(p, s);
          var h = minW[p] / 60;
          var k2 = teil[p] ? -1e6 + h : h;
          if (tagAnz[p * D + d] > 0) k2 += 500;
          if (mischt(p, k)) k2 += 30;
          var k3 = anzVerf[p];
          if (best < 0 || k0 < b0 || (k0 === b0 && (k1 < b1 || (k1 === b1 && (k2 < b2 ||
              (k2 === b2 && (k3 < b3 || (k3 === b3 && v === 2 && p > best)))))))) {
            best = p; b0 = k0; b1 = k1; b2 = k2; b3 = k3;
          }
        }
        if (best >= 0) { setze(s, best); nachziehen(best, k); }
      }
    }

    // ----- Verbesserung -----
    function zugUebernahme() {
      var besser = false;
      for (var s = 0; s < S && !abbruch; s++) {
        if (fest[s] || halter[s] === -2) continue;
        var k = slotK[s];
        if (halter[s] === -1 && ersterLeer(k) !== s) continue;
        var kl = kand[k];
        for (var j = 0; j < kl.length; j++) {
          var q = kl[j];
          if (q === halter[s] || pk[q * K + k]) continue;
          var n0 = nLog;
          aendere(s, q);
          var r = besuchLoesen();
          if (r === 1) { besser = true; continue; }
          zurueckBis(n0);
          if (r === 2) return besser;
        }
      }
      return besser;
    }
    function zugTausch() {
      var besser = false;
      for (var s1 = 0; s1 < S && !abbruch; s1++) {
        if (fest[s1]) continue;
        var r1 = halter[s1];
        if (r1 < 0) continue;
        for (var s2 = s1 + 1; s2 < S; s2++) {
          var r2 = halter[s2];
          if (r2 < 0 || r2 === r1 || fest[s2]) continue;
          var k1 = slotK[s1], k2 = slotK[s2];
          if (k1 === k2 || !verfK[r2 * K + k1] || !verfK[r1 * K + k2] || pk[r2 * K + k1] || pk[r1 * K + k2]) continue;
          var n0 = nLog;
          aendere(s1, r2); aendere(s2, r1);
          var r = besuchLoesen();
          if (r === 1) { besser = true; r1 = halter[s1]; continue; }
          zurueckBis(n0);
          if (r === 2) return besser;
        }
      }
      return besser;
    }
    function zugGruppenpaar() {
      var besser = false;
      for (var g = 0; g < G && !abbruch; g++) {
        var r;
        while ((r = gruppenPaar(g, -1, besuchLoesen)) === 1) besser = true;
        if (r === 2) return besser;
      }
      return besser;
    }
    function zugKetten(nurOben) {
      var besser = false, k, s, j, q, r, p, i, l;
      // 1. leere Plätze
      for (k = 0; k < K && !abbruch; k++) {
        s = ersterLeer(k);
        if (s < 0) continue;
        var kl = kand[k];
        for (j = 0; j < kl.length; j++) {
          q = kl[j];
          if (pk[q * K + k]) continue;
          r = kette(s, q, 1, besuchLoesen);
          if (r === 2) return besser;
          if (r === 1) { besser = true; k--; break; }
        }
      }
      // 2. Plätze von Personen über ihrem Wunsch
      for (p = 0; p < N && !abbruch; p++) {
        if (anz[p] <= lim[p]) continue;
        l = pl[p].slice();
        var weiter = true;
        for (i = 0; i < l.length && weiter && !abbruch; i++) {
          s = l[i];
          if (fest[s] || halter[s] !== p) continue;
          k = slotK[s];
          var kl2 = kand[k];
          for (j = 0; j < kl2.length; j++) {
            q = kl2[j];
            if (q === p || pk[q * K + k]) continue;
            r = kette(s, q, 1, besuchLoesen);
            if (r === 2) return besser;
            if (r === 1) { besser = true; weiter = anz[p] > lim[p]; break; }
          }
        }
      }
      // 3. getrennte Paar-Tage
      for (var pi = 0; pi < PA && !abbruch; pi++) {
        for (var d = 0; d < D && !abbruch; d++) {
          if (!cT[pi * D + d]) continue;
          r = paarZuege(pi, d, besuchLoesen, false);
          if (r === 2) return besser;
          if (r === 1) besser = true;
        }
      }
      // 4. Teilzeit übernimmt Plätze von Minijobbern oder leere Plätze
      for (p = 0; p < N && !abbruch && !nurOben; p++) {
        if (!teil[p]) continue;
        for (s = 0; s < S && !abbruch; s++) {
          var h = halter[s];
          if (fest[s] || h === -2 || h === p || (h >= 0 && teil[h])) continue;
          k = slotK[s];
          if (!verfK[p * K + k] || pk[p * K + k]) continue;
          if (h === -1 && ersterLeer(k) !== s) continue;
          r = kette(s, p, 1, besuchLoesen);
          if (r === 2) return besser;
          if (r === 1) besser = true;
        }
      }
      return besser;
    }
    // nurOben: ohne die (teuren) Teilzeit-Ketten – für den Schlusslauf, der
    // sicherstellt, dass Lücken, Wunschgrenzen und Trennungen ausgereizt sind
    function verbessere(nurOben) {
      for (var runde = 0; runde < MAX_RUNDEN && !abbruch; runde++) {
        var besser = false;
        if (zugUebernahme()) besser = true;
        if (!abbruch && zugTausch()) besser = true;
        if (!abbruch && zugGruppenpaar()) besser = true;
        if (!abbruch && zugKetten(nurOben)) besser = true;
        if (!besser) break;
      }
    }
    // Schlusslauf: jeder leere Platz, den jemand ohne Regelbruch übernehmen
    // kann, wird besetzt (danach gilt: leerer Platz ⇒ keine Alternative).
    function auffuellen() {
      var geaendert = true;
      while (geaendert) {
        geaendert = false;
        for (var k = 0; k < K; k++) {
          var s = ersterLeer(k);
          if (s < 0) continue;
          var kl = kand[k], best = -1, bv = null;
          for (var j = 0; j < kl.length; j++) {
            var q = kl[j];
            if (!kannDazuK(q, k)) continue;
            aendere(s, q); bewerte();
            var vec = deltaVektor();
            zurueckBis(0);
            if (best < 0 || lexKleiner(vec, bv)) { best = q; bv = vec; }
          }
          if (best >= 0) { aendere(s, best); bewerte(); uebernehme(); geaendert = true; }
        }
      }
    }

    function loesen(festIn) {
      festSetzen(festIn);
      var besteK = null, besteH = null, s, vi;
      for (vi = 0; vi < VARIANTEN.length; vi++) {
        for (s = 0; s < S; s++) if (!fest[s] && halter[s] !== -1) setze(s, -1);
        konstruiere(VARIANTEN[vi]);
        neuBerechnen();
        abbruch = false;
        var rest = BUDGET - auswertungen;
        budget = auswertungen + Math.floor(vi === 0 ? rest / 2 : rest / (VARIANTEN.length - vi));
        verbessere();
        auffuellen();
        var kv = [gesL, gesU, gesT, gesTZ, gesW];
        if (!besteK || lexKleiner(kv, besteK)) { besteK = kv; besteH = halter.slice(); }
      }
      for (s = 0; s < S; s++) if (!fest[s] && halter[s] !== -1) setze(s, -1);
      for (s = 0; s < S; s++) if (!fest[s] && besteH[s] >= 0) setze(s, besteH[s]);
      neuBerechnen();
      abbruch = false;
      budget = auswertungen + SCHLUSS;
      verbessere(true);
      if (gesT > 0) fensterPhase();
      auffuellen();
      return kosten();
    }

    // ----- Begründungen -----
    // Neue Probleme des protokollierten Zuges gegenüber dem Stand (nach bewerte()):
    // Rang 3 neue Lücke, 2 neue Überschreitung, 1 neue Trennung
    // Nach bewerte(): Ist der Versuch netto besser auf den Stufen ab eigenRang
    // (3 Lücken, 2 Wunsch, 1 Trennung)? Dann "vermeidbar". Sonst zählt die
    // höchste Stufe, die netto schlechter wird; gemeldet wird das erste neue
    // Problem dieser Stufe (eine nur verschobene Lücke zählt netto nicht).
    function profil(eigenRang) {
      if (dL < 0 || (dL === 0 && (dU < 0 || (dU === 0 && eigenRang <= 1 && dT < 0)))) {
        return { rang: 0, anzahl: 0, detail: { typ: "vermeidbar" } };
      }
      var stufe = dL > 0 ? 3 : (dU > 0 || eigenRang === 2) ? 2 : 1;
      var rang = 0, anzahl = 0, detail = null, i, j, d;
      var ersteLuecke = -1;
      epoche++;
      for (i = 0; i < nLog; i++) {
        var s = logS[i];
        if (sMark[s] === epoche) continue;
        sMark[s] = epoche;
        if (logAlt[i] !== -1 && halter[s] === -1) {
          anzahl++;
          if (ersteLuecke < 0 || s < ersteLuecke) ersteLuecke = s;
        }
      }
      var ersteU = -1;
      for (i = 0; i < nBetr; i++) {
        var p = betr[i];
        if (neuU[p] > cU[p]) { anzahl++; if (ersteU < 0 || p < ersteU) ersteU = p; }
      }
      var ersteT = -1;
      for (i = 0; i < nPD; i++) {
        var x = pdListe[i];
        if (neuT[x] && !cT[x]) {
          anzahl++;
          j = (x / D) | 0; d = x - j * D;
          var key = d * PA + j;
          if (ersteT < 0 || key < ersteT) ersteT = key;
        }
      }
      if (stufe === 3 && ersteLuecke >= 0) { rang = 3; detail = { typ: "luecke", slot: slots[ersteLuecke].id }; }
      else if (stufe >= 2 && ersteU >= 0) {
        rang = 2; detail = { typ: "limit", pn: pers[ersteU].pn, anzahl: anz[ersteU], grenze: lim[ersteU] };
      } else if (ersteT >= 0) {
        var pi = ersteT % PA, dd = (ersteT - pi) / PA;
        rang = 1; detail = { typ: "fahrgemeinschaft", pn: pers[paarA[pi]].pn, partner: pers[paarB[pi]].pn, datum: tage[dd] };
      }
      if (!detail) return null;   // (nicht erreichbar: netto schlechter heißt, es gibt ein neues Problem)
      return { rang: rang, anzahl: anzahl, detail: detail };
    }
    function grundFuer(eigenRang, entfernt, versuche) {
      var best = null, n = 0, fertig = false;
      function besuch() {
        if (++n > GRUND_BUDGET) { fertig = true; return 2; }
        if (!zulaessig() || !entfernt()) return 0;
        bewerte();
        var pr = profil(eigenRang);
        if (!pr) return 0;
        if (best === null || pr.rang < best.rang || (pr.rang === best.rang && pr.anzahl < best.anzahl)) best = pr;
        if (pr.rang === 0) { fertig = true; return 2; }
        return 0;
      }
      // Fensterknoten zählen mit; nach "vermeidbar" oder Budgetende nichts mehr
      besuch.fenster = function (g, dA, dB) {
        if (fertig || n >= GRUND_BUDGET) return 2;
        var e = fenster(g, dA, dB, besuch, GRUND_BUDGET - n);
        n += e.knoten;
        return fertig || e.stopp ? 2 : 0;
      };
      versuche(besuch);
      zurueckBis(0);
      return best ? best.detail : null;
    }
    function grundLimit(pn) {
      var x = pnIdx[String(pn)];
      if (x === undefined || anz[x] <= lim[x]) return null;
      var vorher = anz[x];
      return grundFuer(2, function () { return anz[x] < vorher; }, function (besuch) {
        var l = pl[x].slice(), r = 0;
        for (var i = 0; i < l.length && r !== 2; i++) {
          var u = l[i];
          if (fest[u] || halter[u] !== x) continue;
          var k = slotK[u], kl = kand[k];
          for (var j = 0; j < kl.length && r !== 2; j++) {
            var q = kl[j];
            if (q === x || pk[q * K + k]) continue;
            r = kette(u, q, 1, besuch);
          }
          if (r !== 2) r = kette(u, -1, 1, besuch);
        }
      });
    }
    function grundPaar(pnA, pnB, datum) {
      var a = pnIdx[String(pnA)], b = pnIdx[String(pnB)], d = tagVon[datum];
      if (a === undefined || b === undefined || d === undefined) return null;
      var pi = -1;
      for (var i = 0; i < PA; i++) {
        if ((paarA[i] === a && paarB[i] === b) || (paarA[i] === b && paarB[i] === a)) { pi = i; break; }
      }
      if (pi < 0 || !getrennt(pi, d)) return null;
      return grundFuer(1, function () { return getrennt(pi, d) === 0; }, function (besuch) {
        if (paarZuege(pi, d, besuch, true) === 2) return;
        var g = paarG[pi];
        if (d > 0 && besuch.fenster(g, d - 1, d) === 2) return;
        if (d + 1 < D && besuch.fenster(g, d, d + 1) === 2) return;
        if (D === 1 && besuch.fenster(g, d, d) === 2) return;
        // zuletzt: beide räumen den Tag
        var n0 = nLog;
        [a, b].forEach(function (m) {
          tagesSlots(m, d).forEach(function (s) { if (!fest[s]) aendere(s, -1); });
        });
        besuch();
        zurueckBis(n0);
      });
    }

    // ----- Auskünfte -----
    function zuweisung() {
      var z = {};
      for (var s = 0; s < S; s++) z[slots[s].id] = halter[s] >= 0 ? pers[halter[s]].pn : null;
      return z;
    }
    function kosten() { return [gesL, gesU, gesT, gesTZ, gesW]; }
    function arten(maske) {
      var out = [];
      for (var t = 1; t <= 4; t <<= 1) if (maske & t) out.push(BIT_NAME[t]);
      return out.sort();
    }
    function getrenntListe() {
      var out = [];
      for (var d = 0; d < D; d++) {
        for (var pi = 0; pi < PA; pi++) {
          if (!getrennt(pi, d)) continue;
          var a = paarA[pi], b = paarB[pi];
          out.push({ pn: pers[a].pn, partner: pers[b].pn, datum: tage[d], gruppe: gName[paarG[pi]],
            arten_pn: arten(tagMaske[a * D + d]), arten_partner: arten(tagMaske[b * D + d]) });
        }
      }
      return out;
    }
    function wahlIdx(s, q) {
      aendere(s, q); bewerte();
      var ergebnis = { ueber: q >= 0 && anz[q] > lim[q], trennt: dT > 0 };
      zurueckBis(0);
      return ergebnis;
    }
    function wahl(slotId, pn) {
      var s = slotIdx[slotId];
      if (s === undefined) return { ueber: false, trennt: false };
      var q = -1;
      if (pn !== null && pn !== undefined && pn !== "") {
        q = pnIdx[String(pn)];
        if (q === undefined) return { ueber: false, trennt: false };
      }
      return wahlIdx(s, q);
    }
    function alternativenListe() {
      var out = {}, proPerson = [], p, s;
      for (p = 0; p < N; p++) proPerson.push(pl[p].map(function (x) { return slots[x]; }));
      for (s = 0; s < S; s++) {
        var liste = [];
        for (p = 0; p < N; p++) {
          if (halter[s] === p) continue;
          if (!pruefeHinzufuegen(pers[p], slots[s], proPerson[p], { keinDoppel: true }).ok) continue;
          var w = wahlIdx(s, p);
          liste.push({ pn: pers[p].pn, f: w.ueber || w.trennt ? 1 : 0, m: minW[p] });
        }
        liste.sort(function (x, y) { return x.f - y.f || x.m - y.m || (x.pn < y.pn ? -1 : x.pn > y.pn ? 1 : 0); });
        out[slots[s].id] = liste.map(function (x) { return x.pn; });
      }
      return out;
    }
    function stunden() {
      var h = {};
      for (var p = 0; p < N; p++) h[pers[p].pn] = minW[p] / 60;
      return h;
    }

    return {
      laden: laden,
      loesen: loesen,
      kosten: kosten,
      zuweisung: zuweisung,
      stunden: stunden,
      getrenntListe: getrenntListe,
      wahl: wahl,
      alternativen: alternativenListe,
      grundLimit: grundLimit,
      grundPaar: grundPaar,
      auswertungen: function () { return auswertungen; }
    };
  }

  // ---------- Lösen ----------
  /*
   * eingabe: { schichten, tage, bedarf?, personen: [{personalnummer,
   *   verfuegbar:[{datum,schicht_id}], max_schichten, kategorie,
   *   fahrgemeinschaft}], fest?: { slotId: pn } }  (fest = vorbelegt, bleibt)
   * Altfelder (nur_schicht, gesperrte_tage, max_schichten_woche, schnitt_h,
   * notiz) werden ignoriert.
   */
  function loese(eingabe) {
    var slots = slotsBauen(eingabe.schichten, eingabe.bedarf || standardBedarf(eingabe.schichten), eingabe.tage);
    var M = Modell(eingabe, slots);
    M.loesen(eingabe.fest || {});
    var zuw = M.zuweisung();
    var ergebnis = { slots: slots, zuweisung: zuw, stunden: M.stunden(), kosten: M.kosten() };
    ergebnis.unbesetzt = slots.filter(function (s) { return zuw[s.id] === null; })
      .map(function (s) { return s.id; });
    ergebnis.alternativen = alternativen(eingabe, slots, zuw);
    ergebnis.verstoesse = begruenden(eingabe, slots, zuw, pruefe(eingabe, slots, zuw));
    return ergebnis;
  }

  // Kostenvektor [L, U, T, TZ, W] eines beliebigen Plans (auch von Hand)
  function kostenVon(eingabe, slots, zuw) {
    var M = Modell(eingabe, slots);
    M.laden(zuw);
    return M.kosten();
  }

  function getrenntePaarTage(eingabe, slots, zuw) {
    var M = Modell(eingabe, slots);
    M.laden(zuw);
    return M.getrenntListe();
  }

  // ---------- Alternativen (Spalte J der Dispo, Auswahlfeld) ----------
  // Wer hat die Schicht als verfügbar abgegeben, ist an dem Tag nicht
  // geplant und würde keine harte Regel brechen? Zuerst, wer dadurch weder
  // über seinen Wunsch käme noch eine Fahrgemeinschaft trennte; dann
  // wenigste Stunden, dann Personalnummer.
  function alternativen(eingabe, slots, zuw) {
    var M = Modell(eingabe, slots);
    M.laden(zuw);
    return M.alternativen();
  }

  // Kennzeichen für eine Handänderung: wahl(slotId, pn|null) → {ueber, trennt}
  function bewertung(eingabe, slots, zuw) {
    var M = Modell(eingabe, slots);
    M.laden(zuw);
    return { wahl: function (slotId, pn) { return M.wahl(slotId, pn); } };
  }

  // ---------- Prüfer (auch für händische Änderungen) ----------
  function pruefe(eingabe, slots, zuw) {
    var P = personenBauen(eingabe.personen || []);
    var v = [];
    var nachId = {};
    slots.forEach(function (s) { nachId[s.id] = s; });
    var proPerson = Object.create(null), unbekannt = [];
    Object.keys(zuw).forEach(function (id) {
      if (!nachId[id]) return;
      var pn = zuw[id];
      if (pn === null || pn === undefined || pn === "") {
        v.push({ art: "hinweis", typ: "unbesetzt", slot: id, text: "Unbesetzt" });
        return;
      }
      pn = String(pn);
      if (!proPerson[pn]) {
        proPerson[pn] = [];
        if (!P.nachPn[pn]) unbekannt.push(pn);
      }
      proPerson[pn].push(nachId[id]);
    });
    unbekannt.forEach(function (pn) {
      v.push({ art: "fehler", typ: "unbekannt", pn: pn, text: "Unbekannte Personalnummer" });
    });
    P.liste.forEach(function (p) {
      var pn = p.pn;
      if (!proPerson[pn]) return;
      var l = proPerson[pn].slice().sort(function (a, b) { return a.start - b.start; });
      var wocheMin = 0, tage = {};
      l.forEach(function (s, i) {
        wocheMin += s.dauer;
        tage[s.datum] = (tage[s.datum] || 0) + s.dauer;
        if (!verfuegbarFuer(p, s))
          v.push({ art: "fehler", typ: "nicht_verfuegbar", pn: pn, slot: s.id, text: "Nicht als verfügbar abgegeben" });
        if (i > 0) {
          var a = l[i - 1];
          if (a.datum !== s.datum) {
            var luecke = s.start - a.end;
            if (luecke < RUHEZEIT_MIN)
              v.push({ art: "fehler", typ: "ruhezeit", pn: pn, slot: s.id,
                text: "Ruhezeit nur " + (Math.max(luecke, 0) / 60).toFixed(1).replace(".", ",") + " h (mind. 11 h)" });
          } else {
            if (a.start < s.end && s.start < a.end)
              v.push({ art: "fehler", typ: "ueberlappung", pn: pn, slot: s.id, text: "Überschneidende Schichten" });
            v.push({ art: "hinweis", typ: "doppelschicht", pn: pn, slot: s.id, text: "Zwei Schichten am selben Tag" });
          }
        }
      });
      Object.keys(tage).forEach(function (d) {
        if (tage[d] > MAX_TAG_MIN)
          v.push({ art: "fehler", typ: "tagesgrenze", pn: pn, text: "Mehr als 10 h am " + d });
      });
      if (wocheMin > p.wocheMaxMin)
        v.push({ art: "fehler", typ: "wochengrenze", pn: pn, text: "Mehr als 48 h in der Woche" });
      if (l.length > p.limit)
        v.push({ art: "hinweis", typ: "limit", pn: pn, anzahl: l.length, grenze: p.limit,
          slots: l.map(function (s) { return s.id; }),
          text: l.length + " Schichten, Wunsch höchstens " + p.limit });
    });
    getrenntePaarTage(eingabe, slots, zuw).forEach(function (t) {
      v.push({ art: "hinweis", typ: "fahrgemeinschaft", pn: t.pn, partner: t.partner, datum: t.datum,
        gruppe: t.gruppe, arten_pn: t.arten_pn, arten_partner: t.arten_partner, text: "Fahrgemeinschaft getrennt" });
    });
    return v;
  }

  // ---------- Begründungen ----------
  // Für jede Überschreitung ("limit") und jede Trennung ("fahrgemeinschaft")
  // werden die Reparaturzüge durchprobiert. Gemeldet wird, was dabei neu
  // entstünde (Lücke vor Überschreitung vor Trennung); entsteht nichts
  // Gleichrangiges oder Schlimmeres, ist die Ausnahme "vermeidbar".
  function begruenden(eingabe, slots, zuw, befunde) {
    if (!befunde || !befunde.length) return befunde;
    var relevant = befunde.some(function (b) { return b && (b.typ === "limit" || b.typ === "fahrgemeinschaft"); });
    if (!relevant) return befunde;
    var M = Modell(eingabe, slots);
    M.laden(zuw);
    befunde.forEach(function (b) {
      if (!b) return;
      var g = null;
      if (b.typ === "limit") g = M.grundLimit(b.pn);
      else if (b.typ === "fahrgemeinschaft") g = M.grundPaar(b.pn, b.partner, b.datum);
      if (g) b.grund = g;
    });
    return befunde;
  }

  // ---------- Umwandlung aus dem Export-JSON der App ----------
  // profile: { pn: {kategorie, fahrgemeinschaft} } aus der Stammliste;
  // max_schichten_woche der Abgabe = Wunsch des Mitarbeiters
  function ausExport(json, profile) {
    profile = profile || {};
    var personen = (json.mitarbeiter || []).filter(function (m) { return m.abgegeben !== false; })
      .map(function (m) {
        var pr = profile[m.personalnummer] || {};
        return {
          personalnummer: m.personalnummer,
          verfuegbar: m.verfuegbar || [],
          max_schichten: m.max_schichten_woche === undefined ? null : m.max_schichten_woche,
          kategorie: pr.kategorie,
          fahrgemeinschaft: pr.fahrgemeinschaft
        };
      });
    return { schichten: json.schichten, tage: json.tage, personen: personen };
  }

  return {
    loese: loese,
    pruefe: pruefe,
    begruenden: begruenden,
    alternativen: alternativen,
    bewertung: bewertung,
    kostenVon: kostenVon,
    getrenntePaarTage: getrenntePaarTage,
    gruppeNorm: gruppeNorm,
    slotsBauen: slotsBauen,
    standardBedarf: standardBedarf,
    ausExport: ausExport,
    wochentagVon: wochentagVon,
    RUHEZEIT_MIN: RUHEZEIT_MIN
  };
});
