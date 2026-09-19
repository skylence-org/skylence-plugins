import { describe, expect, mock, test, tier } from 'claude-code/testing'
import type { HttpResponse, On } from 'claude-code'

import { absoluteOf } from '../hooks/register'

tier('user')

/**
 * What core answers a Read with, in the shape observed on Claude Code 2.1.278
 * (see README). Beneath the mod it stands for core's own Read.
 */
const CORE_ANSWER = {
  result: {
    type: 'text',
    file: { filePath: '/repo/a.ts', content: 'let a = 1\n', numLines: 1, startLine: 1, totalLines: 1 },
  },
  text: '1\tlet a = 1\n',
  ref: 7,
}

const WHOLE_BLOCK = '¶/repo/sample.txt#E213\n1:alpha line one\n2:beta line two\n3:gamma line three\ntotal: 3 lines'

function sse(message: unknown): string {
  return `data: \nid: 0/0\nretry: 3000\n\ndata: ${JSON.stringify(message)}\nid: 1/0\n\n`
}

type Sent = { method: string; params?: { name?: string; arguments?: Record<string, unknown> }; id?: number }

type Daemon = {
  /** Every request the mod posted, in order. */
  sent: Sent[]
  /** The session id header each request carried. */
  sessions: (string | undefined)[]
  /** What the next tools/call answers with (default: the whole block). */
  reply: (call: Sent) => { text: string; status?: number }
}

/**
 * The world beneath the mod: a session in /repo (a code tree), a home with no
 * ~/.claude reads, a clock, core's Read, and a skyline daemon over http.fetch
 * that speaks MCP streamable HTTP as the real one does.
 */
function worldOf(on: On, options: { down?: boolean; codeTree?: boolean; cwd?: string; decision?: 'allow' | 'ask' | 'deny' } = {}) {
  const cwd = options.cwd ?? '/repo'
  const checked: Record<string, unknown>[] = []
  on('tool.check', ($, e) => {
    checked.push(e.input as Record<string, unknown>)
    return { decision: options.decision ?? 'allow', ...(options.decision === 'deny' ? { reason: 'Read(./sample.txt) is denied' } : {}) }
  })
  const daemon: Daemon = {
    sent: [],
    sessions: [],
    reply: () => ({ text: sse({ jsonrpc: '2.0', id: 0, result: { content: [{ type: 'text', text: WHOLE_BLOCK }], isError: false } }) }),
  }
  const coreReads: string[] = []
  const transcript: string[] = []
  const debug: string[] = []

  on('session.cwd', () => ({ value: cwd }))
  mock.env(on, { HOME: '/home/j' })
  const clock = mock.clock(on)
  const asked: string[] = []
  // the engine hands a hook the path as the host spells it (C:\repo\.git here on Windows)
  const posix = (p: string) => p.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
  on('fs.exists', ($, e) => {
    asked.push(posix(e.path))
    return { value: (options.codeTree ?? true) && posix(e.path) === '/repo/.git' }
  })
  on('ui.log', ($, e) => {
    ;(e.to === 'debug' ? debug : transcript).push(e.text)
    return { value: undefined }
  })
  on('tool.call', ($, e) => {
    if (e.tool === 'Read') coreReads.push(e.file_path)
    if (e.tool === 'Grep') coreReads.push(`grep:${e.pattern}`)
    return CORE_ANSWER
  })
  const answer = (status: number, headers: Record<string, string>, text: string): { value: HttpResponse } => ({
    value: { status, ok: status < 400, headers, text },
  })
  on('http.fetch', ($, e) => {
    const body = JSON.parse(e.init?.body ?? '{}') as Sent
    daemon.sent.push(body)
    if (options.down) throw new Error('ECONNREFUSED')
    daemon.sessions.push(e.init?.headers?.['Mcp-Session-Id'])
    if (body.method === 'initialize') {
      const n = daemon.sent.filter((s) => s.method === 'initialize').length
      return answer(
        200,
        { 'content-type': 'text/event-stream', 'mcp-session-id': `sid-${n}` },
        sse({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'skyline' } } }),
      )
    }
    if (body.method === 'notifications/initialized') return answer(202, {}, '')
    const r = daemon.reply(body)
    // the fixture's reply carries id 0; stamp the request's id on it
    return answer(r.status ?? 200, { 'content-type': 'text/event-stream' }, r.text.replace('"id":0,', `"id":${body.id},`))
  })

  return { daemon, coreReads, transcript, debug, clock, asked, checked }
}

describe('register', () => {
  test('a Read inside a code tree is answered from skyline in the shape core produces', async ($, on) => {
    const world = worldOf(on)

    const got = await $.tool.call({ tool: 'Read', file_path: 'sample.txt' })

    expect(world.asked).toEqual(['/repo/.git'])
    expect(world.checked).toEqual([{ file_path: '/repo/sample.txt' }])
    expect(got).toEqual({
      result: {
        type: 'text',
        file: {
          filePath: '/repo/sample.txt',
          content: 'alpha line one\nbeta line two\ngamma line three',
          numLines: 3,
          startLine: 1,
          totalLines: 3,
        },
      },
      context: ['skyline anchor for edit (paste verbatim): ¶/repo/sample.txt#E213'],
    })
    expect(world.coreReads).toEqual([])
    expect(world.daemon.sent.map((s) => s.method)).toEqual(['initialize', 'notifications/initialized', 'tools/call'])
    expect(world.daemon.sessions).toEqual([undefined, 'sid-1', 'sid-1'])
    const call = world.daemon.sent[2]?.params
    expect(call?.name).toBe('read')
    expect(call?.arguments).toEqual({ path: '/repo/sample.txt', full: true, max_match_chars: 0 })
    expect(world.transcript[0]).toContain('Read answered by skyline shape #1')
  })

  test('offset and limit go to skyline; one session serves every Read', async ($, on) => {
    const world = worldOf(on)
    world.daemon.reply = () => ({
      text: sse({ jsonrpc: '2.0', id: 0, result: { content: [{ type: 'text', text: '¶/repo/sample.txt#E213\n2:beta line two' }], isError: false } }),
    })

    await $.tool.call({ tool: 'Read', file_path: '/repo/sample.txt' })
    const got = await $.tool.call({ tool: 'Read', file_path: '/repo/sample.txt', offset: 2, limit: 1 })

    expect((got as { result: { file: { startLine: number; numLines: number; totalLines: number } } }).result.file).toMatchObject({
      startLine: 2,
      numLines: 1,
      totalLines: 2,
    })
    expect(world.daemon.sent.filter((s) => s.method === 'initialize')).toHaveLength(1)
    expect(world.daemon.sent[3]?.params?.arguments).toMatchObject({ offset: 2, limit: 1 })
  })

  test('with the daemon down core reads, and the mod does not knock again for a while', async ($, on) => {
    const world = worldOf(on, { down: true })

    const first = await $.tool.call({ tool: 'Read', file_path: '/repo/a.ts' })
    const second = await $.tool.call({ tool: 'Read', file_path: '/repo/b.ts' })
    await world.clock.advance(6000)
    const third = await $.tool.call({ tool: 'Read', file_path: '/repo/c.ts' })

    expect([first, second, third]).toEqual([CORE_ANSWER, CORE_ANSWER, CORE_ANSWER])
    expect(world.coreReads).toEqual(['/repo/a.ts', '/repo/b.ts', '/repo/c.ts'])
    // one knock, then marked down for 5 s, then one knock again
    expect(world.daemon.sent.map((s) => s.method)).toEqual(['initialize', 'initialize'])
    const down = world.debug.filter((l) => l.includes('daemon down'))
    expect(down).toHaveLength(3)
    expect(down[1]).toContain('marked down')
    expect(down[2]).not.toContain('marked down')
    expect(world.transcript[0]).toContain('Read answered by core shape #1')
  })

  test('a restarted daemon (stale session) costs one re-initialize, not the Read', async ($, on) => {
    const world = worldOf(on)
    let calls = 0
    world.daemon.reply = () => {
      calls += 1
      return calls === 1
        ? { text: 'Unexpected message, expect initialize request' }
        : { text: sse({ jsonrpc: '2.0', id: 0, result: { content: [{ type: 'text', text: WHOLE_BLOCK }], isError: false } }) }
    }

    const got = await $.tool.call({ tool: 'Read', file_path: '/repo/sample.txt' })

    expect((got as { result: { file: { numLines: number } } }).result.file.numLines).toBe(3)
    expect(world.daemon.sent.map((s) => s.method)).toEqual([
      'initialize', 'notifications/initialized', 'tools/call',
      'initialize', 'notifications/initialized', 'tools/call',
    ])
    expect(world.daemon.sessions.slice(3)).toEqual([undefined, 'sid-2', 'sid-2'])
    expect(world.coreReads).toEqual([])
  })

  test('a skyline error (file missing) is left to core, whose error the model knows', async ($, on) => {
    const world = worldOf(on)
    world.daemon.reply = () => ({
      text: sse({ jsonrpc: '2.0', id: 0, result: { content: [{ type: 'text', text: 'file not found: /repo/nope.txt' }], isError: true } }),
    })

    const got = await $.tool.call({ tool: 'Read', file_path: '/repo/nope.txt' })

    expect(got).toEqual(CORE_ANSWER)
    expect(world.coreReads).toEqual(['/repo/nope.txt'])
  })

  test('outside any code tree, under ~/.claude, a pdf, or a pages request: core reads, skyline is not asked', async ($, on) => {
    const world = worldOf(on, { codeTree: false })

    await $.tool.call({ tool: 'Read', file_path: '/elsewhere/notes.md' })
    await $.tool.call({ tool: 'Read', file_path: '/home/j/.claude/CLAUDE.md' })
    await $.tool.call({ tool: 'Read', file_path: '/repo/paper.pdf' })
    await $.tool.call({ tool: 'Read', file_path: '/repo/paper.txt', pages: '1-2' })

    expect(world.coreReads).toHaveLength(4)
    expect(world.daemon.sent).toEqual([])
  })

  test('a Read the permission path would refuse or ask about is left to core, unread by skyline', async ($, on) => {
    const denied = worldOf(on, { decision: 'deny' })

    const got = await $.tool.call({ tool: 'Read', file_path: '/repo/sample.txt', offset: 2, limit: 1 })

    expect(got).toEqual(CORE_ANSWER)
    expect(denied.coreReads).toEqual(['/repo/sample.txt'])
    expect(denied.daemon.sent).toEqual([])
    expect(denied.checked).toEqual([{ file_path: '/repo/sample.txt', offset: 2, limit: 1 }])
    expect(denied.debug[0]).toContain('permission deny (Read(./sample.txt) is denied)')
  })

  test('a Grep in files mode is answered from skyline as core would record it', async ($, on) => {
    const world = worldOf(on)
    world.daemon.reply = () => ({
      text: sse({
        jsonrpc: '2.0',
        id: 0,
        result: { content: [{ type: 'text', text: '¶/repo/sub/b.txt#T1\n¶/repo/a.rs#T2\n\n**Next:** file headers only.' }], isError: false },
      }),
    })

    const got = await $.tool.call({ tool: 'Grep', pattern: 'alpha', glob: '*.{txt,rs}' })

    expect(got).toEqual({ result: { mode: 'files_with_matches', filenames: ['sub/b.txt', 'a.rs'], numFiles: 2, totalFiles: 2 } })
    expect(world.coreReads).toEqual([])
    const call = world.daemon.sent[2]?.params
    expect(call?.name).toBe('grep')
    expect(call?.arguments).toEqual({
      pattern: 'alpha',
      path: '/repo',
      cwd: '/repo',
      limit: 250,
      strict: true,
      max_match_chars: 0,
      files_with_matches: true,
      glob: '*.{txt,rs}',
    })
    expect(world.checked).toEqual([{ pattern: 'alpha', glob: '*.{txt,rs}' }])
    expect(world.transcript[0]).toContain('Grep answered by skyline shape #1')
  })

  test('a Grep in content mode with -n, -i and -C renders as ripgrep would', async ($, on) => {
    const world = worldOf(on)
    world.daemon.reply = () => ({
      text: sse({
        jsonrpc: '2.0',
        id: 0,
        result: {
          content: [{ type: 'text', text: '2 matches in 1 file.\n¶/repo/sample.txt#E\n1:alpha line one\n2:Beta line two\n3:gamma line three' }],
          isError: false,
        },
      }),
    })

    const got = await $.tool.call({ tool: 'Grep', pattern: 'beta', output_mode: 'content', '-n': true, '-i': true, '-C': 1, path: 'sub/..' })

    expect(got).toEqual({
      result: {
        mode: 'content',
        content: 'sample.txt-1-alpha line one\nsample.txt:2:Beta line two\nsample.txt-3-gamma line three',
        filenames: [],
        numFiles: 1,
        numLines: 3,
        totalLines: 3,
      },
    })
    expect(world.daemon.sent[2]?.params?.arguments).toMatchObject({ path: '/repo/sub/..', ignore_case: true, context: 1 })
  })

  test('a Grep skyline cannot mirror (count mode, a file type) is left to core, unasked', async ($, on) => {
    const world = worldOf(on)

    await $.tool.call({ tool: 'Grep', pattern: 'x', output_mode: 'count' })
    await $.tool.call({ tool: 'Grep', pattern: 'x', type: 'rust' })

    expect(world.daemon.sent).toEqual([])
    expect(world.debug.filter((l) => l.includes('left to core'))).toHaveLength(2)
  })

  test('another tool is not touched', async ($, on) => {
    const world = worldOf(on)

    const got = await $.tool.call({ tool: 'Bash', command: 'true' })

    expect(got).toEqual(CORE_ANSWER)
    expect(world.daemon.sent).toEqual([])
    expect(world.transcript).toEqual([])
  })

  test('paths resolve against the session directory on both separators', async () => {
    expect(absoluteOf('a.ts', '/repo')).toBe('/repo/a.ts')
    expect(absoluteOf('/abs/a.ts', '/repo')).toBe('/abs/a.ts')
    expect(absoluteOf('a.ts', 'C:\\repo')).toBe('C:\\repo\\a.ts')
    expect(absoluteOf('C:\\x\\a.ts', 'C:\\repo')).toBe('C:\\x\\a.ts')
  })
})
