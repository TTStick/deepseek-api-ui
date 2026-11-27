import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { android, saveAndroidHistory } from '../../app/android.js'
import {
  subscribeToAndroidBackPreview,
  useAndroidBackInterception,
} from '../../app/useAndroidBackInterception.js'
import { useTranslate, type LinkedMessage } from '../../i18n/index.js'
import type { TtsVoice } from '../../services/api/speech.js'
import {
  applyTunnelAddr,
  displayUrl,
  isServerMode,
  restoreDirectUrl,
  setServerOptions,
  serverLogin,
  serverLogout,
  useServerConfig,
} from '../../services/api/serverMode.js'
import { savedAuthKey, targetFromUrl, useTunnel, waitTunnel } from '../../services/tailscale.js'
import {
  BackupError,
  clearHistory,
  exportHistory,
  formatExportWarning,
  formatImportResult,
  importHistory,
  type ImportMode,
} from '../../services/chat/backup.js'
import { useChatStore } from '../../services/chat/store.js'
import { setInert } from '../../utils/inert.js'
import {
  setFoldThinking,
  setFontSize,
  setLocale,
  setThemePreference,
  setTtsVoice,
  useSettings,
  type LocalePreference,
  type ThemePreference,
} from '../../services/settings.js'
import {
  IconChartOutline16,
  IconChevronRightOutline14,
  IconCloseOutline16,
  IconDataOutline16,
  IconGlobeLanguageOutline14,
  IconLightOutline16,
} from '../base/icons.js'
import { showToast } from '../base/toastState.js'
import { closeOverlaySider } from '../sider/mobileSiderState.js'
import { createSettingsPageMotion } from './androidSettingsMotion.js'
import { ProfileIcon } from './ProfileAvatar.js'
import { ProfileEditor } from './ProfileEditor.js'
import { closeSettings, useSettingsDialog } from './settingsDialogState.js'
import { UsagePanel } from '../usage/UsagePanel.js'
import styles from './AndroidSettings.module.css'

const appVersion = document.querySelector<HTMLMetaElement>(
  'meta[name="application-version"]'
)?.content

type Page = 'root' | 'account' | 'data' | 'usage' | 'export' | 'font' | 'personalization'
type Popup = 'locale' | 'theme' | 'voice' | 'delete' | 'import'

const parentPage: Record<Page, Page | null> = {
  root: null,
  account: 'root',
  data: 'root',
  usage: 'root',
  export: 'data',
  font: 'root',
  personalization: 'root',
}

const PersonalizationIcon = () => (
  <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor">
    <path
      fillRule="evenodd"
      d="M6.374 5.017 4.897 4.499c-.247-.086-.484.151-.398.398l.518 1.477c.349.992.174 2.093-.463 2.929l-.95 1.244c-.158.208-.006.508.256.502l1.564-.037c1.052-.024 2.045.481 2.643 1.346l.89 1.287c.149.216.481.163.556-.088l.448-1.499a3.32 3.32 0 0 1 2.097-2.097l1.499-.448c.251-.075.304-.407.088-.556l-1.287-.89a3.32 3.32 0 0 1-1.346-2.643l.037-1.564c.006-.262-.294-.414-.502-.256l-1.244.95a3.32 3.32 0 0 1-2.929.463Zm-1.573-2.207c-1.236-.433-2.424.755-1.991 1.991l.734 2.09a1.32 1.32 0 0 1-.232 1.465l-1.344 1.761c-.794 1.041-.031 2.539 1.279 2.508l2.214-.052c.526-.012 1.022.241 1.321.674l1.26 1.821c.745 1.078 2.405.815 2.781-.44l.635-2.122c.15-.504.544-.898 1.048-1.048l2.122-.635c1.255-.376 1.518-2.036.44-2.781l-1.821-1.26a1.32 1.32 0 0 1-.674-1.321l.052-2.214c.031-1.31-1.467-2.073-2.509-1.279l-1.76 1.344a1.32 1.32 0 0 1-1.465.232l-2.09-.734Z"
    />
    <path d="M12.387 13.729a.9.9 0 1 1 1.344-1.344l3.384 2.722a1.5 1.5 0 1 1-1.885 2.007l-2.72-3.385Z" />
  </svg>
)

const VoiceIcon = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 18 18"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M3.2 7.2h2.1l3.1-2.5v8.6L5.3 10.8H3.2V7.2Z" />
    <path d="M11 6.1c1.55 1.6 1.55 4.2 0 5.8" />
    <path d="M12.6 4.5c2 2.5 2 6.5 0 9" />
  </svg>
)

const FontSizeIcon = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 18 18"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M1.4 14.25 3.8 8.25l2.4 6M2.2 12.25h3.2" />
    <path d="M8.6 14.25 12.6 3.75l4 10.5M9.95 10.75h5.3" />
  </svg>
)

const Info = ({ glyph = 'i' }: { glyph?: string }) => <span className={styles.info}>{glyph}</span>

const Group = ({
  label,
  children,
  spaced,
}: {
  label?: string
  children: ReactNode
  spaced?: boolean
}) => (
  <section className={styles.group} data-spaced={spaced ? '' : undefined}>
    {label ? <h2>{label}</h2> : null}
    <div className={styles.card}>{children}</div>
  </section>
)

const Row = ({
  label,
  icon,
  value,
  onClick,
  href,
  control,
  danger = false,
  disabled = false,
  arrow = Boolean(onClick || href),
}: {
  label: string
  icon?: ReactNode
  value?: string
  onClick?: () => void
  href?: string
  control?: ReactNode
  danger?: boolean
  disabled?: boolean
  arrow?: boolean
}) => {
  const contents = (
    <>
      {icon ? <span className={styles.icon}>{icon}</span> : null}
      <span className={styles.rowLabel}>{label}</span>
      {value ? <span className={styles.value}>{value}</span> : null}
      {control}
      {arrow ? (
        <span className={styles.arrow}>
          <IconChevronRightOutline14 />
        </span>
      ) : null}
    </>
  )
  if (href) {
    return (
      <a className={styles.row} href={href}>
        {contents}
      </a>
    )
  }
  if (onClick) {
    return (
      <button
        type="button"
        className={styles.row}
        data-danger={danger}
        disabled={disabled}
        onClick={onClick}
      >
        {contents}
      </button>
    )
  }
  return <div className={styles.row}>{contents}</div>
}

const Switch = ({
  label,
  checked,
  toggle,
}: {
  label: string
  checked: boolean
  toggle?: () => void
}) => (
  <button
    type="button"
    className={styles.switch}
    role="switch"
    aria-label={label}
    aria-checked={checked}
    disabled={!toggle}
    onClick={toggle}
  >
    <span />
  </button>
)

const Choice = <T extends string>({
  title,
  icon,
  value,
  fields,
  confirmLabel,
  confirm,
  dismiss,
}: {
  title: string
  icon?: ReactNode
  value: T
  fields: ReadonlyArray<{ id: T; label: string }>
  confirmLabel?: string
  confirm: (value: T) => void
  dismiss: () => void
}) => {
  const t = useTranslate()
  const [next, setNext] = useState(value)
  return (
    <div
      className={styles.overlay}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          dismiss()
        }
      }}
    >
      <section className={styles.choice} role="dialog" aria-modal="true" aria-label={title}>
        <header>
          {icon}
          {title}
        </header>
        <div className={styles.options} role="radiogroup" aria-label={title}>
          {fields.map((field) => (
            <button
              key={field.id}
              type="button"
              role="radio"
              aria-checked={next === field.id}
              onClick={() => setNext(field.id)}
            >
              {field.label}
            </button>
          ))}
        </div>
        <button type="button" className={styles.confirm} onClick={() => confirm(next)}>
          {confirmLabel ?? t('confirm')}
        </button>
      </section>
    </div>
  )
}

export const AndroidSettings = ({ chatFrame }: { chatFrame: RefObject<HTMLDivElement> }) => {
  const open = useSettingsDialog((state) => state.open)
  const section = useSettingsDialog((state) => state.section)
  return open ? (
    <Settings
      start={section === 'general' ? 'root' : 'account'}
      chatFrame={chatFrame}
      key={section}
    />
  ) : null
}

const Settings = ({ start, chatFrame }: { start: Page; chatFrame: RefObject<HTMLDivElement> }) => {
  const t = useTranslate()
  const {
    locale,
    localePreference,
    themePreference,
    fontSize,
    foldThinking,
    ttsVoice,
  } = useSettings()
  const tr = (chinese: string, english: string) => (locale === 'zh-CN' ? chinese : english)
  const [page, setPage] = useState<Page>(start)
  const [popup, setPopup] = useState<Popup | null>(null)
  const [tone, setTone] = useState(ttsVoice)
  const [busy, setBusy] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [importMode, setImportMode] = useState<ImportMode>('merge')
  const [importStatus, setImportStatus] = useState<LinkedMessage | null>(null)
  const [exportSavedName, setExportSavedName] = useState<string | null>(null)
  const importInput = useRef<HTMLInputElement>(null)
  const pagesRef = useRef<HTMLDivElement>(null)
  const motionRef = useRef<ReturnType<typeof createSettingsPageMotion>>()
  const enterNext = useRef(true)
  const exiting = useRef(false)
  const sessions = useChatStore((state) => state.sessions.length)
  const serverConfig = useServerConfig()
  const connected = isServerMode()
  const [serverEditing, setServerEditing] = useState(!connected)
  const [serverUrl, setServerUrl] = useState(displayUrl(serverConfig))
  const [serverPassword, setServerPassword] = useState('')
  const [serverBusy, setServerBusy] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const tunnel = useTunnel()
  const [tsKey, setTsKey] = useState(savedAuthKey())
  const [tsBusy, setTsBusy] = useState(false)
  const [tsError, setTsError] = useState<string | null>(null)
  const tunnelTarget = targetFromUrl(displayUrl(serverConfig))

  const connectServer = async () => {
    if (serverBusy) {
      return
    }
    setServerBusy(true)
    setServerError(null)
    const snapshot = useTunnel.getState()
    const viaTunnel = snapshot.enabled && snapshot.state === 'ready'
    const result = await serverLogin(
      viaTunnel ? `http://${snapshot.addr}` : serverUrl,
      serverPassword,
      { directUrl: serverUrl, tunnel: viaTunnel }
    )
    setServerBusy(false)
    if (result.ok) {
      setServerPassword('')
      setServerEditing(false)
      showToast({ key: 'serverConnectedToast' })
    } else {
      setServerError(result.message ?? t('serverConnectFailed'))
    }
  }

  const startTunnelNow = async () => {
    if (tsBusy) {
      return
    }
    if (!tunnelTarget) {
      setTsError(tr('请先填写服务器地址', 'Set the server URL first'))
      return
    }
    setTsBusy(true)
    setTsError(null)
    useTunnel.getState().start(tsKey.trim() || savedAuthKey(), tunnelTarget)
    const snapshot = await waitTunnel()
    setTsBusy(false)
    if (snapshot.state === 'ready') {
      useTunnel.getState().setEnabled(true)
      applyTunnelAddr(snapshot.addr)
      return
    }
    if (snapshot.state === 'error') {
      setTsError(snapshot.error || tr('隧道启动失败', 'Tunnel failed to start'))
      return
    }
    setTsError(
      snapshot.loginUrl
        ? tr(`需要先在浏览器完成 Tailscale 登录：${snapshot.loginUrl}`, `Complete Tailscale login first: ${snapshot.loginUrl}`)
        : tr('隧道启动超时', 'Tunnel start timed out')
    )
  }

  const stopTunnelNow = () => {
    useTunnel.getState().stop()
    useTunnel.getState().setEnabled(false)
    restoreDirectUrl()
    setTsBusy(false)
    setTsError(null)
  }

  const disconnectServer = () => {
    serverLogout()
    setServerPassword('')
    setServerError(null)
    closeSettings()
    showToast({ key: 'serverDisconnectedToast' })
  }

  const labels: Record<Page, string> = {
    root: t('settings'),
    account: t('accountManagement'),
    data: tr('数据管理', 'Data management'),
    usage: t('settingDialogAsideUsageOptionLabel'),
    export: t('exportAllLabel'),
    font: tr('字体大小', 'Text size'),
    personalization: tr('个性化', 'Personalization'),
  }
  const language = tr('语言', 'Language')
  const appearance = tr('外观', 'Appearance')
  const voice = tr('朗读音色', 'Read-aloud voice')
  const autoFold = tr('思考内容自动折叠', 'Collapse thinking automatically')
  const follow = tr('跟随系统', 'Follow system')
  const clear = tr('删除所有历史对话', 'Delete all conversations')
  const themes: { id: ThemePreference; label: string }[] = [
    { id: 'system', label: tr('系统', 'System') },
    { id: 'light', label: tr('浅色', 'Light') },
    { id: 'dark', label: tr('深色', 'Dark') },
  ]
  const languages: { id: LocalePreference; label: string }[] = [
    { id: 'system', label: tr('系统', 'System') },
    { id: 'zh-CN', label: '中文 (简体中文)' },
    { id: 'en-US', label: 'English' },
  ]
  const tones: { id: TtsVoice; label: string; description: string }[] = [
    {
      id: 'stella',
      label: t('settingsTtsVoiceStella'),
      description: t('settingsTtsVoiceStellaDescription'),
    },
    {
      id: 'tide',
      label: t('settingsTtsVoiceTide'),
      description: t('settingsTtsVoiceTideDescription'),
    },
  ]
  const currentTone = tones.find((item) => item.id === tone) ?? tones[0]
  const systemFontStep = Math.min(
    6,
    Math.max(0, Math.round(((android?.systemFontScale() ?? 1) - 1) / 0.1 + 2))
  )
  const languageLabel = languages.find((item) => item.id === locale)?.label
  const themeLabel = themes.find((item) => item.id === themePreference)?.label

  const openPage = (next: Page) => {
    if (exiting.current) {
      return
    }
    closeOverlaySider()
    enterNext.current = true
    setPage(next)
  }

  const back = () => {
    if (busy || exiting.current) {
      return
    }
    if (popup) {
      setPopup(null)
      setFile(null)
      return
    }
    const finish = () => {
      const previous = parentPage[page]
      if (previous) {
        enterNext.current = false
        setPage(previous)
      } else {
        closeSettings()
      }
    }
    const motion = motionRef.current
    if (!motion) {
      finish()
      return
    }
    closeOverlaySider()
    exiting.current = true
    void motion.play('back').then((finished) => {
      if (motionRef.current !== motion) {
        return
      }
      if (finished) {
        finish()
      } else {
        exiting.current = false
      }
    })
  }

  useAndroidBackInterception()
  useLayoutEffect(() => {
    const pages = pagesRef.current
    const getPage = (screen: Page) =>
      pages?.querySelector<HTMLElement>(`[data-settings-page="${screen}"]`)
    const settings = getPage(page)
    const content = settings?.querySelector<HTMLElement>(`.${styles.pageContent}`)
    if (!settings || !content) {
      return
    }
    const parent = parentPage[page]
    const previous = parent
      ? (getPage(parent)?.querySelector<HTMLElement>(`.${styles.pageContent}`) ?? null)
      : chatFrame.current
    exiting.current = false
    const motion = createSettingsPageMotion(settings, content, previous)
    motionRef.current = motion
    if (enterNext.current) {
      void motion.play('enter').then((finished) => {
        if (finished && motionRef.current === motion && !exiting.current) {
          motion.cancel()
          closeOverlaySider()
        }
      })
    }
    return () => {
      motionRef.current = undefined
      motion.cancel()
    }
  }, [chatFrame, page])

  const canPreview = page !== 'font' && popup === null && !busy
  useLayoutEffect(() => {
    const motion = motionRef.current
    if (!canPreview || !motion) {
      return
    }
    let previewing = false
    const unsubscribe = subscribeToAndroidBackPreview((preview) => {
      if (!exiting.current) {
        if (preview && !previewing) {
          closeOverlaySider()
        }
        previewing = Boolean(preview)
        motion.seek(preview?.progress ?? 0)
      }
    })
    return () => {
      unsubscribe?.()
      if (previewing && !exiting.current && motionRef.current === motion) {
        motion.seek(0)
      }
    }
  }, [canPreview, page])

  useEffect(() => {
    const onBack = (event: Event) => {
      event.preventDefault()
      back()
    }
    window.addEventListener('android-back', onBack)
    return () => window.removeEventListener('android-back', onBack)
  })

  const runExportAction = async (action: () => Promise<void>) => {
    setBusy(true)
    try {
      await action()
    } catch (error) {
      showToast({
        key: 'historyExportFailed',
        params: { message: error instanceof Error ? error.message : String(error) },
        type: 'error',
      })
    } finally {
      setBusy(false)
    }
  }

  const confirmAction = async () => {
    if (busy) {
      return
    }
    setBusy(true)
    try {
      if (popup === 'import' && file) {
        setPopup(null)
        setFile(null)
        setImportStatus({ key: 'historyImporting' })
        const result = await importHistory(file, setImportStatus, importMode)
        setImportStatus(formatImportResult(result))
      } else if (popup === 'delete') {
        await clearHistory()
        showToast({ key: 'historyDeleted' })
        setPopup(null)
      }
    } catch (error) {
      if (popup === 'import') {
        setImportStatus({
          key: error instanceof BackupError ? error.key : 'historyImportFailed',
          type: 'error',
        })
      } else {
        showToast({ key: 'historyDeleteFailed', type: 'error' })
      }
    } finally {
      setBusy(false)
    }
  }

  const renderPage = (screen: Page) => (
    <>
      <header className={styles.header}>
        <button
          type="button"
          className={styles.back}
          aria-label={tr('返回', 'Back')}
          onClick={back}
        >
          <IconChevronRightOutline14 />
        </button>
        <h1>{labels[screen]}</h1>
      </header>
      <div className={styles.scroll}>
        {screen === 'root' ? (
          <>
            <Group label={tr('账户', 'Account')}>
              <Row
                label={labels.account}
                icon={<ProfileIcon />}
                onClick={() => openPage('account')}
              />
              <Row
                label={labels.data}
                icon={<IconDataOutline16 />}
                onClick={() => openPage('data')}
              />
              <Row
                label={labels.usage}
                icon={<IconChartOutline16 />}
                onClick={() => openPage('usage')}
              />
            </Group>
            <Group label={tr('应用', 'App')}>
              <Row
                label={language}
                value={languageLabel}
                icon={<IconGlobeLanguageOutline14 />}
                onClick={() => setPopup('locale')}
              />
              <Row
                label={appearance}
                value={themeLabel}
                icon={<IconLightOutline16 />}
                onClick={() => setPopup('theme')}
              />
              <Row label={labels.font} icon={<FontSizeIcon />} onClick={() => openPage('font')} />
              <Row
                label={labels.personalization}
                icon={<PersonalizationIcon />}
                onClick={() => openPage('personalization')}
              />
            </Group>
            <Group label={tr('语音', 'Voice')}>
              <Row
                label={voice}
                icon={<VoiceIcon />}
                arrow={false}
                onClick={() => {
                  setTone(ttsVoice)
                  setPopup('voice')
                }}
              />
            </Group>
            <Group label={tr('关于', 'About')}>
              <Row label={tr('版本信息', 'Version')} value={appVersion} icon={<Info />} />
            </Group>
          </>
        ) : null}
        {screen === 'account' ? (
          <>
            <Group label={tr('服务器', 'Server')}>
              <Row
                label={t('serverUrl')}
                value={connected ? displayUrl(serverConfig) : tr('未连接', 'Not connected')}
                onClick={() => setServerEditing((open) => !open)}
              />
              {connected ? (
                <>
                  <Row
                    label={t('serverAgentTitle')}
                    control={
                      <Switch
                        label={t('serverAgentTitle')}
                        checked={serverConfig.agent}
                        toggle={() => setServerOptions({ agent: !serverConfig.agent })}
                      />
                    }
                  />
                  <Row
                    label={t('serverMemoryTitle')}
                    control={
                      <Switch
                        label={t('serverMemoryTitle')}
                        checked={serverConfig.memory}
                        toggle={() => setServerOptions({ memory: !serverConfig.memory })}
                      />
                    }
                  />
                </>
              ) : null}
              {serverEditing || !connected ? (
                <div className={styles.serverForm}>
                  <label className={styles.serverField}>
                    <span>{t('serverUrl')}</span>
                    <input
                      value={serverUrl}
                      inputMode="url"
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      placeholder="http://192.168.1.10:8090"
                      onChange={(event) => setServerUrl(event.target.value)}
                    />
                  </label>
                  <label className={styles.serverField}>
                    <span>{t('serverPassword')}</span>
                    <input
                      type="password"
                      value={serverPassword}
                      autoComplete="current-password"
                      placeholder={t('serverPasswordPlaceholder')}
                      onChange={(event) => setServerPassword(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                          void connectServer()
                        }
                      }}
                    />
                  </label>
                  <div className={styles.serverActions}>
                    <button
                      type="button"
                      className={styles.serverConnect}
                      disabled={serverBusy || !serverUrl.trim()}
                      onClick={() => void connectServer()}
                    >
                      {t(serverBusy ? 'serverConnecting' : 'serverConnect')}
                    </button>
                    {connected ? (
                      <button
                        type="button"
                        className={styles.serverDisconnect}
                        onClick={disconnectServer}
                      >
                        {t('serverDisconnect')}
                      </button>
                    ) : null}
                  </div>
                  {serverError ? (
                    <p className={styles.serverError} role="alert">
                      {serverError}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {!connected ? (
                <p className={styles.serverHint}>{t('serverDisconnectedDescription')}</p>
              ) : null}
            </Group>
            <Group label={tr('内置 Tailscale', 'Built-in Tailscale')}>
              <Row
                label={tr('通过隧道连接', 'Connect through tunnel')}
                value={
                  tunnel.state === 'ready'
                    ? tunnel.ip || tr('已连接', 'Ready')
                    : tunnel.state === 'starting'
                      ? tr('连接中…', 'Connecting…')
                      : tunnel.enabled
                        ? tr('未就绪', 'Not ready')
                        : tr('未启用', 'Off')
                }
                control={
                  <Switch
                    label={tr('内置 Tailscale', 'Built-in Tailscale')}
                    checked={tunnel.enabled}
                    toggle={() => {
                      if (tunnel.enabled) {
                        stopTunnelNow()
                      } else {
                        void startTunnelNow()
                      }
                    }}
                  />
                }
              />
              {tunnel.enabled ? (
                <div className={styles.serverForm}>
                  <p className={styles.serverHint}>
                    {tr(
                      'App 内直接建立 Tailscale 连接，只有发往服务器的请求走隧道；不需要系统 VPN，也不接管其他流量。',
                      'Runs a userspace Tailscale node inside the app. Only requests to the server use the tunnel — no system VPN.'
                    )}
                  </p>
                  <label className={styles.serverField}>
                    <span>{tr('Tailscale Auth Key', 'Tailscale auth key')}</span>
                    <input
                      type="password"
                      value={tsKey}
                      autoComplete="off"
                      placeholder="tskey-auth-..."
                      onChange={(event) => setTsKey(event.target.value)}
                    />
                  </label>
                  <p className={styles.serverHint}>
                    {tunnelTarget
                      ? tr(`隧道目标：${tunnelTarget}`, `Tunnel target: ${tunnelTarget}`)
                      : tr('请先在上面填写服务器地址', 'Set the server URL above first')}
                  </p>
                  {tunnel.state === 'ready' ? (
                    <p className={styles.serverHint}>
                      {tr(
                        `已就绪：本机节点 ${tunnel.ip}，请求经 127.0.0.1 转发`,
                        `Ready: node ${tunnel.ip}, requests forwarded via 127.0.0.1`
                      )}
                    </p>
                  ) : null}
                  {tsError || tunnel.error ? (
                    <p className={styles.serverError} role="alert">
                      {tsError || tunnel.error}
                    </p>
                  ) : null}
                  <div className={styles.serverActions}>
                    <button
                      type="button"
                      className={styles.serverConnect}
                      disabled={tsBusy}
                      onClick={() => void startTunnelNow()}
                    >
                      {tsBusy ? tr('启动中…', 'Starting…') : tr('启动隧道', 'Start tunnel')}
                    </button>
                    <button type="button" className={styles.serverDisconnect} onClick={stopTunnelNow}>
                      {tr('停止隧道', 'Stop tunnel')}
                    </button>
                  </div>
                </div>
              ) : null}
            </Group>
            <Group>
              <ProfileEditor />
            </Group>
            <p className={styles.legal}>{t('appName')}</p>
          </>
        ) : null}
        {screen === 'usage' ? (
          <UsagePanel />
        ) : null}
        {screen === 'data' ? (
          <>
            <p className={styles.caption}>
              {tr(
                '历史对话仅保存在此设备；模型、记忆、Agent 与上下文压缩由已连接的服务端处理。',
                'Chat history stays on this device. Model, memory, agent and compression run on the connected server.'
              )}
            </p>
            <Group>
              <Row
                label={labels.export}
                disabled={busy}
                onClick={() => {
                  setExportSavedName(null)
                  openPage('export')
                }}
              />
            </Group>
            <Group>
              <Row
                label={clear}
                danger
                arrow={false}
                disabled={busy}
                onClick={() => setPopup('delete')}
              />
            </Group>
            <Group>
              <Row
                label={t('historyImport')}
                arrow={false}
                disabled={busy}
                onClick={() => importInput.current?.click()}
              />
              <input
                ref={importInput}
                hidden
                type="file"
                accept=".zip,application/zip"
                onChange={(event) => {
                  const selected = event.target.files?.[0]
                  event.target.value = ''
                  if (selected) {
                    setImportMode('merge')
                    setFile(selected)
                    setPopup('import')
                  }
                }}
              />
            </Group>
            {importStatus ? (
              <p
                className={styles.caption}
                role={importStatus.type === 'error' ? 'alert' : 'status'}
              >
                {t(importStatus.key, importStatus.params)}
              </p>
            ) : null}
          </>
        ) : null}
        {screen === 'export' ? (
          <>
            <Group>
              <Row
                label={tr('保存到设备', 'Save to device')}
                arrow={false}
                disabled={busy || !sessions}
                onClick={() =>
                  void runExportAction(async () => {
                    setExportSavedName(null)
                    const exported = await exportHistory()
                    const warning = formatExportWarning(exported)
                    if (warning) {
                      showToast(warning)
                    }
                    if (android) {
                      if (await saveAndroidHistory(exported.name, exported.blob)) {
                        setExportSavedName(exported.name)
                      }
                      return
                    }
                    const url = URL.createObjectURL(exported.blob)
                    const link = document.createElement('a')
                    link.href = url
                    link.download = exported.name
                    link.click()
                    setTimeout(() => URL.revokeObjectURL(url), 10_000)
                    setExportSavedName(exported.name)
                  })
                }
              />
            </Group>
            <p className={styles.caption} role="status">
              {busy
                ? t('historyExporting')
                : exportSavedName
                  ? t('historyExportSaved', { name: exportSavedName })
                  : t(sessions ? 'historyExportDescription' : 'androidNoChats')}
            </p>
          </>
        ) : null}
        {screen === 'font' ? (
          <div
            className={styles.preview}
            style={{
              fontSize: `${16 * (fontSize === null ? (android?.systemFontScale() ?? 1) : 1 + (fontSize - 2) * 0.1)}px`,
            }}
          >
            <span>{tr('预览文字大小', 'Preview text size')}</span>
            <p>
              {tr('你可以拖动滑块来调整字体大小。', 'Drag the slider to adjust the text size.')}
            </p>
            <p>
              {tr(
                '如果在使用过程中存在问题或建议，可反馈给 DeepSeek 团队。',
                'You can share questions or suggestions with DeepSeek.'
              )}
            </p>
          </div>
        ) : null}
        {screen === 'personalization' ? (
          <>
            <Group>
              <Row
                label={autoFold}
                control={
                  <Switch
                    label={autoFold}
                    checked={foldThinking}
                    toggle={() => setFoldThinking(!foldThinking)}
                  />
                }
              />
            </Group>
            <p className={styles.caption}>
              {tr(
                '开启后，思考结束后将自动折叠思考内容',
                'Collapse thinking once an answer is ready.'
              )}
            </p>
          </>
        ) : null}
      </div>
      {screen === 'font' ? (
        <div className={styles.fontPanel}>
          <Row
            label={follow}
            control={
              <Switch
                label={follow}
                checked={fontSize === null}
                toggle={() => setFontSize(fontSize === null ? systemFontStep : null)}
              />
            }
          />
          <div className={styles.fontLabels}>
            <small>A</small>
            <span>{tr('标准', 'Standard')}</span>
            <strong>A</strong>
          </div>
          <div className={styles.rangeWrap}>
            <div className={styles.rangeTicks} aria-hidden="true">
              {Array.from({ length: 7 }, (_, step) => (
                <span key={step} />
              ))}
            </div>
            <input
              type="range"
              aria-label={labels.font}
              min="0"
              max="6"
              step="1"
              value={fontSize ?? systemFontStep}
              onChange={(event) => setFontSize(event.target.valueAsNumber)}
            />
          </div>
        </div>
      ) : null}
    </>
  )

  const popups = (
    <>
      {popup === 'locale' ? (
        <Choice
          title={language}
          icon={<IconGlobeLanguageOutline14 />}
          value={localePreference}
          fields={languages}
          confirmLabel={tr('确认', 'Confirm')}
          confirm={(value) => {
            setLocale(value)
            setPopup(null)
          }}
          dismiss={back}
        />
      ) : null}
      {popup === 'theme' ? (
        <Choice
          title={appearance}
          value={themePreference}
          fields={themes}
          confirmLabel={tr('确认', 'Confirm')}
          confirm={(value) => {
            setThemePreference(value)
            setPopup(null)
          }}
          dismiss={back}
        />
      ) : null}
      {popup === 'voice' ? (
        <div
          className={styles.overlay}
          data-sheet=""
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              back()
            }
          }}
        >
          <section className={styles.voiceSheet} role="dialog" aria-modal="true" aria-label={voice}>
            <header>
              {voice}
              <button type="button" aria-label={t('close')} onClick={back}>
                <IconCloseOutline16 />
              </button>
            </header>
            <div
              className={styles.voiceBody}
              onTouchStart={(event) => {
                event.currentTarget.dataset.swipeX = String(event.touches[0].clientX)
              }}
              onTouchEnd={(event) => {
                const dx =
                  event.changedTouches[0].clientX - Number(event.currentTarget.dataset.swipeX)
                if (Math.abs(dx) > 32) {
                  setTone(dx > 0 ? 'stella' : 'tide')
                }
              }}
            >
              <div className={styles.voiceArt} data-tone={tone} aria-hidden="true" />
              <div>{currentTone.label}</div>
              <small>{currentTone.description}</small>
              <div className={styles.dots} role="radiogroup" aria-label={voice}>
                {tones.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="radio"
                    aria-label={item.label}
                    aria-checked={tone === item.id}
                    onClick={() => setTone(item.id)}
                  />
                ))}
              </div>
            </div>
            <button
              className={styles.primary}
              type="button"
              onClick={() => {
                setTtsVoice(tone)
                setPopup(null)
              }}
            >
              {tr('确认', 'Confirm')}
            </button>
          </section>
        </div>
      ) : null}
      {popup === 'import' ? (
        <div
          className={styles.overlay}
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              back()
            }
          }}
        >
          <section
            className={styles.choice}
            role="dialog"
            aria-modal="true"
            aria-label={t('historyImportConfirmTitle')}
          >
            <header>{t('historyImportConfirmTitle')}</header>
            <div
              className={styles.options}
              role="radiogroup"
              aria-label={t('historyImportConfirmTitle')}
            >
              <button
                type="button"
                role="radio"
                aria-checked={importMode === 'merge'}
                disabled={busy}
                onClick={() => setImportMode('merge')}
              >
                {t('historyImportModeMerge')}
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={importMode === 'replace'}
                disabled={busy}
                onClick={() => setImportMode('replace')}
              >
                {t('historyImportModeReplace')}
              </button>
            </div>
            <p className={styles.importDescription}>
              {t(
                importMode === 'merge'
                  ? 'historyImportModeMergeDescription'
                  : 'historyImportModeReplaceDescription'
              )}
            </p>
            <div className={styles.confirmActions}>
              <button type="button" className={styles.confirm} disabled={busy} onClick={back}>
                {t('cancel')}
              </button>
              <button
                type="button"
                className={styles.confirm}
                disabled={busy}
                data-danger={importMode === 'replace'}
                onClick={() => void confirmAction()}
              >
                {t(
                  importMode === 'merge'
                    ? 'historyImportMergeConfirm'
                    : 'historyImportReplaceConfirm'
                )}
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {popup === 'delete' ? (
        <div className={styles.overlay}>
          <section className={styles.choice} role="dialog" aria-modal="true">
            <header>{clear}</header>
            <p className={styles.message}>{t('deleteAllSessionsModalDescription')}</p>
            <div className={styles.confirmActions}>
              <button className={styles.confirm} disabled={busy} onClick={back}>
                {t('cancel')}
              </button>
              <button
                className={styles.confirm}
                disabled={busy}
                data-danger
                onClick={() => void confirmAction()}
              >
                {t('confirm')}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  )

  const pages = [page]
  for (let parent = parentPage[page]; parent; parent = parentPage[parent]) {
    pages.unshift(parent)
  }

  return (
    <div ref={pagesRef}>
      {pages.map((screen) => {
        const active = screen === page
        return (
          <section
            key={screen}
            ref={(element) => {
              setInert(element, !active)
            }}
            className={styles.page}
            data-settings-page={screen}
            role="region"
            aria-label={labels[screen]}
            aria-hidden={active ? undefined : true}
          >
            <div className={styles.pageContent}>{renderPage(screen)}</div>
            {active ? popups : null}
          </section>
        )
      })}
    </div>
  )
}
