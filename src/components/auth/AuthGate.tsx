import { useEffect, useState, type ReactNode } from 'react'
import { AUTH_REQUIRED_EVENT, fetchAuthStatus, login, type AuthStatus } from '../../services/auth.js'
import { useTranslate } from '../../i18n/index.js'
import { IconDeepSeekWhale } from '../base/icons.js'
import { Button } from '../base/Button.js'
import styles from './AuthGate.module.css'

/**
 * 访问密码门禁：未设置密码时直接放行；
 * 已设置且会话无效时展示登录页（表单提交可让浏览器保存密码）。
 */
export const AuthGate = ({ children }: { children: ReactNode }) => {
  const t = useTranslate()
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [error, setError] = useState(false)
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [wrong, setWrong] = useState(false)

  const refresh = async () => {
    try {
      setStatus(await fetchAuthStatus())
      setError(false)
    } catch {
      setError(true)
    }
  }

  useEffect(() => {
    void refresh()
    const onAuthRequired = () => {
      // 会话过期：回到登录页并重新检查
      setStatus({ passwordSet: true, authenticated: false })
    }
    window.addEventListener(AUTH_REQUIRED_EVENT, onAuthRequired)
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, onAuthRequired)
  }, [])

  if (error) {
    return (
      <div className={styles.screen}>
        <div className={styles.card}>
          <div className={styles.brand}>
            <IconDeepSeekWhale size={28} />
            <span>Wy DEEPSEEK</span>
          </div>
          <p className={styles.message}>{t('authServerUnreachable')}</p>
          <Button onClick={() => void refresh()}>{t('retry')}</Button>
        </div>
      </div>
    )
  }

  if (!status) {
    return (
      <div className={styles.screen}>
        <div className={styles.card}>
          <div className={styles.brand}>
            <IconDeepSeekWhale size={28} />
            <span>Wy DEEPSEEK</span>
          </div>
          <p className={styles.message}>{t('memoryStatusChecking')}</p>
        </div>
      </div>
    )
  }

  // 公网模式要求密码，但服务端尚未设置 ACCESS_PASSWORD：提示管理员配置，避免误开放
  if (status.requireAuth && !status.passwordSet) {
    return (
      <div className={styles.screen}>
        <div className={styles.card}>
          <div className={styles.brand}>
            <IconDeepSeekWhale size={28} />
            <span>Wy DEEPSEEK</span>
          </div>
          <p className={styles.message}>{t('authSetupRequired')}</p>
        </div>
      </div>
    )
  }

  // 未设置密码，或已通过认证：直接进入应用
  if (!status.passwordSet || status.authenticated) {
    return <>{children}</>
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!password || submitting) {
      return
    }
    setSubmitting(true)
    setWrong(false)
    const result = await login(password, remember)
    setSubmitting(false)
    if (result.ok) {
      setPassword('')
      setStatus({ passwordSet: true, authenticated: true })
    } else {
      setWrong(true)
    }
  }

  return (
    <div className={styles.screen}>
      <form className={styles.card} onSubmit={submit}>
        <div className={styles.brand}>
          <IconDeepSeekWhale size={28} />
          <span>Wy DEEPSEEK</span>
        </div>
        <div className={styles.subtitle}>{t('authLoginSubtitle')}</div>
        {/* 隐藏用户名让浏览器密码管理器正确关联账号 */}
        <input
          className={styles.hiddenUser}
          type="text"
          name="username"
          value="wy"
          readOnly
          autoComplete="username"
          tabIndex={-1}
          aria-hidden="true"
        />
        <input
          className={styles.input}
          type="password"
          name="password"
          placeholder={t('authPasswordPlaceholder')}
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={(event) => {
            setPassword(event.target.value)
            setWrong(false)
          }}
        />
        <label className={styles.remember}>
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
          />
          {t('authRemember')}
        </label>
        {wrong ? <div className={styles.error}>{t('authWrongPassword')}</div> : null}
        <Button type="submit" variant="primary" className={styles.submit} disabled={!password || submitting}>
          {submitting ? t('authLoggingIn') : t('authLogin')}
        </Button>
      </form>
    </div>
  )
}
