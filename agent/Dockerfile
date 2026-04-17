FROM node:20 AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

FROM node:20-slim
WORKDIR /app
COPY --from=builder /app .
ENV NODE_ENV=production
CMD ["node", "index.js"]
