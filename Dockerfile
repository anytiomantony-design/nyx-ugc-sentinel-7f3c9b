FROM node:18-slim

# Install libs playwright needs
RUN apt-get update && apt-get install -y wget ca-certificates libnss3 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libx11-xcb1 libxcomposite1 libasound2 libxrandr2 libdrm2 libpangocairo-1.0-0 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --production || npm i --production
# Install browsers
RUN npx playwright install --with-deps

COPY . .

ENV NODE_ENV=production
CMD ["node", "monitor.js"]
