FROM python:3.13.18-slim

# Keine .pyc-Dateien, Logs sofort ausgeben statt puffern
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

# git für Commit-Verlauf, Statistik und README aus dem eingehängten .git
RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
# Login, Sessions und Fehlerbehandlung aus Backend/shared (additional_contexts in der Compose-Datei)
COPY --from=shared *.py ./
COPY *.py ./

# Nicht als root laufen. /data ist der Ordner für das Board und gehört dem
# Nutzer app. Docker übernimmt Besitzer und Rechte beim ersten Einhängen in
# das noch leere Volume board-data.
RUN useradd --system --no-create-home app \
    && mkdir /data \
    && chown app:app /data
USER app

# Genau ein Worker: Die Sessions und der Verlauf der Antwortzeiten liegen im
# Speicher dieses einen Prozesses, und der Lock für das Board gilt nur darin.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--no-server-header"]
