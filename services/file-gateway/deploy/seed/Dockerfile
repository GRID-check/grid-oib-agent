FROM python:3.12-slim
WORKDIR /app
# Trust the agent egress proxy CA so pip over the intercepted TLS works.
COPY ca-bundle.crt /ca.crt
ENV PIP_CERT=/ca.crt SSL_CERT_FILE=/ca.crt
RUN pip install --no-cache-dir boto3
COPY seed.py ./
CMD ["python", "seed.py"]
