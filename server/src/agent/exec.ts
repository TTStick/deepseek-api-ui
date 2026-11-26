import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { env } from '../env.js'

/**
 * Python 隔离执行：在 server 容器内以工作区为 cwd 运行，
 * 超时强制终止，输出截断，MPLBACKEND=Agg 让 matplotlib 落盘出图。
 * 常用库（numpy/matplotlib/pandas/requests）随镜像安装，见 server/Dockerfile。
 */

const EXEC_TIMEOUT_MS = Number(process.env.AGENT_EXEC_TIMEOUT_MS ?? 60_000)
const OUTPUT_LIMIT = 200 * 1024
const CODE_LIMIT = 500 * 1024

export type ExecResult = {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  truncated: boolean
}

const run = (
  args: string[],
  cwd: string,
  stdin?: string
): Promise<ExecResult> =>
  new Promise((resolve) => {
    const child = execFile(
      env.pythonPath,
      args,
      { cwd, env: pythonExecEnv(), timeout: EXEC_TIMEOUT_MS, maxBuffer: OUTPUT_LIMIT, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        resolve({
          stdout: String(stdout),
          stderr: String(stderr),
          exitCode: error ? ((error as { code?: number }).code ?? 1) : 0,
          timedOut: Boolean(error && (error as { killed?: boolean }).killed),
          truncated: String(stdout).length + String(stderr).length >= OUTPUT_LIMIT,
        })
      }
    )
    if (stdin !== undefined) {
      child.stdin?.write(stdin)
      child.stdin?.end()
    }
  })

/** 直接执行一段 python 代码（工作区为 cwd，工作区内文件可直接读写） */
export const runPythonCode = async (
  workspaceDir: string,
  code: string
): Promise<ExecResult> => {
  if (Buffer.byteLength(code, 'utf8') > CODE_LIMIT) {
    return {
      stdout: '',
      stderr: '代码超过 500KB 上限',
      exitCode: 1,
      timedOut: false,
      truncated: false,
    }
  }
  return run(['-c', code], workspaceDir)
}

/** 执行工作区内的 .py 文件 */
export const runPythonScript = async (
  workspaceDir: string,
  relativePath: string,
  args: string[] = []
): Promise<ExecResult> => {
  const script = path.resolve(workspaceDir, relativePath)
  if (script !== workspaceDir && !script.startsWith(workspaceDir + path.sep)) {
    return {
      stdout: '',
      stderr: '脚本路径越出工作区',
      exitCode: 1,
      timedOut: false,
      truncated: false,
    }
  }
  return run([script, ...args], workspaceDir)
}

/** 从 stdin 执行 python（-c 的备选，避免大代码量的命令行长度限制） */
export const runPythonStdin = async (
  workspaceDir: string,
  code: string
): Promise<ExecResult> => run(['-'], workspaceDir, code)

/** 把代码写入工作区的临时脚本并执行（便于 matplotlib 出图与相对路径 import） */
export const runPythonAsScript = async (
  workspaceDir: string,
  code: string,
  scriptName = 'agent_script.py'
): Promise<ExecResult> => {
  await writeFile(path.join(workspaceDir, scriptName), code, 'utf8')
  return run([scriptName], workspaceDir)
}

/** 执行时注入的环境：只保留运行 Python 所需变量，不向 Agent 代码暴露服务端密钥 */
export const pythonExecEnv = (): NodeJS.ProcessEnv => {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR']
  const env: NodeJS.ProcessEnv = {}
  for (const key of keep) {
    if (process.env[key]) {
      env[key] = process.env[key]
    }
  }
  return {
    ...env,
    MPLBACKEND: 'Agg',
    PYTHONUNBUFFERED: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONNOUSERSITE: '1',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
  }
}
