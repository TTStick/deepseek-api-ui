import path from 'node:path'

/** 服务端环境配置：DeepSeek 直连凭据与 Honcho 自托管地址 */
const read = (name: string, fallback: string): string => {
  const value = process.env[name]
  return typeof value === 'string' && value !== '' ? value : fallback
}

const dataRoot = read('DATA_ROOT', '/app/data')

export const env = {
  port: Number(process.env.PORT ?? 3000),
  /** 浏览器未带 key 时的兜底凭据（压缩摘要、查询改写共用） */
  deepseekApiKey: read('DEEPSEEK_API_KEY', ''),
  deepseekApiOrigin: read('DEEPSEEK_API_ORIGIN', 'https://api.deepseek.com'),
  honchoBaseUrl: read('HONCHO_BASE_URL', ''),
  honchoApiKey: read('HONCHO_API_KEY', ''),
  honchoEnvironment: read('HONCHO_ENVIRONMENT', 'local'),
  honchoWorkspace: read('HONCHO_WORKSPACE', 'myagent'),
  /** agent 工作区根目录（compose 挂载持久化卷） */
  workspaceRoot: read('WORKSPACE_ROOT', '/app/workspaces'),
  /** python 解释器路径（server 镜像内置） */
  pythonPath: read('PYTHON_PATH', 'python3'),
  /** 访问密码与会话密钥的持久化目录 */
  dataRoot,
  /**
   * 静态加密主密钥：优先读 DATA_ENCRYPTION_KEY（base64/hex/32 字节原文），
   * 否则从 DATA_ENCRYPTION_KEY_FILE 读取；都不存在时首次启动生成。
   */
  dataEncryptionKey: read('DATA_ENCRYPTION_KEY', ''),
  dataEncryptionKeyFile: read(
    'DATA_ENCRYPTION_KEY_FILE',
    path.join(dataRoot, 'encryption.key')
  ),
  /** Python 执行时的临时解密目录；默认使用容器内存盘，避免明文落盘 */
  execTmpRoot: read('EXEC_TMP_ROOT', '/dev/shm'),
  /** Python 子进程使用的无特权 UID/GID（容器以 root 启动时生效，隔离加密密钥） */
  agentExecUid: Math.max(1, Number(read('AGENT_EXEC_UID', '10001')) || 10001),
  agentExecGid: Math.max(1, Number(read('AGENT_EXEC_GID', '10001')) || 10001),
  /** 初始访问密码（仅首次启动、尚未通过界面设置时生效） */
  accessPassword: read('ACCESS_PASSWORD', ''),
  /** 公网部署：强制要求已设置访问密码（未设置时拒绝所有业务接口） */
  requireAuth: read('REQUIRE_AUTH', 'false') === 'true',
  /** SSH 工具是否允许连接内网/回环地址（默认禁止，防 SSRF；局域网自用可设 true） */
  sshAllowPrivateHosts: read('SSH_ALLOW_PRIVATE_HOSTS', 'false') === 'true',
  /** 单 IP 每分钟聊天/压缩请求上限，防止共享口令被用来刷服务端 LLM 额度 */
  chatRateLimitPerMinute: Math.max(
    1,
    Number(read('CHAT_RATE_LIMIT_PER_MINUTE', '30')) || 30
  ),
  /**
   * 是否信任 X-Forwarded-For。默认 false（用 TCP 对端地址，防止伪造头绕过限速）；
   * 仅当服务端只经可信反向代理（nginx/Caddy 会覆写 XFF）暴露时设为 true。
   */
  trustProxy: read('TRUST_PROXY', 'false') === 'true',
  /** 允许客户端请求的模型白名单，防止用服务端密钥调用未授权/更贵的模型 */
  allowedModels: new Set(
    read('ALLOWED_MODELS', 'deepseek-flash,deepseek-v4-pro')
      .split(',')
      .map((model) => model.trim())
      .filter(Boolean)
  ),
  /** 允许跨域访问的来源（手机 WebView 本地页 + 本地预览）；逗号分隔 */
  corsOrigins: new Set(
    read(
      'CORS_ORIGINS',
      'https://appassets.androidplatform.net,http://localhost:8100,http://127.0.0.1:8100'
    )
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean)
  ),
} as const
