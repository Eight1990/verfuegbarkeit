// =====================================================================
// Edge Function: passwort-setzen
//
// Der angemeldete Mitarbeiter legt sein eigenes Passwort fest. Pflicht
// nach dem ersten Login mit dem Startpasswort.
//
// Die Personalnummer kommt aus dem Anmelde-Token, nicht aus der Anfrage:
// jeder kann nur sein eigenes Passwort aendern. Die Regeln werden hier
// geprueft, nicht nur im Browser. Passwort und Flag werden zusammen
// gesetzt, damit das Flag nicht ohne echte Aenderung fallen kann.
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const EIGEN_PASSWORT_MIN_LAENGE = 8;
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

  const { data: mitarbeiter, error: ladeFehler } = await admin
    .from("employees")
    .select("personalnummer, aktiv, passwort_fp")
    .eq("user_id", userDaten.user.id)
    .maybeSingle();

  if (ladeFehler) return antwort({ fehler: ladeFehler.message }, 500);
  if (!mitarbeiter || !mitarbeiter.aktiv) {
    return antwort({ fehler: "Kein Mitarbeiter-Zugang." }, 403);
  }

  // --- Eingabe pruefen ----------------------------------------------
  let body: any;
  try {
    body = await req.json();
  } catch {
    return antwort({ fehler: "Ungueltige Daten." }, 400);
  }

  // Bewusst ohne trim: Leerzeichen am Rand gehoeren zum Passwort.
  const pw = String(body?.passwort ?? "");

  if (pw.length < EIGEN_PASSWORT_MIN_LAENGE) {
    return antwort({ fehler: `Passwort muss mindestens ${EIGEN_PASSWORT_MIN_LAENGE} Zeichen haben.` }, 400);
  }
  if (pw.length > PASSWORT_MAX_LAENGE) {
    return antwort({ fehler: `Passwort darf hoechstens ${PASSWORT_MAX_LAENGE} Zeichen haben.` }, 400);
  }
  if (!/[0-9]/.test(pw)) {
    return antwort({ fehler: "Passwort muss mindestens eine Ziffer enthalten." }, 400);
  }
  if (!/[^\p{L}\p{N}]/u.test(pw)) {
    return antwort({ fehler: "Passwort muss mindestens ein Sonderzeichen enthalten." }, 400);
  }

  const pn = mitarbeiter.personalnummer as string;
  const fp = await fingerabdruck(pn, pw, serviceKey);
  if (fp === mitarbeiter.passwort_fp) {
    return antwort({ fehler: "Das neue Passwort darf nicht dem Startpasswort entsprechen." }, 400);
  }

  // --- Passwort setzen, dann Flag loeschen ----------------------------
  const { error: setzFehler } = await admin.auth.admin.updateUserById(userDaten.user.id, {
    password: pw,
  });
  if (setzFehler) return antwort({ fehler: setzFehler.message }, 500);

  // passwort_fp bleibt unveraendert: der Stammlisten-Import erkennt so
  // "Liste unveraendert" und laesst das eigene Passwort in Ruhe.
  const { error: updFehler } = await admin
    .from("employees")
    .update({ muss_pw_aendern: false })
    .eq("personalnummer", pn);
  if (updFehler) return antwort({ fehler: updFehler.message }, 500);

  return antwort({ ok: true });
});
