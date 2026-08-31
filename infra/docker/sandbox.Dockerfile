# Supply a reviewed immutable reference, for example:
#   --build-arg NODE_IMAGE=node:22-alpine@sha256:<64-hex-digest>
ARG NODE_IMAGE
FROM ${NODE_IMAGE}

ARG NODE_IMAGE
RUN printf '%s\n' "$NODE_IMAGE" \
      | grep -Eq '^.+@sha256:[0-9a-f]{64}$'

# The sandbox image is intentionally separate from the privileged dev image.
# Package-manager installation happens at image build time; a run never needs
# egress merely to discover or download pnpm.
RUN npm install --global pnpm@11.23.0 \
    && npm cache clean --force \
    && addgroup -S -g 65532 sandbox \
    && adduser -S -D -H -u 65532 -G sandbox sandbox

ENV HOME=/tmp
WORKDIR /workspace

# The runner also pins this numeric identity with `docker run --user` so a
# future image change cannot accidentally restore root execution.
USER 65532:65532

ENTRYPOINT []
CMD ["node", "--version"]
