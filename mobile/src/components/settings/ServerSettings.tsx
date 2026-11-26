import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  isServerMode,
  serverLogin,
  serverLogout,
  setServerOptions,
  useServerConfig,
} from '../../services/api/serverMode.js'
import { Button } from '../base/Button.js'
import { SettingCell } from './SettingCell.js'
import styles from './ServerSettings.module.css'

/**
 * 服务器设置：连接自建 MyAgent 后端。
 * 连接后模型请求（含记忆、上下文压缩、Agent 工具）都由服务器处理，
 * 手机端只负责 UI 与本地会话存储。
 */
export const ServerSettings = () => {
  const t = useTranslate()
  const config = useServerConfig()
  const connected = isServerMode()
  const [editing, setEditing] = useState(!connected)
  const [url, setUrl] = useState(config.url)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const connect = async () => {
    if (busy) {
      return
    }
    setBusy(true)
    setError(null)
    const result = await serverLogin(url, password)
    setBusy(false)
    if (result.ok) {
      setEditing(false)
      setPassword('')
    } else {
      setError(result.message ?? t('serverConnectFailed'))
    }
  }

  return (
    <>
      <SettingCell
        label={t('serverTitle')}
        description={
          connected
            ? t('serverConnectedDescription', { url: config.url })
            : t('serverDisconnectedDescription')
        }
        status={error ? { key: 'serverConnectFailed', params: { message: error }, error: true } : null}
        action={
          connected ? (
            <Button
              variant="outlined"
              size="m"
              onClick={() => {
                serverLogout()
                setEditing(true)
              }}
            >
              {t('serverDisconnect')}
            </Button>
          ) : (
            <Button variant="primary" size="m" onClick={() => setEditing(true)}>
              {t('serverConnect')}
            </Button>
          )
        }
      />
      {editing ? (
        <div className={styles.form}>
          <label className={styles.field}>
            <span>{t('serverUrl')}</span>
            <input
              value={url}
              inputMode="url"
              autoCapitalize="off"
              autoComplete="off"
              spellCheck={false}
              placeholder="http://192.168.1.10:8090"
              onChange={(event) => setUrl(event.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span>{t('serverPassword')}</span>
            <input
              type="password"
              value={password}
              autoComplete="current-password"
              placeholder={t('serverPasswordPlaceholder')}
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  void connect()
                }
              }}
            />
          </label>
          <div className={styles.actions}>
            {connected ? (
              <Button variant="outlined" size="m" onClick={() => setEditing(false)}>
                {t('cancel')}
              </Button>
            ) : null}
            <Button
              variant="primary"
              size="m"
              aria-busy={busy}
              disabled={busy || !url.trim()}
              onClick={() => void connect()}
            >
              {busy ? t('serverConnecting') : t('serverConnect')}
            </Button>
          </div>
        </div>
      ) : null}
      {connected ? (
        <>
          <SettingCell
            label={t('serverAgentTitle')}
            description={t('serverAgentDescription')}
            status={null}
            action={
              <Toggle
                pressed={config.agent}
                label={t('serverAgentTitle')}
                onChange={(value) => setServerOptions({ agent: value })}
              />
            }
          />
          <SettingCell
            label={t('serverMemoryTitle')}
            description={t('serverMemoryDescription')}
            status={null}
            action={
              <Toggle
                pressed={config.memory}
                label={t('serverMemoryTitle')}
                onChange={(value) => setServerOptions({ memory: value })}
              />
            }
          />
        </>
      ) : null}
    </>
  )
}

const Toggle = ({
  pressed,
  label,
  onChange,
}: {
  pressed: boolean
  label: string
  onChange: (value: boolean) => void
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={pressed}
    aria-label={label}
    className={styles.switch}
    onClick={() => onChange(!pressed)}
  >
    <span className={styles.track}>
      <span className={styles.thumb} />
    </span>
  </button>
)
