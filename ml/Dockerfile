FROM python:3.12-slim
WORKDIR /app
COPY ml/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt --extra-index-url https://download.pytorch.org/whl/cpu
RUN useradd --system --uid 10002 worker && mkdir -p /data && chown worker /data
COPY ml/worker.py .
USER worker
CMD ["python", "worker.py"]
