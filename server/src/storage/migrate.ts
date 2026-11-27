import { migrateWorkspaceStorage } from '../agent/workspace.js'
import { migrateAuthSecret } from '../auth.js'
import { migrateIndexStorage } from '../indexing/store.js'
import { migrateSessionStorage } from '../sessions.js'
import { migrateUsageStorage } from '../usage.js'

export type MigrationResult = {
  sessions: number
  metas: number
  tombstones: number
  workspaceFiles: number
  indexes: number
  usageState: boolean
  authSecret: boolean
}

/**
 * 启动时的一次性静态加密迁移。所有写入都是原子替换，失败后可以重跑。
 * 只处理历史明文文件；已经是 MAG1 密文的文件会跳过。
 */
export const migrateAtRest = async (): Promise<MigrationResult> => {
  const sessions = await migrateSessionStorage()
  const usageState = await migrateUsageStorage()
  const authSecret = await migrateAuthSecret()
  const workspaceFiles = await migrateWorkspaceStorage()
  const indexes = await migrateIndexStorage()
  return {
    ...sessions,
    workspaceFiles,
    indexes,
    usageState,
    authSecret,
  }
}
