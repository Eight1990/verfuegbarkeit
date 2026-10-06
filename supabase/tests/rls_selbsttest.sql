-- =====================================================================
-- Selbsttest der Sicherheitsregeln (Row Level Security)
--
-- WOZU: beweist in der echten Datenbank, dass
--   1. ein Mitarbeiter keine fremden Daten lesen kann,
--   2. ein Mitarbeiter keine fremden Daten schreiben kann,
--   3. nach der Abgabefrist nichts mehr geaendert werden kann,
--   4. eine deaktivierte Personalnummer nichts mehr speichern kann,
--   5. der Passwort-Fingerabdruck fuer niemanden lesbar ist,
--   6. bei offenem Passwortwechsel (Migration 0005) nichts gespeichert wird,
--   7. geplante Schichten (Migration 0006) nur der Betroffene sieht und nur
--      Admins aendern koennen.
--
-- VORHER: es muessen mindestens ZWEI aktive Personalnummern angelegt sein.
--         Am einfachsten: im Admin-Bereich die Datei
--         beispiel_stammliste.xlsx hochladen und uebernehmen.
--
-- SO AUSFUEHREN (Supabase-Dashboard -> SQL Editor):
--   1. Diese Datei einmal komplett einfuegen und ausfuehren (legt den Test an)
--   2. Danach jederzeit:   select * from public.rls_selbsttest();
--
-- Der Test aendert nichts dauerhaft: alles, was er anfasst, setzt er
-- wieder zurueck. Er laeuft in einer einzigen Transaktion.
-- =====================================================================

create or replace function public.rls_selbsttest()
returns table (
  nr        int,
  pruefung  text,
  erwartet  text,
  ergebnis  text,
  bestanden boolean
)
language plpgsql
as $fn$
declare
  v_a_pn      text;
  v_a_user    uuid;
  v_b_pn      text;
  v_b_user    uuid;
  v_kw        date;
  v_datum     date;
  v_schicht   text;
  v_zahl      int;
  v_eigene    int;
  v_text      text;
  v_frist_alt timestamptz;
  v_a_flag    boolean;
  v_nr        int := 0;
begin
  -- ------------------------------------------------------------------
  -- Vorbereitung
  -- ------------------------------------------------------------------
  select e.personalnummer, e.user_id into v_a_pn, v_a_user
  from public.employees e
  where e.aktiv and e.user_id is not null
  order by e.personalnummer
  limit 1;

  if v_a_pn is null then
    raise exception 'Kein aktiver Zugang gefunden. Bitte zuerst die Stammliste hochladen.';
  end if;

  select e.personalnummer, e.user_id into v_b_pn, v_b_user
  from public.employees e
  where e.aktiv and e.user_id is not null and e.personalnummer <> v_a_pn
  order by e.personalnummer
  limit 1;

  if v_b_pn is null then
    raise exception 'Es werden zwei aktive Personalnummern gebraucht. Bitte Stammliste mit mindestens zwei Zeilen hochladen.';
  end if;

  v_kw := public.aktive_woche();
  perform public.get_or_create_week(v_kw);

  -- eine freie Schicht suchen, die noch keiner von beiden gewaehlt hat
  select ws.datum, ws.schicht_id into v_datum, v_schicht
  from public.week_shifts ws
  join public.week_days wd on wd.datum = ws.datum
  where ws.kw_start_datum = v_kw
    and ws.aktiv
    and not wd.gesperrt
    and not exists (
      select 1 from public.availability a
      where a.datum = ws.datum and a.schicht_id = ws.schicht_id
        and a.personalnummer in (v_a_pn, v_b_pn)
    )
  order by ws.datum, ws.sortierung
  limit 1;

  if v_datum is null then
    raise exception 'Keine freie Schicht zum Testen gefunden. Bitte im Admin-Bereich eine neue Woche anlegen.';
  end if;

  -- eigene Eintraege von A zaehlen (Vergleichswert fuer Test 5)
  select count(*) into v_eigene
  from public.availability a where a.personalnummer = v_a_pn;

  -- Passwortwechsel-Flag von A merken und fuer die Tests abschalten.
  -- Ein offener Passwortwechsel sperrt das Speichern (siehe Test 11b);
  -- am Ende wird der urspruengliche Wert wiederhergestellt.
  select e.muss_pw_aendern into v_a_flag
  from public.employees e where e.personalnummer = v_a_pn;
  update public.employees set muss_pw_aendern = false where personalnummer = v_a_pn;

  -- ------------------------------------------------------------------
  -- Ab hier arbeiten wir als Mitarbeiter A
  -- ------------------------------------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_a_user, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';

  -- 1) Nur die eigene Zeile in employees sichtbar
  select count(*) into v_zahl from public.employees;
  v_nr := v_nr + 1;
  return query select v_nr,
    ('Mitarbeiter ' || v_a_pn || ' sieht Zeilen in employees')::text,
    'genau 1'::text, v_zahl::text, (v_zahl = 1);

  -- 2) Eigene Personalnummer wird erkannt
  v_text := public.current_personalnummer();
  v_nr := v_nr + 1;
  return query select v_nr,
    'Eigene Personalnummer wird erkannt'::text,
    v_a_pn, coalesce(v_text, '(leer)'), (v_text = v_a_pn);

  -- 3) Kein Admin
  v_nr := v_nr + 1;
  return query select v_nr,
    'Mitarbeiter ist kein Admin'::text,
    'false'::text, public.is_admin()::text, (public.is_admin() = false);

  -- 4) Fremde Verfuegbarkeiten sind nicht lesbar
  select count(*) into v_zahl
  from public.availability a where a.personalnummer = v_b_pn;
  v_nr := v_nr + 1;
  return query select v_nr,
    ('Fremde Verfuegbarkeiten von ' || v_b_pn || ' lesbar')::text,
    '0 Zeilen'::text, v_zahl::text, (v_zahl = 0);

  -- 5) Insgesamt nur eigene Verfuegbarkeiten sichtbar
  select count(*) into v_zahl from public.availability;
  v_nr := v_nr + 1;
  return query select v_nr,
    'Sichtbare Verfuegbarkeiten insgesamt'::text,
    ('nur eigene: ' || v_eigene)::text, v_zahl::text, (v_zahl = v_eigene);

  -- 6) Fremde Abgaben sind nicht lesbar
  select count(*) into v_zahl
  from public.submissions s where s.personalnummer = v_b_pn;
  v_nr := v_nr + 1;
  return query select v_nr,
    ('Fremde Abgabe von ' || v_b_pn || ' lesbar')::text,
    '0 Zeilen'::text, v_zahl::text, (v_zahl = 0);

  -- 7) Schreiben auf eine fremde Personalnummer muss scheitern
  begin
    insert into public.availability (personalnummer, datum, schicht_id)
    values (v_b_pn, v_datum, v_schicht);
    v_nr := v_nr + 1;
    return query select v_nr,
      ('Verfuegbarkeit fuer fremde Nummer ' || v_b_pn || ' einfuegen')::text,
      'abgelehnt'::text, 'FEHLER: war moeglich'::text, false;
  exception when others then
    v_nr := v_nr + 1;
    return query select v_nr,
      ('Verfuegbarkeit fuer fremde Nummer ' || v_b_pn || ' einfuegen')::text,
      'abgelehnt'::text, ('abgelehnt (' || sqlstate || ')')::text, true;
  end;

  -- 8) Fremde Abgabe anlegen muss scheitern
  begin
    insert into public.submissions (personalnummer, kw_start_datum, max_schichten)
    values (v_b_pn, v_kw, 3);
    v_nr := v_nr + 1;
    return query select v_nr,
      ('Abgabe fuer fremde Nummer ' || v_b_pn || ' anlegen')::text,
      'abgelehnt'::text, 'FEHLER: war moeglich'::text, false;
  exception when others then
    v_nr := v_nr + 1;
    return query select v_nr,
      ('Abgabe fuer fremde Nummer ' || v_b_pn || ' anlegen')::text,
      'abgelehnt'::text, ('abgelehnt (' || sqlstate || ')')::text, true;
  end;

  -- 9) Fremde Personalnummer deaktivieren muss scheitern
  begin
    update public.employees set aktiv = false where personalnummer = v_b_pn;
    v_nr := v_nr + 1;
    return query select v_nr,
      ('Fremde Nummer ' || v_b_pn || ' deaktivieren')::text,
      'abgelehnt'::text, 'FEHLER: war moeglich'::text, false;
  exception when others then
    v_nr := v_nr + 1;
    return query select v_nr,
      ('Fremde Nummer ' || v_b_pn || ' deaktivieren')::text,
      'abgelehnt'::text, ('abgelehnt (' || sqlstate || ')')::text, true;
  end;

  -- 10) Passwort-Fingerabdruck ist nicht lesbar
  begin
    execute 'select passwort_fp from public.employees limit 1' into v_text;
    v_nr := v_nr + 1;
    return query select v_nr,
      'Passwort-Fingerabdruck lesen'::text,
      'abgelehnt'::text, 'FEHLER: war moeglich'::text, false;
  exception when others then
    v_nr := v_nr + 1;
    return query select v_nr,
      'Passwort-Fingerabdruck lesen'::text,
      'abgelehnt'::text, ('abgelehnt (' || sqlstate || ')')::text, true;
  end;

  -- 11) Eigene Abgabe speichern muss funktionieren (wird zurueckgenommen)
  begin
    perform public.abgabe_speichern(
      v_kw, null, 'Selbsttest',
      json_build_array(json_build_object('datum', v_datum, 'schicht_id', v_schicht))::jsonb
    );
    v_nr := v_nr + 1;
    return query select v_nr,
      'Eigene Abgabe vor der Frist speichern'::text,
      'gespeichert'::text, 'gespeichert'::text, true;
    delete from public.availability
     where personalnummer = v_a_pn and datum = v_datum and schicht_id = v_schicht;
  exception when others then
    v_nr := v_nr + 1;
    return query select v_nr,
      'Eigene Abgabe vor der Frist speichern'::text,
      'gespeichert'::text, ('FEHLER: ' || left(sqlerrm, 70))::text, false;
  end;

  -- 11b) Solange der Passwortwechsel offen ist, darf nicht gespeichert werden
  execute 'reset role';
  update public.employees set muss_pw_aendern = true where personalnummer = v_a_pn;
  execute 'set local role authenticated';

  v_nr := v_nr + 1;
  return query select v_nr,
    'Passwortwechsel offen wird erkannt'::text,
    'true'::text, public.muss_passwort_aendern()::text,
    (public.muss_passwort_aendern() = true);

  begin
    perform public.abgabe_speichern(
      v_kw, null, 'Selbsttest Passwortwechsel offen',
      json_build_array(json_build_object('datum', v_datum, 'schicht_id', v_schicht))::jsonb
    );
    v_nr := v_nr + 1;
    return query select v_nr,
      'Speichern bei offenem Passwortwechsel'::text,
      'abgelehnt'::text, 'FEHLER: war moeglich'::text, false;
  exception when others then
    v_nr := v_nr + 1;
    return query select v_nr,
      'Speichern bei offenem Passwortwechsel'::text,
      'abgelehnt'::text, 'abgelehnt'::text, true;
  end;

  -- Flag fuer die restlichen Tests wieder abschalten
  execute 'reset role';
  update public.employees set muss_pw_aendern = false where personalnummer = v_a_pn;

  -- ------------------------------------------------------------------
  -- 12) und 13) Nach Ablauf der Frist darf nichts mehr gespeichert werden
  -- ------------------------------------------------------------------
  execute 'reset role';

  select w.abgabefrist into v_frist_alt from public.weeks w where w.kw_start_datum = v_kw;
  update public.weeks set abgabefrist = now() - interval '1 hour' where kw_start_datum = v_kw;

  execute 'set local role authenticated';

  begin
    perform public.abgabe_speichern(
      v_kw, null, 'Selbsttest nach Frist',
      json_build_array(json_build_object('datum', v_datum, 'schicht_id', v_schicht))::jsonb
    );
    v_nr := v_nr + 1;
    return query select v_nr,
      'Speichern NACH der Abgabefrist'::text,
      'abgelehnt'::text, 'FEHLER: war moeglich'::text, false;
  exception when others then
    v_nr := v_nr + 1;
    return query select v_nr,
      'Speichern NACH der Abgabefrist'::text,
      'abgelehnt'::text, 'abgelehnt'::text, true;
  end;

  begin
    insert into public.availability (personalnummer, datum, schicht_id)
    values (v_a_pn, v_datum, v_schicht);
    v_nr := v_nr + 1;
    return query select v_nr,
      'Direktes Einfuegen NACH der Frist'::text,
      'abgelehnt'::text, 'FEHLER: war moeglich'::text, false;
  exception when others then
    v_nr := v_nr + 1;
    return query select v_nr,
      'Direktes Einfuegen NACH der Frist'::text,
      'abgelehnt'::text, ('abgelehnt (' || sqlstate || ')')::text, true;
  end;

  -- Frist wieder herstellen
  execute 'reset role';
  update public.weeks set abgabefrist = v_frist_alt where kw_start_datum = v_kw;

  -- ------------------------------------------------------------------
  -- 13b) Geplante Schichten (Migration 0006): nur eigene sichtbar, kein Schreiben
  -- ------------------------------------------------------------------
  insert into public.planung (personalnummer, datum, schicht_id, beginn, ende, kw_start_datum)
  values (v_a_pn, v_kw, 'FRUEH', '04:00', '07:00', v_kw),
         (v_b_pn, v_kw, 'FRUEH', '04:00', '07:00', v_kw);

  execute 'set local role authenticated';

  select count(*) into v_zahl from public.planung;
  v_nr := v_nr + 1;
  return query select v_nr,
    'Mitarbeiter sieht Zeilen in planung'::text,
    'genau 1 (nur eigene)'::text, v_zahl::text, (v_zahl = 1);

  begin
    insert into public.planung (personalnummer, datum, schicht_id, beginn, ende, kw_start_datum)
    values (v_a_pn, v_kw, 'SPAET', '18:30', '22:30', v_kw);
    v_nr := v_nr + 1;
    return query select v_nr,
      'Mitarbeiter schreibt in planung'::text,
      'abgelehnt'::text, 'FEHLER: war moeglich'::text, false;
  exception when others then
    v_nr := v_nr + 1;
    return query select v_nr,
      'Mitarbeiter schreibt in planung'::text,
      'abgelehnt'::text, ('abgelehnt (' || sqlstate || ')')::text, true;
  end;

  begin
    perform public.planung_ersetzen(v_kw, '[]'::jsonb);
    v_nr := v_nr + 1;
    return query select v_nr,
      'Mitarbeiter ruft planung_ersetzen auf'::text,
      'abgelehnt'::text, 'FEHLER: war moeglich'::text, false;
  exception when others then
    v_nr := v_nr + 1;
    return query select v_nr,
      'Mitarbeiter ruft planung_ersetzen auf'::text,
      'abgelehnt'::text, ('abgelehnt (' || sqlstate || ')')::text, true;
  end;

  execute 'reset role';
  delete from public.planung where kw_start_datum = v_kw and personalnummer in (v_a_pn, v_b_pn);

  -- ------------------------------------------------------------------
  -- 14) Deaktivierte Personalnummer kann nichts mehr speichern
  -- ------------------------------------------------------------------
  update public.employees set aktiv = false where personalnummer = v_a_pn;

  execute 'set local role authenticated';

  v_text := public.current_personalnummer();
  v_nr := v_nr + 1;
  return query select v_nr,
    'Deaktivierte Nummer wird nicht mehr erkannt'::text,
    '(leer)'::text, coalesce(v_text, '(leer)'), (v_text is null);

  begin
    insert into public.availability (personalnummer, datum, schicht_id)
    values (v_a_pn, v_datum, v_schicht);
    v_nr := v_nr + 1;
    return query select v_nr,
      'Deaktivierte Nummer speichert Verfuegbarkeit'::text,
      'abgelehnt'::text, 'FEHLER: war moeglich'::text, false;
  exception when others then
    v_nr := v_nr + 1;
    return query select v_nr,
      'Deaktivierte Nummer speichert Verfuegbarkeit'::text,
      'abgelehnt'::text, ('abgelehnt (' || sqlstate || ')')::text, true;
  end;

  -- Aufraeumen
  execute 'reset role';
  update public.employees
     set aktiv = true, muss_pw_aendern = v_a_flag
   where personalnummer = v_a_pn;
  perform set_config('request.jwt.claims', '', true);

  return;
end;
$fn$;

-- Diese Funktion wechselt intern die Datenbankrolle und darf deshalb
-- NUR aus dem SQL-Editor heraus laufen, niemals aus der App.
revoke all on function public.rls_selbsttest() from public, anon, authenticated;

-- Jetzt ausfuehren:
select * from public.rls_selbsttest();
