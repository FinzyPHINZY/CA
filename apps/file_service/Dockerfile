# Development stage
FROM node:20-alpine AS development

WORKDIR /usr/src/app

# Install pnpm
RUN npm install -g pnpm

# Copy package files
COPY package.json pnpm-lock.yaml ./
COPY .npmrc ./
COPY tsconfig.json nest-cli.json ./

# Install dependencies
RUN pnpm install --frozen-lockfile \
  && node -e "require.resolve('@aws-sdk/s3-request-presigner/package.json')"

# Copy application files
COPY apps/file_service/ apps/file_service/
COPY libs/ libs/

# Build stage
FROM development AS build

RUN pnpm build file_service

# Production stage
FROM node:20-alpine AS production

WORKDIR /usr/src/app

# Install pnpm
RUN npm install -g pnpm

# Copy package files
COPY package.json pnpm-lock.yaml ./
COPY .npmrc ./

# Install production dependencies only
RUN pnpm install --prod --frozen-lockfile \
  && node -e "require.resolve('@aws-sdk/s3-request-presigner/package.json')"

# Copy built application
COPY --from=build /usr/src/app/dist/apps/file_service ./dist/apps/file_service

# Expose port
EXPOSE 3004

# Start the application
CMD ["node", "dist/apps/file_service/main.js"]

