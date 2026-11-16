-- =====================================================================
-- 0016: Schichtboerse (offene Schicht nach der Planung per App vergeben)
--
-- Ablauf:
--   1. Admin gibt eine geplante Schicht frei (jemand faellt aus) oder legt
--      eine Zusatzschicht an: boerse_freigeben(). Die Person wird aus der
--      Planung genommen. Die App des Admins rechnet aus, wer passt (an dem
--      Tag verfuegbar gemeldet, noch nicht eingeplant); nur diese
--      Personalnummern speichert der Server als "darf sehen". Keine Namen.
--   2. Diese Mitarbeitenden sehen das Angebot ueber boerse_meine_angebote()
--      (nur Datum, Schicht, Zeiten - nicht, wer ausgefallen ist).
--   3. Wer zuerst boerse_uebernehmen() aufruft, bekommt die Schicht
--      (Zeilensperre, nur einer gewinnt). Sie steht dann in planung.
--   4. Angebote laufen bis 1 Stunde vor Schichtbeginn (Zeitvergleich,
--      Europe/Berlin). Danach zeigt die Admin-App "nicht besetzt".
--   5. Admin kann ein offenes Angebot zuruecknehmen: boerse_zuruecknehmen().
--      Die urspruengliche Person kommt NICHT zurueck (Entscheidung Max
--      2026-11-16).
--   6. Neu veroeffentlichen (planung_ersetzen) schliesst offene Angebote der
--      Woche (Entscheidung Max 2026-11-16; die App warnt vorher).
--   7. planung_aenderungen protokolliert jede Aenderung nach der Planung
--      (Admin/Boerse, spaeter auch Absagen von Mitarbeitenden).
--      planung_stand.fedex_datei_am merkt, wann zuletzt die FedEx-Datei
--      erstellt wurde ("Aenderungen seit letzter FedEx-Datei").
--
-- Minijob-Grenze wird hier bewusst NICHT geprueft (Entscheidung Max
-- 2026-11-16); die Admin-App zeigt nur einen Hinweis.
--
-- Ausfuehren: Supabase-Dashboard -> SQL Editor -> einfuegen -> Run.
-- Voraussetzung: 0015 ist eingespielt. Kann mehrfach ausgefuehrt werden.
-- Reihenfolge: ERST diese Migration, DANN die App (index.html).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Tabellen
-- ---------------------------------------------------------------------
create table if not exists public.boerse_angebot (
  id               bigserial primary key,
  kw_start_datum   date not null,
  datum            date not null,
  schicht_id       text not null check (schicht_id in ('FRUEH','SPAET','LANG','BUERO')),
  beginn           time not null,
  ende             time not null check (ende > beginn),
  status           text not null default 'frei'
                   check (status in ('frei','uebernommen','zurueckgenommen','geschlossen')),
  frei_von         text references public.employees(personalnummer) on delete set null,
  uebernommen_von  text references public.employees(personalnummer) on delete set null,
  erstellt_am      timestamptz not null default now(),
  erledigt_am      timestamptz
);
create index if not exists boerse_angebot_kw_idx on public.boerse_angebot (kw_start_datum);
create index if not exists boerse_angebot_frei_idx on public.boerse_angebot (status) where status = 'frei';

create table if not exists public.boerse_berechtigt (
  angebot_id      bigint not null references public.boerse_angebot(id) on delete cascade,
  personalnummer  text   not null references public.employees(personalnummer) on delete cascade,
  primary key (angebot_id, personalnummer)
);
create index if not exists boerse_berechtigt_pn_idx on public.boerse_berechtigt (personalnummer);

create table if not exists public.planung_aenderungen (
  id              bigserial primary key,
  kw_start_datum  date not null,
  datum           date not null,
  schicht_id      text not null,
  beginn          time not null,
  ende            time not null,
  aktion          text not null
                  check (aktion in ('freigegeben','zusatz','uebernommen','zurueckgenommen','geschlossen','abgesagt')),
  personalnummer  text references public.employees(personalnummer) on delete set null,
  ausgeloest_von  text not null check (ausgeloest_von in ('admin','boerse','mitarbeiter')),
  angebot_id      bigint references public.boerse_angebot(id) on delete set null,
  am              timestamptz not null default now()
);
create index if not exists planung_aenderungen_kw_idx on public.planung_aenderungen (kw_start_datum);

alter table public.planung_stand add column if not exists fedex_datei_am timestamptz;

alter table public.boerse_angebot      enable row level security;
alter table public.boerse_berechtigt   enable row level security;
alter table public.planung_aenderungen enable row level security;

revoke all on public.boerse_angebot      from anon, authenticated;
revoke all on public.boerse_berechtigt   from anon, authenticated;
revoke all on public.planung_aenderungen from anon, authenticated;
grant select on public.boerse_angebot      to authenticated;
grant select on public.boerse_berechtigt   to authenticated;
grant select on public.planung_aenderungen to authenticated;

-- Lesen nur fuer Admins. Mitarbeitende lesen ausschliesslich ueber
-- boerse_meine_angebote() (ohne "wer ist ausgefallen" und ohne Liste).
drop policy if exists boerse_angebot_admin_select on public.boerse_angebot;
create policy boerse_angebot_admin_select on public.boerse_angebot
  for select to authenticated using (public.is_admin());

drop policy if exists boerse_berechtigt_admin_select on public.boerse_berechtigt;
create policy boerse_berechtigt_admin_select on public.boerse_berechtigt
  for select to authenticated using (public.is_admin());

drop policy if exists planung_aenderungen_admin_select on public.planung_aenderungen;
create policy planung_aenderungen_admin_select on public.planung_aenderungen
  for select to authenticated using (public.is_admin());

-- ---------------------------------------------------------------------
-- Hilfsfunktionen (intern)
-- ---------------------------------------------------------------------
-- Ende der Boerse fuer eine Schicht: 1 Stunde vor Beginn, Ortszeit Muenchen
create or replace function public.boerse_schluss(p_datum date, p_beginn time)
returns timestamptz
language sql
stable
set search_path = public, pg_temp
as $fn$
  select ((p_datum + p_beginn) at time zone 'Europe/Berlin') - interval '1 hour';
$fn$;
revoke all on function public.boerse_schluss(date, time) from public, anon;
grant execute on function public.boerse_schluss(date, time) to authenticated;

-- planung_stand.anzahl nach einer Boersen-Aenderung nachziehen
-- (aktualisiert_am bleibt: das ist der Zeitpunkt der Veroeffentlichung)
create or replace function public.planung_stand_nachzaehlen(p_kw date)
returns void
language sql
security definer
set search_path = public, pg_temp
as $fn$
  update public.planung_stand s
     set anzahl = (select count(*) from public.planung p where p.kw_start_datum = p_kw)
   where s.kw_start_datum = p_kw;
$fn$;
revoke all on function public.planung_stand_nachzaehlen(date) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- boerse_freigeben (nur Admin)
--   p_von        = Personalnummer der bisher eingeplanten Person, oder
--                  null fuer eine Zusatzschicht
--   p_berechtigt = Personalnummern, die das Angebot sehen duerfen
-- Rueckgabe: {"id":..,"berechtigt":n}
-- ---------------------------------------------------------------------
create or replace function public.boerse_freigeben(
  p_kw          date,
  p_datum       date,
  p_schicht_id  text,
  p_beginn      time,
  p_ende        time,
  p_von         text,
  p_berechtigt  text[]
)
returns json
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_id     bigint;
  v_anzahl int;
  v_weg    int;
begin
  if not public.is_admin() then
    raise exception 'Nur fuer Admins.';
  end if;
  if p_kw is null or extract(isodow from p_kw) <> 1 then
    raise exception 'kw muss ein Montag sein.';
  end if;
  if p_datum is null or p_datum not between p_kw and p_kw + 4 then
    raise exception 'Datum liegt nicht in dieser Woche (Mo-Fr).';
  end if;
  if p_schicht_id is null or p_schicht_id not in ('FRUEH','SPAET','LANG','BUERO') then
    raise exception 'Unbekannte Schichtart.';
  end if;
  if p_beginn is null or p_ende is null or p_ende <= p_beginn then
    raise exception 'Ungueltige Zeiten.';
  end if;
  if now() >= public.boerse_schluss(p_datum, p_beginn) then
    raise exception 'Zu spaet: Die Schicht beginnt in weniger als 1 Stunde. Bitte telefonisch regeln.';
  end if;
  if coalesce(array_length(p_berechtigt, 1), 0) > 500 then
    raise exception 'Zu viele Berechtigte.';
  end if;

  if p_von is not null then
    delete from public.planung
     where personalnummer = p_von and datum = p_datum and beginn = p_beginn
       and kw_start_datum = p_kw;
    get diagnostics v_weg = row_count;
    if v_weg <> 1 then
      raise exception 'Diese Schicht ist in der veroeffentlichten Planung nicht (mehr) vorhanden. Bitte neu laden.';
    end if;
  end if;

  insert into public.boerse_angebot (kw_start_datum, datum, schicht_id, beginn, ende, frei_von)
  values (p_kw, p_datum, p_schicht_id, p_beginn, p_ende, p_von)
  returning id into v_id;

  -- Nur aktive Personen, die an dem Tag noch nicht eingeplant sind
  insert into public.boerse_berechtigt (angebot_id, personalnummer)
  select distinct v_id, b.pn
    from unnest(coalesce(p_berechtigt, '{}')) as b(pn)
    join public.employees e on e.personalnummer = b.pn and e.aktiv
   where b.pn is distinct from p_von
     and not exists (select 1 from public.planung p
                      where p.personalnummer = b.pn and p.datum = p_datum);
  get diagnostics v_anzahl = row_count;

  insert into public.planung_aenderungen
    (kw_start_datum, datum, schicht_id, beginn, ende, aktion, personalnummer, ausgeloest_von, angebot_id)
  values (p_kw, p_datum, p_schicht_id, p_beginn, p_ende,
          case when p_von is null then 'zusatz' else 'freigegeben' end,
          p_von, 'admin', v_id);

  perform public.planung_stand_nachzaehlen(p_kw);

  return json_build_object('id', v_id, 'berechtigt', v_anzahl);
end;
$fn$;
revoke all on function public.boerse_freigeben(date, date, text, time, time, text, text[]) from public, anon;
grant execute on function public.boerse_freigeben(date, date, text, time, time, text, text[]) to authenticated;

-- ---------------------------------------------------------------------
-- boerse_zuruecknehmen (nur Admin): offenes Angebot beenden.
-- Die Schicht bleibt unbesetzt; niemand wird zurueck eingeplant.
-- ---------------------------------------------------------------------
create or replace function public.boerse_zuruecknehmen(p_id bigint)
returns json
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  a public.boerse_angebot%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Nur fuer Admins.';
  end if;
  select * into a from public.boerse_angebot where id = p_id for update;
  if not found then
    raise exception 'Angebot nicht gefunden.';
  end if;
  if a.status <> 'frei' then
    return json_build_object('ok', false, 'status', a.status);
  end if;
  update public.boerse_angebot
     set status = 'zurueckgenommen', erledigt_am = now()
   where id = p_id;
  insert into public.planung_aenderungen
    (kw_start_datum, datum, schicht_id, beginn, ende, aktion, personalnummer, ausgeloest_von, angebot_id)
  values (a.kw_start_datum, a.datum, a.schicht_id, a.beginn, a.ende, 'zurueckgenommen', null, 'admin', a.id);
  return json_build_object('ok', true, 'status', 'zurueckgenommen');
end;
$fn$;
revoke all on function public.boerse_zuruecknehmen(bigint) from public, anon;
grant execute on function public.boerse_zuruecknehmen(bigint) to authenticated;

-- ---------------------------------------------------------------------
-- boerse_meine_angebote (Mitarbeitende): offene Angebote fuer mich.
-- Liefert nur Datum, Schicht und Zeiten.
-- ---------------------------------------------------------------------
create or replace function public.boerse_meine_angebote()
returns table (id bigint, datum date, schicht_id text, beginn time, ende time)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select a.id, a.datum, a.schicht_id, a.beginn, a.ende
    from public.boerse_angebot a
    join public.boerse_berechtigt b
      on b.angebot_id = a.id and b.personalnummer = public.current_personalnummer()
    join public.employees e
      on e.personalnummer = b.personalnummer and e.aktiv
   where a.status = 'frei'
     and not public.muss_passwort_aendern()
     and now() < public.boerse_schluss(a.datum, a.beginn)
     and not exists (select 1 from public.planung p
                      where p.personalnummer = b.personalnummer and p.datum = a.datum)
   order by a.datum, a.beginn;
$fn$;
revoke all on function public.boerse_meine_angebote() from public, anon;
grant execute on function public.boerse_meine_angebote() to authenticated;

-- ---------------------------------------------------------------------
-- boerse_uebernehmen (Mitarbeitende): Schicht fest uebernehmen.
-- Zeilensperre: bei zwei gleichzeitigen Klicks gewinnt genau einer.
-- Rueckgabe: {"ok":true} oder {"ok":false,"grund":"vergeben"|"zu_spaet"|
--            "schon_eingeplant"|"nicht_berechtigt"}
-- ---------------------------------------------------------------------
create or replace function public.boerse_uebernehmen(p_id bigint)
returns json
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_pn text := public.current_personalnummer();
  a    public.boerse_angebot%rowtype;
begin
  if v_pn is null then
    raise exception 'Nicht angemeldet.';
  end if;
  if public.muss_passwort_aendern() then
    raise exception 'Bitte zuerst das Passwort aendern.';
  end if;
  if not exists (select 1 from public.employees e where e.personalnummer = v_pn and e.aktiv) then
    raise exception 'Zugang ist nicht aktiv.';
  end if;

  select * into a from public.boerse_angebot where id = p_id for update;
  if not found then
    return json_build_object('ok', false, 'grund', 'vergeben');
  end if;
  if not exists (select 1 from public.boerse_berechtigt b
                  where b.angebot_id = a.id and b.personalnummer = v_pn) then
    return json_build_object('ok', false, 'grund', 'nicht_berechtigt');
  end if;
  if a.status <> 'frei' then
    return json_build_object('ok', false, 'grund', 'vergeben');
  end if;
  if now() >= public.boerse_schluss(a.datum, a.beginn) then
    return json_build_object('ok', false, 'grund', 'zu_spaet');
  end if;
  if exists (select 1 from public.planung p where p.personalnummer = v_pn and p.datum = a.datum) then
    return json_build_object('ok', false, 'grund', 'schon_eingeplant');
  end if;

  insert into public.planung (personalnummer, datum, schicht_id, beginn, ende, kw_start_datum)
  values (v_pn, a.datum, a.schicht_id, a.beginn, a.ende, a.kw_start_datum);

  update public.boerse_angebot
     set status = 'uebernommen', uebernommen_von = v_pn, erledigt_am = now()
   where id = a.id;

  insert into public.planung_aenderungen
    (kw_start_datum, datum, schicht_id, beginn, ende, aktion, personalnummer, ausgeloest_von, angebot_id)
  values (a.kw_start_datum, a.datum, a.schicht_id, a.beginn, a.ende, 'uebernommen', v_pn, 'boerse', a.id);

  perform public.planung_stand_nachzaehlen(a.kw_start_datum);

  return json_build_object('ok', true, 'datum', a.datum, 'beginn', a.beginn, 'ende', a.ende);
end;
$fn$;
revoke all on function public.boerse_uebernehmen(bigint) from public, anon;
grant execute on function public.boerse_uebernehmen(bigint) to authenticated;

-- ---------------------------------------------------------------------
-- fedex_datei_vermerken (nur Admin): FedEx-Datei fuer die Woche erstellt.
-- Grundlage fuer "Aenderungen seit letzter FedEx-Datei".
-- ---------------------------------------------------------------------
create or replace function public.fedex_datei_vermerken(p_kw date)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_am timestamptz := now();
begin
  if not public.is_admin() then
    raise exception 'Nur fuer Admins.';
  end if;
  update public.planung_stand set fedex_datei_am = v_am where kw_start_datum = p_kw;
  return v_am;
end;
$fn$;
revoke all on function public.fedex_datei_vermerken(date) from public, anon;
grant execute on function public.fedex_datei_vermerken(date) to authenticated;

-- ---------------------------------------------------------------------
-- planung_ersetzen: Stand 0007 (+ Suchpfad aus 0014) plus:
-- offene Boersen-Angebote der Woche werden geschlossen.
-- ---------------------------------------------------------------------
create or replace function public.planung_ersetzen(kw date, eintraege jsonb)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_erwartet   integer;
  v_eingefuegt integer;
  v_unbekannt  text;
  v_alt        jsonb;
begin
  if not public.is_admin() then
    raise exception 'Nur Admins duerfen die Planung aendern.';
  end if;
  if extract(isodow from kw) <> 1 then
    raise exception 'kw muss ein Montag sein.';
  end if;
  if jsonb_typeof(eintraege) <> 'array' then
    raise exception 'eintraege muss eine Liste sein.';
  end if;
  if jsonb_array_length(eintraege) > 2000 then
    raise exception 'Zu viele Eintraege.';
  end if;

  select string_agg(distinct coalesce(e.personalnummer, '(leer)'), ', ') into v_unbekannt
    from jsonb_to_recordset(eintraege) as e(personalnummer text)
    left join public.employees m
           on m.personalnummer = e.personalnummer and m.aktiv
   where m.personalnummer is null;
  if v_unbekannt is not null then
    raise exception 'Unbekannte oder inaktive Personalnummer: %', v_unbekannt;
  end if;

  if exists (
    select 1
      from jsonb_to_recordset(eintraege) as e(
             datum date, schicht_id text, beginn time, ende time)
     where e.datum is null or e.datum not between kw and kw + 4
        or e.schicht_id is null or e.schicht_id not in ('FRUEH','SPAET','LANG','BUERO')
        or e.beginn is null or e.ende is null or e.ende <= e.beginn
  ) then
    raise exception 'Ungueltiger Eintrag (Datum ausserhalb Mo-Fr, Schichtart oder Zeit).';
  end if;

  select count(*) into v_erwartet from (
    select distinct e.personalnummer, e.datum, e.beginn
      from jsonb_to_recordset(eintraege) as e(
             personalnummer text, datum date, beginn time)
  ) d;

  select coalesce(jsonb_agg(to_jsonb(p)), '[]'::jsonb) into v_alt
    from public.planung p where p.kw_start_datum = kw;
  if jsonb_array_length(v_alt) > 0 then
    insert into public.planung_historie (kw_start_datum, daten) values (kw, v_alt);
  end if;

  delete from public.planung where kw_start_datum = kw;

  insert into public.planung (personalnummer, datum, schicht_id, beginn, ende, kw_start_datum)
  select distinct on (e.personalnummer, e.datum, e.beginn)
         e.personalnummer, e.datum, e.schicht_id, e.beginn, e.ende, kw
    from jsonb_to_recordset(eintraege) as e(
           personalnummer text, datum date, schicht_id text, beginn time, ende time);

  get diagnostics v_eingefuegt = row_count;
  if v_eingefuegt <> v_erwartet then
    raise exception 'Anzahl stimmt nicht (erwartet %, eingefuegt %).', v_erwartet, v_eingefuegt;
  end if;

  -- Neu (0016): offene Boersen-Angebote dieser Woche schliessen
  insert into public.planung_aenderungen
    (kw_start_datum, datum, schicht_id, beginn, ende, aktion, personalnummer, ausgeloest_von, angebot_id)
  select a.kw_start_datum, a.datum, a.schicht_id, a.beginn, a.ende, 'geschlossen', null, 'admin', a.id
    from public.boerse_angebot a
   where a.kw_start_datum = kw and a.status = 'frei';
  update public.boerse_angebot
     set status = 'geschlossen', erledigt_am = now()
   where kw_start_datum = kw and status = 'frei';

  insert into public.planung_stand (kw_start_datum, aktualisiert_am, anzahl)
  values (kw, now(), v_eingefuegt)
  on conflict (kw_start_datum) do update
    set aktualisiert_am = excluded.aktualisiert_am, anzahl = excluded.anzahl;

  return json_build_object('erwartet', v_erwartet, 'eingefuegt', v_eingefuegt);
end;
$fn$;
revoke all on function public.planung_ersetzen(date, jsonb) from public, anon;
grant execute on function public.planung_ersetzen(date, jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- Loeschfrist: Stand 0014 plus Boersen-Tabellen und Aenderungsliste
-- (gleiche Grenze wie die Planung: 12 Monate nach Ende der Woche)
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
  -- 1b. (0016) Aenderungsliste und Boerse (Berechtigte kaskadieren mit)
  delete from public.planung_aenderungen where kw_start_datum + 7 < v_grenze;
  delete from public.boerse_angebot      where kw_start_datum + 7 < v_grenze;

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

  -- 4b. Verwaiste Mitarbeiter-Konten nachholen
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
-- Kontrolle (nur lesend): anon = false in jeder Zeile;
-- planung_stand_nachzaehlen und loeschfrist_anwenden: angemeldet = false
-- ---------------------------------------------------------------------
select p.proname as funktion,
       has_function_privilege('anon', p.oid, 'execute')          as anon,
       has_function_privilege('authenticated', p.oid, 'execute') as angemeldet
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('boerse_schluss','planung_stand_nachzaehlen','boerse_freigeben',
                     'boerse_zuruecknehmen','boerse_meine_angebote','boerse_uebernehmen',
                     'fedex_datei_vermerken','planung_ersetzen','loeschfrist_anwenden')
 order by 1;
