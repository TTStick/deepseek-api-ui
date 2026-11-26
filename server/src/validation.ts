/** 通用输入校验工具 */

/** 嵌套过深会让 JSON.stringify / 上游解析器栈溢出，提前按客户端错误拒绝 */
export const hasExcessiveDepth = (value: unknown, limit = 200): boolean => {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  while (stack.length > 0) {
    const { value: current, depth } = stack.pop()!
    if (depth > limit) {
      return true
    }
    if (Array.isArray(current)) {
      for (const item of current) {
        stack.push({ value: item, depth: depth + 1 })
      }
    } else if (current !== null && typeof current === 'object') {
      for (const item of Object.values(current as Record<string, unknown>)) {
        stack.push({ value: item, depth: depth + 1 })
      }
    }
  }
  return false
}
