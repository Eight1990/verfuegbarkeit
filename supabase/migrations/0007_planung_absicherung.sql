-- =====================================================================
-- 0007: Planung absichern
--   * planung_ersetzen wird strikt: kein stilles Verwerfen mehr, alles oder nichts
--   * planung_historie: Snapshot der alten Version vor jedem Ersetzen (ohne Namen)
--   * planung_stand: wann wurde die Planung einer Woche zuletzt eingelesen
-- =====================================================================

create table if not exists public.planung_historie (
  id              bigserial primary key,
  kw_start_datum  date        not null,
  erstellt_am     timestamptz not null default now(),
  daten           jsonb       not null
);

create table if not exists public.planung_stand (
  kw_start_datum  date primary key,
  aktualisiert_am timestamptz not null default now(),
  anzahl          integer     not null
);

alter table public.planung_historie enable row level security;
alter table public.planung_stand    enable row level security;

revoke all on public.planung_historie from anon, authenticated;
revoke all on public.planung_stand    from anon, authenticated;
grant select on public.planung_historie to authenticated;
grant select on public.planung_stand    to authenticated;

-- Historie: nur Admins. Stand: alle Angemeldeten (enthaelt keine personenbezogenen Daten).
create policy planung_historie_admin_select on public.planung_historie
  for select to authenticated using (public.is_admin());

create policy planung_stand_select on public.planung_stand
  for select to authenticated using (true);

-- ---------------------------------------------------------------------
-- planung_ersetzen (strikt). Rueckgabe: {"erwartet":n,"eingefuegt":n}
-- ---------------------------------------------------------------------
drop function if exists public.planung_ersetzen(date, jsonb);

create function public.planung_ersetzen(kw date, eintraege jsonb)
returns json
language plpgsql
security definer
set search_path = public
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

  -- Unbekannte oder inaktive Personalnummern: ablehnen statt still verwerfen
  select string_agg(distinct coalesce(e.personalnummer, '(leer)'), ', ') into v_unbekannt
    from jsonb_to_recordset(eintraege) as e(personalnummer text)
    left join public.employees m
           on m.personalnummer = e.personalnummer and m.aktiv
   where m.personalnummer is null;
  if v_unbekannt is not null then
    raise exception 'Unbekannte oder inaktive Personalnummer: %', v_unbekannt;
  end if;

  -- Ungueltige Datums-, Zeit- oder Schichtangaben
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

  -- Alte Version sichern
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
-- Loeschfrist (siehe 0004/0006) um Historie und Stand erweitern
-- ---------------------------------------------------------------------
create or replace function public.loeschfrist_anwenden(p_monate int default 12)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_grenze  date := (current_date - make_interval(months => p_monate))::date;
  v_wochen  int;
  v_ma      int;
  v_users   uuid[];
begin
  delete from public.planung          where kw_start_datum + 7 < v_grenze;
  delete from public.planung_historie where kw_start_datum + 7 < v_grenze;
  delete from public.planung_stand    where kw_start_datum + 7 < v_grenze;

  delete from public.weeks where kw_start_datum + 7 < v_grenze;
  get diagnostics v_wochen = row_count;

  with weg as (
    delete from public.employees
     where aktiv = false
       and aktualisiert_am < (now() - make_interval(months => p_monate))
    returning user_id
  )
  select coalesce(array_agg(user_id) filter (where user_id is not null), '{}'), count(*)
    into v_users, v_ma
    from weg;

  delete from auth.users where id = any(v_users);

  return json_build_object('wochen_geloescht', v_wochen, 'zugaenge_geloescht', v_ma);
end;
$fn$;

revoke all on function public.loeschfrist_anwenden(int) from public, anon, authenticated;
