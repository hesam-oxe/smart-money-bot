FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
EXPOSE 8080
ENV PROVIDER=kraken
# Paper-trade live loop (signals + Telegram). For the dashboard run:
#   docker run -p 8080:8080 --env-file .env <image> npm run dashboard
CMD ["npm", "run", "paper"]
