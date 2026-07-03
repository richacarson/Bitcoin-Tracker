FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production
EXPOSE 3000
# Mount a volume at /app/data to persist synced history, the price cache,
# and the login password between deploys.
CMD ["node", "server.js"]
