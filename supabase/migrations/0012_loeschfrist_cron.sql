-- =====================================================================
-- 0012: Loeschfrist automatisch anwenden (monatlicher Cron-Job)
--
-- Die Datenschutzerklaerung in index.html verspricht: Verfuegbarkeiten,
-- Abgaben und geplante Schichten werden 12 Monate nach Ende der
-- Kalenderwoche geloescht, deaktivierte Zugaenge 12 Monate nach der
-- Deaktivierung. Die Funktion loeschfrist_anwenden() gibt es seit
-- Migration 0004 (erweitert in 0006/0007), sie wurde aber nie
-- automatisch aufgerufen.
--
-- Neu:
--   - Tabelle loeschlauf: Protokoll jedes Laufs (Zeitpunkt, Anzahl),
--     ohne Personendaten. So ist nachweisbar, dass geloescht wurde.
--   - loeschfrist_anwenden(): wie bisher, schreibt zusaetzlich ins
--     Protokoll. Das Loeschen der Anmeldekonten ist abgesichert: schlaegt
--     es fehl, bleiben die uebrigen Loeschungen bestehen und der Fehler
--     steht im Protokoll.
--   - Cron-Job "loeschfrist": am 1. jedes Monats um 03:00 UTC.
--   - Ein sofortiger erster Lauf (es gibt noch nichts Altes, der Lauf
--     erzeugt nur die erste Protokollzeile).
--
-- Ausfuehren: Supabase-Dashboard -> SQL Editor -> einfuegen -> Run.
-- Kann gefahrlos mehrfach ausgefuehrt werden.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Protokoll der Loeschlaeufe (keine Personendaten)
-- ---------------------------------------------------------------------
create table if not exists public.loeschlauf (
  id           bigserial primary key,
  gelaufen_am  timestamptz not null default now(),
  ergebnis     jsonb       not null
);

comment on table public.loeschlauf is
  'Protokoll der automatischen Loeschlaeufe (Zeitpunkt und Anzahl). Keine Personendaten.';

alter table public.loeschlauf enable row level security;
revoke all on table public.loeschlauf from public, anon, authenticated;

-- Admins duerfen das Protokoll lesen (fuer eine spaetere Anzeige in der App).
grant select on public.loeschlauf to authenticated;
drop policy if exists loeschlauf_admin_select on public.loeschlauf;
create policy loeschlauf_admin_select on public.loeschlauf
  for select to authenticated using (public.is_admin());

-- ---------------------------------------------------------------------
-- loeschfrist_anwenden: Stand 0007 plus Protokoll und Absicherung
-- ---------------------------------------------------------------------
create or replace function public.loeschfrist_anwenden(p_monate int default 12)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_grenze   date := (current_date - make_interval(months => p_monate))::date;
  v_wochen   int;
  v_planung  int;
  v_ma       int;
  v_users    uuid[];
  v_konten   int := 0;
  v_fehler   text := null;
  v_ergebnis json;
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

  -- 5. Protokoll selbst nicht ewig aufheben (2 Jahre)
  delete from public.loeschlauf where gelaufen_am < now() - interval '24 months';

  v_ergebnis := json_build_object(
    'grenze',             v_grenze,
    'wochen_geloescht',   v_wochen,
    'planung_geloescht',  v_planung,
    'zugaenge_geloescht', v_ma,
    'konten_geloescht',   v_konten,
    'fehler',             v_fehler
  );

  insert into public.loeschlauf (ergebnis) values (v_ergebnis::jsonb);

  return v_ergebnis;
end;
$fn$;

-- Nur der Datenbank-Eigentuemer (SQL Editor / pg_cron) darf das aufrufen,
-- niemand ueber die App.
revoke all on function public.loeschfrist_anwenden(int) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Monatlicher Cron-Job (pg_cron ist seit 0011 aktiv), 1. des Monats 03:00 UTC
-- ---------------------------------------------------------------------
create extension if not exists pg_cron;

do $do$
begin
  if exists (select 1 from cron.job where jobname = 'loeschfrist') then
    perform cron.unschedule('loeschfrist');
  end if;
end;
$do$;

select cron.schedule(
  'loeschfrist',
  '0 3 1 * *',
  $cron$select public.loeschfrist_anwenden()$cron$
);

-- Sofort einmal ausfuehren (erste Protokollzeile; es gibt noch nichts Altes)
select public.loeschfrist_anwenden();

-- Kontrolle: beide Cron-Jobs und das Protokoll
select jobname, schedule, command from cron.job
 where jobname in ('loeschfrist', 'wochen-vorausanlegen')
 order by jobname;

select gelaufen_am, ergebnis from public.loeschlauf order by gelaufen_am desc limit 3;
