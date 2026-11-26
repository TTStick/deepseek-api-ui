import { create } from 'zustand'
import type { TtsVoice } from './api/speech.js'
import type { ChatModel } from './api/types.js'
import { normalizeLocation, type UserLocation } from './location.js'

export type Locale = 'zh-CN' | 'en-US'

/** 主题偏好；默认跟随系统 */
export type ThemePreference = 'light' | 'dark' | 'system'

/** 本机设置，存 localStorage：API Key、语言、主题、位置、朗读音色、深度思考与智能搜索开关、侧边栏收起状态 */
type Settings = {
  apiKey: string | null
  locale: Locale
  themePreference: ThemePreference
  location: UserLocation | null
  ttsVoice: TtsVoice
  thinking: boolean
  search: boolean
  siderCollapsed: boolean
  /** 自我检索开关：开启后每轮请求会注入后端召回的长期记忆 */
  memoryEnabled: boolean
  /** 是否在回答里展示「本轮召回的记忆」详情面板 */
  showRecalledMemory: boolean
  /** 上下文压缩开关 */
  compressionEnabled: boolean
  /** 聊天模型：默认 deepseek-flash（快），可切换 deepseek-v4-pro（更强） */
  model: ChatModel
  /** 界面字体大小：小 / 标准 / 大 / 特大 */
  fontSize: FontSize
  /** 思考内容自动折叠：回答中的思考过程默认收起，点击标题可展开 */
  collapseThinking: boolean
}

export type FontSize = 'small' | 'medium' | 'large' | 'xlarge'

const KEYS = {
  apiKey: 'chat-demo:api-key',
  locale: 'chat-demo:locale',
  location: 'chat-demo:location',
  themePreference: 'chat-demo:theme-preference',
  ttsVoice: 'chat-demo:tts-voice',
  thinking: 'chat-demo:thinking',
  search: 'chat-demo:search',
  siderCollapsed: 'chat-demo:sider-collapsed',
  memoryEnabled: 'chat-demo:memory-enabled',
  showRecalledMemory: 'chat-demo:show-recalled-memory',
  compressionEnabled: 'chat-demo:compression-enabled',
  model: 'chat-demo:model',
  fontSize: 'chat-demo:font-size',
  collapseThinking: 'chat-demo:collapse-thinking',
} as const

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    // 存储不可用时只在内存中生效
  }
}

/** 位置选择模式跟随浏览器语言，与应用内选择的界面语言无关。 */
export const isChineseBrowser = (): boolean =>
  (typeof navigator === 'undefined' ? 'zh' : navigator.language).toLowerCase().startsWith('zh')

const initialLocale = (): Locale => {
  const saved = read(KEYS.locale)
  if (saved === 'zh-CN' || saved === 'en-US') {
    return saved
  }
  return isChineseBrowser() ? 'zh-CN' : 'en-US'
}

const initialLocation = (): UserLocation | null => {
  try {
    const location = normalizeLocation(JSON.parse(read(KEYS.location) ?? 'null'))
    if (!location) {
      return null
    }
    return isChineseBrowser()
      ? location.region === 'CN' && location.province
        ? location
        : null
      : { region: location.region }
  } catch {
    return null
  }
}

/** 未保存过时跟随系统 */
const initialThemePreference = (): ThemePreference => {
  const saved = read(KEYS.themePreference)
  return saved === 'light' || saved === 'dark' ? saved : 'system'
}

/** 未保存过时使用服务端默认音色 stella（海星） */
const initialTtsVoice = (): TtsVoice => (read(KEYS.ttsVoice) === 'tide' ? 'tide' : 'stella')

/** 未保存过时用标准字号 */
const initialFontSize = (): FontSize => {
  const saved = read(KEYS.fontSize)
  return saved === 'small' || saved === 'large' || saved === 'xlarge' ? saved : 'medium'
}

export const useSettings = create<Settings>(() => ({
  apiKey: read(KEYS.apiKey),
  locale: initialLocale(),
  location: initialLocation(),
  themePreference: initialThemePreference(),
  ttsVoice: initialTtsVoice(),
  thinking: read(KEYS.thinking) === 'true',
  search: read(KEYS.search) === 'true',
  siderCollapsed: read(KEYS.siderCollapsed) === 'true',
  memoryEnabled: read(KEYS.memoryEnabled) === 'true',
  showRecalledMemory: read(KEYS.showRecalledMemory) !== 'false',
  compressionEnabled: read(KEYS.compressionEnabled) !== 'false',
  model: read(KEYS.model) === 'deepseek-v4-pro' ? 'deepseek-v4-pro' : 'deepseek-flash',
  fontSize: initialFontSize(),
  collapseThinking: read(KEYS.collapseThinking) === 'true',
}))

export const setLocale = (locale: Locale) => {
  write(KEYS.locale, locale)
  useSettings.setState({ locale })
}

export const setLocation = (value: UserLocation | null) => {
  const location = normalizeLocation(value)
  write(KEYS.location, location ? JSON.stringify(location) : null)
  useSettings.setState({ location })
}

export const setThemePreference = (themePreference: ThemePreference) => {
  write(KEYS.themePreference, themePreference)
  useSettings.setState({ themePreference })
}

export const setTtsVoice = (ttsVoice: TtsVoice) => {
  write(KEYS.ttsVoice, ttsVoice)
  useSettings.setState({ ttsVoice })
}

export const setApiKey = (apiKey: string | null) => {
  write(KEYS.apiKey, apiKey)
  useSettings.setState({ apiKey })
}

export const setThinking = (thinking: boolean) => {
  write(KEYS.thinking, String(thinking))
  useSettings.setState({ thinking })
}

export const setSearch = (search: boolean) => {
  write(KEYS.search, String(search))
  useSettings.setState({ search })
}

export const setSiderCollapsed = (siderCollapsed: boolean) => {
  write(KEYS.siderCollapsed, String(siderCollapsed))
  useSettings.setState({ siderCollapsed })
}

export const setMemoryEnabled = (memoryEnabled: boolean) => {
  write(KEYS.memoryEnabled, String(memoryEnabled))
  useSettings.setState({ memoryEnabled })
}

export const setShowRecalledMemory = (showRecalledMemory: boolean) => {
  write(KEYS.showRecalledMemory, String(showRecalledMemory))
  useSettings.setState({ showRecalledMemory })
}

export const setCompressionEnabled = (compressionEnabled: boolean) => {
  write(KEYS.compressionEnabled, String(compressionEnabled))
  useSettings.setState({ compressionEnabled })
}

export const setModel = (model: ChatModel) => {
  write(KEYS.model, model)
  useSettings.setState({ model })
}

export const setFontSize = (fontSize: FontSize) => {
  write(KEYS.fontSize, fontSize)
  useSettings.setState({ fontSize })
}

export const setCollapseThinking = (collapseThinking: boolean) => {
  write(KEYS.collapseThinking, String(collapseThinking))
  useSettings.setState({ collapseThinking })
}
