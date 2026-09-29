-- =====================================================================
-- ZiG Verfuegbarkeits-App / FedEx-Schichten
-- Migration 3 von 3: Standard-Schichten und erste Woche
-- Im Supabase-Dashboard unter "SQL Editor" einfuegen und ausfuehren.
--
-- Diese Werte sind nur der Startzustand. Alles laesst sich spaeter im
-- Admin-Bereich der App aendern, ohne SQL.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Schichtarten
-- ---------------------------------------------------------------------

insert into public.shift_types (schicht_id, name, symbol, sortierung, aktiv) values
  ('FRUEH', 'Frühschicht',       'sonne', 1, true),
  ('SPAET', 'Spätschicht',       'mond',  2, true),
  ('LANG',  'Lange Spätschicht', 'mond',  3, true)
on conflict (schicht_id) do nothing;

-- ---------------------------------------------------------------------
-- Standardzeiten (wochentag: 1 = Montag ... 5 = Freitag)
--
-- Frueh:  Montag    04:00-07:00 (3,0 h)
--         Di bis Fr 05:30-08:30 (3,0 h)
-- Spaet:  Mo bis Fr 18:30-22:30 (4,0 h)
-- Lang:   Mo bis Fr 16:00-22:30 (6,5 h)
-- ---------------------------------------------------------------------

insert into public.shift_templates (schicht_id, wochentag, beginn, ende, aktiv) values
  ('FRUEH', 1, '04:00', '07:00', true),
  ('FRUEH', 2, '05:30', '08:30', true),
  ('FRUEH', 3, '05:30', '08:30', true),
  ('FRUEH', 4, '05:30', '08:30', true),
  ('FRUEH', 5, '05:30', '08:30', true),

  ('SPAET', 1, '18:30', '22:30', true),
  ('SPAET', 2, '18:30', '22:30', true),
  ('SPAET', 3, '18:30', '22:30', true),
  ('SPAET', 4, '18:30', '22:30', true),
  ('SPAET', 5, '18:30', '22:30', true),

  ('LANG',  1, '16:00', '22:30', true),
  ('LANG',  2, '16:00', '22:30', true),
  ('LANG',  3, '16:00', '22:30', true),
  ('LANG',  4, '16:00', '22:30', true),
  ('LANG',  5, '16:00', '22:30', true)
on conflict (schicht_id, wochentag) do nothing;

-- ---------------------------------------------------------------------
-- Erste Woche anlegen (die aktuelle Folgewoche).
-- Danach legt die App jede neue Woche automatisch selbst an.
-- ---------------------------------------------------------------------

select public.get_or_create_week();

-- ---------------------------------------------------------------------
-- Kontrolle: so sieht die angelegte Woche aus
-- ---------------------------------------------------------------------

select kw_start_datum, abgabefrist from public.weeks order by kw_start_datum desc limit 1;

select datum, wochentag, schicht_id, beginn, ende, dauer_h, aktiv
from public.week_shifts
order by datum, sortierung;
