FROM node:24-bookworm-slim
WORKDIR /app
COPY config.json run.mjs watch.mjs telegram.mjs daily.mjs bot.mjs stop.mjs ./
COPY lib ./lib
COPY templates ./templates
RUN mkdir data report && chown -R node:node data report
USER node
ENTRYPOINT ["node"]
CMD ["watch.mjs"]
