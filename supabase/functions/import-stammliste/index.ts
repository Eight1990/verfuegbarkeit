// =====================================================================
// Edge Function: import-stammliste
//
// Nimmt die im Browser ausgelesene Stammliste (Personalnummer + Passwort)
// entgegen und legt daraus Login-Zugaenge an.
//
// - modus "vorschau"  -> aendert nichts, zaehlt nur: X neu, Y geaendert, Z deaktiviert
// - modus "anwenden"  -> legt an, aktualisiert Passwoerter, deaktiviert Fehlende
//
// Nur fuer angemeldete Administratoren. Der Service-Role-Key steckt
// ausschliesslich hier auf dem Server, niemals im Browser.
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

// ---------------------------------------------------------------------
// Einstellungen - hier anpassen, falls sich eure Nummernkreise aendern
// ---------------------------------------------------------------------
const PERSONALNUMMER_MUSTER = /^[A-Za-z0-9._-]{1,20}$/;
const PASSWORT_MIN_LAENGE = 6;       // Untergrenze fuer bereits bestehende, unveraenderte Passwoerter
const PASSWORT_MIN_LAENGE_NEU = 10;  // neue oder geaenderte Startpasswoerter (Fund B4-3)
const PASSWORT_MAX_LAENGE = 72; // technische Grenze des Passwort-Hashings
const EMAIL_DOMAIN = "ma.zig.invalid";
const BAN_DAUER = "876000h"; // ca. 100 Jahre = dauerhaft gesperrt

const cors = {
  // Ohne gesetztes Secret gilt die feste App-Adresse, nie "alle".
  "Access-Control-Allow-Origin": Deno.env.get("ERLAUBTE_ORIGIN") ?? "https://eight1990.github.io",
  "Vary": "Origin",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function antwort(daten: unknown, status = 200) {
  return new Response(JSON.stringify(daten), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function emailFuer(personalnummer: string) {
  return `${personalnummer.toLowerCase()}@${EMAIL_DOMAIN}`;
}

// Nicht umkehrbarer Fingerabdruck des Passworts. Dient nur dazu zu erkennen,
// ob sich ein Passwort gegenueber der letzten Liste geaendert hat.
// Der Service-Role-Key wirkt als geheimer Zusatz ("Pepper"), damit aus dem
// Fingerabdruck auch bei Datenbankzugriff nichts abgeleitet werden kann.
async function fingerabdruck(personalnummer: string, passwort: string, pepper: string) {
  const roh = new TextEncoder().encode(`${personalnummer}:${passwort}:${pepper}`);
  const hash = await crypto.subtle.digest("SHA-256", roh);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Fingerabdruck-Geheimnis: eigenes Secret FP_GEHEIMNIS, falls gesetzt, sonst wie
// bisher der Service-Role-Key. Das erste Element gilt fuer neue Fingerabdruecke,
// alle Elemente werden beim Vergleich anerkannt. So lassen sich bestehende
// Fingerabdruecke ohne Passwort-Reset auf das eigene Geheimnis umstellen.
function fpGeheimnisse(serviceKey: string): string[] {
  const eigen = (Deno.env.get("FP_GEHEIMNIS") ?? "").trim();
  return eigen && eigen !== serviceKey ? [eigen, serviceKey] : [serviceKey];
}

// Alle Sitzungen einer Person beenden (Funktion aus Migration 0014).
// Scheitert das, laeuft der Import trotzdem weiter; der Fehler steht im Log.
async function sitzungenBeenden(admin: any, userId: string) {
  try {
    const { error } = await admin.rpc("sitzungen_beenden", { p_user_id: userId, p_ausser: null });
    if (error) console.error("sitzungen_beenden:", error.message);
  } catch (e) {
    console.error("sitzungen_beenden:", e);
  }
}

// Interne Fehlertexte nicht nach aussen geben: Einzelheiten nur ins Log.
function intern(wo: string, e: any) {
  console.error(wo + ":", e?.message ?? e);
  return "Interner Fehler (" + wo + "). Bitte spaeter erneut versuchen.";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return antwort({ fehler: "Nur POST erlaubt." }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // --- 1. Aufrufer pruefen: muss ein angemeldeter Admin sein ---------
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  if (!token) return antwort({ fehler: "Nicht angemeldet." }, 401);

  const { data: userDaten, error: userFehler } = await admin.auth.getUser(token);
  if (userFehler || !userDaten?.user) return antwort({ fehler: "Nicht angemeldet." }, 401);

  const { data: adminZeile } = await admin
    .from("admins")
    .select("user_id")
    .eq("user_id", userDaten.user.id)
    .maybeSingle();

  if (!adminZeile) return antwort({ fehler: "Keine Admin-Berechtigung." }, 403);

  // --- 2. Eingabe pruefen -------------------------------------------
  let body: any;
  try {
    body = await req.json();
  } catch {
    return antwort({ fehler: "Ungueltige Daten." }, 400);
  }

  const modus = body?.modus === "anwenden" ? "anwenden" : "vorschau";
  const roheEintraege = Array.isArray(body?.eintraege) ? body.eintraege : [];

  if (roheEintraege.length === 0) {
    return antwort({ fehler: "Die Liste enthaelt keine Zeilen." }, 400);
  }
  if (roheEintraege.length > 5000) {
    return antwort({ fehler: "Die Liste ist zu lang (max. 5000 Zeilen)." }, 400);
  }

  const fehler: string[] = [];
  const liste = new Map<string, string>();   // personalnummer -> passwort
  const emails = new Map<string, string>();  // E-Mail -> Personalnummer

  for (const [i, e] of roheEintraege.entries()) {
    const zeile = i + 2; // +2 wegen Kopfzeile in der Excel
    const pn = String(e?.personalnummer ?? "").trim();
    const pw = String(e?.passwort ?? "").trim();

    if (!pn) { fehler.push(`Zeile ${zeile}: Personalnummer fehlt.`); continue; }
    if (!PERSONALNUMMER_MUSTER.test(pn)) {
      fehler.push(`Zeile ${zeile}: Personalnummer "${pn}" enthaelt unerlaubte Zeichen.`);
      continue;
    }
    if (pw.length < PASSWORT_MIN_LAENGE) {
      fehler.push(`Zeile ${zeile} (${pn}): Passwort ist kuerzer als ${PASSWORT_MIN_LAENGE} Zeichen.`);
      continue;
    }
    if (pw.length > PASSWORT_MAX_LAENGE) {
      fehler.push(`Zeile ${zeile} (${pn}): Passwort ist zu lang (max. ${PASSWORT_MAX_LAENGE}).`);
      continue;
    }
    if (liste.has(pn)) {
      fehler.push(`Zeile ${zeile}: Personalnummer ${pn} kommt mehrfach vor.`);
      continue;
    }
    // Aus der Personalnummer wird die Anmelde-E-Mail gebildet, und die
    // unterscheidet keine Gross- und Kleinschreibung. "10A" und "10a" waeren
    // also derselbe Zugang - das muss vorher auffallen.
    const mail = emailFuer(pn);
    if (emails.has(mail)) {
      fehler.push(
        `Zeile ${zeile}: Personalnummer ${pn} unterscheidet sich von ` +
        `${emails.get(mail)} nur in Gross- und Kleinschreibung.`,
      );
      continue;
    }
    emails.set(mail, pn);
    liste.set(pn, pw);
  }

  if (fehler.length > 0) {
    return antwort({ ok: false, fehler }, 400);
  }

  // --- 3. Ist-Zustand laden -----------------------------------------
  const { data: vorhandene, error: ladeFehler } = await admin
    .from("employees")
    .select("personalnummer, user_id, aktiv, passwort_fp");

  if (ladeFehler) return antwort({ fehler: intern("Laden", ladeFehler) }, 500);

  const bestand = new Map<string, any>();
  const vergebeneKonten = new Map<string, string>(); // user_id -> Personalnummer
  for (const z of vorhandene ?? []) {
    bestand.set(z.personalnummer, z);
    if (z.user_id) vergebeneKonten.set(z.user_id, z.personalnummer);
  }

  // Alle Auth-Benutzer einmal holen, um E-Mail -> Benutzer zuordnen zu koennen.
  const authNachEmail = new Map<string, any>();
  for (let seite = 1; seite <= 20; seite++) {
    const { data, error } = await admin.auth.admin.listUsers({ page: seite, perPage: 1000 });
    if (error) return antwort({ fehler: intern("Konten laden", error) }, 500);
    for (const u of data.users) if (u.email) authNachEmail.set(u.email.toLowerCase(), u);
    if (data.users.length < 1000) break;
  }

  // --- 4. Vergleichen ------------------------------------------------
  const neu: string[] = [];
  const geaendert: string[] = [];
  const unveraendert: string[] = [];
  const reaktiviert: string[] = [];

  const geheimnisse = fpGeheimnisse(serviceKey);
  const fpNeu = new Map<string, string>();      // Personalnummer -> Fingerabdruck (aktuelles Geheimnis)
  const pwGleich = new Map<string, boolean>();  // Personalnummer -> Listen-Passwort unveraendert?
  const zuKurz: string[] = [];

  for (const [pn, pw] of liste) {
    const vorhanden = bestand.get(pn);
    const fps: string[] = [];
    for (const g of geheimnisse) fps.push(await fingerabdruck(pn, pw, g));
    fpNeu.set(pn, fps[0]);
    const gleich = !!vorhanden && fps.includes(vorhanden.passwort_fp);
    pwGleich.set(pn, gleich);

    // Neue oder geaenderte Startpasswoerter brauchen die groessere Mindestlaenge.
    // Unveraenderte bleiben unberuehrt (dort gilt laengst das eigene Passwort).
    if (!gleich && pw.length < PASSWORT_MIN_LAENGE_NEU) zuKurz.push(pn);

    if (!vorhanden) {
      neu.push(pn);
    } else {
      if (!vorhanden.aktiv) reaktiviert.push(pn);
      if (!gleich) geaendert.push(pn);
      else if (vorhanden.aktiv) unveraendert.push(pn);
    }
  }

  if (zuKurz.length > 0) {
    return antwort({
      ok: false,
      fehler: zuKurz.map((pn) =>
        `${pn}: Neues Startpasswort ist kuerzer als ${PASSWORT_MIN_LAENGE_NEU} Zeichen. ` +
        `Bitte ein zufaelliges Passwort mit mindestens ${PASSWORT_MIN_LAENGE_NEU} Zeichen eintragen.`),
    }, 400);
  }

  const deaktiviert = (vorhandene ?? [])
    .filter((z: any) => z.aktiv && !liste.has(z.personalnummer))
    .map((z: any) => z.personalnummer);

  const zusammenfassung = {
    gesamt_in_liste: liste.size,
    neu: neu.length,
    geaendert: geaendert.length,
    unveraendert: unveraendert.length,
    reaktiviert: reaktiviert.length,
    deaktiviert: deaktiviert.length,
  };

  // Schutz vor Massen-Deaktivierung durch eine falsche oder zu kurze Liste:
  // Fallen mindestens 3 und mehr als die Haelfte der aktiven Zugaenge weg,
  // muss der Aufruf die Zahl ausdruecklich bestaetigen.
  const aktivVorher = (vorhandene ?? []).filter((z: any) => z.aktiv).length;
  const massenDeaktivierung = deaktiviert.length >= 3 && deaktiviert.length > aktivVorher / 2;
  if (modus === "anwenden" && massenDeaktivierung &&
      Number(body?.deaktivieren_bestaetigt) !== deaktiviert.length) {
    return antwort({
      ok: false,
      fehler: [
        `Diese Liste wuerde ${deaktiviert.length} von ${aktivVorher} aktiven Zugaengen deaktivieren. ` +
        "Das wurde nicht ausdruecklich bestaetigt. Bitte Datei pruefen, die Vorschau neu laden und bestaetigen.",
      ],
    }, 409);
  }

  if (modus === "vorschau") {
    return antwort({
      ok: true,
      modus,
      zusammenfassung,
      neu,
      geaendert,
      reaktiviert,
      deaktiviert,
    });
  }

  // --- 5. Anwenden ---------------------------------------------------
  const probleme: string[] = [];

  for (const [pn, pw] of liste) {
    try {
      const fp = fpNeu.get(pn)!;
      const gleich = pwGleich.get(pn) === true;
      const vorhanden = bestand.get(pn);
      const email = emailFuer(pn);
      let userId: string | null = vorhanden?.user_id ?? null;

      // Auth-Benutzer sicherstellen
      if (!userId) {
        const bereitsDa = authNachEmail.get(email);
        if (bereitsDa) {
          // Ein Konto, das schon zu einer anderen Personalnummer gehoert,
          // wird nie uebernommen (Fund B2-5).
          const gehoert = vergebeneKonten.get(bereitsDa.id);
          if (gehoert && gehoert !== pn) {
            throw new Error("Anmeldekonto ist bereits einer anderen Personalnummer zugeordnet.");
          }
          userId = bereitsDa.id;
          const { error } = await admin.auth.admin.updateUserById(userId!, {
            password: pw,
            ban_duration: "none",
          });
          if (error) throw error;
        } else {
          const { data, error } = await admin.auth.admin.createUser({
            email,
            password: pw,
            email_confirm: true,
            user_metadata: { personalnummer: pn },
          });
          if (error) throw error;
          userId = data.user.id;
        }
      } else {
        const mussPasswortSetzen = !gleich;
        const mussEntsperren = !vorhanden.aktiv;
        if (mussPasswortSetzen || mussEntsperren) {
          const aenderung: Record<string, unknown> = {};
          if (mussPasswortSetzen) aenderung.password = pw;
          if (mussEntsperren) aenderung.ban_duration = "none";
          const { error } = await admin.auth.admin.updateUserById(userId, aenderung);
          if (error) throw error;
          // Neues Startpasswort: laufende Sitzungen der Person beenden.
          if (mussPasswortSetzen) await sitzungenBeenden(admin, userId);
        }
      }

      // Neues oder geaendertes Listen-Passwort: der Mitarbeiter muss beim
      // naechsten Login wieder ein eigenes Passwort setzen. Bei unveraenderter
      // Liste bleibt das Flag (und damit das Eigen-Passwort) unangetastet.
      const passwortNeuGesetzt = !vorhanden || !gleich;

      const { error: upsertFehler } = await admin
        .from("employees")
        .upsert(
          {
            personalnummer: pn,
            user_id: userId,
            aktiv: true,
            passwort_fp: fp,
            ...(passwortNeuGesetzt ? { muss_pw_aendern: true } : {}),
          },
          { onConflict: "personalnummer" },
        );
      if (upsertFehler) throw upsertFehler;
    } catch (e: any) {
      probleme.push(`${pn}: ${e?.message ?? String(e)}`);
    }
  }

  // Nicht mehr gelistete Nummern deaktivieren (nicht loeschen)
  for (const pn of deaktiviert) {
    try {
      const vorhanden = bestand.get(pn);
      if (vorhanden?.user_id) {
        const { error } = await admin.auth.admin.updateUserById(vorhanden.user_id, {
          ban_duration: BAN_DAUER,
        });
        if (error) throw error;
        // Deaktiviert: laufende Sitzungen sofort beenden.
        await sitzungenBeenden(admin, vorhanden.user_id);
      }
      const { error: updFehler } = await admin
        .from("employees")
        .update({ aktiv: false })
        .eq("personalnummer", pn);
      if (updFehler) throw updFehler;
    } catch (e: any) {
      probleme.push(`${pn} (deaktivieren): ${e?.message ?? String(e)}`);
    }
  }

  return antwort({
    ok: probleme.length === 0,
    modus,
    zusammenfassung,
    probleme,
  });
});
