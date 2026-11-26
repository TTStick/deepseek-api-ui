# MyAgent 记忆与压缩后端。开发模式：tsx watch，src 由 compose bind mount 覆盖。
FROM node:24-bookworm-slim
ARG PNPM_VERSION=12.6.0

# 网络慢时走本机代理：compose 传 DOCKER_BUILD_PROXY=http://host.docker.internal:10808
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY
ENV HTTP_PROXY=${HTTP_PROXY} HTTPS_PROXY=${HTTPS_PROXY} NO_PROXY=${NO_PROXY}

RUN npm install --global pnpm@${PNPM_VERSION}

# Agent 隔离执行环境：python + 常用库（numpy/matplotlib/pandas/requests）
# build-essential 供 ssh2 的 optional 原生依赖（cpu-features）编译
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-pip build-essential \
    && pip3 install --break-system-packages --no-cache-dir numpy matplotlib pandas requests \
    && rm -rf /var/lib/apt/lists/*

# 导出能力：reportlab（PDF，内置 CJK 字体）+ markdown（HTML 分享页）
RUN pip3 install --break-system-packages --no-cache-dir reportlab markdown

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=myagent-server-pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
COPY test ./test
COPY scripts ./scripts

ENV NODE_ENV=development
EXPOSE 3000
CMD ["pnpm", "dev"]
