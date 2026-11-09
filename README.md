# zamaric-toolchain

Werkzeuge, die nur intern genutzt werden: das Upload-Tool, über das der Geschäftspartner Songs nach Supabase lädt, und die Entwicklerseite nur für Phil, dazu ihr gemeinsamer Python-Code. Beide laufen als eigene Docker-Stacks auf dem Raspberry Pi.

Verwandte Repos:
- `zamaric`: die Flutter-App für Bläserensembles (Noten, Playbacks, Probenbuchstaben, Einzähler)
- `zamaric-database`: Supabase (Migrationen, Schema, SQL-Funktionen wie `import_song` und `update_song`), das alte Backend (Legacy) und die lokalen Song-Ordner

---

## Inhalt

1. [TODO](#todo)
2. [Aufbau](#aufbau)
3. [Upload-Tool](#upload-tool)
4. [Entwicklerseite](#entwicklerseite)

---

## TODO

### Backend

- Vielleicht _ in Dateinamen durch / ersetzen? Vielleicht aber auch App Seitig umsetzen
- Upload-Tool alle paar Monate aktualisieren: Versionen in `upload/api/Dockerfile` (Python), `upload/website/Dockerfile` (nginx), `upload/api/requirements.txt` und beim NetBird-Image in `upload/docker-compose.yml` anheben, dann auf dem Pi im Ordner `upload` `docker compose up -d --build`

### Tests

- Entwicklerseite, Board (pytest mit FastAPI-TestClient gegen echte SQLite in `tmp_path`): Verschieben nummeriert lückenlos neu (Index 0, über der Länge, in andere Spalte, unbekannte ID → `404 not_found`), Verschieben ändert `updated_at` nicht, Farbe/Titel/Text schon; PATCH ohne `color` behält die Farbe; Spalte löschen löscht ihre Karten; gelöschte höchste ID wird nicht neu vergeben (`autoincrement`); NUL/Steuerzeichen und IDs über 2⁶³ − 1 → `422`; `user_version` = 1, zu neue Datei wird nicht beschrieben; `backup_once()` legt eine Sicherung pro Tag an (Datum Berlin, stündliche Prüfung auch über die Zeitumstellung), räumt `.part`-Reste auf und behält nur 14
- Entwicklerseite, Python mit pytest: `repo.py` `parse_commits` (Body mit Leerzeilen, Merge-Commit ohne numstat, Umbenennung), `summarize_history` (Typ aus dem Präfix), `week_list` (52 bzw. 12 Wochen lückenlos, Wochenstart Montag in Berlin, Wochenwechsel ohne neuen Commit); `overview.py` (Teilfehler, Zeitlimit, `down_since`, Supabase beim Token-Erneuern weg → nur Supabase-Teile mit Fehler), `language_of`, `parse_batch`; `monitor.py` Ringpuffer (höchstens 1440 Einträge, Ausfall mit `ms` = null)
- Entwicklerseite, Website: Rauchtest im Demo-Modus (`?demo`) mit jsdom: jede Route rendert, Board-Aktionen spiegeln sich im Demo-Speicher, HTML in Commit-Texten/Karten/README landet nicht als Element im DOM

---

## Aufbau

```
zamaric-toolchain/
├── upload/                   Upload-Tool (Website, Container, siehe unten)
├── dev/                      Entwicklerseite (Website, Container, siehe unten)
└── shared/                   gemeinsamer Python-Code für Login, Sessions, Fehler, Prüfsummen,
                              eingebunden über additional_contexts in den docker-compose-Dateien
```

---

## Upload-Tool

Über das Upload-Tool lädt der Geschäftspartner Songs nach Supabase. Er wählt einen Song-Ordner, die Website prüft ihn, er bestätigt Warnungen und Zuordnungen, dann wird hochgeladen. Gibt es den Song in der Kategorie schon, aktualisiert derselbe Ablauf ihn (siehe [Song aktualisieren](#song-aktualisieren)). Löschen kann das Tool nichts, außer Dateien im Bucket, auf die keine Zeile mehr zeigt.

### Aufbau

```
Browser (Partner)
  │  nur Session-Cookie, nie den Supabase-Token
  │  prüft den Song-Ordner selbst (Prüfregeln unten)
  ▼
Container 1: website            (nginx, Website in static/)
  GET  /                        statische Website
  /api/*                        leitet unverändert an Container 2 weiter
  │  internes Docker-Netz
  ▼
Container 2: api                (Python)
  POST /api/login               Passwort → Supabase, Token bleibt in Python
  POST /api/logout
  GET  /api/reference           Nachschlagedaten für die Prüfung
  GET  /api/songs/{id}          sichtbarer Stand eines Songs zum Vergleichen
  POST /api/upload              Dateien → Buckets, Zeilen → import_song
  POST /api/update              Dateien → Buckets, Änderung → update_song
                                danach: unbenutzte Dateien im Bucket löschen
```

- Nur Container 1 ist erreichbar, über ein eigenes NetBird-Netz unter `http://zamaric-upload.netbird.cloud` (siehe [NetBird](#netbird)). Dafür läuft neben ihm ein dritter Container mit NetBird. Container 2 hat keinen veröffentlichten Port und ist nur für Container 1 erreichbar.
- Container 1 ist ein fertiger Webserver ohne eigenen Code und ohne Zugang zu Supabase. Login, Sessions und Upload liegen alle in Container 2, der Token verlässt ihn nie.
- Jede Interaktion mit Supabase passiert in Python. Der Browser hat weder Token noch Publishable Key und kennt die E-Mail nicht.
- Auf dem Pi liegt kein Supabase-Secret: nur Supabase-URL, Publishable Key (der steckt auch in der App) und die E-Mail.
- Python spricht immer mit dem Token des Partners mit Supabase, RLS gilt also voll.
- Die Prüfung läuft in der Website. Python liefert dafür nur die Nachschlagedaten aus der DB.

### Dateien

```
upload/
├── api/                          Container 2 (Python, FastAPI)
│   ├── main.py                   Endpunkte, startet das Aufräumen im Bucket nach Upload/Update
│   ├── config.py                 Einstellungen aus den Umgebungsvariablen
│   ├── reference.py              GET /api/reference
│   ├── songs.py                  GET /api/songs/{id}, trägt fehlende Prüfsummen des Songs nach
│   ├── manifest.py               Pydantic-Modelle mit den Regeln fürs Manifest
│   ├── upload.py                 POST /api/upload und /api/update
│   ├── requirements.txt
│   └── Dockerfile                kopiert zusätzlich shared/*.py dazu
├── website/                      Container 1 (nginx)
│   ├── static/                   die Website
│   │   └── vendor/sha256.min.js  js-sha256 1.0.0 (MIT), Prüfsummen im Browser
│   ├── nginx.conf
│   ├── security_headers.conf
│   └── Dockerfile
├── docker-compose.yml            alle drei Container (NetBird, website, api)
└── .env.example                  Vorlage für die eigene .env (nicht im Repo)
```

**Gemeinsamer Code.** Login, Sessions und Fehlerbehandlung teilen sich Upload-Tool und [Entwicklerseite](#entwicklerseite). Sie liegen in `shared/`. Beim Bauen holt die Compose-Datei den Ordner als zweiten Build-Kontext dazu (`additional_contexts: { shared: ../shared }`), das Dockerfile kopiert ihn mit `COPY --from=shared *.py ./` neben den eigenen Code. Im Container liegt also alles flach in `/app`. Braucht Docker Compose ≥ 2.17.

| Datei | Inhalt |
|---|---|
| `web.py` | `create_app()`: FastAPI ohne `/docs`, alle Fehler-Handler, `require_own_origin`, `POST /api/login`, `POST /api/logout`, `GET /api/session` |
| `sessions.py` | Login, Sessions, Login-Sperre, Token-Erneuerung (`fresh_client`). Liest `config.settings` des jeweiligen Tools |
| `errors.py` | `ApiError`: Fehler mit festem Code für den Browser |
| `queries.py` | `select_all`: alle Zeilen einer Tabelle seitenweise |
| `checksums.py` | `backfill_sha256`: Prüfsumme einer Datei nachtragen, `missing_sha256`, Bucket je Tabelle |
| `files.py` | `remove_unused_files`: unbenutzte Dateien über die Storage-API löschen (`unused_files()`), auch als Hintergrund-Variante, die nur loggt |

### Konfiguration

Diese Variablen gehören zu Container 2. Container 1 braucht nur seine nginx-Konfiguration mit der Adresse von Container 2 im Docker-Netz, z. B. `http://api:8000`. Die Einstellungen des NetBird-Containers stehen unter [NetBird](#netbird). Die Werte stehen in `upload/.env`, die Vorlage ist `.env.example`.

| Variable | Inhalt |
|---|---|
| `SUPABASE_URL` | `https://<projekt>.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | Publishable Key |
| `ADMIN_EMAIL` | E-Mail des Upload-Accounts. Nur mit ihm meldet sich das Tool an, im Browser wird nur das Passwort eingegeben |
| `PUBLIC_ORIGIN` | Eigene Adresse der Website, z. B. `http://zamaric-upload.netbird.cloud`. Für die `Origin`-Prüfung. Beginnt sie mit `https://`, bekommt das Cookie zusätzlich `Secure` |
| `SESSION_IDLE_MINUTES` | Session endet nach so vielen Minuten ohne Anfrage, z. B. `120` |

### NetBird

Das Upload-Tool hängt in einem eigenen NetBird-Netz (Free-Plan, NetBird Cloud), getrennt von Phils Tailscale-Netz mit dem Pi. Tailscale kam nicht in Frage, weil der kostenlose Plan nur für nicht-kommerzielle Nutzung ist.

- **Darin:** nur Container 1 als Gerät `zamaric-upload`, das Gerät des Partners und bei Bedarf Phils Gerät zum Testen. Der Pi selbst ist nicht drin, der Partner kann ihn also nie erreichen.
- **Konto:** ein eigenes NetBird-Konto nur für das Upload-Tool. Phil ist Owner, der Partner normaler Nutzer und kann die Regeln deshalb nicht ändern.
- **Regeln:** Die Standardregel (alle im Netz erreichen alle) reicht, weil im Netz nur der Container und der Partner sind. Im Container lauscht nur nginx auf Port `80`.
- **Adresse:** `http://zamaric-upload.netbird.cloud`. Den genauen Namen zeigt das NetBird-Dashboard beim Gerät.
- **Nur HTTP:** NetBird stellt für Adressen im Netz kein Zertifikat aus. Die Verbindung ist trotzdem verschlüsselt, weil sie durch WireGuard läuft. Der Browser zeigt aber „Nicht sicher“ an, und das Cookie ist ohne `Secure`. Die eingebaute SHA-256-Funktion des Browsers (`crypto.subtle`) gibt es nur bei HTTPS. Deshalb rechnet die Website Prüfsummen mit `js-sha256`, das in `static/vendor/` liegt.

**Sidecar.** Neben nginx läuft ein Container `netbird` mit dem Image `netbirdio/netbird`. nginx hängt mit `network_mode: service:netbird` in dessen Netz. Auf dem Pi wird kein Port veröffentlicht, und das Tailscale des Pi selbst bleibt davon unberührt.

| Einstellung | Inhalt |
|---|---|
| `NB_SETUP_KEY` | Setup-Key aus dem NetBird-Dashboard, steht in der `.env`. Nur für die erste Anmeldung nötig, danach leeren |
| `NB_HOSTNAME` | `zamaric-upload` |
| Volume `/var/lib/netbird` | Anmeldung und Schlüssel des Geräts. Ohne Volume wäre der Container nach jedem Neustart ein neues Gerät |
| `cap_add`, `/dev/net/tun` | `NET_ADMIN`, `SYS_ADMIN`, `SYS_RESOURCE`, laut NetBird-Doku nötig für WireGuard |

Das Volume enthält den Geräteschlüssel für das NetBird-Netz, aber keinen Zugang zu Supabase.

### Starten

Einmalig im NetBird-Dashboard:
1. Konto fürs Upload-Tool anlegen.
2. Setup-Key erzeugen, einmalig verwendbar.
3. Den Partner einladen. Er installiert die NetBird-App und meldet sich an.

Auf dem Pi (64 Bit, Docker mit Compose-Plugin ≥ 2.17 wegen `additional_contexts`) im Clone dieses Repos im Ordner `upload`:
1. `.env.example` nach `.env` kopieren und ausfüllen, `NB_SETUP_KEY` eintragen.
2. `docker compose up -d --build` baut und startet alle drei Container.
3. Wenn `zamaric-upload` im NetBird-Dashboard auftaucht: `NB_SETUP_KEY` in der `.env` leeren.
4. Logs: `docker compose logs -f api` (Container 2), `website` oder `netbird`. Startet `website` nicht, steht ein Fehler in der nginx-Konfiguration im Log.

Nach einem `git pull` mit Änderungen an der Website oder an Container 2 wieder `docker compose up -d --build`.

### Sessions

- `POST /api/login` meldet bei Supabase an (`ADMIN_EMAIL` + Passwort). Python legt Access- und Refresh-Token im Speicher ab, Schlüssel ist eine zufällige Session-ID (`secrets.token_urlsafe(32)`).
- Der Browser bekommt nur die Session-ID als Cookie `session`: `HttpOnly`, `SameSite=Strict`, `Secure` (nur bei HTTPS, also derzeit nicht), `Path=/`.
- Vor jedem Aufruf an Supabase erneuert Python den Access-Token, wenn er bald abläuft. Ist Supabase dabei oder beim Login nicht erreichbar, antwortet Container 2 mit `502 database_failed` und die Session bleibt bestehen.
- Sessions liegen nur im Speicher. Neustart von Container 2 = alle abgemeldet. Deshalb läuft uvicorn mit genau einem Worker.
- Jeder `/api/*`-Endpunkt außer `login` antwortet ohne gültige Session mit `401`.
- Eine Session läuft nach `SESSION_IDLE_MINUTES` ohne Aktivität ab. Als Aktivität zählen alle Endpunkte außer `GET /api/session`.
- Die Website fragt jede Minute (solange der Tab sichtbar ist) und beim Zurückkehren zum Tab `GET /api/session` und zeigt bei `401` sofort den Login. Der Login ist ein Fenster (`<dialog>`) über der weichgezeichneten Seite: Nach dem Anmelden bleibt man auf der Seite, auf der man war, und alles Gewählte bleibt erhalten. Bei jedem Seitenwechsel, nach „Nächster Song“ und beim Zurückkehren zum Tab lädt sie außerdem `GET /api/reference` neu. Hat sich etwas geändert, prüft sie einen schon gewählten Ordner neu.

### Sicherheit

Der Browser darf nie an Token, Passwort oder Konfiguration kommen. Dafür gilt in beiden Containern:

1. **Keine technischen Details in Antworten.** FastAPI ohne Debug-Modus starten. Jede Ausnahme wird abgefangen und nur mit den festen Codes aus den Endpunkten unten beantwortet. Fehlermeldungen von Supabase werden nie an den Browser weitergereicht.
2. **Nur `static/` als Website ausliefern.** Ins Image von Container 1 kommt nur der Inhalt von `static/`, nie der Projektordner. Sonst sind z. B. `/.env` oder der Python-Code im Browser abrufbar.
3. **Token und Passwort nie loggen**, auch nicht in Fehlermeldungen oder beim Debuggen.
4. **Dateinamen sind fremde Eingaben.** Die Website setzt sie nur als Text ein (`textContent`), nie als HTML.
5. **Die Prüfung im Browser ist Komfort, kein Schutz.** Wer eine Session hat, kann die Website umgehen und ein eigenes Manifest schicken. Container 2 prüft deshalb den Inhalt selbst (siehe Ablauf), `import_song` und `update_song` sichern dieselben Regeln noch einmal ab. Auch die Prüfsummen rechnet Container 2 selbst, die der Website dienen nur dem Vergleich.
6. **Größe begrenzen, bevor gelesen wird.** Sonst füllt eine einzige Anfrage den Speicher des Pi. Obergrenzen: 500 MB je Anfrage, 50 MB je Datei, 300 Dateien.
   - Container 1 lehnt Anfragen über 500 MB ab, bevor sie Container 2 erreichen (`client_max_body_size`). Er antwortet dann mit `413` und `{ "error": "too_large" }`, nicht mit der HTML-Fehlerseite von nginx.
   - Container 2 prüft beim Lesen des Formulars die Zahl der Dateien und die Größe jeder Datei, ebenfalls mit `413` und `too_large`.
7. **Fremde Seiten aussperren.** Container 2 verlangt bei jedem `POST /api/*` den Header `Origin` mit der eigenen Adresse (`PUBLIC_ORIGIN`), sonst `403`. Das ergänzt `SameSite=Strict`.
8. **Sicherheits-Header.** Container 1 setzt bei jeder Antwort, auch bei weitergeleiteten:
   - `Content-Security-Policy: default-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`
   - `X-Content-Type-Options: nosniff`
   - `Referrer-Policy: no-referrer`
   - `Cache-Control: no-store` für `/api/*`, `no-cache` für die Website, damit nach einem Update nicht die alte Version im Browser hängt.
9. **Login bremsen.** Container 2 sperrt nach 5 falschen Passwörtern für 5 Minuten (`429` mit `too_many_attempts`), zusätzlich zur Sperre von Supabase.
10. **Container-Rechte.** `api` und `website` laufen mit `no-new-privileges`, Prozesse darin können sich also keine zusätzlichen Rechte verschaffen. Alle Linux-Sonderrechte sind entzogen (`cap_drop: ALL`). Container 2 läuft außerdem als normaler Nutzer und braucht keine. nginx behält nur die vier, die es zum Start braucht: Port 80 öffnen, zum Nutzer `nginx` wechseln, seine Zwischenordner übergeben. Mehr Rechte hat nur der NetBird-Container (`NET_ADMIN`, `SYS_ADMIN`, `SYS_RESOURCE`), die verlangt NetBird für WireGuard.
11. **Logs.** Container 2 loggt bei jedem Fehler Zeitpunkt, Endpunkt, Status, Fehlercode und Songnamen nach stdout (`docker logs`). Nie Token, Passwort, Cookie oder Header. Container 1 bleibt beim Standard-Zugriffslog von nginx, das enthält weder Cookies noch Header.

### Endpunkte

Für alle Endpunkte gilt zusätzlich:

| Status | Body | Wann |
|---|---|---|
| `401` | `{ "error": "unauthorized" }` | keine oder abgelaufene Session (außer bei `login`) |
| `403` | `{ "error": "forbidden" }` | `POST` ohne den eigenen `Origin` |
| `404` / `405` | `{ "error": "not_found" }` / `"method_not_allowed"` | unbekannter Pfad oder falsche Methode |
| `422` | `{ "error": "invalid_request" }` | Body von `login` hat nicht die erwartete Form |
| `500` | `{ "error": "internal_error" }` | unerwarteter Fehler in Python, Details nur im Log |

#### POST /api/login

Anfrage (JSON):

```json
{ "password": "…" }
```

| Status | Body | Wann |
|---|---|---|
| `204` | leer, setzt Cookie `session` | Login geklappt |
| `401` | `{ "error": "invalid_credentials" }` | Passwort falsch |
| `429` | `{ "error": "too_many_attempts" }` | Login gesperrt, von Container 2 oder von Supabase |

Eine Admin-Prüfung gibt es beim Login nicht: Angemeldet wird immer `ADMIN_EMAIL`, und dieser Account ist in `admin` eingetragen.

#### POST /api/logout

Löscht die Session in Python und das Cookie und meldet diese eine Sitzung bei Supabase ab (`scope: local`, andere Geräte bleiben angemeldet). Antwort `204`.

#### GET /api/session

Nur „noch angemeldet?“: `204` mit leerem Body oder `401`. Verlängert die Session nicht und fragt Supabase nicht, damit ein offener Tab die Session nicht ewig am Leben hält.

#### GET /api/reference

Holt bei jedem Aufruf frisch aus Supabase, was die Prüfung braucht. Die Website ruft es beim Start und vor jeder Prüfung auf. Ohne gültige Session `401`, so erkennt die Website auch, ob der Partner angemeldet ist. Gelesen wird seitenweise, weil Supabase pro Abfrage höchstens 1000 Zeilen liefert. Scheitert das Lesen, kommt `502` mit `database_failed`.

Antwort `200`:

```json
{
  "categories": [
    { "id": 3, "name": "Grande Fanfare" },
    { "id": 4, "name": "Absolute Beginners Brass" }
  ],
  "levels": [
    { "id": 1, "name": "Normal" },
    { "id": 2, "name": "Anfänger" },
    { "id": 3, "name": "Leicht" }
  ],
  "instruments": [
    { "id": 12, "name": "Trompete", "transposition": "B" },
    { "id": 13, "name": "Trompete", "transposition": "C" },
    { "id": 20, "name": "DrumSet", "transposition": "" }
  ],
  "parts": [
    { "id": 112, "name": "Trompete", "transposition": "B" },
    { "id": 140, "name": "DrumSet Hi-Hat", "transposition": "" },
    { "id": 144, "name": "in B Stimmung", "transposition": "B" }
  ],
  "instrument_parts": [
    { "part_id": 112, "instrument_id": 12 },
    { "part_id": 140, "instrument_id": 20 },
    { "part_id": 144, "instrument_id": 12 }
  ],
  "songs": [
    {
      "id": 5,
      "category_id": 3,
      "name": "APT",
      "created_at": "2026-10-29T20:14:33.123456+00:00",
      "release_at": "2026-10-31T03:00:00+00:00"
    }
  ]
}
```

- `categories` sortiert nach `position`.
- `instruments` sind die Instrumente, die man in der App wählen kann. Sie werden für die Playback-Zuordnung (`instrument_ids`) und für Instrumente im `type` gebraucht.
- `parts` sind die Stimmen, für die es Noten gibt. Gegen sie werden die Noten-Dateinamen geprüft.
- `instrument_parts` ist der Inhalt der View `instrument_part`: wer welche Stimme sieht, feste Zuordnungen und Stimmungsregel zusammen. Die Website zeigt damit bei jeder Note, wer sie in der App sieht.
- `songs` enthält alle Songs, wartend und freigegeben, mit ID, Kategorie, Namen und den Zeitpunkten aus `song`. Die Website prüft damit, ob es einen Song schon gibt (dann bietet sie das Aktualisieren an), und zeigt auf der ersten Seite die letzten 5 Uploads mit ihrer Freigabe. „Alle Songs anzeigen“ klappt darunter alle Songs auf, nach Kategorien unterteilt und darin alphabetisch, mit Suche im Song-Namen (ohne Rücksicht auf Groß-/Kleinschreibung und Akzente) und Auswahl einer Kategorie.

#### POST /api/upload

Die Website schickt den geprüften Song mit den Angaben des Partners. Container 2 prüft keine Namensregeln (die sind Sache der Website), aber alles, was die Daten in der DB kaputt machen könnte.

**Anfrage** (`multipart/form-data`):

- Feld `manifest`: JSON wie unten.
- Feld `paths`: JSON-Liste mit dem `path` jeder Datei, in derselben Reihenfolge wie die Felder `files`.
- Je Datei ein Feld `files`.

`paths` gibt es, weil manche Server-Bibliotheken bei Dateinamen alles bis zum letzten `/` abschneiden. Der Dateiname eines `files`-Felds wird deshalb nicht ausgewertet.

```json
{
  "category_id": 3,
  "song_name": "APT",
  "release_at": null,
  "publisher_name": "Musikverlag Beispiel",
  "publisher_url": "https://www.musikverlag-beispiel.de/apt",
  "count_ins": [
    { "path": "Playbacks/Einzaehler/APT 4-4.mp3", "name": "4-4", "duration_ms": 1900 }
  ],
  "playbacks": [
    {
      "path": "Playbacks/APT.mp3",
      "type": "Normal",
      "duration_ms": 152430,
      "instrument_mode": "all",
      "instrument_ids": [],
      "letters": [
        { "name": "A", "position_ms": 0, "count_in": "4-4" },
        { "name": "B", "position_ms": 16467, "count_in": "4-4" }
      ]
    }
  ],
  "sheet_music": [
    { "path": "Noten/APT - Trompete in B.pdf", "part_id": 112, "level_id": 1 }
  ]
}
```

- `path` ist immer der Originalpfad im Ordner des Partners, relativ zum Song-Ordner. `type`, `name`, Instrument und Level kommen aus der Prüfung, also schon mit übernommenen Vorschlägen.
- `duration_ms` misst die Website im Browser. Container 2 misst beim Upload selbst nach und speichert seinen Wert.
- `instrument_mode` = `all` → `instrument_ids` ist leer. `only` / `except` → mindestens ein Instrument.
- Enthält der `type` als einen seiner Teile (zwischen ` - `) einen Instrumentennamen, stellt die Website `only` mit allen Instrumenten dieses Namens ein (z. B. `Trompete - lauter` → Trompete in B und in C). Der Partner kann das ändern.
- `letters[].count_in` verweist über `name` auf einen Eintrag in `count_ins`.
- `letters` darf leer sein, wenn der Partner ein Playback ohne `.txt` bestätigt hat.
- `release_at` ist optional: `null` = frühestmögliche Freigabe, sonst ISO-Zeitpunkt (gewählter Tag, 04:00 Europe/Berlin). Freigegeben wird frühestens 24 h nach dem Upload um 4 Uhr, und nicht vor `release_at`.
- `publisher_name` und `publisher_url` sind unabhängig voneinander freiwillig (`null` = keine Angabe), mit oder ohne Noten. Die Website trägt sie auf der Seite „Noten“ in der Karte „Verlagsnoten“ ein. Den Link bringt sie mit `new URL()` in die Standardform: `https://` wird ergänzt, wenn es fehlt, eine Domain mit Umlauten wird zur `xn--`-Schreibweise. Die Domain zeigt sie an, damit eine Fake-Domain auffällt.
- Es werden nur die Dateien mitgeschickt, die im Manifest stehen.

**Ablauf in Container 2:**

1. Session prüfen und Token bei Bedarf erneuern (`401`).
2. Manifest gegen Pydantic-Modelle prüfen (`422`):
   - `publisher_name` und `publisher_url` sind `null` oder erfüllen dieselben Regeln wie die Spalten in `song`.
   - Alle Texte (`song_name`, `type`, Einzähler-`name`, `letters[].count_in`) nicht leer, ohne Leerzeichen am Anfang/Ende, höchstens 100 Zeichen, ohne Steuer- oder Formatzeichen (Unicode `Cc`/`Cf`).
   - `letters[].name` passt auf `^([A-Z]|[0-9]+|D\.S\.|D\.C\.|Coda)$`.
   - `letters[].position_ms` ganzzahlig, ≥ 0, streng aufsteigend.
   - `letters[].count_in` kommt in `count_ins[].name` vor.
   - `instrument_mode` ist `all`, `only` oder `except`. Bei `all` ist `instrument_ids` leer, sonst nicht leer und ohne Doppelte.
   - `type` einmalig im Song, Einzähler-`name` einmalig im Song, `(part_id, level_id)` einmalig im Song, jeweils ohne Rücksicht auf Groß-/Kleinschreibung.
   - Jeder `path` beginnt mit `Noten/` (PDF) bzw. `Playbacks/` (MP3) und endet auf `.pdf` bzw. `.mp3`.
   - `release_at` ist `null` oder ein ISO-Zeitpunkt mit Zeitzone.
3. `paths` und `files` gleich lang, jeder Pfad im Manifest genau einmal in `paths`, keine zusätzlichen (`422`).
4. Dateiinhalt prüfen: PDF beginnt mit `%PDF`, MP3 lässt sich mit `mutagen` lesen (`422`).
5. `duration_ms` jeder MP3 mit `mutagen` neu messen und den Wert aus dem Manifest ersetzen. Danach prüfen, dass kein `letters[].position_ms` hinter der gemessenen Länge liegt (`422`). Von jeder Datei die SHA-256-Prüfsumme rechnen.
6. Dateien hochladen: MP3 (Playbacks und Einzähler) in den Bucket `audio` als `<uuid>.mp3`, PDF in den Bucket `sheet_music` als `<uuid>.pdf`. Den Content-Type fest auf `audio/mpeg` bzw. `application/pdf` setzen, nie den aus der Anfrage übernehmen. Der `path` aus dem Manifest dient nur der Zuordnung und taucht im Bucket nicht auf.
7. `import_song` (siehe README von `zamaric-database` → „`import_song`“) mit dem Manifest aufrufen, `path` jeweils durch den Dateinamen im Bucket ersetzt (`<uuid>.mp3`, ohne Bucket-Namen), dazu `sha256` je Datei. Die zurückgegebene Song-ID schreibt Container 2 nur ins Log. Fehler übersetzt er so: `song_exists` → `409`, `invalid_manifest` → `422`, `forbidden` → `403`, alles andere → `502` mit `database_failed`.
8. Scheitert Schritt 6 oder 7, bleiben schon hochgeladene Dateien liegen. Sie sind unsichtbar, und das Aufräumen nach dem nächsten Upload löscht sie.
9. Nach der Antwort ruft Container 2 im Hintergrund `unused_files()` auf und löscht diese Dateien über Storage, höchstens 100 pro Aufruf. Ein Fehler steht nur im Log.

**Antwort:** nur Status, nie Daten aus der DB.

| Status | Body |
|---|---|
| `201` | leer |
| `401` | `{ "error": "unauthorized" }` |
| `403` | `{ "error": "forbidden" }` |
| `409` | `{ "error": "song_exists" }` |
| `413` | `{ "error": "too_large" }` |
| `422` | `{ "error": "invalid_manifest" }`, `"missing_file"`, `"unexpected_file"` oder `"invalid_file_content"` |
| `502` | `{ "error": "storage_failed" }` oder `"database_failed"` |

#### GET /api/songs/{song_id}

Der sichtbare Stand eines Songs, gegen den die Website beim Aktualisieren vergleicht. Wartende Änderungen sind nicht dabei, nur ihr Zeitpunkt. Pfade im Bucket gehen nicht an den Browser.

Fehlt einer Datei noch die Prüfsumme (hochgeladen vor `song_update`), lädt Container 2 sie einmal aus dem Bucket, rechnet sie und trägt sie mit `set_file_sha256` ein. Beim ersten Aktualisieren eines alten Songs dauert das deshalb einen Moment.

Alle fehlenden Prüfsummen auf einmal trägt die [Entwicklerseite](#entwicklerseite) nach (Bereich Datenbank → Prüfsummen, `POST /api/checksums` dort).

Antwort `200`:

```json
{
  "song_id": 5,
  "release_at": "2026-10-31T03:00:00+00:00",
  "pending_release_at": null,
  "publisher_name": null,
  "publisher_url": null,
  "count_ins": [{ "name": "4-4", "duration_ms": 1900, "sha256": "…" }],
  "playbacks": [
    {
      "type": "Normal",
      "duration_ms": 152430,
      "sha256": "…",
      "instrument_mode": "all",
      "instrument_ids": [],
      "letters": [{ "name": "A", "position_ms": 0, "count_in": "4-4" }]
    }
  ],
  "sheet_music": [{ "part_id": 112, "level_id": 1, "sha256": "…" }]
}
```

`pending_release_at`: Zeitpunkt einer schon wartenden Änderung, sonst `null`. Unbekannter Song: `404` mit `not_found`. Scheitert das Lesen: `502` mit `database_failed` oder `storage_failed`.

#### POST /api/update

Aufbau wie [POST /api/upload](#post-apiupload) (`manifest`, `paths`, `files`), aber das Manifest enthält nur, was neu oder geändert ist:

```json
{
  "song_id": 5,
  "release_at": null,
  "publisher_name": "Musikverlag Beispiel",
  "publisher_url": "https://www.musikverlag-beispiel.de/apt",
  "count_ins": [],
  "playbacks": [
    {
      "path": null,
      "type": "Langsamer",
      "duration_ms": 180000,
      "instrument_mode": "except",
      "instrument_ids": [20],
      "letters": [{ "name": "A", "position_ms": 0, "count_in": "4-4" }]
    }
  ],
  "sheet_music": [{ "path": "Noten/APT - Trompete in B.pdf", "part_id": 112, "level_id": 1 }]
}
```

- `path: null` bei einem Playback: Die MP3 bleibt, geändert haben sich nur Buchstaben, Sichtbarkeit oder die Schreibweise des Zusatzes. Dafür wird keine Datei mitgeschickt.
- Listen dürfen leer sein, wenn sich nur Verlag oder Link ändern.
- Container 2 prüft wie beim Upload (Schritte 2 bis 6: gleiche Regeln je Eintrag, Einmaligkeit innerhalb der Listen, Dateien messen, hashen, hochladen) und ruft dann `update_song` (siehe README von `zamaric-database` → „`update_song`“) auf. Ob die Einzähler der Buchstaben existieren, prüft `update_song`, weil sie auch zu unveränderten Einzählern gehören können. Danach räumt er auf wie in Schritt 9.

**Antwort** `201` mit dem Zeitpunkt, ab dem die Änderung sichtbar ist (bei einem Song, der noch wartet: dessen Freigabe):

```json
{ "release_at": "2026-11-03T03:00:00+00:00" }
```

Fehler wie bei `POST /api/upload`, ohne `409`.

### Song aktualisieren

1. Auf der Seite **Kategorie**: Gibt es den Song dort schon, erscheint die Karte „„APT“ gibt es hier schon“ mit **Song aktualisieren**, **Nur Noten aktualisieren** und **Nur Playbacks aktualisieren**. „Weiter“ geht erst nach einer Wahl, die Wahl allein wechselt die Seite nicht. Bei „Nur …“ ignoriert die Website den anderen Ordner ganz und blendet dessen Seite aus (die Schritte werden übersprungen). Bei „Nur Playbacks“ bleiben deshalb auch Verlag und Link, wie sie sind, weil ihre Karte auf der Seite Noten steht. Wartet schon eine Änderung, steht dort, dass diese ersetzt wird.
2. Die Website lädt den Stand über `GET /api/songs/{id}`, belegt Verlag, Link und die Sichtbarkeit der vorhandenen Playbacks damit vor und rechnet die Prüfsummen der Dateien im Ordner.
3. Jede Datei bekommt eine Markierung: **neu**, **geändert** (mit Grund: PDF, MP3, Buchstaben, Sichtbar für, Schreibweise) oder **unverändert**. Was in der DB steht, aber nicht im Ordner, listet die Website unter „… nicht im Ordner, bleiben unverändert“. Gelöscht wird nichts.
4. Hochgeladen werden nur neue und geänderte Dateien. Ohne jede Änderung lässt sich nichts hochladen.
5. Freigabe wie bei neuen Songs (frühestmöglich oder an einem bestimmten Tag). Wartet der Song selbst noch, entfällt die Auswahl, weil Änderungen dann sofort gelten.

### Song-Ordner

#### Ordnerstruktur und Namenskonvention

```
<Song>/
  Noten/
    <Song> - <Instrument>[ <Level>].pdf
  Playbacks/
    <Song>[ - <type>].mp3
    Timestamps/
      <gleicher Name wie die MP3>.txt
    Einzaehler/
      <Song> <Name>.mp3
```

- Der Songname ist der Name des gewählten Ordners.
- Jeder Dateiname muss mit dem Songnamen beginnen, gefolgt von einem Leerzeichen oder dem Ende des Namens. Sonst `prefix_mismatch` (Fehler, mit Vorschlag). Der Rest dahinter wird ausgewertet, ein führendes `- ` fällt weg.
- Einzähler-`<Name>` ist der ganze Rest hinter `<Song> ` und darf Leerzeichen enthalten (z. B. `4-4`, `4-4langsamer`).
- `type` ist der Rest hinter `<Song> - ` ohne `.mp3`, als Ganzes übernommen (z. B. `ohne Drums_langsamer`, `Altsaxophon - lauter`). Fehlt das ` - ` (`Ackee Part A.mp3`), wird der Rest trotzdem `type` (`Part A`), mit Warnung `missing_separator`. Ohne Zusatz ist `type` = `Normal`, eine zusätzliche Datei `<Song> - Normal.mp3` ergibt dann denselben `type`. MP3 und `.txt` gehören zusammen, wenn sie denselben `type` haben.
- Level: Ist das letzte Wort ein Level-Name aus der DB, ist es das Level. Sonst ist das Level `Normal`.
- Stimme (der Rest ohne Level), gegen `part` (`name`, `transposition`):
  - Endet er auf ` in <X>` (z. B. `Trompete in B`), muss es genau eine Zeile mit `name` = `Trompete` und `transposition` = `B` geben.
  - Sonst (z. B. `Flöte`) wird nur `name` verglichen. Genau eine Zeile → passt. Mehrere Zeilen (z. B. `Trompete` gibt es in B und C) → `ambiguous_part`.
  - Keine passende Zeile → `unknown_part`. Ist nur das letzte Wort unbekannt und die Stimme davor bekannt → `unknown_level`.
- `.txt`-Zeile: `<Buchstabe> <MM:SS:FF> <Einzähler>`, getrennt durch Leerzeichen, `<Einzähler>` ist der ganze Rest der Zeile, FF = Frames bei 30 fps (0–29). `<Einzähler>` ist der `<Name>` einer Datei in `Einzaehler/`.
- `position_ms` = `(MM * 60 + SS) * 1000 + round(FF / 30 * 1000)`, wie `RehearsalMark.parseTimestamp` in der App.
- Wird ignoriert: `.DS_Store`, Dateien mit `._` am Anfang, leere Zeilen und Leerzeichen am Zeilenende in `.txt`.

#### Normalisierung

Gilt für jeden Datei- und Ordnernamen und jeden Zeileninhalt, bevor irgendetwas verglichen wird:

1. Unicode NFC (`String.prototype.normalize("NFC")`): macOS liefert Umlaute teils zerlegt.
2. Jeder Vergleich, ob es etwas schon gibt oder ob zwei Dinge zusammengehören, ignoriert Groß-/Kleinschreibung: Songs, Level, Instrumente, `type`, Einzähler-Namen und die Zuordnung MP3 ↔ `.txt` (`leicht` = `Leicht`, `ohne drums` = `ohne Drums`). Gespeichert wird die Schreibweise der Datei. Einzähler-Namen in `letters` werden auf die Schreibweise der Einzähler-Datei gebracht. Die DB erzwingt das mit `unique`-Indizes auf `lower(...)`.
3. Sonst wird nichts stillschweigend korrigiert. Abweichungen werden gemeldet, nicht repariert.

### Prüfregeln

Laufen in der Website (`static/check.js`). ⛔ = Fehler, blockiert den Upload · ⚠️ = Warnung, der Partner muss sie bestätigen

Meldungen zu einer Datei stehen direkt bei der Datei in der Liste. Nur Meldungen ohne passende Zeile (Song, Ordner, Dateien an falscher Stelle) zeigt die Website als Kartenstapel „Allgemein“: erst alle Fehler, dann die Warnungen in der Reihenfolge von `warningOrder`. Gleiche Meldungen ab 4 Stück werden zu einer Karte zusammengefasst, bei Warnungen nur die aus `groupableWarnings`. Die übrigen Warnungen muss der Partner einzeln bestätigen. Der Überblick sammelt alle offenen Punkte vor dem Hochladen-Knopf.

#### Struktur

| Code | | Regel |
|---|---|---|
| `no_content` | ⛔ | Weder `Noten/` noch `Playbacks/` vorhanden |
| `unexpected_entry` | ⛔ | Etwas anderes als `Noten/` oder `Playbacks/` direkt im Song-Ordner |
| `unexpected_folder` | ⛔ | Unterordner in `Noten/`, `Timestamps/`, `Einzaehler/` oder ein anderer als diese zwei in `Playbacks/` |
| `wrong_file_type` | ⛔ | In `Noten/` nicht `.pdf`, in `Playbacks/` und `Einzaehler/` nicht `.mp3`, in `Timestamps/` nicht `.txt` |
| `invalid_file_content` | ⛔ | Inhalt passt nicht zur Endung: PDF ohne `%PDF` am Anfang, MP3 ohne MP3-Kopf oder nicht abspielbar |
| `empty_folder` | ⛔ | Einer der Ordner ist leer (nur erkennbar, wenn der Ordner per Drag & Drop kommt) |
| `file_too_large` | ⛔ | Datei größer als 50 MB (Grenze von Supabase im Free-Plan) |

#### Namen

| Code | | Regel |
|---|---|---|
| `whitespace_issue` | ⛔ | Doppelte Leerzeichen, Leerzeichen am Anfang/Ende oder vor der Endung |
| `invisible_character` | ⛔ | Datei- oder Song-Ordnername enthält ein Steuer- oder Formatzeichen (Unicode `Cc`/`Cf`, z. B. Leerzeichen ohne Breite oder Richtungswechsel). Sonst sähen zwei verschiedene Namen in der App gleich aus und die `unique`-Indizes griffen nicht |
| `invalid_name_pattern` | ⛔ | Name folgt nicht der Konvention oben, oder zwei Dateien ergeben denselben `type` bzw. Einzähler |
| `prefix_mismatch` | ⛔ | Datei beginnt nicht mit dem Songnamen (z. B. `Cant Stop - …` im Ordner `Can't Stop`) |
| `missing_separator` | ⚠️ | Nach dem Songnamen fehlt ` - `, die Meldung zeigt den entstehenden `type` |

#### Noten

| Code | | Regel |
|---|---|---|
| `missing_default_level` | ⛔ | Level `Normal` fehlt in der DB |
| `unknown_level` | ⛔ | Das letzte Wort ist kein Level, das Instrument davor gibt es aber (`Tuba Profi`) |
| `unknown_part` | ⛔ | Stimme steht nicht in der DB |
| `ambiguous_part` | ⛔ | Name ohne Stimmung, aber die Stimme gibt es in mehreren Stimmungen |
| `part_without_viewers` | ⚠️ | Die Stimme ist keinem Instrument zugeordnet (laut `instrument_parts`), die Noten sieht in der App niemand |
| `duplicate_sheet_music` | ⛔ | Gleiches Instrument mit gleichem Level mehrfach |
| – | ⛔ | Verlagsnoten: Verlag mit unsichtbarem Zeichen oder Link, der die Regel von `song.publisher_url` nicht erfüllt. Beide Felder sind freiwillig |

#### Playbacks

| Code | | Regel |
|---|---|---|
| `missing_timestamps` | ⚠️ | Zu einer MP3 fehlt die `.txt`, das Playback wird ohne Buchstaben hochgeladen |
| `orphan_timestamps` | ⛔ | Zu einer `.txt` fehlt die MP3 |
| `invalid_encoding` | ⛔ | `.txt` ist kein gültiges UTF-8 |
| `empty_timestamps` | ⛔ | `.txt` hat keine Zeile |
| `invalid_timestamp_line` | ⛔ | Zeile hat weniger als drei Teile oder die Zeit nicht das Format `MM:SS:FF` |
| `invisible_character_text` | ⛔ | Zeile enthält ein Steuer- oder Formatzeichen. Tabulator und BOM am Dateianfang sind erlaubt |
| `invalid_frames` | ⛔ | Frames größer als 29 oder Sekunden größer als 59 |
| `invalid_letter` | ⛔ | Buchstabe ist nicht `A`–`Z`, keine Zahl und nicht `D.S.`, `D.C.` oder `Coda` |
| `duplicate_letter` | ⛔ | Buchstabe kommt mehrfach vor, ohne dass dazwischen `D.S.` oder `D.C.` steht |
| `duplicate_position` | ⛔ | Zwei Buchstaben liegen an derselben Stelle |
| `letters_not_ascending` | ⛔ | Zeiten sind nicht aufsteigend |
| `letter_after_end` | ⛔ | Zeit liegt hinter dem Ende der MP3 |
| `unknown_count_in` | ⛔ | Einzähler aus der `.txt` hat keine Datei in `Einzaehler/`. Gibt es einen Einzähler, dessen Name damit endet (`Prelude 4-4` statt `4-4`), weist die Meldung auf einen vermutlich zu kurzen Songnamen hin |
| `unused_count_in` | ⛔ | Datei in `Einzaehler/` wird von keiner `.txt` benutzt |
| `letters_differ_between_variants` | ⚠️ | Buchstabenfolge weicht innerhalb einer Variantengruppe ab. Bei höchstens 2 Unterschieden nennt die Meldung die fehlenden und zusätzlichen Buchstaben, sonst beide Folgen. Gruppe `Normal` = `Normal`, `langsamer`, `ohne Drums`, `<Instrument> - lauter` und Kombinationen; Gruppe `Part A` = `Part A`, `Part A - ohne Drums` usw. Verglichen wird mit dem Playback, das wie die Gruppe heißt. `SoloPart`, `Begleitung` usw. stehen allein |
| `letter_time_differs_between_variants` | ⚠️ | Gleiche Buchstabenfolge, aber ein einzelner Buchstabe liegt mehr als 3 s neben der Stelle, die sich aus seinen beiden Nachbarn und dem Tempo-Verhältnis zur Referenz ergibt. Erster und letzter Buchstabe werden nicht geprüft; gleichmäßige Tempo-Abweichungen lösen nichts aus |
| `unknown_type_instrument` | ⚠️ | Ein Teil des `type` (zwischen ` - `) ähnelt einem Instrument (Ähnlichkeit ≥ 0,8), ist aber keins |
| `ambiguous_type_instrument` | ⛔ | Ein Teil des `type` ist das gemeinsame Wortende mehrerer Instrumente (mindestens 5 Buchstaben, selbst kein Instrument) oder ähnelt ihm (≥ 0,8), z. B. `Saxophon`/`Saxaphon` für Alt-, Tenor-, Bariton- und Sopransaxophon. Die Familien ergeben sich aus der Instrumententabelle |
| `first_letter_not_at_start` | ⚠️ | Erster Buchstabe liegt nicht bei `00:00:00` |

#### Song

| Code | | Regel |
|---|---|---|
| `unknown_category` | ⛔ | Kategorie gibt es nicht |
| `song_exists` | ⛔ | In der Kategorie gibt es schon einen Song mit diesem Namen (ohne Rücksicht auf Groß-/Kleinschreibung), wartend oder freigegeben. Entfällt beim [Aktualisieren](#song-aktualisieren) |

#### Vorschläge

Zu manchen Meldungen schlägt die Prüfung einen korrigierten Dateinamen vor, nur bei eindeutig bestem Treffer (Ähnlichkeit über Levenshtein-Abstand). Übernimmt der Partner den Vorschlag, prüft die Website neu, als hieße die Datei schon so. Die Datei im Ordner des Partners bleibt unverändert, hochgeladen wird mit der korrigierten Zuordnung.

| Meldung | Vorschlag |
|---|---|
| `whitespace_issue` | Leerzeichen bereinigt |
| `invisible_character` | unsichtbare Zeichen entfernt, Leerzeichen bereinigt (nur bei Dateien, nicht beim Song-Ordner) |
| `prefix_mismatch` | Präfix durch den Songnamen ersetzt (`Cant Stop - …` → `Can't Stop - …`) |
| `unknown_level` | ähnlichstes Level aus der DB (`Anhänger` → `Anfänger`) |
| `unknown_part` | ähnlichste Stimme aus der DB (`Altsaxoxophon in Es` → `Altsaxophon in Es`) |
| `unknown_type_instrument` | Instrument im `type` korrigiert (`Tenorsaxophone - lauter` → `Tenorsaxophon - lauter`), bei MP3 und `.txt` |
| `ambiguous_type_instrument` | die `Alt`-Variante der Familie (`Part B - Saxaphon` → `Part B - Altsaxophon`), bei MP3 und `.txt`. Gibt es keine, nur die Meldung |
| `orphan_timestamps` | `.txt` der ähnlichsten MP3 ohne `.txt` zugeordnet (`ohne Dums` → `ohne Drums`) |

### Angefangener Upload

Die Website merkt sich einen angefangenen Upload im Browser (`localStorage`, Schlüssel `zamaric-upload-draft`), damit nach einem Neuladen oder abgelaufener Anmeldung nichts verloren geht (`upload/website/static/app.js`, `saveDraft`).

- **Was gespeichert wird:** Song-Name, Kategorie, aktueller Schritt, Umbenennungen, ausgeschlossene Dateien, bestätigte Warnungen, Instrument-Einstellungen der Playbacks, Freigabetag, Verlag und Link, beim Aktualisieren auch Song und Art der Aktualisierung. Die Dateien selbst nicht, die kann der Browser nicht aufheben.
- **Wann:** nach jeder Änderung, sobald der Ordner geprüft ist. Pro Browser gibt es einen Entwurf, ein neuer Song ersetzt ihn.
- **Fortsetzen:** Auf der Startseite steht die Karte „Angefangener Upload“ mit Song, Kategorie und Zeitpunkt. „Fortsetzen“ verlangt, denselben Ordner erneut zu wählen. Heißt er anders, kommt „Falscher Ordner: „…“ erwartet, „…“ gewählt.“. Dann prüft die Website den Ordner neu und macht auf dem gespeicherten Schritt weiter (auf der zweiten Seite, falls der Schritt nicht mehr verfügbar ist). Lässt sich der zu aktualisierende Song nicht laden, kommt „Song nicht geladen. Auf der Seite Kategorie erneut wählen.“ und es geht auf der Seite Kategorie weiter.
- **Verwerfen** löscht den Entwurf.
- **Ende:** Nach einem erfolgreichen Upload wird der Entwurf gelöscht. Älter als 7 Tage wird er nicht mehr angeboten.

### Testmodus der Website

`/?demo` nutzt eingebaute Beispieldaten statt `/api/reference`, überspringt den Login und zeigt beim Hochladen nur das Manifest an. Damit lässt sich die Prüfung mit echten Song-Ordnern ausprobieren, ohne dass Python läuft:

```bash
cd upload/website/static
python3 -m http.server
```

Danach `http://localhost:8000/?demo` öffnen.

---

## Entwicklerseite

Website auf dem Pi nur für Phil: ein Board für TODOs im Stil von Padlet, Commit-Verlauf, Statistik und README aus dem App-Repo `zamaric`, der Status der GitHub Actions, Prüfungen der DB und der Buckets, der Verlauf der ntfy-Nachrichten und die Antwortzeit von Supabase. Aufgebaut wie das [Upload-Tool](#upload-tool) und mit demselben Login-Code (`shared/`), aber als eigener Stack mit eigenem NetBird-Gerät.

### Aufbau

```
Browser (Phil)
  │  nur Session-Cookie, nie den Supabase-Token
  ▼
Container 1: website            (nginx, Website in static/)
  GET  /                        statische Website
  /api/*                        leitet unverändert an Container 2 weiter
  │  internes Docker-Netz
  ▼
Container 2: api                (Python)
  POST /api/login, /api/logout  Passwort → Supabase, Token bleibt in Python
  GET  /api/overview            Startseite: alle Kennzahlen in einer Antwort
  /api/board/*                  Board → SQLite-Datei /data/board.sqlite3 (Volume board-data)
  /api/integrity, /api/files …  Prüfungen und Übersichten → RPCs der Migration dev_site
  /api/checksums                fehlende Prüfsummen nachtragen (aus dem Upload-Tool hierher umgezogen)
  /api/git/*, /api/readme       git log/show/ls-tree auf dem eingehängten .git
  /api/ci                       GitHub REST (Actions), nur lesender Token
  /api/latency                  jede Minute /auth/v1/health, ohne Anmeldung
  │
  ├── Supabase (Token des Admins, RLS gilt)
  ├── /repo.git (schreibgeschützt eingehängt: nur das .git des App-Repos zamaric auf dem Pi)
  ├── /data (Volume board-data: Board und tägliche Sicherungen)
  └── api.github.com
```

- Nur Container 1 ist erreichbar, als eigenes NetBird-Gerät `zamaric-dev` (siehe [NetBird](#netbird-1)). Auf dem Pi wird kein Port veröffentlicht.
- Wie beim Upload-Tool: Jede Interaktion mit Supabase passiert in Python, der Browser kennt weder Token noch Publishable Key noch E-Mail. Auf dem Pi liegt kein Supabase-Secret.
- Der Clone des App-Repos `zamaric` auf dem Pi (nicht dieses Repo) pullt sich selbst. Die Seite zeigt den Stand des letzten Pulls (`FETCH_HEAD`) und holt nichts selbst.
- Das Board gehört zur Entwicklerseite, nicht zur App, und liegt deshalb nicht in Supabase, sondern auf dem Pi (siehe [Board (SQLite)](#board-sqlite)). Es funktioniert auch, wenn Supabase nicht erreichbar ist.

### Dateien

```
dev/
├── api/                          Container 2 (Python, FastAPI), nutzt shared/
│   ├── main.py                   create_app() mit Lifespan (startet/stoppt Messung und Board-Sicherung), bindet die Router ein
│   ├── config.py                 Einstellungen aus den Umgebungsvariablen
│   ├── board.py                  /api/board/*, SQLite-Datei und tägliche Sicherung
│   ├── database.py               Integrität, Dateien, Prüfsummen, Speicher, Freigaben, Cron, Nachrichten
│   ├── repo.py                   Commits, Statistik, README (git), CI (GitHub)
│   ├── monitor.py                Antwortzeit: Hintergrund-Messung und /api/latency
│   ├── overview.py               /api/overview, sammelt die Kennzahlen der anderen Module
│   ├── requirements.txt          u. a. tzdata (Wochen nach deutscher Zeit, python:slim hat keine Zeitzonen)
│   └── Dockerfile                mit git, kopiert shared/*.py dazu
├── website/                      Container 1 (nginx)
│   ├── static/
│   │   ├── index.html
│   │   ├── app.js                Gerüst: Navigation, Hash-Router, Login, request(), Markdown, Dialoge
│   │   ├── overview.js           Übersicht (Startbereich)
│   │   ├── board.js              Board
│   │   ├── views.js              Repo, Datenbank, Nachrichten, Server
│   │   ├── demo.js               Beispieldaten für ?demo
│   │   ├── style.css             Tokens, Gerüst, gemeinsame Klassen, Board
│   │   ├── views.css             Bereiche aus views.js
│   │   ├── overview.css          Übersicht (Präfix ov-)
│   │   ├── fonts/Figtree.ttf
│   │   └── vendor/
│   │       ├── sortable.esm.js   SortableJS 1.15.6 (MIT), Drag & Drop
│   │       ├── marked.esm.js     marked 15.0.12 (MIT), Markdown → HTML
│   │       └── purify.es.js      DOMPurify 3.2.6 (Apache-2.0 / MPL-2.0), HTML bereinigen
│   ├── nginx.conf
│   ├── security_headers.conf
│   └── Dockerfile
├── docker-compose.yml            alle drei Container (NetBird, website, api)
└── .env.example                  Vorlage für die eigene .env (nicht im Repo)
```

- Die Vendor-Dateien sind unverändert von npm (über jsdelivr). DOMPurify heißt dort `purify.es.mjs`, hier `.js`: Die `mime.types` von nginx kennen `.mjs` nicht, der Browser würde das Modul sonst als `application/octet-stream` ablehnen.
- `app.js` lädt `overview.js`, `board.js`, `views.js` und `demo.js` per dynamischem `import()`, weil diese ihrerseits aus `app.js` importieren.
- Jeder Bereich hat die Form `renderX(container, { signal })`. Beim Wechsel des Bereichs bricht das `AbortSignal` ab und stoppt laufende Anfragen, Timer und Listener.

### Konfiguration

Variablen von Container 2, in `dev/.env` (Vorlage `.env.example`):

| Variable | Inhalt |
|---|---|
| `SUPABASE_URL` | `https://<projekt>.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | Publishable Key |
| `ADMIN_EMAIL` | E-Mail eines Accounts aus `admin`. Im Browser wird nur das Passwort eingegeben |
| `PUBLIC_ORIGIN` | `http://zamaric-dev.netbird.cloud`, für die `Origin`-Prüfung und das `Secure`-Flag |
| `SESSION_IDLE_MINUTES` | Session endet nach so vielen Minuten ohne Anfrage, Standard `120` |
| `GITHUB_TOKEN` | Fine-grained Token (GitHub → Settings → Developer settings), nur Repo `zamaric`, Rechte **Actions: Read** und **Metadata: Read**. Kann nichts ändern. Leer: Der GitHub-Bereich zeigt „Nicht verbunden“, die Ampel der Übersicht „nicht eingerichtet“ |
| `REPO_PATH` | Ordner eines Clones des App-Repos `zamaric` auf dem Pi (nicht dieses Repo), z. B. `/home/phil_ps/zamaric`. Pflicht, sonst bricht `docker compose` ab |
| `NB_SETUP_KEY` | Setup-Key aus dem NetBird-Dashboard, nur für die erste Anmeldung, danach leeren. Bekommt nur der NetBird-Container |

Fest in `config.py`: `git_dir` = `/repo.git`, `github_repository` = `OutofSkill/zamaric`, `github_workflow` = `analyze.yml`, `board_data_dir` = `/data` (Volume `board-data`).

**Nur `.git` eingehängt.** Compose hängt `${REPO_PATH}/.git` des App-Repos schreibgeschützt als `/repo.git` ein, nicht den ganzen Ordner. So sieht Container 2 nur die Git-Daten und nichts aus dem Arbeitsordner des Clones. Die `.env`-Dateien von Upload-Tool und Entwicklerseite liegen ohnehin in diesem Repo, also nicht im App-Repo. git läuft nur lesend (`log`, `show`, `ls-tree`, `cat-file`, `rev-parse`, `rev-list`) mit `--git-dir`, `safe.directory=*` (der Container-Nutzer ist nicht Besitzer) und `GIT_OPTIONAL_LOCKS=0`.

### NetBird

- Eigenes Gerät `zamaric-dev` (`NB_HOSTNAME`) mit eigenem Volume, getrennt vom Gerät `zamaric-upload`. Sidecar, `cap_add` und `/dev/net/tun` wie beim [Upload-Tool](#netbird).
- **Zugriffsregel:** Im NetBird-Dashboard eine Gruppe nur mit Phils Geräten anlegen und die Standardregel „alle erreichen alle“ durch eine Regel ersetzen, die nur diese Gruppe auf `zamaric-dev` lässt. Der Partner darf die Seite nicht erreichen. Gilt die Standardregel weiter, weil das Upload-Tool sie braucht, für `zamaric-upload` eine eigene Regel anlegen.
- Adresse: `http://zamaric-dev.netbird.cloud`, nur HTTP wie beim Upload-Tool.

### Starten

Einmalig:
1. Migrationen `20261106120000_dev_site` und `20261106180000_integrity_tuning` im SQL-Editor ausführen (siehe README von `zamaric-database` → „Migrationen“).
2. Im NetBird-Dashboard einen Setup-Key erzeugen und die Zugriffsregel anlegen (siehe oben).
3. Optional den GitHub-Token anlegen.

Auf dem Pi im Clone dieses Repos im Ordner `dev` (Docker Compose ≥ 2.17 wegen `additional_contexts`):
1. `.env.example` nach `.env` kopieren und ausfüllen, `REPO_PATH` auf den Clone des App-Repos `zamaric`.
2. `docker compose up -d --build` baut und startet alle drei Container.
3. Wenn `zamaric-dev` im NetBird-Dashboard auftaucht: `NB_SETUP_KEY` in der `.env` leeren.
4. Logs: `docker compose logs -f api`. Die Messung der Antwortzeit loggt nur Wechsel zwischen erreichbar und nicht erreichbar, der Logger von `httpx` steht auf `WARNING`.

Nach einem Pull mit Änderungen an `dev` oder `shared` wieder `docker compose up -d --build`, bei `shared` auch im Ordner `upload`. Das Board bleibt dabei erhalten (Volume `board-data`). Weg ist es nur mit `docker compose down -v`.

**Sicherungen des Boards abholen** (im Ordner `dev`):

```bash
mkdir -p board-backups
docker compose cp api:/data/backups/. ./board-backups
```

Danach liegen die Tagessicherungen `board-JJJJ-MM-TT.sqlite3` in `dev/board-backups/` (steht in `.gitignore`). Das `/.` sorgt dafür, dass die Dateien auch beim zweiten Abholen direkt dort landen und nicht in `board-backups/backups/`.

**Board wiederherstellen** aus einer Sicherung in `board-backups/` (im Ordner `dev`):
1. `docker compose stop api`
2. Die WAL-Dateien `board.sqlite3-wal` und `board.sqlite3-shm` gehören zum alten Stand und müssen weg, sonst mischt SQLite sie in die zurückgespielte Datei. Das erledigt der nächste Schritt mit.
3. Als Nutzer `app` kopieren (das Image setzt `USER app`), damit die Datei danach beschreibbar ist:
   ```bash
   docker compose run --rm --no-deps -v "$PWD/board-backups:/restore:ro" --entrypoint sh api \
     -c "rm -f /data/board.sqlite3-wal /data/board.sqlite3-shm && cp /restore/board-JJJJ-MM-TT.sqlite3 /data/board.sqlite3"
   ```
4. `docker compose start api`

Nicht mit `docker compose cp` zurückspielen: Dateien, die so in den Container kommen, gehören `root`. Der Container läuft als `app` ohne Sonderrechte und könnte die Datei dann nur lesen, jede Änderung am Board endete mit `500`.

**Lokal ansehen ohne Pi:** `/?demo` nutzt die Beispieldaten aus `demo.js` statt der API und überspringt den Login. Das Board lässt sich im Speicher bearbeiten.

```bash
cd dev/website/static
python3 -m http.server
```

Danach `http://localhost:8000/?demo` öffnen.

### Sicherheit

Alle Punkte des [Upload-Tools](#sicherheit) gelten hier genauso: feste Fehlercodes ohne Details, nur `static/` im Image, nie Token, Passwort, Cookie oder Header im Log, `Origin`-Pflicht bei jedem schreibenden Endpunkt, Login-Sperre, gleiche Container-Härtung, ein Worker. Unterschiede:

- **Größe:** `client_max_body_size 1m`, es gibt keine Uploads.
- **CSP:** `default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`. Kein `media-src`.
- **Markdown** (README, Karten) geht nur über DOMPurify ins DOM. `style`, `form`, `input` und `button` sind zusätzlich verboten. Links öffnen in einem neuen Tab mit `rel="noopener noreferrer"`. Bilder bleiben nur als `data:image/…`, alle anderen werden durch ihren Alt-Text ersetzt, damit keine fremden Server angefragt werden. Alles andere setzt die Website nur als Text ein.
- **GitHub-Token** nur im Header an api.github.com, nie im Log oder in Fehlermeldungen.
- **Bucket:** Unbenutzte Dateien löscht nur der Knopf in „Unbenutzte Dateien“, über die Storage-API und die bestehende Lösch-Regel. Die SQL-Funktionen lesen `storage.objects` nur.

### Board (SQLite)

Das Board liegt in `/data/board.sqlite3` im Docker-Volume `board-data`, nicht in Supabase. `board.py` legt Datei und Tabellen beim ersten Zugriff an, mit `journal_mode = wal`, `foreign_keys = on` und `busy_timeout` 5 s. Jeder Zugriff öffnet eine eigene Verbindung in einem Thread und läuft hinter einem Lock in einer Transaktion (`begin immediate`). Es gibt nur einen Worker, der Lock reicht also gegen gleichzeitiges Verschieben.

**Schema-Stand:** steht in `pragma user_version` (derzeit `1`). Die Schritte stehen in `SCHEMA_STEPS` in `board.py`, eine spätere Änderung kommt als neuer Eintrag ans Ende und läuft beim nächsten Start genau einmal, jeweils in einer eigenen Transaktion. Ist die Datei neuer als der Code (z. B. nach dem Zurückgehen auf ein älteres Image), schreibt `board.py` nichts, loggt „Board-Datei hat Schema …“ und antwortet mit `500`.

**`board_column`**: Spalten

| Spalte | Typ | Regeln |
|---|---|---|
| `id` | integer | `autoincrement`: Eine gelöschte ID wird nie neu vergeben, ein Tab mit altem Stand bekommt dann `404` statt eine fremde Spalte zu treffen |
| `title` | text | 1–200 Zeichen |
| `position` | integer | ab 0, lückenlos. Neue Spalten kommen ans Ende (max + 1) |
| `created_at`, `updated_at` | text (ISO-8601 UTC) | `updated_at` nur bei geändertem Titel, nicht beim Verschieben |

**`board_card`**: Karten einer Spalte

| Spalte | Typ | Regeln |
|---|---|---|
| `id` | integer | `autoincrement`, wie bei `board_column` |
| `column_id` | integer | → `board_column`, wird mit der Spalte gelöscht |
| `title` | text | 0–200 Zeichen, Standard leer |
| `body` | text | Markdown, höchstens 20 000 Zeichen, Standard leer |
| `color` | text | Farbe des Zettels: `default`, `red`, `orange`, `yellow`, `green`, `blue`, `purple`, Standard `default` |
| `position` | integer | ab 0 innerhalb der Spalte, lückenlos. Neue Karten kommen ans Ende |
| `created_at`, `updated_at` | text (ISO-8601 UTC) | `updated_at` nur bei geändertem Titel, Text oder Farbe |

Titel und Text dürfen keine Steuerzeichen enthalten außer Tab, Zeilenumbruch und Wagenrücklauf (sonst `422`). IDs in Pfad und Body müssen zwischen 1 und 2⁶³ − 1 liegen (sonst `422`).

- **Verschieben:** `index` ab 0, zu groß heißt ans Ende. Ziel- und alte Spalte werden in derselben Transaktion lückenlos neu nummeriert, auch nach dem Löschen einer Karte oder Spalte.
- **Sicherung:** Beim Start des Containers und danach stündlich prüft `backup_once()`, ob es für den Tag (Datum in Berlin) schon eine Sicherung gibt, und sichert sonst die Datei über die Backup-API von SQLite nach `/data/backups/board-JJJJ-MM-TT.sqlite3`. Stündlich statt alle 24 Stunden, damit Zeitumstellung, Laufzeit oder eine beim Booten noch falsche Uhr keinen Tag auslassen. Geschrieben wird zuerst in `….sqlite3.part`, dann umbenannt; ein alter `.part`-Rest des Tages wird vorher gelöscht, Reste anderer Tage beim Aufräumen. Es bleiben die neuesten 14, ältere werden gelöscht. Im Log steht „Board gesichert: …“, ein Fehler nur als „Board nicht gesichert (…)“. Die Sicherungen liegen im selben Volume. Abholen und Wiederherstellen siehe [Starten](#starten-1).

### Endpunkte

Für alle gilt die Tabelle unter [Upload-Tool → Endpunkte](#endpunkte) (`401`, `403`, `404`/`405`, `422`, `500`). Jeder Endpunkt außer `login` braucht eine Session, jeder `POST`/`PATCH`/`DELETE` den eigenen `Origin`. Fehler von Supabase: `forbidden` → `403`, `not_found` bzw. Verweis auf eine fehlende Zeile → `404 not_found`, sonst `502 database_failed`. Das Board fragt Supabase nicht: Unbekannte IDs ergeben `404 not_found`, ein Fehler in SQLite `500 internal_error` (Details im Log). Zeiten sind ISO-8601 in UTC.

| Methode | Pfad | Antwort | Fehler |
|---|---|---|---|
| `POST` | `/api/login`, `/api/logout` | `204`, wie beim Upload-Tool | wie beim Upload-Tool |
| `GET` | `/api/session` | `204` oder `401`, verlängert die Session nicht | |
| `GET` | `/api/overview` | `{ generated_at, latency, ci, integrity, cron, content, repo, releases, storage, notifications }`, jeder Teil `{ data }` oder `{ error }` (Details unten), immer `200`, verlängert die Session nicht | `401` |
| `GET` | `/api/board` | `{ columns: [{ id, title, cards: [{ id, title, body, color, updated_at }] }] }` | |
| `POST` | `/api/board/columns` `{ title }` | `201`, neue Spalte am Ende | `422` |
| `PATCH` | `/api/board/columns/{id}` `{ title }` | `{ id, title }` | `404`, `422` |
| `DELETE` | `/api/board/columns/{id}` | `204`, Karten fallen mit weg | `404` |
| `POST` | `/api/board/columns/{id}/move` `{ index }` | `204` | `404`, `422` |
| `POST` | `/api/board/cards` `{ column_id, title?, body?, color? }` | `201`, neue Karte am Ende der Spalte, ohne `title`/`body` leer, ohne `color` `default` | `404`, `422` |
| `PATCH` | `/api/board/cards/{id}` `{ title, body, color? }` (Titel und Text Pflicht, ohne `color` bleibt die Farbe) | Karte | `404`, `422` |
| `DELETE` | `/api/board/cards/{id}` | `204` | `404` |
| `POST` | `/api/board/cards/{id}/move` `{ column_id, index }` | `204` | `404`, `422` |
| `GET` | `/api/integrity` | `{ checked_at, findings: [integrity_report()] }` | `502` |
| `GET` | `/api/files` | `{ unused: [{ bucket, name }], missing: [missing_files()] }` | `502` |
| `POST` | `/api/files/cleanup` | `{ removed }` | `502 storage_failed` / `database_failed` |
| `GET` | `/api/checksums` | `{ running, total, done, failed }`, verlängert die Session nicht | |
| `POST` | `/api/checksums` | `202`, wie `GET`. Läuft schon ein Durchgang, kommt dessen Stand | |
| `GET` | `/api/storage` | `{ buckets: [storage_usage()], largest: [largest_files(20)] }` | `502` |
| `GET` | `/api/releases` | `{ pending: [pending_releases()] }` | `502` |
| `GET` | `/api/cron` | `{ runs: [cron_runs(50)] }` | `502` |
| `GET` | `/api/notifications` | `{ notifications: [notification_feed(200)] }` | `502` |
| `GET` | `/api/git/commits?skip=0&limit=50` | `{ head, fetched_at, total, commits: [{ hash, short, author, date, subject, body, files, insertions, deletions }] }`, `limit` ≤ 200 | `422`, `503 repo_unavailable` |
| `GET` | `/api/git/stats` | `{ head, total_commits, first_commit_at, last_commit_at, authors, weeks (52, lückenlos, ab Montag 00:00 Europe/Berlin), types, languages, hot_files (90 Tage, Top 15) }` | `503 repo_unavailable` |
| `GET` | `/api/readme` | `{ head, markdown }` aus `HEAD:README.md` des App-Repos | `503 repo_unavailable` |
| `GET` | `/api/ci` | `{ configured, runs: [{ id, status, conclusion, branch, commit (voller Hash), title, event, started_at, updated_at, url }], latest_jobs: [{ name, status, conclusion, steps }] }`, 120 s Cache | `502 github_failed` |
| `GET` | `/api/latency` | `{ interval_seconds: 60, samples: [{ at, ms, ok }] }`, verlängert die Session nicht | |

**Prüfsummen nachtragen** (`backfill_missing_sha256`, aus dem Upload-Tool umgezogen): alle Zeilen in `count_in`, `playback` und `sheet_music` mit Datei, aber ohne Prüfsumme. Datei für Datei herunterladen, hashen, über `set_file_sha256` eintragen. Es läuft immer nur ein Durchgang. Fehlt eine Datei im Bucket, wird sie übersprungen und beim nächsten Durchgang wieder versucht. Endet mit der Session. Im Log steht am Ende „Prüfsummen nachgetragen: N, fehlgeschlagen: M“.

**Übersicht** (`overview.py`): Alle Teile laufen parallel, jeder höchstens 15 s (sonst `{ error: "timeout" }`). Ein Fehler betrifft nur seinen Teil. Ist Supabase beim Erneuern des Tokens nicht erreichbar, bekommen nur die Supabase-Teile `database_failed`, Antwortzeit, GitHub und Repo kommen trotzdem.

| Teil | Inhalt | Quelle |
|---|---|---|
| `latency` | `last`, `down_since` (Beginn des laufenden Ausfalls), `median_ms`, `failures` (24 h), `samples` | Ringpuffer von `monitor.py` |
| `ci` | `configured`, `workflow`, `latest` (letzter Lauf) | `/api/ci`-Cache |
| `integrity` | `errors`, `warnings` | `integrity_report()`, 5 min gecacht |
| `cron` | `latest` (letzter Lauf), `failed_24h` | `cron_runs(50)` |
| `content` | `songs`, `pending_songs`, `playbacks`, `sheet_music`, `count_ins`, `categories` | Zählabfragen (`count=exact`), sichtbar = `release_at is null` |
| `repo` | `head`, `fetched_at`, `latest` (Commit), `this_week`, `last_week`, `weeks` (12) | git, Wochen bei jeder Anfrage aus einem Zähler je HEAD gebaut |
| `releases` | `next` (früheste wartende Freigabe), `more` | `pending_releases()` |
| `storage` | `buckets`, `total_bytes` | `storage_usage()`, 5 min gecacht |
| `notifications` | `latest` (3) | `notification_feed(3)` |

**Git:** Ergebnisse liegen je HEAD im Speicher, die Statistik wird pro HEAD nur einmal gerechnet. Die Wochenliste entsteht bei jeder Anfrage neu aus dem heutigen Datum, damit „diese Woche“ auch ohne neuen Commit stimmt. Sprachen nach Dateiendung im Baum von HEAD; Binärdateien und Dateien über 2 MB zählen nur als Dateien. Commit-Art ist das Präfix vor dem Doppelpunkt (`feat`, `fix`, `docs` …), sonst `other`.

**Antwortzeit:** Ringpuffer mit 1440 Messungen (24 Stunden) im Speicher von Container 2, ein Neustart leert ihn. Erreichbar heißt Status < 500, wie bei der App.

### Bereiche der Website

Navigation über den Hash (`#overview` als Start, `#board`, `#repo`, `#database`, `#messages`, `#server`), Seitenleiste ab 900 px, darunter eine Leiste oben. Die Seitenleiste lässt sich über den Knopf neben „zamaric dev“ oder mit `[` (nicht in Eingabefeldern) auf eine 56 px schmale Leiste mit Symbolen einklappen; die Namen erscheinen dann als Tooltip bei Hover und Fokus, der Zustand bleibt im `localStorage` (`zamaric-dev.sidebar`). Login als Fenster über der Seite wie beim Upload-Tool, Session-Check jede Minute bei sichtbarem Tab und beim Zurückkehren. Dark Mode über die Systemeinstellung, `prefers-reduced-motion` wird beachtet.

- **Übersicht** (Startbereich): aktualisiert sich jede Minute, solange der Tab sichtbar ist, beim Zurückkehren sofort, und baut sich nur neu, wenn sich etwas geändert hat. Kein Knopf und kein Hinweis darauf; schlägt ein Neuladen fehl, steht neben dem Titel „Nicht aktuell: <Grund>“. Jede Kachel außer Inhalt führt in ihren Bereich. Ab 1200 × 600 px füllt die Seite genau den Bildschirm (Ampeln oben, darunter 3 + 2 Kacheln), darunter 2 Spalten, unter 640 px 1 Spalte. Inhalt als Balken (wartende Songs schraffiert), Speicher als Ring.
  - **Ampeln:** Supabase (erreichbar mit Antwortzeit, Fehlmessungen in 24 h, bei Ausfall „seit …“), GitHub (letzter Lauf mit Commit), Integrität (Fehler und Warnungen), Cron (letzter Lauf; gelb, wenn 2 h lang keiner kam). Grau heißt unbekannt oder nicht eingerichtet. Jede Ampel hat Symbol und Text, nicht nur Farbe.
  - **Kacheln:** Inhalt (Songs, davon wartend, Playbacks, Noten, Einzähler, Kategorien), Repo (letzter Commit, diese Woche gegen Vorwoche, 12 Wochen als Säulen, zuletzt gepullt), Nächste Freigabe (überfällige als „fällig“ markiert), Speicher je Bucket, die letzten 3 Nachrichten.
- **Board:** Spalten nebeneinander, horizontal scrollbar. Spalten anlegen, inline umbenennen, über ⋯ verschieben oder am Griff ziehen, löschen (mit Rückfrage, wenn Karten drin sind). Karten mit Titel, Farbe und Markdown-Text im Editor (Schreiben/Vorschau, ⌘/Strg+Enter speichert), Spalte im Editor wählbar, per Drag & Drop innerhalb und zwischen Spalten. Änderungen erscheinen sofort, schlägt die Anfrage fehl, lädt das Board neu. Schlägt auch das Neuladen fehl, bleiben die Spalten stehen und eine Fehlerzeile mit „Erneut versuchen“ erscheint.
- **Repo** (App-Repo `zamaric`): Verlauf (nach Tag, eine Zeile pro Commit mit Art als Chip, Hash, Uhrzeit, +/− Zeilen, „Mehr laden“, „gepullt vor …“ im Kopf), Statistik (Kennzahlen inkl. Autoren, Commits pro Woche ab dem ersten Commit, Sprachen neben Commit-Arten, meistgeänderte Dateien), README gerendert mit Inhaltsverzeichnis auf Lesebreite, GitHub (letzter Lauf mit Jobs und Schritten, ältere als Tabelle, lädt jede Minute nach, solange ein Lauf noch läuft, auch nach einem Fehler).
- **Datenbank:**
  - **Integrität:** Funde von `integrity_report()`, gruppiert nach Prüfung:

    | `check_name` | Schwere | Meldet |
    |---|---|---|
    | `song_without_playback` | warning | sichtbarer Song ohne sichtbares Playback (reine Noten sind erlaubt) |
    | `letter_out_of_range` | error | Buchstabe vor 0 oder hinter dem Ende des Playbacks (genau am Ende ist erlaubt, wie beim Upload) |
    | `letter_count_in_other_song` | error | Einzähler des Buchstabens gehört zu einem anderen Song |
    | `count_in_unused` | warning | sichtbarer Einzähler ohne Buchstaben |
    | `missing_sha256` | warning | Zeile mit Datei, aber ohne Prüfsumme |
    | `file_missing` | error | Datei der Zeile fehlt im Bucket |
    | `duplicate_file` | warning | Playbacks und Einzähler: gleiche Prüfsumme mehrfach in der Tabelle (nur Zeilen mit eigener Datei). Noten: gleiche Datei in verschiedenen Songs, oder in einem Song zwei oder mehr verschiedene Dateien, die jeweils doppelt vorkommen. Ein einzelnes doppeltes Blatt pro Song (z. B. Akkordeon für mehrere Stimmen) ist gewollt |
    | `release_overdue` | error | wartende Datei-Zeile, deren `release_at` über 2 Stunden her ist (der stündliche Cron-Job hätte sie übernehmen müssen). Neue Songs werden ohne Job sichtbar und zählen nicht |
    | `replaces_other_song` | error | `replaces_id` zeigt auf eine Zeile eines anderen Songs |
    | `invalid_duration` | error | `duration_ms` ≤ 0 |
    | `display_without_effect` | warning | `display_playback`-Zeilen bei `instrument_mode` `all` |
    | `category_empty` | warning | Kategorie ohne Songs |
  - **Prüfsummen:** Knopf „Prüfsummen nachtragen“ im Kopf der Integrität, Fortschritt alle 1,5 s („12 / 42“). Ein Netzfehler wird nach 5 s erneut versucht, nach 3 Fehlern in Folge steht „Erneut versuchen“ da. Am Ende laden Integrität und Dateien neu.
  - **Unbenutzte Dateien** (`unused_files()`), Knopf „Löschen“ mit Rückfrage, danach laden Dateien, Speicher und Integrität neu. Fehlende Dateien stehen nur in der Integrität (`file_missing`).
  - **Speicher** je Bucket mit den 20 größten Dateien, **Wartende Freigaben**, **Cron-Läufe** (rechts neben den drei anderen, so viele Läufe wie in die Höhe passen, ältere aufklappbar; Meldung nur bei Fehlschlag).
- **Nachrichten:** Verlauf aus `notification_feed()`, ein Panel pro Tag, eine Zeile pro Nachricht, mit Suche und Zustellstatus aus `status_code`.
- **Server:** aktuelle Messung, Median, P95, Fehlmessungen (24 h), Verlauf als Linie mit roten Ausfällen, Ausfälle als Zeiträume, Tabelle pro Stunde. Aktualisiert sich jede Minute, solange der Tab sichtbar ist.
- **Layout:** Alle Bereiche nutzen die volle Breite mit gleichem Rand und einem Abstand (`--gap`) zwischen allen Panels. Panels einer Zeile sind gleich hoch; Paare (`pair()`) stehen unter 1200 px untereinander. Die Übersicht passt ab 1200 × 600 px ohne Scrollen auf den Bildschirm. Fehlertexte (`errorMessage`) und Zeitangaben (`describeTime`) kommen zentral aus `app.js`. Neu-laden-Knöpfe gibt es nicht, die Seite neu zu laden reicht.
