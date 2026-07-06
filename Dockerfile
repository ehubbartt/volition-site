# syntax = docker/dockerfile:1

ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-slim AS base

LABEL fly_launch_runtime="SvelteKit"

WORKDIR /app

ENV NODE_ENV="production"

# Build stage
FROM base AS build

RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y build-essential node-gyp pkg-config python-is-python3

COPY package-lock.json package.json ./
RUN npm ci --include=dev

COPY . .

RUN npm run build

RUN npm prune --omit=dev

# Final stage
FROM base

COPY --from=build /app/build build/
COPY --from=build /app/node_modules node_modules/
COPY package.json server.mjs ./

EXPOSE 3000
CMD [ "node", "server.mjs" ]
