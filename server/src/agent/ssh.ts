import { Client, type ConnectConfig } from 'ssh2'
import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import path from 'node:path'
import { getRuntimeConfig } from '../runtimeConfig.js'

/**
 * 每会话 SSH 连接（对话级主机资源，不跨会话共享）：
 * - 密码或私钥认证（claude-code 的 SSH 会话概念移植）
 * - 文件操作走 SFTP，执行走 exec 通道
 * - 所有远程路径限定在配置的 remotePath 内
 */

export type SshConfig = {
  host: string
  port: number
  username: string
  /** 二选一：密码或私钥（OpenSSH PEM 文本） */
  password?: string
  privateKey?: string
  /** 远程工作目录（绝对路径） */
  remotePath: string
}

export type SshExecResult = {
  stdout: string
  stderr: string
  exitCode: number | null
}

const MAX_FILE_SIZE = 2 * 1024 * 1024
const OUTPUT_LIMIT = 200 * 1024
const CONNECT_TIMEOUT_MS = 10_000
const EXEC_TIMEOUT_MS = 60_000

export class SshError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SshError'
  }
}

/**
 * SSRF 防护：SSH 测试/连接会让服务端主动出站，默认禁止回环、内网、
 * 链路本地与云元数据地址。确实需要连局域网机器时显式设置
 * SSH_ALLOW_PRIVATE_HOSTS=true（公网部署不建议）。
 */
const blockedHosts = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blockedHosts.addSubnet(network, prefix, 'ipv4')
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blockedHosts.addSubnet(network, prefix, 'ipv6')
}
const BLOCKED_NAMES = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'instance-data',
  'instance-data.ec2.internal',
])

/** 解析并固定到具体 IP，同时阻断 DNS 重绑定到内网 */
const resolveSshTarget = async (host: string): Promise<string> => {
  const trimmed = host.trim()
  if (getRuntimeConfig().sshAllowPrivateHosts) {
    return trimmed
  }
  const lowered = trimmed.toLowerCase()
  if (BLOCKED_NAMES.has(lowered)) {
    throw new SshError('目标地址不允许：默认禁止回环与云元数据地址')
  }
  const literalFamily = isIP(lowered)
  if (literalFamily !== 0) {
    const family = literalFamily === 6 ? 'ipv6' : 'ipv4'
    if (blockedHosts.check(lowered, family)) {
      throw new SshError('目标地址不允许：默认禁止内网/回环/链路本地地址')
    }
    return lowered
  }
  const records = await lookup(lowered, { all: true, verbatim: true }).catch(() => [])
  const allowed = records.filter(
    (record) => !blockedHosts.check(record.address, record.family === 6 ? 'ipv6' : 'ipv4')
  )
  if (allowed.length === 0) {
    throw new SshError('目标地址不允许：主机不可解析或解析到内网/回环地址')
  }
  // 固定到校验过的 IP，避免两次解析之间被重绑定到内网
  return allowed[0]!.address
}

const fingerprint = (config: SshConfig): string =>
  JSON.stringify([config.host, config.port, config.username, Boolean(config.privateKey), config.remotePath])

export class SshSession {
  private constructor(
    private readonly client: Client,
    readonly config: SshConfig,
    readonly fingerprint: string
  ) {}

  static async connect(config: SshConfig): Promise<SshSession> {
    if (!config.host || !config.username || !config.remotePath) {
      throw new SshError('SSH 配置不完整：需要 host、username 与 remotePath')
    }
    if (!config.password && !config.privateKey) {
      throw new SshError('SSH 配置不完整：需要密码或私钥')
    }
    const client = new Client()
    const connectConfig: ConnectConfig = {
      host: await resolveSshTarget(config.host),
      port: config.port || 22,
      username: config.username,
      readyTimeout: CONNECT_TIMEOUT_MS,
      keepaliveInterval: 15_000,
    }
    if (config.privateKey) {
      connectConfig.privateKey = config.privateKey
    } else if (config.password) {
      connectConfig.password = config.password
    }
    await new Promise<void>((resolve, reject) => {
      client
        .on('ready', () => resolve())
        .on('error', (error) => reject(new SshError(error.message)))
        .connect(connectConfig)
    })
    return new SshSession(client, config, fingerprint(config))
  }

  /** 远程路径解析（posix 语义，防越出 remotePath） */
  private resolve(relativePath: string): string {
    const root = this.config.remotePath.replace(/\/+$/, '') || '/'
    const resolved = path.posix.resolve(root, relativePath || '.')
    if (resolved !== root && !resolved.startsWith(root + '/')) {
      throw new SshError(`路径越出远程工作目录：${relativePath}`)
    }
    return resolved
  }

  private sftp(): Promise<import('ssh2').SFTPWrapper> {
    return new Promise((resolve, reject) => {
      this.client.sftp((error, sftp) => (error ? reject(new SshError(error.message)) : resolve(sftp)))
    })
  }

  async listDir(relativePath = ''): Promise<Array<{ name: string; type: 'file' | 'dir'; size?: number }>> {
    const sftp = await this.sftp()
    const target = this.resolve(relativePath)
    const entries = await new Promise<import('ssh2').FileEntry[]>((resolve, reject) => {
      sftp.readdir(target, (error, list) => (error ? reject(new SshError(error.message)) : resolve(list)))
    })
    return entries
      .sort((a, b) => a.filename.localeCompare(b.filename))
      .slice(0, 200)
      .map((entry) => ({
        name: entry.filename,
        type: entry.longname.startsWith('d') ? ('dir' as const) : ('file' as const),
        size: entry.attrs.size,
      }))
  }

  async readFile(relativePath: string): Promise<string> {
    const sftp = await this.sftp()
    const target = this.resolve(relativePath)
    const stream = sftp.createReadStream(target)
    const chunks: Buffer[] = []
    let total = 0
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => {
        total += chunk.length
        if (total > MAX_FILE_SIZE) {
          stream.destroy(new SshError('文件过大（>2MB），无法读取'))
          return
        }
        chunks.push(chunk)
      })
      stream.on('error', (error: Error) => reject(new SshError(error.message)))
      stream.on('close', () => resolve())
    })
    return Buffer.concat(chunks).toString('utf8')
  }

  async writeFile(relativePath: string, content: string): Promise<void> {
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_SIZE) {
      throw new SshError('内容超过 2MB 上限')
    }
    const sftp = await this.sftp()
    const target = this.resolve(relativePath)
    await new Promise<void>((resolve) => {
      sftp.mkdir(path.posix.dirname(target), { mode: 0o755 }, () => {
        // 目录已存在等错误忽略，真正的问题由写文件时报出
        resolve()
      })
    })
    await new Promise<void>((resolve, reject) => {
      const stream = sftp.createWriteStream(target)
      stream.on('error', (error: Error) => reject(new SshError(error.message)))
      stream.on('close', () => resolve())
      stream.end(content, 'utf8')
    })
  }

  async deleteFile(relativePath: string): Promise<void> {
    const sftp = await this.sftp()
    const target = this.resolve(relativePath)
    await new Promise<void>((resolve) => {
      sftp.rmdir(target, () => resolve())
      sftp.unlink(target, () => {
        // 目录已通过 rmdir 删除时 unlink 报错，忽略
        resolve()
      })
    })
  }

  /** 在远程工作目录执行命令（python3 等） */
  exec(command: string): Promise<SshExecResult> {
    return new Promise((resolve, reject) => {
      const full = `cd ${this.quote(this.config.remotePath)} && ${command}`
      this.client.exec(full, { timeout: EXEC_TIMEOUT_MS } as never, (error, stream) => {
        if (error) {
          reject(new SshError(error.message))
          return
        }
        let stdout = ''
        let stderr = ''
        let exitCode: number | null = null
        let closed = false
        const finish = () => {
          if (closed) {
            return
          }
          closed = true
          resolve({
            stdout: stdout.slice(0, OUTPUT_LIMIT),
            stderr: stderr.slice(0, OUTPUT_LIMIT),
            exitCode,
          })
        }
        stream
          .on('data', (chunk: Buffer) => {
            stdout += chunk.toString('utf8')
          })
          .stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString('utf8')
          })
        stream.on('close', (code: number | null) => {
          exitCode = code
          finish()
        })
        stream.on('error', () => finish())
      })
    })
  }

  private quote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`
  }

  close(): void {
    this.client.end()
  }
}

/** 连通性测试返回给前端的错误：不暴露内网 IP/端口/底层 errno，只给可操作分类 */
const publicSshError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error)
  if (/authentication methods failed|authentication failure|permission denied/i.test(message)) {
    return 'SSH 认证失败：请检查用户名与密码/私钥'
  }
  if (/timed out|timeout/i.test(message)) {
    return 'SSH 连接超时：目标不可达或端口未开放'
  }
  if (/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|connection lost/i.test(message)) {
    return 'SSH 连接失败：目标不可达或端口未开放'
  }
  return 'SSH 连接失败'
}

/** 会话级连接缓存：配置指纹变化时自动重连 */
export class SshManager {
  private readonly sessions = new Map<string, { session: SshSession; fingerprint: string }>()

  async get(sessionId: string, config: SshConfig): Promise<SshSession> {
    const fp = fingerprint(config)
    const cached = this.sessions.get(sessionId)
    if (cached && cached.fingerprint === fp) {
      return cached.session
    }
    cached?.session.close()
    const session = await SshSession.connect(config)
    this.sessions.set(sessionId, { session, fingerprint: fp })
    return session
  }

  cleanup(sessionId: string): void {
    this.sessions.get(sessionId)?.session.close()
    this.sessions.delete(sessionId)
  }

  /** 测试连接：连接 + echo 探测后立即关闭 */
  async test(config: SshConfig): Promise<{ ok: boolean; hostname: string; error: string | null }> {
    let session: SshSession | null = null
    try {
      session = await SshSession.connect(config)
      const result = await session.exec('echo OK && hostname && python3 --version 2>&1 || true')
      const hostname = result.stdout.split('\n')[1] ?? ''
      return { ok: true, hostname, error: null }
    } catch (error) {
      return {
        ok: false,
        hostname: '',
        error: publicSshError(error),
      }
    } finally {
      session?.close()
    }
  }
}

export const sshManager = new SshManager()
