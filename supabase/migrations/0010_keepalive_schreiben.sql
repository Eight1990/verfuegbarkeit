-- =====================================================================
-- 0010: Keep-alive schreibt jetzt wirklich in die Datenbank
--
-- Hintergrund: Am 20.10.2026 hat Supabase das Projekt trotz
-- erfolgreicher ping()-Aufrufe alle 3 Tage pausiert ("not sufficient
-- activity"). Eine reine Leseabfrage alle 3 Tage reicht offenbar nicht.
--
-- Neu: ping() schreibt bei jedem Aufruf einen Zeitstempel in die
-- Mini-Tabelle keepalive (genau eine Zeile). Das ist echte
-- Schreibaktivitaet. Personendaten werden weder gelesen noch
-- zurueckgegeben.
--
-- Ausfuehren: Supabase-Dashboard -> SQL Editor -> diesen Inhalt
-- einfuegen -> Run. Kann gefahrlos mehrfach ausgefuehrt werden.
-- =====================================================================

create table if not exists public.keepalive (
  id        int primary key default 1 check (id = 1),
  zuletzt   timestamptz not null default now(),
  anzahl    bigint      not null default 0
);

-- Niemand darf direkt auf die Tabelle zugreifen; nur ping() (security
-- definer) schreibt hinein.
alter table public.keepalive enable row level security;
revoke all on table public.keepalive from public, anon, authenticated;

-- Rueckgabetyp bleibt json, daher reicht create or replace.
create or replace function public.ping()
returns json
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_anzahl bigint;
begin
  insert into public.keepalive as k (id, zuletzt, anzahl)
  values (1, now(), 1)
  on conflict (id) do update
    set zuletzt = now(),
        anzahl  = k.anzahl + 1
  returning k.anzahl into v_anzahl;

  return json_build_object(
    'ok', true,
    'zeit', now(),
    'wochen', (select count(*) from public.weeks),
    'pings', v_anzahl
  );
end;
$fn$;

revoke all on function public.ping() from public;
grant execute on function public.ping() to anon, authenticated;
