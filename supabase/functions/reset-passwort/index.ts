// =====================================================================
// Edge Function: reset-passwort
//
// Setzt das Passwort EINER Personalnummer neu. Nur fuer Administratoren.
// Mitarbeitende koennen ihr Passwort nicht selbst zuruecksetzen.
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const PASSWORT_MIN_LAENGE = 6;
const PASSWORT_MAX_LAENGE = 72;

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

  if (ladeFehler) return antwort({ fehler: ladeFehler.message }, 500);
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
  if (setzFehler) return antwort({ fehler: setzFehler.message }, 500);

  const fp = await fingerabdruck(pn, pw, serviceKey);
  const { error: updFehler } = await admin
    .from("employees")
    .update({ passwort_fp: fp })
    .eq("personalnummer", pn);
  if (updFehler) return antwort({ fehler: updFehler.message }, 500);

  return antwort({ ok: true, personalnummer: pn });
});
