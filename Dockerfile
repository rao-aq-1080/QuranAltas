FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8000

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --upgrade pip && pip install --no-cache-dir -r requirements.txt

COPY . /app

WORKDIR /app/quran_backend/quran_backend

EXPOSE 8000

CMD ["sh", "-c", "gunicorn app.main:app -k uvicorn.workers.UvicornWorker --bind 0.0.0.0:${PORT:-8000}"]
