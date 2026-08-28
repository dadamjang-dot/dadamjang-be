FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
RUN wget -q -O /tmp/aws-rds-global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
  && echo "e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3  /tmp/aws-rds-global-bundle.pem" | sha256sum -c -
COPY . .
RUN pnpm build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY --from=build /app/dist ./dist
COPY --from=build /tmp/aws-rds-global-bundle.pem /etc/ssl/certs/aws-rds-global-bundle.pem
COPY migrations ./migrations
CMD ["pnpm", "start:prod"]
