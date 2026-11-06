FROM node:alpine AS development

WORKDIR /usr/src/app

# Install pnpm
RUN npm install -g pnpm

# Copy dependency files first for better caching
COPY package.json ./
COPY pnpm-lock.yaml ./
COPY .npmrc ./
COPY tsconfig.json tsconfig.json
COPY nest-cli.json nest-cli.json

# Install all dependencies (.npmrc: shamefully-hoist for webpack in monorepo)
RUN pnpm install --frozen-lockfile

COPY apps/ai_service/ apps/ai_service/
COPY libs libs

RUN pnpm build ai_service


FROM node:alpine AS production

ARG NODE_ENV=production
ENV NODE_ENV=${NODE_ENV}

WORKDIR /usr/src/app

COPY package.json ./
COPY pnpm-lock.yaml ./
COPY .npmrc ./

RUN npm install -g pnpm
RUN pnpm install --prod --frozen-lockfile

COPY --from=development /usr/src/app/dist ./dist

CMD ["node", "dist/apps/ai_service/main"]

