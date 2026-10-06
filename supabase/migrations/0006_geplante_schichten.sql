-- =====================================================================
-- 0006: Geplante Schichten (fertige Dispo, pro Mitarbeiter sichtbar)
--
-- Die Dispo wird im Admin-Bereich im Browser gelesen. Der Abgleich
-- Name -> Personalnummer passiert ausschliesslich dort. Hierher gelangen
-- nur Personalnummer, Datum, Schichtart und Zeiten - keine Klarnamen.
--
-- Schreiben geht nur ueber planung_ersetzen() (nur Admin). Mitarbeitende
-- duerfen ausschliesslich ihre eigenen Zeilen lesen.
-- =====================================================================

create table if not exists public.planung (
  personalnummer  text  not null references public.employees(personalnummer) on delete cascade,
  datum           date  not null,
  schicht_id      text  not null check (schicht_id in ('FRUEH','SPAET','LANG','BUERO')),
  beginn          time  not null,
  ende            time  not null,
  kw_start_datum  date  not null,
  primary key (personalnummer, datum, beginn)
);

create index if not exists planung_kw_idx on public.planung (kw_start_datum);

alter table public.planung enable row level security;

revoke all on public.planung from anon, authenticated;
grant select on public.planung to authenticated;

create policy planung_select_eigene on public.planung
  for select to authenticated
  using (personalnummer = public.current_personalnummer());

create policy planung_admin_select on public.planung
  for select to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------
-- planung_ersetzen: ersetzt die komplette Planung einer Woche
-- eintraege: [{"personalnummer":"...","datum":"2026-07-20",
--              "schicht_id":"FRUEH","beginn":"04:00","ende":"07:00"}, ...]
-- ---------------------------------------------------------------------
create or replace function public.planung_ersetzen(kw date, eintraege jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  anzahl integer;
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

  delete from public.planung where kw_start_datum = kw;

  insert into public.planung (personalnummer, datum, schicht_id, beginn, ende, kw_start_datum)
  select distinct e.personalnummer, e.datum, e.schicht_id, e.beginn, e.ende, kw
    from jsonb_to_recordset(eintraege) as e(
           personalnummer text, datum date, schicht_id text, beginn time, ende time)
    join public.employees m on m.personalnummer = e.personalnummer
   where e.datum between kw and kw + 4;

  get diagnostics anzahl = row_count;
  return anzahl;
end;
$fn$;

revoke all on function public.planung_ersetzen(date, jsonb) from public, anon;
grant execute on function public.planung_ersetzen(date, jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- Loeschfrist (siehe 0004) um die Planung erweitern: 12 Monate nach
-- Ende der Woche. Die Tabelle hat keinen Fremdschluessel auf weeks.
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
  delete from public.planung where kw_start_datum + 7 < v_grenze;

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
