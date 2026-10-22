FROM node:22.23.3-alpine3.24

RUN apk add --no-cache git ca-certificates

ADD https://github.com/aaif-goose/goose/releases/download/v1.55.0/goose-aarch64-unknown-linux-musl.tar.gz /tmp/goose.tar.gz
RUN tar -xzf /tmp/goose.tar.gz -C /usr/local/bin \
 && chmod 755 /usr/local/bin/goose \
 && rm /tmp/goose.tar.gz \
 && goose --version

WORKDIR /opt
COPY goose/server.ts /opt/src/goose/server.ts
COPY lib /opt/src/lib
RUN npm install --omit=dev esbuild @aws-sdk/client-dynamodb@3.1152.0 @aws-sdk/lib-dynamodb@3.1152.0 @aws-sdk/client-secrets-manager@3.1152.0 \
 && npx esbuild /opt/src/goose/server.ts --bundle --platform=node --format=cjs --outfile=/opt/goose/server.js

ENV GOOSE_PROVIDER=aws_bedrock \
    GOOSE_MODEL=us.anthropic.claude-sonnet-4-6 \
    GOOSE_MODE=auto \
    GOOSE_DISABLE_SESSION_NAMING=true \
    GOOSE_PATH_ROOT=/tmp/goose

WORKDIR /opt/goose
COPY goose/recipe.yaml /opt/goose/

EXPOSE 8080
ENTRYPOINT ["node", "/opt/goose/server.js"]
