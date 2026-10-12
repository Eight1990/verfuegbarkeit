-- =====================================================================
-- 0008: app_einstellungen
--   Schluessel/Wert-Tabelle fuer Angaben, die in der App erscheinen, aber
--   nicht im oeffentlichen Repository stehen sollen (z. B. Kontakt-Handynummer).
--   Die Werte werden direkt in Supabase gepflegt (SQL-Editor / Table Editor),
--   nie in dieser Datei. Lesen duerfen alle Angemeldeten, schreiben niemand
--   ueber die App.
--   Bekannter Schluessel: kontakt_handy
-- =====================================================================

create table if not exists public.app_einstellungen (
  schluessel text primary key,
  wert       text not null
);

alter table public.app_einstellungen enable row level security;

revoke all on public.app_einstellungen from anon, authenticated;
grant select on public.app_einstellungen to authenticated;

create policy app_einstellungen_select on public.app_einstellungen
  for select to authenticated using (true);
