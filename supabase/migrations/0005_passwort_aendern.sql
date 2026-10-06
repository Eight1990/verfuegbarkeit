-- =====================================================================
-- ZiG Verfuegbarkeits-App / FedEx-Schichten
-- Migration 5: Eigenes Passwort nach dem Startpasswort
-- Im Supabase-Dashboard unter "SQL Editor" einfuegen und ausfuehren.
--
-- Nach dem Login mit dem Startpasswort muss jeder Mitarbeiter ein eigenes
-- Passwort setzen. Das Flag liegt in der Datenbank und wird nur von den
-- Edge Functions (Service-Role) veraendert. Solange es gesetzt ist, sind
-- schreibende Zugriffe auf die Abgabe gesperrt - auch wenn jemand die
-- Passwort-Maske im Browser umgeht.
-- =====================================================================

-- Bestehende Konten bekommen ebenfalls true: alle setzen einmal ein
-- eigenes Passwort.
alter table public.employees
  add column if not exists muss_pw_aendern boolean not null default true;

-- Die Spalte steht bewusst NICHT in der Lese-Freigabe fuer Angemeldete
-- (siehe 0002). Gelesen wird sie nur ueber die Funktion unten.

-- Ist beim angemeldeten Mitarbeiter noch ein Passwortwechsel offen?
-- Admins stehen nicht in employees und bekommen immer false.
create or replace function public.muss_passwort_aendern()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce(
    (select e.muss_pw_aendern
       from public.employees e
      where e.user_id = auth.uid()),
    false
  );
$fn$;

-- Schreibzugriffe auf die Abgabe nur, wenn kein Passwortwechsel offen ist.
-- woche_bearbeitbar steckt in allen schreibenden Policies und wird von
-- abgabe_speichern geprueft.
create or replace function public.woche_bearbeitbar(p_kw_start date)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select p_kw_start = public.aktive_woche()
     and not public.muss_passwort_aendern()
     and exists (
       select 1 from public.weeks w
       where w.kw_start_datum = p_kw_start
         and now() < w.abgabefrist
     );
$fn$;

revoke all on function public.muss_passwort_aendern() from public, anon;
grant execute on function public.muss_passwort_aendern() to authenticated;
