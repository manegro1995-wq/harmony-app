FROM node:20-alpine

WORKDIR /app

COPY . .

EXPOSE 3000

CMD ["npx", "http-server", ".", "-p", "3000", "--gzip"]
