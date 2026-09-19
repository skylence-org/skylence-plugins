import { describe, expect, test, tier } from 'claude-code/testing'

import { translateRead } from '../hooks/translate'

tier('user')

const WHOLE = '¶C:/repo/sample.txt#E213\n1:alpha line one\n2:beta line two\n3:gamma line three\ntotal: 3 lines'

describe('translate', () => {
  test('a whole read: five fields, the anchor apart, no line numbers in content', async () => {
    const got = translateRead(WHOLE, 'C:\\repo\\sample.txt')
    expect(got?.anchor).toBe('¶C:/repo/sample.txt#E213')
    expect(got?.file).toEqual({
      filePath: 'C:\\repo\\sample.txt',
      content: 'alpha line one\nbeta line two\ngamma line three',
      numLines: 3,
      startLine: 1,
      totalLines: 3,
    })
  })

  test('a partial read starts where skyline started and bounds the total below', async () => {
    const got = translateRead('¶/repo/a.ts#A1\n2:beta line two', '/repo/a.ts', 2)
    expect(got?.file).toEqual({ filePath: '/repo/a.ts', content: 'beta line two', numLines: 1, startLine: 2, totalLines: 2 })
  })

  test('empty lines, colons and tabs in content survive', async () => {
    const got = translateRead('¶/r/x#T\n1:\n2:a: b\n3:\tc\ntotal: 3 lines', '/r/x')
    expect(got?.file.content).toBe('\na: b\n\tc')
    expect(got?.file.numLines).toBe(3)
  })

  test('an empty file is zero lines', async () => {
    const got = translateRead('¶/r/empty#T\ntotal: 0 lines', '/r/empty')
    expect(got?.file).toEqual({ filePath: '/r/empty', content: '', numLines: 0, startLine: 1, totalLines: 0 })
  })

  test('anything that is not an anchored numbered block is left to core', async () => {
    expect(translateRead('unchanged since ¶/r/x#T', '/r/x')).toBeUndefined()
    expect(translateRead('¶/r/x#T\n## 1-3\n1:a', '/r/x')).toBeUndefined()
    expect(translateRead('file not found: /r/x', '/r/x')).toBeUndefined()
  })
})
