import { describe, expect, test, tier } from 'claude-code/testing'

tier('user')

/**
 * What core answers a Read with, in the shape observed on Claude Code 2.1.278
 * (see README): a typed record, the text the model reads, and the message
 * index. The test only checks the mod passes it through; stage 2 must build
 * exactly this.
 */
const ANSWER = {
  result: {
    type: 'text',
    file: { filePath: '/repo/a.ts', content: 'let a = 1\n', numLines: 1, startLine: 1, totalLines: 1 },
  },
  text: '1\tlet a = 1\n',
  ref: 7,
}

describe('register', () => {
  test('a Read comes back exactly as the tool answered it', async ($, on) => {
    on('tool.call', () => ANSWER)
    on('ui.log', () => ({ value: undefined }))

    const got = await $.tool.call({ tool: 'Read', file_path: '/repo/a.ts' })

    expect(got).toEqual(ANSWER)
  })

  test('a new shape is announced once; a repeat only reaches the debug log', async ($, on) => {
    const transcript: string[] = []
    const debug: string[] = []
    on('tool.call', () => ANSWER)
    on('ui.log', ($, e) => {
      ;(e.to === 'debug' ? debug : transcript).push(e.text)
      return { value: undefined }
    })

    await $.tool.call({ tool: 'Read', file_path: '/repo/a.ts' })
    await $.tool.call({ tool: 'Read', file_path: '/repo/b.ts' })

    expect(transcript).toHaveLength(1)
    expect(transcript[0]).toContain('Read answered shape #1')
    expect(transcript[0]).toContain('envelope {ref, result, text}')
    expect(transcript[0]).toContain('"content":"string(10)"')
    expect(transcript[0]).not.toContain('let a = 1')
    expect(debug).toHaveLength(2)
    expect(debug[1]).toContain('"hits":2')
    expect(debug[1]).toContain('"firstFile":"/repo/a.ts"')
  })

  test('a denied Read is returned untouched and recorded as denied', async ($, on) => {
    const transcript: string[] = []
    on('tool.call', () => ({ deny: 'use skyline read' }))
    on('ui.log', ($, e) => {
      if (e.to !== 'debug') transcript.push(e.text)
      return { value: undefined }
    })

    const got = await $.tool.call({ tool: 'Read', file_path: '/repo/a.ts' })

    expect(got).toEqual({ deny: 'use skyline read' })
    expect(transcript[0]).toContain('Read denied shape #1')
  })

  test('another tool is not measured', async ($, on) => {
    const logged: string[] = []
    on('tool.call', () => ({ result: { stdout: 'ok', stderr: '' }, text: 'ok', ref: 1 }))
    on('ui.log', ($, e) => {
      logged.push(e.text)
      return { value: undefined }
    })

    await $.tool.call({ tool: 'Bash', command: 'true' })

    expect(logged).toEqual([])
  })
})
