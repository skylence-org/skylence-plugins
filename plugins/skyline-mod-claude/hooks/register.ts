import type { EngineInterface, On, PluginOptions } from 'claude-code'

import { translateGrep, type GrepMode, type GrepRecord } from './grep'
import { DaemonDown, SkylineClient, type Transport } from './mcp'
import { shapeOf, signatureOf, type Shape } from './shape'
import { translateRead, type ReadFile } from './translate'

export const DEFAULT_DAEMON_URL = 'http://127.0.0.1:7333/mcp'

/** Files core renders specially (pages, images, notebooks): never skyline's. */
const NOT_TEXT = /\.(pdf|png|jpe?g|gif|webp|bmp|ico|ipynb)$/i

/** The markers that make a directory a code tree, as the classic hook has them. */
const CODE_TREE_MARKERS = ['.git', '.skyrift-workspace']

/** Core's default cap on Grep output lines or files. */
const GREP_DEFAULT_LIMIT = 250

/**
 * What a call came back as: answered by the tool, refused by a hook or the
 * permission path, or run and failed.
 */
export type ReadKind = 'answered' | 'denied' | 'errored'

/**
 * One distinct shape of result, counted across the session.
 */
export type ReadShape = {
  kind: ReadKind
  /** Who produced it: this mod from skyline, or core's own tool. */
  source: 'skyline' | 'core'
  /** The result envelope's own keys, as resolved. */
  envelopeKeys: string[]
  /** The typed record under `result`, keys and types only. */
  result: Shape
  /** Length of the text the model reads, when there is one. Never the text. */
  textLength?: number
  /** How many `context` reminders rode along. */
  contextCount: number
  /** Whether `ref` (core's message index) was present. */
  hasRef: boolean
  /** The deny text, when the kind is `denied`. */
  deny?: string
  /** How many calls produced this shape. */
  hits: number
  /** What the first such call asked for. */
  firstFile: string
}

/**
 * The engine calls an answer path makes, as closures over `$`: a user-tier
 * module may spell `$` only as `$.noun.event(...)` at a call site, or pass it
 * to a function declared at the top of the file.
 */
type Io = Transport & {
  cwd: () => Promise<string>
  /** USERPROFILE, else HOME (the loader wants `$.env.get` given literal names). */
  home: () => Promise<string | undefined>
  exists: (path: string) => Promise<boolean>
  /** The engine's permission decision for this call, as `$.tool.check` gives it. */
  check: (input: Record<string, unknown>) => Promise<{ decision: string; reason?: string }>
  debug: (text: string) => void
}

type Recorder = {
  notice: (text: string) => void
  debug: (text: string) => void
  write: (path: string, text: string) => Promise<void>
}

type ReadCall = { file_path: string; offset?: number; limit?: number; pages?: string }

type GrepCall = {
  pattern: string
  path?: string
  glob?: string
  type?: string
  output_mode?: 'content' | 'files_with_matches' | 'count'
  '-A'?: number
  '-B'?: number
  '-C'?: number
  '-n'?: boolean
  '-i'?: boolean
  head_limit?: number
  offset?: number
  multiline?: boolean
}

type ReadAnswer = { result: { type: 'text'; file: ReadFile }; context?: readonly string[] }

type GrepAnswer = { result: GrepRecord }

/**
 * Registers the mod's hooks, on Read and on Grep.
 *
 * A Read of a text file inside a code tree, and a Grep in files or content
 * mode under one, are answered from the skyline daemon in the record core
 * would have produced; core's tool never runs and the classic enforce hook
 * beneath never sees a call to deny. Anything else (the daemon down or
 * answering an error, a path outside any code tree or under ~/.claude, a
 * pdf, image, notebook or `pages` request, a Grep in count mode or with a
 * file type, multiline or an unparsable pattern, a permission decision other
 * than allow, a block that does not parse) goes on to core untouched.
 *
 * Whatever the answer, its shape is recorded (stage 1).
 *
 * @param on the engine's registrar
 * @param options `daemonUrl` (default http://127.0.0.1:7333/mcp);
 *   `answerFromSkyline` (default true; false makes the mod observe only);
 *   `anchorContext` (default true; false drops the anchor line after a Read);
 *   `shapeFile` (default none)
 */
export function register(on: On, options: PluginOptions): void {
  const shapeFile = typeof options.shapeFile === 'string' ? options.shapeFile.trim() : ''
  const daemonUrl =
    typeof options.daemonUrl === 'string' && options.daemonUrl.trim() ? options.daemonUrl.trim() : DEFAULT_DAEMON_URL
  const answering = flag(options.answerFromSkyline, true)
  const anchorContext = flag(options.anchorContext, true)
  const client = new SkylineClient(daemonUrl)
  const codeTrees = new Map<string, boolean>()
  const seen = new Map<string, ReadShape>()

  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    if (e.tool !== 'Read') return next(e)

    const io = ioOf($, 'Read')
    const answered = answering ? await answerReadFromSkyline(io, e, client, codeTrees, anchorContext) : undefined
    const result = answered ?? (await next(e))

    await record(recorderOf($), 'Read', e.file_path, result, answered ? 'skyline' : 'core')
    return result
  })

  on('tool.call', { tool: 'Grep' }, async ($, e, next) => {
    if (e.tool !== 'Grep') return next(e)

    const io = ioOf($, 'Grep')
    const answered = answering ? await answerGrepFromSkyline(io, e, client, codeTrees) : undefined
    const result = answered ?? (await next(e))

    await record(recorderOf($), 'Grep', `${e.output_mode ?? 'files_with_matches'}:${e.pattern}`, result, answered ? 'skyline' : 'core')
    return result
  })

  /**
   * Records one result's shape: a transcript notice the first time a shape is
   * seen, a debug line every time, the shape file when one is named. Never
   * costs the model its result.
   */
  async function record(io: Recorder, tool: string, subject: string, result: object, source: 'skyline' | 'core'): Promise<void> {
    try {
      const shape = recordOf(result, subject, source)
      const signature = signatureOf({ tool, kind: shape.kind, source, keys: shape.envelopeKeys, result: shape.result })
      const known = seen.get(signature)
      if (known) {
        known.hits += 1
      } else {
        seen.set(signature, shape)
        io.notice(
          `[skyline-mod] ${tool} ${shape.kind} by ${source} shape #${seen.size}: ` +
            `envelope {${shape.envelopeKeys.join(', ')}} result ${JSON.stringify(shape.result)}` +
            (shape.textLength === undefined ? '' : ` text ${shape.textLength} chars`),
        )
      }
      io.debug(`[skyline-mod] ${JSON.stringify({ tool, subject, ...(known ?? shape) })}`)
      if (shapeFile) await io.write(shapeFile, JSON.stringify([...seen.values()], null, 2) + '\n')
    } catch (err) {
      io.debug(`[skyline-mod] could not record a ${tool} shape: ${messageOf(err)}`)
    }
  }
}

/**
 * The engine calls an answer path makes, over `$`. A top-level function
 * declaration: the loader lets a hook pass `$` to one of those and to nothing
 * else (not to a nested function, a method, or a variable).
 */
function ioOf($: EngineInterface, tool: 'Read' | 'Grep'): Io {
  return {
    fetch: (url, init) => $.http.fetch(url, init),
    now: () => $.clock.now(),
    cwd: () => $.session.cwd(),
    home: async () => (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')),
    exists: (path) => $.fs.exists(path),
    check: (input) => $.tool.check({ tool, input }),
    debug: (text) => $.ui.log(text, { to: 'debug' }),
  }
}

function recorderOf($: EngineInterface): Recorder {
  return {
    notice: (text) => $.ui.log(text),
    debug: (text) => $.ui.log(text, { to: 'debug' }),
    write: (path, text) => $.fs.write(path, text),
  }
}

/**
 * Answers a Read from skyline, or returns undefined to let core's Read run.
 * Never throws: whatever goes wrong is a debug line and a pass-through.
 */
async function answerReadFromSkyline(
  io: Io,
  e: ReadCall,
  client: SkylineClient,
  codeTrees: Map<string, boolean>,
  anchorContext: boolean,
): Promise<ReadAnswer | undefined> {
  try {
    if (e.pages !== undefined || NOT_TEXT.test(e.file_path)) return leftToCore(io, 'Read', e.file_path, 'not a text read')

    const abs = absoluteOf(e.file_path, await io.cwd())
    if (await isUnderClaudeConfig(io, abs)) return leftToCore(io, 'Read', abs, 'under ~/.claude')
    if (!(await isInsideCodeTree(io, abs, codeTrees))) return leftToCore(io, 'Read', abs, 'not inside a code tree')

    // Answering without next() skips core's permission path, so ask it here:
    // a deny rule, or anything that would need a dialog, is core's to settle.
    const input: Record<string, unknown> = { file_path: abs }
    if (e.offset !== undefined) input.offset = e.offset
    if (e.limit !== undefined) input.limit = e.limit
    const verdict = await io.check(input)
    if (verdict.decision !== 'allow') return leftToCore(io, 'Read', abs, `permission ${verdictText(verdict)}`)

    const args: Record<string, unknown> = { path: abs, full: true, max_match_chars: 0 }
    if (e.offset !== undefined) args.offset = e.offset
    if (e.limit !== undefined) args.limit = e.limit
    const reply = await client.call(io, 'read', args)
    if (reply.isError) return leftToCore(io, 'Read', abs, 'skyline reported an error')

    const block = firstText(reply.content)
    const translated = block === undefined ? undefined : translateRead(block, abs, e.offset)
    if (!translated) return leftToCore(io, 'Read', abs, `skyline block not translatable: ${headOf(block)}`)

    return {
      result: { type: 'text', file: translated.file },
      ...(anchorContext ? { context: [`skyline anchor for edit (paste verbatim): ${translated.anchor}`] } : {}),
    }
  } catch (err) {
    return leftToCore(io, 'Read', e.file_path, err instanceof DaemonDown ? `daemon down: ${err.message}` : messageOf(err))
  }
}

/**
 * Answers a Grep from skyline, or returns undefined to let core's Grep run.
 * Files mode and content mode only: skyline's count has no per-file figures,
 * and its search has no ripgrep file-type table.
 */
async function answerGrepFromSkyline(
  io: Io,
  e: GrepCall,
  client: SkylineClient,
  codeTrees: Map<string, boolean>,
): Promise<GrepAnswer | undefined> {
  const subject = `${e.output_mode ?? 'files_with_matches'}:${e.pattern}`
  try {
    const mode: GrepMode | 'count' = e.output_mode ?? 'files_with_matches'
    if (mode === 'count') return leftToCore(io, 'Grep', subject, 'count mode')
    if (e.type !== undefined) return leftToCore(io, 'Grep', subject, 'file type filter')
    if (e.multiline) return leftToCore(io, 'Grep', subject, 'multiline')
    if (!e.pattern) return leftToCore(io, 'Grep', subject, 'empty pattern')

    const context = Math.max(e['-C'] ?? 0, e['-A'] ?? 0, e['-B'] ?? 0)
    let matches: ((line: string) => boolean) | undefined
    if (context > 0) {
      // ripgrep and JavaScript agree on the syntax that reaches a tool call in
      // practice; a pattern JavaScript cannot compile is core's to run.
      try {
        const re = new RegExp(e.pattern, e['-i'] ? 'i' : '')
        matches = (line) => re.test(line)
      } catch {
        return leftToCore(io, 'Grep', subject, 'pattern not a JavaScript regex, context lines could not be told apart')
      }
    }

    const cwd = await io.cwd()
    const searchPath = e.path === undefined ? cwd : absoluteOf(e.path, cwd)
    if (await isUnderClaudeConfig(io, searchPath)) return leftToCore(io, 'Grep', subject, 'under ~/.claude')
    if (!(await isInsideCodeTree(io, searchPath + (searchPath.endsWith('/') || searchPath.endsWith('\\') ? '' : '/.'), codeTrees))) {
      return leftToCore(io, 'Grep', subject, 'not inside a code tree')
    }

    // The call's own fields only: the envelope also carries consent and the
    // agent loop, which are not the question.
    const input: Record<string, unknown> = { pattern: e.pattern }
    for (const key of ['path', 'glob', 'output_mode', '-A', '-B', '-C', '-n', '-i', 'head_limit', 'offset'] as const) {
      if (e[key] !== undefined) input[key] = e[key]
    }
    const verdict = await io.check(input)
    if (verdict.decision !== 'allow') return leftToCore(io, 'Grep', subject, `permission ${verdictText(verdict)}`)

    const limit = e.head_limit === undefined ? GREP_DEFAULT_LIMIT : e.head_limit === 0 ? 1_000_000 : e.head_limit
    const args: Record<string, unknown> = {
      pattern: e.pattern,
      path: searchPath,
      cwd,
      limit,
      strict: true,
      max_match_chars: 0,
    }
    if (mode === 'files_with_matches') args.files_with_matches = true
    if (e.glob !== undefined) args.glob = e.glob
    if (e['-i']) args.ignore_case = true
    if (e['-A'] !== undefined) args.after_context = e['-A']
    if (e['-B'] !== undefined) args.before_context = e['-B']
    if (e['-C'] !== undefined && e['-A'] === undefined && e['-B'] === undefined) args.context = e['-C']
    if (e.offset !== undefined && e.offset > 0) args.skip = e.offset
    const reply = await client.call(io, 'grep', args)
    if (reply.isError) return leftToCore(io, 'Grep', subject, 'skyline reported an error')

    const block = firstText(reply.content)
    const translated =
      block === undefined
        ? undefined
        : translateGrep(block, { mode, cwd, searchPath, lineNumbers: e['-n'] === true, context, matches })
    if (!translated) return leftToCore(io, 'Grep', subject, `skyline block not translatable: ${headOf(block)}`)
    return { result: translated }
  } catch (err) {
    return leftToCore(io, 'Grep', subject, err instanceof DaemonDown ? `daemon down: ${err.message}` : messageOf(err))
  }
}

function firstText(content: readonly { type: string; text?: string }[]): string | undefined {
  return content.find((c) => c.type === 'text' && typeof c.text === 'string')?.text
}

/** The first line or so of a block, for a debug line; never a whole file. */
function headOf(block: string | undefined): string {
  return JSON.stringify((block ?? '').slice(0, 600))
}

function verdictText(verdict: { decision: string; reason?: string }): string {
  return verdict.decision + (verdict.reason ? ` (${verdict.reason})` : '')
}

function leftToCore(io: Io, tool: string, subject: string, reason: string): undefined {
  io.debug(`[skyline-mod] ${tool} ${subject} left to core: ${reason}`)
  return undefined
}

/** A boolean option, as a manifest may hold it (boolean or "true"/"false"). */
function flag(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

const ABSOLUTE = /^([A-Za-z]:[\\/]|[\\/])/

function separatorOf(p: string): string {
  return p.includes('\\') && !p.includes('/') ? '\\' : '/'
}

/** `filePath` made absolute against the session's directory. */
export function absoluteOf(filePath: string, cwd: string): string {
  if (ABSOLUTE.test(filePath)) return filePath
  const sep = separatorOf(cwd)
  return cwd.endsWith(sep) ? cwd + filePath : cwd + sep + filePath
}

/** The directory above `p`, or undefined at a root. */
export function parentOf(p: string): string | undefined {
  const sep = separatorOf(p)
  const trimmed = p.length > 1 && p.endsWith(sep) ? p.slice(0, -1) : p
  const i = trimmed.lastIndexOf(sep)
  if (i < 0) return undefined
  const parent = trimmed.slice(0, i)
  if (parent === '') return trimmed === sep ? undefined : sep
  if (/^[A-Za-z]:$/.test(parent)) return trimmed === parent + sep ? undefined : parent + sep
  return parent
}

function normalised(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** ~/.claude stays core's unconditionally, as the classic hook keeps it. */
async function isUnderClaudeConfig(io: Io, abs: string): Promise<boolean> {
  const home = await io.home()
  if (!home) return false
  const config = normalised(home) + '/.claude'
  const target = normalised(abs)
  return target === config || target.startsWith(config + '/')
}

/**
 * Whether a `.git` or `.skyrift-workspace` marker sits in the file's
 * directory or any ancestor: the classic hook's "inside any code tree",
 * walked with `$.fs.exists` and remembered per directory for the session.
 * Pass a directory as `<dir>/.` to start the walk at the directory itself.
 */
async function isInsideCodeTree(io: Io, abs: string, cache: Map<string, boolean>): Promise<boolean> {
  const start = parentOf(abs)
  if (start === undefined) return false
  const visited: string[] = []
  let found = false
  for (let dir: string | undefined = start, i = 0; dir !== undefined && i < 64; dir = parentOf(dir), i++) {
    const known = cache.get(dir)
    if (known !== undefined) {
      found = known
      break
    }
    visited.push(dir)
    const sep = separatorOf(dir)
    const base = dir.endsWith(sep) ? dir : dir + sep
    let marked = false
    for (const marker of CODE_TREE_MARKERS) {
      if (await io.exists(base + marker)) {
        marked = true
        break
      }
    }
    if (marked) {
      found = true
      break
    }
  }
  for (const dir of visited) cache.set(dir, found)
  return found
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Measures one resolved result.
 */
function recordOf(result: object, firstFile: string, source: 'skyline' | 'core'): ReadShape {
  const envelope = result as {
    deny?: string
    result?: unknown
    text?: string
    ref?: number
    isError?: boolean
    context?: readonly string[]
  }
  const kind: ReadKind =
    envelope.deny !== undefined ? 'denied' : envelope.isError ? 'errored' : 'answered'
  const record: ReadShape = {
    kind,
    source,
    envelopeKeys: Object.keys(envelope).sort(),
    result: shapeOf(envelope.result),
    contextCount: envelope.context?.length ?? 0,
    hasRef: envelope.ref !== undefined,
    hits: 1,
    firstFile,
  }
  if (typeof envelope.text === 'string') record.textLength = envelope.text.length
  if (kind === 'denied') record.deny = envelope.deny
  return record
}
