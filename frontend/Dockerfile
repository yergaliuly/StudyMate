FROM node:24-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY index.html vite.config.js ./
COPY public ./public
COPY src ./src
# The browser always uses its own origin; only nginx knows the backend host.
RUN VITE_API_BASE_URL=/api/v1 npm run build

FROM nginx:1.30.5-alpine

ENV BACKEND_HOST=site--studymate-backend--wpkj64cc5mq6.code.run \
    BACKEND_PORT=443 \
    NGINX_ENVSUBST_FILTER="^(BACKEND_HOST|BACKEND_PORT)$"

COPY --from=build /app/dist /usr/share/nginx/html
COPY deploy/default.conf.template /etc/nginx/templates/default.conf.template
COPY --chmod=755 deploy/15-validate-upstream.sh /docker-entrypoint.d/15-validate-upstream.sh

EXPOSE 8080
