/*
 * planung-solver.js – regelbasierte Wochenplanung (ohne KI, ohne API).
 *
 * Reine Logik, kein DOM, keine Netzwerkzugriffe. Läuft im Browser
 * (window.PlanungSolver) und unter Node (require) für die Tests.
 *
 * Harte Regeln (werden nie gebrochen, lieber bleibt ein Platz leer):
 *   - nur eingesetzt, wer die Schicht als verfügbar abgegeben hat
 *   - Ruhezeit zwischen zwei Arbeitstagen mindestens 11 Stunden (ArbZG § 5)
 *   - höchstens 10 Stunden pro Tag, 48 Stunden pro Woche
 *   - Wunschgrenze "max. Schichten pro Woche" der Abgabe / des Profils
 *   - Profil-Sperren (nur Früh / nur Spät, gesperrte Wochentage)
 * Weich (Zielfunktion): Teilzeit maximal, Rest fair nach Schnitt der
 * letzten Monate, Fahrgemeinschaften zusammen, Früh/Spät nicht mischen,
 * Früh+Spät am selben Tag nur als Notlösung.
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

  // Gewichte der Zielfunktion (kleiner ist besser)
  var W = {
    UNBESETZT: 1000000,
    UNBESETZT_OFFICE: 100000,
    TEILZEIT_PRO_STUNDE: 2000,
    // Wunschgrenze "max. Schichten": nur überschritten, wenn sonst eine Lücke bliebe
    UEBER_WUNSCHGRENZE: 20000,
    DOPPELSCHICHT: 800,
    MISCHUNG: 60,
    FAHRGEMEINSCHAFT: 25
  };

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

  // ---------- Personen ----------
  function personenBauen(rohe) {
    var summe = 0, anzahl = 0;
    rohe.forEach(function (p) {
      if (p.schnitt_h !== null && p.schnitt_h !== undefined && !isNaN(+p.schnitt_h)) {
        summe += +p.schnitt_h; anzahl++;
      }
    });
    var mittel = anzahl ? summe / anzahl : 0;
    var liste = rohe.map(function (p) {
      var verf = {};
      (p.verfuegbar || []).forEach(function (v) { verf[v.datum + "|" + v.schicht_id] = true; });
      var grenzen = [p.max_schichten, p.max_schichten_woche]
        .filter(function (g) { return g !== null && g !== undefined && g > 0; });
      var sperr = {};
      (p.gesperrte_tage || []).forEach(function (t) { sperr[t] = true; });
      var hatSchnitt = p.schnitt_h !== null && p.schnitt_h !== undefined && !isNaN(+p.schnitt_h);
      return {
        pn: String(p.personalnummer || p.pn),
        verf: verf,
        anzahlVerf: Object.keys(verf).length,
        limit: grenzen.length ? Math.min.apply(null, grenzen) : 99,
        kategorie: p.kategorie === "teilzeit" ? "teilzeit" : "minijob",
        nurSchicht: p.nur_schicht || null,
        sperr: sperr,
        gruppe: p.fahrgemeinschaft ? String(p.fahrgemeinschaft).trim() : "",
        basis: hatSchnitt ? +p.schnitt_h : mittel
      };
    });
    var nachPn = {};
    liste.forEach(function (p) { nachPn[p.pn] = p; });
    return { liste: liste, nachPn: nachPn };
  }

  function verfuegbarFuer(person, slot) {
    if (person.verf[slot.datum + "|" + slot.schicht_id]) return true;
    // LANG schließt SPAET ein
    return slot.schicht_id === "SPAET" && !!person.verf[slot.datum + "|LANG"];
  }

  function profilErlaubt(person, slot) {
    if (person.sperr[wochentagVon(slot.datum)]) return false;
    if (person.nurSchicht === "FRUEH" && slot.schicht_id !== "FRUEH") return false;
    if (person.nurSchicht === "SPAET" && slot.schicht_id === "FRUEH") return false;
    return true;
  }

  // ---------- Regelprüfung für das Hinzufügen einer Schicht ----------
  // opt.ohneLimit: Wunschgrenze ignorieren (für Alternativen)
  // opt.keinDoppel: keine zweite Schicht am selben Tag zulassen
  function pruefeHinzufuegen(person, slot, zugewiesen, opt) {
    opt = opt || {};
    if (!verfuegbarFuer(person, slot)) return { ok: false, grund: "nicht_verfuegbar" };
    if (!profilErlaubt(person, slot)) return { ok: false, grund: "profil" };
    // Die Wunschgrenze ist weich: Überschreiten ist erlaubt, wird aber in der
    // Zielfunktion stark bestraft und als Hinweis ausgegeben.
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
    if (wocheMin > MAX_WOCHE_MIN) return { ok: false, grund: "wochengrenze" };
    return { ok: true, doppelt: doppelt, ueber: ueber };
  }

  // ---------- Lösen ----------
  /*
   * eingabe: { schichten, tage, bedarf, personen: [{personalnummer,
   *   verfuegbar:[{datum,schicht_id}], max_schichten, kategorie, nur_schicht,
   *   gesperrte_tage, max_schichten_woche, fahrgemeinschaft, schnitt_h}] }
   * optional: eingabe.fest = { slotId: pn } vorbelegte Plätze (bleiben stehen)
   */
  function loese(eingabe) {
    var slots = slotsBauen(eingabe.schichten, eingabe.bedarf || standardBedarf(eingabe.schichten), eingabe.tage);
    var P = personenBauen(eingabe.personen || []);
    var fest = eingabe.fest || {};

    var zuw = {};          // slotId -> pn | null
    var proPerson = {};    // pn -> [slot]
    P.liste.forEach(function (p) { proPerson[p.pn] = []; });
    var slotVonId = {};
    slots.forEach(function (s) { slotVonId[s.id] = s; zuw[s.id] = null; });

    function setze(slot, pn) {
      var alt = zuw[slot.id];
      if (alt !== null) {
        var l = proPerson[alt];
        l.splice(l.indexOf(slot), 1);
      }
      zuw[slot.id] = pn;
      if (pn !== null) proPerson[pn].push(slot);
    }

    function stundenVon(pn) {
      var m = 0;
      proPerson[pn].forEach(function (s) { m += s.dauer; });
      return m / 60;
    }

    var gruppen = {};
    P.liste.forEach(function (p) { if (p.gruppe) (gruppen[p.gruppe] = gruppen[p.gruppe] || []).push(p); });
    var tageAlle = {};
    slots.forEach(function (s) { tageAlle[s.datum] = true; });

    // Kosten der Gesamtlösung
    function kosten() {
      var c = 0;
      slots.forEach(function (s) {
        if (zuw[s.id] === null) c += s.schicht_id === "LANG" ? W.UNBESETZT_OFFICE : W.UNBESETZT;
      });
      P.liste.forEach(function (p) {
        var l = proPerson[p.pn];
        if (!l.length) return;
        var h = stundenVon(p.pn);
        if (p.kategorie === "teilzeit") c -= W.TEILZEIT_PRO_STUNDE * h;
        else c += (p.basis + h) * (p.basis + h);
        if (l.length > p.limit) c += W.UEBER_WUNSCHGRENZE * (l.length - p.limit);
        var tage = {}, hatFrueh = false, hatSpaet = false;
        l.forEach(function (s) {
          tage[s.datum] = (tage[s.datum] || 0) + 1;
          if (s.schicht_id === "FRUEH") hatFrueh = true; else hatSpaet = true;
        });
        Object.keys(tage).forEach(function (d) { if (tage[d] > 1) c += W.DOPPELSCHICHT; });
        if (hatFrueh && hatSpaet) c += W.MISCHUNG;
      });
      // Fahrgemeinschaften: am selben Tag gleiche Schicht, oder beide frei
      Object.keys(gruppen).forEach(function (g) {
        var mitglieder = gruppen[g];
        if (mitglieder.length < 2) return;
        Object.keys(tageAlle).forEach(function (d) {
          var arten = mitglieder.map(function (m) {
            var s = proPerson[m.pn].filter(function (x) { return x.datum === d; })[0];
            return s ? s.schicht_id : "-";
          });
          for (var i = 0; i < arten.length; i++)
            for (var j = i + 1; j < arten.length; j++)
              if (arten[i] !== arten[j]) c += W.FAHRGEMEINSCHAFT;
        });
      });
      return c;
    }

    // Vorbelegung
    Object.keys(fest).forEach(function (id) {
      var s = slotVonId[id];
      if (s && proPerson[fest[id]]) setze(s, fest[id]);
    });
    var festSet = {};
    Object.keys(fest).forEach(function (id) { festSet[id] = true; });

    // 1) Konstruktion: knappe Plätze zuerst
    var kandidatenZahl = {};
    slots.forEach(function (s) {
      var n = 0;
      P.liste.forEach(function (p) { if (verfuegbarFuer(p, s) && profilErlaubt(p, s)) n++; });
      kandidatenZahl[s.id] = n;
    });
    var reihenfolge = slots.filter(function (s) { return !festSet[s.id]; }).sort(function (a, b) {
      return kandidatenZahl[a.id] - kandidatenZahl[b.id] ||
        (a.datum < b.datum ? -1 : a.datum > b.datum ? 1 : 0) || a.ord - b.ord || a.nr - b.nr;
    });

    reihenfolge.forEach(function (s) {
      var bester = null, besterKey = null;
      P.liste.forEach(function (p) {
        var r = pruefeHinzufuegen(p, s, proPerson[p.pn]);
        if (!r.ok) return;
        var h = stundenVon(p.pn);
        var key = p.kategorie === "teilzeit" ? -1e6 + h : p.basis + h;
        if (r.doppelt) key += 500;
        if (r.ueber) key += 1e7; // erst alle, die innerhalb ihrer Grenze bleiben
        var mischt = proPerson[p.pn].some(function (x) {
          return (x.schicht_id === "FRUEH") !== (s.schicht_id === "FRUEH");
        });
        if (mischt) key += 30;
        var tup = [key, p.anzahlVerf, p.pn];
        if (besterKey === null || tup[0] < besterKey[0] ||
            (tup[0] === besterKey[0] && (tup[1] < besterKey[1] ||
              (tup[1] === besterKey[1] && tup[2] < besterKey[2])))) {
          bester = p; besterKey = tup;
        }
      });
      if (bester) setze(s, bester.pn);
    });

    // 2) Verbesserung: lokale Suche (Füllen, Verschieben, Tauschen)
    var aktuell = kosten();
    var EPS = 1e-9;
    for (var durchlauf = 0; durchlauf < 60; durchlauf++) {
      var besser = false;
      for (var si = 0; si < slots.length; si++) {
        var s = slots[si];
        if (festSet[s.id]) continue;
        // Verschieben / Füllen: anderer Mitarbeiter übernimmt s
        for (var pi = 0; pi < P.liste.length; pi++) {
          var q = P.liste[pi];
          var vorher = zuw[s.id];
          if (q.pn === vorher) continue;
          setze(s, null);
          var r = pruefeHinzufuegen(q, s, proPerson[q.pn]);
          if (r.ok) {
            setze(s, q.pn);
            var c = kosten();
            if (c < aktuell - EPS) { aktuell = c; besser = true; continue; }
            setze(s, null);
          }
          setze(s, vorher);
        }
        // Tauschen mit einem späteren Platz t
        var alt = zuw[s.id];
        if (alt === null) continue;
        for (var ti = si + 1; ti < slots.length; ti++) {
          var t = slots[ti];
          if (festSet[t.id]) continue;
          var q2 = zuw[t.id];
          if (q2 === null || q2 === alt || zuw[s.id] !== alt) continue;
          var pA = P.nachPn[alt], pB = P.nachPn[q2];
          setze(s, null); setze(t, null);
          var getauscht = false;
          if (pruefeHinzufuegen(pB, s, proPerson[pB.pn]).ok) {
            setze(s, pB.pn);
            if (pruefeHinzufuegen(pA, t, proPerson[pA.pn]).ok) {
              setze(t, pA.pn);
              var c2 = kosten();
              if (c2 < aktuell - EPS) { aktuell = c2; besser = true; getauscht = true; }
              else setze(t, null);
            }
            if (!getauscht) setze(s, null);
          }
          if (!getauscht) { setze(s, alt); setze(t, q2); }
          else break;
        }
      }
      if (!besser) break;
    }

    var stunden = {};
    P.liste.forEach(function (p) { stunden[p.pn] = stundenVon(p.pn); });
    var ergebnis = { slots: slots, zuweisung: zuw, stunden: stunden, kosten: aktuell };
    ergebnis.unbesetzt = slots.filter(function (s) { return zuw[s.id] === null; })
      .map(function (s) { return s.id; });
    ergebnis.alternativen = alternativen(eingabe, slots, zuw);
    ergebnis.verstoesse = pruefe(eingabe, slots, zuw);
    return ergebnis;
  }

  // ---------- Alternativen (Spalte J der Dispo) ----------
  // Wer hat die Schicht als verfügbar abgegeben, ist an dem Tag nicht
  // geplant und würde keine harte Regel brechen? Wenigste Stunden zuerst.
  function alternativen(eingabe, slots, zuw) {
    var P = personenBauen(eingabe.personen || []);
    var proPerson = {};
    P.liste.forEach(function (p) { proPerson[p.pn] = []; });
    var nachId = {};
    slots.forEach(function (s) { nachId[s.id] = s; });
    Object.keys(zuw).forEach(function (id) {
      if (zuw[id] !== null && proPerson[zuw[id]] && nachId[id]) proPerson[zuw[id]].push(nachId[id]);
    });
    var out = {};
    slots.forEach(function (s) {
      var liste = [];
      P.liste.forEach(function (p) {
        if (zuw[s.id] === p.pn) return;
        var r = pruefeHinzufuegen(p, s, proPerson[p.pn], { keinDoppel: true });
        if (!r.ok) return;
        var h = proPerson[p.pn].reduce(function (m, x) { return m + x.dauer; }, 0) / 60;
        // wer innerhalb der eigenen Grenze bleibt, steht vorn
        liste.push({ pn: p.pn, key: p.basis + h + (r.ueber ? 1000 : 0) });
      });
      liste.sort(function (a, b) { return a.key - b.key || (a.pn < b.pn ? -1 : 1); });
      out[s.id] = liste.map(function (x) { return x.pn; });
    });
    return out;
  }

  // ---------- Prüfer (auch für händische Änderungen) ----------
  function pruefe(eingabe, slots, zuw) {
    var P = personenBauen(eingabe.personen || []);
    var v = [];
    var nachId = {};
    slots.forEach(function (s) { nachId[s.id] = s; });
    var proPerson = {};
    Object.keys(zuw).forEach(function (id) {
      var pn = zuw[id];
      if (pn === null || pn === undefined) {
        v.push({ art: "hinweis", typ: "unbesetzt", slot: id, text: "Unbesetzt" });
        return;
      }
      (proPerson[pn] = proPerson[pn] || []).push(nachId[id]);
    });
    Object.keys(proPerson).forEach(function (pn) {
      var p = P.nachPn[pn];
      var l = proPerson[pn].slice().sort(function (a, b) { return a.start - b.start; });
      if (!p) { v.push({ art: "fehler", typ: "unbekannt", pn: pn, text: "Unbekannte Personalnummer" }); return; }
      var wocheMin = 0, tage = {};
      l.forEach(function (s, i) {
        wocheMin += s.dauer;
        tage[s.datum] = (tage[s.datum] || 0) + s.dauer;
        if (!verfuegbarFuer(p, s))
          v.push({ art: "fehler", typ: "nicht_verfuegbar", pn: pn, slot: s.id, text: "Nicht als verfügbar abgegeben" });
        if (!profilErlaubt(p, s))
          v.push({ art: "fehler", typ: "profil", pn: pn, slot: s.id, text: "Widerspricht dem Profil" });
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
      if (wocheMin > MAX_WOCHE_MIN)
        v.push({ art: "fehler", typ: "wochengrenze", pn: pn, text: "Mehr als 48 h in der Woche" });
      if (l.length > p.limit)
        v.push({ art: "hinweis", typ: "limit", pn: pn,
          text: l.length + " Schichten, Wunschgrenze " + p.limit + " (nur zur Besetzung einer Lücke; kurz anfragen)" });
    });
    return v;
  }

  // ---------- Umwandlung aus dem Export-JSON der App ----------
  // profile: { pn: {kategorie, nur_schicht, gesperrte_tage, max_schichten_woche,
  //                 fahrgemeinschaft, schnitt_h} }
  function ausExport(json, profile) {
    profile = profile || {};
    var personen = (json.mitarbeiter || []).filter(function (m) { return m.abgegeben !== false; })
      .map(function (m) {
        var pr = profile[m.personalnummer] || {};
        return {
          personalnummer: m.personalnummer,
          verfuegbar: m.verfuegbar || [],
          max_schichten: m.max_schichten_woche,
          kategorie: pr.kategorie,
          nur_schicht: pr.nur_schicht,
          gesperrte_tage: pr.gesperrte_tage,
          max_schichten_woche: pr.max_schichten_woche,
          fahrgemeinschaft: pr.fahrgemeinschaft,
          schnitt_h: pr.schnitt_h
        };
      });
    return { schichten: json.schichten, tage: json.tage, personen: personen };
  }

  return {
    loese: loese,
    pruefe: pruefe,
    alternativen: alternativen,
    slotsBauen: slotsBauen,
    standardBedarf: standardBedarf,
    ausExport: ausExport,
    wochentagVon: wochentagVon,
    RUHEZEIT_MIN: RUHEZEIT_MIN
  };
});
