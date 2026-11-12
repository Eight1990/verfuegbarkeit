/*
 * dispo-export.js – füllt die Kunden-Vorlage "Dispo_Aktuell_Neues_Format.xlsm".
 *
 * Die Datei hat ein VBA-Makro und einen Button. Sie wird deshalb NICHT mit
 * einer Tabellen-Bibliothek neu geschrieben, sondern nur das Blatt "FedEx"
 * (xl/worksheets/sheet1.xml) zellgenau angepasst. Alle anderen Teile des
 * ZIP (vbaProject.bin, Zeichnung, Formatvorlagen, Blatt "Dienstplan")
 * bleiben unverändert.
 *
 * Es gibt keinen Netzwerkzugriff und keine Datenhaltung: Bytes rein, Bytes raus.
 */
(function (wurzel, fabrik) {
  if (typeof module === "object" && module.exports) module.exports = fabrik();
  else wurzel.DispoExport = fabrik();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var BLATT = "xl/worksheets/sheet1.xml";
  var MAPPE = "xl/workbook.xml";

  function xmlText(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function entXml(s) {
    return String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  }
  function spaltenNr(buchst) {
    var n = 0;
    for (var i = 0; i < buchst.length; i++) n = n * 26 + (buchst.charCodeAt(i) - 64);
    return n;
  }
  function serieAusIso(iso) {
    var p = iso.split("-");
    return Math.round(Date.UTC(+p[0], +p[1] - 1, +p[2]) / 86400000) + 25569;
  }
  function bruchAusUhr(uhr) {
    var t = String(uhr).split(":");
    return ((+t[0]) * 60 + (+t[1] || 0)) / 1440;
  }

  function geteilteTexte(xml) {
    var out = [];
    var re = /<si\b[^>]*>([\s\S]*?)<\/si>/g, m;
    while ((m = re.exec(xml))) {
      var txt = "", t, rt = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
      while ((t = rt.exec(m[1]))) txt += entXml(t[1]);
      out.push(txt);
    }
    return out;
  }

  var ZEILE_QUELLE = "<row\\b[^>]*?(?:\\/>|>[\\s\\S]*?<\\/row>)";
  var ZELLE_QUELLE = "<c\\b[^>]*?(?:\\/>|>[\\s\\S]*?<\\/c>)";

  function attr(tag, name) {
    var m = new RegExp("\\b" + name + '="([^"]*)"').exec(tag);
    return m ? m[1] : null;
  }

  function zelleLesen(zXml) {
    var kopf = /^<c\b[^>]*?(?=\/?>)/.exec(zXml)[0];
    var ref = attr(kopf, "r");
    var inner = zXml.slice(kopf.length).replace(/^\/>$/, "").replace(/^>/, "").replace(/<\/c>$/, "");
    var v = /<v>([\s\S]*?)<\/v>/.exec(inner);
    var isT = /<is>[\s\S]*?<t\b[^>]*>([\s\S]*?)<\/t>/.exec(inner);
    return {
      ref: ref,
      spalte: ref.replace(/\d+/g, ""),
      s: attr(kopf, "s"),
      t: attr(kopf, "t"),
      hatFormel: /<f\b/.test(inner),
      v: v ? v[1] : null,
      inlineText: isT ? entXml(isT[1]) : null,
      xml: zXml
    };
  }

  function zellenXml(ref, stil, art, wert) {
    var s = stil !== null && stil !== undefined ? ' s="' + stil + '"' : "";
    if (art === "text") {
      return '<c r="' + ref + '"' + s + ' t="inlineStr"><is><t xml:space="preserve">' +
        xmlText(wert) + "</t></is></c>";
    }
    if (art === "zahl") return '<c r="' + ref + '"' + s + "><v>" + wert + "</v></c>";
    return '<c r="' + ref + '"' + s + "/>"; // leer
  }

  function zellenListe(zeilenXml, kopf) {
    var zellen = [];
    var rest = zeilenXml.slice(kopf.length);
    if (/^\/>/.test(rest)) return zellen;
    var re = new RegExp(ZELLE_QUELLE, "g"), m;
    while ((m = re.exec(rest))) zellen.push(zelleLesen(m[0]));
    return zellen;
  }

  /*
   * Ändert Zellen einer Zeile. aend: { "B": {art:"text"|"zahl"|"leer", wert} }
   * Zellen mit Formel werden nie überschrieben.
   */
  function zeileAendern(zeilenXml, zeilenNr, aend) {
    var kopf = /^<row\b[^>]*?(?=\/?>)/.exec(zeilenXml)[0];
    var zellen = zellenListe(zeilenXml, kopf);
    Object.keys(aend).forEach(function (sp) {
      var a = aend[sp];
      var ref = sp + zeilenNr;
      var vorhanden = null;
      for (var i = 0; i < zellen.length; i++) if (zellen[i].spalte === sp) { vorhanden = i; break; }
      if (vorhanden !== null) {
        var z = zellen[vorhanden];
        if (z.hatFormel) {
          // Formel bleibt; nur der zwischengespeicherte Wert wird aktualisiert
          if (a.art === "cache" && /<v>[\s\S]*?<\/v>/.test(z.xml)) {
            zellen[vorhanden] = zelleLesen(z.xml.replace(/<v>[\s\S]*?<\/v>/, "<v>" + a.wert + "</v>"));
          }
          return;
        }
        zellen[vorhanden] = zelleLesen(zellenXml(ref, z.s, a.art === "cache" ? "zahl" : a.art, a.wert));
        return;
      }
      if (a.art === "cache") return;
      var neu = zelleLesen(zellenXml(ref, null, a.art, a.wert));
      var pos = zellen.length;
      for (var j = 0; j < zellen.length; j++) {
        if (spaltenNr(zellen[j].spalte) > spaltenNr(sp)) { pos = j; break; }
      }
      zellen.splice(pos, 0, neu);
    });
    var neuerKopf = kopf.replace(/\sspans="[^"]*"/, "");
    return neuerKopf + ">" + zellen.map(function (z) { return z.xml; }).join("") + "</row>";
  }

  // Struktur der Vorlage: Blöcke je Tag, Zeilen der Positionen und Datumszellen
  function vorlageAnalysieren(sheetXml, texte) {
    var bloecke = [];
    var aktuell = null;
    var letztesDatum = null;
    var re = new RegExp(ZEILE_QUELLE, "g"), m;
    while ((m = re.exec(sheetXml))) {
      var zx = m[0];
      var rKopf = /^<row\b[^>]*?(?=\/?>)/.exec(zx)[0];
      var nr = parseInt(attr(rKopf, "r"), 10);
      var zellen = zellenListe(zx, rKopf);
      var a = null;
      for (var i = 0; i < zellen.length; i++) if (zellen[i].spalte === "A") a = zellen[i];
      if (!a || a.v === null) continue;
      var istText = a.t === "s";
      if (!istText && a.t !== "str" && a.t !== "inlineStr") {
        var zahl = parseFloat(a.v);
        if (zahl > 40000 && zahl < 80000) {
          if (zahl !== letztesDatum) {
            aktuell = { datum: zahl, positionen: {}, datumsZeilen: [] };
            bloecke.push(aktuell);
            letztesDatum = zahl;
          }
          aktuell.datumsZeilen.push(nr);
          continue;
        }
      }
      var text = istText ? texte[parseInt(a.v, 10)] : (a.inlineText || a.v);
      var pm = /^\s*zig\s+(am|pm|office)\s*(\d*)\s*$/i.exec(text || "");
      if (pm && aktuell) {
        var w = pm[1].toLowerCase();
        var artKey = w === "am" ? "AM" : w === "pm" ? "PM" : "Office";
        var n = pm[2] ? parseInt(pm[2], 10) : 1;
        aktuell.positionen[artKey + "|" + n] = nr;
      }
    }
    return bloecke;
  }

  /*
   * plan = { tage: ["2026-10-19", ... 5 ISO-Daten, aufsteigend],
   *          eintraege: [{datum, art:"AM"|"PM"|"Office", nr, name,
   *                       beginn:"HH:MM", ende:"HH:MM", alternativen:[Namen]}] }
   * Gibt { bytes, nichtUntergebracht:[...], belegt, bloecke } zurück.
   */
  // Schreibt den Plan in das Blatt "FedEx" der Vorlage (nur Text, kein ZIP).
  function blattFuellen(sheetXml, texte, plan) {
    var bloecke = vorlageAnalysieren(sheetXml, texte);
    if (!bloecke.length) throw new Error("In der Vorlage wurden keine Tagesblöcke gefunden.");

    var aenderungen = {}; // zeilenNr -> {spalte: {art,wert}}
    function aendern(zeile, spalte, art, wert) {
      (aenderungen[zeile] = aenderungen[zeile] || {})[spalte] = { art: art, wert: wert };
    }

    var nichtUntergebracht = [];
    var belegt = 0;
    var nachTag = {};
    (plan.eintraege || []).forEach(function (e) {
      (nachTag[e.datum] = nachTag[e.datum] || []).push(e);
    });

    bloecke.forEach(function (blk, idx) {
      var datum = plan.tage[idx];
      if (!datum) return;
      var serie = serieAusIso(datum);
      blk.datumsZeilen.forEach(function (z) { aendern(z, "A", "cache", serie); });
      var gesetzt = {};
      (nachTag[datum] || []).forEach(function (e) {
        var key = e.art + "|" + e.nr;
        var zeile = blk.positionen[key];
        if (!zeile) { nichtUntergebracht.push(datum + " " + e.art + " " + e.nr); return; }
        gesetzt[key] = true;
        aendern(zeile, "B", e.name ? "text" : "leer", e.name || "");
        var alt = (e.alternativen || []).join(", ");
        aendern(zeile, "J", alt ? "text" : "leer", alt);
        if (e.beginn) aendern(zeile, "C", "zahl", bruchAusUhr(e.beginn));
        if (e.ende) aendern(zeile, "D", "zahl", bruchAusUhr(e.ende));
        if (e.name) belegt++;
      });
      // Positionen der Vorlage ohne Bedarf: Reste der alten Planung leeren
      Object.keys(blk.positionen).forEach(function (key) {
        if (gesetzt[key]) return;
        var z = blk.positionen[key];
        aendern(z, "B", "leer"); aendern(z, "C", "leer");
        aendern(z, "D", "leer"); aendern(z, "J", "leer");
      });
    });

    var neu = sheetXml.replace(new RegExp(ZEILE_QUELLE, "g"), function (zx) {
      var rKopf = /^<row\b[^>]*?(?=\/?>)/.exec(zx)[0];
      var nr = parseInt(attr(rKopf, "r"), 10);
      return aenderungen[nr] ? zeileAendern(zx, nr, aenderungen[nr]) : zx;
    });
    return { xml: neu, bloecke: bloecke, nichtUntergebracht: nichtUntergebracht, belegt: belegt };
  }

  function vorlageOeffnen(JSZip, vorlageBytes) {
    return JSZip.loadAsync(vorlageBytes).then(function (zip) {
      var sheetDatei = zip.file(BLATT);
      var mappeDatei = zip.file(MAPPE);
      if (!sheetDatei || !mappeDatei) throw new Error("Vorlage hat nicht den erwarteten Aufbau (Blatt FedEx fehlt).");
      var stringsDatei = zip.file("xl/sharedStrings.xml");
      return Promise.all([
        sheetDatei.async("string"),
        mappeDatei.async("string"),
        stringsDatei ? stringsDatei.async("string") : Promise.resolve("")
      ]).then(function (teile) {
        return { zip: zip, sheetXml: teile[0], mappeXml: teile[1], texte: geteilteTexte(teile[2]) };
      });
    });
  }

  function fuelleVorlage(JSZip, vorlageBytes, plan) {
    return vorlageOeffnen(JSZip, vorlageBytes).then(function (v) {
      var g = blattFuellen(v.sheetXml, v.texte, plan);
      v.zip.file(BLATT, g.xml);

      var mappeNeu = /fullCalcOnLoad=/.test(v.mappeXml) ? v.mappeXml :
        v.mappeXml.replace(/<calcPr\b([^>]*?)\/>/, '<calcPr$1 fullCalcOnLoad="1"/>');
      v.zip.file(MAPPE, mappeNeu);

      return v.zip.generateAsync({
        type: "uint8array",
        compression: "DEFLATE",
        mimeType: "application/vnd.ms-excel.sheet.macroEnabled.12"
      }).then(function (bytes) {
        return { bytes: bytes, nichtUntergebracht: g.nichtUntergebracht, belegt: g.belegt, bloecke: g.bloecke.length };
      });
    });
  }

  /* =====================================================================
   * Datei für FedEx ("ZiG_Planung_FedEx_KW<Nr>_<Jahr>.xlsx")
   *
   * Aufbau wie die bisher per Mail versendete Datei: eine Mappe ohne Makro,
   * ein Blatt "KW<Nr>". Links (A:H) Kopf und Montag bis Mittwoch aus dem Blatt
   * "FedEx" der Vorlage, rechts (J:Q) Donnerstag und Freitag, darunter der
   * Summenkasten. Ersatzleute (Spalte J der Vorlage) und die interne
   * Auswertung kommen nicht mit.
   * ===================================================================== */
  var FEDEX_BREITEN = [16.28515625, 28.140625, 8.85546875, 6.28515625, 5.28515625, 7, 8.85546875,
    5.28515625, 9.140625, 12, 23.85546875, 6.28515625, 9.85546875, 5.28515625, 5.5703125, 7.85546875, 5.28515625];
  var QUELL_SPALTEN = 8;   // A:H
  var SPALTEN_VERSATZ = 9; // A -> J

  function spaltenBuchst(n) {
    var s = "";
    while (n > 0) { var r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = (n - r - 1) / 26; }
    return s;
  }

  // Ruft fn(spalteNr, zeile, absSpalte, absZeile) für jeden Zellbezug auf; Texte in "..." bleiben unberührt.
  function bezuegeAendern(formel, fn) {
    return String(formel).split('"').map(function (teil, i) {
      if (i % 2) return teil;
      return teil.replace(/(^|[^A-Za-z0-9_!.$])(\$?)([A-Z]{1,3})(\$?)(\d+)(?![A-Za-z0-9_(])/g,
        function (g, vor, aS, sp, aZ, ze) {
          var n = fn(spaltenNr(sp), parseInt(ze, 10), !!aS, !!aZ);
          return vor + aS + spaltenBuchst(n.s) + aZ + n.z;
        });
    }).join('"');
  }

  function formelLesen(zXml) {
    var m = /<f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)/.exec(zXml);
    if (!m) return null;
    return { text: m[2] ? entXml(m[2]) : "", geteilt: attr(m[1], "t") === "shared", si: attr(m[1], "si") };
  }

  // Liest die Spalten A:H des gefüllten Blatts; geteilte Formeln werden ausgeschrieben.
  function blattLesen(sheetXml, texte) {
    var zeilen = {}, meister = {}, offen = [];
    var re = new RegExp(ZEILE_QUELLE, "g"), m;
    while ((m = re.exec(sheetXml))) {
      var zx = m[0];
      var kopf = /^<row\b[^>]*?(?=\/?>)/.exec(zx)[0];
      var nr = parseInt(attr(kopf, "r"), 10);
      var zeile = { ht: attr(kopf, "ht"), fest: attr(kopf, "customHeight") === "1", zellen: {} };
      zeilen[nr] = zeile;
      zellenListe(zx, kopf).forEach(function (z) {
        var sp = spaltenNr(z.spalte);
        var f = formelLesen(z.xml);
        if (f && f.geteilt && f.text) meister[f.si] = { text: f.text, s: sp, z: nr };
        if (sp > QUELL_SPALTEN) return;
        var c = { s: z.s, f: null, art: "leer", wert: "" };
        if (z.t === "s") { c.art = "text"; c.wert = texte[parseInt(z.v, 10)] || ""; }
        else if (z.t === "inlineStr") { c.art = "text"; c.wert = z.inlineText || ""; }
        else if (z.t === "str") { c.art = "str"; c.wert = entXml(z.v || ""); }
        else if (z.t === "b" || z.t === "e") { c.art = "roh"; c.typ = z.t; c.wert = z.v || ""; }
        else if (z.v !== null) { c.art = "zahl"; c.wert = z.v; }
        if (c.art === "text" && c.wert === "") c.art = "leer";
        if (f) {
          if (f.text) c.f = f.text;
          else if (f.geteilt) offen.push({ c: c, si: f.si, s: sp, z: nr });
        }
        zeile.zellen[sp] = c;
      });
    }
    offen.forEach(function (o) {
      var ms = meister[o.si];
      if (!ms) return;
      o.c.f = bezuegeAendern(ms.text, function (s, z, aS, aZ) {
        return { s: aS ? s : s + (o.s - ms.s), z: aZ ? z : z + (o.z - ms.z) };
      });
    });
    return zeilen;
  }

  // Rechnet einfache Formeln (+ - * /, Klammern, Zellbezüge, SUM) für die zwischengespeicherten Werte.
  function rechne(formel, wertVon) {
    var s = String(formel).replace(/\s+/g, ""), i = 0;
    function fehler() { throw new Error("Formel nicht berechenbar"); }
    function ausdruck() {
      var v = term();
      while (s[i] === "+" || s[i] === "-") { var o = s[i++]; var t = term(); v = o === "+" ? v + t : v - t; }
      return v;
    }
    function term() {
      var v = faktor();
      while (s[i] === "*" || s[i] === "/") { var o = s[i++]; var t = faktor(); v = o === "*" ? v * t : v / t; }
      return v;
    }
    function faktor() {
      if (s[i] === "(") { i++; var v = ausdruck(); if (s[i] !== ")") fehler(); i++; return v; }
      if (s[i] === "-") { i++; return -faktor(); }
      var rest = s.slice(i), m;
      if (/^SUM\(/i.test(rest)) {
        i += 4;
        var summe = 0;
        for (;;) {
          m = /^\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?/.exec(s.slice(i));
          if (!m) fehler();
          i += m[0].length;
          var s1 = spaltenNr(m[1]), z1 = +m[2], s2 = m[3] ? spaltenNr(m[3]) : s1, z2 = m[3] ? +m[4] : z1;
          for (var z = Math.min(z1, z2); z <= Math.max(z1, z2); z++) {
            for (var sp = Math.min(s1, s2); sp <= Math.max(s1, s2); sp++) summe += wertVon(spaltenBuchst(sp) + z, true);
          }
          if (s[i] === ",") { i++; continue; }
          if (s[i] === ")") { i++; break; }
          fehler();
        }
        return summe;
      }
      m = /^\$?([A-Z]{1,3})\$?(\d+)/.exec(rest);
      if (m) { i += m[0].length; return wertVon(m[1] + m[2], false); }
      m = /^\d+(?:\.\d+)?/.exec(rest);
      if (m) { i += m[0].length; return parseFloat(m[0]); }
      return fehler();
    }
    var erg = ausdruck();
    if (i !== s.length || !isFinite(erg)) fehler();
    return erg;
  }

  function abschnittFinden(xml, tag) {
    var m = new RegExp("<" + tag + "(?=[\\s>/])").exec(xml);
    if (!m) return null;
    var von = m.index, kopfEnde = xml.indexOf(">", von);
    if (xml.charAt(kopfEnde - 1) === "/") {
      return { von: von, bis: kopfEnde + 1, kopf: xml.slice(von, kopfEnde - 1), innen: "" };
    }
    var zu = xml.indexOf("</" + tag + ">", kopfEnde);
    if (zu < 0) return null;
    return { von: von, bis: zu + tag.length + 3, kopf: xml.slice(von, kopfEnde), innen: xml.slice(kopfEnde + 1, zu) };
  }
  function abschnittErsetzen(xml, tag, neu) {
    var a = abschnittFinden(xml, tag);
    return a ? xml.slice(0, a.von) + neu + xml.slice(a.bis) : xml;
  }
  function elemente(innen, tag) {
    return innen.match(new RegExp("<" + tag + "\\b[^>]*?(?:\\/>|>[\\s\\S]*?<\\/" + tag + ">)", "g")) || [];
  }

  /*
   * Formatvorlagen der Vorlage übernehmen (Zellstil-Nummern bleiben gültig), aber den Ballast der
   * benannten Formatvorlagen weglassen und die Stile für Summenkasten und Zeitformat ergänzen.
   */
  function stileVorbereiten(stylesXml) {
    var aF = abschnittFinden(stylesXml, "fonts"), aB = abschnittFinden(stylesXml, "borders"),
      aX = abschnittFinden(stylesXml, "cellXfs");
    if (!aF || !aB || !aX) throw new Error("Formatvorlagen der Vorlage haben nicht den erwarteten Aufbau.");
    var fonts = elemente(aF.innen, "font"), borders = elemente(aB.innen, "border");
    var xfs = elemente(aX.innen, "xf").map(function (x) {
      return /\bxfId="/.test(x) ? x.replace(/\bxfId="\d+"/, 'xfId="0"') : x;
    });

    var zeitFmt = /<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="h:mm;@"/.exec(stylesXml) ||
      /<numFmt\b[^>]*formatCode="h:mm;@"[^>]*numFmtId="(\d+)"/.exec(stylesXml);
    var zeitId = zeitFmt ? zeitFmt[1] : "20"; // 20 = eingebautes h:mm
    var zeitKlone = {};
    function zeitStil(s) {
      var nr = parseInt(s || "0", 10);
      if (zeitKlone[nr] !== undefined) return String(zeitKlone[nr]);
      var x = xfs[nr] || '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>';
      x = /\bnumFmtId="/.test(x) ? x.replace(/\bnumFmtId="\d+"/, 'numFmtId="' + zeitId + '"')
        : x.replace(/^<xf\b/, '<xf numFmtId="' + zeitId + '"');
      if (!/\bapplyNumberFormat="/.test(x)) x = x.replace(/^<xf\b/, '<xf applyNumberFormat="1"');
      xfs.push(x);
      return String(zeitKlone[nr] = xfs.length - 1);
    }

    function schrift(fett) {
      fonts.push("<font>" + (fett ? "<b/>" : "") + '<sz val="10"/><color theme="1"/><name val="Arial"/><family val="2"/></font>');
      return fonts.length - 1;
    }
    function rahmen(seiten) {
      function seite(n) {
        return seiten.indexOf(n.charAt(0).toUpperCase()) >= 0
          ? "<" + n + ' style="medium"><color indexed="64"/></' + n + ">" : "<" + n + "/>";
      }
      borders.push("<border>" + seite("left") + seite("right") + seite("top") + seite("bottom") + "<diagonal/></border>");
      return borders.length - 1;
    }
    function stil(font, border, numFmt, mitte) {
      xfs.push('<xf numFmtId="' + numFmt + '" fontId="' + font + '" fillId="0" borderId="' + border + '" xfId="0"' +
        (numFmt ? ' applyNumberFormat="1"' : "") + ' applyFont="1" applyBorder="1"' +
        (mitte ? ' applyAlignment="1"><alignment horizontal="center"/></xf>' : "/>"));
      return String(xfs.length - 1);
    }
    var fFett = schrift(true), fNormal = schrift(false);
    var kasten = { // 46 = eingebautes [h]:mm:ss
      kopfL: stil(fFett, rahmen("LRT"), 0, true), kopfM: stil(0, rahmen("T"), 0), kopfR: stil(0, rahmen("RT"), 0),
      tagL: stil(fNormal, rahmen("L"), 0), tagM: stil(fNormal, 0, 46), tagR: stil(fNormal, rahmen("R"), 0),
      endL: stil(fFett, rahmen("LB"), 46, true), endM: stil(0, rahmen("B"), 0), endR: stil(fFett, rahmen("RB"), 0),
      endL2: stil(fFett, rahmen("LB"), 0), endM2: stil(fFett, rahmen("B"), 46)
    };

    function zaehler(kopf, n) {
      return (/\bcount="/.test(kopf) ? kopf.replace(/\bcount="\d+"/, 'count="' + n + '"') : kopf + ' count="' + n + '"') + ">";
    }
    function fertig() {
      var x = stylesXml;
      x = abschnittErsetzen(x, "fonts", zaehler(aF.kopf, fonts.length) + fonts.join("") + "</fonts>");
      x = abschnittErsetzen(x, "borders", zaehler(aB.kopf, borders.length) + borders.join("") + "</borders>");
      x = abschnittErsetzen(x, "cellStyleXfs",
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>');
      x = abschnittErsetzen(x, "cellXfs", zaehler(aX.kopf, xfs.length) + xfs.join("") + "</cellXfs>");
      x = abschnittErsetzen(x, "cellStyles",
        '<cellStyles count="1"><cellStyle name="Standard" xfId="0" builtinId="0"/></cellStyles>');
      x = abschnittErsetzen(x, "dxfs", '<dxfs count="0"/>');
      return x;
    }
    return { zeitStil: zeitStil, kasten: kasten, fertig: fertig };
  }

  // Baut das Blatt "KW<Nr>" aus dem gefüllten Blatt "FedEx".
  function fedexBlatt(gefuelltXml, texte, bloecke, stile) {
    if (bloecke.length !== 5) {
      throw new Error("Die Vorlage hat " + bloecke.length + " Tagesblöcke, für die FedEx-Datei werden genau 5 gebraucht (Montag bis Freitag).");
    }
    var quelle = blattLesen(gefuelltXml, texte);
    var grenzen = bloecke.map(function (b) {
      var pos = Object.keys(b.positionen).map(function (k) { return b.positionen[k]; });
      return {
        start: Math.min.apply(null, b.datumsZeilen),
        erste: Math.max.apply(null, b.datumsZeilen) + 1,
        letzte: Math.max.apply(null, pos.concat(b.datumsZeilen))
      };
    });
    var linksEnde = grenzen[2].letzte;
    var rechtsVon = grenzen[3].start, rechtsBis = grenzen[4].letzte;
    // Standard-Stil je Spalte der Vorlage: gilt für Zellen, die in der Vorlage nicht einzeln angelegt sind
    var spaltenStil = {};
    (gefuelltXml.match(/<col\b[^>]*\/>/g) || []).forEach(function (c) {
      var st = attr(c, "style");
      if (st === null) return;
      for (var i = parseInt(attr(c, "min"), 10); i <= Math.min(parseInt(attr(c, "max"), 10), QUELL_SPALTEN); i++) spaltenStil[i] = st;
    });
    var dZ = grenzen[0].start - grenzen[3].start;
    function ziel(sp, z) {
      return z >= rechtsVon && z <= rechtsBis && sp <= QUELL_SPALTEN ? { s: sp + SPALTEN_VERSATZ, z: z + dZ } : { s: sp, z: z };
    }
    function formelZiel(f) { return bezuegeAendern(f, function (s, z) { return ziel(s, z); }); }

    var aus = {};       // "B5" -> Zelle
    var maxZeile = 1;
    function setze(sp, z, c) { aus[spaltenBuchst(sp) + z] = c; if (z > maxZeile) maxZeile = z; }
    // Zeilenhöhen werden bewusst nicht übernommen: Excel bestimmt sie beim Öffnen selbst (wie beim Kopieren von Zellen).
    for (var nr = 1; nr <= rechtsBis; nr++) {
      if (nr > linksEnde && nr < rechtsVon) continue;
      var q = quelle[nr] || { zellen: {} };
      for (var sp = 1; sp <= QUELL_SPALTEN; sp++) {
        var c = q.zellen[sp], t = ziel(sp, nr);
        if (c) setze(t.s, t.z, { s: c.s, f: c.f ? formelZiel(c.f) : null, art: c.art, wert: c.wert, typ: c.typ });
        else if (spaltenStil[sp] !== undefined) setze(t.s, t.z, { s: spaltenStil[sp], f: null, art: "leer", wert: "" });
      }
    }

    // Vorlage rechnet die Montag-Frühschicht als (Bis-Von)*24; hier einheitlich Bis-Von im Zeitformat.
    Object.keys(aus).forEach(function (ref) {
      var c = aus[ref];
      var m = c.f && /^\(\s*(\$?[A-Z]{1,3}\$?\d+)\s*-\s*(\$?[A-Z]{1,3}\$?\d+)\s*\)\s*\*\s*24$/.exec(c.f);
      if (m) { c.f = m[1] + "-" + m[2]; c.s = stile.zeitStil(c.s); }
    });

    // Summenkasten zwei Zeilen unter dem Freitag-Block, ab Spalte L
    var k = stile.kasten, kz = rechtsBis + dZ + 2;
    function txt(sp, z, s, wert) { setze(sp, z, { s: s, f: null, art: "text", wert: wert }); }
    function frm(sp, z, s, f) { setze(sp, z, { s: s, f: f, art: "zahl", wert: "0" }); }
    function leer(sp, z, s) { setze(sp, z, { s: s, f: null, art: "leer", wert: "" }); }
    txt(12, kz, k.kopfL, " Summe Geplant"); leer(13, kz, k.kopfM); leer(14, kz, k.kopfR);
    txt(15, kz, k.kopfL, "Summe Anwesend"); leer(16, kz, k.kopfM); leer(17, kz, k.kopfR);
    ["Mo", "Tue", "Wed", "Thu", "Fri"].forEach(function (tag, i) {
      var z = kz + 1 + i, g = grenzen[i], rechts = i >= 3;
      var von = g.erste + (rechts ? dZ : 0), bis = g.letzte + (rechts ? dZ : 0);
      var spStd = rechts ? "N" : "E", spIst = rechts ? "Q" : "H";
      txt(12, z, k.tagL, tag); frm(13, z, k.tagM, "SUM(" + spStd + von + ":" + spStd + bis + ")"); txt(14, z, k.tagR, "h");
      txt(15, z, k.tagL, tag); frm(16, z, k.tagM, "SUM(" + spIst + von + ":" + spIst + bis + ")"); txt(17, z, k.tagR, "h");
    });
    var ez = kz + 6;
    frm(12, ez, k.endL, "SUM(M" + (kz + 1) + ":M" + (kz + 5) + ")"); leer(13, ez, k.endM); txt(14, ez, k.endR, "h");
    txt(15, ez, k.endL2, "ttl"); frm(16, ez, k.endM2, "SUM(P" + (kz + 1) + ":P" + (kz + 5) + ")"); txt(17, ez, k.endR, "h");

    // Zwischengespeicherte Werte, damit auch Vorschauen ohne Neuberechnung stimmen
    var memo = {}, inArbeit = {};
    function wertVon(ref, inSumme) {
      var c = aus[ref];
      if (!c) return 0;
      if (c.f) {
        if (memo[ref] !== undefined) return memo[ref];
        if (inArbeit[ref]) throw new Error("Zirkelbezug");
        inArbeit[ref] = true;
        try { memo[ref] = rechne(c.f, wertVon); } finally { inArbeit[ref] = false; }
        return memo[ref];
      }
      if (c.art === "zahl") return parseFloat(c.wert);
      if (c.art === "leer" || inSumme) return 0;
      throw new Error("Text in Rechnung");
    }
    Object.keys(aus).forEach(function (ref) {
      var c = aus[ref];
      if (!c.f) return;
      try { c.wert = String(wertVon(ref, false)); c.art = "zahl"; } catch (e) { /* alter Wert bleibt */ }
    });

    // Verbundene Zellen: aus der Vorlage (soweit im übernommenen Bereich) + Summenkasten
    var verbunden = [];
    var mm = /<mergeCells\b[^>]*>([\s\S]*?)<\/mergeCells>/.exec(gefuelltXml);
    ((mm && mm[1].match(/ref="[^"]+"/g)) || []).forEach(function (r) {
      var p = /ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"/.exec(r);
      if (!p) return;
      var s1 = spaltenNr(p[1]), z1 = +p[2], s2 = spaltenNr(p[3]), z2 = +p[4];
      if (s2 > QUELL_SPALTEN || z2 > rechtsBis) return;
      if ((z1 <= linksEnde) !== (z2 <= linksEnde)) return;
      var a = ziel(s1, z1), b = ziel(s2, z2);
      verbunden.push(spaltenBuchst(a.s) + a.z + ":" + spaltenBuchst(b.s) + b.z);
    });
    verbunden.push("L" + kz + ":N" + kz, "O" + kz + ":Q" + kz, "L" + ez + ":M" + ez);

    // Namensspalten bei sehr langen Namen verbreitern
    var breiten = FEDEX_BREITEN.slice();
    Object.keys(aus).forEach(function (ref) {
      var c = aus[ref], sp = spaltenNr(ref.replace(/\d+/g, ""));
      if ((sp === 2 || sp === 11) && c.art === "text") breiten[sp - 1] = Math.max(breiten[sp - 1], c.wert.length * 0.9 + 1);
    });

    var nachZeile = {};
    Object.keys(aus).forEach(function (ref) {
      var z = parseInt(ref.replace(/[A-Z]+/g, ""), 10);
      (nachZeile[z] = nachZeile[z] || []).push(ref);
    });
    function zelleXml(ref, c) {
      var s = c.s !== null && c.s !== undefined ? ' s="' + c.s + '"' : "";
      if (c.f) {
        var t = c.art === "str" ? ' t="str"' : c.art === "roh" ? ' t="' + c.typ + '"' : "";
        return '<c r="' + ref + '"' + s + t + "><f>" + xmlText(c.f) + "</f>" +
          (c.art === "leer" ? "" : "<v>" + xmlText(c.wert) + "</v>") + "</c>";
      }
      if (c.art === "text" || c.art === "str") return zellenXml(ref, c.s, "text", c.wert);
      if (c.art === "zahl") return zellenXml(ref, c.s, "zahl", c.wert);
      if (c.art === "roh") return '<c r="' + ref + '"' + s + ' t="' + c.typ + '"><v>' + xmlText(c.wert) + "</v></c>";
      return s ? '<c r="' + ref + '"' + s + "/>" : "";
    }
    var zeilenXml = "";
    for (var z = 1; z <= maxZeile; z++) {
      var refs = (nachZeile[z] || []).sort(function (a, b) {
        return spaltenNr(a.replace(/\d+/g, "")) - spaltenNr(b.replace(/\d+/g, ""));
      });
      if (!refs.length) continue;
      zeilenXml += '<row r="' + z + '">' + refs.map(function (ref) { return zelleXml(ref, aus[ref]); }).join("") + "</row>";
    }

    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<dimension ref="A1:Q' + maxZeile + '"/>' +
      '<sheetViews><sheetView tabSelected="1" workbookViewId="0"/></sheetViews>' +
      '<sheetFormatPr baseColWidth="10" defaultRowHeight="15"/><cols>' +
      breiten.map(function (b, i) {
        return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + b + '" customWidth="1"/>';
      }).join("") + "</cols><sheetData>" + zeilenXml + "</sheetData>" +
      '<mergeCells count="' + verbunden.length + '">' +
      verbunden.map(function (r) { return '<mergeCell ref="' + r + '"/>'; }).join("") + "</mergeCells>" +
      '<pageMargins left="0.7" right="0.7" top="0.78740157499999996" bottom="0.78740157499999996" header="0.3" footer="0.3"/>' +
      "</worksheet>";
  }

  /*
   * plan wie bei fuelleVorlage; opt = { kw: 46 } bestimmt den Blattnamen "KW46".
   * Gibt { bytes, nichtUntergebracht, belegt, bloecke } zurück.
   */
  function fedexDatei(JSZip, vorlageBytes, plan, opt) {
    return vorlageOeffnen(JSZip, vorlageBytes).then(function (v) {
      var stilDatei = v.zip.file("xl/styles.xml"), themaDatei = v.zip.file("xl/theme/theme1.xml");
      if (!stilDatei) throw new Error("Vorlage hat nicht den erwarteten Aufbau (Formatvorlagen fehlen).");
      return Promise.all([
        stilDatei.async("string"),
        themaDatei ? themaDatei.async("string") : Promise.resolve(null)
      ]).then(function (teile) {
        var g = blattFuellen(v.sheetXml, v.texte, plan);
        var stile = stileVorbereiten(teile[0]);
        var blatt = fedexBlatt(g.xml, v.texte, g.bloecke, stile);
        var blattName = "KW" + String(opt && opt.kw !== undefined ? opt.kw : "").replace(/[^0-9A-Za-z]/g, "");
        var NS = "http://schemas.openxmlformats.org/";
        var kopf = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

        var neu = new JSZip();
        neu.file("[Content_Types].xml", kopf +
          '<Types xmlns="' + NS + 'package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
          (teile[1] ? '<Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' : "") +
          '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
          "</Types>");
        neu.file("_rels/.rels", kopf +
          '<Relationships xmlns="' + NS + 'package/2006/relationships">' +
          '<Relationship Id="rId1" Type="' + NS + 'officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
          "</Relationships>");
        neu.file("xl/workbook.xml", kopf +
          '<workbook xmlns="' + NS + 'spreadsheetml/2006/main" xmlns:r="' + NS + 'officeDocument/2006/relationships">' +
          "<bookViews><workbookView/></bookViews>" +
          '<sheets><sheet name="' + blattName + '" sheetId="1" r:id="rId1"/></sheets>' +
          '<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>');
        neu.file("xl/_rels/workbook.xml.rels", kopf +
          '<Relationships xmlns="' + NS + 'package/2006/relationships">' +
          '<Relationship Id="rId1" Type="' + NS + 'officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
          '<Relationship Id="rId2" Type="' + NS + 'officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
          (teile[1] ? '<Relationship Id="rId3" Type="' + NS + 'officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>' : "") +
          "</Relationships>");
        neu.file("xl/worksheets/sheet1.xml", blatt);
        neu.file("xl/styles.xml", stile.fertig());
        if (teile[1]) neu.file("xl/theme/theme1.xml", teile[1]);

        return neu.generateAsync({
          type: "uint8array",
          compression: "DEFLATE",
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        }).then(function (bytes) {
          return { bytes: bytes, nichtUntergebracht: g.nichtUntergebracht, belegt: g.belegt, bloecke: g.bloecke.length };
        });
      });
    });
  }

  return {
    fuelleVorlage: fuelleVorlage,
    fedexDatei: fedexDatei,
    vorlageAnalysieren: vorlageAnalysieren,
    geteilteTexte: geteilteTexte,
    serieAusIso: serieAusIso
  };
});
