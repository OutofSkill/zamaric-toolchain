FROM python:3.13.18-slim

# Keine .pyc-Dateien, Logs sofort ausgeben statt puffern
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY *.py ./

# Nicht als root laufen
RUN useradd --system --no-create-home app
USER app

# Genau ein Worker: Die Sessions liegen im Speicher dieses einen Prozesses.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--no-server-header"]
