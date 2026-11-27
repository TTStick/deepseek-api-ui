import { create } from 'zustand'
import { useSettings } from '../../services/settings.js'
import { isServerApiKeyConfigured } from '../../services/serverKey.js'

/** 设置弹窗的分组：通用设置 / 服务端 / 记忆与上下文 / 消耗统计 / 数据管理 */
export type SettingsSection = 'general' | 'server' | 'memory' | 'usage' | 'data'

/** 设置弹窗：侧边栏底部、没有 API Key 时的操作与 401 提示都可以打开；section 为打开时选中的分组 */
export const useSettingsDialog = create(() => ({
  open: false,
  section: 'general' as SettingsSection,
}))

export const openSettings = (section: SettingsSection) =>
  useSettingsDialog.setState({ open: true, section })

export const closeSettings = () => useSettingsDialog.setState({ open: false })

/**
 * 聊天/压缩：本机 Key 或服务端 Key 任一可用即可。
 * 服务端 Key 由 /api/auth/status 的布尔字段告知，不会下发到浏览器。
 */
export const ensureApiKey = () => {
  if (useSettings.getState().apiKey || isServerApiKeyConfigured()) {
    return true
  }
  openSettings('data')
  return false
}

/** 附件上传仍直连 DeepSeek Files API，必须使用本机 Key */
export const ensureLocalApiKey = () => {
  if (useSettings.getState().apiKey) {
    return true
  }
  openSettings('data')
  return false
}
