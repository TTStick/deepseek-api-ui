import { useEffect, useState } from 'react'
import {
  changePassword,
  fetchAuthStatus,
  logout,
  notifyAuthRequired,
} from '../../services/auth.js'
import { useTranslate } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { showToast } from '../base/toastState.js'
import { SettingCell, type Status } from './SettingCell.js'
import styles from './PasswordSetting.module.css'

/** 访问密码：设置/修改访问密码，或退出当前设备登录 */
export const PasswordSetting = () => {
  const t = useTranslate()
  const [passwordSet, setPasswordSet] = useState<boolean | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)

  useEffect(() => {
    let cancelled = false
    void fetchAuthStatus()
      .then((value) => {
        if (!cancelled) {
          setPasswordSet(value.passwordSet)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPasswordSet(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  const submit = async () => {
    if (busy) {
      return
    }
    if (next.length < 10) {
      setStatus({ key: 'authPasswordTooShort', error: true })
      return
    }
    if (next !== confirm) {
      setStatus({ key: 'authPasswordMismatch', error: true })
      return
    }
    setBusy(true)
    setStatus(null)
    try {
      const result = await changePassword(current, next)
      if (result.ok) {
        setPasswordSet(true)
        setCurrent('')
        setNext('')
        setConfirm('')
        setExpanded(false)
        showToast({ key: 'authPasswordSaved' })
      } else {
        setStatus({ key: 'authCurrentWrong', error: true })
      }
    } catch {
      setStatus({ key: 'authServerUnreachable', error: true })
    } finally {
      setBusy(false)
    }
  }

  const signOut = async () => {
    await logout().catch(() => undefined)
    notifyAuthRequired()
  }

  return (
    <>
      <SettingCell
        label={t('authSettingTitle')}
        description={
          passwordSet === null
            ? t('memoryStatusChecking')
            : passwordSet
              ? t('authSettingDescriptionOn')
              : t('authSettingDescriptionOff')
        }
        status={status}
        action={
          <div className={styles.actions}>
            {passwordSet ? (
              <Button variant="outlined" size="m" onClick={() => void signOut()}>
                {t('authSignOut')}
              </Button>
            ) : null}
            <Button
              variant={passwordSet ? 'outlined' : 'primary'}
              size="m"
              onClick={() => {
                setExpanded((value) => !value)
                setStatus(null)
              }}
            >
              {passwordSet ? t('authChangePassword') : t('authSetPassword')}
            </Button>
          </div>
        }
      />
      {expanded ? (
        <div className={styles.form}>
          {passwordSet ? (
            <label className={styles.field}>
              <span>{t('authCurrentPassword')}</span>
              <input
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(event) => setCurrent(event.target.value)}
              />
            </label>
          ) : null}
          <label className={styles.field}>
            <span>{t('authNewPassword')}</span>
            <input
              type="password"
              autoComplete="new-password"
              value={next}
              placeholder={t('authPasswordHint')}
              onChange={(event) => setNext(event.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span>{t('authConfirmPassword')}</span>
            <input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  void submit()
                }
              }}
            />
          </label>
          <div className={styles.formActions}>
            <Button variant="outlined" size="m" onClick={() => setExpanded(false)}>
              {t('cancel')}
            </Button>
            <Button
              variant="primary"
              size="m"
              aria-busy={busy}
              disabled={busy || !next || !confirm || (passwordSet === true && !current)}
              onClick={() => void submit()}
            >
              {t('save')}
            </Button>
          </div>
        </div>
      ) : null}
    </>
  )
}
