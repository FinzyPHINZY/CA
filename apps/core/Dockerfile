FROM node:alpine AS development

WORKDIR /usr/src/app

COPY package.json ./
COPY pnpm-lock.yaml ./
COPY .npmrc ./
COPY tsconfig.json tsconfig.json
COPY nest-cli.json nest-cli.json

RUN npm install -g pnpm
RUN pnpm install --frozen-lockfile

COPY apps/core/ apps/core/
COPY libs libs

RUN pnpm build


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

CMD ["node", "dist/apps/core/main"]