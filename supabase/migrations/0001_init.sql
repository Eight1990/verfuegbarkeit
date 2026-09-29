-- =====================================================================
-- ZiG Verfuegbarkeits-App / FedEx-Schichten
-- Migration 1 von 3: Tabellen, Hilfsfunktionen, Trigger
-- Im Supabase-Dashboard unter "SQL Editor" einfuegen und ausfuehren.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Hilfsfunktionen (Datum / Woche)
-- ---------------------------------------------------------------------

-- Montag der ISO-Woche, in der p_datum liegt
create or replace function public.montag_von(p_datum date)
returns date
language sql
immutable
as $fn$
  select p_datum - ((extract(isodow from p_datum)::int) - 1);
$fn$;

-- Dauer einer Schicht in Stunden (z. B. 3.00 oder 6.50)
create or replace function public.dauer_stunden(p_beginn time, p_ende time)
returns numeric
language sql
immutable
as $fn$
  select round(
    (
      extract(epoch from (p_ende - p_beginn))
      + case when p_ende < p_beginn then 86400 else 0 end
    ) / 3600.0
  , 2);
$fn$;

-- Heutiges Datum in deutscher Zeitzone
create or replace function public.heute_berlin()
returns date
language sql
stable
as $fn$
  select (now() at time zone 'Europe/Berlin')::date;
$fn$;

-- Die Woche, die aktuell bearbeitet werden darf = FOLGEWOCHE (Montag)
create or replace function public.aktive_woche()
returns date
language sql
stable
as $fn$
  select public.montag_von(public.heute_berlin()) + 7;
$fn$;

-- Standard-Abgabefrist: Freitag 12:00 Uhr (Europe/Berlin) vor der Woche
create or replace function public.standard_frist(p_kw_start date)
returns timestamptz
language sql
stable
as $fn$
  select (((p_kw_start - 3)::text || ' 12:00:00')::timestamp) at time zone 'Europe/Berlin';
$fn$;

-- ---------------------------------------------------------------------
-- Tabellen
-- ---------------------------------------------------------------------

-- Mitarbeitende. KEINE Klarnamen - einzige Kennung ist die Personalnummer.
create table public.employees (
  personalnummer   text primary key,
  user_id          uuid unique references auth.users(id) on delete set null,
  aktiv            boolean not null default true,
  -- Fingerabdruck des zuletzt gesetzten Passworts (KEIN Passwort, nicht umkehrbar).
  -- Dient nur dazu, beim Stammlisten-Import "geaendert" von "unveraendert" zu
  -- unterscheiden. Auf diese Spalte hat per RLS niemand Zugriff, nur die
  -- Edge Function mit Service-Role.
  passwort_fp      text,
  erstellt_am      timestamptz not null default now(),
  aktualisiert_am  timestamptz not null default now()
);

comment on table public.employees is
  'Mitarbeitende, identifiziert ausschliesslich ueber die Personalnummer. Keine Klarnamen.';

-- Administratoren (Planer + Vertretung)
create table public.admins (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  notiz        text,
  erstellt_am  timestamptz not null default now()
);

-- Schichtarten (FRUEH / SPAET / LANG)
create table public.shift_types (
  schicht_id   text primary key,
  name         text not null,
  symbol       text not null default '',
  sortierung   int  not null default 0,
  aktiv        boolean not null default true
);

-- Standardzeiten je Schichtart und Wochentag (1 = Montag ... 5 = Freitag)
create table public.shift_templates (
  schicht_id   text not null references public.shift_types(schicht_id) on delete cascade,
  wochentag    int  not null check (wochentag between 1 and 5),
  beginn       time not null,
  ende         time not null,
  aktiv        boolean not null default true,
  primary key (schicht_id, wochentag)
);

-- Kalenderwochen (Montag als Schluessel) mit Abgabefrist
create table public.weeks (
  kw_start_datum  date primary key,
  abgabefrist     timestamptz not null,
  erstellt_am     timestamptz not null default now()
);

-- Die 5 Tage einer Woche. Einzelne Tage koennen gesperrt werden (z. B. Feiertag).
create table public.week_days (
  datum           date primary key,
  kw_start_datum  date not null references public.weeks(kw_start_datum) on delete cascade,
  wochentag       int  not null check (wochentag between 1 and 5),
  gesperrt        boolean not null default false,
  grund           text
);

-- Schichten EINER konkreten Woche. Beim Anlegen der Woche werden die
-- Standardzeiten hierher kopiert ("eingefroren"), damit spaetere Aenderungen
-- alte Wochen und alte Exporte nicht rueckwirkend veraendern.
create table public.week_shifts (
  datum           date not null references public.week_days(datum) on delete cascade,
  schicht_id      text not null references public.shift_types(schicht_id) on delete cascade,
  kw_start_datum  date not null references public.weeks(kw_start_datum) on delete cascade,
  wochentag       int  not null,
  name            text not null,
  symbol          text not null default '',
  sortierung      int  not null default 0,
  beginn          time not null,
  ende            time not null,
  dauer_h         numeric(5,2) not null default 0,
  aktiv           boolean not null default true,
  primary key (datum, schicht_id)
);

-- Abgabe eines Mitarbeiters fuer eine Woche (Kopfdaten)
create table public.submissions (
  personalnummer  text not null references public.employees(personalnummer) on delete cascade,
  kw_start_datum  date not null references public.weeks(kw_start_datum) on delete cascade,
  max_schichten   int check (max_schichten between 1 and 10),
  hinweis         text check (char_length(hinweis) <= 200),
  abgegeben_am    timestamptz not null default now(),
  primary key (personalnummer, kw_start_datum)
);

-- Einzelne Verfuegbarkeiten (eine Zeile je moeglicher Schicht)
create table public.availability (
  personalnummer  text not null references public.employees(personalnummer) on delete cascade,
  datum           date not null,
  schicht_id      text not null,
  kw_start_datum  date not null,
  erstellt_am     timestamptz not null default now(),
  primary key (personalnummer, datum, schicht_id),
  foreign key (datum, schicht_id)
    references public.week_shifts(datum, schicht_id) on delete cascade
);

create index availability_woche_idx on public.availability (kw_start_datum);
create index submissions_woche_idx  on public.submissions  (kw_start_datum);
create index week_shifts_woche_idx  on public.week_shifts  (kw_start_datum);
create index employees_aktiv_idx    on public.employees    (aktiv);

-- ---------------------------------------------------------------------
-- Trigger
-- ---------------------------------------------------------------------

create or replace function public.tg_set_aktualisiert_am()
returns trigger language plpgsql as $fn$
begin
  new.aktualisiert_am := now();
  return new;
end;
$fn$;

create trigger employees_aktualisiert
  before update on public.employees
  for each row execute function public.tg_set_aktualisiert_am();

-- Dauer immer automatisch aus Beginn/Ende berechnen
create or replace function public.tg_week_shift_dauer()
returns trigger language plpgsql as $fn$
begin
  new.dauer_h := public.dauer_stunden(new.beginn, new.ende);
  return new;
end;
$fn$;

create trigger week_shifts_dauer
  before insert or update on public.week_shifts
  for each row execute function public.tg_week_shift_dauer();

-- Wochenschluessel bei Verfuegbarkeiten automatisch setzen
create or replace function public.tg_availability_woche()
returns trigger language plpgsql as $fn$
begin
  new.kw_start_datum := public.montag_von(new.datum);
  return new;
end;
$fn$;

create trigger availability_woche
  before insert or update on public.availability
  for each row execute function public.tg_availability_woche();

-- Abgabezeitpunkt bei jeder Aenderung neu setzen
create or replace function public.tg_submission_zeit()
returns trigger language plpgsql as $fn$
begin
  new.abgegeben_am := now();
  return new;
end;
$fn$;

create trigger submissions_zeit
  before insert or update on public.submissions
  for each row execute function public.tg_submission_zeit();
