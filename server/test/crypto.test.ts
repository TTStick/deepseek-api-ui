import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  decryptText,
  encryptBuffer,
  encryptText,
  isEncrypted,
  readSecureJson,
  readSecureText,
  setEncryptionKeyForTests,
  writeSecureJson,
  writeSecureText,
} from '../src/storage/crypto.js'

describe('服务端静态加密', () => {
  beforeAll(() => {
    setEncryptionKeyForTests(Buffer.alloc(32, 7))
  })

  it('AES-256-GCM 往返保留内容，且每次 IV 不同', () => {
    const a = encryptText('你好，世界', 'session:s1')
    const b = encryptText('你好，世界', 'session:s1')
    expect(isEncrypted(a)).toBe(true)
    expect(a.equals(b)).toBe(false)
    expect(decryptText(a, 'session:s1')).toBe('你好，世界')
    expect(decryptText(b, 'session:s1')).toBe('你好，世界')
  })

  it('AAD 绑定逻辑路径：密文挪到其他文件会失败', () => {
    const encrypted = encryptBuffer(Buffer.from('secret'), 'session:s1')
    expect(() => decryptText(encrypted, 'session:s2')).toThrow(/解密失败/)
  })

  it('篡改密文会被 GCM 拒绝', () => {
    const encrypted = encryptText('secret', 'index:s1')
    const tampered = Buffer.from(encrypted)
    tampered[tampered.length - 1] ^= 0xff
    expect(() => decryptText(tampered, 'index:s1')).toThrow(/解密失败/)
  })

  it('明文不是密文格式', () => {
    expect(isEncrypted(Buffer.from('{"messages":[]}'))).toBe(false)
  })

  it('安全文件读写：落盘为密文，读回为明文', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-crypto-test-'))
    try {
      const file = path.join(dir, 'session.json')
      await writeSecureJson(file, { id: 's1', text: '敏感内容' }, 'session:s1')
      const raw = await readFile(file)
      expect(isEncrypted(raw)).toBe(true)
      expect(raw.toString('utf8')).not.toContain('敏感内容')
      expect(await readSecureJson<{ text: string }>(file, 'session:s1')).toEqual({
        id: 's1',
        text: '敏感内容',
      })
      await writeSecureText(path.join(dir, 'plain.txt'), '历史明文', 'workspace:s1')
      expect(await readSecureText(path.join(dir, 'plain.txt'), 'workspace:s1')).toBe('历史明文')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
