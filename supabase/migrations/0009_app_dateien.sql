-- =====================================================================
-- 0009: Private Ablage fuer die Dispo-Vorlage (nur Admin)
--
--   Die Dispo-Vorlage (.xlsm, ohne Mitarbeiternamen) wird einmal im
--   Admin-Bereich hochgeladen und danach bei jedem Export wiederverwendet.
--   Sie liegt hier und nicht im Repository.
--
--   Datenschutz (Stand 0009): Mitarbeiterprofile wurden nicht in der Datenbank
--   gespeichert. Seit 0013 liegen sie verschluesselt als Tresor in dieser Tabelle
--   (Schluessel 'stammliste_tresor'); der Server sieht nur Chiffrat. Details in 0013.
--   Nur Admins koennen die Vorlage lesen oder schreiben (RLS).
--   Kann gefahrlos mehrfach ausgefuehrt werden.
-- =====================================================================

create table if not exists public.app_dateien (
  schluessel      text primary key,
  dateiname       text,
  inhalt_base64   text not null,
  aktualisiert_am timestamptz not null default now()
);

alter table public.app_dateien enable row level security;

revoke all on public.app_dateien from public, anon, authenticated;
grant select, insert, update, delete on public.app_dateien to authenticated;

drop policy if exists app_dateien_admin_select on public.app_dateien;
create policy app_dateien_admin_select on public.app_dateien
  for select to authenticated using (public.is_admin());

drop policy if exists app_dateien_admin_insert on public.app_dateien;
create policy app_dateien_admin_insert on public.app_dateien
  for insert to authenticated with check (public.is_admin());

drop policy if exists app_dateien_admin_update on public.app_dateien;
create policy app_dateien_admin_update on public.app_dateien
  for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists app_dateien_admin_delete on public.app_dateien;
create policy app_dateien_admin_delete on public.app_dateien
  for delete to authenticated using (public.is_admin());
