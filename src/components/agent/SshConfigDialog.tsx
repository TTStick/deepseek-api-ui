import { useState } from 'react'
import { getAgentApiOrigin } from '../../services/api/client.js'
import { setSessionSsh } from '../../services/chat/store.js'
import type { SessionSshConfig } from '../../services/chat/types.js'
import { useTranslate } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import styles from './SshConfigDialog.module.css'

/**
 * 会话级 SSH 主机配置：agent 模式下文件操作与执行改到远程主机。
 * 凭据只保存在本会话（IndexedDB），不跨会话共享；测试连接不落盘。
 */
export const SshConfigDialog = ({
  sessionId,
  initial,
  onClose,
}: {
  sessionId: string
  initial: SessionSshConfig | undefined
  onClose: () => void
}) => {
  const t = useTranslate()
  const [host, setHost] = useState(initial?.host ?? '')
  const [port, setPort] = useState(initial?.port ?? 22)
  const [username, setUsername] = useState(initial?.username ?? '')
  const [password, setPassword] = useState(initial?.password ?? '')
  const [privateKey, setPrivateKey] = useState(initial?.privateKey ?? '')
  const [remotePath, setRemotePath] = useState(initial?.remotePath ?? '')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)

  const buildConfig = (): SessionSshConfig => ({
    host: host.trim(),
    port: Number(port) || 22,
    username: username.trim(),
    ...(privateKey.trim() ? { privateKey: privateKey } : { password }),
    remotePath: remotePath.trim(),
  })

  const test = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const response = await fetch(`${getAgentApiOrigin()}/api/agent/ssh/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildConfig()),
      })
      const result = (await response.json()) as { ok: boolean; hostname?: string; error?: string | null }
      setTestResult(result.ok ? `${t('agentSshTestOk')}${result.hostname ? `（${result.hostname}）` : ''}` : `${t('agentSshTestFailed')}：${result.error ?? ''}`)
    } catch {
      setTestResult(t('agentSshTestFailed'))
    } finally {
      setTesting(false)
    }
  }

  const save = () => {
    const config = buildConfig()
    if (!config.host || !config.username || !config.remotePath) {
      showToast({ key: 'agentSshIncomplete', type: 'error' })
      return
    }
    if (!config.password && !config.privateKey) {
      showToast({ key: 'agentSshIncomplete', type: 'error' })
      return
    }
    setSessionSsh(sessionId, config)
    showToast({ key: 'agentSshSaved' })
    onClose()
  }

  const disable = () => {
    setSessionSsh(sessionId, null)
    onClose()
  }

  return (
    <Modal
      title={t('agentSshTitle')}
      className={styles.dialog}
      closable
      onClose={onClose}
      footer={
        <div className={styles.footer}>
          {initial ? (
            <Button variant="outlined" size="m" onClick={disable}>
              {t('agentSshDisable')}
            </Button>
          ) : null}
          <Button variant="outlined" size="m" aria-busy={testing} onClick={() => void test()}>
            {t('agentSshTest')}
          </Button>
          <Button variant="primary" size="m" onClick={save}>
            {t('save')}
          </Button>
        </div>
      }
    >
      <div className={styles.form}>
        <label className={styles.field}>
          <span>{t('agentSshHost')}</span>
          <input value={host} placeholder="192.168.1.10" onChange={(event) => setHost(event.target.value)} />
        </label>
        <label className={styles.field}>
          <span>{t('agentSshPort')}</span>
          <input
            type="number"
            value={port}
            onChange={(event) => setPort(Number(event.target.value))}
          />
        </label>
        <label className={styles.field}>
          <span>{t('agentSshUsername')}</span>
          <input value={username} placeholder="root" onChange={(event) => setUsername(event.target.value)} />
        </label>
        <label className={styles.field}>
          <span>{t('agentSshPassword')}</span>
          <input
            type="password"
            value={password}
            placeholder={t('agentSshPasswordPlaceholder')}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <label className={styles.field}>
          <span>{t('agentSshKey')}</span>
          <textarea
            rows={4}
            value={privateKey}
            placeholder={t('agentSshKeyPlaceholder')}
            onChange={(event) => setPrivateKey(event.target.value)}
          />
        </label>
        <label className={styles.field}>
          <span>{t('agentSshRemotePath')}</span>
          <input value={remotePath} placeholder="/home/user/myagent" onChange={(event) => setRemotePath(event.target.value)} />
        </label>
        {testResult ? <div className={styles.testResult}>{testResult}</div> : null}
      </div>
    </Modal>
  )
}
