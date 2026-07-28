FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
ENV DATA_DIR=/data
EXPOSE 9601
CMD ["node", "server.js"]
