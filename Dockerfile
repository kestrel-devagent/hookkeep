FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY . .
ENV PORT=7860
ENV HOOKKEEP_DATA=/data
RUN mkdir -p /data
EXPOSE 7860
CMD ["node", "src/server.js"]
