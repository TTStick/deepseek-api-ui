import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { env } from '../env.js'

/**
 * 服务端静态加密（AES-256-GCM）：
 * - 密钥来自 DATA_ENCRYPTION_KEY（base64/hex/32 字节原文）或本地密钥文件；
 * - 每个文件随机 IV，AAD 绑定逻辑路径，防止把密文挪到别的文件后仍能解密；
 * - 密文带 MAG1 魔数，读取时兼容历史明文，便于无感迁移。
 *
 * 这不是端到端加密：服务端运行时仍需密钥解密（Agent、检索、压缩都依赖明文）。
 * 它防的是磁盘/备份/卷被直接读取，不防拿到容器 root 或密钥文件的人。
 */

const MAGIC = Buffer.from('MAG1')
const VERSION = 1
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32
export const ENCRYPTED_HEADER_BYTES = MAGIC.length + 1 + IV_BYTES + TAG_BYTES

let cachedKey: Buffer | null = null
let keySource: string | null = null

export class EncryptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EncryptionError'
  }
}

const keyMarker = (): string => path.join(env.dataRoot, 'encryption.meta')

const parseKey = (raw: string, source: string): Buffer => {
  const value = raw.trim()
  if (!value) {
    throw new EncryptionError(`${source} 为空`)
  }
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    return Buffer.from(value, 'hex')
  }
  // 44 字符左右的标准 base64；先校验长度，避免把普通 ASCII 误判成 base64
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length >= 40) {
    const decoded = Buffer.from(value, 'base64')
    if (decoded.length === KEY_BYTES) {
      return decoded
    }
  }
  const utf8 = Buffer.from(value, 'utf8')
  if (utf8.length === KEY_BYTES) {
    return utf8
  }
  throw new EncryptionError(`${source} 必须是 32 字节密钥（64 位 hex、base64 或 32 字节原文）`)
}

const readKeyFile = async (file: string): Promise<Buffer> => {
  const raw = await readFile(file, 'utf8')
  return parseKey(raw, `密钥文件 ${file}`)
}

const writeKeyFile = async (file: string): Promise<Buffer> => {
  const key = randomBytes(KEY_BYTES)
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(file, `${key.toString('hex')}\n`, { encoding: 'utf8', mode: 0o600 })
  await chmod(file, 0o600).catch(() => undefined)
  return key
}

const keyFingerprint = (key: Buffer): string =>
  createHash('sha256').update('myagent-encryption-key:').update(key).digest('hex')

type KeyMarker = { version?: number; source?: string; createdAt?: number; fingerprint?: string }

const readMarker = async (): Promise<KeyMarker | null> => {
  try {
    return JSON.parse(await readFile(keyMarker(), 'utf8')) as KeyMarker
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw new Error(`无法读取加密标记 ${keyMarker()}：${String(error)}`)
  }
}

const writeMarker = async (source: string): Promise<void> => {
  await mkdir(env.dataRoot, { recursive: true })
  await writeFile(
    keyMarker(),
    JSON.stringify({
      version: VERSION,
      source,
      createdAt: Date.now(),
      fingerprint: keyFingerprint(getKey()),
    }),
    { encoding: 'utf8', mode: 0o600 }
  )
  await chmod(keyMarker(), 0o600).catch(() => undefined)
}

/** 已有加密标记时校验密钥，避免用错密钥启动后把界面显示成空数据。 */
const verifyMarkerKey = async (): Promise<void> => {
  const marker = await readMarker()
  if (!marker) {
    return
  }
  if (!marker.fingerprint) {
    // 早期版本只记录了 source；此时无法校验，补写指纹
    await writeMarker(marker.source ?? 'unknown')
    return
  }
  if (marker.fingerprint !== keyFingerprint(getKey())) {
    throw new EncryptionError(
      '加密密钥与已有数据不匹配。请恢复原来的 DATA_ENCRYPTION_KEY/密钥文件，不能换新密钥读取旧数据。'
    )
  }
}

/**
 * 初始化密钥。密钥文件不存在时：
 * - 如果已有加密标记，拒绝生成新密钥（否则旧数据会永久无法解密）；
 * - 否则首次启动生成密钥并写标记。
 */
export const initEncryption = async (): Promise<{ source: string }> => {
  if (cachedKey) {
    return { source: keySource ?? 'memory' }
  }
  if (env.dataEncryptionKey) {
    cachedKey = parseKey(env.dataEncryptionKey, 'DATA_ENCRYPTION_KEY')
    keySource = 'env'
    await verifyMarkerKey()
    await writeMarker('env')
    return { source: 'env' }
  }

  const keyFile = env.dataEncryptionKeyFile
  try {
    cachedKey = await readKeyFile(keyFile)
    keySource = 'file'
    await verifyMarkerKey()
    await writeMarker('file')
    return { source: 'file' }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      throw error
    }
    // 密钥文件不在：若之前已经启用过加密，绝不能悄悄换一把新钥匙
    const marker = await readMarker()
    if (marker) {
      throw new EncryptionError(
        `加密密钥文件不存在（${keyFile}）。请从备份恢复 encryption.key，或设置 DATA_ENCRYPTION_KEY；` +
          '不能自动生成新密钥，否则已有加密数据将无法读取。'
      )
    }
    cachedKey = await writeKeyFile(keyFile)
    keySource = 'generated'
    await writeMarker('generated')
    return { source: 'generated' }
  }
}

const getKey = (): Buffer => {
  if (!cachedKey) {
    throw new EncryptionError('加密模块尚未初始化')
  }
  return cachedKey
}

export const encryptionSource = (): string | null => keySource

/** 仅用于测试：避免测试写入真实数据目录 */
export const setEncryptionKeyForTests = (key: Buffer): void => {
  if (key.length !== KEY_BYTES) {
    throw new EncryptionError('测试密钥必须是 32 字节')
  }
  cachedKey = Buffer.from(key)
  keySource = 'test'
}

export const resetEncryptionForTests = (): void => {
  cachedKey = null
  keySource = null
}

export const isEncrypted = (data: Buffer): boolean =>
  data.length >= ENCRYPTED_HEADER_BYTES && data.subarray(0, MAGIC.length).equals(MAGIC)

export const encryptBuffer = (plaintext: Buffer, aad: string): Buffer => {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([MAGIC, Buffer.from([VERSION]), iv, cipher.getAuthTag(), ciphertext])
}

export const decryptBuffer = (payload: Buffer, aad: string): Buffer => {
  if (!isEncrypted(payload)) {
    throw new EncryptionError('文件不是有效的加密格式')
  }
  const version = payload[MAGIC.length]
  if (version !== VERSION) {
    throw new EncryptionError(`不支持的加密版本：${version}`)
  }
  const ivStart = MAGIC.length + 1
  const tagStart = ivStart + IV_BYTES
  const bodyStart = tagStart + TAG_BYTES
  const iv = payload.subarray(ivStart, tagStart)
  const tag = payload.subarray(tagStart, bodyStart)
  const ciphertext = payload.subarray(bodyStart)
  try {
    const decipher = createDecipheriv('aes-256-gcm', getKey(), iv)
    decipher.setAAD(Buffer.from(aad, 'utf8'))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch {
    throw new EncryptionError('解密失败：密钥不匹配或文件已损坏')
  }
}

export const encryptText = (plaintext: string, aad: string): Buffer =>
  encryptBuffer(Buffer.from(plaintext, 'utf8'), aad)

export const decryptText = (payload: Buffer, aad: string): string =>
  decryptBuffer(payload, aad).toString('utf8')

/** 读取并解密；历史明文文件原样返回，便于迁移。 */
export const readSecure = async (file: string, aad: string): Promise<Buffer> => {
  const data = await readFile(file)
  return isEncrypted(data) ? decryptBuffer(data, aad) : data
}

export const readSecureText = async (file: string, aad: string): Promise<string> =>
  (await readSecure(file, aad)).toString('utf8')

/** 原子写入加密文件（临时文件 → rename），权限默认 0600。 */
export const writeSecure = async (
  file: string,
  plaintext: Buffer,
  aad: string,
  mode = 0o600
): Promise<void> => {
  const encrypted = encryptBuffer(plaintext, aad)
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(temporary, encrypted, { mode })
  await rename(temporary, file)
  await chmod(file, mode).catch(() => undefined)
}

export const writeSecureText = (
  file: string,
  plaintext: string,
  aad: string,
  mode = 0o600
): Promise<void> => writeSecure(file, Buffer.from(plaintext, 'utf8'), aad, mode)

export const readSecureJson = async <T>(file: string, aad: string): Promise<T> =>
  JSON.parse(await readSecureText(file, aad)) as T

export const writeSecureJson = (
  file: string,
  value: unknown,
  aad: string,
  mode = 0o600
): Promise<void> => writeSecureText(file, JSON.stringify(value), aad, mode)
