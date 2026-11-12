// =====================================================================
// Edge Function: reset-passwort
//
// Setzt das Passwort EINER Personalnummer neu. Nur fuer Administratoren.
// Das Startpasswort gilt danach wieder, und der Mitarbeiter muss beim
// naechsten Login ein eigenes Passwort setzen (siehe passwort-setzen).
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

// Startpasswort: mindestens 10 Zeichen (Fund B4-3)
const PASSWORT_MIN_LAENGE = 10;
const PASSWORT_MAX_LAENGE = 72;

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

async function fingerabdruck(personalnummer: string, passwort: string, pepper: string) {
  const roh = new TextEncoder().encode(`${personalnummer}:${passwort}:${pepper}`);
  const hash = await crypto.subtle.digest("SHA-256", roh);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Fingerabdruck-Geheimnis: eigenes Secret FP_GEHEIMNIS, falls gesetzt, sonst wie
// bisher der Service-Role-Key. So haengen die Fingerabdruecke nicht mehr am
// Generalschluessel (ein Schluesselwechsel setzt dann keine Passwoerter zurueck).
function fpGeheimnisse(serviceKey: string): string[] {
  const eigen = (Deno.env.get("FP_GEHEIMNIS") ?? "").trim();
  return eigen && eigen !== serviceKey ? [eigen, serviceKey] : [serviceKey];
}

// Alle Sitzungen einer Person beenden (Funktion aus Migration 0014).
// Scheitert das, laeuft der Vorgang trotzdem weiter; der Fehler steht im Log.
async function sitzungenBeenden(admin: any, userId: string, ausser: string | null = null) {
  try {
    const { error } = await admin.rpc("sitzungen_beenden", { p_user_id: userId, p_ausser: ausser });
    if (error) { console.error("sitzungen_beenden:", error.message); return false; }
    return true;
  } catch (e) {
    console.error("sitzungen_beenden:", e);
    return false;
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

  // --- Aufrufer pruefen ---------------------------------------------
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

  // --- Eingabe pruefen ----------------------------------------------
  let body: any;
  try {
    body = await req.json();
  } catch {
    return antwort({ fehler: "Ungueltige Daten." }, 400);
  }

  const pn = String(body?.personalnummer ?? "").trim();
  const pw = String(body?.passwort ?? "").trim();

  if (!pn) return antwort({ fehler: "Personalnummer fehlt." }, 400);
  if (pw.length < PASSWORT_MIN_LAENGE) {
    return antwort({ fehler: `Passwort muss mindestens ${PASSWORT_MIN_LAENGE} Zeichen haben.` }, 400);
  }
  if (pw.length > PASSWORT_MAX_LAENGE) {
    return antwort({ fehler: `Passwort darf hoechstens ${PASSWORT_MAX_LAENGE} Zeichen haben.` }, 400);
  }

  // --- Mitarbeiter suchen -------------------------------------------
  const { data: mitarbeiter, error: ladeFehler } = await admin
    .from("employees")
    .select("personalnummer, user_id, aktiv")
    .eq("personalnummer", pn)
    .maybeSingle();

  if (ladeFehler) return antwort({ fehler: intern("Laden", ladeFehler) }, 500);
  if (!mitarbeiter) return antwort({ fehler: `Personalnummer ${pn} ist nicht angelegt.` }, 404);
  if (!mitarbeiter.user_id) {
    return antwort(
      { fehler: `Personalnummer ${pn} hat keinen Zugang. Bitte Stammliste neu hochladen.` },
      409,
    );
  }
  if (!mitarbeiter.aktiv) {
    return antwort(
      { fehler: `Personalnummer ${pn} ist deaktiviert. Bitte zuerst wieder in die Stammliste aufnehmen.` },
      409,
    );
  }

  // --- Passwort setzen ----------------------------------------------
  const { error: setzFehler } = await admin.auth.admin.updateUserById(mitarbeiter.user_id, {
    password: pw,
  });
  if (setzFehler) return antwort({ fehler: intern("Passwort setzen", setzFehler) }, 500);

  const fp = await fingerabdruck(pn, pw, fpGeheimnisse(serviceKey)[0]);
  const { error: updFehler } = await admin
    .from("employees")
    .update({ passwort_fp: fp, muss_pw_aendern: true })
    .eq("personalnummer", pn);
  if (updFehler) return antwort({ fehler: intern("Speichern", updFehler) }, 500);

  // Laufende Sitzungen der Person beenden: wer noch angemeldet war (auch ein
  // Fremder mit dem alten Passwort), muss sich neu anmelden.
  const beendet = await sitzungenBeenden(admin, mitarbeiter.user_id);

  return antwort({ ok: true, personalnummer: pn, sitzungen_beendet: beendet });
});
