FROM node:20-slim
WORKDIR /app
COPY agent/package*.json ./agent/
RUN cd agent && npm ci --production
COPY api/_lib/ ./api/_lib/
COPY api/prompts/ ./api/prompts/
COPY agent/ ./agent/
ENV NODE_ENV=production
WORKDIR /app/agent
CMD ["node", "index.js"]
