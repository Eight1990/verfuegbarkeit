-- =====================================================================
-- ZiG Verfuegbarkeits-App / FedEx-Schichten
-- Migration 4 (optional): Loeschfrist von 12 Monaten umsetzen
--
-- Passt zur Datenschutzerklaerung in index.html:
--   * Wochen (samt Verfuegbarkeiten und Abgaben) werden 12 Monate nach
--     Ende der Kalenderwoche geloescht.
--   * Deaktivierte Zugaenge werden 12 Monate nach der Deaktivierung
--     geloescht (samt Anmeldekonto).
--
-- Im Supabase-Dashboard unter "SQL Editor" ausfuehren. Die Funktion loescht
-- NICHT von selbst - sie muss aufgerufen werden (Handaufruf oder pg_cron,
-- siehe unten).
-- =====================================================================

create or replace function public.loeschfrist_anwenden(p_monate int default 12)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_grenze  date := (current_date - make_interval(months => p_monate))::date;
  v_wochen  int;
  v_ma      int;
  v_users   uuid[];
begin
  -- 1. Alte Wochen (kaskadiert auf Tage, Schichten, Abgaben, Verfuegbarkeiten)
  delete from public.weeks where kw_start_datum + 7 < v_grenze;
  get diagnostics v_wochen = row_count;

  -- 2. Lange deaktivierte Zugaenge
  with weg as (
    delete from public.employees
     where aktiv = false
       and aktualisiert_am < (now() - make_interval(months => p_monate))
    returning user_id
  )
  select coalesce(array_agg(user_id) filter (where user_id is not null), '{}'), count(*)
    into v_users, v_ma
    from weg;

  -- 3. Zugehoerige Anmeldekonten
  delete from auth.users where id = any(v_users);

  return json_build_object('wochen_geloescht', v_wochen, 'zugaenge_geloescht', v_ma);
end;
$fn$;

-- Nur der Datenbank-Eigentuemer (SQL Editor / pg_cron) darf das aufrufen,
-- niemand ueber die App.
revoke all on function public.loeschfrist_anwenden(int) from public, anon, authenticated;

-- Handaufruf:
--   select public.loeschfrist_anwenden();
--
-- Automatisch jeden Monat (erst unter Database -> Extensions "pg_cron"
-- aktivieren, dann diese Zeile ausfuehren):
--   select cron.schedule('loeschfrist', '0 3 1 * *', $$select public.loeschfrist_anwenden()$$);
