/**
 * Skyline's `grep` text block, as the daemon renders it:
 *
 *     N matches in M files.            (content mode only)
 *     ¶/abs/dir/a.rs#TAG
 *     1:fn alpha() {}
 *     2:let beta = 2;
 *
 *     ¶/abs/dir/b.txt#TAG
 *     2:beta line two
 *
 * (files_with_matches mode: the ¶ headers alone, then a blank line and a
 * hint; no matches: `No matches found.`)
 *
 * into the record core produces for a Grep (observed on Claude Code 2.1.278,
 * see README): files mode `{ mode, filenames, numFiles, totalFiles }`,
 * content mode `{ mode, content, filenames: [], numFiles, numLines,
 * totalLines }`, where `content` is ripgrep's rendering: paths relative to
 * the working directory in the host's separator, `path:N:line` for a match
 * and `path-N-line` for a context line (with `-n`; without it the number is
 * left out), `--` between context groups, and no path at all when the search
 * was one file.
 *
 * Pure: no engine, no I/O.
 */

export type GrepMode = 'files_with_matches' | 'content'

export type GrepFilesRecord = {
  mode: 'files_with_matches'
  filenames: string[]
  numFiles: number
  totalFiles: number
}

export type GrepContentRecord = {
  mode: 'content'
  content: string
  filenames: []
  numFiles: number
  numLines: number
  totalLines: number
}

export type GrepRecord = GrepFilesRecord | GrepContentRecord

export type GrepRendering = {
  mode: GrepMode
  /** The session's working directory: paths come out relative to it. */
  cwd: string
  /** The absolute path searched (the working directory when none was given). */
  searchPath: string
  /** `-n`: line numbers in content mode. */
  lineNumbers: boolean
  /** Lines of context asked for (max of -A, -B, -C); 0 for none. */
  context: number
  /** Tells a match from a context line when context > 0; undefined otherwise. */
  matches?: (line: string) => boolean
  /**
   * Files the permission path would refuse a Read of, as skyline spelled
   * them: dropped whole, as core drops them from its own results.
   */
  denied?: ReadonlySet<string>
}

const ANCHOR = /^¶(.+)#[A-Za-z0-9]+$/
const NUMBERED = /^(\d+):(.*)$/
const SUMMARY = /^\d+ match(es)? in \d+ file(s)?\.$/
const NO_MATCHES = /^No matches found\.?$/
/** Prose skyline appends after the last match, sometimes with no blank line before it. */
const TRAILER = /^(steer:|hint:|resume:|note:|\*\*Next:\*\*|pass skip:|truncated|showing |…)/i

type FileBlock = { path: string; lines: { n: number; text: string }[] }

/**
 * Splits a block into files. Returns undefined when a line is neither a
 * header, a numbered line, a summary, nor a hint after the last file.
 */
function blocksOf(block: string): FileBlock[] | undefined {
  const out: FileBlock[] = []
  let current: FileBlock | undefined
  let afterFiles = false
  for (const raw of block.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line === '') {
      if (current) afterFiles = true
      continue
    }
    const header = ANCHOR.exec(line)
    if (header) {
      current = { path: header[1] ?? '', lines: [] }
      out.push(current)
      afterFiles = false
      continue
    }
    if (!current) {
      if (SUMMARY.test(line) || NO_MATCHES.test(line)) continue
      return undefined
    }
    if (afterFiles) continue // the hint paragraph after the last file
    const numbered = NUMBERED.exec(line)
    if (numbered) {
      current.lines.push({ n: Number(numbered[1]), text: numbered[2] ?? '' })
      continue
    }
    if (TRAILER.test(line)) {
      afterFiles = true
      continue
    }
    return undefined
  }
  return out
}

function posix(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
}

/** `path` relative to `cwd` in `sep`, or as given when it is not beneath. */
export function relativeOf(path: string, cwd: string, sep: string): string {
  const p = posix(path)
  const c = posix(cwd)
  const under = p.toLowerCase().startsWith(c.toLowerCase() + '/')
  const rel = under ? p.slice(c.length + 1) : p
  return sep === '/' ? rel : rel.replace(/\//g, sep)
}

/**
 * The files a grep block names, as skyline spelled them, so the caller can
 * ask the permission path about each before translating. Undefined when the
 * block is not in the expected form.
 */
export function grepFilesOf(block: string): string[] | undefined {
  return blocksOf(block)?.map((f) => f.path)
}

/**
 * Translates one grep block. Returns undefined when the block is not in the
 * expected form, so the caller can let core's Grep run instead.
 */
export function translateGrep(block: string, r: GrepRendering): GrepRecord | undefined {
  const parsed = blocksOf(block)
  if (!parsed) return undefined
  const files = r.denied ? parsed.filter((f) => !r.denied!.has(f.path)) : parsed
  const sep = r.cwd.includes('\\') && !r.cwd.includes('/') ? '\\' : '/'

  if (r.mode === 'files_with_matches') {
    const filenames = files.map((f) => relativeOf(f.path, r.cwd, sep))
    return { mode: 'files_with_matches', filenames, numFiles: filenames.length, totalFiles: filenames.length }
  }

  const singleFile = files.length === 1 && posix(files[0]!.path).toLowerCase() === posix(r.searchPath).toLowerCase()
  const out: string[] = []
  let numLines = 0
  files.forEach((file, index) => {
    const rel = singleFile ? undefined : relativeOf(file.path, r.cwd, sep)
    file.lines.forEach((line, i) => {
      const previous = file.lines[i - 1]
      const gap = previous !== undefined && line.n - previous.n > 1
      if (r.context > 0 && (gap || (i === 0 && index > 0))) out.push('--')
      const isMatch = r.context > 0 && r.matches ? r.matches(line.text) : true
      const mark = isMatch ? ':' : '-'
      const prefix = (rel === undefined ? '' : rel + mark) + (r.lineNumbers ? `${line.n}${mark}` : '')
      out.push(prefix + line.text)
      numLines += 1
    })
  })
  return { mode: 'content', content: out.join('\n'), filenames: [], numFiles: files.length, numLines, totalLines: numLines }
}
