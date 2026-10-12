FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json config.json ./
COPY src ./src
COPY scripts ./scripts
COPY tests ./tests
RUN mkdir data && chown -R node:node data
USER node
ENTRYPOINT ["node"]
CMD ["src/cli/watch.mjs"]
