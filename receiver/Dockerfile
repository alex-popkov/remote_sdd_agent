FROM node:20-alpine

WORKDIR /app

# Install deps first for better layer caching
COPY package.json package-lock.json* ./
RUN npm install --production

COPY tsconfig.json ./
COPY src ./src

# Build TS → JS
RUN npm install typescript --no-save && npx tsc

EXPOSE 3000
CMD ["node", "dist/server.js"]
