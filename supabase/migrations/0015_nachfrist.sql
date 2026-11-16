-- =====================================================================
-- 0015: Nachfrist fuer eine einzelne Person
--
-- Wofuer: Jemand ruft nach der Abgabefrist an ("vergessen" oder "falsch
-- geklickt"). Der Admin drueckt im Admin-Bereich auf die Person; danach
-- darf NUR diese Person 10 Minuten lang ihre Abgabe fuer die aktive
-- Woche noch einmal speichern. Danach ist automatisch wieder zu (reiner
-- Zeitvergleich mit now(), nichts muss zurueckgesetzt werden).
-- Die Wochenfrist (weeks.abgabefrist) bleibt unveraendert.
--
-- Ausfuehren: Supabase-Dashboard -> SQL Editor -> einfuegen -> Run.
-- Kann gefahrlos mehrfach ausgefuehrt werden.
-- Reihenfolge beim Veroeffentlichen: ERST diese Migration, DANN die App
-- (index.html). Die alte App laeuft mit der Migration unveraendert weiter.
-- =====================================================================

create table if not exists public.nachfrist (
  personalnummer  text not null references public.employees(personalnummer) on delete cascade,
  kw_start_datum  date not null references public.weeks(kw_start_datum) on delete cascade,
  bis             timestamptz not null,
  geoeffnet_am    timestamptz not null default now(),
  primary key (personalnummer, kw_start_datum)
);

alter table public.nachfrist enable row level security;
revoke all on public.nachfrist from anon, authenticated;
grant select on public.nachfrist to authenticated;

-- Lesen: Admin alles, Mitarbeitende nur die eigene Zeile.
-- Schreiben: niemand direkt, nur ueber nachfrist_oeffnen().
drop policy if exists nachfrist_admin_select on public.nachfrist;
create policy nachfrist_admin_select on public.nachfrist
  for select to authenticated
  using (public.is_admin());

drop policy if exists nachfrist_select_eigene on public.nachfrist;
create policy nachfrist_select_eigene on public.nachfrist
  for select to authenticated
  using (personalnummer = public.current_personalnummer()
         and not public.muss_passwort_aendern());

-- ---------------------------------------------------------------------
-- Woche bearbeitbar? Stand 0005 plus: ODER eine laufende Nachfrist der
-- angemeldeten Person fuer genau diese Woche.
-- ---------------------------------------------------------------------
create or replace function public.woche_bearbeitbar(p_kw_start date)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select p_kw_start = public.aktive_woche()
     and not public.muss_passwort_aendern()
     and (
       exists (
         select 1 from public.weeks w
         where w.kw_start_datum = p_kw_start
           and now() < w.abgabefrist
       )
       or exists (
         select 1 from public.nachfrist n
         where n.kw_start_datum = p_kw_start
           and n.personalnummer = public.current_personalnummer()
           and now() < n.bis
       )
     );
$fn$;

revoke all on function public.woche_bearbeitbar(date) from public, anon;
grant execute on function public.woche_bearbeitbar(date) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- RPC fuer den Admin: Abgabe fuer eine Person kurz oeffnen.
-- Gilt immer fuer die aktive Woche (die Woche, die Mitarbeitende gerade
-- bearbeiten). Erneutes Druecken verlaengert auf jetzt + p_minuten.
-- p_minuten = 0 schliesst die Nachfrist sofort.
-- ---------------------------------------------------------------------
create or replace function public.nachfrist_oeffnen(
  p_personalnummer text,
  p_minuten        int default 10
)
returns json
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_kw  date := public.aktive_woche();
  v_bis timestamptz;
begin
  if not public.is_admin() then
    raise exception 'Nur fuer Admins.';
  end if;
  if p_minuten is null or p_minuten < 0 or p_minuten > 60 then
    raise exception 'Minuten muessen zwischen 0 und 60 liegen.';
  end if;
  if not exists (select 1 from public.employees e
                  where e.personalnummer = p_personalnummer and e.aktiv) then
    raise exception 'Personalnummer ist nicht aktiv.';
  end if;
  if not exists (select 1 from public.weeks w where w.kw_start_datum = v_kw) then
    raise exception 'Die Woche % ist noch nicht angelegt.', v_kw;
  end if;

  v_bis := now() + make_interval(mins => p_minuten);

  insert into public.nachfrist (personalnummer, kw_start_datum, bis, geoeffnet_am)
  values (p_personalnummer, v_kw, v_bis, now())
  on conflict (personalnummer, kw_start_datum) do update
    set bis = excluded.bis,
        geoeffnet_am = excluded.geoeffnet_am;

  return json_build_object('kw_start_datum', v_kw, 'bis', v_bis);
end;
$fn$;

revoke all on function public.nachfrist_oeffnen(text, int) from public, anon;
grant execute on function public.nachfrist_oeffnen(text, int) to authenticated;

-- ---------------------------------------------------------------------
-- Kontrolle (nur lesend): anon = false, angemeldet = true
-- ---------------------------------------------------------------------
select p.proname as funktion,
       has_function_privilege('anon', p.oid, 'execute')          as anon,
       has_function_privilege('authenticated', p.oid, 'execute') as angemeldet
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('woche_bearbeitbar', 'nachfrist_oeffnen')
 order by 1;
