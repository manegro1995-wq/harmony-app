# Zero dependencies means no `npm install` layer, no lockfile to audit,
# and nothing between the base image and the code that holds the key.
# The image is essentially Node plus three files.
FROM node:22-alpine

WORKDIR /app
COPY package.json personas.js server.js ./

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# Never run as root. If the process is ever compromised, this is the
# difference between "read the env" and "own the container".
USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
