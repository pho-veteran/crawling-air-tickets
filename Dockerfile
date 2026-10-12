FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json config.json ./
COPY src ./src
COPY scripts ./scripts
COPY tests ./tests
COPY templates ./templates
RUN mkdir data report && chown -R node:node data report
USER node
ENTRYPOINT ["node"]
CMD ["src/cli/watch.mjs"]
