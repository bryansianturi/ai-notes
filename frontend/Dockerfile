# Build the static site
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY . .
RUN npm run build

# Serve it with nginx (unprivileged image: runs as a non-root user on port 8080)
FROM nginxinc/nginx-unprivileged:1.30-alpine
# Where /api/* is forwarded to; set per environment (compose / k8s)
ENV API_UPSTREAM=http://web:8000
# The nginx image fills in ${API_UPSTREAM} from files in /etc/nginx/templates at startup
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
