type SessionListener = (id: string) => void

let savedListener: SessionListener | null = null
let deletedListener: SessionListener | null = null

/** 会话保存/删除时通知同步层；同步层未启动时为空操作 */
export const setSessionSyncListeners = (listeners: {
  saved: SessionListener
  deleted: SessionListener
}) => {
  savedListener = listeners.saved
  deletedListener = listeners.deleted
}

export const notifySessionSaved = (id: string) => {
  savedListener?.(id)
}

export const notifySessionDeleted = (id: string) => {
  deletedListener?.(id)
}
