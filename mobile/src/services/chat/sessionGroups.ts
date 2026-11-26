import { translate } from '../../i18n/index.js'
import { monthKey } from '../../utils/format.js'
import type { SessionSummary } from './types.js'

const DAY = 86_400_000

const startOfDay = (time: number) => new Date(time).setHours(0, 0, 0, 0)

export type SessionSection = {
  key: string
  label: string
  sessions: SessionSummary[]
  /** 'pinned' = 置顶；'timeline' = 时间分组（未分组会话）；'group' = 自定义分组；'archive' = 已归档 */
  kind: 'pinned' | 'timeline' | 'group' | 'archive'
}

const byUpdatedDesc = (a: SessionSummary, b: SessionSummary) => b.updatedAt - a.updatedAt

/**
 * 侧边栏分区（与网页端一致）：置顶 → 未分组会话按时间分组（今天/昨天/7 天内/30 天内/按月）
 * → 自定义分组（按名称排序）→ 已归档（折叠区）。
 * 移动端的置顶保存在设置里，因此以 pinnedIds 传入。
 */
export const groupSessions = (
  sessions: SessionSummary[],
  now: number,
  pinnedIds: readonly string[] = [],
  t = translate
): SessionSection[] => {
  const pinnedSet = new Set(pinnedIds)
  const archived: SessionSummary[] = []
  const pinned: SessionSummary[] = []
  const byGroup = new Map<string, SessionSummary[]>()
  const loose: SessionSummary[] = []
  for (const session of sessions) {
    if (session.archived) {
      archived.push(session)
    } else if (pinnedSet.has(session.id)) {
      pinned.push(session)
    } else if (session.group) {
      const list = byGroup.get(session.group)
      if (list) {
        list.push(session)
      } else {
        byGroup.set(session.group, [session])
      }
    } else {
      loose.push(session)
    }
  }

  const sections: SessionSection[] = []

  if (pinned.length > 0) {
    sections.push({
      key: 'pinned',
      label: t('androidPinned'),
      sessions: pinned.sort(byUpdatedDesc),
      kind: 'pinned',
    })
  }

  // 未分组会话：沿用时间分组
  for (const session of loose.sort(byUpdatedDesc)) {
    const diff = Math.floor((now - startOfDay(session.updatedAt)) / DAY)
    const key =
      diff <= 0
        ? 'sessionHistoryTimelineLabelToday'
        : diff <= 1
          ? 'sessionHistoryTimelineLabelYesterday'
          : diff < 7
            ? 'sessionHistoryTimelineLabel7days'
            : diff < 30
              ? 'sessionHistoryTimelineLabel30days'
              : null
    const groupKey = key ?? monthKey(session.updatedAt) ?? ''
    const last = sections.at(-1)
    if (last?.kind === 'timeline' && last.key === groupKey) {
      last.sessions.push(session)
    } else {
      sections.push({
        key: groupKey,
        label: key ? t(key) : groupKey,
        sessions: [session],
        kind: 'timeline',
      })
    }
  }

  // 自定义分组（按名称排序，组内按更新时间倒序）
  for (const [name, list] of [...byGroup.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh-CN'))) {
    sections.push({
      key: `group:${name}`,
      label: name,
      sessions: list.sort(byUpdatedDesc),
      kind: 'group',
    })
  }

  if (archived.length > 0) {
    sections.push({
      key: 'archive',
      label: t('sessionGroupArchive'),
      sessions: archived.sort(byUpdatedDesc),
      kind: 'archive',
    })
  }
  return sections
}

/** 现有分组名列表（去重排序，供「移动到分组」使用） */
export const listSessionGroups = (sessions: SessionSummary[]): string[] =>
  [
    ...new Set(
      sessions
        .map((session) => session.group)
        .filter((group): group is string => Boolean(group))
    ),
  ].sort((a, b) => a.localeCompare(b, 'zh-CN'))
