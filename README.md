# Verfügbarkeit FedEx-Schichten (ZiG)

Eine kleine Web-App, in der Mitarbeitende der **Zeit ist Geld GmbH** für die
**Folgewoche** eintragen, welche FedEx-Schichten sie **maximal** übernehmen könnten.

Die App plant **nicht**. Sie sammelt nur ein. Am Ende lädst du die Angaben als
CSV oder JSON herunter und gibst diese Datei an die Planungs-KI weiter.

---

## Inhalt

- [Wie es für die Mitarbeitenden aussieht](#wie-es-für-die-mitarbeitenden-aussieht)
- [Was du brauchst](#was-du-brauchst)
- [Einrichtung in 10 Schritten](#einrichtung-in-10-schritten)
- [Erste Nutzung: Stammliste hochladen](#erste-nutzung-stammliste-hochladen)
- [Der Wochenablauf](#der-wochenablauf)
- [Der Export für die Planungs-KI](#der-export-für-die-planungs-ki)
- [Sicherheit selbst nachprüfen](#sicherheit-selbst-nachprüfen)
- [Wenn etwas nicht klappt](#wenn-etwas-nicht-klappt)
- [Datenschutz](#datenschutz)
- [Was die App bewusst nicht kann](#was-die-app-bewusst-nicht-kann)
- [Dateien in diesem Ordner](#dateien-in-diesem-ordner)

---

## Wie es für die Mitarbeitenden aussieht

1. Link öffnen (am Handy).
2. Personalnummer und Passwort eingeben. Das Gerät bleibt angemeldet.
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

### Schritt 2 — Auftragsverarbeitungsvertrag (DPA) abschließen

Supabase verarbeitet für euch personenbezogene Daten. Dafür braucht ihr nach
Art. 28 DSGVO einen Auftragsverarbeitungsvertrag. Den kannst du im Dashboard
selbst abschließen:

1. Links unten auf das Organisations-Symbol → **Organization Settings**
   (oder direkt <https://supabase.com/dashboard/org/_/documents>).
2. Den Punkt **Legal Documents** bzw. **Documents** öffnen.
3. Beim **Data Processing Addendum (DPA)** auf **Request** / **Accept** klicken
   und die Firmendaten der ZiG eintragen.
4. Das bestätigte Dokument herunterladen und zu euren Datenschutzunterlagen legen.

> Findest du den Punkt nicht, suche im Dashboard nach „DPA". Supabase ändert die
> Menüführung gelegentlich. Der Vertrag lässt sich auch nachträglich abschließen,
> aber **bevor** echte Personalnummern eingetragen werden.

### Schritt 3 — Datenbank einrichten (3 Dateien)

Im Supabase-Dashboard links auf **SQL Editor** → **New query**.

Jetzt **eine nach der anderen**, jeweils komplett einfügen und auf **Run**
drücken:

1. `supabase/migrations/0001_init.sql` — legt die Tabellen an
2. `supabase/migrations/0002_rls.sql` — legt die Schutzregeln an
3. `supabase/migrations/0003_standard_schichten.sql` — legt die Schichten an

Die Reihenfolge ist wichtig. Nach Datei 3 sollte unten eine Tabelle mit
15 Zeilen erscheinen (3 Schichten × 5 Tage) — das ist die Kontrollabfrage.

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

### Schritt 5 — Die zwei Server-Funktionen einspielen

Diese zwei Funktionen legen Zugänge an und setzen Passwörter. Sie laufen auf
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

Die Namen müssen genau so geschrieben sein, sonst findet die App sie nicht.

> **Wichtig nach jedem Neu-Veröffentlichen einer Funktion:** In den
> Einstellungen der Funktion muss **Verify JWT with legacy secret** auf **AUS**
> stehen. Dieses Projekt signiert Anmelde-Tokens mit einem modernen
> ECC-Schlüssel; die alte Prüfung würde solche Tokens ablehnen, und der Import
> bräche mit einem 401-Fehler ab. Geschützt sind die Funktionen trotzdem: sie
> prüfen bei jedem Aufruf selbst, ob ein angemeldeter Admin dahintersteckt.
> Beim ersten Veröffentlichen steht der Schalter auf AN — also nach dem Deploy
> einmal nachsehen.

> **Optional, etwas sicherer:** Unter **Edge Functions → Secrets** kannst du
> `ERLAUBTE_ORIGIN` auf die Adresse deiner Seite setzen
> (z. B. `https://deinname.github.io`). Dann nehmen die Funktionen nur noch
> Anfragen von dieser Seite an. Ohne diese Einstellung sind sie trotzdem
> geschützt: sie prüfen bei jedem Aufruf, ob ein Admin angemeldet ist.

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
3. Den **kompletten Inhalt dieses Ordners** ins Browserfenster ziehen:
   `index.html`, den Ordner `supabase`, den Ordner `.github`, `README.md`,
   `beispiel_stammliste.xlsx`. Dann **Commit changes**.
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

Die Datei braucht **genau zwei Spalten** mit diesen Überschriften in Zeile 1:

| Personalnummer | Passwort  |
|----------------|-----------|
| 10001          | BEISPIEL-Passwort1 |
| 10002          | BEISPIEL-Passwort2 |
| 00345          | BEISPIEL-Passwort3 |

`beispiel_stammliste.xlsx` in diesem Ordner zeigt das Format. `.xlsx` und `.csv`
funktionieren beide.

**Regeln:**
- Passwörter mindestens **6 Zeichen**.
- Personalnummern dürfen Ziffern, Buchstaben, Punkt, Bindestrich und
  Unterstrich enthalten, höchstens 20 Zeichen. **Führende Nullen bleiben
  erhalten** — formatiere die Spalte in Excel als *Text*.
- Keine Namen, keine Geburtsdaten, keine weiteren Spalten.

**So läuft der Import:**
1. Auf der Seite unten **Admin-Anmeldung** → mit E-Mail und Passwort anmelden.
2. Reiter **Stammliste** → Datei auswählen → **Vorschau prüfen**.
3. Es erscheint z. B. *„3 neu · 0 geändert · 0 deaktiviert"*. Die Listen darunter
   lassen sich aufklappen. **Bis hierhin ist nichts verändert.**
4. Stimmt es, auf **Jetzt übernehmen**.

**Was der Import macht:**
- Nummern, die es noch nicht gibt → **neuer Zugang**
- Nummern mit **geändertem** Passwort → Passwort wird ersetzt
- Nummern, die **nicht mehr** in der Liste stehen → **deaktiviert**, nicht
  gelöscht. Die Person kann sich nicht mehr anmelden, bisherige Angaben bleiben
  für den Export erhalten.
- Nummern, die wieder auftauchen → werden wieder aktiviert

Du kannst die Liste jederzeit erneut hochladen. Sie ist die maßgebliche Quelle.

> **Woher weiß die App, ob ein Passwort geändert wurde, ohne es zu speichern?**
> Sie speichert nur einen nicht umkehrbaren Prüfwert (SHA-256 mit geheimem
> Zusatz). Daraus lässt sich kein Passwort zurückrechnen, und **niemand** kann
> diese Spalte lesen — auch kein Admin. Nur die Server-Funktion kommt daran.

**Einzelnes Passwort zurücksetzen:** Reiter **Passwort** → Personalnummer und
neues Passwort eintragen → **Passwort setzen**. Mitarbeitende können das
**nicht** selbst; sie müssen sich bei dir melden.

---

## Der Wochenablauf

| Wann | Was |
|------|-----|
| Montag bis Freitag 12:00 | Die Folgewoche kann eingetragen und beliebig oft geändert werden |
| Freitag 12:00 | Frist läuft ab. Danach nur noch Ansicht mit dem Hinweis „Frist vorbei" |
| Freitag nach 12:00 bis Sonntag | Nichts ist änderbar. Du exportierst und planst |
| Montag | Die App schaltet automatisch auf die nächste Woche um |

Die Woche wird beim ersten Öffnen automatisch angelegt. Du musst nichts starten.

**Frist ändern:** Reiter **Zeiten** → Woche wählen → **Abgabefrist dieser Woche**
→ Zeitpunkt setzen → **Speichern**. Die Angabe ist deutsche Zeit; Sommer- und
Winterzeit werden berücksichtigt.

**Schichtzeiten ändern.** Es gibt zwei Ebenen:
- **Zeiten dieser Woche** — gilt nur für die ausgewählte Woche. Dafür sind die
  schwankenden Startzeiten (04:15, 04:30, 16:30 …) gedacht.
- **Standardzeiten** — die Vorlage für Wochen, die **neu** angelegt werden.

Beim Anlegen einer Woche werden die Standardzeiten in die Woche **kopiert und
eingefroren**. Änderst du später die Standardzeiten, bleiben alte Wochen und
alte Exporte unverändert richtig. Willst du eine bestehende Woche doch
nachziehen: **Zeiten aus Standard neu laden**.

**Eine Schicht ganz abschalten:** Reiter **Zeiten** → **Standardzeiten** → bei
der Schicht den Haken *„Schicht wird angeboten"* entfernen. Wirkt auf neue
Wochen. Für die laufende Woche stattdessen bei **Zeiten dieser Woche** das
Häkchen je Tag entfernen.

**Feiertag sperren:** Reiter **Zeiten** → Woche → den Tag aufklappen →
**Tag sperren** anhaken, Grund eintragen (z. B. „Feiertag") → **Speichern**.
Der Tag erscheint dann ausgegraut und ist nicht wählbar.
**Achtung:** bereits eingetragene Verfügbarkeiten dieses Tages werden dabei
gelöscht.

**Abgabestatus:** Reiter **Abgaben** zeigt alle aktiven Personalnummern mit
„✓ Zeitpunkt" oder „✗ fehlt" und oben die Zahl „x von y haben abgegeben".

---

## Der Export für die Planungs-KI

Reiter **Export** → Woche wählen → **CSV herunterladen** oder
**JSON herunterladen**.

Dateiname: `verfuegbarkeit_2026-W40.csv` bzw. `.json`

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
| `max_schichten_woche` | Wunschgrenze, leer = keine | `4` |
| `hinweis` | Freitext, max. 200 Zeichen | |
| `abgegeben_am` | deutsche Zeit, sortierbar | `2026-09-25 18:12` |

Personalnummern **ohne** Abgabe stehen mit **einer** Zeile und
`schicht_id = KEINE_ABGABE` drin; die übrigen Felder sind leer.

### JSON

Enthält dasselbe, nur strukturiert:

- **`meta`** — Kalenderwoche, Zeitraum, Exportzeitpunkt und der Hinweistext:
  *„Angaben sind maximale Verfügbarkeit, ungeprüft gegen Arbeitszeitrecht.
  Eine Verfügbarkeit für LANG schließt SPAET ein."*
- **`tage`** — die fünf Tage, inklusive `gesperrt` und `grund`
- **`schichten`** — alle Schichten der Woche mit Datum, Beginn, Ende, Dauer
- **`mitarbeiter`** — je Personalnummer: `abgegeben`, `abgegeben_am`,
  `max_schichten_woche`, `hinweis` und `verfuegbar` als Liste von
  `{datum, schicht_id}`

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
2. **SQL Editor** → Inhalt von `rls_selbsttest.sql` einfügen → **Run**.

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

Der Test setzt alles, was er anfasst, wieder zurück. Du kannst ihn jederzeit
wiederholen, auch im laufenden Betrieb.

Später kannst du diese Funktion wieder entfernen:

```sql
drop function if exists public.rls_selbsttest();
```

---

## Wenn etwas nicht klappt

**„Personalnummer oder Passwort falsch" — obwohl beides stimmt**
Führende Null vergessen? `00345` ist nicht `345`. Sonst im Reiter **Passwort**
ein neues Passwort setzen.

**„Dieser Zugang ist nicht mehr aktiv"**
Die Nummer steht nicht mehr in der Stammliste. Wieder aufnehmen und die Liste
erneut hochladen.

**Mitarbeitende sehen „Frist vorbei", obwohl noch Zeit ist**
Reiter **Zeiten** → Woche → **Abgabefrist dieser Woche** prüfen. Steht dort ein
Zeitpunkt in der Vergangenheit, neu setzen und speichern.

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

**Die Datei wird nicht gelesen („zwei Spalten … vorhanden")**
Die Überschriften in Zeile 1 müssen `Personalnummer` und `Passwort` heißen, und
es muss das erste Tabellenblatt sein.

**Der Export ist leer**
Vermutlich die falsche Woche ausgewählt, oder es hat noch niemand abgegeben.
Der Reiter **Abgaben** zeigt es.

---

## Datenschutz

Was hier umgesetzt ist:

- **Keine Klarnamen in der Datenbank.** Einzige Kennung ist die
  Personalnummer. Die Zuordnung Personalnummer → Name führst du ausschließlich
  lokal in deiner Excel.
- **Passwörter werden nie im Klartext gespeichert.** Supabase Auth speichert nur
  einen Hash. Zusätzlich liegt in der Datenbank ein nicht umkehrbarer Prüfwert,
  der für niemanden lesbar ist.
- **Daten in Frankfurt** (Region `eu-central-1`), mit abgeschlossenem DPA.
- **Kein Tracking**, keine Analyse-Cookies, keine externen Schriftarten, keine Drittanbieter-Skripte (alle Bibliotheken liegen im Ordner `vendor/`). Nur die
  technisch nötige Anmeldesitzung im Gerätespeicher.
- **Zugriff ausschließlich auf eigene Daten**, serverseitig in der Datenbank
  erzwungen — nicht nur in der Webseite versteckt.
- Im Fuß der App öffnen Impressum und Datenschutz als Fenster (Text steht in `index.html`; Ergänzung zur
  ZiG-Website-Datenschutzerklärung).

Was du selbst beachten musst:

- **Die Excel mit den Passwörtern ist der empfindlichste Teil.** Sie liegt nur
  bei dir: nicht per E-Mail versenden, nicht in eine Cloud legen, möglichst mit
  Passwort schützen. Beim Import wird sie nur im Browser gelesen und an den
  Server geschickt — sie wird **nicht** gespeichert.
- Passwörter an die Mitarbeitenden möglichst persönlich oder auf Papier
  weitergeben, nicht in Chatgruppen.
- Ergänzt euer Verzeichnis von Verarbeitungstätigkeiten um diese Anwendung
  (Zweck: Einsatzplanung; Daten: Personalnummer, Verfügbarkeitsangaben;
  Empfänger: Supabase als Auftragsverarbeiter, GitHub für das Hosting der
  Webseite).
- **Löschfrist:** Die Datenschutzerklärung in der App nennt 12 Monate (Verfügbarkeiten:
  12 Monate nach Ende der Woche; deaktivierte Zugänge: 12 Monate nach Deaktivierung).
  Umgesetzt wird das mit `supabase/migrations/0004_loeschfrist.sql`. Einmal im SQL Editor
  ausführen, danach entweder monatlich von Hand `select public.loeschfrist_anwenden();` oder
  per pg_cron automatisieren (Anleitung am Ende der Datei). Ändert ihr die Frist, den Text in
  `index.html` mit anpassen.
- **Auftragsverarbeitungsvertrag:** Das unterschriebene Supabase-DPA aus dem Dashboard
  in den eigenen Datenschutzunterlagen ablegen. Für GitHub (Hosting) ebenfalls einen
  Vertrag (DPA) in den GitHub-Einstellungen der Organisation bzw. des Kontos prüfen.
- Die Datenschutzerklärung in der App ist ein Entwurf und sollte von einem Anwalt oder
  Datenschutzbeauftragten geprüft werden. Falls es einen Betriebsrat gibt, ist er wegen
  § 87 BetrVG zu beteiligen.

---

## Was die App bewusst nicht kann

Diese Punkte sind **kein Teil** dieses Projekts — die Struktur ist aber so
gebaut, dass sie später ergänzt werden können:

- automatische Schichtplanung (macht die nachgelagerte KI)
- Krankmeldung über die App
- Anzeige der eigenen **geplanten** Schichten für Mitarbeitende
- weitere Sprachen (alle Texte liegen dafür gesammelt im Objekt `TEXTE`
  in `index.html`)

---

## Dateien in diesem Ordner

```
index.html                                   die komplette App (Mitarbeiter + Admin)
beispiel_stammliste.xlsx                     Beispiel für das Datei-Format
README.md                                    diese Anleitung

supabase/migrations/0001_init.sql             Tabellen, Hilfsfunktionen, Trigger
supabase/migrations/0002_rls.sql              Schutzregeln, Rechte, RPC-Funktionen
supabase/migrations/0003_standard_schichten.sql   Standard-Schichten, erste Woche
supabase/migrations/0004_loeschfrist.sql          Löschfrist (optional, siehe Datenschutz)
vendor/                                       lokale Kopien von supabase-js und SheetJS

supabase/functions/import-stammliste/index.ts     Stammliste einlesen (Server)
supabase/functions/reset-passwort/index.ts        Einzelpasswort setzen (Server)

supabase/tests/rls_selbsttest.sql             Sicherheitsregeln nachprüfen

.github/workflows/keepalive.yml               hält das Supabase-Projekt wach
```

### Technischer Kurzüberblick

- **Frontend:** eine einzige HTML-Datei, kein Bauprozess, gehostet auf GitHub
  Pages. Bibliotheken liegen lokal im Ordner `vendor/` (kein CDN, keine IP-Weitergabe an
  Dritte): `supabase-js 2.45.4` und `SheetJS 0.20.3` (letzteres wird erst geladen, wenn
  im Admin-Bereich wirklich eine Datei geöffnet wird — Mitarbeitende am Handy
  laden es nie).
- **Backend:** Supabase (PostgreSQL). Schutz ausschließlich über Row Level
  Security. Im Browser stecken nur Projekt-URL und anon-Key.
- **Tabellen:** `employees`, `admins`, `shift_types`, `shift_templates`,
  `weeks`, `week_days`, `week_shifts`, `submissions`, `availability`.
- **Speichern** läuft über die Datenbankfunktion `abgabe_speichern` — in einer
  Transaktion, also entweder ganz oder gar nicht, und mit Fristprüfung im Server.
