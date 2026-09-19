import { describe, expect, test, tier } from 'claude-code/testing'

import { relativeOf, translateGrep } from '../hooks/grep'

tier('user')

const TWO_FILES =
  '5 matches in 2 files.\n' +
  '¶C:/repo\\code.rs#BF46\n1:fn alpha() {}\n2:let beta = 2;\n\n' +
  '¶C:/repo/sub\\sample.txt#E213\n1:alpha line one\n2:beta line two\n3:gamma line three'

const WIN = { cwd: 'C:\\repo', searchPath: 'C:\\repo' }

describe('grep', () => {
  test('files mode: headers become paths relative to cwd in the host separator, the hint dropped', async () => {
    const block = '¶C:/repo/sub\\sample.txt#E213\n¶C:/repo\\code.rs#BF46\n\n**Next:** file headers only (no line numbers).'
    const got = translateGrep(block, { ...WIN, mode: 'files_with_matches', lineNumbers: false, context: 0 })
    expect(got).toEqual({ mode: 'files_with_matches', filenames: ['sub\\sample.txt', 'code.rs'], numFiles: 2, totalFiles: 2 })
  })

  test('content mode with -n: path:N:line per match, files run together without context', async () => {
    const got = translateGrep(TWO_FILES, { ...WIN, mode: 'content', lineNumbers: true, context: 0 })
    expect(got).toEqual({
      mode: 'content',
      content: 'code.rs:1:fn alpha() {}\ncode.rs:2:let beta = 2;\nsub\\sample.txt:1:alpha line one\nsub\\sample.txt:2:beta line two\nsub\\sample.txt:3:gamma line three',
      filenames: [],
      numFiles: 2,
      numLines: 5,
      totalLines: 5,
    })
  })

  test('content mode without -n: path:line', async () => {
    const got = translateGrep('¶/repo/a.txt#T\n7:seven', { cwd: '/repo', searchPath: '/repo', mode: 'content', lineNumbers: false, context: 0 })
    expect(got?.mode === 'content' && got.content).toBe('a.txt:seven')
  })

  test('context lines are told from matches and groups separated as ripgrep does', async () => {
    const block = '¶/repo/code.rs#B\n1:fn alpha() {}\n2:let beta = 2;\n\n¶/repo/sample.txt#E\n1:alpha line one\n2:beta line two\n3:gamma line three\n7:beta again\n8:after'
    const got = translateGrep(block, {
      cwd: '/repo',
      searchPath: '/repo',
      mode: 'content',
      lineNumbers: true,
      context: 1,
      matches: (line) => /beta/.test(line),
    })
    expect(got?.mode === 'content' && got.content).toBe(
      'code.rs-1-fn alpha() {}\ncode.rs:2:let beta = 2;\n--\nsample.txt-1-alpha line one\nsample.txt:2:beta line two\nsample.txt-3-gamma line three\n--\nsample.txt:7:beta again\nsample.txt-8-after',
    )
  })

  test('a single-file search carries no path, as ripgrep prints it', async () => {
    const got = translateGrep('1 match in 1 file.\n¶C:/repo\\sample.txt#E213\n1:alpha line one', {
      cwd: 'C:\\repo',
      searchPath: 'C:\\repo\\sample.txt',
      mode: 'content',
      lineNumbers: true,
      context: 0,
    })
    expect(got?.mode === 'content' && got.content).toBe('1:alpha line one')
  })

  test('no matches is an empty record in either mode', async () => {
    expect(translateGrep('No matches found.', { ...WIN, mode: 'files_with_matches', lineNumbers: false, context: 0 })).toEqual({
      mode: 'files_with_matches',
      filenames: [],
      numFiles: 0,
      totalFiles: 0,
    })
    expect(translateGrep('No matches found.', { ...WIN, mode: 'content', lineNumbers: true, context: 0 })).toEqual({
      mode: 'content',
      content: '',
      filenames: [],
      numFiles: 0,
      numLines: 0,
      totalLines: 0,
    })
  })

  test('a steer or hint line right after the matches ends the block, a summary line opens it', async () => {
    const block =
      '2 matches in 2 files.\n¶/repo/code.rs#B\n1:fn alpha() {}\n2:let beta = 2;\n3:\n\n¶/repo/sample.txt#E\n2:beta line two\nsteer: symbol hunt, definition(path:"/repo") …\nhint: anchors expire'
    const got = translateGrep(block, { cwd: '/repo', searchPath: '/repo', mode: 'content', lineNumbers: true, context: 0 })
    expect(got?.mode === 'content' && got.content).toBe('code.rs:1:fn alpha() {}\ncode.rs:2:let beta = 2;\ncode.rs:3:\nsample.txt:2:beta line two')
    expect(got?.numFiles).toBe(2)
  })

  test('anything else is left to core', async () => {
    expect(translateGrep('¶/repo/a#T\n## 1-3\n1:x', { ...WIN, mode: 'content', lineNumbers: true, context: 0 })).toBeUndefined()
    expect(translateGrep('unexpected prose', { ...WIN, mode: 'content', lineNumbers: true, context: 0 })).toBeUndefined()
  })

  test('relative paths: beneath cwd on either separator, else as given', async () => {
    expect(relativeOf('C:/repo/sub\\a.txt', 'C:\\repo', '\\')).toBe('sub\\a.txt')
    expect(relativeOf('/repo/sub/a.txt', '/repo', '/')).toBe('sub/a.txt')
    expect(relativeOf('/elsewhere/a.txt', '/repo', '/')).toBe('/elsewhere/a.txt')
  })
})
