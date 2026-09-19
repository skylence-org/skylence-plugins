/**
 * Grep, declared for this mod by declaration merging (the engine's
 * `BuiltinToolInputs` is empty until a declaration file adds entries, and the
 * checkout of `claude-code.d.ts` this mod typechecks against does not list
 * Grep). The fields are the Grep tool's input schema as Claude Code 2.1.278
 * offers them to the model.
 */
declare module 'claude-code' {
  interface BuiltinToolInputs {
    Grep: {
      /** The regular expression pattern to search for in file contents */
      pattern: string
      /** File or directory to search in; defaults to the working directory */
      path?: string
      /** Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}") */
      glob?: string
      /** File type to search (rg --type), e.g. "js", "py", "rust" */
      type?: string
      /** "files_with_matches" (the default), "content" or "count" */
      output_mode?: 'content' | 'files_with_matches' | 'count'
      /** Lines after each match; content mode only */
      '-A'?: number
      /** Lines before each match; content mode only */
      '-B'?: number
      /** Lines around each match; content mode only */
      '-C'?: number
      /** Show line numbers; content mode only */
      '-n'?: boolean
      /** Case insensitive search */
      '-i'?: boolean
      /** Cap on output lines, entries or counts (default 250; 0 for unlimited) */
      head_limit?: number
      /** Entries to skip before head_limit applies */
      offset?: number
      /** Patterns may span lines */
      multiline?: boolean
    }
  }
}
