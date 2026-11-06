"""GET /api/git/*, /api/readme und /api/ci: Commit-Verlauf, Statistik, README und GitHub-Status.

Das Repo liegt auf dem Pi und wird dort automatisch gepullt. Container 2 bekommt
nur dessen .git schreibgeschützt eingehängt (settings.git_dir), keinen
Arbeitsbaum. So sieht er weder .env-Dateien noch Backend/stuecke.

Alle git-Befehle lesen nur und laufen ohne Shell mit fester Argumentliste.
Ergebnisse werden je HEAD-Hash im Speicher gehalten: Nach dem nächsten Pull
ändert sich der Hash und alles wird einmal neu berechnet.
"""

import asyncio
import logging
import os
import re
import time
from collections import Counter
from datetime import UTC, date, datetime, timedelta
from typing import Annotated
from zoneinfo import ZoneInfo

import httpx
from fastapi import APIRouter, Depends, Query

from config import settings
from errors import ApiError
from sessions import current_session

logger = logging.getLogger("zamaric")

router = APIRouter(dependencies=[Depends(current_session)])

# Obergrenze für einen git-Aufruf in Sekunden. Die Statistik liest einmal den
# ganzen HEAD-Baum und bekommt deshalb mehr Zeit.
GIT_TIMEOUT_SECONDS = 15
GIT_STATS_TIMEOUT_SECONDS = 60

# Größere Dateien werden für die Statistik nicht gelesen, nur gezählt.
MAX_BLOB_BYTES = 2 * 1024 * 1024
# So viele Bytes vom Anfang einer Datei entscheiden, ob sie binär ist.
BINARY_SNIFF_BYTES = 8000

STATS_WEEKS = 52
HOT_FILES_DAYS = 90
HOT_FILES_COUNT = 15

GITHUB_API = "https://api.github.com"
GITHUB_TIMEOUT_SECONDS = 10
# Länger als der Takt der Übersicht (60 s), damit nicht jede Abfrage GitHub erreicht
GITHUB_CACHE_SECONDS = 120

# Wochen beginnen Montag 00:00 in deutscher Zeit, nicht in UTC
WEEK_ZONE = ZoneInfo("Europe/Berlin")
GITHUB_RUN_COUNT = 15

# Trennzeichen für git log: Unit Separator zwischen Feldern, Record Separator
# vor jedem Commit. Beide kommen in Commit-Texten praktisch nie vor.
FIELD = "\x1f"
RECORD = "\x1e"

# Präfix eines Commit-Betreffs wie "feat:", "fix(player):" oder "feat!:"
COMMIT_TYPE = re.compile(r"^([a-z]+)(?:\([^)]*\))?!?:")

LANGUAGES = {
    "dart": "Dart",
    "py": "Python",
    "sql": "SQL",
    "js": "JavaScript",
    "mjs": "JavaScript",
    "ts": "TypeScript",
    "css": "CSS",
    "html": "HTML",
    "md": "Markdown",
    "yml": "YAML",
    "yaml": "YAML",
    "sh": "Shell",
    "pl": "Perl",
    "swift": "Swift",
    "m": "Objective-C",
    "mm": "Objective-C",
    "c": "C/C++",
    "cc": "C/C++",
    "cpp": "C/C++",
    "h": "C/C++",
    "cmake": "CMake",
    "pbxproj": "Xcode",
    "xcconfig": "Xcode",
    "xcsettings": "Xcode",
    "xcscheme": "Xcode",
    "xcworkspacedata": "Xcode",
    "entitlements": "Xcode",
    "storyboard": "Xcode",
    "xib": "Xcode",
    "kt": "Kotlin",
    "kts": "Kotlin",
    "gradle": "Gradle",
    "json": "JSON",
    "xml": "XML",
    "plist": "XML",
    "svg": "SVG",
    "conf": "Konfiguration",
    "toml": "Konfiguration",
    "properties": "Konfiguration",
    "lock": "Konfiguration",
    "metadata": "Konfiguration",
    "txt": "Text",
    "png": "Bilder",
    "jpg": "Bilder",
    "jpeg": "Bilder",
    "gif": "Bilder",
    "webp": "Bilder",
    "ico": "Bilder",
    "ttf": "Schriften",
    "otf": "Schriften",
    "woff": "Schriften",
    "woff2": "Schriften",
    "mp3": "Audio",
    "wav": "Audio",
    "pdf": "PDF",
}

FILE_NAMES = {
    "dockerfile": "Docker",
    "makefile": "Shell",
    "cmakelists.txt": "CMake",
    ".gitignore": "Konfiguration",
    ".dockerignore": "Konfiguration",
    ".metadata": "Konfiguration",
}

OTHER_LANGUAGE = "Andere"


# ---------------------------------------------------------------------------
# git aufrufen
# ---------------------------------------------------------------------------

async def run_git(*args: str, stdin: bytes | None = None, timeout: float = GIT_TIMEOUT_SECONDS) -> bytes:
    """Führt einen lesenden git-Befehl gegen settings.git_dir aus und gibt stdout zurück.

    safe.directory=*: Das eingehängte .git gehört einem anderen Nutzer als dem
    im Container, git würde sonst die Arbeit verweigern. core.quotePath=false
    liefert Pfade mit Umlauten unverändert statt in Oktal-Schreibweise.
    GIT_OPTIONAL_LOCKS=0 verhindert, dass git nebenbei etwas schreiben will.
    """
    if not os.path.isdir(settings.git_dir):
        raise ApiError(503, "repo_unavailable", f"{settings.git_dir} fehlt")
    command = ["git", "-c", "safe.directory=*", "-c", "core.quotePath=false", f"--git-dir={settings.git_dir}", *args]
    environment = {**os.environ, "GIT_OPTIONAL_LOCKS": "0", "GIT_TERMINAL_PROMPT": "0"}
    try:
        process = await asyncio.create_subprocess_exec(
            *command,
            stdin=asyncio.subprocess.PIPE if stdin is not None else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=environment,
        )
    except OSError as error:
        raise ApiError(503, "repo_unavailable", f"git nicht startbar ({type(error).__name__})") from None
    try:
        output, errors = await asyncio.wait_for(process.communicate(stdin), timeout)
    except TimeoutError:
        process.kill()
        await process.wait()
        raise ApiError(503, "repo_unavailable", f"git {args[0]} nach {timeout} s abgebrochen") from None
    if process.returncode != 0:
        message = errors.decode("utf-8", "replace").strip()[:300]
        raise ApiError(503, "repo_unavailable", f"git {args[0]} → {process.returncode}: {message}")
    return output


async def current_head() -> str:
    return (await run_git("rev-parse", "--verify", "HEAD")).decode().strip()


def fetched_at() -> str | None:
    """Zeitpunkt des letzten Pulls auf dem Pi: Änderungszeit von FETCH_HEAD."""
    try:
        modified = os.stat(os.path.join(settings.git_dir, "FETCH_HEAD")).st_mtime
    except OSError:
        return None
    return datetime.fromtimestamp(modified, UTC).isoformat()


def to_utc(value: str) -> str:
    """ISO-Zeit von git (mit Zeitzone des Autors) → ISO-Zeit in UTC."""
    return datetime.fromisoformat(value).astimezone(UTC).isoformat()


class HeadCache:
    """Merkt sich Ergebnisse zum aktuellen HEAD und vergisst alles bei einem neuen."""

    def __init__(self, max_entries: int = 64) -> None:
        self.head: str | None = None
        self.entries: dict = {}
        self.max_entries = max_entries

    def get(self, head: str, key):
        if head != self.head:
            self.head = head
            self.entries.clear()
        return self.entries.get(key)

    def put(self, head: str, key, value) -> None:
        if head != self.head:
            self.head = head
            self.entries.clear()
        if len(self.entries) >= self.max_entries:
            self.entries.clear()
        self.entries[key] = value


cache = HeadCache()
# Die Statistik liest den ganzen Baum. Kommen zwei Anfragen gleichzeitig,
# rechnet nur die erste, die zweite nimmt danach das Ergebnis aus dem Cache.
stats_lock = asyncio.Lock()


# ---------------------------------------------------------------------------
# Commits
# ---------------------------------------------------------------------------

def parse_commits(output: str) -> list[dict]:
    """Zerlegt die Ausgabe von git log mit COMMIT_FORMAT und --numstat."""
    commits = []
    for record in output.split(RECORD):
        if not record.strip():
            continue
        fields = record.split(FIELD)
        if len(fields) < 7:
            logger.warning("Commit-Eintrag nicht lesbar (%d Felder)", len(fields))
            continue
        full_hash, short, author, authored_at, subject, body, numstat = fields[:7]
        files = insertions = deletions = 0
        for line in numstat.splitlines():
            parts = line.split("\t", 2)
            if len(parts) != 3:
                continue
            files += 1
            # Binärdateien haben "-" statt Zeilenzahlen
            if parts[0].isdigit():
                insertions += int(parts[0])
            if parts[1].isdigit():
                deletions += int(parts[1])
        commits.append(
            {
                "hash": full_hash,
                "short": short,
                "author": author,
                "date": to_utc(authored_at),
                "subject": subject,
                "body": body.strip(),
                "files": files,
                "insertions": insertions,
                "deletions": deletions,
            }
        )
    return commits


# Pro Commit: Hash, Kurz-Hash, Autor, Zeit, Betreff, Text, danach die numstat-Zeilen
COMMIT_FORMAT = f"{RECORD}%H{FIELD}%h{FIELD}%an{FIELD}%aI{FIELD}%s{FIELD}%b{FIELD}"


async def load_commits(head: str, skip: int, limit: int) -> dict:
    cached = cache.get(head, ("commits", skip, limit))
    if cached is not None:
        return cached
    total = cache.get(head, "total")
    if total is None:
        total = int((await run_git("rev-list", "--count", head)).decode().strip())
        cache.put(head, "total", total)
    output = await run_git(
        "log", f"--format={COMMIT_FORMAT}", "--numstat", f"--skip={skip}", "-n", str(limit), head
    )
    result = {"total": total, "commits": parse_commits(output.decode("utf-8", "replace"))}
    cache.put(head, ("commits", skip, limit), result)
    return result


@router.get("/api/git/commits")
async def get_commits(
    skip: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> dict:
    head = await current_head()
    page = await load_commits(head, skip, limit)
    return {"head": head, "fetched_at": fetched_at(), **page}


# ---------------------------------------------------------------------------
# Statistik
# ---------------------------------------------------------------------------

def commit_type(subject: str) -> str:
    match = COMMIT_TYPE.match(subject.strip().lower())
    return match.group(1) if match else "other"


def week_start(day: date) -> date:
    """Montag der Woche, day ist ein Datum in WEEK_ZONE."""
    return day - timedelta(days=day.weekday())


def summarize_history(output: str) -> dict:
    """Autoren, erste/letzte Commit-Zeit und Commit-Typen aus git log.

    Die Wochen stehen nicht hier, sondern in week_list(): Die hängen vom
    heutigen Datum ab und dürfen nicht mit dem HEAD gecacht werden.
    """
    authors = Counter()
    types = Counter()
    times = []
    for line in output.splitlines():
        parts = line.split(FIELD, 2)
        if len(parts) != 3:
            continue
        authored_at, author, subject = parts
        moment = datetime.fromisoformat(authored_at).astimezone(UTC)
        times.append(moment)
        authors[author] += 1
        types[commit_type(subject)] += 1
    return {
        "total_commits": len(times),
        "first_commit_at": min(times).isoformat() if times else None,
        "last_commit_at": max(times).isoformat() if times else None,
        "authors": [{"name": name, "commits": count} for name, count in authors.most_common()],
        "types": [{"type": name, "commits": count} for name, count in types.most_common()],
    }


def count_weeks(output: str) -> Counter:
    """Commits pro Wochenbeginn aus `git log --format=%aI`."""
    per_week = Counter()
    for line in output.splitlines():
        if line.strip():
            moment = datetime.fromisoformat(line.strip()).astimezone(WEEK_ZONE)
            per_week[week_start(moment.date())] += 1
    return per_week


def week_list(per_week: Counter, today: date, count: int) -> list[dict]:
    """Die letzten count Wochen bis einschließlich der laufenden, lückenlos."""
    newest_week = week_start(today)
    return [
        {"week_start": start.isoformat(), "commits": per_week.get(start, 0)}
        for start in (newest_week - timedelta(weeks=offset) for offset in range(count - 1, -1, -1))
    ]


async def commit_weeks(head: str, count: int = STATS_WEEKS) -> list[dict]:
    """Commits pro Woche, die laufende Woche zuletzt.

    Gecacht wird nur die Zählung je HEAD. Die Liste wird bei jedem Aufruf mit
    dem heutigen Datum gebaut, damit „diese Woche“ nach einem Wochenwechsel
    ohne neuen Commit stimmt.
    """
    per_week = cache.get(head, "week_counts")
    if per_week is None:
        output = await run_git("log", "--format=%aI", head, timeout=GIT_STATS_TIMEOUT_SECONDS)
        per_week = count_weeks(output.decode("utf-8", "replace"))
        cache.put(head, "week_counts", per_week)
    return week_list(per_week, datetime.now(WEEK_ZONE).date(), count)


def language_of(path: str) -> str:
    name = path.rsplit("/", 1)[-1].lower()
    if name in FILE_NAMES:
        return FILE_NAMES[name]
    _, extension = os.path.splitext(name)
    return LANGUAGES.get(extension.lstrip("."), OTHER_LANGUAGE)


def parse_tree(output: bytes) -> list[tuple[str, str, int | None]]:
    """Zerlegt git ls-tree -r -l -z in (Pfad, Objekt, Größe). Nur Dateien, keine Submodule."""
    entries = []
    for entry in output.split(b"\0"):
        if not entry:
            continue
        meta, _, raw_path = entry.partition(b"\t")
        parts = meta.split()
        if len(parts) != 4 or parts[1] != b"blob":
            continue
        size = int(parts[3]) if parts[3].isdigit() else None
        entries.append((raw_path.decode("utf-8", "replace"), parts[2].decode(), size))
    return entries


def parse_batch(output: bytes) -> dict[str, bytes]:
    """Zerlegt die Ausgabe von git cat-file --batch in Objekt → Inhalt."""
    contents = {}
    position = 0
    while position < len(output):
        line_end = output.find(b"\n", position)
        if line_end == -1:
            break
        header = output[position:line_end].split()
        position = line_end + 1
        if len(header) != 3:
            # "<objekt> missing": kein Inhalt, keine Leerzeile dahinter
            continue
        size = int(header[2])
        contents[header[0].decode()] = output[position : position + size]
        # Nach dem Inhalt folgt ein Zeilenumbruch
        position += size + 1
    return contents


def count_lines(content: bytes) -> int:
    if not content:
        return 0
    return content.count(b"\n") + (0 if content.endswith(b"\n") else 1)


async def language_summary(head: str) -> list[dict]:
    """Dateien und Zeilen je Sprache im HEAD-Baum, ohne Arbeitsbaum."""
    tree = parse_tree(await run_git("ls-tree", "-r", "-l", "-z", head))
    readable = sorted({obj for _, obj, size in tree if size is not None and size <= MAX_BLOB_BYTES})
    contents = {}
    if readable:
        batch = await run_git(
            "cat-file", "--batch", stdin=("\n".join(readable) + "\n").encode(), timeout=GIT_STATS_TIMEOUT_SECONDS
        )
        contents = parse_batch(batch)

    files = Counter()
    lines = Counter()
    for path, obj, _ in tree:
        language = language_of(path)
        files[language] += 1
        content = contents.get(obj)
        # Binärdateien und zu große Dateien zählen nur als Datei
        if content is None or b"\0" in content[:BINARY_SNIFF_BYTES]:
            continue
        lines[language] += count_lines(content)

    summary = [{"language": language, "files": count, "lines": lines.get(language, 0)} for language, count in files.items()]
    summary.sort(key=lambda item: (-item["lines"], -item["files"], item["language"]))
    return summary


async def hot_files(head: str) -> list[dict]:
    """Die in den letzten HOT_FILES_DAYS Tagen am häufigsten geänderten Dateien."""
    output = await run_git("log", f"--since={HOT_FILES_DAYS} days ago", "--format=", "--name-only", head)
    changes = Counter(line for line in output.decode("utf-8", "replace").splitlines() if line.strip())
    return [{"path": path, "changes": count} for path, count in changes.most_common(HOT_FILES_COUNT)]


async def load_stats(head: str) -> dict:
    cached = cache.get(head, "stats")
    if cached is not None:
        return cached
    async with stats_lock:
        cached = cache.get(head, "stats")
        if cached is not None:
            return cached
        started = time.monotonic()
        history = await run_git("log", f"--format=%aI{FIELD}%an{FIELD}%s", head, timeout=GIT_STATS_TIMEOUT_SECONDS)
        stats = {
            "head": head,
            **summarize_history(history.decode("utf-8", "replace")),
            "languages": await language_summary(head),
            "hot_files": await hot_files(head),
        }
        cache.put(head, "stats", stats)
        logger.info("Repo-Statistik für %s berechnet (%d ms)", head[:7], (time.monotonic() - started) * 1000)
        return stats


@router.get("/api/git/stats")
async def get_stats() -> dict:
    head = await current_head()
    return {**await load_stats(head), "weeks": await commit_weeks(head)}


# ---------------------------------------------------------------------------
# README
# ---------------------------------------------------------------------------

@router.get("/api/readme")
async def get_readme() -> dict:
    head = await current_head()
    markdown = cache.get(head, "readme")
    if markdown is None:
        markdown = (await run_git("show", f"{head}:README.md")).decode("utf-8", "replace")
        cache.put(head, "readme", markdown)
    return {"head": head, "markdown": markdown}


# ---------------------------------------------------------------------------
# GitHub Actions
# ---------------------------------------------------------------------------

# (Zeitpunkt aus time.monotonic(), Antwort) der letzten erfolgreichen Abfrage
ci_cache: tuple[float, dict] | None = None
ci_lock = asyncio.Lock()


def github_headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {settings.github_token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }


async def github_get(client: httpx.AsyncClient, path: str) -> dict:
    """GET gegen die GitHub-API. Fehler nennen nur Pfad und Status, nie den Token."""
    try:
        response = await client.get(f"{GITHUB_API}{path}", headers=github_headers())
    except httpx.HTTPError as error:
        raise ApiError(502, "github_failed", f"{path}: {type(error).__name__}") from None
    if response.status_code != 200:
        raise ApiError(502, "github_failed", f"{path} → {response.status_code}")
    try:
        return response.json()
    except ValueError:
        raise ApiError(502, "github_failed", f"{path}: keine JSON-Antwort") from None


def simplify_run(run: dict) -> dict:
    return {
        "id": run.get("id"),
        "status": run.get("status"),
        "conclusion": run.get("conclusion"),
        "branch": run.get("head_branch"),
        "commit": run.get("head_sha"),
        "title": run.get("display_title"),
        "event": run.get("event"),
        "started_at": run.get("run_started_at"),
        "updated_at": run.get("updated_at"),
        "url": run.get("html_url"),
    }


def simplify_job(job: dict) -> dict:
    return {
        "name": job.get("name"),
        "status": job.get("status"),
        "conclusion": job.get("conclusion"),
        "steps": [
            {"name": step.get("name"), "status": step.get("status"), "conclusion": step.get("conclusion")}
            for step in job.get("steps") or []
        ],
    }


async def load_ci() -> dict:
    global ci_cache
    if not settings.github_token:
        return {"configured": False, "runs": [], "latest_jobs": []}
    async with ci_lock:
        if ci_cache is not None and time.monotonic() - ci_cache[0] < GITHUB_CACHE_SECONDS:
            return ci_cache[1]
        repository = settings.github_repository
        async with httpx.AsyncClient(timeout=GITHUB_TIMEOUT_SECONDS) as client:
            runs = await github_get(
                client, f"/repos/{repository}/actions/workflows/{settings.github_workflow}/runs?per_page={GITHUB_RUN_COUNT}"
            )
            run_list = [simplify_run(run) for run in runs.get("workflow_runs") or []]
            latest_jobs = []
            if run_list:
                jobs = await github_get(client, f"/repos/{repository}/actions/runs/{run_list[0]['id']}/jobs")
                latest_jobs = [simplify_job(job) for job in jobs.get("jobs") or []]
        result = {"configured": True, "runs": run_list, "latest_jobs": latest_jobs}
        ci_cache = (time.monotonic(), result)
        return result


@router.get("/api/ci")
async def get_ci() -> dict:
    return await load_ci()
