# Verfügbarkeit FedEx-Schichten (ZiG)

Eine kleine Web-App, in der Mitarbeitende der **Zeit ist Geld GmbH** für die
**Folgewoche** eintragen, welche FedEx-Schichten sie **maximal** übernehmen könnten.

Aus diesen Angaben berechnet die App im Admin-Bereich einen Wochenplan
(regelbasiert, ohne KI-Dienst). Du prüfst ihn, lädst die Dispo-Datei für den
Kunden herunter und veröffentlichst die Schichten für die Mitarbeitenden. Wer
lieber selbst plant, kann die Angaben weiterhin als CSV herunterladen.

---

## Inhalt

- [Wie es für die Mitarbeitenden aussieht](#wie-es-für-die-mitarbeitenden-aussieht)
- [Was du brauchst](#was-du-brauchst)
- [Einrichtung in 10 Schritten](#einrichtung-in-10-schritten)
- [Erste Nutzung: Stammliste hochladen](#erste-nutzung-stammliste-hochladen)
- [Tresor (Namen verschlüsselt)](#tresor-namen-verschlüsselt)
- [Der Wochenablauf](#der-wochenablauf)
- [Der Export (CSV)](#der-export-csv)
- [Sicherheit selbst nachprüfen](#sicherheit-selbst-nachprüfen)
- [Wenn etwas nicht klappt](#wenn-etwas-nicht-klappt)
- [Datenschutz](#datenschutz)
- [Was die App bewusst nicht kann](#was-die-app-bewusst-nicht-kann)
- [Dateien in diesem Ordner](#dateien-in-diesem-ordner)

---

## Wie es für die Mitarbeitenden aussieht

1. Link öffnen (am Handy).
2. Personalnummer und Startpasswort eingeben. Beim ersten Login legt jede Person
   ein **eigenes Passwort** fest (mindestens 8 Zeichen, eine Ziffer, ein
   Sonderzeichen). Danach gilt nur noch das eigene Passwort. Das Gerät bleibt
   angemeldet.
3. Oben steht groß, um welche Woche es geht, z. B. **KW 40 · 28.09.–02.10.**
4. Pro Tag drei große Schaltflächen: **Frühschicht**, **Spätschicht**,
   **Lange Spätschicht** — jeweils mit Uhrzeit und Symbol.
   Angetippt = grün = „kann ich".
5. Abkürzungen: **Ganzer Tag** je Tag, **Alles möglich** und **Nichts** für die
   ganze Woche, **Wie letzte Woche** übernimmt die vorige Eingabe als Vorschlag.
6. Unten eine große Schaltfläche **Senden**. Danach erscheint ein grüner Haken
   mit „Gespeichert".
7. Bis zur Frist (standardmäßig Freitag 12:00) kann beliebig oft geändert werden.

**Wichtige Regel:** Wer „Lang" (16:00–22:30) wählt, ist automatisch auch für
„Spät" (18:30–22:30) verfügbar — „Spät" wird mit markiert. Wird „Spät"
abgewählt, fällt „Lang" ebenfalls weg. Früh und Spät am selben Tag sind
ausdrücklich erlaubt; die App prüft **keine** Arbeitszeitregeln.

---

## Was du brauchst

- Ein **GitHub-Konto** (kostenlos) — hostet die Seite.
- Ein **Supabase-Konto** (kostenlos) — Datenbank und Anmeldung.
- Deine **Excel-Liste** mit Personalnummern und Passwörtern.
  Diese Datei bleibt **immer nur bei dir auf dem Rechner**.

Du brauchst keine Programme zu installieren. Alles läuft im Browser.

**Zeitbedarf:** etwa 45–60 Minuten für die komplette Einrichtung.

---

## Einrichtung in 10 Schritten

### Schritt 1 — Supabase-Projekt in Frankfurt anlegen

1. Auf <https://supabase.com> anmelden.
2. **New project** anklicken.
3. Ausfüllen:
   - **Name:** z. B. `zig-verfuegbarkeit`
   - **Database Password:** ein langes Zufallspasswort. **Speichere es in deinem
     Passwortmanager.** Du brauchst es selten, aber es lässt sich nicht
     nachträglich anzeigen.
   - **Region:** **Central EU (Frankfurt) — `eu-central-1`**
     Das ist wichtig: so bleiben die Daten in Deutschland.
4. **Create new project** und ein bis zwei Minuten warten.

### Schritt 2 — Auftragsverarbeitungsvertrag (DPA)

Supabase verarbeitet für euch personenbezogene Daten. Dafür braucht ihr nach
Art. 28 DSGVO einen Auftragsverarbeitungsvertrag. Bei Supabase ist das DPA
**Teil der Nutzungsbedingungen (Terms of Service)** und gilt damit automatisch
für jede Organisation. Ein separates Unterschreiben ist nicht nötig und im
Dashboard auch nicht vorgesehen.

1. Dashboard → Organization Settings → **Legal Documents**
   (<https://supabase.com/dashboard/org/_/documents>).
2. Beim Punkt **Data Processing Addendum (DPA)** auf **View DPA** klicken.
3. Den Text (Versionsstand notieren, z. B. „Version 1 vom 01.08.2026") als PDF
   speichern bzw. ausdrucken und zu den Datenschutzunterlagen legen. Dort steht
   auch **Transfer Impact Assessment (TIA)** zum Download — ebenfalls ablegen.


### Schritt 3 — Datenbank einrichten (alle Migrationen)

Im Supabase-Dashboard links auf **SQL Editor** → **New query**.

Jetzt **eine nach der anderen**, jeweils komplett einfügen und auf **Run**
drücken:

1. `supabase/migrations/0001_init.sql` — legt die Tabellen an
2. `supabase/migrations/0002_rls.sql` — legt die Schutzregeln an
3. `supabase/migrations/0003_standard_schichten.sql` — legt die Schichten an
4. danach in Nummernreihenfolge alle weiteren Dateien `0004` bis `0014`
   (Löschfrist, eigenes Passwort, geplante Schichten, Einstellungen, Dateiablage,
   Keep-alive, automatische Wochen, Löschfrist-Cron, Versionszähler für den Tresor)

Die Reihenfolge ist wichtig. Nach Datei 3 sollte unten eine Tabelle mit
15 Zeilen erscheinen (3 Schichten × 5 Tage) — das ist die Kontrollabfrage.
Alle Dateien lassen sich gefahrlos mehrfach ausführen.

> **Fehlermeldung „already exists"?** Dann wurde die Datei schon einmal
> ausgeführt. Das ist kein Problem, mach mit der nächsten weiter.

### Schritt 4 — Anmeldung richtig einstellen

Links auf **Authentication**.

1. **Sign In / Providers** → **Email**:
   - **Allow new users to sign up:** **AUS**.
     Sehr wichtig. Sonst könnte sich jeder selbst einen Zugang anlegen.
   - **Confirm email:** kann aus bleiben. Die Zugänge, die die App anlegt, sind
     automatisch bestätigt.
2. Fertig. Mehr ist hier nicht einzustellen.

### Schritt 5 — Die Server-Funktionen einspielen

Diese Funktionen legen Zugänge an und setzen Passwörter. Sie laufen auf
dem Server, weil sie erhöhte Rechte brauchen — diese Rechte dürfen niemals in
die Webseite gelangen.

Links auf **Edge Functions** → **Deploy a new function** → **Via Editor**.

**Funktion 1:**
- Name exakt: `import-stammliste`
- Inhalt: kompletter Text aus `supabase/functions/import-stammliste/index.ts`
- **Deploy**

**Funktion 2:**
- Name exakt: `reset-passwort`
- Inhalt: kompletter Text aus `supabase/functions/reset-passwort/index.ts`
- **Deploy**

**Funktion 3** (eigenes Passwort der Mitarbeitenden):
- Name exakt: `passwort-setzen`
- Inhalt: kompletter Text aus `supabase/functions/passwort-setzen/index.ts`
- **Deploy**
- Zusätzlich einmal `0005_passwort_aendern.sql` im SQL Editor ausführen.

Die Namen müssen genau so geschrieben sein, sonst findet die App sie nicht.

> **Wichtig nach jedem Neu-Veröffentlichen einer Funktion:** In den
> Einstellungen der Funktion muss **Verify JWT with legacy secret** auf **AUS**
> stehen. Dieses Projekt signiert Anmelde-Tokens mit einem modernen
> ECC-Schlüssel; die alte Prüfung würde solche Tokens ablehnen, und der Import
> bräche mit einem 401-Fehler ab. Geschützt sind die Funktionen trotzdem: sie
> prüfen bei jedem Aufruf selbst, ob ein angemeldeter Admin dahintersteckt.
> Beim ersten Veröffentlichen steht der Schalter auf AN — also nach dem Deploy
> einmal nachsehen.

> **Empfohlen:** Unter **Edge Functions → Secrets** `ERLAUBTE_ORIGIN` auf die
> Adresse deiner Seite setzen, ohne Pfad (z. B. `https://deinname.github.io`).
> Dann beantworten die Funktionen Browser-Anfragen nur noch von dieser Seite
> (CORS). Ohne diese Einstellung antworten sie jedem Origin (`*`); geschützt
> sind sie trotzdem, weil sie bei jedem Aufruf prüfen, wer angemeldet ist.
> Prüfen: `curl -i -X OPTIONS https://<ref>.supabase.co/functions/v1/passwort-setzen -H "Origin: https://beispiel.invalid"`
> muss `Access-Control-Allow-Origin: https://deinname.github.io` zeigen.

### Schritt 6 — Deinen Admin-Zugang anlegen

1. **Authentication** → **Users** → **Add user** → **Create new user**
   - **Email:** deine dienstliche E-Mail
   - **Password:** ein starkes Passwort
   - **Auto Confirm User:** anhaken
   - **Create user**
2. Jetzt diesen Zugang zum Admin machen: **SQL Editor** → **New query**,
   deine E-Mail eintragen und ausführen:

```sql
insert into public.admins (user_id, notiz)
select id, 'Planung'
from auth.users
where email = 'deine.adresse@zeit-ist-geld.de'
on conflict (user_id) do nothing;

-- Kontrolle: muss genau eine Zeile zeigen
select a.user_id, u.email
from public.admins a
join auth.users u on u.id = a.user_id;
```

Für die **Vertretung** genau dasselbe wiederholen: Benutzer anlegen, dann mit
deren E-Mail-Adresse noch einmal in `public.admins` eintragen.

### Schritt 7 — Die zwei Zugangswerte in `index.html` eintragen

> **Bei diesem Projekt ist der Schritt bereits erledigt.** Die Werte stehen in
> `index.html`. Die folgende Anleitung brauchst du nur, wenn ihr später ein
> anderes Supabase-Projekt verwendet oder die Schlüssel ausgetauscht werden.

1. Im Supabase-Dashboard: **Project Settings** (Zahnrad) → **API Keys**.
   Dort stehen:
   - **Project URL**, z. B. `https://abcdefghijkl.supabase.co`
   - der öffentliche Schlüssel. Neuere Projekte zeigen ihn als
     **Publishable key** im Format `sb_publishable_…`; ältere zeigen einen
     **anon public key**, der mit `eyJ…` beginnt. Beide funktionieren an
     derselben Stelle in `index.html`.
2. `index.html` in einem Texteditor öffnen (Editor/Notepad genügt).
3. Ganz oben im Abschnitt `const CONFIG = {` die zwei Platzhalter ersetzen:

```js
const CONFIG = {
  SUPABASE_URL:      "https://abcdefghijkl.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOi... (der lange anon-Key)",
  ...
```

4. Bei Gelegenheit noch die beiden Links auf die echten Adressen der
   ZiG-Website anpassen.

> **Diese beiden Werte sind keine Geheimnisse.** Sie dürfen in einem
> öffentlichen Repository stehen. Der Schutz der Daten liegt vollständig in den
> Regeln der Datenbank (Schritt 3).
>
> **Was niemals in `index.html` gehört:** der `service_role`-Key bzw.
> `secret key`. Falls du ihn dort siehst — sofort entfernen und in Supabase unter
> **API Keys** neu erzeugen.

### Schritt 8 — Auf GitHub veröffentlichen (GitHub Pages)

1. Auf <https://github.com> anmelden → oben rechts **+** → **New repository**.
   - **Repository name:** z. B. `verfuegbarkeit`
   - **Public** auswählen (für kostenlose GitHub Pages)
   - **Create repository**
2. Auf der nächsten Seite **uploading an existing file** anklicken.
3. Diese Dateien und Ordner ins Browserfenster ziehen:
   `index.html`, `tresor.js`, `planung-solver.js`, `dispo-export.js`, die Ordner
   `vendor`, `tests`, `supabase` und `.github`, `README.md`. **Niemals** den Ordner
   „Nicht veröffentlichen! Echte Daten" oder eine echte Stammliste. Dann **Commit changes**.
4. **Settings** → links **Pages**:
   - **Source:** *Deploy from a branch*
   - **Branch:** `main`, Ordner `/ (root)` → **Save**
5. Eine bis zwei Minuten warten. Oben erscheint die Adresse, z. B.
   `https://deinname.github.io/verfuegbarkeit/`
6. Diese Adresse im Handy öffnen. Es muss die Anmeldemaske erscheinen.

> Zeigt die Seite den Hinweis „Die App ist noch nicht eingerichtet", dann wurden
> die Werte aus Schritt 7 nicht gespeichert oder nicht mit hochgeladen.

### Schritt 9 — Keep-alive einschalten (GitHub Secrets)

Supabase pausiert kostenlose Projekte nach **7 Tagen ohne Aktivität**. Die
mitgelieferte Automatik ruft alle 3 Tage eine kleine Datenbankabfrage auf und
verhindert das.

1. Im GitHub-Repository: **Settings** → **Secrets and variables** → **Actions**
2. **New repository secret**, zweimal:
   - Name `SUPABASE_URL`, Wert: die Projekt-URL aus Schritt 7
   - Name `SUPABASE_ANON_KEY`, Wert: der anon-Key aus Schritt 7
3. Oben auf **Actions** → links **Keep-alive Supabase** → **Run workflow**,
   um es sofort einmal zu testen. Nach etwa 20 Sekunden muss ein grüner Haken
   erscheinen.

> GitHub schaltet geplante Abläufe ab, wenn **60 Tage** lang niemand etwas am
> Repository ändert. Dann unter **Actions** einmal **Run workflow** drücken —
> damit läuft der Zeitplan wieder.

### Schritt 10 — Eigene Adresse (optional)

Statt `deinname.github.io/verfuegbarkeit` geht auch z. B.
`schichten.zeit-ist-geld.de`:

1. Beim Anbieter der Domain `zeit-ist-geld.de` einen **CNAME**-Eintrag anlegen:
   - Name/Host: `schichten`
   - Ziel/Wert: `deinname.github.io`
2. In GitHub: **Settings** → **Pages** → **Custom domain** →
   `schichten.zeit-ist-geld.de` → **Save**
3. **Enforce HTTPS** anhaken, sobald es anwählbar ist (kann eine Stunde dauern).

---

## Erste Nutzung: Stammliste hochladen

Es gibt **eine** Stammliste für alles: Zugänge, Namen, Planungsprofile,
Einsatzzeitraum und die Lohndaten der Minijobber. Zeile 1 enthält die
Überschriften. Die ersten drei Spalten sind die wichtigen, alle weiteren sind
optional und dürfen fehlen:

| Personalnummer | Passwort | Name | Kategorie | Fahrgemeinschaft |
|---|---|---|---|---|
| 10001 | BEISPIEL-Passwort1 | Mustermann, Anna | Teilzeit | FG1 |
| 10002 | BEISPIEL-Passwort2 | Beispiel, Ben | Minijob | |
| 00345 | BEISPIEL-Passwort3 | Muster, Chris | | fg 1 |

Bedeutung der optionalen Spalten D und E: **Kategorie** `Teilzeit` oder `Minijob`
(leer = Minijob), **Fahrgemeinschaft** ein frei gewähltes Kürzel für Personen,
die zusammen fahren. Gleiche Kennung = eine Fahrgemeinschaft; Groß- und
Kleinschreibung und Leerzeichen zählen nicht (`fg 1` = `FG1`). Im Beispiel
fahren also Anna und Chris zusammen. Wie die Planung Fahrgemeinschaften
behandelt, steht unter [Wochenplanung](#wochenplanung-auto-planung).

**Spalten F–M (Einsatzzeitraum und Lohndaten).** Sie füllt ein lokales
Hilfsskript (Einsatzzeitraum aus der Personalverwaltung, Lohndaten aus den
Lohnabrechnungen); von Hand muss man dort nichts eintragen. Die App findet die
Spalten über die Überschrift:

| Sp. | Überschrift | Inhalt (Beispiel, erfunden) |
|---|---|---|
| F | Einsatz von | `09.02.2026` |
| G | Einsatz bis | `08.11.2026` |
| H | Eintritt | `09.02.2026` oder leer |
| I | Abgerechnet bis | `09/2026` oder leer (= noch keine Abrechnung) |
| J | SV-Brutto seit Eintritt | `2950,00` oder leer |
| K | Stunden seit Eintritt | `210,50` oder leer |
| L | Minijob-Merkmal | `ja`, `nein`, `?` oder leer |
| M | Stand Lohndaten | `11.11.2026` (Tag, an dem die Lohndaten geholt wurden) |

- **Einsatz von/bis gilt für alle:** An Tagen außerhalb dieses Zeitraums plant
  die App niemanden ein; Schritt 2 der Wochenplanung nennt die Betroffenen.
- **Lohndaten (I–K) nur für Minijobber** (Kategorie Minijob oder leer); bei
  Teilzeit bleiben sie leer und werden nie gespeichert. Daraus entsteht der
  [Minijob-Stand](#minijob-grenze-minijob-stand). Die Datei enthält damit
  Lohndaten: nur lokal aufbewahren, nicht per E-Mail oder Chat weitergeben,
  nie ins Repo.
- **Streng:** Ein Datum muss `TT.MM.JJJJ` sein (auch `T.M.JJJJ`) oder eine echte
  Excel-Datumszelle, ein Monat `MM/JJJJ`, ein Betrag `2950,00`, `2.950,00` oder
  `2950`. Lässt sich eine gefüllte Zelle nicht lesen, nennt die App Zeile und
  Spalte (z. B. *Zeile 4, Spalte "Einsatz bis": "31.02.2026" – kein gültiges
  Datum*) und speichert keine Namen, bis die Datei korrigiert ist. Ebenso, wenn
  „Einsatz von“ nach „Einsatz bis“ liegt oder bei einem Minijobber „Abgerechnet
  bis“ gefüllt, aber „Eintritt“ oder „SV-Brutto seit Eintritt“ leer ist.
- **Datei ohne Lohndaten-Spalten** (ohne „Abgerechnet bis“ und „SV-Brutto“):
  dann bleibt der bisherige Minijob-Stand im Tresor unverändert.

Die früheren Spalten **Max. Schichten**, **Ø h/Wo**, **Nur Schicht**,
**Gesperrte Tage** und **Notiz** gibt es nicht mehr. Eine ältere Datei, die sie
noch enthält, wird trotzdem angenommen; diese Spalten werden einfach ignoriert.
Die Höchstzahl an Schichten gibt jeder Mitarbeiter selbst bei seiner Abgabe an.

`tests/stamm_synthetisch.xlsx` zeigt das vollständige Format (Spalten A–M) mit
erfundenen Daten. `.xlsx` und `.csv` funktionieren beide; es zählt das erste
Tabellenblatt.

**Regeln:**
- Neue oder geänderte Startpasswörter mindestens **10 Zeichen**, zufällig gewählt (bestehende, unveränderte bleiben gültig).
- Personalnummern dürfen Ziffern, Buchstaben, Punkt, Bindestrich und
  Unterstrich enthalten, höchstens 20 Zeichen. **Führende Nullen bleiben
  erhalten** — formatiere die Spalte in Excel als *Text*.
- Keine Geburtsdaten, keine Gesundheitsangaben, keine weiteren
  personenbezogenen Spalten.

**Was wohin geht:**
- **Personalnummer und Passwort** gehen an den Server und werden zu Zugängen.
  Passwörter werden nirgends gespeichert, nur als nicht umkehrbarer Prüfwert.
- **Name und alle Profilspalten** werden noch im Browser verschlüsselt und im
  **Tresor** abgelegt (siehe [nächster Abschnitt](#tresor-namen-verschlüsselt)).
  Der Server sieht davon nur Zeichensalat.

**So läuft der Import:**
1. Auf der Seite unten **Admin-Anmeldung** → mit E-Mail und Passwort anmelden.
   Du landest auf der **Startseite** des Admin-Bereichs.
2. Beim allerersten Mal zeigt die Startseite die Karte **Tresor anlegen**:
   Tresor-Passwort wählen (Regeln im nächsten Abschnitt), wiederholen, anlegen.
   Später fragt die Karte nur noch nach dem Tresor-Passwort, wenn der Tresor
   auf diesem Gerät noch nicht geöffnet ist.
3. **Mitarbeiter** → Datei auswählen. Darunter erscheint eine Lesezeile
   („… Zeilen gelesen").
4. **Vorschau prüfen**. Es erscheint z. B. *„3 neu · 0 geändert · 0 deaktiviert"*.
   Die Listen darunter lassen sich aufklappen. **Bis hierhin ist nichts verändert.**
   Hat die Datei Lohndaten, zeigt die Vorschau außerdem: Minijobber mit
   Wochen-Obergrenze, ohne Abrechnung, mit 0 h, „abgerechnet bis“ und wie viele
   laut Stammliste Minijob, laut Abrechnung aber kein Minijob sind.
5. Würden Zugänge deaktiviert oder Passwörter geändert, zeigt eine **rote
   Liste** die Betroffenen **mit Namen**. Lies sie und setze den Pflicht-Haken.
   Ebenso, wenn Minijobber, die bisher eine Wochen-Obergrenze hatten, danach
   keine mehr hätten (z. B. „Abgerechnet bis“ leer, jetzt Teilzeit oder nicht
   mehr in der Datei): rote Warnung mit Zahl und Namen, eigener Pflicht-Haken.
6. Stimmt alles, auf **Jetzt übernehmen: Zugänge, Namen und Lohndaten** (ohne
   Lohndaten-Spalten: **Jetzt übernehmen: Zugänge und Namen**).

**Drei Dateiformen, derselbe Weg:**
- **Vollständige Datei** (Personalnummer, Passwort, Name, optional Profile und
  Lohndaten): Zugänge und Tresor werden zusammen aktualisiert. Knopf: **Jetzt
  übernehmen: Zugänge, Namen und Lohndaten** bzw. **… Zugänge und Namen**.
- **Datei ohne Spalte „Name"**: nur die Zugänge, der Tresor bleibt unverändert.
  Knopf: **Nur Zugänge übernehmen (Datei ohne Namen)**.
- **Datei ohne Spalte „Passwort"**: nur Namen, Profile und (falls die Spalten
  da sind) Lohndaten. Der Server wird nicht aufgerufen, kein Zugang ändert
  sich. **Empfohlen für Korrekturen** an Namen oder Profilen. Knopf: **Namen und
  Profile übernehmen (Zugänge bleiben unverändert)** bzw. **Namen, Profile und
  Lohndaten übernehmen …**.

**Was der Import macht:**
- Nummern, die es noch nicht gibt → **neuer Zugang**
- Nummern mit **geändertem** Passwort → Passwort wird ersetzt. Die Person muss
  beim nächsten Login wieder ein eigenes Passwort festlegen. Bei **unveränderter**
  Liste bleibt das eigene Passwort bestehen.
- Nummern, die **nicht mehr** in der Liste stehen → **deaktiviert**, nicht
  gelöscht. Die Person kann sich nicht mehr anmelden, bisherige Angaben bleiben
  für den Export erhalten.
- Nummern, die wieder auftauchen → werden wieder aktiviert

Du kannst die Liste jederzeit erneut hochladen. Sie ist die maßgebliche Quelle.
Du musst sie aber **nicht** pro Sitzung oder pro Gerät neu einspielen: Namen und
Profile kommen danach auf jedem Gerät aus dem Tresor.

> **Woher weiß die App, ob ein Passwort geändert wurde, ohne es zu speichern?**
> Sie speichert nur einen nicht umkehrbaren Prüfwert (SHA-256 mit geheimem
> Zusatz). Daraus lässt sich kein Passwort zurückrechnen, und **niemand** kann
> diese Spalte lesen — auch kein Admin. Nur die Server-Funktion kommt daran.

**Einzelnes Passwort zurücksetzen:** **Mitarbeiter** → unten **Passwort
zurücksetzen** aufklappen → Person nach **Name** auswählen → neues Passwort
eintragen → **Passwort setzen**. Das gilt dann als Startpasswort:
die Person legt beim nächsten Login wieder ein eigenes fest. Ein **vergessenes**
Passwort können Mitarbeitende nicht selbst zurücksetzen; sie melden sich bei dir.

---

## Tresor (Namen verschlüsselt)

**Was er ist.** Namen und Planungsprofile (und der
[Minijob-Stand](#minijob-grenze-minijob-stand)) liegen in der Datenbank (Tabelle
`app_dateien`, Schlüssel `stammliste_tresor`) **ausschließlich verschlüsselt**
(AES-256-GCM). Der Schlüssel wird im Browser aus einem eigenen
**Tresor-Passwort** abgeleitet (PBKDF2 mit 600.000 Runden) und verlässt den
Browser nie. Supabase und der Datenbank-Anbieter sehen nur Zeichensalat. Das
Tresor-Passwort ist **nicht** dein Admin-Login-Passwort.

**Passwortregel.** Mindestens 12 Zeichen und nicht einförmig (also nicht
`aaaaaaaaaaaa` oder `123456789012`). Am besten ein Satz aus vier Wörtern,
nach dem Muster `Kaffee Montag Nebel Fahrrad` (aber ein eigener).

**Aufbewahrung.** Im Passwortmanager speichern. Es gibt **keine**
Wiederherstellung über Supabase: Wer das Passwort verliert, verliert den
Tresor-Inhalt (siehe „Passwort vergessen" unten). Nie ins Repo, nie in Chat
oder E-Mail.

**Vertretung.** Das Tresor-Passwort der Vertretung **persönlich** geben. Beide
nutzen denselben Tresor auf ihren eigenen Geräten. Speichern zwei Geräte fast
gleichzeitig, geht nichts verloren: Ein Versionszähler erkennt den Konflikt und
meldet „auf einem anderen Gerät geändert". Dann Seite neu laden, Tresor öffnen
und die Änderung wiederholen.

**Auf diesem Gerät merken.** Der Haken **Auf diesem Gerät merken (bis zum
Abmelden)** legt den (nicht exportierbaren) Schlüssel im Browser-Speicher
(IndexedDB) ab. Dann fragt die App beim nächsten Öffnen nicht erneut nach dem
Tresor-Passwort. Nur auf eigenen Geräten anhaken, nie an fremden Rechnern.

**Abmelden** löscht den gemerkten Schlüssel auf dem Gerät. Dasselbe erreichst
du über **Mehr > Tresor > Tresor auf diesem Gerät vergessen**.

**Mehr > Tresor** zeigt den Status (Version, zuletzt gespeichert, von dir oder
einem anderen Admin) und bietet:
- **Tresor-Passwort ändern** — altes Passwort nötig. Andere Geräte (Vertretung)
  müssen das neue Passwort danach einmal eingeben.
- **Tresor auf diesem Gerät vergessen** — löscht den gemerkten Schlüssel.
- **Passwort vergessen?** — erscheint nur bei gesperrtem Tresor und
  überschreibt ihn mit einem neuen Passwort. Danach die Stammliste **ohne
  Passwortspalte** (aber mit den Lohndaten-Spalten) neu einspielen. Die Zugänge
  bleiben erhalten; verloren gehen nur die gemerkten Dispo-Schreibweisen (siehe
  [Geplante Schichten](#geplante-schichten-dispo-einlesen)).

**Einmalig anlegen.** Der Tresor wird als eigener Schritt auf der Startseite
angelegt (Karte **Tresor anlegen**). Danach erscheint die Karte nur noch, wenn
der Tresor auf diesem Gerät geöffnet werden muss.

**Diese Version einspielen — in dieser Reihenfolge:**
1. `supabase/migrations/0013_app_dateien_version.sql` im SQL Editor ausführen
   (Spalte `version`, Trigger, Größenschranke; mehrfach ausführbar). Ohne 0013
   läuft der Admin-Bereich nicht.
2. `supabase/tests/rls_selbsttest.sql` komplett neu einfügen und ausführen,
   danach `select * from public.rls_selbsttest();` — überall `true`.
3. `index.html`, `tresor.js`, `tests/` und `supabase/` gemeinsam hochladen
   (über einen frischen Clone, nie die echte Stammliste).
4. Tresor anlegen, Stammliste einspielen, der Vertretung das Tresor-Passwort
   persönlich geben.

> **Wichtig bei GitHub Pages:** Alle Seiten eines GitHub-Kontos liegen unter
> `deinname.github.io` und teilen sich damit denselben Browser-Speicher.
> Lege deshalb **keine weiteren GitHub-Pages-Seiten** unter demselben Konto an —
> oder nutze eine eigene Domain (Schritt 10). Sonst könnte eine andere Seite
> dieses Kontos den gemerkten Tresor-Schlüssel und die Anmeldesitzung
> mitbenutzen.

---

## Der Wochenablauf

| Wann | Was |
|------|-----|
| Montag bis Freitag 12:00 | Die Folgewoche kann eingetragen und beliebig oft geändert werden |
| Freitag 12:00 | Frist läuft ab. Danach nur noch Ansicht mit dem Hinweis „Frist vorbei" |
| Freitag nach 12:00 bis Sonntag | Nichts ist änderbar. Du berechnest die Planung (**Wochenplanung**, Schritte 1–4) und veröffentlichst sie |
| Montag | Die App schaltet automatisch auf die nächste Woche um |

Wochen werden **automatisch 4 Wochen im Voraus** aus den Standardzeiten angelegt
(täglich um 01:05 bzw. 02:05 Uhr deutscher Zeit, zusätzlich beim Öffnen des Admin-Bereichs).
Du musst nichts starten. So kannst du Feiertage oder abweichende Zeiten schon
Wochen vorher eintragen. Voraussetzung: Migration `0011_wochen_automatisch.sql`
wurde einmal im SQL Editor ausgeführt.

### Wochenplanung (Auto-Planung)

Das ist der Standardweg: sechs bis sieben Klicks, **kein Upload**.

1. Admin-Bereich öffnen. Auf der **Startseite** steht oben die Zeile **Woche**
   (die Auswahl gilt für alle Unterseiten), darunter **Nächster Schritt: …** mit
   einem Sprungknopf und die drei großen Knöpfe **Wochenplanung**,
   **Mitarbeiter** und **Mehr**, jeder mit einer Statuszeile. Status lesen.
2. **Wochenplanung** öffnen. Alle Daten laden automatisch. Die vier Schritte
   stehen untereinander auf einer Seite:
   - **1 · Abgaben** — „x von y haben abgegeben" und die Frist. Aufklappbar:
     **Wer fehlt** und **Alle Mitarbeiter**.
   - **2 · Planung berechnen** — die Profile kommen aus dem Tresor. Darunter
     steht der **Minijob-Stand** („Minijob-Stand vom TT.MM. (abgerechnet bis
     MM/JJJJ) · n Minijobber mit Wochen-Obergrenze“, siehe
     [Minijob-Grenze](#minijob-grenze-minijob-stand)) und, falls nötig, die Box
     **Laut Stammliste nicht (ganz) eingeplant** – je Person, die für Tage
     außerhalb ihres Einsatzzeitraums Verfügbarkeit abgegeben hat, z. B.
     „Einsatz laut Stammliste bis TT.MM. – danach nicht eingeplant (stimmt das
     nicht: Stammliste aktualisieren)“ bzw. „beginnt erst am TT.MM.“, und je
     Minijobber, dessen Vertrag laut Lohndaten schon beendet ist. Die
     Profiltabelle hat die Spalte **Minijob max/Wo**. **Bedarf
     anpassen** (Plätze je Tag und Schichtart) ist eingeklappt. Dann **Planung
     berechnen**. Ist der Tresor nicht offen oder fehlen Profile, rechnet die
     App nur mit dem Haken **Trotzdem ohne vollständige Profile rechnen** —
     Personen ohne Profil gelten dann als Minijob ohne Fahrgemeinschaft.
     Unter dem Ergebnis erscheint bei Bedarf die Box **Vor dem Veröffentlichen
     klären** (siehe unten).
   - **3 · Dispo-Datei für den Kunden** — die fertige `.xlsm` herunterladen.
     Fehlt die Dispo-Vorlage noch, kannst du sie hier einmalig auswählen.
   - **4 · Veröffentlichen** — Gibt es für die Woche schon eine veröffentlichte
     Planung, steht das hier mit „neu +x / entfernt −y". Haken **Ich habe die
     Planung für KW n geprüft …** setzen. Gibt es Punkte zum Klären, steht die
     Liste hier noch einmal, und zusätzlich ist der Haken **Ich habe die
     Betroffenen informiert** Pflicht. Liegt jemand von Hand über seiner
     Minijob-Grenze, ist zusätzlich der eigene Haken **Ich lasse die
     Überschreitung der Minijob-Grenze bewusst zu (…)** Pflicht. Dann
     **Planung KW n (k Schichten) für Mitarbeiter veröffentlichen**. Danach liest die App die Woche zurück:
     „x von y Schichten stimmen mit der Datenbank überein" muss erscheinen.
3. **← Start**. Fertig.

Ein berechneter, noch nicht veröffentlichter Entwurf geht beim Wochenwechsel
nie still verloren: Die App fragt nach und bietet **Zurück zu KW n** oder
**Entwurf verwerfen und KW m laden**.

Die Berechnung ist regelbasiert und läuft komplett im Browser (kein KI-Dienst,
nichts verlässt das Gerät). Sie folgt einer **festen Rangfolge**: Jede Stufe
geht allen folgenden vor.

1. **Harte Regeln** (werden nie gebrochen): nur eingesetzt, wer die Schicht
   abgegeben hat und an dem Tag laut Stammliste im Einsatz ist (Einsatz
   von/bis); mindestens 11 Stunden Ruhezeit; höchstens 10 Stunden am Tag
   und 48 Stunden pro Woche; Minijobber höchstens bis zu ihrer
   Wochen-Obergrenze aus dem Minijob-Stand (siehe unten).
2. **Alle Plätze besetzen.**
3. **Wunsch des Mitarbeiters einhalten:** die Höchstzahl an Schichten, die er
   selbst bei der Abgabe mit dem Regler angegeben hat. Darüber plant die App
   nur, wenn sonst ein Platz leer bliebe.
4. **Fahrgemeinschaften zusammen, wo beide können:** Haben beide dieselbe
   Schicht abgegeben, arbeiten sie dieselbe Schicht oder haben beide frei.
   Allein arbeiten ist in Ordnung, wenn der Partner diese Schicht nicht
   abgegeben hat oder dafür über seinen Wunsch bzw. über 48 Stunden käme.
   Getrennt wird nur, wenn sonst ein Platz leer bliebe oder jemand über seinen
   Wunsch käme. Lässt sich ein Platz nur durch Trennen **oder** durch eine
   Überschreitung besetzen, wird getrennt.
5. **Teilzeit zuerst**, dann Minijob. Weil die Fahrgemeinschaft vorgeht, kann
   eine Teilzeitkraft, die mit einem Minijobber fährt, weniger Stunden bekommen
   als ohne Fahrgemeinschaft.
6. **Gleichmäßig verteilen:** möglichst keine zwei Schichten am selben Tag und
   Früh und Spät in einer Woche nicht mischen.

Mehr Schichten als gewünscht oder eine getrennte Fahrgemeinschaft sind
**Hinweise**, keine Fehler. Gibt es solche Punkte, zeigt Schritt 2 die Box
**Vor dem Veröffentlichen klären** mit zwei Listen: **Mehr Schichten als
gewünscht** (Name, geplant/Wunsch, Platz) und **Fahrgemeinschaft getrennt**
(Namen, Tag, Schichten). Zu jedem Punkt steht der Grund, z. B. dass sonst ein
Platz leer bliebe, oder dass die Ausnahme vermeidbar wäre (etwa nach einer
Handänderung). Die Box rechnet
nach jeder Handänderung neu; im Auswahlfeld zur Handkorrektur sind solche
Kandidaten mit „(über Wunsch)" bzw. „(trennt Fahrgem.)" markiert. So kannst du
die Betroffenen vorher informieren. Veröffentlichen lässt sich erst mit dem
Haken **Ich habe die Betroffenen informiert** in Schritt 4.

Prüfe das Ergebnis trotzdem, bevor du es veröffentlichst.

### Minijob-Grenze (Minijob-Stand)

Die App sorgt dafür, dass Minijobber durch die Planung **nicht zu viel
verdienen**. Ob jemand genug Stunden bekommt, prüft sie nicht (das bleibt bei
dir).

**Minijob-Stand = Lohndaten-Spalten der Stammliste (monatlich, nach der
Lohnabrechnung).** Eine eigene Karte dafür gibt es nicht mehr: Das lokale
Hilfsskript trägt die Lohndaten in die Spalten H–M der Stammliste ein, und du
spielst die Stammliste wie gewohnt unter **Mitarbeiter › Stammliste einspielen**
ein (siehe [Erste Nutzung](#erste-nutzung-stammliste-hochladen)). Die Vorschau
zeigt dabei Minijobber mit Wochen-Obergrenze, ohne Abrechnung, mit 0 h,
„abgerechnet bis“ und die Abweichungen „laut Stammliste Minijob, laut
Abrechnung kein Minijob“; verliert jemand seine bisherige Grenze, gibt es eine
rote Warnung mit eigenem Pflicht-Haken. Der Tresor muss offen sein. Gespeichert
wird der Stand **verschlüsselt im Tresor** (Abschnitt `minijob`), und zwar nur
Personalnummer, Eintritt, „abgerechnet bis“, SV-Brutto, Stunden und das
Minijob-Merkmal — keine Namen und nur für Minijobber (Kategorie Minijob oder
leer). Jeder Upload mit Lohndaten-Spalten ersetzt den alten Stand vollständig;
eine Datei ohne diese Spalten lässt ihn unverändert.

**So entsteht die Wochen-Obergrenze** (Rechnung in `minijob.js`):
- Verträge laufen immer **9 Monate**: Befristungsende = Tag vor dem Eintritt
  plus 9 Monate, höchstens bis zum Monatsende (Eintritt 02.02.2026 → Ende
  01.11.2026). Vertragsende = das früheste von Befristungsende, „Einsatz bis“
  aus der Stammliste und (aus älteren Ständen) Austritt. „Einsatz bis“ allein
  zählt nie: Liegt es nach dem Befristungsende, gilt das Befristungsende.
- Erlaubt ist je Kalendermonat die Minijob-Grenze des Jahres (2025: 556 €,
  2026: 603 €, 2027: 633 €); angebrochene Monate **anteilig nach Tagen**.
- Es zählt nur der Verdienst seit dem **aktuellen** Eintritt. Restbudget =
  Grenze von Eintritt bis Befristungsende minus abgerechnetes SV-Brutto.
- Das Restbudget wird **gleichmäßig auf alle Tage** vom 1. des ersten noch
  nicht abgerechneten Monats bis zum Vertragsende verteilt. Gearbeitete,
  aber noch nicht abgerechnete Wochen verbrauchen damit rechnerisch ihren
  Anteil; geschätzt wird nichts.
- Die Planungswoche bekommt den Anteil ihrer Tage: Restbudget je Tag × Tage
  dieser Woche, die in den offenen Zeitraum fallen (endet der Vertrag am
  Mittwoch, zählen nur Montag bis Mittwoch). Endete der Vertrag schon vor dem
  Montag, ist die Grenze **0 h**; Schritt 2 nennt die Person („Minijob-Vertrag
  laut Lohndaten am TT.MM. beendet“).
- Euro je Woche → Stunden über den eigenen Stundensatz (SV-Brutto / Stunden),
  abgerundet auf ganze Minuten. Neue ohne abgerechneten Monat haben **keine**
  Grenze; ist das Budget aufgebraucht, ist die Grenze **0 h**.
- Teilzeitkräfte berührt das alles nicht; für sie gilt nur der
  Einsatzzeitraum (Einsatz von/bis).

**Harte Regel.** Der Solver plant nie über die Wochen-Obergrenze (wie bei
48 Stunden). Schritt 2 zeigt „Minijob-Stand vom … · n Minijobber mit
Wochen-Obergrenze“; ohne Stand steht dort „Kein Minijob-Stand –
Minijob-Grenze wird nicht geprüft“. Liegt „abgerechnet bis“ mehr als zwei
Monate vor dem Planungsmonat, warnt die Zeile „Minijob-Stand veraltet – bitte
die Stammliste aktualisieren und neu einspielen“. Ändert sich der Stand nach
dem Berechnen, muss neu berechnet werden, bevor veröffentlicht werden kann.
Minijobber mit aufgebrauchtem Budget stehen unter dem Ergebnis als Hinweis
„Minijob-Grenze erreicht – bis Vertragsende keine Schichten mehr“ (beendete
Verträge stehen schon in Schritt 2).

**Ausnahme nur von Hand.** Im Auswahlfeld sind Kandidaten, die dadurch über
ihre Grenze kämen, mit „(Minijob-Grenze)“ markiert. Wählst du so jemanden
trotzdem, zeigt die Box **Vor dem Veröffentlichen klären** den Abschnitt
**Minijob-Grenze von Hand überschritten** (Name, geplant, höchstens).
Veröffentlichen ist dann möglich, aber erst mit dem eigenen Haken **Ich lasse
die Überschreitung der Minijob-Grenze bewusst zu (…)** in Schritt 4.

Einspielen dieser Version: `minijob.js` gehört mit `index.html`, `tresor.js`
und `planung-solver.js` zusammen hochgeladen (keine Datenbank-Migration). Der
Tresor-Inhalt bleibt Version 1; ältere Tresore laden unverändert (ohne
Minijob-Stand bzw. ohne Einsatzzeitraum). Eine ältere `tresor.js` oder
`minijob.js` aus dem Browser-Cache erkennt die App und bittet um Neuladen
(Strg+F5).

Eine fertige Dispo von außen einlesen (**Mehr > Fertige Dispo einlesen**) ist
nur noch die Ausnahme, siehe
[Geplante Schichten](#geplante-schichten-dispo-einlesen).

**Frist ändern:** **Mehr > Zeiten und Frist** → Woche oben in der Zeile
**Woche** wählen → **Abgabefrist dieser Woche** → Zeitpunkt setzen →
**Speichern**. Die Angabe ist deutsche Zeit; Sommer- und Winterzeit werden
berücksichtigt.

**Schichtzeiten ändern.** Es gibt zwei Ebenen:
- **Zeiten dieser Woche** — gilt nur für die ausgewählte Woche. Dafür sind die
  schwankenden Startzeiten (04:15, 04:30, 16:30 …) gedacht.
- **Standardzeiten** — die Vorlage für Wochen, die **neu** angelegt werden.

Beim Anlegen einer Woche werden die Standardzeiten in die Woche **kopiert und
eingefroren**. Änderst du später die Standardzeiten, bleiben alte Wochen und
alte Exporte unverändert richtig. Weil die kommenden Wochen schon angelegt sind,
erscheint nach dem Speichern der Standardzeiten der Knopf **Auf die schon
angelegten kommenden Wochen übertragen** (gesperrte Tage und Abgaben bleiben
erhalten). Eine einzelne Woche ziehst du mit **Zeiten aus Standard neu laden** nach.

**Eine Schicht ganz abschalten:** **Mehr > Zeiten und Frist** → **Standardzeiten** → bei
der Schicht den Haken *„Schicht wird angeboten"* entfernen. Wirkt auf neue
Wochen. Für die laufende Woche stattdessen bei **Zeiten dieser Woche** das
Häkchen je Tag entfernen.

**Feiertag sperren:** **Mehr > Zeiten und Frist** → Woche → den Tag aufklappen →
**Tag sperren** anhaken, Grund eintragen (z. B. „Feiertag") → **Speichern**.
Der Tag erscheint dann ausgegraut und ist nicht wählbar.
**Achtung:** bereits eingetragene Verfügbarkeiten dieses Tages werden dabei
gelöscht.

**Abgabestatus:** **Wochenplanung**, Schritt **1 · Abgaben** zeigt „x von y
haben abgegeben" und die Frist. **Wer fehlt** listet die offenen Personen mit
Namen aus dem Tresor, **Alle Mitarbeiter** zeigt alle aktiven mit „✓ Zeitpunkt"
oder „✗ fehlt".

---

## Der Export (CSV)

**Mehr > Verfügbarkeiten exportieren (CSV)** → Woche oben in der Zeile
**Woche** wählen → **CSV herunterladen**. Den früheren JSON-Export gibt es seit
dem 12.11.2026 nicht mehr (er wurde nicht genutzt). Der
Export ist optional: Die Wochenplanung rechnet direkt in der App. Er ist für
eigene Auswertungen oder eine Planung außerhalb der App gedacht.

Dateiname: `verfuegbarkeit_2026-W40.csv`. Die Datei enthält Verfügbarkeiten je
Personalnummer – nach Gebrauch wieder löschen.

### CSV

UTF-8 mit BOM, **mit Semikolon getrennt** — öffnet in deutschem Excel direkt
richtig. **Eine Zeile je möglicher Schicht:**

| Spalte | Inhalt | Beispiel |
|--------|--------|----------|
| `kw` | Jahr und Kalenderwoche | `2026-W40` |
| `datum` | Tag der Schicht, ISO | `2026-09-28` |
| `wochentag` | ausgeschrieben | `Montag` |
| `personalnummer` | einzige Kennung | `10001` |
| `schicht_id` | `FRUEH`, `SPAET`, `LANG` oder `KEINE_ABGABE` | `LANG` |
| `schicht_name` | Klartext | `Lange Spätschicht` |
| `beginn` / `ende` | Uhrzeit dieser Woche | `16:00` / `22:30` |
| `dauer_h` | Stunden mit Komma | `6,5` |
| `max_schichten_woche` | eigener Wunsch aus der Abgabe (Regler), leer = keine Angabe | `4` |
| `hinweis` | immer leer (Feld stillgelegt; die Spalte bleibt nur für das Dateiformat) | |
| `abgegeben_am` | deutsche Zeit, sortierbar | `2026-09-25 18:12` |

Personalnummern **ohne** Abgabe stehen mit **einer** Zeile und
`schicht_id = KEINE_ABGABE` drin; die übrigen Felder sind leer.

### Wichtig für die Planung

- Die Angaben sind die **maximale** Verfügbarkeit, kein Wunschplan.
- Es wurde **nichts** gegen Arbeitszeitgesetz, Ruhezeiten oder Stundengrenzen
  geprüft. Das macht die Planung.
- **`LANG` enthält `SPAET`.** Wer für `LANG` verfügbar ist, hat immer auch eine
  `SPAET`-Zeile für denselben Tag. Zähle die Stunden nicht doppelt — in der App
  wird für so einen Tag korrekt 6,5 h angezeigt, nicht 10,5 h.
- Früh und Spät am selben Tag sind erlaubt und kommen vor.

---

## Sicherheit selbst nachprüfen

Im Ordner `supabase/tests/` liegt `rls_selbsttest.sql`. Damit prüfst du in der
echten Datenbank nach, dass die Schutzregeln greifen.

1. Vorher die Stammliste mit **mindestens zwei** Nummern hochladen.
2. Alle Migrationen bis einschließlich `0013_app_dateien_version.sql` müssen
   ausgeführt sein — der Tresor-Teil des Tests braucht die Spalte `version`.
3. **SQL Editor** → Inhalt von `rls_selbsttest.sql` einfügen → **Run**. Das legt
   die Testfunktion an (eine neue Fassung der Datei einfach erneut einfügen,
   sie ersetzt die alte).
4. Dann ausführen: `select * from public.rls_selbsttest();`

Es erscheint eine Tabelle. In der Spalte **`bestanden`** muss **überall `true`**
stehen. Geprüft wird unter anderem:

- Ein Mitarbeiter sieht nur seine eigene Zeile, keine fremden Verfügbarkeiten
  und keine fremden Abgaben.
- Er kann nichts auf eine fremde Personalnummer schreiben.
- Er kann keine fremde Nummer deaktivieren.
- **Nach der Abgabefrist** wird jedes Speichern abgewiesen — auch dann, wenn
  jemand die App umgeht und direkt mit der Datenbank spricht.
- Eine **deaktivierte** Nummer kann nichts mehr speichern.
- Der Passwort-Prüfwert ist nicht lesbar.
- Der **Stammlisten-Tresor** (Block 13d): Mitarbeitende können ihn weder lesen
  noch ändern, der Versionszähler zählt bei jedem Speichern hoch, und in der
  Datenbank liegt nur die verschlüsselte Hülle — keine Klarnamen.

Der Test setzt alles, was er anfasst, wieder zurück. Du kannst ihn jederzeit
wiederholen, auch im laufenden Betrieb.

**Tests auf dem eigenen Rechner** (Node.js ab Version 20, nur erfundene Daten,
keine Verbindung zur echten Datenbank):

- `node tests/tresor.test.js` — Verschlüsselung des Tresors (11 Tests, u. a.
  falsches Passwort, manipulierte Hülle, kein Passwort im Chiffrat).
- `node tests/syntax.test.js` — alle Skripte in `index.html` und die
  Modul-Dateien sind syntaktisch gültig. **Vor jedem Push ausführen.**
- `node tests/solver.test.js` — Wochenplanung mit den erfundenen Daten aus
  `tests/synthetisch.js`.
- `node tests/vorschau.js` — startet die App mit Fake-Backend unter
  `http://localhost:8765/index.html` (anderer Port: `node tests/vorschau.js 8766`)
  und meldet dich als Admin an. `?neu` an die Adresse anhängen setzt den
  Fake-Zustand zurück. Eine erfundene Stammliste liegt im Temp-Ordner; den Pfad
  zeigt die Konsole. Die Vorschau liest `index.html` bei jedem Aufruf frisch ein.

Später kannst du diese Funktion wieder entfernen:

```sql
drop function if exists public.rls_selbsttest();
```

---

## Wenn etwas nicht klappt

**„Personalnummer oder Passwort falsch" — obwohl beides stimmt**
Führende Null vergessen? `00345` ist nicht `345`. Sonst unter **Mitarbeiter >
Passwort zurücksetzen** ein neues Passwort setzen.

**„Dieser Zugang ist nicht mehr aktiv"**
Die Nummer steht nicht mehr in der Stammliste. Wieder aufnehmen und die Liste
erneut hochladen.

**Mitarbeitende sehen „Frist vorbei", obwohl noch Zeit ist**
**Mehr > Zeiten und Frist** → Woche oben wählen → **Abgabefrist dieser Woche**
prüfen. Steht dort ein Zeitpunkt in der Vergangenheit, neu setzen und speichern.

**Die Seite lädt, bleibt aber leer / Fehler beim Speichern**
Möglicherweise wurde das Supabase-Projekt pausiert (7 Tage ohne Aktivität). Im
Supabase-Dashboard nachsehen und **Restore** drücken. Danach Schritt 9 prüfen —
das Keep-alive soll genau das verhindern.

**Beim Stammlisten-Import: „Keine Admin-Berechtigung"**
Schritt 6 wurde nicht abgeschlossen. Die Kontrollabfrage dort muss deine
E-Mail zeigen.

**Beim Import eine CORS-Meldung**
Der Name der Edge Function stimmt nicht genau (`import-stammliste`,
`reset-passwort`), oder sie ist nicht veröffentlicht. Unter **Edge Functions**
nachsehen.

**„Die Datei hat weder eine Spalte "Passwort" noch eine Spalte "Name"."**
Die Überschriften stehen in Zeile 1 des ersten Tabellenblatts. Nötig sind
`Personalnummer` und mindestens eine der Spalten `Passwort` oder `Name`.

**„Tresor-Passwort falsch."**
Das Tresor-Passwort ist nicht dein Admin-Login-Passwort. Leerzeichen am Anfang
und Ende stören nicht; Groß- und Kleinschreibung muss stimmen. Hat die
Vertretung das Passwort geändert, gilt das neue.

**Tresor-Passwort vergessen**
**Mehr > Tresor > Passwort vergessen?** überschreibt den Tresor mit einem neuen
Passwort. Danach die Stammliste **ohne Passwortspalte** (mit den
Lohndaten-Spalten) einspielen. Zugänge bleiben, nur die gemerkten
Dispo-Schreibweisen gehen verloren.

**Beim Stammlisten-Import: „Zeile n, Spalte "…": "…" – kein gültiges Datum“ o. Ä.**
Eine gefüllte Zelle lässt sich nicht lesen (z. B. `31.02.2026` oder `11.11.26`).
Zeile und Spalte stehen in der Meldung; dort korrigieren (Datum `TT.MM.JJJJ`,
Monat `MM/JJJJ`, Betrag `2950,00`) und die Datei erneut wählen. Bis dahin
werden keine Namen, Profile oder Lohndaten gespeichert.

**„… auf einem anderen Gerät geändert. Bitte die Seite neu laden."**
Die Vertretung hat den Tresor inzwischen gespeichert. Seite neu laden, Tresor
öffnen, deine Änderung noch einmal machen. Es geht nichts verloren.

**„Merken ist in diesem Browser nicht möglich (privater Modus?)"**
Privates Fenster oder blockierter Seitenspeicher. Ein normales Fenster nutzen.
Sonst fragt die App nach jedem Neuladen das Tresor-Passwort ab — das ist
unschädlich.

**„… kennt die Spalte "version" noch nicht"**
Migration 0013 fehlt. `supabase/migrations/0013_app_dateien_version.sql` im
SQL Editor ausführen, dann die Seite neu laden.

**In der Wochenplanung fehlen die Namen (nur Personalnummern)**
Der Tresor ist auf diesem Gerät nicht offen: auf der Startseite das
Tresor-Passwort eingeben. Steht trotzdem „ohne Namen/Profil", fehlt die Person
im Tresor: unter **Mitarbeiter** die Stammliste einspielen (ohne Passwortspalte
genügt).

**Der Export ist leer**
Vermutlich die falsche Woche ausgewählt, oder es hat noch niemand abgegeben.
**Wochenplanung**, Schritt **1 · Abgaben** zeigt es.

---

## Datenschutz

Was hier umgesetzt ist:

- **Keine Klarnamen im Klartext in der Datenbank.** Einzige offene Kennung ist
  die Personalnummer. Namen und Planungsprofile liegen ausschließlich
  verschlüsselt im Tresor (AES-256-GCM; der Schlüssel entsteht nur aus dem
  Tresor-Passwort der Planer). Supabase sieht nur das Chiffrat.
- **Passwörter werden nie im Klartext gespeichert.** Supabase Auth speichert nur
  einen Hash. Zusätzlich liegt in der Datenbank ein nicht umkehrbarer Prüfwert,
  der für niemanden lesbar ist.
- **Daten in Frankfurt** (Region `eu-central-1`), mit abgeschlossenem DPA.
- **Kein Tracking**, keine Analyse-Cookies, keine externen Schriftarten, keine Drittanbieter-Skripte (alle Bibliotheken liegen im Ordner `vendor/`). Im
  Gerätespeicher liegen nur die technisch nötige Anmeldesitzung und — bei
  Admins mit dem Haken „Auf diesem Gerät merken" — der nicht exportierbare
  Tresor-Schlüssel (IndexedDB), der beim Abmelden gelöscht wird.
- **Zugriff ausschließlich auf eigene Daten**, serverseitig in der Datenbank
  erzwungen — nicht nur in der Webseite versteckt.
- Im Fuß der App öffnen Impressum und Datenschutz als Fenster (Text steht in `index.html`; Ergänzung zur
  ZiG-Website-Datenschutzerklärung).

Was du selbst beachten musst:

- **Die Excel mit den Passwörtern ist der empfindlichste Teil.** Sie liegt nur
  bei dir: nicht per E-Mail versenden, nicht in eine Cloud legen, möglichst mit
  Passwort schützen. Beim Import wird sie nur im Browser gelesen: Personalnummer
  und Passwort gehen an den Server (nur für die Zugänge, nicht gespeichert);
  Name und Profil werden im Browser verschlüsselt und nur als Chiffrat im Tresor
  abgelegt. Die Datei selbst wird **nirgends** gespeichert.
- Passwörter an die Mitarbeitenden möglichst persönlich oder auf Papier
  weitergeben, nicht in Chatgruppen. Das Tresor-Passwort nur persönlich an die
  Vertretung.
- Ergänzt euer Verzeichnis von Verarbeitungstätigkeiten um diese Anwendung
  (Zweck: Einsatzplanung; Daten: Personalnummer, Verfügbarkeitsangaben
  einschließlich der gewünschten Höchstzahl an Schichten, geplante Schichten
  sowie Name, Beschäftigungskategorie, Fahrgemeinschaft, Einsatzzeitraum
  (von/bis, für alle Mitarbeitenden) und — nur bei Minijobbern, zur Einhaltung
  der Verdienstgrenze — Eintrittsdatum, abgerechnetes SV-Brutto, abgerechnete
  Stunden und Minijob-Merkmal aus der Lohnabrechnung — diese verschlüsselt,
  Schlüssel nur bei ZiG; Empfänger: Supabase als Auftragsverarbeiter, GitHub
  für das Hosting der Webseite).
- **Lohndaten in der Stammliste:** Die Spalten H–M (vom lokalen Hilfsskript
  gefüllt) enthalten Lohndaten. Die Stammliste wird nur im Browser gelesen;
  gespeichert werden nur die genannten Felder, die Lohndaten nur für
  Minijobber, alles verschlüsselt im Tresor. Die Datei selbst nicht weitergeben
  und nicht in geteilte Ordner legen.
- **Löschfrist:** Die Datenschutzerklärung in der App nennt 12 Monate (Verfügbarkeiten:
  12 Monate nach Ende der Woche; deaktivierte Zugänge: 12 Monate nach Deaktivierung).
  Umgesetzt wird das mit `supabase/migrations/0004_loeschfrist.sql` (Funktion) und
  `supabase/migrations/0012_loeschfrist_cron.sql` (monatlicher Cron-Job am 1. um 03:00 UTC,
  Protokolltabelle `loeschlauf`). Beide einmal im SQL Editor ausführen. Ob gelöscht wurde,
  zeigt `select * from public.loeschlauf order by gelaufen_am desc;` (nur Anzahlen, keine
  Personendaten). Ändert ihr die Frist, den Text in `index.html` mit anpassen.
- **Auftragsverarbeitungsvertrag:** Das unterschriebene Supabase-DPA aus dem Dashboard
  in den eigenen Datenschutzunterlagen ablegen. Für GitHub (Hosting) ebenfalls einen
  Vertrag (DPA) in den GitHub-Einstellungen der Organisation bzw. des Kontos prüfen.
- Die Datenschutzerklärung in der App ist ein Entwurf und sollte von einem Anwalt oder
  Datenschutzbeauftragten geprüft werden. Falls es einen Betriebsrat gibt, ist er wegen
  § 87 BetrVG zu beteiligen.
- **Mit dieser Version geändert:** Der Datenschutztext in `index.html` nennt die
  verschlüsselte Speicherung von Name und Profil auf dem Server. Seit dem Solver-Umbau
  (11.11.2026) besteht das Profil nur noch aus Beschäftigungskategorie und
  Fahrgemeinschaft; „Schichtwünsche und -sperren" und die interne Notiz sind gestrichen
  (weniger Daten als vorher). Mit der Minijob-Grenze (Teil 4) nennt der Text zusätzlich
  die verschlüsselt gespeicherten Abrechnungsangaben der Minijobber (Ein-/Austritt,
  abgerechnetes Entgelt, Stunden, Minijob-Kennzeichen; mit jedem Monatsstand ersetzt).
  Seit Teil 5 (eine Stammliste für alles) kommt der **Einsatzzeitraum (von/bis) für alle
  Mitarbeitenden** dazu, ebenfalls nur verschlüsselt; er sorgt dafür, dass niemand
  außerhalb seines Einsatzes eingeplant wird. Die Lohndaten kommen jetzt mit der
  Stammliste statt aus einer eigenen Datei (gleiche Felder).
  **Stand 12.11.2026:** Der Text nennt jetzt zusätzlich den Datenschutzbeauftragten, die
  Freiwilligkeit der App (Abgabe weiter persönlich im Büro möglich), den Kunden als
  Empfänger des Einsatzplans, die Herkunft der Daten, die Entstehung der Planung, die
  Übermittlung der IP-Adresse an GitHub in die USA samt Grundlage und die automatische
  Abmeldung. Die Freigabe durch den Datenschutzbeauftragten steht noch aus.

---

## Geplante Schichten (Dispo einlesen)

Mitarbeitende sehen nach dem Login oben "Meine Planung" (ihre Schichten ab heute).
Im Normalfall kommt diese Planung aus der **Wochenplanung** (Schritt
**4 · Veröffentlichen**). Dieser Abschnitt beschreibt den **Ausnahmeweg**: Eine
fertige Dispo, die außerhalb der App geändert oder erstellt wurde, wird eingelesen.

1. Einmalig `supabase/migrations/0006_geplante_schichten.sql` im SQL Editor ausführen
   (legt die Tabelle `planung` und die Funktion `planung_ersetzen` an; erweitert die Löschfrist).
2. **Mehr > Fertige Dispo einlesen (Ausnahme)**: Es gibt nur ein Datei-Feld — die Dispo
   (`.xlsm`, Blatt "FedEx", eine Woche Mo–Fr) → "Planung prüfen". Eine zweite Stammliste ist
   nicht nötig: Die Namen kommen aus dem Tresor (er muss offen sein). Enthält die Dispo eine
   andere Woche als oben in der Zeile **Woche** gewählt, warnt die App.
3. Die Namen werden **im Browser** aus dem Tresor den Personalnummern zugeordnet. Sichere Treffer sind
   vorausgewählt, Vorschläge sind markiert, der Rest wird per Auswahlliste zugeordnet oder übersprungen.
   Bestätigte Schreibweisen merkt sich die App verschlüsselt im Tresor; sie gelten auf allen Geräten.
   (Die früheren Knöpfe „Zuordnungsliste sichern/laden" gibt es nicht mehr.)
4. "Planung übernehmen" ersetzt die Planung der Woche. Zum Server gehen nur Personalnummer,
   Datum, Schichtart (FRUEH/SPAET/LANG/BUERO) und Uhrzeiten, keine Namen.
5. Schichtart wird aus der Startzeit abgeleitet (vor 12 Uhr Früh, 12–17 Uhr Lang, danach Spät;
   "ZiG Office" = Büro). Die Spalte "Alternative" wird nicht importiert.

---

### Mitarbeiteransicht (Startseite, Wochenkalender)

- Nach dem Login gibt es zwei Wege: **"Meine Planung"** und **"Verfügbarkeit eintragen"**. Auf dem
  Planungs-Button steht schon die nächste Schicht ("Heute · Spät · 18:30–22:30").
- Die Planung zeigt einen **Wochenkalender Mo–Fr** mit Umschalter "Diese Woche | Nächste Woche".
  Schichtarten haben feste Farben und Symbole (Früh gelb/Sonne, Spät blau/Mond, Lang violett/Mond mit Pfeil);
  vier Reserve-Stile (Stern, Wolke, Dreieck, Raute) sind für spätere Schichtarten vorbereitet. Für eine
  neue Schichtart braucht es zusätzlich eine Anpassung der Datenbank (`planung.schicht_id`) und der Erkennung im Import.
- **Büro ("ZiG Office") wird nicht importiert** und nicht angezeigt.
- Unten steht "Stimmt etwas nicht? Bitte im Büro melden" mit der Büro-Telefonnummer als Link (Tippen startet den Anruf).

### Planung absichern (Migration 0007)

Grundsatz: **kein stiller Fehler.** Vor dem Übernehmen muss alles Unklare geklärt sein.

- Zusätzlich `supabase/migrations/0007_planung_absicherung.sql` im SQL Editor ausführen
  (strenge `planung_ersetzen`, Tabellen `planung_historie` und `planung_stand`).
- **Fehler** (z. B. Datum fehlt oder ist Text, Position doppelt, keine fünf Tage Mo–Fr) blockieren
  die Übernahme. **Warnungen** (unbekannte Position, Name ohne Zeit, Doppelbuchung, Woche weit von
  heute) müssen gelesen werden.
- Nur **eindeutige** Namenstreffer und früher bestätigte Schreibweisen sind vorausgewählt.
  Alles andere steht auf "KLÄREN" und muss zugeordnet oder ausdrücklich übersprungen werden.
  Namen ohne App-Zugang (neue Mitarbeitende) stehen als "Nicht in der App" in der Liste.
- Übernehmen erst nach Bestätigung der Woche (und, falls Personen übersprungen wurden, dieser Personen).
- Nach dem Speichern liest die App die Woche zurück: **"✓ n von n"** muss erscheinen.
  Die Kontrollliste (Name, Personalnummer, Schichten) dient zum Gegenlesen gegen die Excel.
- Die alte Planung einer Woche wird vor dem Ersetzen in `planung_historie` gesichert.
- Mitarbeitende sehen "Stand: Datum, Uhrzeit" je Woche; ein Ladefehler wird als Fehler angezeigt,
  nie als "keine Schicht".

**Checkliste für jede Woche:**
1. Neue Mitarbeitende zuerst in die Stammliste aufnehmen und unter **Mitarbeiter** einspielen
   (Zugang und Name im Tresor).
2. **Wochenplanung**: Abgaben prüfen, Planung berechnen, Ergebnis gegenlesen, Dispo-Datei
   herunterladen und an den Kunden geben.
3. **4 · Veröffentlichen**: Haken setzen, veröffentlichen, auf die Gegenprobe „x von y Schichten
   stimmen mit der Datenbank überein" warten.
4. Nur im Ausnahmefall (Dispo außerhalb der App geändert): **Mehr > Fertige Dispo einlesen**,
   alle Warnungen und "KLÄREN"-Zeilen abarbeiten, niemanden überspringen, der arbeiten soll,
   Woche bestätigen, auf "✓ n von n" warten, 3–5 Personen aus der Kontrollliste gegen die
   Excel gegenlesen.
5. Personen aus "Nicht in der App" persönlich informieren. In der Dispo möglichst die
   Schreibweise der Stammliste verwenden.

---

## Was die App bewusst nicht kann

Diese Punkte sind **kein Teil** dieses Projekts — die Struktur ist aber so
gebaut, dass sie später ergänzt werden können:

- KI-Planung oder Anbindung externer Dienste: Die Wochenplanung rechnet
  regelbasiert im Browser, nichts verlässt das Gerät
- Krankmeldung über die App
- weitere Sprachen (alle Texte liegen dafür gesammelt im Objekt `TEXTE`
  in `index.html`)

---

## Dateien in diesem Ordner

```
index.html                                   die komplette App (Mitarbeiter + Admin)
tresor.js                                    Verschlüsselung des Stammlisten-Tresors (lädt nur im Admin-Bereich)
planung-solver.js                            regelbasierte Wochenplanung (lädt nur im Admin-Bereich)
minijob.js                                   Wochen-Obergrenzen der Minijobber berechnen (lädt nur im Admin-Bereich)
dispo-export.js                              füllt die Dispo-Vorlage (.xlsm) für den Kunden (lädt nur im Admin-Bereich)
beispiel_stammliste.xlsx                     Beispiel für die kurze Form (nur Personalnummer und Passwort)
README.md                                    diese Anleitung
vendor/                                      lokale Kopien von supabase-js, SheetJS und JSZip

supabase/migrations/0001_init.sql             Tabellen, Hilfsfunktionen, Trigger
supabase/migrations/0002_rls.sql              Schutzregeln, Rechte, RPC-Funktionen
supabase/migrations/0003_standard_schichten.sql   Standard-Schichten, erste Woche
supabase/migrations/0004_loeschfrist.sql          Löschfrist: Funktion (siehe Datenschutz)
supabase/migrations/0005_passwort_aendern.sql     eigenes Passwort nach dem Startpasswort
supabase/migrations/0006_geplante_schichten.sql   geplante Schichten: Tabelle planung, RPC planung_ersetzen
supabase/migrations/0007_planung_absicherung.sql  strenge planung_ersetzen, planung_historie, planung_stand
supabase/migrations/0008_app_einstellungen.sql    Schlüssel/Wert-Tabelle für Angaben außerhalb des Repos (z. B. Kontakt-Handy)
supabase/migrations/0009_app_dateien.sql          private Ablage für die Dispo-Vorlage (nur Admins)
supabase/migrations/0010_keepalive_schreiben.sql  Keep-alive schreibt in die Datenbank
supabase/migrations/0011_wochen_automatisch.sql   Wochen 4 Wochen im Voraus anlegen (Cron)
supabase/migrations/0012_loeschfrist_cron.sql     Löschfrist: monatlicher Cron-Job + Protokoll
supabase/migrations/0013_app_dateien_version.sql  Versionszähler und Größenschranke für app_dateien (Tresor)
supabase/migrations/0014_sicherheit_haertung.sql  Härtung: Freitextfeld stillgelegt, Hilfsfunktionen nur mit Anmeldung, Sitzungen beenden, Löschlauf holt nach

supabase/functions/import-stammliste/index.ts     Stammliste einlesen (Server)
supabase/functions/reset-passwort/index.ts        Einzelpasswort setzen (Server)
supabase/functions/passwort-setzen/index.ts       eigenes Passwort festlegen (Server)

supabase/tests/rls_selbsttest.sql             Sicherheitsregeln nachprüfen (inkl. Tresor, Block 13d)

tests/tresor.test.js                          Verschlüsselung prüfen (node tests/tresor.test.js)
tests/syntax.test.js                          alle Skripte auf Syntaxfehler prüfen (vor jedem Push)
tests/solver.test.js                          Wochenplanung mit erfundenen Daten
tests/minijob.test.js                         Minijob-Grenze mit erfundenen Daten
tests/dispo-export.test.js                    Dispo-Export (wird übersprungen, wenn keine Vorlage lokal liegt)
tests/synthetisch.js                          erfundene Daten für Tests und Vorschau (keine echten Personen)
tests/stamm_synthetisch.xlsx                  erfundene Stammliste im vollständigen Format (Spalten A–M)
tests/vorschau.js                             App lokal mit Fake-Backend starten

.github/workflows/keepalive.yml               hält das Supabase-Projekt wach
```

### Technischer Kurzüberblick

- **Frontend:** eine HTML-Datei plus vier kleine Modul-Dateien (`tresor.js`,
  `planung-solver.js`, `dispo-export.js`, `minijob.js`), kein Bauprozess, gehostet auf GitHub
  Pages. Bibliotheken liegen lokal im Ordner `vendor/` (kein CDN, keine IP-Weitergabe an
  Dritte): `supabase-js 2.45.4`, `SheetJS 0.20.3` und `JSZip 3.10.1`. SheetJS, JSZip
  und die vier Module werden erst geladen, wenn sie im Admin-Bereich wirklich
  gebraucht werden — Mitarbeitende am Handy laden sie nie. Verschlüsselung und
  Geräteschlüssel nutzen WebCrypto und IndexedDB: beides browser-nativ, kein CDN.
- **Admin-Bereich:** Startseite mit globaler Wochenzeile und drei Knöpfen
  (**Wochenplanung**, **Mitarbeiter**, **Mehr**) statt Reiter; zurück immer über
  **← Start** bzw. **← Mehr**.
- **Backend:** Supabase (PostgreSQL). Schutz ausschließlich über Row Level
  Security. Im Browser stecken nur Projekt-URL und anon-Key.
- **Tabellen:** `employees`, `admins`, `shift_types`, `shift_templates`,
  `weeks`, `week_days`, `week_shifts`, `submissions`, `availability`,
  `planung`, `planung_historie`, `planung_stand`, `app_einstellungen`,
  `app_dateien` (Schlüssel `dispo_vorlage` und `stammliste_tresor`), `loeschlauf`.
- **Speichern** läuft über die Datenbankfunktion `abgabe_speichern` — in einer
  Transaktion, also entweder ganz oder gar nicht, und mit Fristprüfung im Server.
