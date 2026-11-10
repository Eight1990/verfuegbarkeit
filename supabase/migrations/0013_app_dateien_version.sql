-- =====================================================================
-- 0013: app_dateien bekommt einen Versionszaehler (Stammlisten-Tresor)
--
--   Der Stammlisten-Tresor (Klarnamen und Profile, im Browser mit AES-GCM
--   verschluesselt, Schluessel nur bei den Planern) liegt als Zeile
--   'stammliste_tresor' in app_dateien. Der Server kann die Namen nicht
--   lesen: in der Spalte inhalt_base64 steht nur die Huelle mit Chiffrat.
--
--   Neu: Spalte version (zaehlt bei jedem Update hoch) und ein Trigger, der
--   dabei auch aktualisiert_am setzt. Damit erkennen zwei Admins (z. B.
--   Planer und Vertretung), wenn sie sich gegenseitig ueberschreiben
--   wuerden: Die App schreibt nur, wenn die Version noch die gelesene ist.
--   Ausserdem eine Groessenschranke (8 MB Base64) gegen versehentlich
--   riesige Dateien (not valid: prueft nur neue Schreibvorgaenge). RLS bleibt wie in 0009: nur Admins.
--
--   Kann gefahrlos mehrfach ausgefuehrt werden.
-- =====================================================================

alter table public.app_dateien
  add column if not exists version integer not null default 1;

create or replace function public.app_dateien_vor_update()
returns trigger
language plpgsql
as $fn$
begin
  new.version := old.version + 1;
  new.aktualisiert_am := now();
  return new;
end;
$fn$;

drop trigger if exists app_dateien_version on public.app_dateien;
create trigger app_dateien_version
  before update on public.app_dateien
  for each row execute function public.app_dateien_vor_update();

do $do$
begin
  if not exists (select 1 from pg_constraint where conname = 'app_dateien_groesse') then
    alter table public.app_dateien
      add constraint app_dateien_groesse check (length(inhalt_base64) <= 8388608) not valid;
  end if;
end
$do$;

comment on table public.app_dateien is
  'Private Admin-Dateien (RLS: nur Admins). dispo_vorlage = Dispo-Vorlage ohne Namen. '
  'stammliste_tresor = Klarnamen/Profile ausschliesslich als AES-GCM-Chiffrat; der Schluessel '
  'wird im Browser aus dem Tresor-Passwort der Planer abgeleitet (PBKDF2). Der Server kann die Namen nicht lesen.';

-- PostgREST soll die neue Spalte sofort kennen (harmlos, falls nicht noetig)
notify pgrst, 'reload schema';

-- Kontrolle: zeigt die vorhandenen Dateien mit Version (keine Inhalte)
select schluessel, dateiname, version, aktualisiert_am
from public.app_dateien
order by schluessel;
