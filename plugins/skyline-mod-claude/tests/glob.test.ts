import { describe, expect, test, tier } from 'claude-code/testing'

import { globFilesOf, translateGlob } from '../hooks/glob'

tier('user')

describe('glob', () => {
  test('headers become cwd-relative paths in the host separator, the extended-length prefix dropped, oldest first', async () => {
    const block = '¶\\\\?\\C:\\repo\\sub\\new.txt#A1\n¶\\\\?\\C:\\repo\\old.txt#0000\n\nhint: anchors expire'
    const got = translateGlob(block, { cwd: 'C:\\repo', newestFirst: true, durationMs: 12 })
    expect(got).toEqual({
      filenames: ['old.txt', 'sub\\new.txt'],
      numFiles: 2,
      totalMatches: 2,
      truncated: false,
      countIsComplete: true,
      durationMs: 12,
    })
  })

  test('the elision footer sets the total and marks truncation', async () => {
    const block = '¶/repo/a.txt#T\n¶/repo/b.txt#T\n20 match(es), 2 shown, 18 elided; pass skip:2 to continue'
    const got = translateGlob(block, { cwd: '/repo', newestFirst: false, durationMs: 3 })
    expect(got).toMatchObject({ filenames: ['a.txt', 'b.txt'], numFiles: 2, totalMatches: 20, truncated: true })
  })

  test('no matches is an empty record; directory rows are dropped', async () => {
    expect(translateGlob('no matches\n0 match(es), 0 shown', { cwd: '/repo', newestFirst: true, durationMs: 1 })).toMatchObject({
      filenames: [],
      numFiles: 0,
      totalMatches: 0,
      truncated: false,
    })
    expect(translateGlob('¶/repo/sub/#T\n¶/repo/a.txt#T', { cwd: '/repo', newestFirst: false, durationMs: 1 })?.filenames).toEqual(['a.txt'])
  })

  test('denied files are dropped and the total follows; globFilesOf strips the prefix', async () => {
    const block = '¶\\\\?\\C:\\repo\\secret.txt#S\n¶\\\\?\\C:\\repo\\a.txt#A\n5 match(es), 2 shown, 3 elided'
    expect(globFilesOf(block)).toEqual(['C:\\repo\\secret.txt', 'C:\\repo\\a.txt'])
    const got = translateGlob(block, { cwd: 'C:\\repo', newestFirst: true, durationMs: 1, denied: new Set(['C:\\repo\\secret.txt']) })
    expect(got).toMatchObject({ filenames: ['a.txt'], numFiles: 1, totalMatches: 4, truncated: true })
  })

  test('anything else is left to core', async () => {
    expect(translateGlob('some prose', { cwd: '/repo', newestFirst: true, durationMs: 1 })).toBeUndefined()
  })
})
