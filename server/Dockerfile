# MyAgent 记忆与压缩后端。开发模式：tsx watch，src 由 compose bind mount 覆盖。
# NODE_IMAGE 允许国内/离线环境换成镜像站或本地 retag 的基础镜像。
ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE}
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

# Agent 的 Python 子进程使用无特权 UID 运行，读不到 root 0600 的加密密钥/会话密文。
# 服务端本体仍以 root 运行（需要写持久化卷），仅对模型生成的代码降权。
ARG AGENT_UID=10001
ARG AGENT_GID=10001
RUN groupadd -g "${AGENT_GID}" agent \
    && useradd -u "${AGENT_UID}" -g "${AGENT_GID}" -m -s /usr/sbin/nologin agent

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
