import type { On, PluginOptions } from 'claude-code'

import { DaemonDown, SkylineClient, type Transport } from './mcp'
import { shapeOf, signatureOf, type Shape } from './shape'
import { translateRead, type ReadFile } from './translate'

export const DEFAULT_DAEMON_URL = 'http://127.0.0.1:7333/mcp'

/** Files core renders specially (pages, images, notebooks): never skyline's. */
const NOT_TEXT = /\.(pdf|png|jpe?g|gif|webp|bmp|ico|ipynb)$/i

/** The markers that make a directory a code tree, as the classic hook has them. */
const CODE_TREE_MARKERS = ['.git', '.skyrift-workspace']

/**
 * What a Read came back as: answered by the tool, refused by a hook or the
 * permission path, or run and failed.
 */
export type ReadKind = 'answered' | 'denied' | 'errored'

/**
 * One distinct shape of Read result, counted across the session.
 */
export type ReadShape = {
  kind: ReadKind
  /** Who produced it: this mod from skyline, or core's own Read. */
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
  /** How many Reads produced this shape. */
  hits: number
  /** The file the first such Read asked for. */
  firstFile: string
}

/**
 * The engine calls the answer path makes, as closures over `$`: a user-tier
 * module may only spell `$` as `$.noun.event(...)` at a call site.
 */
type Io = Transport & {
  cwd: () => Promise<string>
  /** USERPROFILE, else HOME (the loader wants `$.env.get` given literal names). */
  home: () => Promise<string | undefined>
  exists: (path: string) => Promise<boolean>
  debug: (text: string) => void
}

type ReadCall = { file_path: string; offset?: number; limit?: number; pages?: string }

type Answer = { result: { type: 'text'; file: ReadFile }; context?: readonly string[] }

/**
 * Registers the mod's one hook, on Read.
 *
 * Stage 2: a Read of a text file inside a code tree is answered from the
 * skyline daemon, in the record core would have produced, with skyline's
 * `¶path#TAG` anchor as one context line; core's Read never runs and the
 * classic enforce hook beneath never sees a call to deny. Anything else (the
 * daemon down or answering an error, a file outside any code tree or under
 * ~/.claude, a pdf, an image, a notebook, a `pages` request, a block that
 * does not parse) goes on to core untouched.
 *
 * Stage 1 stays: whatever the answer, its shape is recorded.
 *
 * @param on the engine's registrar
 * @param options `daemonUrl` (default http://127.0.0.1:7333/mcp);
 *   `answerFromSkyline` (default true; false makes the mod observe only);
 *   `anchorContext` (default true; false drops the anchor line); `shapeFile`
 *   (default none)
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

    const io: Io = {
      fetch: (url, init) => $.http.fetch(url, init),
      now: () => $.clock.now(),
      cwd: () => $.session.cwd(),
      home: async () => (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')),
      exists: (path) => $.fs.exists(path),
      debug: (text) => $.ui.log(text, { to: 'debug' }),
    }

    const answered = answering ? await answerFromSkyline(io, e, client, codeTrees, anchorContext) : undefined
    const result = answered ?? (await next(e))

    try {
      const record = recordOf(result, e.file_path, answered ? 'skyline' : 'core')
      const signature = signatureOf({ kind: record.kind, source: record.source, keys: record.envelopeKeys, result: record.result })
      const known = seen.get(signature)
      if (known) {
        known.hits += 1
      } else {
        seen.set(signature, record)
        $.ui.log(
          `[skyline-mod] Read ${record.kind} by ${record.source} shape #${seen.size}: ` +
            `envelope {${record.envelopeKeys.join(', ')}} result ${JSON.stringify(record.result)}` +
            (record.textLength === undefined ? '' : ` text ${record.textLength} chars`),
        )
      }
      $.ui.log(`[skyline-mod] ${JSON.stringify({ file: e.file_path, ...(known ?? record) })}`, { to: 'debug' })
      if (shapeFile) {
        await $.fs.write(shapeFile, JSON.stringify([...seen.values()], null, 2) + '\n')
      }
    } catch (err) {
      // Measuring must never cost the model its Read.
      $.ui.log(`[skyline-mod] could not record a Read shape: ${messageOf(err)}`, { to: 'debug' })
    }
    return result
  })
}

/**
 * Answers a Read from skyline, or returns undefined to let core's Read run.
 * Never throws: whatever goes wrong is a debug line and a pass-through.
 */
async function answerFromSkyline(
  io: Io,
  e: ReadCall,
  client: SkylineClient,
  codeTrees: Map<string, boolean>,
  anchorContext: boolean,
): Promise<Answer | undefined> {
  try {
    if (e.pages !== undefined || NOT_TEXT.test(e.file_path)) return leftToCore(io, e.file_path, 'not a text read')

    const abs = absoluteOf(e.file_path, await io.cwd())
    if (await isUnderClaudeConfig(io, abs)) return leftToCore(io, abs, 'under ~/.claude')
    if (!(await isInsideCodeTree(io, abs, codeTrees))) return leftToCore(io, abs, 'not inside a code tree')

    const args: Record<string, unknown> = { path: abs, full: true, max_match_chars: 0 }
    if (e.offset !== undefined) args.offset = e.offset
    if (e.limit !== undefined) args.limit = e.limit
    const reply = await client.call(io, 'read', args)
    if (reply.isError) return undefined

    const block = reply.content.find((c) => c.type === 'text' && typeof c.text === 'string')?.text
    const translated = block === undefined ? undefined : translateRead(block, abs, e.offset)
    if (!translated) {
      io.debug(`[skyline-mod] skyline read block not translatable for ${abs}; core reads it`)
      return undefined
    }

    return {
      result: { type: 'text', file: translated.file },
      ...(anchorContext ? { context: [`skyline anchor for edit (paste verbatim): ${translated.anchor}`] } : {}),
    }
  } catch (err) {
    const why = err instanceof DaemonDown ? `daemon down: ${err.message}` : messageOf(err)
    io.debug(`[skyline-mod] skyline could not answer Read of ${e.file_path} (${why}); core reads it`)
    return undefined
  }
}

function leftToCore(io: Io, path: string, reason: string): undefined {
  io.debug(`[skyline-mod] Read of ${path} left to core: ${reason}`)
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

/** `file_path` made absolute against the session's directory. */
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
 * Measures one resolved Read result.
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
