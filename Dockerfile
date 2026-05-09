FROM python:3.12-alpine

WORKDIR /app

COPY index.html README.md ./
COPY src ./src

EXPOSE 8839

CMD ["python", "-m", "http.server", "8839", "--bind", "0.0.0.0"]
