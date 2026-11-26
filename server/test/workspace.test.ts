import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspaceManager, WorkspaceError } from '../src/agent/workspace.js'

describe('WorkspaceManager', () => {
  let root: string
  let workspaces: WorkspaceManager

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'myagent-ws-test-'))
    workspaces = new WorkspaceManager(root)
  })

  afterEach(async () => {
    const { rm } = await import('node:fs/promises')
    await rm(root, { recursive: true, force: true })
  })

  it('每个会话拥有独立目录（同一会话幂等，不同会话隔离）', async () => {
    const dirA = await workspaces.ensure('session-a')
    const dirB = await workspaces.ensure('session-b')
    expect(dirA).not.toBe(dirB)
    expect(dirA).toBe(await workspaces.ensure('session-a'))
  })

  it('写入 → 读取 → 树 → 删除全链路', async () => {
    await workspaces.writeFile('s1', 'docs/note.md', '# 标题\n内容')
    await workspaces.writeFile('s1', 'script.py', 'print(1)')
    const { content } = await workspaces.readFile('s1', 'docs/note.md')
    expect(content).toBe('# 标题\n内容')
    const tree = await workspaces.tree('s1')
    expect(tree.some((node) => node.name === 'docs' && node.type === 'dir')).toBe(true)
    expect(tree.some((node) => node.name === 'script.py')).toBe(true)
    await workspaces.deleteFile('s1', 'docs')
    expect((await workspaces.tree('s1')).some((node) => node.name === 'docs')).toBe(false)
  })

  it('路径越界被拒绝（../ 逃逸与绝对路径）', async () => {
    await expect(workspaces.writeFile('s1', '../escape.txt', 'x')).rejects.toBeInstanceOf(WorkspaceError)
    await expect(workspaces.readFile('s1', '/etc/passwd')).rejects.toBeInstanceOf(WorkspaceError)
  })

  it('写入实际落在会话目录内', async () => {
    const dir = await workspaces.ensure('s1')
    await workspaces.writeFile('s1', 'a.txt', 'hello')
    const content = await readFile(path.join(dir, 'a.txt'), 'utf8')
    expect(content).toBe('hello')
  })

  it('cleanup 删除整个工作区（幂等）', async () => {
    await workspaces.writeFile('s1', 'a.txt', 'x')
    expect((await workspaces.info('s1')).exists).toBe(true)
    await workspaces.cleanup('s1')
    expect((await workspaces.info('s1')).exists).toBe(false)
    await workspaces.cleanup('s1')
  })
})
