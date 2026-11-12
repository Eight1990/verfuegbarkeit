-- =====================================================================
-- 0014: Haertung nach der Sicherheitspruefung vom 11.11.2026
--
-- Behebt diese Funde (Nummern aus dem Pruefbericht):
--   B2-1  Freitextfeld "hinweis" stillgelegt: Altwerte geleert, Feld
--         gesperrt, abgabe_speichern schreibt es nicht mehr.
--   B2-2  Acht Hilfsfunktionen sind ohne Anmeldung nicht mehr aufrufbar.
--   B2-3  ping() schreibt hoechstens einmal pro Stunde und gibt keine
--         Zaehler mehr zurueck.
--   B2-4  planung_ersetzen bekommt denselben Suchpfad wie alle anderen.
--   B2-6  Solange der Pflicht-Passwortwechsel offen ist, sind eigene
--         Abgaben, Verfuegbarkeiten und geplante Schichten auch nicht
--         mehr LESBAR (bisher war nur das Speichern gesperrt).
--   B3-1  Neue Funktion sitzungen_beenden(): die Edge Functions beenden
--         damit nach einem Passwort-Reset alle Sitzungen der Person.
--   C2-5  Der Loeschlauf raeumt verwaiste Anmeldekonten nach, falls das
--         Loeschen in einem frueheren Lauf gescheitert ist.
--
-- Ausfuehren: Supabase-Dashboard -> SQL Editor -> einfuegen -> Run.
-- Kann gefahrlos mehrfach ausgefuehrt werden.
-- Reihenfolge beim Veroeffentlichen: ERST diese Migration, DANN die
-- Edge Functions, DANN die App (index.html).
-- =====================================================================

-- ---------------------------------------------------------------------
-- B2-1: Freitextfeld "hinweis" stilllegen
-- Das Feld ist seit Langem aus der Maske entfernt. Vorhandene Texte
-- werden geleert; die Zahl der geleerten Zeilen steht in der Ausgabe.
-- ---------------------------------------------------------------------
do $do$
declare
  v_anzahl int;
begin
  update public.submissions set hinweis = null where hinweis is not null;
  get diagnostics v_anzahl = row_count;
  raise notice 'hinweis geleert in % Zeile(n)', v_anzahl;
end;
$do$;

alter table public.submissions drop constraint if exists submissions_hinweis_stillgelegt;
alter table public.submissions
  add constraint submissions_hinweis_stillgelegt check (hinweis is null);

-- Gleiche Signatur wie bisher (die App ruft sie unveraendert auf),
-- p_hinweis wird aber nicht mehr gespeichert.
create or replace function public.abgabe_speichern(
  p_kw_start      date,
  p_max_schichten int,
  p_hinweis       text,
  p_eintraege     jsonb
)
returns timestamptz
language plpgsql
set search_path = public, pg_temp
as $fn$
declare
  v_pn   text := public.current_personalnummer();
  v_zeit timestamptz;
begin
  if v_pn is null then
    raise exception 'Nicht angemeldet oder Personalnummer deaktiviert.';
  end if;

  if not public.woche_bearbeitbar(p_kw_start) then
    raise exception 'Die Abgabefrist fuer diese Woche ist vorbei.';
  end if;

  insert into public.submissions (personalnummer, kw_start_datum, max_schichten, hinweis)
  values (v_pn, p_kw_start, p_max_schichten, null)
  on conflict (personalnummer, kw_start_datum) do update
    set max_schichten = excluded.max_schichten,
        hinweis       = null;

  delete from public.availability
   where personalnummer = v_pn
     and kw_start_datum = p_kw_start;

  insert into public.availability (personalnummer, datum, schicht_id)
  select v_pn, (x->>'datum')::date, x->>'schicht_id'
  from jsonb_array_elements(coalesce(p_eintraege, '[]'::jsonb)) x;

  select s.abgegeben_am into v_zeit
  from public.submissions s
  where s.personalnummer = v_pn
    and s.kw_start_datum = p_kw_start;

  return v_zeit;
end;
$fn$;

revoke all on function public.abgabe_speichern(date, int, text, jsonb) from public, anon;
grant execute on function public.abgabe_speichern(date, int, text, jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- B2-2: Hilfsfunktionen nicht mehr ohne Anmeldung aufrufbar
-- (service_role bleibt berechtigt, damit Edge Functions und Trigger
-- unveraendert laufen.)
-- ---------------------------------------------------------------------
revoke all on function public.is_admin()                  from public, anon;
revoke all on function public.current_personalnummer()    from public, anon;
revoke all on function public.woche_bearbeitbar(date)     from public, anon;
revoke all on function public.aktive_woche()              from public, anon;
revoke all on function public.montag_von(date)            from public, anon;
revoke all on function public.heute_berlin()              from public, anon;
revoke all on function public.standard_frist(date)        from public, anon;
revoke all on function public.dauer_stunden(time, time)   from public, anon;

grant execute on function public.is_admin()                to authenticated, service_role;
grant execute on function public.current_personalnummer()  to authenticated, service_role;
grant execute on function public.woche_bearbeitbar(date)   to authenticated, service_role;
grant execute on function public.aktive_woche()            to authenticated, service_role;
grant execute on function public.montag_von(date)          to authenticated, service_role;
grant execute on function public.heute_berlin()            to authenticated, service_role;
grant execute on function public.standard_frist(date)      to authenticated, service_role;
grant execute on function public.dauer_stunden(time, time) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- B2-3: ping() begrenzen
-- Bleibt ohne Anmeldung aufrufbar (Keep-alive der GitHub-Action),
-- schreibt aber hoechstens einmal pro Stunde und verraet keine Zaehler.
-- ---------------------------------------------------------------------
create or replace function public.ping()
returns json
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
begin
  insert into public.keepalive as k (id, zuletzt, anzahl)
  values (1, now(), 1)
  on conflict (id) do update
    set zuletzt = now(),
        anzahl  = k.anzahl + 1
    where k.zuletzt < now() - interval '1 hour';

  return json_build_object('ok', true, 'zeit', now());
end;
$fn$;

revoke all on function public.ping() from public;
grant execute on function public.ping() to anon, authenticated;

-- ---------------------------------------------------------------------
-- B2-4: einheitlicher Suchpfad
-- ---------------------------------------------------------------------
alter function public.planung_ersetzen(date, jsonb) set search_path = public, pg_temp;

-- ---------------------------------------------------------------------
-- B2-6: Lesen eigener Daten erst nach dem Pflicht-Passwortwechsel
-- (Admins sind nicht betroffen: fuer sie liefert muss_passwort_aendern()
-- immer false, und sie lesen ueber die *_admin_select-Regeln.)
-- ---------------------------------------------------------------------
alter policy submissions_select_eigene on public.submissions
  using (personalnummer = public.current_personalnummer()
         and not public.muss_passwort_aendern());

alter policy availability_select_eigene on public.availability
  using (personalnummer = public.current_personalnummer()
         and not public.muss_passwort_aendern());

alter policy planung_select_eigene on public.planung
  using (personalnummer = public.current_personalnummer()
         and not public.muss_passwort_aendern());

-- ---------------------------------------------------------------------
-- B3-1: Sitzungen einer Person beenden
-- Nur fuer die Edge Functions (service_role). Loescht die Sitzungen im
-- Anmeldesystem; die zugehoerigen Erneuerungs-Tokens fallen mit weg.
-- p_ausser: diese eine Sitzung bleibt bestehen (die, in der jemand
-- gerade selbst sein Passwort aendert).
-- ---------------------------------------------------------------------
create or replace function public.sitzungen_beenden(
  p_user_id uuid,
  p_ausser  uuid default null
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_anzahl int;
begin
  if p_user_id is null then
    return 0;
  end if;

  delete from auth.sessions s
   where s.user_id = p_user_id
     and (p_ausser is null or s.id <> p_ausser);
  get diagnostics v_anzahl = row_count;
  return v_anzahl;
end;
$fn$;

revoke all on function public.sitzungen_beenden(uuid, uuid) from public, anon, authenticated;
grant execute on function public.sitzungen_beenden(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------
-- C2-5: Loeschlauf holt gescheitertes Loeschen von Anmeldekonten nach
-- Stand 0012 plus Schritt 4b: Mitarbeiter-Konten (Anmelde-Domain
-- ma.zig.invalid) ohne Zeile in employees werden entfernt, wenn sie
-- aelter als 7 Tage sind. So ein Konto entsteht nur, wenn Schritt 4 in
-- einem frueheren Lauf gescheitert ist oder ein Import abgebrochen hat.
-- Admin-Konten sind nie betroffen (andere E-Mail-Domain).
-- ---------------------------------------------------------------------
create or replace function public.loeschfrist_anwenden(p_monate int default 12)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_grenze    date := (current_date - make_interval(months => p_monate))::date;
  v_wochen    int;
  v_planung   int;
  v_ma        int;
  v_users     uuid[];
  v_konten    int := 0;
  v_verwaist  int := 0;
  v_fehler    text := null;
  v_ergebnis  json;
begin
  -- 1. Geplante Schichten samt Historie und Stand (kein Fremdschluessel auf weeks)
  delete from public.planung          where kw_start_datum + 7 < v_grenze;
  get diagnostics v_planung = row_count;
  delete from public.planung_historie where kw_start_datum + 7 < v_grenze;
  delete from public.planung_stand    where kw_start_datum + 7 < v_grenze;

  -- 2. Alte Wochen (kaskadiert auf Tage, Schichten, Abgaben, Verfuegbarkeiten)
  delete from public.weeks where kw_start_datum + 7 < v_grenze;
  get diagnostics v_wochen = row_count;

  -- 3. Lange deaktivierte Zugaenge (kaskadiert auf deren Abgaben, Verfuegbarkeiten, Planung)
  with weg as (
    delete from public.employees
     where aktiv = false
       and aktualisiert_am < (now() - make_interval(months => p_monate))
    returning user_id
  )
  select coalesce(array_agg(user_id) filter (where user_id is not null), '{}'), count(*)
    into v_users, v_ma
    from weg;

  -- 4. Zugehoerige Anmeldekonten. Abgesichert: ein Fehler hier darf die
  --    uebrigen Loeschungen nicht rueckgaengig machen.
  if coalesce(array_length(v_users, 1), 0) > 0 then
    begin
      delete from auth.users where id = any(v_users);
      get diagnostics v_konten = row_count;
    exception when others then
      v_fehler := 'Anmeldekonten nicht geloescht: ' || sqlerrm;
    end;
  end if;

  -- 4b. Verwaiste Mitarbeiter-Konten nachholen (siehe Kopf dieses Abschnitts)
  begin
    delete from auth.users u
     where u.email like '%@ma.zig.invalid'
       and u.created_at < now() - interval '7 days'
       and not exists (select 1 from public.employees e where e.user_id = u.id);
    get diagnostics v_verwaist = row_count;
  exception when others then
    v_fehler := coalesce(v_fehler || ' | ', '') || 'Verwaiste Konten nicht geloescht: ' || sqlerrm;
  end;

  -- 5. Protokoll selbst nicht ewig aufheben (2 Jahre)
  delete from public.loeschlauf where gelaufen_am < now() - interval '24 months';

  v_ergebnis := json_build_object(
    'grenze',             v_grenze,
    'wochen_geloescht',   v_wochen,
    'planung_geloescht',  v_planung,
    'zugaenge_geloescht', v_ma,
    'konten_geloescht',   v_konten,
    'verwaiste_konten_geloescht', v_verwaist,
    'fehler',             v_fehler
  );

  insert into public.loeschlauf (ergebnis) values (v_ergebnis::jsonb);

  return v_ergebnis;
end;
$fn$;

revoke all on function public.loeschfrist_anwenden(int) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Kontrolle (nur lesend): erwartet wird in jeder Zeile anon = false,
-- ausser bei ping (true).
-- ---------------------------------------------------------------------
select p.proname as funktion,
       has_function_privilege('anon', p.oid, 'execute')          as anon,
       has_function_privilege('authenticated', p.oid, 'execute') as angemeldet
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('is_admin','current_personalnummer','woche_bearbeitbar','aktive_woche',
                     'montag_von','heute_berlin','standard_frist','dauer_stunden',
                     'ping','sitzungen_beenden','abgabe_speichern','loeschfrist_anwenden')
 order by 1;
