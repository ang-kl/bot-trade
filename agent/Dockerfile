FROM node:20
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && echo "Dependencies installed successfully"
COPY . .
ENV NODE_ENV=production
EXPOSE 3001
CMD ["node", "index.js"]
