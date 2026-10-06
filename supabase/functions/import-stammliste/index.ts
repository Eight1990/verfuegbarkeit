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
const PASSWORT_MIN_LAENGE = 6;
const PASSWORT_MAX_LAENGE = 72; // technische Grenze des Passwort-Hashings
const EMAIL_DOMAIN = "ma.zig.invalid";
const BAN_DAUER = "876000h"; // ca. 100 Jahre = dauerhaft gesperrt

const cors = {
  "Access-Control-Allow-Origin": Deno.env.get("ERLAUBTE_ORIGIN") ?? "*",
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

  if (ladeFehler) return antwort({ fehler: ladeFehler.message }, 500);

  const bestand = new Map<string, any>();
  for (const z of vorhandene ?? []) bestand.set(z.personalnummer, z);

  // Alle Auth-Benutzer einmal holen, um E-Mail -> Benutzer zuordnen zu koennen.
  const authNachEmail = new Map<string, any>();
  for (let seite = 1; seite <= 20; seite++) {
    const { data, error } = await admin.auth.admin.listUsers({ page: seite, perPage: 1000 });
    if (error) return antwort({ fehler: error.message }, 500);
    for (const u of data.users) if (u.email) authNachEmail.set(u.email.toLowerCase(), u);
    if (data.users.length < 1000) break;
  }

  // --- 4. Vergleichen ------------------------------------------------
  const neu: string[] = [];
  const geaendert: string[] = [];
  const unveraendert: string[] = [];
  const reaktiviert: string[] = [];

  for (const [pn, pw] of liste) {
    const vorhanden = bestand.get(pn);
    const fp = await fingerabdruck(pn, pw, serviceKey);

    if (!vorhanden) {
      neu.push(pn);
    } else {
      if (!vorhanden.aktiv) reaktiviert.push(pn);
      if (vorhanden.passwort_fp !== fp) geaendert.push(pn);
      else if (vorhanden.aktiv) unveraendert.push(pn);
    }
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
      const fp = await fingerabdruck(pn, pw, serviceKey);
      const vorhanden = bestand.get(pn);
      const email = emailFuer(pn);
      let userId: string | null = vorhanden?.user_id ?? null;

      // Auth-Benutzer sicherstellen
      if (!userId) {
        const bereitsDa = authNachEmail.get(email);
        if (bereitsDa) {
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
        const mussPasswortSetzen = vorhanden.passwort_fp !== fp;
        const mussEntsperren = !vorhanden.aktiv;
        if (mussPasswortSetzen || mussEntsperren) {
          const aenderung: Record<string, unknown> = {};
          if (mussPasswortSetzen) aenderung.password = pw;
          if (mussEntsperren) aenderung.ban_duration = "none";
          const { error } = await admin.auth.admin.updateUserById(userId, aenderung);
          if (error) throw error;
        }
      }

      // Neues oder geaendertes Listen-Passwort: der Mitarbeiter muss beim
      // naechsten Login wieder ein eigenes Passwort setzen. Bei unveraenderter
      // Liste bleibt das Flag (und damit das Eigen-Passwort) unangetastet.
      const passwortNeuGesetzt = !vorhanden || vorhanden.passwort_fp !== fp;

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
