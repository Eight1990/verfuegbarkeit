-- =====================================================================
-- ZiG Verfuegbarkeits-App / FedEx-Schichten
-- Migration 2 von 3: Rollen-Funktionen, Row Level Security, RPC-Funktionen
-- Im Supabase-Dashboard unter "SQL Editor" einfuegen und ausfuehren.
--
-- Grundregel: Ohne passende Policy ist JEDER Zugriff verboten.
-- Mitarbeitende sehen und aendern ausschliesslich ihre eigenen Zeilen,
-- und das nur solange die Abgabefrist der Folgewoche laeuft.
-- Diese Pruefung findet hier in der Datenbank statt, nicht im Browser.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Rollen-Hilfsfunktionen
--
-- SECURITY DEFINER: laufen mit den Rechten des Eigentuemers und umgehen
-- damit RLS. Sonst wuerden sich die Policies gegenseitig aufrufen.
-- ---------------------------------------------------------------------

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select exists (
    select 1 from public.admins a where a.user_id = auth.uid()
  );
$fn$;

-- Personalnummer des angemeldeten Mitarbeiters.
-- Gibt NULL zurueck, wenn nicht angemeldet oder die Nummer deaktiviert ist.
create or replace function public.current_personalnummer()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select e.personalnummer
  from public.employees e
  where e.user_id = auth.uid()
    and e.aktiv = true;
$fn$;

-- Darf diese Woche gerade bearbeitet werden?
-- Nur die Folgewoche, und nur solange die Frist nicht abgelaufen ist.
create or replace function public.woche_bearbeitbar(p_kw_start date)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select p_kw_start = public.aktive_woche()
     and exists (
       select 1 from public.weeks w
       where w.kw_start_datum = p_kw_start
         and now() < w.abgabefrist
     );
$fn$;

-- ---------------------------------------------------------------------
-- RLS aktivieren
-- ---------------------------------------------------------------------

alter table public.employees       enable row level security;
alter table public.admins          enable row level security;
alter table public.shift_types     enable row level security;
alter table public.shift_templates enable row level security;
alter table public.weeks           enable row level security;
alter table public.week_days       enable row level security;
alter table public.week_shifts     enable row level security;
alter table public.submissions     enable row level security;
alter table public.availability    enable row level security;

-- ---------------------------------------------------------------------
-- Tabellenrechte ausdruecklich setzen
--
-- Supabase vergibt neuen Tabellen standardmaessig weitgehende Rechte an
-- die Rollen "anon" (nicht angemeldet) und "authenticated" (angemeldet).
-- Wir nehmen alles zurueck und geben nur das Noetige wieder frei.
-- So gilt der Schutz doppelt: ueber die Rechte UND ueber die Policies.
--
-- Wichtig: ein Recht auf Spaltenebene wirkt in PostgreSQL nur, wenn das
-- Recht auf Tabellenebene NICHT vorhanden ist. Deshalb erst "revoke all".
-- ---------------------------------------------------------------------

revoke all on public.employees       from anon, authenticated;
revoke all on public.admins          from anon, authenticated;
revoke all on public.shift_types     from anon, authenticated;
revoke all on public.shift_templates from anon, authenticated;
revoke all on public.weeks           from anon, authenticated;
revoke all on public.week_days       from anon, authenticated;
revoke all on public.week_shifts     from anon, authenticated;
revoke all on public.submissions     from anon, authenticated;
revoke all on public.availability    from anon, authenticated;

-- Ohne Anmeldung ist keine einzige Tabelle erreichbar.
-- "anon" darf ausschliesslich die Funktion ping() aufrufen (siehe unten).

-- Angemeldete duerfen von employees NUR diese Spalten lesen.
-- Der Passwort-Fingerabdruck fehlt bewusst: an ihn kommt niemand heran,
-- auch kein Admin. Nur die Edge Function mit Service-Role liest ihn.
grant select (personalnummer, user_id, aktiv, erstellt_am, aktualisiert_am)
  on public.employees to authenticated;

-- Mitarbeitende werden ausschliesslich ueber die Edge Function angelegt,
-- geaendert und deaktiviert. Aus dem Browser ist kein Schreiben moeglich.

grant select on public.admins to authenticated;

-- Schichten und Wochen: lesen alle, aendern nur Admins (per Policy geprueft)
grant select, update on public.shift_types     to authenticated;
grant select, update on public.shift_templates to authenticated;
grant select, update on public.weeks           to authenticated;
grant select, update on public.week_days       to authenticated;
grant select, update on public.week_shifts     to authenticated;

-- Eigene Abgabe: lesen, anlegen, aendern, loeschen (per Policy auf die
-- eigene Personalnummer und die laufende Frist begrenzt)
grant select, insert, update, delete on public.submissions  to authenticated;
grant select, insert, update, delete on public.availability to authenticated;

-- ---------------------------------------------------------------------
-- employees
-- ---------------------------------------------------------------------

-- Mitarbeiter sieht ausschliesslich seine eigene Zeile
create policy employees_select_eigene on public.employees
  for select to authenticated
  using (user_id = auth.uid());

-- Admin sieht alle Personalnummern (Abgabestatus, Export)
create policy employees_admin_select on public.employees
  for select to authenticated
  using (public.is_admin());

-- Anlegen, Passwort setzen und Deaktivieren passiert ausschliesslich ueber
-- die Edge Functions (Service-Role) - dafuer ist bewusst keine Policy noetig.

-- ---------------------------------------------------------------------
-- admins
-- ---------------------------------------------------------------------

create policy admins_select_eigene on public.admins
  for select to authenticated
  using (user_id = auth.uid());

create policy admins_admin_select on public.admins
  for select to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------
-- Schichtarten und Standardzeiten: alle Angemeldeten duerfen lesen
-- ---------------------------------------------------------------------

create policy shift_types_select on public.shift_types
  for select to authenticated using (true);

create policy shift_types_admin on public.shift_types
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy shift_templates_select on public.shift_templates
  for select to authenticated using (true);

create policy shift_templates_admin on public.shift_templates
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------
-- Wochen, Tage, Wochen-Schichten: lesen alle Angemeldeten, aendern nur Admin
-- ---------------------------------------------------------------------

create policy weeks_select on public.weeks
  for select to authenticated using (true);

create policy weeks_admin on public.weeks
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy week_days_select on public.week_days
  for select to authenticated using (true);

create policy week_days_admin on public.week_days
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy week_shifts_select on public.week_shifts
  for select to authenticated using (true);

create policy week_shifts_admin on public.week_shifts
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------
-- submissions (Kopfdaten der Abgabe)
-- ---------------------------------------------------------------------

create policy submissions_select_eigene on public.submissions
  for select to authenticated
  using (personalnummer = public.current_personalnummer());

create policy submissions_insert_eigene on public.submissions
  for insert to authenticated
  with check (
    personalnummer = public.current_personalnummer()
    and public.woche_bearbeitbar(kw_start_datum)
  );

create policy submissions_update_eigene on public.submissions
  for update to authenticated
  using (
    personalnummer = public.current_personalnummer()
    and public.woche_bearbeitbar(kw_start_datum)
  )
  with check (
    personalnummer = public.current_personalnummer()
    and public.woche_bearbeitbar(kw_start_datum)
  );

create policy submissions_delete_eigene on public.submissions
  for delete to authenticated
  using (
    personalnummer = public.current_personalnummer()
    and public.woche_bearbeitbar(kw_start_datum)
  );

-- Admin liest alle Abgaben (Abgabestatus, Export), aendert sie aber nicht.
create policy submissions_admin_select on public.submissions
  for select to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------
-- availability (einzelne Verfuegbarkeiten)
-- ---------------------------------------------------------------------

create policy availability_select_eigene on public.availability
  for select to authenticated
  using (personalnummer = public.current_personalnummer());

create policy availability_insert_eigene on public.availability
  for insert to authenticated
  with check (
    personalnummer = public.current_personalnummer()
    and public.woche_bearbeitbar(public.montag_von(datum))
    -- die Schicht muss es an diesem Tag wirklich geben und aktiv sein
    and exists (
      select 1 from public.week_shifts ws
      where ws.datum = availability.datum
        and ws.schicht_id = availability.schicht_id
        and ws.aktiv = true
    )
    -- der Tag darf nicht gesperrt sein (z. B. Feiertag)
    and exists (
      select 1 from public.week_days wd
      where wd.datum = availability.datum
        and wd.gesperrt = false
    )
  );

create policy availability_delete_eigene on public.availability
  for delete to authenticated
  using (
    personalnummer = public.current_personalnummer()
    and public.woche_bearbeitbar(kw_start_datum)
  );

-- Admin liest alle Verfuegbarkeiten (fuer den Export), aendert sie aber nicht.
create policy availability_admin_select on public.availability
  for select to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------
-- RPC: Woche anlegen und Schichtzeiten einfrieren
--
-- Wird vom Frontend beim Laden aufgerufen. Legt die Woche, ihre 5 Tage und
-- die Schichten dieser Woche an, falls noch nicht vorhanden. Bestehende
-- Zeiten werden NICHT ueberschrieben (Einfrieren).
-- ---------------------------------------------------------------------

create or replace function public.get_or_create_week(p_kw_start date default null)
returns date
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_kw  date;
  v_tag date;
  v_wt  int;
begin
  v_kw := public.montag_von(coalesce(p_kw_start, public.aktive_woche()));

  -- Mitarbeitende duerfen nur die aktuell bearbeitbare Woche anlegen.
  if not public.is_admin() and v_kw <> public.aktive_woche() then
    raise exception 'Nur die aktuelle Bearbeitungswoche kann angelegt werden.';
  end if;

  insert into public.weeks (kw_start_datum, abgabefrist)
  values (v_kw, public.standard_frist(v_kw))
  on conflict (kw_start_datum) do nothing;

  for v_wt in 1..5 loop
    v_tag := v_kw + (v_wt - 1);

    insert into public.week_days (datum, kw_start_datum, wochentag)
    values (v_tag, v_kw, v_wt)
    on conflict (datum) do nothing;

    insert into public.week_shifts
      (datum, schicht_id, kw_start_datum, wochentag,
       name, symbol, sortierung, beginn, ende, aktiv)
    select v_tag, st.schicht_id, v_kw, v_wt,
           ty.name, ty.symbol, ty.sortierung, st.beginn, st.ende,
           (st.aktiv and ty.aktiv)
    from public.shift_templates st
    join public.shift_types ty on ty.schicht_id = st.schicht_id
    where st.wochentag = v_wt
    on conflict (datum, schicht_id) do nothing;
  end loop;

  return v_kw;
end;
$fn$;

-- ---------------------------------------------------------------------
-- RPC: Abgabe eines Mitarbeiters speichern (alles oder nichts)
--
-- Bewusst OHNE security definer: die Funktion laeuft mit den Rechten des
-- Aufrufers, es greifen also dieselben RLS-Policies wie oben. Ein Mitarbeiter
-- kann damit nur seine eigene Abgabe und nur vor der Frist speichern.
-- Weil alles in einer Transaktion laeuft, kann kein halb gespeicherter
-- Zustand entstehen.
--
-- p_eintraege: [{"datum": "2026-10-05", "schicht_id": "FRUEH"}, ...]
-- ---------------------------------------------------------------------

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
  values (
    v_pn,
    p_kw_start,
    p_max_schichten,
    nullif(btrim(coalesce(p_hinweis, '')), '')
  )
  on conflict (personalnummer, kw_start_datum) do update
    set max_schichten = excluded.max_schichten,
        hinweis       = excluded.hinweis;

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

-- ---------------------------------------------------------------------
-- RPC (nur Admin): Schichtzeiten einer Woche aus den Standardzeiten
-- neu laden. Vorhandene Verfuegbarkeiten bleiben erhalten.
-- ---------------------------------------------------------------------

create or replace function public.woche_aus_standard_neu_laden(p_kw_start date)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_kw      date;
  v_anzahl  int;
begin
  if not public.is_admin() then
    raise exception 'Nur Administratoren duerfen das.';
  end if;

  v_kw := public.montag_von(p_kw_start);
  perform public.get_or_create_week(v_kw);

  update public.week_shifts ws
     set beginn     = st.beginn,
         ende       = st.ende,
         name       = ty.name,
         symbol     = ty.symbol,
         sortierung = ty.sortierung,
         aktiv      = (st.aktiv and ty.aktiv)
    from public.shift_templates st
    join public.shift_types ty on ty.schicht_id = st.schicht_id
   where ws.kw_start_datum = v_kw
     and ws.schicht_id = st.schicht_id
     and ws.wochentag  = st.wochentag;

  get diagnostics v_anzahl = row_count;
  return v_anzahl;
end;
$fn$;

-- ---------------------------------------------------------------------
-- RPC (nur Admin): Einzelnen Tag sperren oder wieder freigeben.
-- Beim Sperren werden bereits eingetragene Verfuegbarkeiten dieses Tages
-- geloescht, damit der Export sauber bleibt.
-- ---------------------------------------------------------------------

create or replace function public.tag_sperren(
  p_datum    date,
  p_gesperrt boolean,
  p_grund    text default null
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_geloescht int := 0;
begin
  if not public.is_admin() then
    raise exception 'Nur Administratoren duerfen das.';
  end if;

  update public.week_days
     set gesperrt = p_gesperrt,
         grund    = case when p_gesperrt then p_grund else null end
   where datum = p_datum;

  if p_gesperrt then
    delete from public.availability where datum = p_datum;
    get diagnostics v_geloescht = row_count;
  end if;

  return v_geloescht;
end;
$fn$;

-- ---------------------------------------------------------------------
-- RPC: Keep-alive fuer den Supabase-Free-Tarif.
-- Fuehrt eine echte, sehr kleine Datenbankabfrage aus.
-- Darf mit dem oeffentlichen anon-Key aufgerufen werden und gibt
-- keinerlei Personendaten zurueck.
-- ---------------------------------------------------------------------

create or replace function public.ping()
returns json
language sql
security definer
set search_path = public, pg_temp
as $fn$
  select json_build_object(
    'ok', true,
    'zeit', now(),
    'wochen', (select count(*) from public.weeks)
  );
$fn$;

-- ---------------------------------------------------------------------
-- Ausfuehrungsrechte
-- ---------------------------------------------------------------------

revoke all on function public.get_or_create_week(date)            from public, anon;
revoke all on function public.abgabe_speichern(date, int, text, jsonb) from public, anon;
revoke all on function public.woche_aus_standard_neu_laden(date)  from public, anon;
revoke all on function public.tag_sperren(date, boolean, text)    from public, anon;

grant execute on function public.get_or_create_week(date)           to authenticated;
grant execute on function public.abgabe_speichern(date, int, text, jsonb) to authenticated;
grant execute on function public.woche_aus_standard_neu_laden(date) to authenticated;
grant execute on function public.tag_sperren(date, boolean, text)   to authenticated;
grant execute on function public.is_admin()                         to authenticated;
grant execute on function public.current_personalnummer()           to authenticated;
grant execute on function public.woche_bearbeitbar(date)            to authenticated;
grant execute on function public.aktive_woche()                     to authenticated;
grant execute on function public.montag_von(date)                   to authenticated;

-- ping darf auch ohne Login aufgerufen werden (GitHub-Action Keep-alive)
grant execute on function public.ping() to anon, authenticated;
