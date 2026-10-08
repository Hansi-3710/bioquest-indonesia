FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 BIOQUEST_ENV=production BIOQUEST_DATA_DIR=/data
WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
RUN useradd -r -u 10001 bioquest && mkdir /data && chown bioquest /data
USER bioquest
VOLUME /data
EXPOSE 8000
# SECRET_KEY and MASTER_KEY must be passed as environment variables (never baked into the image).
CMD ["gunicorn", "-w", "3", "-b", "0.0.0.0:8000", "--limit-request-line", "4094", "wsgi:app"]
