FROM node:22-alpine
RUN apk add --no-cache ffmpeg font-dejavu
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
# Optional AI background (person cut-out). Needs internet during the build; the studio works without it.
RUN (mkdir -p /tmp/ms && cd /tmp/ms && npm pack @mediapipe/selfie_segmentation --silent >/dev/null && tar xzf ./*.tgz \
    && mkdir -p /app/public/vendor/selfie && cp package/*.js package/*.wasm package/*.tflite package/*.binarypb package/*.json /app/public/vendor/selfie/ 2>/dev/null; \
    rm -rf /tmp/ms) || echo "AI background not installed"
RUN mkdir -p /data && chown node:node /data
USER node
ENV DATA_DIR=/data PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
