FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=7000

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 7000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:7000/health >/dev/null || exit 1

CMD ["npm", "start"]
