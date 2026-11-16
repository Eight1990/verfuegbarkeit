// Test der Edge Function supabase/functions/mitarbeiter-verwalten/index.ts gegen einen
// nachgebauten Supabase-Server (nur erfundene Daten). Laeuft ohne Deno: Node 24 entfernt
// die TypeScript-Typen, der Code laeuft dann in einer vm mit Ersatz fuer Deno und createClient.
// Aufruf: node tests/mitarbeiter-verwalten.test.js
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { stripTypeScriptTypes } = require("node:module");

const QUELLE = path.join(__dirname, "..", "supabase", "functions", "mitarbeiter-verwalten", "index.ts");

// ---------- nachgebauter Server ----------
function neuerServer() {
  const s = {
    employees: [],
    users: [],
    admins: [{ user_id: "admin-1" }],
    rpcAufrufe: [],
    folge: 0
  };
  const passt = (zeile, filter) => filter.every(([k, v]) => zeile[k] === v);
  function tabelle(name) {
    const filter = [];
    let modus = "select", daten = null, einzel = false;
    const b = {
      select() { return b; },
      eq(k, v) { filter.push([k, v]); return b; },
      maybeSingle() { einzel = true; return b; },
      upsert(obj) { modus = "upsert"; daten = obj; return b; },
      update(obj) { modus = "update"; daten = obj; return b; },
      then(ok, fehl) {
        return Promise.resolve().then(() => {
          const zeilen = s[name];
          if (modus === "upsert") {
            const z = zeilen.find((x) => x.personalnummer === daten.personalnummer);
            if (z) Object.assign(z, daten); else zeilen.push(Object.assign({}, daten));
            return { data: null, error: null };
          }
          if (modus === "update") {
            zeilen.filter((z) => passt(z, filter)).forEach((z) => Object.assign(z, daten));
            return { data: null, error: null };
          }
          const treffer = zeilen.filter((z) => passt(z, filter)).map((z) => Object.assign({}, z));
          if (einzel) return { data: treffer[0] || null, error: null };
          return { data: treffer, error: null };
        }).then(ok, fehl);
      }
    };
    return b;
  }
  const client = {
    from: tabelle,
    rpc(n, a) { s.rpcAufrufe.push([n, a]); return Promise.resolve({ data: null, error: null }); },
    auth: {
      getUser(token) {
        if (token === "admin-token") return Promise.resolve({ data: { user: { id: "admin-1" } }, error: null });
        if (token === "ma-token") return Promise.resolve({ data: { user: { id: "u-ma" } }, error: null });
        return Promise.resolve({ data: { user: null }, error: { message: "invalid" } });
      },
      admin: {
        listUsers({ page }) { return Promise.resolve({ data: { users: page === 1 ? s.users.slice() : [] }, error: null }); },
        createUser({ email, password }) {
          const u = { id: "u-" + (++s.folge), email, password, ban: "none" };
          s.users.push(u);
          return Promise.resolve({ data: { user: u }, error: null });
        },
        updateUserById(id, aenderung) {
          const u = s.users.find((x) => x.id === id);
          if (!u) return Promise.resolve({ error: { message: "kein Konto" } });
          if (aenderung.password) u.password = aenderung.password;
          if (aenderung.ban_duration) u.ban = aenderung.ban_duration;
          return Promise.resolve({ error: null });
        }
      }
    }
  };
  return { s, client };
}

// ---------- Function laden ----------
const code = stripTypeScriptTypes(fs.readFileSync(QUELLE, "utf8")).replace(/^\s*import\s.+$/gm, "");
function handlerFuer(server) {
  let handler = null;
  const kontext = {
    Deno: {
      env: { get: (k) => ({ SUPABASE_URL: "https://test.invalid", SUPABASE_SERVICE_ROLE_KEY: "service-test" })[k] },
      serve: (h) => { handler = h; }
    },
    createClient: () => server.client,
    Response, Request, TextEncoder, crypto: globalThis.crypto, console: { error() {}, log() {} }
  };
  vm.runInNewContext(code, kontext, { filename: QUELLE });
  return handler;
}

async function rufe(handler, koerper, token) {
  const req = new Request("https://test.invalid/functions/v1/mitarbeiter-verwalten", {
    method: "POST",
    headers: Object.assign({ "Content-Type": "application/json" }, token ? { Authorization: "Bearer " + token } : {}),
    body: JSON.stringify(koerper)
  });
  const res = await handler(req);
  return { status: res.status, daten: await res.json() };
}

// ---------- Tests ----------
let ok = 0, fehler = 0;
function pruefe(name, bedingung, info) {
  if (bedingung) { ok++; console.log("ok   " + name); }
  else { fehler++; console.log("FAIL " + name + (info ? " – " + JSON.stringify(info) : "")); }
}

(async () => {
  const PW = "Abcd-Efgh-2345";
  // Anmeldung und Admin-Pruefung
  {
    const { client, s } = neuerServer(); const h = handlerFuer({ client, s });
    let r = await rufe(h, { aktion: "anlegen", personalnummer: "9001", passwort: PW }, null);
    pruefe("ohne Anmeldung: 401", r.status === 401 && r.daten.fehler === "Nicht angemeldet.", r);
    r = await rufe(h, { aktion: "anlegen", personalnummer: "9001", passwort: PW }, "ma-token");
    pruefe("Mitarbeiter statt Admin: 403", r.status === 403, r);
    r = await rufe(h, { aktion: "irgendwas" }, "admin-token");
    pruefe("unbekannte Aktion: 400", r.status === 400, r);
  }
  // Anlegen
  {
    const { client, s } = neuerServer(); const h = handlerFuer({ client, s });
    let r = await rufe(h, { aktion: "anlegen", personalnummer: "90 01", passwort: PW }, "admin-token");
    pruefe("Personalnummer mit Leerzeichen: 400", r.status === 400, r);
    r = await rufe(h, { aktion: "anlegen", personalnummer: "9001", passwort: "kurz-123" }, "admin-token");
    pruefe("Startpasswort unter 10 Zeichen: 400", r.status === 400, r);
    r = await rufe(h, { aktion: "anlegen", personalnummer: "9001A", passwort: PW }, "admin-token");
    const e = s.employees.find((x) => x.personalnummer === "9001A");
    const u = s.users.find((x) => x.email === "9001a@ma.zig.invalid");
    pruefe("Anlegen: 200 und ok", r.status === 200 && r.daten.ok === true && r.daten.reaktiviert === false, r);
    pruefe("Anlegen: Konto mit kleingeschriebener E-Mail und Passwort", !!u && u.password === PW);
    pruefe("Anlegen: employees aktiv, muss_pw_aendern, Fingerabdruck", !!e && e.aktiv === true && e.muss_pw_aendern === true &&
      /^[0-9a-f]{64}$/.test(e.passwort_fp) && e.user_id === u.id, e);
    r = await rufe(h, { aktion: "anlegen", personalnummer: "9001A", passwort: PW }, "admin-token");
    pruefe("Anlegen doppelt (aktiv): 409", r.status === 409, r);
    r = await rufe(h, { aktion: "anlegen", personalnummer: "9001a", passwort: PW }, "admin-token");
    pruefe("Nur Gross/Klein verschieden: 409", r.status === 409 && /Gross- und Kleinschreibung/.test(r.daten.fehler), r);
    // fremdes Konto mit gleicher E-Mail, das einer anderen Personalnummer gehoert
    s.users.push({ id: "u-fremd", email: "9002@ma.zig.invalid", password: "x", ban: "none" });
    s.employees.push({ personalnummer: "ANDERE", user_id: "u-fremd", aktiv: false, passwort_fp: "", muss_pw_aendern: false });
    r = await rufe(h, { aktion: "anlegen", personalnummer: "9002", passwort: PW }, "admin-token");
    pruefe("Konto gehoert anderer Personalnummer: 409", r.status === 409, r);
  }
  // Deaktivieren und Reaktivieren
  {
    const { client, s } = neuerServer(); const h = handlerFuer({ client, s });
    for (const pn of ["1", "2", "3", "4", "5"]) await rufe(h, { aktion: "anlegen", personalnummer: pn, passwort: PW }, "admin-token");
    let r = await rufe(h, { aktion: "deaktivieren", personalnummern: ["2"] }, "admin-token");
    const e2 = s.employees.find((x) => x.personalnummer === "2");
    const u2 = s.users.find((x) => x.id === e2.user_id);
    pruefe("Deaktivieren: ok, 1 deaktiviert", r.status === 200 && r.daten.ok && r.daten.deaktiviert === 1, r);
    pruefe("Deaktivieren: aktiv=false, Konto gesperrt, Sitzungen beendet", e2.aktiv === false && u2.ban === "876000h" &&
      s.rpcAufrufe.some(([n, a]) => n === "sitzungen_beenden" && a.p_user_id === u2.id));
    r = await rufe(h, { aktion: "deaktivieren", personalnummern: ["2"] }, "admin-token");
    pruefe("Deaktivieren erneut: schon inaktiv", r.daten.ok && r.daten.deaktiviert === 0 && r.daten.schon_inaktiv === 1, r);
    r = await rufe(h, { aktion: "deaktivieren", personalnummern: ["999"] }, "admin-token");
    pruefe("Deaktivieren unbekannt: 404", r.status === 404, r);
    // Massen-Schutz: 4 aktiv, 3 deaktivieren > Haelfte
    r = await rufe(h, { aktion: "deaktivieren", personalnummern: ["1", "3", "4"] }, "admin-token");
    pruefe("Massen-Deaktivierung ohne Bestaetigung: 409, nichts geaendert", r.status === 409 &&
      s.employees.filter((x) => x.aktiv).length === 4, r);
    r = await rufe(h, { aktion: "deaktivieren", personalnummern: ["1", "3", "4"], bestaetigt: 3 }, "admin-token");
    pruefe("Massen-Deaktivierung mit Bestaetigung: ok", r.daten.ok && r.daten.deaktiviert === 3, r);
    // Reaktivieren
    const NEU = "Neu1-Pass-word";
    r = await rufe(h, { aktion: "reaktivieren", personalnummer: "2", passwort: NEU }, "admin-token");
    pruefe("Reaktivieren: ok, aktiv, entsperrt, neues Passwort, muss_pw_aendern", r.daten.ok && r.daten.reaktiviert === true &&
      e2.aktiv === true && u2.ban === "none" && u2.password === NEU && e2.muss_pw_aendern === true, { r, e2, u2 });
    r = await rufe(h, { aktion: "reaktivieren", personalnummer: "777", passwort: NEU }, "admin-token");
    pruefe("Reaktivieren unbekannt: 404", r.status === 404, r);
    r = await rufe(h, { aktion: "anlegen", personalnummer: "3", passwort: NEU }, "admin-token");
    pruefe("Anlegen einer entfernten Nummer = wieder aktivieren", r.daten.ok && r.daten.reaktiviert === true &&
      s.employees.find((x) => x.personalnummer === "3").aktiv === true, r);
  }
  console.log(fehler ? fehler + " Test(s) fehlgeschlagen" : ok + " Tests bestanden");
  process.exit(fehler ? 1 : 0);
})().catch((e) => { console.log("FAIL Abbruch: " + (e && e.stack || e)); process.exit(1); });
