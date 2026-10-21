FROM node:22.23.3-alpine3.24

RUN apk add --no-cache git ca-certificates

ADD https://github.com/aaif-goose/goose/releases/download/v1.55.0/goose-aarch64-unknown-linux-musl.tar.gz /tmp/goose.tar.gz
RUN tar -xzf /tmp/goose.tar.gz -C /usr/local/bin \
 && chmod 755 /usr/local/bin/goose \
 && rm /tmp/goose.tar.gz \
 && goose --version

ENV GOOSE_PROVIDER=aws_bedrock \
    GOOSE_MODEL=deepseek.v3.2 \
    GOOSE_MODE=auto \
    GOOSE_DISABLE_SESSION_NAMING=true \
    GOOSE_PATH_ROOT=/tmp/goose

WORKDIR /opt/goose
COPY server.ts recipe.yaml /opt/goose/

EXPOSE 8080
ENTRYPOINT ["node", "/opt/goose/server.ts"]
