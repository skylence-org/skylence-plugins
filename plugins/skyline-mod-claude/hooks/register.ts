import type { On, PluginOptions } from 'claude-code'

import { shapeOf, signatureOf, type Shape } from './shape'

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
  /** The result envelope's own keys, as `next(e)` resolved them. */
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
 * Registers the stage-1 hook: Read runs as the engine would run it, and what
 * comes back is measured, never changed.
 *
 * @param on the engine's registrar
 * @param options the plugin's options; `shapeFile` names a JSON file to
 *   rewrite with every distinct shape after each Read, or is empty for none
 */
export function register(on: On, options: PluginOptions): void {
  const shapeFile = typeof options.shapeFile === 'string' ? options.shapeFile.trim() : ''
  const seen = new Map<string, ReadShape>()

  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const result = await next(e)
    if (e.tool !== 'Read') return result

    const file = e.file_path
    try {
      const record = recordOf(result, file)
      const signature = signatureOf({ kind: record.kind, keys: record.envelopeKeys, result: record.result })
      const known = seen.get(signature)
      if (known) {
        known.hits += 1
      } else {
        seen.set(signature, record)
        $.ui.log(
          `[skyline-mod] Read ${record.kind} shape #${seen.size}: ` +
            `envelope {${record.envelopeKeys.join(', ')}} result ${JSON.stringify(record.result)}` +
            (record.textLength === undefined ? '' : ` text ${record.textLength} chars`),
        )
      }
      $.ui.log(`[skyline-mod] ${JSON.stringify({ file, ...(known ?? record) })}`, { to: 'debug' })
      if (shapeFile) {
        await $.fs.write(shapeFile, JSON.stringify([...seen.values()], null, 2) + '\n')
      }
    } catch (err) {
      // Measuring must never cost the model its Read.
      const message = err instanceof Error ? err.message : String(err)
      $.ui.log(`[skyline-mod] could not record a Read shape: ${message}`, { to: 'debug' })
    }
    return result
  })
}

/**
 * Measures one resolved Read result.
 */
function recordOf(result: Awaited<ReturnType<Parameters<On>[2]>> & object, firstFile: string): ReadShape {
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
