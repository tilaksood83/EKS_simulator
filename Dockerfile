# EKS Simulator — zero-dependency Node.js app, so no install/build step needed.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

COPY package.json server.js ./
COPY src ./src
COPY public ./public

# run as the unprivileged user bundled with the official image
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:'+process.env.PORT+'/api/state').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
