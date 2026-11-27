import { useState } from 'react'
import { android } from '../../app/android.js'
import whale from '../../assets/deepseek-whale.svg'
import { useTranslate } from '../../i18n/index.js'
import {
  rememberDirectUrl,
  restoreDirectUrl,
  serverLogin,
} from '../../services/api/serverMode.js'
import {
  openLoginPage,
  savedAuthKey,
  targetFromUrl,
  useTunnel,
  watchTunnel,
} from '../../services/tailscale.js'
import { AdvancedApiDialog } from './AdvancedApiSettings.js'
import advancedStyles from './AdvancedApiSettings.module.css'
import { useApiKeyForm } from './useApiKeyForm.js'
import styles from './ApiKeyScreen.module.css'

export const ApiKeyScreen = () => {
  const t = useTranslate()
  const form = useApiKeyForm()
  const [advanced, setAdvanced] = useState(false)
  // 手机端是网页版的客户端：首屏直接填写服务端地址，不再以 DeepSeek Key 为主
  const [serverMode, setServerMode] = useState(Boolean(android))
  const [serverUrl, setServerUrl] = useState('')
  const [serverPassword, setServerPassword] = useState('')
  const [serverBusy, setServerBusy] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const tunnel = useTunnel()
  const [tunnelError, setTunnelError] = useState<string | null>(null)
  const tunnelTarget = targetFromUrl(serverUrl)

  const toggleTunnel = () => {
    if (tunnel.enabled) {
      useTunnel.getState().stop()
      restoreDirectUrl()
      setTunnelError(null)
      return
    }
    if (!tunnelTarget) {
      setTunnelError(t('tsTunnelNeedUrl'))
      return
    }
    setTunnelError(null)
    rememberDirectUrl(serverUrl)
    useTunnel.getState().start(tunnelTarget, savedAuthKey())
    watchTunnel()
  }

  const tunnelStatus =
    tunnel.state === 'ready'
      ? t('tsTunnelConnected', { ip: tunnel.ip })
      : tunnel.state === 'starting'
        ? t('tsTunnelStarting')
        : tunnel.state === 'error'
          ? t('tsTunnelFailed')
          : ''

  if (serverMode) {
    return (
      <main className={styles.page}>
        <form
          className={styles.form}
          onSubmit={async (event) => {
            event.preventDefault()
            if (serverBusy || !serverUrl.trim()) {
              return
            }
            setServerBusy(true)
            setServerError(null)
            const snapshot = useTunnel.getState()
            const viaTunnel = snapshot.enabled && snapshot.state === 'ready'
            if (snapshot.enabled && !viaTunnel) {
              setServerBusy(false)
              setServerError(t('tsTunnelNeedSignIn'))
              return
            }
            const result = await serverLogin(
              viaTunnel ? `http://${snapshot.addr}` : serverUrl,
              serverPassword,
              { directUrl: serverUrl, tunnel: viaTunnel }
            )
            setServerBusy(false)
            if (!result.ok) {
              setServerError(result.message ?? t('serverConnectFailed'))
            }
            // 连接成功后 serverConfig 变为已配置，App 会自动进入聊天页
          }}
        >
          <img className={styles.whale} src={whale} alt="" />
          <h1>{t('serverTitle')}</h1>
          <input
            aria-label={t('serverUrl')}
            aria-invalid={Boolean(serverError)}
            type="url"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="next"
            placeholder="http://192.168.1.10:8090"
            value={serverUrl}
            onChange={(event) => setServerUrl(event.target.value)}
          />
          {android ? (
            <div className={styles.tunnel}>
              <label className={styles.tunnelToggle}>
                <input type="checkbox" checked={tunnel.enabled} onChange={toggleTunnel} />
                <span>{t('tsUseTunnel')}</span>
              </label>
              {tunnel.enabled ? (
                <>
                  <p>{t('tsTunnelHint')}</p>
                  {tunnelStatus ? <p className={styles.tunnelStatus}>{tunnelStatus}</p> : null}
                  {tunnel.state === 'starting' && tunnel.loginUrl ? (
                    <button type="button" className={styles.tunnelLogin} onClick={() => openLoginPage()}>
                      {t('tsSignIn')}
                    </button>
                  ) : null}
                </>
              ) : null}
              {tunnelError || tunnel.error ? (
                <div role="alert" className={styles.error}>
                  {tunnelError || tunnel.error}
                </div>
              ) : null}
            </div>
          ) : null}
          <input
            aria-label={t('serverPassword')}
            type="password"
            autoComplete="current-password"
            enterKeyHint="go"
            placeholder={t('serverPasswordPlaceholder')}
            value={serverPassword}
            onChange={(event) => setServerPassword(event.target.value)}
          />
          {serverError ? (
            <div role="alert" className={styles.error}>
              {serverError}
            </div>
          ) : null}
          <button type="submit" disabled={serverBusy || !serverUrl.trim()}>
            {t(serverBusy ? 'serverConnecting' : 'serverConnect')}
          </button>
          <button
            className={advancedStyles.entry}
            type="button"
            onClick={() => setServerMode(false)}
          >
            {t('serverUseApiKey')}
          </button>
        </form>
      </main>
    )
  }

  return (
    <main className={styles.page}>
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault()
          void form.submit()
        }}
      >
        <img className={styles.whale} src={whale} alt="" />
        <h1>{t('apiKeyStart')}</h1>
        <input
          aria-label="DeepSeek API Key"
          aria-invalid={Boolean(form.error)}
          type="password"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="go"
          placeholder={t('apiKeyPlaceholder')}
          value={form.value}
          onChange={(event) => form.setValue(event.target.value)}
        />
        {form.error ? (
          <div role="alert" className={styles.error}>
            {form.error}
          </div>
        ) : null}
        <button type="submit" disabled={form.verifying || !form.value.trim()}>
          {t(form.verifying ? 'apiKeyVerifying' : 'confirm')}
        </button>
        <a href="https://platform.deepseek.com/api_keys">{t('apiKeyGet')}</a>
        <button
          className={advancedStyles.entry}
          type="button"
          onClick={() => setServerMode(true)}
        >
          {t('serverUseServer')}
        </button>
        <button className={advancedStyles.entry} type="button" onClick={() => setAdvanced(true)}>
          {t('advancedSettings')}
        </button>
      </form>
      {advanced ? <AdvancedApiDialog onClose={() => setAdvanced(false)} /> : null}
    </main>
  )
}
