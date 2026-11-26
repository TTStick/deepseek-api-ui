# 基础镜像可用 --build-arg 覆盖，便于离线/私有仓库环境
ARG NODE_IMAGE=node:24-bookworm-slim
ARG NGINX_IMAGE=nginx:1.29-alpine

FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION=12.6.0

# 网络慢时走本机代理：compose 传 DOCKER_BUILD_PROXY=http://host.docker.internal:10808
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY
ENV HTTP_PROXY=${HTTP_PROXY} HTTPS_PROXY=${HTTPS_PROXY} NO_PROXY=${NO_PROXY}

RUN npm install --global pnpm@${PNPM_VERSION}
WORKDIR /app

# 依赖单独一层：package.json / lockfile 不变时直接复用缓存。
# 全程使用 node 用户（UID 1000），避免构建后对 node_modules 做 chown 造成大量拷贝。
FROM base AS deps
RUN chown node:node /app
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
USER node
RUN pnpm install --frozen-lockfile

# 开发镜像：容器内跑 rspack dev server，源码由 compose bind mount 覆盖
FROM deps AS dev
COPY --chown=node:node . .
ENV NODE_ENV=development
EXPOSE 8090
CMD ["pnpm", "dev"]

# 生产构建：静态产物输出到 /app/dist
FROM deps AS build
COPY . .
RUN pnpm build

# 生产镜像：nginx 托管静态文件
FROM ${NGINX_IMAGE} AS prod
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/healthz || exit 1
