FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
WORKDIR /app
COPY package.json ./package.json
COPY src ./src
COPY public ./public
RUN mkdir -p /data && chown 65532:65532 /data
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0 DATA_DIR=/data
USER 65532:65532
EXPOSE 8080
CMD ["node", "src/server.js"]
