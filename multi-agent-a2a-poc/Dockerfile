# One image for all three agents — docker-compose overrides the command per service.
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY shared ./shared
COPY main-agent ./main-agent
COPY executor-agent ./executor-agent
COPY verifier-agent ./verifier-agent
COPY mobile-agent ./mobile-agent
COPY browser-agent ./browser-agent
COPY scripts ./scripts

# Default command (overridden per service in docker-compose.yml)
CMD ["npm", "run", "start:main"]
