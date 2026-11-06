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
  function fuelleVorlage(JSZip, vorlageBytes, plan) {
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
        var sheetXml = teile[0], mappeXml = teile[1];
        var texte = geteilteTexte(teile[2]);
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
        zip.file(BLATT, neu);

        var mappeNeu = /fullCalcOnLoad=/.test(mappeXml) ? mappeXml :
          mappeXml.replace(/<calcPr\b([^>]*?)\/>/, '<calcPr$1 fullCalcOnLoad="1"/>');
        zip.file(MAPPE, mappeNeu);

        return zip.generateAsync({
          type: "uint8array",
          compression: "DEFLATE",
          mimeType: "application/vnd.ms-excel.sheet.macroEnabled.12"
        }).then(function (bytes) {
          return { bytes: bytes, nichtUntergebracht: nichtUntergebracht, belegt: belegt, bloecke: bloecke.length };
        });
      });
    });
  }

  return {
    fuelleVorlage: fuelleVorlage,
    vorlageAnalysieren: vorlageAnalysieren,
    geteilteTexte: geteilteTexte,
    serieAusIso: serieAusIso
  };
});
