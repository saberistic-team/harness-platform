# Build via build-native-test.mjs; its context excludes source and credentials.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
USER 0
ARG BASE_IMAGE
RUN printf '%s\n' "$BASE_IMAGE" | grep -Eq '^.+@sha256:[0-9a-f]{64}$'
RUN apk add --no-cache git \
    && npm install --global pnpm@11.23.0 \
    && npm cache clean --force \
    && addgroup -S -g 65532 sandbox \
    && adduser -S -D -H -u 65532 -G sandbox sandbox
COPY . /opt/harness-deps/
WORKDIR /opt/harness-deps
RUN pnpm install --frozen-lockfile --node-linker=hoisted \
    && mv node_modules /node_modules \
    && mkdir -p /node_modules/@harness /opt/harness \
    && node link-workspaces.mjs \
    && cp native-check.mjs native-check.config.mjs /opt/harness/ \
    && rm -rf /opt/harness-deps /root/.local/share/pnpm /root/.cache
WORKDIR /workspace
USER 65532:65532
ENTRYPOINT []
CMD ["node", "--version"]
