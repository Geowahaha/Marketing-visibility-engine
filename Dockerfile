FROM python:3.12-slim
WORKDIR /app
ARG APP_VERSION=0.3.0
ARG BUILD_SHA=dev
ARG BUILD_TIME=unknown
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 APP_VERSION=${APP_VERSION} BUILD_SHA=${BUILD_SHA} BUILD_TIME=${BUILD_TIME} VISIBILITY_ENGINE_DATA_DIR=/data
COPY requirements.txt pyproject.toml README.md ./
COPY visibility_engine ./visibility_engine
RUN pip install --no-cache-dir -r requirements.txt && pip install --no-cache-dir .
EXPOSE 8090
CMD ["uvicorn", "visibility_engine.api:app", "--host", "0.0.0.0", "--port", "8090"]
