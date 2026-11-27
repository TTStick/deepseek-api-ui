import { searchConversation, searchReferences, type IndexOptions } from '../indexing/store.js'
import { runPythonAsScript, type ExecResult } from './exec.js'
import { SshManager, sshManager, type SshConfig } from './ssh.js'
import { workspaces } from './workspace.js'

/**
 * Agent 工具集（移植 claude-code 的 Read/Write/Edit/Bash 工具概念，
 * 简化为会话工作区内的文件操作 + 隔离 python 执行）：
 * - 本地模式：操作 server 容器内的工作区目录
 * - SSH 模式：同一套工具操作远程主机的 remotePath
 * 工具以 Anthropic function-calling 格式暴露给模型。
 */

export type AgentToolName =
  | 'list_files'
  | 'read_file'
  | 'write_file'
  | 'delete_file'
  | 'run_python'
  | 'run_script'
  | 'search_conversation'
  | 'search_references'

export const AGENT_TOOLS: Array<{ name: AgentToolName; description: string; input_schema: unknown }> = [
  {
    name: 'list_files',
    description: '列出工作区目录下的文件与子目录（path 为空表示根目录）',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对工作区的目录路径' } },
    },
  },
  {
    name: 'read_file',
    description:
      '按行分块读取工作区内的文件。默认读取前 800 行；大文件用 offset（从 1 开始的行号）和 limit 继续读取。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区的文件路径' },
        offset: { type: 'number', description: '起始行号，从 1 开始，默认 1' },
        limit: { type: 'number', description: '最多读取行数，默认 800，最大 5000' },
        char_offset: {
          type: 'number',
          description: '仅超长单行时使用：从该行的第几个字符继续读取，返回值会给出下一段位置',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: '在工作区内创建或覆盖文件（如 .py 脚本、.md 文档、.csv 数据）',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区的文件路径' },
        content: { type: 'string', description: '文件完整内容' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'delete_file',
    description: '删除工作区内的文件或目录',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对工作区的路径' } },
      required: ['path'],
    },
  },
  {
    name: 'run_python',
    description:
      '在工作区内隔离执行一段 Python 代码（已预装 numpy、matplotlib、pandas、requests）。' +
      'matplotlib 使用无头模式，保存图片用 plt.savefig("文件名.png")，图片会交付给用户。',
    input_schema: {
      type: 'object',
      properties: { code: { type: 'string', description: 'Python 代码' } },
      required: ['code'],
    },
  },
  {
    name: 'run_script',
    description: '执行工作区内已有的 .py 脚本（可传命令行参数）',
    input_schema: {
      type: 'object',
      properties: {
        script: { type: 'string', description: '相对工作区的脚本路径' },
        args: { type: 'array', items: { type: 'string' }, description: '命令行参数' },
      },
      required: ['script'],
    },
  },
]

/**
 * 进阶检索工具：只有对应索引开关打开时才注入模型。
 * sessionId 由服务端固定传入，模型无法访问其他对话的索引。
 */
export const INDEX_TOOLS: Array<{
  name: AgentToolName
  description: string
  input_schema: unknown
}> = [
  {
    name: 'search_conversation',
    description:
      '搜索当前对话的历史消息（包括较早、已被上下文压缩的轮次）。只返回当前会话的片段，不跨对话。',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词或短语' },
        limit: { type: 'number', description: '最多返回条数，默认 8，最大 20' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_references',
    description:
      '搜索当前对话 references/ 下的 Markdown 资料，返回文件路径和行号。找到后可用 read_file 的 offset/limit 读取原文。',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词或短语' },
        limit: { type: 'number', description: '最多返回条数，默认 8，最大 20' },
      },
      required: ['query'],
    },
  },
]

export const agentToolsFor = (indexes?: IndexOptions) => [
  ...AGENT_TOOLS,
  ...(indexes?.conversation ? [INDEX_TOOLS[0]!] : []),
  ...(indexes?.references ? [INDEX_TOOLS[1]!] : []),
]

export type ToolTarget = { kind: 'local' } | { kind: 'ssh'; config: SshConfig }

export type ToolOutcome = {
  content: string
  isError: boolean
  /** write_file / 执行产出的图片等交付物 */
  artifacts: Array<{ path: string; action: 'created' | 'updated' | 'generated'; size?: number }>
}

const readArg = (input: unknown, key: string): string =>
  typeof (input as Record<string, unknown>)?.[key] === 'string'
    ? ((input as Record<string, unknown>)[key] as string)
    : ''

const readNumber = (input: unknown, key: string, fallback: number): number => {
  const value = (input as Record<string, unknown>)?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** SSH 目标没有流式分块接口时，按行切片；仅用于兼容远程资料读取 */
const sliceTextRange = (
  text: string,
  offset: number,
  limit: number,
  maxChars: number
): {
  content: string
  startLine: number
  endLine: number
  hasMore: boolean
  nextOffset: number
  nextCharOffset: number
} => {
  const lines = text.split(/\r?\n/)
  const start = Math.max(1, Math.floor(offset))
  const collected: string[] = []
  let chars = 0
  let hasMore = false
  for (let index = start - 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (collected.length >= limit || chars + line.length + 1 > maxChars) {
      hasMore = true
      break
    }
    collected.push(line)
    chars += line.length + 1
  }
  return {
    content: collected.join('\n'),
    startLine: start,
    endLine: collected.length > 0 ? start + collected.length - 1 : start - 1,
    hasMore,
    nextOffset: start + collected.length,
    nextCharOffset: 0,
  }
}

const formatRange = (range: {
  content: string
  startLine: number
  endLine: number
  hasMore: boolean
  nextOffset: number
  nextCharOffset?: number
}): string => {
  if (!range.content) {
    return `[第 ${range.startLine} 行之后没有内容]`
  }
  const continueHint = range.nextCharOffset
    ? `；该行超长，继续请传 offset=${range.nextOffset} 且 char_offset=${range.nextCharOffset}`
    : `；继续读取请传 offset=${range.nextOffset}`
  const footer = `\n\n[已读取第 ${range.startLine}-${range.endLine} 行${
    range.hasMore ? continueHint : '（文件末尾）'
  }]`
  return `${range.content}${footer}`
}

const execResultText = (result: ExecResult): string => {
  const parts: string[] = []
  if (result.stdout) {
    parts.push(result.stdout)
  }
  if (result.stderr) {
    parts.push(`[stderr]\n${result.stderr}`)
  }
  if (result.timedOut) {
    parts.push('[执行超时，已强制终止]')
  }
  if (result.truncated) {
    parts.push('[输出过长，已截断]')
  }
  if (result.exitCode !== 0 && !result.timedOut) {
    parts.push(`[退出码 ${result.exitCode}]`)
  }
  return parts.join('\n').slice(0, 100_000) || '[无输出]'
}

/** 本地文件目标（workspace 目录） */
const localTarget = (sessionId: string) => ({
  list: (rel: string) => workspaces.listDir(sessionId, rel),
  read: (rel: string) => workspaces.readFile(sessionId, rel),
  write: (rel: string, content: string) => workspaces.writeFile(sessionId, rel, content),
  remove: (rel: string) => workspaces.deleteFile(sessionId, rel),
  runCode: async (code: string, _sessionId: string) =>
    workspaces.withExecutionWorkspace(sessionId, (dir) => runPythonAsScript(dir, code)),
  runScript: async (script: string, args: string[]) => {
    const { runPythonScript } = await import('./exec.js')
    return workspaces.withExecutionWorkspace(sessionId, (dir) =>
      runPythonScript(dir, script, args)
    )
  },
})

/** SSH 文件目标（远程主机 remotePath） */
const sshTarget = (sessionId: string, manager: SshManager, config: SshConfig) => ({
  list: async (rel: string) => (await manager.get(sessionId, config)).listDir(rel),
  read: async (rel: string) => ({ content: await (await manager.get(sessionId, config)).readFile(rel), size: 0 }),
  write: async (rel: string, content: string) => {
    await (await manager.get(sessionId, config)).writeFile(rel, content)
  },
  remove: async (rel: string) => {
    await (await manager.get(sessionId, config)).deleteFile(rel)
  },
  runCode: async (code: string) => {
    const session = await manager.get(sessionId, config)
    await session.writeFile('agent_script.py', code)
    const result = await session.exec('python3 agent_script.py 2>&1; echo "__EXIT:$?"')
    const marker = '__EXIT:'
    const index = result.stdout.lastIndexOf(marker)
    const exit = index >= 0 ? Number(result.stdout.slice(index + marker.length).trim()) : null
    const stdout = index >= 0 ? result.stdout.slice(0, index) : result.stdout
    return {
      stdout,
      stderr: result.stderr,
      exitCode: exit,
      timedOut: false,
      truncated: false,
    } as ExecResult
  },
  runScript: async (script: string, args: string[]) => {
    const session = await manager.get(sessionId, config)
    const quoted = args.map((arg) => `'${arg.replace(/'/g, `'\\''`)}'`).join(' ')
    const result = await session.exec(`python3 '${script.replace(/'/g, `'\\''`)}' ${quoted} 2>&1; echo "__EXIT:$?"`)
    const marker = '__EXIT:'
    const index = result.stdout.lastIndexOf(marker)
    const exit = index >= 0 ? Number(result.stdout.slice(index + marker.length).trim()) : null
    const stdout = index >= 0 ? result.stdout.slice(0, index) : result.stdout
    return {
      stdout,
      stderr: result.stderr,
      exitCode: exit,
      timedOut: false,
      truncated: false,
    } as ExecResult
  },
})

export class ToolExecutor {
  constructor(
    private readonly sessionId: string,
    private readonly target: ToolTarget,
    private readonly indexes?: IndexOptions
  ) {}

  async execute(name: AgentToolName, input: unknown): Promise<ToolOutcome> {
    const ops =
      this.target.kind === 'local'
        ? localTarget(this.sessionId)
        : sshTarget(this.sessionId, sshManager, this.target.config)
    try {
      switch (name) {
        case 'list_files': {
          const entries = await ops.list(readArg(input, 'path') || '')
          const content = entries
            .map((entry) => `${entry.type === 'dir' ? '[目录]' : '[文件]'} ${entry.name}${entry.size !== undefined ? ` (${entry.size}B)` : ''}`)
            .join('\n')
          return { content: content || '[空目录]', isError: false, artifacts: [] }
        }
        case 'read_file': {
          const rel = readArg(input, 'path')
          if (!rel) {
            return { content: '缺少 path 参数', isError: true, artifacts: [] }
          }
          const offset = Math.max(1, Math.floor(readNumber(input, 'offset', 1)))
          const limit = Math.max(1, Math.min(5000, Math.floor(readNumber(input, 'limit', 800))))
          const charOffset = Math.max(0, Math.floor(readNumber(input, 'char_offset', 0)))
          if (this.target.kind === 'local') {
            const range = await workspaces.readFileRange(
              this.sessionId,
              rel,
              offset,
              limit,
              120_000,
              charOffset
            )
            return { content: formatRange(range), isError: false, artifacts: [] }
          }
          const { content } = await ops.read(rel)
          return {
            content: formatRange(sliceTextRange(content, offset, limit, 120_000)),
            isError: false,
            artifacts: [],
          }
        }
        case 'write_file': {
          const rel = readArg(input, 'path')
          if (!rel) {
            return { content: '缺少 path 参数', isError: true, artifacts: [] }
          }
          const content = readArg(input, 'content')
          await ops.write(rel, content)
          return {
            content: `已写入 ${rel}`,
            isError: false,
            artifacts: [
              {
                path: rel,
                action: 'created' as const,
                size: Buffer.byteLength(content, 'utf8'),
              },
            ],
          }
        }
        case 'delete_file': {
          await ops.remove(readArg(input, 'path'))
          return { content: `已删除 ${readArg(input, 'path')}`, isError: false, artifacts: [] }
        }
        case 'run_python': {
          const code = readArg(input, 'code')
          if (!code) {
            return { content: '缺少 code 参数', isError: true, artifacts: [] }
          }
          const result = await ops.runCode(code, this.sessionId)
          const artifacts: ToolOutcome['artifacts'] = []
          if (this.target.kind === 'local') {
            // 执行后工作区新生成/更新的图片视为交付物
            for (const entry of await ops.list('')) {
              if (entry.type === 'file' && /\.(png|jpe?g|svg|pdf)$/i.test(entry.name)) {
                artifacts.push({ path: entry.name, action: 'generated' as const, size: entry.size })
              }
            }
          }
          return {
            content: execResultText(result),
            isError: result.exitCode !== 0,
            artifacts,
          }
        }
        case 'run_script': {
          const script = readArg(input, 'script')
          const argsInput = (input as Record<string, unknown>).args
          const args = Array.isArray(argsInput) ? argsInput.filter((a): a is string => typeof a === 'string') : []
          const result = await ops.runScript(script, args)
          return {
            content: execResultText(result),
            isError: result.exitCode !== 0,
            artifacts: [],
          }
        }
        case 'search_conversation': {
          if (!this.indexes?.conversation) {
            return { content: '当前对话未开启对话索引', isError: true, artifacts: [] }
          }
          const query = readArg(input, 'query')
          if (!query.trim()) {
            return { content: '缺少 query 参数', isError: true, artifacts: [] }
          }
          const hits = await searchConversation(
            this.sessionId,
            query,
            readNumber(input, 'limit', 8)
          )
          return {
            content:
              hits.length > 0
                ? hits
                    .map(
                      (hit) =>
                        `--- ${hit.role}${hit.createdAt ? ` @ ${new Date(hit.createdAt).toISOString()}` : ''} (${hit.messageId}) ---\n${hit.snippet}`
                    )
                    .join('\n\n')
                : '当前对话中没有找到匹配内容',
            isError: false,
            artifacts: [],
          }
        }
        case 'search_references': {
          if (!this.indexes?.references) {
            return { content: '当前对话未开启资料索引', isError: true, artifacts: [] }
          }
          const query = readArg(input, 'query')
          if (!query.trim()) {
            return { content: '缺少 query 参数', isError: true, artifacts: [] }
          }
          const hits = await searchReferences(
            this.sessionId,
            query,
            readNumber(input, 'limit', 8)
          )
          return {
            content:
              hits.length > 0
                ? hits
                    .map(
                      (hit) =>
                        `--- ${hit.path}:${hit.startLine}-${hit.endLine} ---\n${hit.snippet}`
                    )
                    .join('\n\n')
                : '资料中没有找到匹配内容',
            isError: false,
            artifacts: [],
          }
        }
        default:
          return { content: `未知工具：${name}`, isError: true, artifacts: [] }
      }
    } catch (error) {
      return {
        content: error instanceof Error ? error.message : String(error),
        isError: true,
        artifacts: [],
      }
    }
  }
}
