import { create } from 'zustand'
import { useSettings } from '../../services/settings.js'
import { isServerMode } from '../../services/api/serverMode.js'

export type SettingsSection = 'general' | 'account' | 'server' | 'usage' | 'data' | 'advanced'

/** 设置弹窗：侧边栏底部、没有 API Key 时的操作与 401 提示都可以打开；section 为打开时选中的分组 */
export const useSettingsDialog = create(() => ({
  open: false,
  section: 'general' as SettingsSection,
}))

export const openSettings = (section: SettingsSection) =>
  useSettingsDialog.setState({ open: true, section })

export const closeSettings = () => useSettingsDialog.setState({ open: false })

/** 没有 API Key 时打开设置并选中 API Key 所在的「数据管理」，返回是否已有 Key。服务器模式视为已配置。 */
export const ensureApiKey = (deepSeekOnly = false) => {
  const { apiKey, chatConfig } = useSettings.getState()
  if (apiKey || (!deepSeekOnly && chatConfig.endpoint) || (!deepSeekOnly && isServerMode())) {
    return true
  }
  openSettings('data')
  return false
}
