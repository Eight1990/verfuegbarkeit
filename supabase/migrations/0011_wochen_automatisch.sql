-- =====================================================================
-- 0011: Wochen automatisch 4 Wochen im Voraus anlegen
--
-- Bisher wurde die Bearbeitungswoche erst beim ersten Mitarbeiter-Login
-- angelegt; im Admin-Bereich war sie vorher nicht sichtbar, weiter
-- entfernte Wochen gab es nur ueber den Knopf "Woche anlegen".
--
-- Neu:
--   - woche_anlegen_intern(): die eigentliche Anlage-Logik (intern,
--     von aussen nicht aufrufbar)
--   - get_or_create_week(): unveraendertes Verhalten, nutzt die interne
--     Funktion
--   - wochen_vorausanlegen(): legt Bearbeitungswoche + 3 Folgewochen aus
--     den Standardzeiten an (bestehende Wochen bleiben unveraendert)
--   - taeglicher Cron-Job um 00:05 UTC
--
-- Ausfuehren: Supabase-Dashboard -> SQL Editor -> einfuegen -> Run.
-- Kann gefahrlos mehrfach ausgefuehrt werden.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Interne Anlage-Logik (ohne Rechtepruefung)
-- ---------------------------------------------------------------------
create or replace function public.woche_anlegen_intern(p_kw date)
returns date
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_kw  date := public.montag_von(p_kw);
  v_tag date;
  v_wt  int;
begin
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

revoke all on function public.woche_anlegen_intern(date) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- get_or_create_week: gleiches Verhalten wie in 0002
-- ---------------------------------------------------------------------
create or replace function public.get_or_create_week(p_kw_start date default null)
returns date
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_kw date;
begin
  v_kw := public.montag_von(coalesce(p_kw_start, public.aktive_woche()));

  -- Mitarbeitende duerfen nur die aktuell bearbeitbare Woche anlegen.
  if not public.is_admin() and v_kw <> public.aktive_woche() then
    raise exception 'Nur die aktuelle Bearbeitungswoche kann angelegt werden.';
  end if;

  return public.woche_anlegen_intern(v_kw);
end;
$fn$;

revoke all on function public.get_or_create_week(date) from public, anon;
grant execute on function public.get_or_create_week(date) to authenticated;

-- ---------------------------------------------------------------------
-- Bearbeitungswoche + 3 Folgewochen anlegen
-- Ohne Parameter, damit niemand beliebig weit vorausanlegen kann.
-- ---------------------------------------------------------------------
create or replace function public.wochen_vorausanlegen()
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_start date := public.aktive_woche();
  i int;
begin
  for i in 0..3 loop
    perform public.woche_anlegen_intern(v_start + 7 * i);
  end loop;
  return 4;
end;
$fn$;

revoke all on function public.wochen_vorausanlegen() from public, anon;
grant execute on function public.wochen_vorausanlegen() to authenticated;

-- ---------------------------------------------------------------------
-- Taeglicher Cron-Job (pg_cron), 00:05 UTC
-- ---------------------------------------------------------------------
create extension if not exists pg_cron;

do $do$
begin
  if exists (select 1 from cron.job where jobname = 'wochen-vorausanlegen') then
    perform cron.unschedule('wochen-vorausanlegen');
  end if;
end;
$do$;

select cron.schedule(
  'wochen-vorausanlegen',
  '5 0 * * *',
  $cron$select public.wochen_vorausanlegen()$cron$
);

-- Sofort einmal ausfuehren
select public.wochen_vorausanlegen();

-- Kontrolle: die naechsten Wochen
select kw_start_datum, abgabefrist
from public.weeks
where kw_start_datum >= public.aktive_woche()
order by kw_start_datum;
