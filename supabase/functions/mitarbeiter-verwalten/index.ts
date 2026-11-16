// =====================================================================
// Edge Function: mitarbeiter-verwalten
//
// Einzelne Zugaenge im Admin-Bereich pflegen (Entscheidung Max 2026-11-16:
// Mitarbeitende werden in der App gepflegt, nicht nur ueber die Stammliste).
//
// - aktion "anlegen"      {personalnummer, passwort}
//     Neuer Zugang mit Startpasswort. Ist die Nummer schon da und
//     deaktiviert, wird sie wieder aktiviert (wie "reaktivieren").
// - aktion "reaktivieren" {personalnummer, passwort}
//     Deaktivierten Zugang mit neuem Startpasswort wieder freischalten.
// - aktion "deaktivieren" {personalnummern: [...], bestaetigt?: Zahl}
//     Zugaenge sperren (nicht loeschen), laufende Sitzungen beenden.
//     Schutz vor Massen-Deaktivierung wie bei import-stammliste.
//
// Namen und Profile liegen NICHT hier, sondern verschluesselt im Tresor
// (Browser). Nur fuer angemeldete Administratoren; der Service-Role-Key
// steckt ausschliesslich hier auf dem Server.
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

// Gleiche Regeln wie import-stammliste / reset-passwort
const PERSONALNUMMER_MUSTER = /^[A-Za-z0-9._-]{1,20}$/;
const PASSWORT_MIN_LAENGE = 10;
const PASSWORT_MAX_LAENGE = 72;
const EMAIL_DOMAIN = "ma.zig.invalid";
const BAN_DAUER = "876000h"; // ca. 100 Jahre = dauerhaft gesperrt
const MAX_DEAKTIVIEREN = 500;

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

async function fingerabdruck(personalnummer: string, passwort: string, pepper: string) {
  const roh = new TextEncoder().encode(`${personalnummer}:${passwort}:${pepper}`);
  const hash = await crypto.subtle.digest("SHA-256", roh);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Wie import-stammliste: eigenes Secret FP_GEHEIMNIS, sonst Service-Role-Key.
function fpGeheimnis(serviceKey: string): string {
  const eigen = (Deno.env.get("FP_GEHEIMNIS") ?? "").trim();
  return eigen || serviceKey;
}

// Alle Sitzungen einer Person beenden (Funktion aus Migration 0014).
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

// Anmeldekonto zu einer E-Mail suchen (seitenweise, wie import-stammliste)
async function kontoNachEmail(admin: any, email: string) {
  for (let seite = 1; seite <= 20; seite++) {
    const { data, error } = await admin.auth.admin.listUsers({ page: seite, perPage: 1000 });
    if (error) throw error;
    const treffer = data.users.find((u: any) => (u.email ?? "").toLowerCase() === email);
    if (treffer) return treffer;
    if (data.users.length < 1000) return null;
  }
  return null;
}

// Startpasswort pruefen; liefert Fehlertext oder null
function passwortFehler(pw: string): string | null {
  if (pw.length < PASSWORT_MIN_LAENGE) return `Startpasswort muss mindestens ${PASSWORT_MIN_LAENGE} Zeichen haben.`;
  if (pw.length > PASSWORT_MAX_LAENGE) return `Startpasswort darf hoechstens ${PASSWORT_MAX_LAENGE} Zeichen haben.`;
  return null;
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

  // --- 2. Eingabe lesen ----------------------------------------------
  let body: any;
  try {
    body = await req.json();
  } catch {
    return antwort({ fehler: "Ungueltige Daten." }, 400);
  }
  const aktion = String(body?.aktion ?? "");

  // --- 3a. Anlegen / Reaktivieren ------------------------------------
  if (aktion === "anlegen" || aktion === "reaktivieren") {
    const pn = String(body?.personalnummer ?? "").trim();
    const pw = String(body?.passwort ?? "").trim();
    if (!pn) return antwort({ fehler: "Personalnummer fehlt." }, 400);
    if (!PERSONALNUMMER_MUSTER.test(pn)) {
      return antwort({ fehler: `Personalnummer "${pn}" enthaelt unerlaubte Zeichen (erlaubt: Buchstaben, Ziffern, . _ -; hoechstens 20).` }, 400);
    }
    const pf = passwortFehler(pw);
    if (pf) return antwort({ fehler: pf }, 400);

    const { data: vorhanden, error: ladeFehler } = await admin
      .from("employees")
      .select("personalnummer, user_id, aktiv")
      .eq("personalnummer", pn)
      .maybeSingle();
    if (ladeFehler) return antwort({ fehler: intern("Laden", ladeFehler) }, 500);

    if (vorhanden?.aktiv) {
      return antwort({ fehler: `Personalnummer ${pn} hat bereits einen aktiven Zugang.` }, 409);
    }
    if (aktion === "reaktivieren" && !vorhanden) {
      return antwort({ fehler: `Personalnummer ${pn} ist nicht angelegt.` }, 404);
    }

    // Gleiche E-Mail mit anderer Schreibweise (z. B. "10A" und "10a") abfangen
    const email = emailFuer(pn);
    const { data: alle, error: alleFehler } = await admin.from("employees").select("personalnummer, user_id");
    if (alleFehler) return antwort({ fehler: intern("Laden", alleFehler) }, 500);
    const doppelt = (alle ?? []).find((z: any) => z.personalnummer !== pn && emailFuer(z.personalnummer) === email);
    if (doppelt) {
      return antwort({ fehler: `Personalnummer ${pn} unterscheidet sich von ${doppelt.personalnummer} nur in Gross- und Kleinschreibung.` }, 409);
    }

    try {
      let userId: string | null = vorhanden?.user_id ?? null;
      if (userId) {
        const { error } = await admin.auth.admin.updateUserById(userId, { password: pw, ban_duration: "none" });
        if (error) throw error;
        await sitzungenBeenden(admin, userId);
      } else {
        const konto = await kontoNachEmail(admin, email);
        if (konto) {
          // Ein Konto, das schon zu einer anderen Personalnummer gehoert, wird nie uebernommen.
          const gehoert = (alle ?? []).find((z: any) => z.user_id === konto.id);
          if (gehoert && gehoert.personalnummer !== pn) {
            return antwort({ fehler: "Anmeldekonto ist bereits einer anderen Personalnummer zugeordnet." }, 409);
          }
          userId = konto.id;
          const { error } = await admin.auth.admin.updateUserById(userId!, { password: pw, ban_duration: "none" });
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
      }

      const fp = await fingerabdruck(pn, pw, fpGeheimnis(serviceKey));
      const { error: upsertFehler } = await admin
        .from("employees")
        .upsert(
          { personalnummer: pn, user_id: userId, aktiv: true, passwort_fp: fp, muss_pw_aendern: true },
          { onConflict: "personalnummer" },
        );
      if (upsertFehler) throw upsertFehler;
    } catch (e: any) {
      return antwort({ fehler: intern(aktion === "anlegen" ? "Anlegen" : "Reaktivieren", e) }, 500);
    }
    return antwort({ ok: true, aktion, personalnummer: pn, reaktiviert: !!vorhanden });
  }

  // --- 3b. Deaktivieren -----------------------------------------------
  if (aktion === "deaktivieren") {
    const roh = Array.isArray(body?.personalnummern) ? body.personalnummern : [];
    const pns = Array.from(new Set(roh.map((x: any) => String(x ?? "").trim()).filter((x: string) => x))) as string[];
    if (!pns.length) return antwort({ fehler: "Keine Personalnummer angegeben." }, 400);
    if (pns.length > MAX_DEAKTIVIEREN) return antwort({ fehler: `Hoechstens ${MAX_DEAKTIVIEREN} auf einmal.` }, 400);

    const { data: bestand, error: ladeFehler } = await admin
      .from("employees")
      .select("personalnummer, user_id, aktiv");
    if (ladeFehler) return antwort({ fehler: intern("Laden", ladeFehler) }, 500);
    const nachPn = new Map((bestand ?? []).map((z: any) => [z.personalnummer, z]));
    const unbekannt = pns.filter((pn) => !nachPn.has(pn));
    if (unbekannt.length) return antwort({ fehler: `Nicht angelegt: ${unbekannt.slice(0, 10).join(", ")}` }, 404);
    const ziel = pns.filter((pn) => (nachPn.get(pn) as any).aktiv);

    // Schutz vor Massen-Deaktivierung (gleiche Regel wie import-stammliste)
    const aktivVorher = (bestand ?? []).filter((z: any) => z.aktiv).length;
    if (ziel.length >= 3 && ziel.length > aktivVorher / 2 && Number(body?.bestaetigt) !== ziel.length) {
      return antwort({
        ok: false,
        fehler: `Das wuerde ${ziel.length} von ${aktivVorher} aktiven Zugaengen deaktivieren. Bitte ausdruecklich bestaetigen.`,
      }, 409);
    }

    const probleme: string[] = [];
    for (const pn of ziel) {
      try {
        const z: any = nachPn.get(pn);
        if (z.user_id) {
          const { error } = await admin.auth.admin.updateUserById(z.user_id, { ban_duration: BAN_DAUER });
          if (error) throw error;
          await sitzungenBeenden(admin, z.user_id);
        }
        const { error: updFehler } = await admin.from("employees").update({ aktiv: false }).eq("personalnummer", pn);
        if (updFehler) throw updFehler;
      } catch (e: any) {
        console.error("deaktivieren " + pn + ":", e?.message ?? e);
        probleme.push(pn);
      }
    }
    return antwort({
      ok: probleme.length === 0,
      aktion,
      deaktiviert: ziel.length - probleme.length,
      schon_inaktiv: pns.length - ziel.length,
      probleme: probleme.map((pn) => `${pn}: konnte nicht deaktiviert werden (Einzelheiten im Log).`),
    });
  }

  return antwort({ fehler: "Unbekannte Aktion." }, 400);
});
