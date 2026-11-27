import { describe, expect, it } from 'vitest'
import { repairReferenceName } from '../src/agent/references.js'

describe('repairReferenceName（Mac zip 文件名乱码）', () => {
  it('把 Latin-1 形式的 UTF-8 文件名还原成中文', () => {
    expect(repairReferenceName('èµæ')).toBe('资料')
    expect(repairReferenceName('æ§å«è®¤åæ¢ç´¢')).toBe('性别认同探索')
  })

  it('正确的中文名保持不变', () => {
    expect(repairReferenceName('资料')).toBe('资料')
    expect(repairReferenceName('notes.md')).toBe('notes.md')
  })

  it('真正的 Latin-1 文件名不被误改', () => {
    expect(repairReferenceName('café.md')).toBe('café.md')
  })
})
