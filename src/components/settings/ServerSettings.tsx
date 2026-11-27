import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  fetchServerConfig,
  saveServerConfig,
  type ServerConfig,
  type ServerConfigInput,
} from '../../services/api/serverConfig.js'
import { setServerApiKeyConfigured } from '../../services/serverKey.js'
import { Button } from '../base/Button.js'
import { showToast } from '../base/toastState.js'
import { SettingCell } from './SettingCell.js'
import { Toggle } from './Toggle.js'
import styles from './Settings.module.css'

type FormState = {
  allowedModels: string
  chatRateLimit: string
  agentMaxIterations: string
  corsOrigins: string
  sshAllowPrivateHosts: boolean
  trustProxy: boolean
  requireAuth: boolean
  honchoBaseUrl: string
}

const formFrom = (config: ServerConfig): FormState => ({
  allowedModels: config.allowedModels.join(', '),
  chatRateLimit: String(config.chatRateLimitPerMinute),
  agentMaxIterations: String(config.agentMaxIterations),
  corsOrigins: config.corsOrigins.join('\n'),
  sshAllowPrivateHosts: config.sshAllowPrivateHosts,
  trustProxy: config.trustProxy,
  requireAuth: config.requireAuth,
  honchoBaseUrl: config.honchoBaseUrl,
})

/** 服务端运行时配置：API Key、模型白名单、限速、Agent 循环、CORS 与安全开关 */
export const ServerSettings = () => {
  const t = useTranslate()
  const [config, setConfig] = useState<ServerConfig | null>(null)
  const [form, setForm] = useState<FormState | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [honchoKey, setHonchoKey] = useState('')
  const [clearHonchoKey, setClearHonchoKey] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const applyConfig = (next: ServerConfig) => {
    setConfig(next)
    setForm(formFrom(next))
    setServerApiKeyConfigured(next.deepseekApiKeyConfigured)
  }

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      applyConfig(await fetchServerConfig())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (loading) {
    return <div className={styles.serverLoading}>{t('loading')}</div>
  }

  if (!config || !form) {
    return (
      <div className={styles.serverLoading}>
        <div className={styles.error}>{t('serverConfigLoadFailed')}</div>
        {error ? <div className={styles.serverError}>{error}</div> : null}
        <Button variant="outlined" size="s" onClick={() => void load()}>
          {t('refresh')}
        </Button>
      </div>
    )
  }

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((current) => (current ? { ...current, [key]: value } : current))

  const save = async () => {
    const models = form.allowedModels
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
    const corsOrigins = form.corsOrigins
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean)
    if (models.length === 0) {
      setError(t('serverConfigModelsRequired'))
      return
    }
    if (form.requireAuth && !config.passwordSet) {
      setError(t('serverConfigPasswordRequired'))
      return
    }
    const input: ServerConfigInput = {
      allowedModels: models,
      chatRateLimitPerMinute: Number(form.chatRateLimit),
      agentMaxIterations: Number(form.agentMaxIterations),
      corsOrigins,
      sshAllowPrivateHosts: form.sshAllowPrivateHosts,
      trustProxy: form.trustProxy,
      requireAuth: form.requireAuth,
      honchoBaseUrl: form.honchoBaseUrl.trim(),
    }
    if (clearKey) {
      input.deepseekApiKey = null
    } else if (apiKey.trim()) {
      input.deepseekApiKey = apiKey.trim()
    }
    if (clearHonchoKey) {
      input.honchoApiKey = null
    } else if (honchoKey.trim()) {
      input.honchoApiKey = honchoKey.trim()
    }
    setSaving(true)
    setError('')
    try {
      const next = await saveServerConfig(input)
      applyConfig(next)
      setApiKey('')
      setClearKey(false)
      setHonchoKey('')
      setClearHonchoKey(false)
      showToast({ key: 'serverConfigSaved' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      showToast({
        key: 'serverConfigSaveFailed',
        params: { message },
        type: 'error',
      })
    } finally {
      setSaving(false)
    }
  }

  const keySource =
    config.deepseekApiKeySource === 'server'
      ? t('serverConfigApiKeySourceServer')
      : config.deepseekApiKeySource === 'env'
        ? t('serverConfigApiKeySourceEnv')
        : t('serverConfigApiKeySourceNone')
  const honchoKeySource =
    config.honchoApiKeySource === 'server'
      ? t('serverConfigApiKeySourceServer')
      : config.honchoApiKeySource === 'env'
        ? t('serverConfigApiKeySourceEnv')
        : t('serverConfigApiKeySourceNone')

  return (
    <div className={styles.serverSettings}>
      <div className={styles.serverIntro}>{t('serverConfigDescription')}</div>

      <div className={styles.cell}>
        <div className={styles.text}>
          <div className={styles.label}>{t('serverConfigApiKey')}</div>
          <div className={styles.description}>{t('serverConfigApiKeyDescription')}</div>
          <div className={styles.serverKeyStatus}>{keySource}</div>
        </div>
        <div className={styles.serverKeyActions}>
          <input
            className={styles.serverInput}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={t('serverConfigApiKeyPlaceholder')}
            value={apiKey}
            onChange={(event) => {
              setApiKey(event.target.value)
              setClearKey(false)
            }}
          />
          <Button
            variant="outlined"
            size="s"
            disabled={config.deepseekApiKeySource !== 'server' || saving}
            onClick={() => {
              setApiKey('')
              setClearKey(true)
            }}
          >
            {t('serverConfigApiKeyClear')}
          </Button>
        </div>
      </div>

      <SettingCell
        className={styles.serverCell}
        label={t('serverConfigHoncho')}
        description={t('serverConfigHonchoDescription')}
        status={null}
        action={
          <input
            className={styles.serverInput}
            value={form.honchoBaseUrl}
            placeholder="http://honcho-api:8000"
            onChange={(event) => update('honchoBaseUrl', event.target.value)}
          />
        }
      />

      <div className={`${styles.cell} ${styles.serverCell}`}>
        <div className={styles.text}>
          <div className={styles.label}>{t('serverConfigHonchoKey')}</div>
          <div className={styles.description}>{t('serverConfigHonchoKeyDescription')}</div>
          <div className={styles.serverKeyStatus}>{honchoKeySource}</div>
        </div>
        <div className={styles.serverKeyActions}>
          <input
            className={styles.serverInput}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={t('serverConfigApiKeyPlaceholder')}
            value={honchoKey}
            onChange={(event) => {
              setHonchoKey(event.target.value)
              setClearHonchoKey(false)
            }}
          />
          <Button
            variant="outlined"
            size="s"
            disabled={config.honchoApiKeySource !== 'server' || saving}
            onClick={() => {
              setHonchoKey('')
              setClearHonchoKey(true)
            }}
          >
            {t('serverConfigHonchoKeyClear')}
          </Button>
        </div>
      </div>

      <SettingCell
        className={styles.serverCell}
        label={t('serverConfigAllowedModels')}
        description={t('serverConfigAllowedModelsDescription')}
        status={null}
        action={
          <input
            className={styles.serverInput}
            value={form.allowedModels}
            placeholder="deepseek-flash, deepseek-v4-pro"
            onChange={(event) => update('allowedModels', event.target.value)}
          />
        }
      />

      <SettingCell
        className={styles.serverCell}
        label={t('serverConfigRateLimit')}
        description={t('serverConfigRateLimitDescription')}
        status={null}
        action={
          <input
            className={styles.serverInput}
            type="number"
            min={1}
            max={600}
            value={form.chatRateLimit}
            onChange={(event) => update('chatRateLimit', event.target.value)}
          />
        }
      />

      <SettingCell
        className={styles.serverCell}
        label={t('serverConfigAgentMax')}
        description={t('serverConfigAgentMaxDescription')}
        status={null}
        action={
          <input
            className={styles.serverInput}
            type="number"
            min={1}
            max={64}
            value={form.agentMaxIterations}
            onChange={(event) => update('agentMaxIterations', event.target.value)}
          />
        }
      />

      <div className={`${styles.cell} ${styles.serverCell}`}>
        <div className={styles.text}>
          <div className={styles.label}>{t('serverConfigCors')}</div>
          <div className={styles.description}>{t('serverConfigCorsDescription')}</div>
        </div>
        <textarea
          className={`${styles.serverInput} ${styles.serverTextarea}`}
          rows={3}
          value={form.corsOrigins}
          placeholder="https://agent.example.com"
          onChange={(event) => update('corsOrigins', event.target.value)}
        />
      </div>

      <SettingCell
        label={t('serverConfigSshPrivate')}
        description={t('serverConfigSshPrivateDescription')}
        status={null}
        action={
          <Toggle
            pressed={form.sshAllowPrivateHosts}
            label={t('serverConfigSshPrivate')}
            onChange={(value) => update('sshAllowPrivateHosts', value)}
          />
        }
      />
      <SettingCell
        label={t('serverConfigTrustProxy')}
        description={t('serverConfigTrustProxyDescription')}
        status={null}
        action={
          <Toggle
            pressed={form.trustProxy}
            label={t('serverConfigTrustProxy')}
            onChange={(value) => update('trustProxy', value)}
          />
        }
      />
      <SettingCell
        label={t('serverConfigRequireAuth')}
        description={t('serverConfigRequireAuthDescription')}
        status={null}
        action={
          <Toggle
            pressed={form.requireAuth}
            label={t('serverConfigRequireAuth')}
            onChange={(value) => update('requireAuth', value)}
          />
        }
      />

      {error ? <div className={styles.serverError}>{error}</div> : null}
      <div className={styles.serverActions}>
        <Button variant="primary" size="m" disabled={saving} onClick={() => void save()}>
          {saving ? t('saving') : t('serverConfigSave')}
        </Button>
      </div>

      <div className={styles.serverDeployNote}>
        <div className={styles.label}>{t('serverConfigDeployOnly')}</div>
        <div className={styles.description}>{t('serverConfigDeployOnlyDescription')}</div>
      </div>
    </div>
  )
}
