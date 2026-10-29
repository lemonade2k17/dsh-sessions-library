/**
 * Host half of the sessions-library bundle.
 *
 * Serves one snapshot route used by the Client page:
 *   POST /api/sessions-library/snapshot
 *
 * Data sources (official services; the plugin never re-scans the storage root
 * by hand):
 *   - workspaceController.follow() baseline -> workspaces + archived/pinned sets
 *   - sessionController.list()               -> session summaries + projection hints
 *   - sessionQuery.readTitleSnapshots()      -> batch title fallback
 *
 * Every step is bounded by a timeout and traced to
 * `<DSH_HOME>/cache/sessions-library/debug.log`; a self-test runs shortly after
 * activation so a restart alone proves which layer works. A degraded hop falls
 * back to a cheaper source instead of leaving the request pending.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { inflateRawSync, zstdCompressSync, zstdDecompressSync } from 'node:zlib'

export const name = 'dsh-sessions-library'

export const inject = ['connection']

const SNAPSHOT_PATH = '/api/sessions-library/snapshot'
const FOLLOW_TIMEOUT_MS = 2500
const SUMMARIES_TIMEOUT_MS = 8000
const TITLES_TIMEOUT_MS = 6000
const SELF_TEST_DELAY_MS = 2500
const SELF_TEST_TIMEOUT_MS = 25000

const DSH_HOME = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
  ? process.env.DSH_HOME
  : join(homedir(), '.dsh')
const DEBUG_DIR = join(DSH_HOME, 'cache', 'sessions-library')
const DEBUG_LOG = join(DEBUG_DIR, 'debug.log')
const DEBUG_SNAPSHOT = join(DEBUG_DIR, 'last-snapshot.json')

// Session storage root and the recycle-bin root. The trash lives OUTSIDE the
// sessions root so the persistence backend never scans it.
const SESSIONS_ROOT = join(DSH_HOME, 'sessions')
const TRASH_ROOT = join(DSH_HOME, 'sessions-trash')

const DELETE_PREFLIGHT_PATH = '/api/sessions-library/delete-preflight'
const DELETE_PATH = '/api/sessions-library/delete'
const TRASH_LIST_PATH = '/api/sessions-library/trash-list'
const TRASH_RESTORE_PATH = '/api/sessions-library/trash-restore'
const TRASH_PURGE_PATH = '/api/sessions-library/trash-purge'
const LOGS_PATH = '/api/sessions-library/logs'
const LOGS_CLEAR_PATH = '/api/sessions-library/logs-clear'
const LOGS_DELETE_PATH = '/api/sessions-library/logs-delete'
const DELETE_PROGRESS_PATH = '/api/sessions-library/delete-progress'
const EXPORT_PATH = '/api/sessions-library/export'
const IMPORT_LIST_PATH = '/api/sessions-library/import-list'
const IMPORT_PREFLIGHT_PATH = '/api/sessions-library/import-preflight'
const IMPORT_RUN_PATH = '/api/sessions-library/import-run'
const DELETE_BATCH_LIMIT = 100
const PURGE_AUDIT_FILE = join(DSH_HOME, 'sessions-library', 'audit.log')
// Sessions deleted while still loaded are queued here and moved on next start.
const PENDING_TRASH_FILE = join(DSH_HOME, 'sessions-library', 'pending-trash.json')
// Exported session packages land here for the user to move between machines.
const EXPORT_DIR = join(DSH_HOME, 'sessions-library', 'exports')
const EXPORT_MAX_BYTES = 512 * 1024 * 1024
const IMPORT_ZIP_BYTES_LIMIT = 768 * 1024 * 1024
const IMPORT_UNPACKED_BYTES_LIMIT = 1536 * 1024 * 1024
const IMPORT_ENTRY_LIMIT = 20000

// Identifies one Host process. The Client compares it with the value it stored
// last time: a different value means DSH restarted, so view state resets.
const BOOT_AT = Date.now()

// Titles already resolved by a page snapshot. The delete dialog needs titles for
// the selected families, and re-reading them per open is what made the dialog
// slow; an unknown id still falls back to one bounded batch read.
const TITLE_CACHE_LIMIT = 4000
const titleCache = new Map()

/**
 * Remember one resolved title for later delete preflights.
 *
 * @param {string} id session id.
 * @param {unknown} title resolved title.
 */
function rememberTitle(id, title) {
  if (typeof id !== 'string' || typeof title !== 'string' || title.trim() === '') return
  if (titleCache.size >= TITLE_CACHE_LIMIT) titleCache.clear()
  titleCache.set(id, title)
}

// Operation history shown on the library's log page: one JSONL record per
// action, appended only after the action succeeded.
const OPERATIONS_FILE = join(DSH_HOME, 'sessions-library', 'operations.log')
const OPERATIONS_LIMIT = 500
const OPERATIONS_BYTES_LIMIT = 512 * 1024
const OPERATIONS_KEEP = 1000

/**
 * Append one operation record.
 *
 * @param {{ action: string, sessionId?: string, title?: string | null, role?: string }} record the action.
 */
function appendOperation(record) {
  try {
    mkdirSync(dirname(OPERATIONS_FILE), { recursive: true })
    appendFileSync(OPERATIONS_FILE, `${JSON.stringify({
      at: new Date().toISOString(),
      action: typeof record.action === 'string' ? record.action : 'unknown',
      sessionId: typeof record.sessionId === 'string' ? record.sessionId : '',
      title: typeof record.title === 'string' && record.title.trim() !== '' ? record.title : null,
      role: typeof record.role === 'string' ? record.role : 'root',
    })}\n`)
    trimOperations()
  } catch {
    // History must never block an operation.
  }
}

/** Keep the history file bounded by dropping the oldest records. */
function trimOperations() {
  try {
    if (statSync(OPERATIONS_FILE).size <= OPERATIONS_BYTES_LIMIT) return
    const lines = readFileSync(OPERATIONS_FILE, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
    writeFileSync(OPERATIONS_FILE, `${lines.slice(-OPERATIONS_KEEP).join('\n')}\n`)
  } catch {
    // A failed trim only costs disk space.
  }
}

/**
 * Stable id for one stored history line.
 *
 * A line index cannot identify a record: the file is trimmed from the front, so
 * every remaining index shifts. A content hash plus an occurrence counter stays
 * put — identical records can only appear when the same action lands in the same
 * millisecond, and the counter keeps even those distinguishable.
 *
 * @param {string} line raw JSONL line.
 * @param {number} occurrence 0-based position among identical lines, newest first.
 * @returns {string} the id.
 */
function operationLineId(line, occurrence) {
  return `${crc32(Buffer.from(line, 'utf8')).toString(16)}#${occurrence}`
}

/**
 * Parse the history file into id-tagged rows, newest first.
 *
 * @returns {Array<{ id: string, line: string }>} rows.
 */
function readOperationLines() {
  let lines = []
  try {
    lines = readFileSync(OPERATIONS_FILE, 'utf8').split('\n').filter((line) => line.trim() !== '')
  } catch {
    return []
  }
  const rows = []
  const occurrences = new Map()
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    const seen = occurrences.get(line) ?? 0
    occurrences.set(line, seen + 1)
    rows.push({ id: operationLineId(line, seen), line })
  }
  return rows
}

/**
 * Read the most recent operations, newest first.
 *
 * @param {any} limit requested row count.
 * @returns {Array<object>} operation records, each carrying its stable `id`.
 */
function readOperations(limit) {
  const parsedLimit = Number(limit)
  const wanted = Number.isFinite(parsedLimit) && parsedLimit > 0
    ? Math.min(OPERATIONS_LIMIT, Math.floor(parsedLimit))
    : OPERATIONS_LIMIT
  const entries = []
  for (const row of readOperationLines()) {
    if (entries.length >= wanted) break
    try {
      const value = JSON.parse(row.line)
      if (value && typeof value === 'object') entries.push({ ...value, id: row.id })
    } catch {
      // Skip a corrupt line instead of dropping the whole history.
    }
  }
  return entries
}

/**
 * Delete the selected history rows.
 *
 * Everything else is rewritten through a temporary file and a rename so a crash
 * cannot leave half a history behind. Trimming is unnecessary: the file only
 * shrinks here.
 *
 * @param {any} rawIds requested row ids.
 * @returns {number} how many rows were removed.
 */
function deleteOperations(rawIds) {
  const wanted = new Set(
    (Array.isArray(rawIds) ? rawIds : [])
      .filter((id) => typeof id === 'string' && id !== '')
      .slice(0, OPERATIONS_LIMIT),
  )
  if (wanted.size === 0) return 0
  const rows = readOperationLines()
  if (rows.length === 0) return 0
  const kept = rows.filter((row) => !wanted.has(row.id))
  const removed = rows.length - kept.length
  if (removed === 0) return 0
  const temporary = `${OPERATIONS_FILE}.tmp`
  try {
    mkdirSync(dirname(OPERATIONS_FILE), { recursive: true })
    // Rows are newest first; the file keeps its oldest-first order.
    const body = kept.map((row) => row.line).reverse()
    writeFileSync(temporary, body.length > 0 ? `${body.join('\n')}\n` : '')
    renameSync(temporary, OPERATIONS_FILE)
  } catch {
    try {
      rmSync(temporary, { force: true })
    } catch {
      // A leftover temporary file is harmless; the history is untouched.
    }
    return 0
  }
  return removed
}

/** Remove the operation history. */
function clearOperations() {
  try {
    rmSync(OPERATIONS_FILE, { force: true })
  } catch {
    // A failed clear leaves the old history in place.
  }
}

// Live progress for running delete batches: one entry per Client-supplied
// token, polled by the dialog while the delete request is in flight.
const DELETE_PROGRESS_TTL_MS = 120000
const deleteProgress = new Map()

/** Drop finished or abandoned progress entries. */
function pruneDeleteProgress() {
  const now = Date.now()
  for (const [token, entry] of deleteProgress) {
    if (now - entry.at > DELETE_PROGRESS_TTL_MS) deleteProgress.delete(token)
  }
}

/**
 * Advance one batch's progress.
 *
 * @param {object | null} progress live progress entry.
 * @param {unknown} current title of the session just handled.
 */
function bumpDeleteProgress(progress, current) {
  if (!progress || typeof progress !== 'object') return
  progress.done += 1
  progress.current = typeof current === 'string' ? current : ''
  progress.at = Date.now()
}

/**
 * Describe an unknown error as one line.
 *
 * @param {unknown} error the failure.
 * @returns {string} a short description.
 */
function describeError(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

/**
 * Append one diagnostic line; never throws.
 *
 * @param {string} requestId trace identity.
 * @param {string} step step name.
 * @param {string} detail free-form detail.
 */
function trace(requestId, step, detail) {
  try {
    mkdirSync(DEBUG_DIR, { recursive: true })
    appendFileSync(DEBUG_LOG, `${new Date().toISOString()} [${requestId}] ${step} ${detail}\n`)
  } catch {
    // Diagnostics must never break the request.
  }
}

/**
 * Reset the diagnostic log for one activation.
 *
 * @param {string} detail first line detail.
 */
function resetTrace(detail) {
  try {
    mkdirSync(DEBUG_DIR, { recursive: true })
    writeFileSync(DEBUG_LOG, `${new Date().toISOString()} [boot] ${detail}\n`)
  } catch {
    // Diagnostics must never break activation.
  }
}

/**
 * Persist the last successful snapshot for offline inspection.
 *
 * @param {object} snapshot snapshot payload.
 */
function writeSnapshotFile(snapshot) {
  try {
    mkdirSync(DEBUG_DIR, { recursive: true })
    writeFileSync(DEBUG_SNAPSHOT, JSON.stringify(snapshot, null, 2))
  } catch {
    // Diagnostics must never break the request.
  }
}

/**
 * Resolve a promise with a bounded wait.
 *
 * @param {Promise<any>} promise operation to wait for.
 * @param {number} timeoutMs maximum wait.
 * @returns {Promise<{ timedOut: boolean, value?: any, error?: unknown }>} the outcome.
 */
function withTimeout(promise, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve({ timedOut: true })
    }, timeoutMs)
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ timedOut: false, value })
      },
      (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ timedOut: false, error })
      },
    )
  })
}

/**
 * Build a JSON response with no-store caching.
 *
 * @param {unknown} value JSON-serializable payload.
 * @param {number} [status] HTTP status code.
 * @returns {Response} the response.
 */
function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/**
 * Normalize one WorkspaceView coming from the follow baseline.
 *
 * @param {any} view baseline item.
 * @returns {{ workspaceId: string, path: string, title: string, sessionIds: string[] }} normalized view.
 */
function normalizeWorkspaceView(view) {
  const item = view && typeof view === 'object' ? view : {}
  return {
    workspaceId: String(item.workspaceId ?? ''),
    path: typeof item.path === 'string' ? item.path : '',
    title: typeof item.title === 'string' ? item.title : '',
    sessionIds: Array.isArray(item.sessionIds) ? item.sessionIds.map(String) : [],
  }
}

/**
 * Normalize the complete workspace baseline.
 *
 * @param {any} value baseline payload.
 * @returns {{ items: Array<object>, archivedSessionIds: string[], pinnedSessionIds: string[] }} normalized baseline.
 */
function normalizeBaseline(value) {
  const source = value && typeof value === 'object' ? value : {}
  const items = Array.isArray(source.items) ? source.items.map(normalizeWorkspaceView) : []
  const archived = Array.isArray(source.archivedSessionIds) ? source.archivedSessionIds.map(String) : []
  const pinned = Array.isArray(source.pinnedSessionIds) ? source.pinnedSessionIds.map(String) : []
  return { items, archivedSessionIds: archived, pinnedSessionIds: pinned }
}

/**
 * Read the workspace baseline: try the follow baseline with a bounded wait,
 * then fall back to the synchronous registry projection (which carries no
 * archive/pin sets).
 *
 * @param {object} ctx Cordis context.
 * @param {string} requestId trace identity.
 * @returns {Promise<{ baseline: object, source: string }>} the baseline and its source tag.
 */
async function readWorkspaceBaseline(ctx, requestId) {
  const controller = ctx.get('workspaceController')
  if (controller && typeof controller.follow === 'function') {
    trace(requestId, 'workspaces', 'follow:start')
    const abort = new AbortController()
    const attempt = (async () => {
      for await (const frame of controller.follow(abort.signal)) {
        if (frame && frame.type === 'baseline' && frame.value) return frame.value
        return undefined
      }
      return undefined
    })()
    attempt.catch(() => {})
    const outcome = await withTimeout(attempt, FOLLOW_TIMEOUT_MS)
    abort.abort()
    if (outcome.timedOut) {
      trace(requestId, 'workspaces', `follow:timeout>${FOLLOW_TIMEOUT_MS}ms`)
    } else if (outcome.error) {
      trace(requestId, 'workspaces', `follow:error ${describeError(outcome.error)}`)
    } else if (outcome.value) {
      trace(requestId, 'workspaces', `follow:ok items=${outcome.value.items?.length ?? 0}`)
      return { baseline: normalizeBaseline(outcome.value), source: 'follow' }
    } else {
      trace(requestId, 'workspaces', 'follow:no-baseline')
    }
  } else {
    trace(requestId, 'workspaces', 'follow:unavailable')
  }

  const registry = ctx.get('workspaceRegistry')
  if (registry && typeof registry.list === 'function') {
    const items = registry.list().map((workspace) => ({
      workspaceId: String(workspace.id),
      path: workspace.path,
      title: workspace.title,
      sessionIds: [...workspace.sessionIds].map(String),
    }))
    trace(requestId, 'workspaces', `registry:ok items=${items.length}`)
    return { baseline: { items, archivedSessionIds: [], pinnedSessionIds: [] }, source: 'registry' }
  }

  trace(requestId, 'workspaces', 'registry:unavailable')
  return { baseline: { items: [], archivedSessionIds: [], pinnedSessionIds: [] }, source: 'none' }
}

/**
 * Read the title a session summary already carries in its projection hints.
 *
 * @param {any} projections projection hints from a session summary.
 * @returns {string | null} the title when present.
 */
function projectionTitle(projections) {
  try {
    const values = projections && typeof projections === 'object' ? projections.values : undefined
    if (!values || typeof values !== 'object') return null
    const candidate = values.title
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate
    if (candidate && typeof candidate === 'object') {
      if (typeof candidate.title === 'string' && candidate.title.trim() !== '') return candidate.title
      if (typeof candidate.text === 'string' && candidate.text.trim() !== '') return candidate.text
    }
  } catch {
    // Projection hints are optional.
  }
  return null
}

/**
 * Normalize one session summary (or a degradation-shaped equivalent).
 *
 * @param {any} item summary payload.
 * @returns {object} normalized summary with its projection title when available.
 */
function normalizeSummary(item) {
  const source = item && typeof item === 'object' ? item : {}
  return {
    id: String(source.sessionId ?? source.id ?? ''),
    title: projectionTitle(source.projections),
    updatedAt: typeof source.updatedAt === 'number' ? source.updatedAt : 0,
    archived: false,
    pinned: false,
    ...(source.origin === 'subagent' ? { origin: 'subagent' } : {}),
    ...(typeof source.cwd === 'string' ? { cwd: source.cwd } : {}),
    blank: source.blank === true,
    running: source.running === true,
    ...(source.formatStatus === undefined ? {} : { formatStatus: source.formatStatus }),
  }
}

/**
 * Read every session summary visible to the Host: the controller projection
 * first (it carries activity time), then the persistence snapshots.
 *
 * @param {object} ctx Cordis context.
 * @param {AbortSignal} signal request cancellation.
 * @param {string} requestId trace identity.
 * @returns {Promise<{ items: Array<object>, source: string }>} normalized summaries and the source tag.
 */
async function readSummaries(ctx, signal, requestId) {
  const controller = ctx.get('sessionController')
  if (controller && typeof controller.list === 'function') {
    trace(requestId, 'summaries', 'controller:start')
    const outcome = await withTimeout(Promise.resolve().then(() => controller.list({}, signal)), SUMMARIES_TIMEOUT_MS)
    if (outcome.timedOut) {
      trace(requestId, 'summaries', `controller:timeout>${SUMMARIES_TIMEOUT_MS}ms`)
    } else if (outcome.error) {
      trace(requestId, 'summaries', `controller:error ${describeError(outcome.error)}`)
    } else {
      const items = outcome.value && Array.isArray(outcome.value.items) ? outcome.value.items : []
      trace(requestId, 'summaries', `controller:ok items=${items.length}`)
      if (items.length > 0) return { items: items.map(normalizeSummary), source: 'controller' }
    }
  } else {
    trace(requestId, 'summaries', 'controller:unavailable')
  }

  const persistence = ctx.get('sessionPersistence')
  if (persistence && typeof persistence.list === 'function') {
    const outcome = await withTimeout(Promise.resolve().then(() => persistence.list({ signal })), SUMMARIES_TIMEOUT_MS)
    if (outcome.timedOut) {
      trace(requestId, 'summaries', `persistence:timeout>${SUMMARIES_TIMEOUT_MS}ms`)
    } else if (outcome.error) {
      trace(requestId, 'summaries', `persistence:error ${describeError(outcome.error)}`)
    } else {
      const snapshots = Array.isArray(outcome.value) ? outcome.value : []
      trace(requestId, 'summaries', `persistence:ok items=${snapshots.length}`)
      const items = snapshots.map((snapshot) => normalizeSummary({
        sessionId: snapshot.header.id,
        cwd: snapshot.header.cwd,
        origin: snapshot.header.origin,
        updatedAt: snapshot.header.createdAt,
        blank: false,
        running: false,
        formatStatus: snapshot.formatStatus,
      }))
      return { items, source: 'persistence' }
    }
  } else {
    trace(requestId, 'summaries', 'persistence:unavailable')
  }

  return { items: [], source: 'none' }
}

/**
 * Fill in titles the summaries did not carry, using one bounded batch read.
 *
 * @param {object} ctx Cordis context.
 * @param {string[]} sessionIds sessions still missing a title.
 * @param {AbortSignal} signal request cancellation.
 * @param {string} requestId trace identity.
 * @returns {Promise<{ titles: Map<string, string>, source: string }>} title map and its source tag.
 */
async function readTitles(ctx, sessionIds, signal, requestId) {
  const titles = new Map()
  if (sessionIds.length === 0) return { titles, source: 'projection' }

  const query = ctx.get('sessionQuery')
  if (!query || typeof query.readTitleSnapshots !== 'function') {
    trace(requestId, 'titles', 'unavailable')
    return { titles, source: 'skipped' }
  }

  trace(requestId, 'titles', `batch:start ids=${sessionIds.length}`)
  const outcome = await withTimeout(
    Promise.resolve().then(() => query.readTitleSnapshots(sessionIds, signal)),
    TITLES_TIMEOUT_MS,
  )
  if (outcome.timedOut) {
    trace(requestId, 'titles', `batch:timeout>${TITLES_TIMEOUT_MS}ms`)
    return { titles, source: 'batch-timeout' }
  }
  if (outcome.error) {
    trace(requestId, 'titles', `batch:error ${describeError(outcome.error)}`)
    return { titles, source: 'batch-failed' }
  }

  const results = Array.isArray(outcome.value) ? outcome.value : []
  for (const result of results) {
    if (!result || result.status !== 'fulfilled') continue
    const title = result.value && result.value.title
    if (title && typeof title.title === 'string' && title.title.trim() !== '') {
      titles.set(String(result.sessionId), title.title)
    }
  }
  trace(requestId, 'titles', `batch:ok resolved=${titles.size}`)
  return { titles, source: 'batch' }
}

/**
 * Read the deferred-deletion registry (sessions deleted while still loaded).
 *
 * @returns {Record<string, object>} session id to its pending record.
 */
function readPendingTrash() {
  try {
    const parsed = JSON.parse(readFileSync(PENDING_TRASH_FILE, 'utf8'))
    if (parsed && typeof parsed === 'object' && parsed.items && typeof parsed.items === 'object') {
      return parsed.items
    }
    return {}
  } catch {
    return {}
  }
}

/**
 * Persist the deferred-deletion registry.
 *
 * @param {Record<string, object>} items session id to its pending record.
 */
function writePendingTrash(items) {
  try {
    mkdirSync(dirname(PENDING_TRASH_FILE), { recursive: true })
    writeFileSync(PENDING_TRASH_FILE, JSON.stringify({ items }, null, 2))
  } catch {
    // Best effort: an unreadable registry only delays the move.
  }
}

/**
 * Read the durable session list: the authoritative set of stored sessions.
 *
 * @param {object} ctx Cordis context.
 * @param {AbortSignal} signal request cancellation.
 * @param {string} requestId trace identity.
 * @returns {Promise<{ snapshots: Array<object>, source: string }>} persistence snapshots and source tag.
 */
async function readPersistedSessions(ctx, signal, requestId) {
  const persistence = ctx.get('sessionPersistence')
  if (!persistence || typeof persistence.list !== 'function') {
    trace(requestId, 'persisted', 'unavailable')
    return { snapshots: [], source: 'unavailable' }
  }
  const outcome = await withTimeout(Promise.resolve().then(() => persistence.list({ signal })), SUMMARIES_TIMEOUT_MS)
  if (outcome.timedOut) {
    trace(requestId, 'persisted', `timeout>${SUMMARIES_TIMEOUT_MS}ms`)
    return { snapshots: [], source: 'timeout' }
  }
  if (outcome.error) {
    trace(requestId, 'persisted', `error ${describeError(outcome.error)}`)
    return { snapshots: [], source: 'error' }
  }
  const snapshots = Array.isArray(outcome.value) ? outcome.value : []
  trace(requestId, 'persisted', `ok items=${snapshots.length}`)
  return { snapshots, source: 'persistence' }
}

/**
 * Assemble the session-library snapshot.
 *
 * The durable store is authoritative: a session moved to the recycle bin
 * disappears from the page even while the Host still holds it in memory. The
 * live summaries only contribute activity time, running state, blank state and
 * projection titles.
 *
 * @param {object} ctx Cordis context.
 * @param {AbortSignal} signal request cancellation.
 * @param {string} requestId trace identity.
 * @returns {Promise<object>} snapshot payload.
 */
async function buildSnapshot(ctx, signal, requestId) {
  const workspace = await readWorkspaceBaseline(ctx, requestId)
  const persisted = await readPersistedSessions(ctx, signal, requestId)
  const summaryResult = await readSummaries(ctx, signal, requestId)
  const baseline = workspace.baseline
  const archived = new Set(baseline.archivedSessionIds)
  const pinned = new Set(baseline.pinnedSessionIds)
  const summaryById = new Map(summaryResult.items.map((summary) => [summary.id, summary]))

  /** @type {Array<object>} */
  let sessions
  if (persisted.snapshots.length > 0 || persisted.source === 'persistence') {
    sessions = persisted.snapshots.map((snapshot) => {
      const id = String(snapshot.header.id)
      const summary = summaryById.get(id)
      return {
        id,
        title: summary ? summary.title : null,
        updatedAt: summary && summary.updatedAt ? summary.updatedAt : snapshot.header.createdAt,
        blank: summary ? summary.blank : false,
        running: summary ? summary.running : false,
        ...(snapshot.header.origin === 'subagent' ? { origin: 'subagent' } : {}),
        ...(typeof snapshot.header.cwd === 'string' ? { cwd: snapshot.header.cwd } : {}),
        ...(snapshot.formatStatus ? { formatStatus: snapshot.formatStatus } : {}),
      }
    })
  } else {
    // Persistence unavailable: fall back to the live summaries.
    sessions = summaryResult.items.map((summary) => ({ ...summary }))
  }

  // Sessions whose deletion is deferred until the next start stay hidden.
  const pendingIds = new Set(Object.keys(readPendingTrash()))
  if (pendingIds.size > 0) sessions = sessions.filter((session) => !pendingIds.has(session.id))

  // Titles for migration-required sessions would force a format migration per
  // session; the page can show the unnamed label instead of paying that on the
  // first open.
  const missingTitleIds = sessions
    .filter((session) => session.title === null
      && session.blank !== true
      && session.origin !== 'subagent'
      && session.formatStatus !== 'migration-required')
    .map((session) => session.id)
  const titleResult = await readTitles(ctx, missingTitleIds, signal, requestId)
  for (const session of sessions) {
    if (session.title === null) session.title = titleResult.titles.get(session.id) ?? null
  }
  // Feed the delete preflight: a page snapshot already paid for these reads.
  for (const session of sessions) rememberTitle(session.id, session.title)

  /**
   * Decorate one session for the Client.
   *
   * @param {object} session normalized session.
   * @returns {object} decorated session.
   */
  const decorate = (session) => ({
    id: session.id,
    title: session.title,
    updatedAt: session.updatedAt,
    archived: archived.has(session.id),
    pinned: pinned.has(session.id),
    blank: session.blank,
    running: session.running,
    ...(session.origin ? { origin: session.origin } : {}),
    ...(session.cwd ? { cwd: session.cwd } : {}),
    ...(session.formatStatus ? { formatStatus: session.formatStatus } : {}),
  })

  const accounted = new Set()
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const workspaces = []
  for (const workspaceItem of baseline.items) {
    const workspaceSessions = []
    for (const sessionId of workspaceItem.sessionIds) {
      const session = byId.get(sessionId)
      if (!session) continue
      accounted.add(sessionId)
      workspaceSessions.push(decorate(session))
    }
    workspaces.push({
      kind: 'workspace',
      id: workspaceItem.workspaceId,
      title: workspaceItem.title,
      path: workspaceItem.path,
      sessions: workspaceSessions,
    })
  }

  const ungrouped = sessions
    .filter((session) => !accounted.has(session.id) && session.origin !== 'subagent')
    .map(decorate)

  return {
    workspaces,
    ungrouped: { kind: 'ungrouped', id: '__ungrouped__', title: '未分组', sessions: ungrouped },
    counts: {
      total: sessions.length,
      archived: sessions.filter((session) => archived.has(session.id)).length,
      subagent: sessions.filter((session) => session.origin === 'subagent').length,
      blank: sessions.filter((session) => session.blank).length,
    },
    sources: {
      workspaces: workspace.source,
      summaries: summaryResult.source,
      sessions: persisted.source,
      titles: titleResult.source,
    },
    fetchedAt: Date.now(),
    bootAt: BOOT_AT,
  }
}

/**
 * Run one snapshot request with tracing.
 *
 * @param {object} ctx Cordis context.
 * @param {AbortSignal} signal request cancellation.
 * @returns {Promise<object>} snapshot payload.
 */
async function runSnapshot(ctx, signal) {
  const requestId = `req-${Date.now().toString(36)}`
  trace(requestId, 'start', '')
  try {
    const snapshot = await buildSnapshot(ctx, signal, requestId)
    trace(
      requestId,
      'end',
      `ok workspaces=${snapshot.workspaces.length} sessions=${snapshot.counts.total} ` +
        `archived=${snapshot.counts.archived} sources=${JSON.stringify(snapshot.sources)}`,
    )
    writeSnapshotFile(snapshot)
    return snapshot
  } catch (error) {
    trace(requestId, 'end', `throw ${describeError(error)}`)
    throw error
  }
}

/* ───────────────────────── recycle bin ───────────────────────── */

/**
 * Read a JSON request body without throwing.
 *
 * @param {Request} request inbound request.
 * @returns {Promise<object>} the parsed object or an empty object.
 */
async function readJsonBody(request) {
  try {
    const value = await request.json()
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

/**
 * Normalize a session-id list and report how much of it the batch accepts.
 *
 * @param {any} value raw value.
 * @returns {{ ids: string[], requested: number }} accepted ids and requested unique count.
 */
function normalizeIdList(value) {
  if (!Array.isArray(value)) return { ids: [], requested: 0 }
  const unique = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const id = item.trim()
    if (id === '' || id.includes('/') || id.includes('\\') || id.includes('..')) continue
    if (!unique.includes(id)) unique.push(id)
  }
  return { ids: unique.slice(0, DELETE_BATCH_LIMIT), requested: unique.length }
}

/**
 * Normalize a session-id list from a request body.
 *
 * @param {any} value raw value.
 * @returns {string[]} unique safe ids.
 */
function normalizeIds(value) {
  return normalizeIdList(value).ids
}

/**
 * Locate one session's on-disk directory without assuming the id escaping
 * rule: the directory name equals the session id for every shipped id shape.
 *
 * @param {string} sessionId session id.
 * @returns {string | undefined} absolute session directory.
 */
function findSessionDir(sessionId) {
  if (!existsSync(SESSIONS_ROOT)) return undefined
  let projects = []
  try {
    projects = readdirSync(SESSIONS_ROOT, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const candidate = join(SESSIONS_ROOT, project.name, sessionId)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Sum the bytes under one directory.
 *
 * @param {string} target absolute directory.
 * @returns {number} total bytes.
 */
function dirSize(target) {
  let total = 0
  const stack = [target]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries = []
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const child = join(current, entry.name)
      if (entry.isDirectory()) stack.push(child)
      else {
        try {
          total += statSync(child).size
        } catch {
          // A vanished file simply contributes nothing.
        }
      }
    }
  }
  return total
}

// --- Export archive support -------------------------------------------------
// Session logs are already compressed, so a stored (uncompressed) ZIP keeps the
// archive lossless without pulling in a codec.

let crc32Table = null

/**
 * Build the CRC-32 lookup table once.
 *
 * @returns {Uint32Array} the table.
 */
function getCrc32Table() {
  if (crc32Table) return crc32Table
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? (0xedb88320 ^ (value >>> 1)) : value >>> 1
    }
    table[index] = value >>> 0
  }
  crc32Table = table
  return table
}

/**
 * Compute one buffer's CRC-32 checksum.
 *
 * @param {Buffer} buffer input bytes.
 * @returns {number} the checksum.
 */
function crc32(buffer) {
  const table = getCrc32Table()
  let value = 0xffffffff
  for (let index = 0; index < buffer.length; index += 1) {
    value = table[(value ^ buffer[index]) & 0xff] ^ (value >>> 8)
  }
  return (value ^ 0xffffffff) >>> 0
}

/**
 * Encode a timestamp as ZIP MS-DOS time and date fields.
 *
 * @param {Date} date timestamp.
 * @returns {{ time: number, date: number }} encoded fields.
 */
function dosDateTime(date) {
  const time = ((date.getHours() & 0x1f) << 11)
    | ((date.getMinutes() & 0x3f) << 5)
    | (Math.floor(date.getSeconds() / 2) & 0x1f)
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9)
    | (((date.getMonth() + 1) & 0xf) << 5)
    | (date.getDate() & 0x1f)
  return { time, date: day }
}

/**
 * Build one stored (uncompressed) ZIP archive.
 *
 * @param {Array<{ name: string, data: Buffer }>} entries archive members.
 * @returns {Buffer} the archive bytes.
 */
function buildStoredZip(entries) {
  if (entries.length > 65535) throw new Error('导出条目过多，请分批导出')
  const locals = []
  const centrals = []
  const { time: dosTime, date: dosDate } = dosDateTime(new Date())
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = entry.data
    const checksum = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(dosTime, 10)
    local.writeUInt16LE(dosDate, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(dosTime, 12)
    central.writeUInt16LE(dosDate, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += local.length + name.length + data.length
  }
  const centralSize = centrals.reduce((sum, buffer) => sum + buffer.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, ...centrals, end])
}

/**
 * Read every file under one directory into archive entries.
 *
 * @param {string} root absolute directory.
 * @param {string} prefix archive path prefix without a trailing slash.
 * @param {Array<{ name: string, data: Buffer }>} entries destination.
 * @param {number} budget remaining byte budget for this session.
 * @returns {number} bytes read.
 */
function collectDirectoryEntries(root, prefix, entries, budget) {
  let used = 0
  const stack = [{ dir: root, rel: '' }]
  while (stack.length > 0) {
    const current = stack.pop()
    let children = []
    try {
      children = readdirSync(current.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const child of children) {
      const absolute = join(current.dir, child.name)
      const relative = current.rel === '' ? child.name : `${current.rel}/${child.name}`
      if (child.isDirectory()) {
        stack.push({ dir: absolute, rel: relative })
        continue
      }
      const data = readFileSync(absolute)
      used += data.length
      if (used > budget) throw new Error('导出包超过体积上限（512 MB），请分批导出')
      entries.push({ name: `${prefix}/${relative}`, data })
    }
  }
  return used
}

// --- Import archive support --------------------------------------------------

/**
 * Split one archive entry name into safe path segments.
 *
 * @param {string} name archive entry name.
 * @returns {string[] | null} segments, or null when the name escapes the root.
 */
function safeZipSegments(name) {
  if (typeof name !== 'string' || name === '') return null
  const normalized = name.replace(/\\/g, '/')
  if (normalized.startsWith('/')) return null
  const segments = normalized.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null
  return segments
}

/**
 * Read every member of a ZIP archive.
 *
 * Stored and deflated members are supported; ZIP64 is rejected with a clear
 * message because these packages are small enough to stay in memory.
 *
 * @param {Buffer} buffer archive bytes.
 * @returns {Array<{ name: string, data: Buffer }>} members in directory order.
 */
function readZipEntries(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new Error('不是有效的 ZIP 文件')
  const searchStart = Math.max(0, buffer.length - 65557)
  let eocd = -1
  for (let offset = buffer.length - 22; offset >= searchStart; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件（找不到目录尾部）')
  const count = buffer.readUInt16LE(eocd + 10)
  const centralSize = buffer.readUInt32LE(eocd + 12)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error('暂不支持 ZIP64 格式的包')
  }
  if (count > IMPORT_ENTRY_LIMIT) throw new Error(`包内文件过多（${count} 个）`)
  if (centralOffset + centralSize > buffer.length) throw new Error('ZIP 目录损坏')

  const entries = []
  let cursor = centralOffset
  let unpacked = 0
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('ZIP 目录损坏')
    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const entryName = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    cursor += 46 + nameLength + extraLength + commentLength
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error('暂不支持 ZIP64 格式的包')
    }
    unpacked += uncompressedSize
    if (unpacked > IMPORT_UNPACKED_BYTES_LIMIT) throw new Error('包解压后体积超过上限')
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('ZIP 本地文件头损坏')
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    if (dataStart + compressedSize > buffer.length) throw new Error('ZIP 数据越界')
    const raw = buffer.subarray(dataStart, dataStart + compressedSize)
    let data
    if (method === 0) data = raw
    else if (method === 8) data = inflateRawSync(raw)
    else throw new Error(`不支持的 ZIP 压缩方式：${method}`)
    entries.push({ name: entryName, data })
  }
  return entries
}

/**
 * Load and validate one exported package.
 *
 * @param {any} rawPath archive path chosen by the user.
 * @returns {{ zipPath: string, fileName: string, manifest: object, entries: Array<object> }} package data.
 */
function loadImportPackage(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') throw new Error('请填写会话包路径')
  const zipPath = resolve(rawPath.trim())
  let stats = null
  try {
    stats = statSync(zipPath)
  } catch {
    throw new Error(`找不到会话包：${zipPath}`)
  }
  if (!stats.isFile()) throw new Error(`不是文件：${zipPath}`)
  if (stats.size > IMPORT_ZIP_BYTES_LIMIT) throw new Error('会话包体积超过上限')
  const entries = readZipEntries(readFileSync(zipPath))
  const manifestEntry = entries.find((entry) => entry.name === 'manifest.json')
  if (!manifestEntry) throw new Error('包内缺少 manifest.json，不是本插件导出的会话包')
  let manifest = null
  try {
    manifest = JSON.parse(manifestEntry.data.toString('utf8'))
  } catch {
    throw new Error('manifest.json 无法解析')
  }
  if (!manifest || manifest.format !== 'dsh-sessions-library-export') {
    throw new Error('不是本插件导出的会话包（manifest.format 不匹配）')
  }
  const version = Number(manifest.version)
  if (!Number.isFinite(version) || version < 1) throw new Error('会话包缺少有效的版本号')
  if (version > 1) throw new Error(`不支持的会话包版本：${manifest.version}`)
  const sessions = Array.isArray(manifest.sessions)
    ? manifest.sessions.filter((session) => session && typeof session.id === 'string' && session.id !== '')
    : []
  if (sessions.length === 0) throw new Error('包内没有可导入的会话')
  return {
    zipPath,
    fileName: basename(zipPath),
    manifest: {
      ...manifest,
      workspaces: Array.isArray(manifest.workspaces) ? manifest.workspaces : [],
      sessions,
    },
    entries,
  }
}

/**
 * Group archive members by the session directory they belong to.
 *
 * @param {Array<{ name: string, data: Buffer }>} entries archive members.
 * @returns {{ bySession: Map<string, Array<object>>, unknown: string[] }} grouped members and ignored names.
 */
function indexPackageEntries(entries) {
  const bySession = new Map()
  const unknown = []
  for (const entry of entries) {
    const segments = safeZipSegments(entry.name)
    if (!segments) {
      unknown.push(entry.name)
      continue
    }
    if (segments.length === 1 && segments[0] === 'manifest.json') continue
    if (segments[0] !== 'sessions' || segments.length < 3) {
      unknown.push(entry.name)
      continue
    }
    const sessionId = segments[1]
    if (!bySession.has(sessionId)) bySession.set(sessionId, [])
    bySession.get(sessionId).push({ segments: segments.slice(2), data: entry.data })
  }
  return { bySession, unknown }
}

/**
 * Keep a package's project directory name usable as one path segment.
 *
 * @param {any} value manifest value.
 * @returns {string} a safe directory name.
 */
function safeProjectDirName(value) {
  if (typeof value !== 'string' || value === '') return '_no-cwd'
  if (value.includes('/') || value.includes('\\') || value.includes('..')) return '_no-cwd'
  return value
}

/**
 * Build the readable project directory key for one cwd, matching the storage
 * backend's convention so DSH groups the imported session under that folder.
 *
 * @param {string} cwd project directory.
 * @returns {string} one safe path segment.
 */
function projectKey(cwd) {
  if (typeof cwd !== 'string' || cwd === '') throw new Error('会话工作目录为空')
  let readable = ''
  let separatorRun = false
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  const trimmed = readable.replace(/^-+/, '') || 'root'
  return `--${trimmed.slice(0, 251)}--`
}

/**
 * Measure one zstd frame at the start of a buffer.
 *
 * @param {Buffer} buffer file bytes starting at a frame magic.
 * @returns {number} frame length in bytes.
 */
function firstZstdFrameLength(buffer) {
  if (buffer.length < 6 || buffer.readUInt32LE(0) !== 0xfd2fb528) {
    throw new Error('会话日志不是 zstd 格式，无法改写工作目录')
  }
  const descriptor = buffer[4]
  const fcsFlag = descriptor >> 6
  const singleSegment = (descriptor & 0x20) !== 0
  const checksum = (descriptor & 0x04) !== 0
  const dictionaryFlag = descriptor & 0x03
  let offset = 5
  if (!singleSegment) offset += 1
  offset += dictionaryFlag === 0 ? 0 : dictionaryFlag === 1 ? 1 : dictionaryFlag === 2 ? 2 : 4
  offset += fcsFlag === 0 ? (singleSegment ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8
  for (let blocks = 0; blocks < 1000000; blocks += 1) {
    if (offset + 3 > buffer.length) throw new Error('会话日志帧头损坏')
    const blockHeader = buffer.readUIntLE(offset, 3)
    offset += 3
    const isLast = (blockHeader & 1) === 1
    const blockType = (blockHeader >> 1) & 3
    const blockSize = blockHeader >> 3
    offset += blockType === 1 ? 1 : blockSize
    if (offset > buffer.length) throw new Error('会话日志帧数据越界')
    if (isLast) break
  }
  if (checksum) offset += 4
  if (offset > buffer.length) throw new Error('会话日志帧校验越界')
  return offset
}

/**
 * Locate the stored log file inside one session directory.
 *
 * @param {string} sessionDir session directory.
 * @returns {string | undefined} log path.
 */
function findSessionLogFile(sessionDir) {
  let children = []
  try {
    children = readdirSync(sessionDir, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const child of children) {
    if (child.isFile() && child.name.endsWith('.jsonl.zstd')) return join(sessionDir, child.name)
  }
  for (const child of children) {
    if (child.isFile() && child.name.startsWith('session.')) return join(sessionDir, child.name)
  }
  return undefined
}

/**
 * Read the cwd one stored session records in its header.
 *
 * Only the first zstd frame is decoded: that frame carries the session header,
 * and the event frames after it are never touched.
 *
 * @param {string} sessionDir session directory.
 * @returns {string | null} recorded cwd, or null when it cannot be read.
 */
function readSessionHeaderCwd(sessionDir) {
  const logFile = findSessionLogFile(sessionDir)
  if (logFile === undefined) return null
  try {
    const buffer = readFileSync(logFile)
    const frameLength = firstZstdFrameLength(buffer)
    const frameText = zstdDecompressSync(buffer.subarray(0, frameLength)).toString('utf8')
    const line = frameText.split('\n').find((candidate) => candidate.trim() !== '')
    if (line === undefined) return null
    const header = JSON.parse(line)
    return typeof header.cwd === 'string' && header.cwd !== '' ? header.cwd : null
  } catch {
    return null
  }
}

/**
 * Rewrite the stored session header's cwd so the session can belong to a
 * workspace whose directory differs from the source machine's path.
 *
 * Only the first zstd frame is re-encoded; every following frame is preserved
 * byte for byte, so the event history is untouched.
 *
 * @param {string} filePath stored session log path.
 * @param {string} targetCwd workspace directory to record.
 * @returns {boolean} whether the header changed.
 */
function rewriteSessionHeaderCwd(filePath, targetCwd) {
  const buffer = readFileSync(filePath)
  const frameLength = firstZstdFrameLength(buffer)
  const frameText = zstdDecompressSync(buffer.subarray(0, frameLength)).toString('utf8')
  const lines = frameText.split('\n')
  const index = lines.findIndex((line) => line.trim() !== '')
  if (index < 0) throw new Error('会话日志首帧为空，无法改写工作目录')
  let header = null
  try {
    header = JSON.parse(lines[index])
  } catch {
    header = null
  }
  if (!header || header.type !== 'session' || typeof header.id !== 'string') {
    throw new Error('会话日志首行不是会话头，无法改写工作目录')
  }
  if (header.cwd === targetCwd) return false
  header.cwd = targetCwd
  lines[index] = JSON.stringify(header)
  const nextFrame = zstdCompressSync(Buffer.from(lines.join('\n'), 'utf8'))
  writeFileSync(filePath, Buffer.concat([nextFrame, buffer.subarray(frameLength)]))
  return true
}

/**
 * Read exactly `length` bytes at `position` from an open file.
 *
 * @param {number} fd open file descriptor.
 * @param {number} position byte offset.
 * @param {number} length bytes to read.
 * @returns {Buffer} the bytes actually read.
 */
function readFileRange(fd, position, length) {
  const buffer = Buffer.alloc(length)
  let read = 0
  while (read < length) {
    const chunk = readSync(fd, buffer, read, length - read, position + read)
    if (chunk <= 0) break
    read += chunk
  }
  return buffer.subarray(0, read)
}

/**
 * Read one archive's member directory without touching member data.
 *
 * @param {number} fd open file descriptor.
 * @param {number} size archive size in bytes.
 * @returns {Array<object>} member descriptors.
 */
function readZipDirectoryFromFile(fd, size) {
  const tailLength = Math.min(size, 65557)
  const tail = readFileRange(fd, size - tailLength, tailLength)
  let eocd = -1
  for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件')
  const count = tail.readUInt16LE(eocd + 10)
  const centralSize = tail.readUInt32LE(eocd + 12)
  const centralOffset = tail.readUInt32LE(eocd + 16)
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error('暂不支持 ZIP64 格式的包')
  }
  if (count > IMPORT_ENTRY_LIMIT) throw new Error(`包内文件过多（${count} 个）`)
  if (centralOffset + centralSize > size) throw new Error('ZIP 目录损坏')
  const central = readFileRange(fd, centralOffset, centralSize)
  const entries = []
  let cursor = 0
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('ZIP 目录损坏')
    }
    const method = central.readUInt16LE(cursor + 10)
    const compressedSize = central.readUInt32LE(cursor + 20)
    const uncompressedSize = central.readUInt32LE(cursor + 24)
    const nameLength = central.readUInt16LE(cursor + 28)
    const extraLength = central.readUInt16LE(cursor + 30)
    const commentLength = central.readUInt16LE(cursor + 32)
    const localOffset = central.readUInt32LE(cursor + 42)
    const name = central.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    cursor += 46 + nameLength + extraLength + commentLength
    entries.push({ name, method, compressedSize, uncompressedSize, localOffset })
  }
  return entries
}

/**
 * Read one member's data given its directory descriptor.
 *
 * @param {number} fd open file descriptor.
 * @param {object} entry member descriptor.
 * @returns {Buffer} member data.
 */
function readZipMemberFromFile(fd, entry) {
  if (entry.compressedSize === 0xffffffff || entry.localOffset === 0xffffffff) {
    throw new Error('暂不支持 ZIP64 格式的包')
  }
  const local = readFileRange(fd, entry.localOffset, 30)
  if (local.length < 30 || local.readUInt32LE(0) !== 0x04034b50) throw new Error('ZIP 本地文件头损坏')
  const nameLength = local.readUInt16LE(26)
  const extraLength = local.readUInt16LE(28)
  const dataStart = entry.localOffset + 30 + nameLength + extraLength
  const raw = readFileRange(fd, dataStart, entry.compressedSize)
  if (entry.method === 0) return raw
  if (entry.method === 8) return inflateRawSync(raw)
  throw new Error(`不支持的 ZIP 压缩方式：${entry.method}`)
}

/**
 * Peek one candidate archive's manifest to tell whether it is a session package.
 *
 * Only the archive directory and the small manifest member are read, so listing
 * a folder full of unrelated zips stays cheap.
 *
 * @param {string} zipPath candidate path.
 * @returns {{ valid: boolean, reason?: string, sessionCount?: number, workspaceCount?: number, exportedAt?: string | null }} package metadata.
 */
function peekPackageMeta(zipPath) {
  let fd = null
  try {
    const stats = statSync(zipPath)
    if (stats.size > IMPORT_ZIP_BYTES_LIMIT) return { valid: false, reason: '体积超过上限' }
    fd = openSync(zipPath, 'r')
    const entries = readZipDirectoryFromFile(fd, stats.size)
    const manifestEntry = entries.find((entry) => entry.name === 'manifest.json')
    if (!manifestEntry) return { valid: false, reason: '缺少 manifest.json' }
    if (manifestEntry.uncompressedSize > 4 * 1024 * 1024) return { valid: false, reason: 'manifest 过大' }
    const data = readZipMemberFromFile(fd, manifestEntry)
    let manifest = null
    try {
      manifest = JSON.parse(data.toString('utf8'))
    } catch {
      manifest = null
    }
    if (!manifest || manifest.format !== 'dsh-sessions-library-export') {
      return { valid: false, reason: '不是本插件的会话包' }
    }
    const version = Number(manifest.version)
    if (!Number.isFinite(version) || version < 1 || version > 1) {
      return { valid: false, reason: `不支持的包版本：${manifest.version}` }
    }
    return {
      valid: true,
      sessionCount: Array.isArray(manifest.sessions) ? manifest.sessions.length : 0,
      workspaceCount: Array.isArray(manifest.workspaces) ? manifest.workspaces.length : 0,
      exportedAt: typeof manifest.exportedAt === 'string' ? manifest.exportedAt : null,
    }
  } catch (error) {
    return { valid: false, reason: describeError(error) }
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // The descriptor closes with the process either way.
      }
    }
  }
}

/**
 * List session packages available in one folder, newest first.
 *
 * Candidates are validated by peeking their manifest, so unrelated archives do
 * not masquerade as importable packages.
 *
 * @param {any} rawDir folder to scan; empty means the default export folder.
 * @returns {{ dir: string, files: Array<object>, ignored: Array<object> }} folder, packages and rejected archives.
 */
function listImportCandidates(rawDir) {
  const dir = typeof rawDir === 'string' && rawDir.trim() !== '' ? resolve(rawDir.trim()) : EXPORT_DIR
  let children = []
  try {
    children = readdirSync(dir, { withFileTypes: true })
  } catch {
    return { dir, files: [], ignored: [] }
  }
  const files = []
  const ignored = []
  for (const child of children) {
    if (!child.isFile() || !child.name.toLowerCase().endsWith('.zip')) continue
    const full = join(dir, child.name)
    let size = 0
    let modifiedAt = 0
    try {
      const stats = statSync(full)
      size = stats.size
      modifiedAt = stats.mtimeMs
    } catch {
      // A vanished file simply disappears from the list.
    }
    const meta = peekPackageMeta(full)
    if (!meta.valid) {
      ignored.push({ name: child.name, reason: meta.reason || '无法识别' })
      continue
    }
    files.push({
      path: full,
      name: child.name,
      size,
      modifiedAt,
      sessionCount: meta.sessionCount || 0,
      workspaceCount: meta.workspaceCount || 0,
      exportedAt: meta.exportedAt || null,
    })
  }
  files.sort((left, right) => right.modifiedAt - left.modifiedAt)
  return {
    dir,
    files: files.slice(0, 200),
    ignored: ignored.slice(0, 50),
  }
}

/**
 * Inspect one package without writing anything.
 *
 * @param {object} ctx Cordis context.
 * @param {any} rawPath package path.
 * @returns {Promise<object>} preflight report for the Client.
 */
async function inspectImport(ctx, rawPath) {
  const pkg = loadImportPackage(rawPath)
  const { manifest, entries } = pkg
  const { bySession, unknown } = indexPackageEntries(entries)

  const registry = ctx.get('workspaceRegistry')
  const localWorkspaces = registry && typeof registry.list === 'function'
    ? registry.list().map((workspace) => ({
        workspaceId: String(workspace.id),
        path: typeof workspace.path === 'string' ? workspace.path : '',
        title: typeof workspace.title === 'string' ? workspace.title : '',
      }))
    : []
  const localByPath = new Map(
    localWorkspaces
      .filter((workspace) => workspace.path !== '')
      .map((workspace) => [workspace.path.toLowerCase(), workspace.workspaceId]),
  )
  const pending = readPendingTrash()
  // Archived sessions hide from both the Native sidebar and the library's
  // default view, so a local duplicate in that state is adoptable instead of a
  // blocking conflict.
  const baseline = await readWorkspaceBaseline(ctx, 'import-inspect')
  const archivedLocal = new Set(baseline.baseline.archivedSessionIds)
  const packageIds = new Set(manifest.sessions.map((session) => session.id))
  const sessions = []
  let conflicts = 0
  let adoptable = 0
  for (const session of manifest.sessions) {
    const files = bySession.get(session.id) ?? []
    const pendingHere = pending[session.id] !== undefined
    const localDir = findSessionDir(session.id)
    let conflict = null
    if (files.length === 0) conflict = 'missing'
    else if (pendingHere) conflict = 'pending'
    else if (localDir !== undefined) conflict = archivedLocal.has(session.id) ? 'archived' : 'exists'
    if (conflict !== null && conflict !== 'archived') conflicts += 1
    if (conflict === 'archived') adoptable += 1
    const parentSession = typeof session.parentSession === 'string' ? session.parentSession : null
    const missingParent = parentSession !== null && parentSession !== ''
      && !packageIds.has(parentSession)
      && findSessionDir(parentSession) === undefined
    sessions.push({
      id: session.id,
      title: typeof session.title === 'string' ? session.title : null,
      role: typeof session.role === 'string' ? session.role : 'root',
      parentSession,
      cwd: typeof session.cwd === 'string' ? session.cwd : null,
      archived: session.archived === true,
      pinned: session.pinned === true,
      workspaceIds: Array.isArray(session.workspaceIds) ? session.workspaceIds.map(String) : [],
      fileCount: files.length,
      bytes: files.reduce((sum, file) => sum + file.data.length, 0),
      conflict,
      missingParent,
    })
  }
  const workspaces = manifest.workspaces.map((workspace) => {
    const workspaceId = String(workspace.workspaceId ?? '')
    const path = typeof workspace.path === 'string' ? workspace.path : ''
    const title = typeof workspace.title === 'string' ? workspace.title : ''
    const suggested = path !== '' ? localByPath.get(path.toLowerCase()) : undefined
    return {
      workspaceId,
      path,
      title,
      sessionCount: sessions.filter((session) => session.workspaceIds.includes(workspaceId)).length,
      suggestedTargetId: suggested ?? null,
    }
  })
  const unknownWorkspaceIds = [...new Set(sessions.flatMap((session) => session.workspaceIds))]
    .filter((workspaceId) => !workspaces.some((workspace) => workspace.workspaceId === workspaceId))
  const warnings = []
  const missingParentCount = sessions.filter((session) => session.missingParent).length
  if (missingParentCount > 0) warnings.push(`${missingParentCount} 个会话的父会话不在包内，导入后可能无法继续对话`)
  if (unknown.length > 0) warnings.push(`包内有 ${unknown.length} 个无法识别的文件，将被忽略`)
  if (unknownWorkspaceIds.length > 0) warnings.push(`${unknownWorkspaceIds.length} 个源工作区没有元数据，相关会话将放入未分组`)
  if (adoptable > 0) {
    warnings.push(`${adoptable} 个会话在本地已存在且处于归档状态：导入会取消归档，并尽量归入所选目标工作区`)
  }

  return {
    path: pkg.zipPath,
    fileName: pkg.fileName,
    exportedAt: typeof manifest.exportedAt === 'string' ? manifest.exportedAt : null,
    sourceDshHome: manifest.source && typeof manifest.source.dshHome === 'string'
      ? manifest.source.dshHome
      : null,
    sessions,
    workspaces,
    localWorkspaces,
    unknownEntries: unknown.slice(0, 20),
    warnings,
    counts: {
      sessions: sessions.length,
      conflicts,
      adoptable,
      importable: sessions.length - conflicts,
      workspaces: workspaces.length,
    },
  }
}

/**
 * Adopt the local copy of a package session instead of importing a duplicate.
 *
 * A session that already exists locally is normally skipped. When that copy is
 * archived, importing would leave it invisible in both the Native sidebar and
 * the library's default view, so adoption un-archives it and, when the user
 * mapped its source workspace to a local one, re-homes it into that workspace
 * directory (header cwd rewrite only; the event frames stay byte-identical).
 *
 * @param {object} options adoption inputs.
 * @param {string} options.id session id.
 * @param {string | null} options.title session title.
 * @param {string} options.role session role.
 * @param {string} options.localDir existing session directory.
 * @param {string[]} options.targetWorkspaceIds mapped local workspace ids.
 * @param {string | null} options.targetCwd mapped workspace directory; null keeps the copy in place.
 * @param {object | undefined} options.registry workspace registry service.
 * @returns {Promise<object>} per-session result.
 */
async function adoptLocalSession(options) {
  const { id, title, role, localDir, targetWorkspaceIds, targetCwd, registry } = options
  const localCwd = readSessionHeaderCwd(localDir)
  const warnings = []
  let moved = false
  let rewritten = false
  const attached = []

  // Un-archive first: adoption exists to make the session visible again, and
  // nothing below may leave it hidden when it fails.
  if (!registry || typeof registry.unarchiveSession !== 'function') {
    return { id, title, role, status: 'failed', reason: '工作区服务不可用，无法取消归档' }
  }
  try {
    await registry.unarchiveSession(id)
  } catch (error) {
    return { id, title, role, status: 'failed', reason: `取消归档失败：${describeError(error)}` }
  }

  const targetPath = typeof targetCwd === 'string' && targetCwd !== '' ? targetCwd : null
  // Moving the directory without rewriting the header would leave the store
  // unable to find the session again, so an unreadable header stays in place.
  if (targetPath !== null && localCwd === null) {
    warnings.push('无法读取会话日志头，未迁移目录')
  } else if (targetPath !== null) {
    const projectDir = join(SESSIONS_ROOT, projectKey(targetPath))
    const targetDir = join(projectDir, id)
    const inPlace = resolve(targetDir).toLowerCase() === resolve(localDir).toLowerCase()
    let activeDir = localDir
    if (!inPlace) {
      try {
        if (existsSync(targetDir)) throw new Error('目标工作区目录已存在同 id 会话')
        mkdirSync(projectDir, { recursive: true })
        // A live Agent keeps its log open, so Windows refuses the move and the
        // session simply stays in its current directory.
        renameSync(localDir, targetDir)
        activeDir = targetDir
        moved = true
      } catch (error) {
        warnings.push(`目录未迁移：${describeError(error)}`)
      }
    }
    // The store derives the project directory from the header cwd, so the two
    // may only disagree when the move succeeded or was unnecessary.
    if (moved || inPlace) {
      const logFile = findSessionLogFile(activeDir)
      if (logFile === undefined) {
        warnings.push('找不到会话日志，工作目录未改写')
      } else {
        try {
          rewritten = rewriteSessionHeaderCwd(logFile, targetPath)
        } catch (error) {
          warnings.push(`工作目录未改写：${describeError(error)}`)
        }
      }
      if (registry && typeof registry.get === 'function') {
        // Moving the log means the previous membership no longer describes it.
        try {
          await detachFromWorkspaces(registry, id)
        } catch {
          // Accounting cleanup is best effort.
        }
        for (const workspaceId of targetWorkspaceIds) {
          try {
            const workspace = registry.get(workspaceId)
            if (workspace && typeof workspace.attachSession === 'function') {
              await workspace.attachSession(id)
              attached.push(workspaceId)
            }
          } catch {
            // Membership is best effort; the session is already visible.
          }
        }
      }
    }
  }

  titleCache.delete(id)
  appendOperation({ action: 'adopt', sessionId: id, title, role })
  trace('import', 'adopted', `id=${id} moved=${moved} rewritten=${rewritten} attached=${attached.length}`)
  return {
    id,
    title,
    role,
    status: 'adopted',
    workspaceIds: attached,
    moved,
    rewritten,
    cwd: targetPath !== null ? targetPath : localCwd,
    warning: warnings.length > 0 ? warnings.join('；') : null,
  }
}

/**
 * Write one inspected package into the session store.
 *
 * Existing session ids are skipped (never overwritten), and workspace
 * membership follows the mapping the user chose per source workspace.
 *
 * @param {object} ctx Cordis context.
 * @param {any} rawPath package path.
 * @param {any} rawMapping source workspace id to local workspace id (or null).
 * @returns {Promise<object>} per-session results and counters.
 */
async function importPackage(ctx, rawPath, rawMapping) {
  const pkg = loadImportPackage(rawPath)
  const { manifest, entries } = pkg
  const { bySession } = indexPackageEntries(entries)
  const mapping = rawMapping && typeof rawMapping === 'object' && !Array.isArray(rawMapping)
    ? rawMapping
    : {}
  const registry = ctx.get('workspaceRegistry')
  const pending = readPendingTrash()
  const workspacePathById = new Map()
  if (registry && typeof registry.list === 'function') {
    try {
      for (const workspace of registry.list()) {
        workspacePathById.set(
          String(workspace.id),
          typeof workspace.path === 'string' ? workspace.path : '',
        )
      }
    } catch {
      // Unknown paths only cost the cwd rewrite and workspace membership.
    }
  }
  const results = []
  let imported = 0
  let adopted = 0
  let skipped = 0
  let failed = 0
  const baseline = await readWorkspaceBaseline(ctx, 'import-run')
  const archivedLocal = new Set(baseline.baseline.archivedSessionIds)

  for (const session of manifest.sessions) {
    const id = session.id
    const files = bySession.get(id) ?? []
    const title = typeof session.title === 'string' ? session.title : null
    const role = typeof session.role === 'string' ? session.role : 'root'
    if (files.length === 0) {
      failed += 1
      results.push({ id, title, status: 'failed', reason: '包内缺少该会话的文件' })
      continue
    }
    const targetWorkspaceIds = [...new Set(
      (Array.isArray(session.workspaceIds) ? session.workspaceIds : [])
        .map((sourceId) => mapping[String(sourceId)])
        .filter((targetId) => typeof targetId === 'string' && targetId !== ''),
    )]
    // A mapped workspace also decides where the log lives and which cwd the
    // header records: the registry only attaches sessions whose cwd equals the
    // workspace directory, so a cross-directory mapping rewrites the header.
    let targetCwd = typeof session.cwd === 'string' && session.cwd !== '' ? session.cwd : null
    let mappedCwd = null
    let rewrite = false
    if (targetWorkspaceIds.length > 0) {
      const targetPath = workspacePathById.get(targetWorkspaceIds[0])
      if (typeof targetPath === 'string' && targetPath !== '') {
        rewrite = targetCwd !== targetPath
        targetCwd = targetPath
        mappedCwd = targetPath
      }
    }
    if (pending[id] !== undefined) {
      skipped += 1
      results.push({ id, title, status: 'skipped', reason: '该会话正在待重启整理队列中' })
      continue
    }
    const localDir = findSessionDir(id)
    if (localDir !== undefined) {
      // A visible duplicate still blocks the import; an archived one is adopted
      // so the package ends up usable instead of silently staying hidden.
      if (!archivedLocal.has(id)) {
        skipped += 1
        results.push({ id, title, status: 'skipped', reason: '本地已存在同 id 会话' })
        continue
      }
      try {
        const outcome = await adoptLocalSession({
          id,
          title,
          role,
          localDir,
          targetWorkspaceIds,
          // Only a mapped workspace re-homes the local copy: the package's own
          // recorded cwd belongs to the source machine and may not exist here.
          targetCwd: mappedCwd,
          registry,
        })
        if (outcome.status === 'adopted') adopted += 1
        else failed += 1
        results.push(outcome)
      } catch (error) {
        failed += 1
        results.push({ id, title, status: 'failed', reason: describeError(error) })
      }
      continue
    }
    // The storage backend derives the project directory from the header cwd, so
    // the package's recorded directory name is only a fallback for sessions that
    // carry no cwd at all.
    const projectDirName = targetCwd !== null
      ? projectKey(targetCwd)
      : safeProjectDirName(session.projectDirName)
    const projectDir = join(SESSIONS_ROOT, projectDirName)
    const sessionDir = join(projectDir, id)
    let createdSessionDir = false
    try {
      if (existsSync(sessionDir)) {
        skipped += 1
        results.push({ id, title, status: 'skipped', reason: '目标目录已存在' })
        continue
      }
      mkdirSync(sessionDir, { recursive: true })
      createdSessionDir = true
      const rootResolved = resolve(sessionDir)
      for (const file of files) {
        const target = resolve(join(sessionDir, ...file.segments))
        if (!target.startsWith(rootResolved + sep)) throw new Error('包内文件路径越界')
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, file.data)
      }
      if (rewrite) {
        const logFile = findSessionLogFile(sessionDir)
        if (logFile === undefined) throw new Error('包内没有可改写的会话日志')
        rewriteSessionHeaderCwd(logFile, targetCwd)
      }

      const attached = []
      for (const workspaceId of targetWorkspaceIds) {
        try {
          const workspace = registry && typeof registry.get === 'function' ? registry.get(workspaceId) : undefined
          if (workspace && typeof workspace.attachSession === 'function') {
            await workspace.attachSession(id)
            attached.push(workspaceId)
          }
        } catch {
          // Membership is best effort; the session still imports.
        }
      }
      // An imported session must never stay archived: an archived session is
      // hidden from the Native sidebar and from the library's default view, so
      // the user would see a successful import with nothing to show for it.
      if (session.pinned === true) {
        try {
          if (registry && typeof registry.pinSession === 'function') await registry.pinSession(id)
        } catch {
          // Pin state is cosmetic.
        }
      }
      titleCache.delete(id)
      appendOperation({ action: 'import', sessionId: id, title, role })
      imported += 1
      results.push({
        id,
        title,
        status: 'imported',
        workspaceIds: attached,
        archived: false,
        unarchivedFromPackage: session.archived === true,
        rewritten: rewrite,
        cwd: targetCwd,
      })
    } catch (error) {
      failed += 1
      // A half-written session must not stay behind as a broken import.
      if (createdSessionDir) {
        try {
          rmSync(sessionDir, { recursive: true, force: true })
        } catch {
          // Leaving it is still better than masking the original failure.
        }
      }
      results.push({ id, title, status: 'failed', reason: describeError(error) })
    }
  }

  trace('import', 'end', `imported=${imported} adopted=${adopted} skipped=${skipped} failed=${failed}`)
  return { results, imported, adopted, skipped, failed, fileName: pkg.fileName }
}

/**
 * Detach a session from every workspace that accounts for it.
 *
 * @param {object | undefined} registry workspace registry service.
 * @param {string} sessionId session id.
 * @returns {Promise<string[]>} workspace ids the session was detached from.
 */
async function detachFromWorkspaces(registry, sessionId) {
  const detached = []
  if (!registry || typeof registry.list !== 'function') return detached
  let workspaces = []
  try {
    workspaces = registry.list()
  } catch {
    return detached
  }
  for (const workspace of workspaces) {
    let contains = false
    try {
      contains = [...workspace.sessionIds].map(String).includes(sessionId)
    } catch {
      contains = false
    }
    if (!contains) continue
    detached.push(String(workspace.id))
    try {
      await workspace.detachSession(sessionId)
    } catch {
      // Accounting cleanup is best effort; the header index filters the rest.
    }
  }
  return detached
}

/**
 * Collect one deletion family.
 *
 * A family is the root plus every `origin: 'subagent'` descendant (subagent and
 * Agent Teams teammate sessions). Fork children are returned separately and
 * stay in place unless `includeForks` is set, because their logs carry their
 * own copy of the inherited prefix.
 *
 * @param {string} rootId family root session id.
 * @param {Map<string, object>} byId persistence snapshots by session id.
 * @param {Map<string, string[]>} childrenByParent session id to child ids.
 * @param {boolean} includeForks whether fork children join the family.
 * @returns {{ members: Array<{ id: string, role: string }>, forks: string[] }} family members and kept forks.
 */
function collectFamily(rootId, byId, childrenByParent, includeForks) {
  const members = []
  const forks = []
  const seen = new Set([rootId])
  const queue = [{ id: rootId, role: 'root' }]
  while (queue.length > 0) {
    const current = queue.shift()
    members.push(current)
    for (const childId of childrenByParent.get(current.id) ?? []) {
      if (seen.has(childId)) continue
      seen.add(childId)
      const child = byId.get(childId)
      const isSubagent = Boolean(child && child.header.origin === 'subagent')
      if (!isSubagent && !includeForks) {
        forks.push(childId)
        continue
      }
      queue.push({ id: childId, role: isSubagent ? 'subagent' : 'fork' })
    }
  }
  return { members, forks }
}

/**
 * Build the delete preflight: one family per requested root session.
 *
 * @param {object} ctx Cordis context.
 * @param {string[]} ids requested root session ids.
 * @param {AbortSignal} signal request cancellation.
 * @param {boolean} includeForks whether fork children travel with the family.
 * @returns {Promise<Array<object>>} one family per requested root.
 */
async function buildDeletePreflight(ctx, ids, signal, includeForks) {
  const startedAt = Date.now()
  const persistence = ctx.get('sessionPersistence')
  const controller = ctx.get('sessionController')
  // Both listings are independent, so the dialog waits for the slower one
  // instead of for their sum.
  const [persistedOutcome, summaryOutcome] = await Promise.all([
    persistence && typeof persistence.list === 'function'
      ? withTimeout(Promise.resolve().then(() => persistence.list({ signal })), SUMMARIES_TIMEOUT_MS)
      : Promise.resolve({ timedOut: false, value: undefined }),
    controller && typeof controller.list === 'function'
      ? withTimeout(Promise.resolve().then(() => controller.list({}, signal)), SUMMARIES_TIMEOUT_MS)
      : Promise.resolve({ timedOut: false, value: undefined }),
  ])
  const listsMs = Date.now() - startedAt
  const snapshots = !persistedOutcome.timedOut
    && !persistedOutcome.error
    && Array.isArray(persistedOutcome.value)
    ? persistedOutcome.value
    : []

  const runningById = new Map()
  if (!summaryOutcome.timedOut
    && !summaryOutcome.error
    && summaryOutcome.value
    && Array.isArray(summaryOutcome.value.items)) {
    for (const item of summaryOutcome.value.items) runningById.set(String(item.sessionId), item.running === true)
  }

  const byId = new Map(snapshots.map((snapshot) => [String(snapshot.header.id), snapshot]))
  const childrenByParent = new Map()
  const parentById = new Map()
  for (const snapshot of snapshots) {
    const parent = snapshot.header.parentSession
    if (!parent) continue
    const childId = String(snapshot.header.id)
    const parentId = String(parent)
    parentById.set(childId, parentId)
    if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, [])
    childrenByParent.get(parentId).push(childId)
  }

  const agents = ctx.get('agents')

  // Drop requested ids that sit inside another requested id's family: the
  // ancestor's family already covers them.
  const requested = new Set(ids)
  const roots = ids.filter((id) => {
    let cursor = parentById.get(id)
    const visited = new Set()
    while (cursor && !visited.has(cursor)) {
      if (requested.has(cursor)) return false
      visited.add(cursor)
      cursor = parentById.get(cursor)
    }
    return true
  })

  const collected = roots.map((rootId) => collectFamily(rootId, byId, childrenByParent, includeForks))
  const memberIds = [...new Set(collected.flatMap((family) => family.members.map((member) => member.id)))]
  // Titles the page snapshot already resolved cost nothing here; only unknown
  // ids fall back to one bounded batch read.
  const titles = new Map()
  const unknownTitleIds = []
  for (const id of memberIds) {
    const cached = titleCache.get(id)
    if (typeof cached === 'string') titles.set(id, cached)
    else unknownTitleIds.push(id)
  }
  const titlesStartedAt = Date.now()
  if (unknownTitleIds.length > 0) {
    const titleResult = await readTitles(ctx, unknownTitleIds, signal, 'delete-preflight')
    for (const [id, title] of titleResult.titles) {
      titles.set(id, title)
      rememberTitle(id, title)
    }
  }
  trace(
    'delete-preflight',
    'scan',
    `ids=${ids.length} roots=${roots.length} members=${memberIds.length} `
      + `lists=${listsMs}ms titles=${Date.now() - titlesStartedAt}ms `
      + `cached=${memberIds.length - unknownTitleIds.length} total=${Date.now() - startedAt}ms`,
  )

  const families = []
  for (let index = 0; index < roots.length; index += 1) {
    const rootId = roots[index]
    const family = collected[index]
    const blockers = []
    const members = []

    for (const entry of family.members) {
      const snapshot = byId.get(entry.id)
      const dir = findSessionDir(entry.id)
      const label = entry.role === 'root' ? '会话' : '家族成员'
      let loaded = false
      try {
        loaded = Boolean(agents && typeof agents.get === 'function' && agents.get(entry.id))
      } catch {
        loaded = false
      }
      const running = runningById.get(entry.id) === true
      if (!snapshot) blockers.push({ code: 'missing', message: `${label}不存在` })
      if (running) blockers.push({ code: 'running', message: `${label}正在运行` })
      // A loaded-but-idle session is only a warning: `agents.get` means the
      // session was activated in this process (the startup-selected session
      // always is), so blocking it would lock the most-used session forever.
      members.push({
        id: entry.id,
        role: entry.role,
        title: titles.get(entry.id) ?? null,
        running,
        loaded,
        sizeBytes: dir ? dirSize(dir) : 0,
        cwd: snapshot && typeof snapshot.header.cwd === 'string' ? snapshot.header.cwd : null,
      })
    }

    const forks = family.forks.map((forkId) => {
      const dir = findSessionDir(forkId)
      return {
        id: forkId,
        title: titles.get(forkId) ?? null,
        sizeBytes: dir ? dirSize(dir) : 0,
      }
    })

    const loadedMembers = members.filter((member) => member.loaded === true)
    const warnings = loadedMembers.length > 0
      ? [{
          code: 'loaded',
          message: `有 ${loadedMembers.length} 个会话仍被应用保留（已打开），移入后可能要从重启 DSH 后才从原生侧边栏消失`,
        }]
      : []

    families.push({
      rootId,
      rootTitle: titles.get(rootId) ?? null,
      members,
      forks,
      memberCount: members.length,
      forkCount: forks.length,
      totalBytes: members.reduce((sum, member) => sum + member.sizeBytes, 0),
      canTrash: blockers.length === 0 && members.length > 0,
      blockers,
      warnings,
    })
  }

  return families
}

/**
 * Read the recycle bin index.
 *
 * @returns {Array<object>} trash entries, newest first.
 */
function readTrashEntries() {
  // A missing trash root only means no entry was ever physically moved; queued
  // deferred deletions still belong in the list.
  let names = []
  try {
    names = readdirSync(TRASH_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    names = []
  }

  const entries = []
  for (const name of names) {
    const entryDir = join(TRASH_ROOT, name)
    let manifest = null
    try {
      manifest = JSON.parse(readFileSync(join(entryDir, 'manifest.json'), 'utf8'))
    } catch {
      manifest = null
    }
    const sessionDir = join(entryDir, 'session')
    if (!manifest && !existsSync(sessionDir)) continue
    const timestamp = Number(String(name).split('-')[0])
    entries.push({
      entryName: name,
      sessionId: manifest && typeof manifest.id === 'string' ? manifest.id : name.replace(/^\d+-/, ''),
      title: manifest && typeof manifest.title === 'string' ? manifest.title : null,
      role: manifest && typeof manifest.role === 'string' ? manifest.role : 'root',
      familyRoot: manifest && typeof manifest.familyRoot === 'string'
        ? manifest.familyRoot
        : (manifest && typeof manifest.id === 'string' ? manifest.id : name.replace(/^\d+-/, '')),
      memberCount: manifest && Array.isArray(manifest.memberIds) ? manifest.memberIds.length : 1,
      cwd: manifest && typeof manifest.cwd === 'string' ? manifest.cwd : null,
      deletedAt: manifest && typeof manifest.deletedAt === 'number' ? manifest.deletedAt : (Number.isFinite(timestamp) ? timestamp : 0),
      sizeBytes: dirSize(entryDir),
      restoreAvailable: existsSync(sessionDir),
    })
  }

  // Deferred deletions are listed as pending entries so they appear in the
  // recycle bin immediately, before their log is moved on the next start.
  const pending = readPendingTrash()
  for (const id of Object.keys(pending)) {
    const record = pending[id] && typeof pending[id] === 'object' ? pending[id] : {}
    const dir = findSessionDir(id)
    entries.push({
      entryName: `pending:${id}`,
      sessionId: id,
      title: typeof record.title === 'string' ? record.title : null,
      role: typeof record.role === 'string' ? record.role : 'root',
      familyRoot: typeof record.familyRoot === 'string' ? record.familyRoot : id,
      memberCount: 1,
      cwd: typeof record.cwd === 'string' ? record.cwd : null,
      deletedAt: typeof record.requestedAt === 'number' ? record.requestedAt : Date.now(),
      sizeBytes: dir ? dirSize(dir) : 0,
      restoreAvailable: true,
      pending: true,
      // A queued permanent delete waits for the next start, when no Agent holds
      // the log file, so it is still a pending entry until then.
      purge: record.purge === true,
    })
  }

  entries.sort((left, right) => right.deletedAt - left.deletedAt)
  return entries
}

/**
 * Move whole families into the recycle bin.
 *
 * @param {object} ctx Cordis context.
 * @param {any} rawIds requested root session ids.
 * @param {AbortSignal} signal request cancellation.
 * @param {boolean} includeForks whether fork children travel with the family.
 * @param {object | null} [progress] live progress entry the Client polls.
 * @returns {Promise<{ results: Array<object>, families: Array<object> }>} per-member results and family summaries.
 */
async function trashSessions(ctx, rawIds, signal, includeForks, progress = null) {
  const ids = normalizeIds(rawIds)
  if (ids.length === 0) return { results: [], families: [] }

  const preflight = await buildDeletePreflight(ctx, ids, signal, includeForks)
  if (progress) {
    // Total work is one step per family member; skipped families count too so
    // the bar still reaches the end when everything was blocked.
    progress.total = preflight.reduce((sum, family) => sum + family.members.length, 0)
    progress.at = Date.now()
  }
  const baseline = await readWorkspaceBaseline(ctx, 'trash')
  const archived = new Set(baseline.baseline.archivedSessionIds)
  const pinned = new Set(baseline.baseline.pinnedSessionIds)
  const registry = ctx.get('workspaceRegistry')
  const pending = readPendingTrash()
  let pendingChanged = false
  const results = []
  const families = []

  for (const family of preflight) {
    if (!family.canTrash) {
      for (const member of family.members) {
        results.push({
          id: member.id,
          familyRoot: family.rootId,
          status: 'skipped',
          reason: family.blockers.map((blocker) => blocker.message).join('；'),
        })
        bumpDeleteProgress(progress, member.title)
      }
      continue
    }

    const deletedAt = Date.now()
    const memberIds = family.members.map((member) => member.id)

    for (const member of family.members) {
      // A loaded session still holds its write handle: moving its log now would
      // break the Agent (ENOENT on the next turn). Archive it so the Native
      // sidebar hides it immediately, and queue the physical move for the next
      // start, when no Agent is live.
      if (member.loaded === true && member.running !== true) {
        // A repeat delete of the same session must not read back the archive the
        // first delete applied: the existing record owns the "was it archived
        // before anyone touched it" answer, and earlier queued intents (a
        // pending permanent delete) must survive the second request.
        const previous = pending[member.id] && typeof pending[member.id] === 'object'
          ? pending[member.id]
          : null
        if (registry && typeof registry.archiveSession === 'function' && !archived.has(member.id)) {
          try {
            await registry.archiveSession(member.id, {})
          } catch {
            // Background work may refuse archiving; the deferred move still applies.
          }
        }
        const wasArchived = previous !== null && typeof previous.wasArchived === 'boolean'
          ? previous.wasArchived
          : archived.has(member.id)
        pending[member.id] = {
          ...(previous ?? {}),
          // Keep the first request's timestamp so the bin entry keeps its age.
          requestedAt: previous !== null && typeof previous.requestedAt === 'number'
            ? previous.requestedAt
            : Date.now(),
          familyRoot: family.rootId,
          role: member.role,
          title: member.title,
          cwd: member.cwd ?? null,
          // Record the archive state from before the delete: restore must undo
          // only the archive this delete applied to hide the session.
          wasArchived,
          archivedByDelete: !wasArchived,
        }
        pendingChanged = true
        trace('trash', 'deferred', `id=${member.id} family=${family.rootId}`)
        appendOperation({ action: 'defer', sessionId: member.id, title: member.title, role: member.role })
        results.push({ id: member.id, familyRoot: family.rootId, role: member.role, status: 'deferred' })
        bumpDeleteProgress(progress, member.title)
        continue
      }
      try {
        const dir = findSessionDir(member.id)
        if (!dir) {
          results.push({ id: member.id, familyRoot: family.rootId, status: 'failed', reason: '找不到会话目录' })
          bumpDeleteProgress(progress, member.title)
          continue
        }
        const entryName = `${deletedAt}-${member.id}`
        const entryDir = join(TRASH_ROOT, entryName)
        mkdirSync(entryDir, { recursive: true })

        // Move first (atomic on one volume), then record and clean accounting:
        // a failure after the move still leaves a recoverable trash entry.
        renameSync(dir, join(entryDir, 'session'))

        const workspaceIds = await detachFromWorkspaces(registry, member.id)
        if (archived.has(member.id) && registry && typeof registry.unarchiveSession === 'function') {
          try {
            await registry.unarchiveSession(member.id)
          } catch {
            // Removal cannot introduce an unknown id, so a failure is cosmetic.
          }
        }
        if (pinned.has(member.id) && registry && typeof registry.unpinSession === 'function') {
          try {
            await registry.unpinSession(member.id)
          } catch {
            // Same as above.
          }
        }

        writeFileSync(join(entryDir, 'manifest.json'), JSON.stringify({
          id: member.id,
          entryName,
          role: member.role,
          familyRoot: family.rootId,
          memberIds,
          title: member.title,
          cwd: member.cwd ?? null,
          projectDirName: basename(dirname(dir)),
          originalDir: dir,
          workspaceIds,
          archived: archived.has(member.id),
          pinned: pinned.has(member.id),
          sizeBytes: member.sizeBytes,
          deletedAt,
        }, null, 2))

        trace('trash', 'end', `ok id=${member.id} family=${family.rootId} role=${member.role} entry=${entryName}`)
        appendOperation({ action: 'trash', sessionId: member.id, title: member.title, role: member.role })
        results.push({ id: member.id, familyRoot: family.rootId, role: member.role, status: 'trashed', entryName })
        bumpDeleteProgress(progress, member.title)
      } catch (error) {
        trace('trash', 'end', `throw id=${member.id} ${describeError(error)}`)
        results.push({ id: member.id, familyRoot: family.rootId, status: 'failed', reason: describeError(error) })
        bumpDeleteProgress(progress, member.title)
      }
    }

    families.push({ familyRoot: family.rootId, memberCount: memberIds.length })
  }

  if (pendingChanged) writePendingTrash(pending)

  return { results, families }
}

/**
 * Restore recycle-bin entries.
 *
 * With `options.cancelPurgeOnly`, a pending entry only loses its queued
 * permanent deletion: it stays in the recycle bin, still hidden from the Native
 * sidebar, and the next start moves it into the bin as usual.
 *
 * @param {object} ctx Cordis context.
 * @param {any} rawNames requested entry names.
 * @param {AbortSignal} signal request cancellation.
 * @param {{ cancelPurgeOnly?: boolean }} [options] cancel a queued permanent delete only.
 * @returns {Promise<Array<object>>} one result per entry.
 */
async function restoreTrashEntries(ctx, rawNames, signal, options = {}) {
  const allowed = new Set(readTrashEntries().map((entry) => entry.entryName))
  const registry = ctx.get('workspaceRegistry')
  const cancelPurgeOnly = options.cancelPurgeOnly === true
  const results = []

  for (const rawName of Array.isArray(rawNames) ? rawNames : []) {
    if (typeof rawName === 'string' && rawName.startsWith('pending:')) {
      const pendingId = rawName.slice('pending:'.length)
      const currentPending = readPendingTrash()
      if (!currentPending[pendingId] || typeof currentPending[pendingId] !== 'object') {
        results.push({ entryName: rawName, status: 'failed', reason: '找不到待移入条目' })
        continue
      }
      if (cancelPurgeOnly) {
        const queued = currentPending[pendingId]
        if (queued.purge !== true) {
          results.push({ entryName: rawName, status: 'failed', reason: '该条目未排队永久删除' })
          continue
        }
        // Drop only the destructive intent: the delete itself stays queued, so
        // the session remains hidden and still moves into the bin next start.
        const { purge, purgeRequestedAt, ...kept } = queued
        currentPending[pendingId] = kept
        writePendingTrash(currentPending)
        trace('restore', 'end', `cancel-purge id=${pendingId}`)
        appendOperation({
          action: 'cancel-purge',
          sessionId: pendingId,
          title: typeof queued.title === 'string' ? queued.title : null,
          role: typeof queued.role === 'string' ? queued.role : 'root',
        })
        results.push({ entryName: rawName, sessionId: pendingId, status: 'canceled' })
        continue
      }
      const record = currentPending[pendingId]
      delete currentPending[pendingId]
      writePendingTrash(currentPending)
      try {
        // A session that was archived before the delete keeps that state; only
        // the archive added by the delete itself is undone.
        if (record.wasArchived !== true && registry && typeof registry.unarchiveSession === 'function') {
          await registry.unarchiveSession(pendingId)
        }
      } catch (error) {
        // The session was archived only to hide it during deletion, so a failure
        // here leaves it invisible; keep a trace to make that diagnosable.
        trace('restore', 'unarchive-fail', `id=${pendingId} ${describeError(error)}`)
      }
      trace('restore', 'end', `ok pending id=${pendingId}`)
      appendOperation({
        action: 'restore',
        sessionId: pendingId,
        title: typeof record.title === 'string' ? record.title : null,
        role: typeof record.role === 'string' ? record.role : 'root',
      })
      results.push({ entryName: rawName, sessionId: pendingId, status: 'restored' })
      continue
    }
    if (cancelPurgeOnly) {
      results.push({
        entryName: String(rawName),
        status: 'failed',
        reason: '仅待处理条目支持取消永久删除',
      })
      continue
    }
    if (typeof rawName !== 'string' || !allowed.has(rawName)) {
      results.push({ entryName: String(rawName), status: 'failed', reason: '回收站中找不到该条目' })
      continue
    }
    try {
      const entryDir = join(TRASH_ROOT, rawName)
      const manifest = JSON.parse(readFileSync(join(entryDir, 'manifest.json'), 'utf8'))
      const sessionDir = join(entryDir, 'session')
      if (!existsSync(sessionDir)) {
        results.push({ entryName: rawName, status: 'failed', reason: '会话数据缺失' })
        continue
      }

      const projectDirName = typeof manifest.projectDirName === 'string'
        && manifest.projectDirName !== ''
        && !manifest.projectDirName.includes('/')
        && !manifest.projectDirName.includes('\\')
        && !manifest.projectDirName.includes('..')
        ? manifest.projectDirName
        : '_no-cwd'
      const projectDir = join(SESSIONS_ROOT, projectDirName)
      const target = join(projectDir, manifest.id)
      if (existsSync(target)) {
        results.push({ entryName: rawName, status: 'failed', reason: '目标位置已存在同 id 会话' })
        continue
      }

      mkdirSync(projectDir, { recursive: true })
      renameSync(sessionDir, target)
      rmSync(entryDir, { recursive: true, force: true })

      if (Array.isArray(manifest.workspaceIds)) {
        for (const workspaceId of manifest.workspaceIds) {
          try {
            const workspace = registry && typeof registry.get === 'function' ? registry.get(workspaceId) : undefined
            if (workspace && typeof workspace.attachSession === 'function') await workspace.attachSession(manifest.id)
          } catch {
            // Restoring accounting is best effort.
          }
        }
      }
      if (manifest.pinned && registry && typeof registry.pinSession === 'function') {
        try {
          await registry.pinSession(manifest.id)
        } catch {
          // Pin restore is cosmetic.
        }
      }
      if (manifest.archived && registry && typeof registry.archiveSession === 'function') {
        try {
          await registry.archiveSession(manifest.id)
        } catch {
          // Archive restore is cosmetic.
        }
      }

      trace('restore', 'end', `ok id=${manifest.id} entry=${rawName}`)
      appendOperation({
        action: 'restore',
        sessionId: manifest.id,
        title: typeof manifest.title === 'string' ? manifest.title : null,
        role: typeof manifest.role === 'string' ? manifest.role : 'root',
      })
      results.push({ entryName: rawName, sessionId: manifest.id, status: 'restored' })
    } catch (error) {
      trace('restore', 'end', `throw entry=${rawName} ${describeError(error)}`)
      results.push({ entryName: rawName, status: 'failed', reason: describeError(error) })
    }
  }

  return results
}

/**
 * Append one durable audit record for a destructive operation.
 *
 * @param {object} record JSON-serializable record.
 */
function appendAudit(record) {
  try {
    mkdirSync(dirname(PURGE_AUDIT_FILE), { recursive: true })
    appendFileSync(PURGE_AUDIT_FILE, `${JSON.stringify(record)}\n`)
  } catch {
    // Audit failures must not block the purge.
  }
}

/**
 * Permanently delete recycle-bin entries.
 *
 * Only entry names currently present in the recycle bin are accepted, and the
 * resolved directory must stay inside the trash root.
 *
 * @param {any} rawNames requested entry names.
 * @returns {Promise<Array<object>>} one result per entry.
 */
async function purgeTrashEntries(rawNames) {
  const entries = readTrashEntries()
  const byName = new Map(entries.map((entry) => [entry.entryName, entry]))
  const trashRoot = resolve(TRASH_ROOT)
  const pending = readPendingTrash()
  let pendingChanged = false
  const results = []
  const purged = []
  const queued = []

  for (const rawName of Array.isArray(rawNames) ? rawNames : []) {
    if (typeof rawName === 'string' && rawName.startsWith('pending:')) {
      const pendingId = rawName.slice('pending:'.length)
      const record = pending[pendingId]
      if (!record || typeof record !== 'object' || !byName.has(rawName)) {
        results.push({ entryName: rawName, status: 'failed', reason: '回收站中找不到该条目' })
        continue
      }
      // The session is still open, so its log cannot be removed now; queue the
      // deletion for the next start instead of rejecting it.
      if (record.purge !== true) {
        pending[pendingId] = { ...record, purge: true, purgeRequestedAt: Date.now() }
        pendingChanged = true
        appendOperation({
          action: 'queue-purge',
          sessionId: pendingId,
          title: typeof record.title === 'string' ? record.title : null,
          role: typeof record.role === 'string' ? record.role : 'root',
        })
      }
      queued.push({ entryName: rawName, sessionId: pendingId })
      results.push({ entryName: rawName, sessionId: pendingId, status: 'queued' })
      continue
    }
    if (typeof rawName !== 'string' || !byName.has(rawName)) {
      results.push({ entryName: String(rawName), status: 'failed', reason: '回收站中找不到该条目' })
      continue
    }
    const entry = byName.get(rawName)
    const entryDir = join(TRASH_ROOT, rawName)
    try {
      const resolved = resolve(entryDir)
      if (resolved === trashRoot || !resolved.startsWith(trashRoot + sep)) {
        results.push({ entryName: rawName, status: 'failed', reason: '条目路径非法' })
        continue
      }
      rmSync(entryDir, { recursive: true, force: true })
      appendOperation({
        action: 'purge',
        sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : '',
        title: typeof entry.title === 'string' ? entry.title : null,
        role: typeof entry.role === 'string' ? entry.role : 'root',
      })
      results.push({ entryName: rawName, sessionId: entry.sessionId, status: 'purged', sizeBytes: entry.sizeBytes })
      purged.push(entry)
    } catch (error) {
      results.push({ entryName: rawName, status: 'failed', reason: describeError(error) })
    }
  }

  if (pendingChanged) writePendingTrash(pending)

  if (purged.length > 0) {
    appendAudit({
      at: new Date().toISOString(),
      action: 'purge',
      entries: purged.map((entry) => ({
        entryName: entry.entryName,
        sessionId: entry.sessionId,
        familyRoot: entry.familyRoot,
        role: entry.role,
        sizeBytes: entry.sizeBytes,
      })),
    })
  }
  trace(
    'purge',
    'end',
    `purged=${purged.length} queued=${queued.length} failed=${results.length - purged.length - queued.length}`,
  )
  return results
}

/**
 * Export the requested sessions as one self-describing ZIP package.
 *
 * The package copies every session directory verbatim (logs stay in their
 * stored format) and carries the workspace membership plus the per-session
 * metadata an importer needs: role, parent, cwd, project directory name and
 * archive/pin state.
 *
 * @param {object} ctx Cordis context.
 * @param {any} rawIds requested root session ids.
 * @param {AbortSignal} signal request cancellation.
 * @param {{ targetDir?: string, createDir?: boolean }} [options] destination, and
 *   whether a missing destination may be created.
 * @returns {Promise<object>} archive description.
 */
async function exportSessions(ctx, rawIds, signal, options = {}) {
  const ids = normalizeIds(rawIds)
  if (ids.length === 0) throw new Error('请先勾选要导出的会话')

  // Resolve and validate the destination before doing any reading work. A
  // missing directory is reported with its own code so the Client can ask the
  // user whether to create it.
  let targetDir = EXPORT_DIR
  const requestedDir = typeof options.targetDir === 'string' ? options.targetDir.trim() : ''
  if (requestedDir !== '') {
    targetDir = resolve(requestedDir)
    let stats = null
    try {
      stats = statSync(targetDir)
    } catch {
      stats = null
    }
    if (stats === null) {
      if (options.createDir === true) {
        try {
          mkdirSync(targetDir, { recursive: true })
        } catch (error) {
          throw new Error(`无法创建导出位置：${describeError(error)}`)
        }
      } else {
        const missing = new Error(`导出位置不存在：${targetDir}`)
        missing.code = 'export-dir-missing'
        throw missing
      }
    } else if (!stats.isDirectory()) {
      throw new Error(`导出位置不是文件夹：${targetDir}`)
    }
  }

  const persistence = ctx.get('sessionPersistence')
  if (!persistence || typeof persistence.list !== 'function') throw new Error('会话持久化服务不可用')
  const outcome = await withTimeout(
    Promise.resolve().then(() => persistence.list({ signal })),
    SUMMARIES_TIMEOUT_MS,
  )
  const snapshots = !outcome.timedOut && !outcome.error && Array.isArray(outcome.value)
    ? outcome.value
    : []
  if (snapshots.length === 0) throw new Error('读取会话列表失败')

  const byId = new Map(snapshots.map((snapshot) => [String(snapshot.header.id), snapshot]))
  const childrenByParent = new Map()
  for (const snapshot of snapshots) {
    const parent = snapshot.header.parentSession
    if (!parent) continue
    const parentId = String(parent)
    const childId = String(snapshot.header.id)
    if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, [])
    childrenByParent.get(parentId).push(childId)
  }

  // Selected sessions plus their subagent/teammate descendants, so an exported
  // family arrives intact.
  const selected = []
  const seen = new Set()
  const queue = [...ids]
  while (queue.length > 0) {
    const id = queue.shift()
    if (seen.has(id)) continue
    seen.add(id)
    if (!byId.has(id)) continue
    selected.push(id)
    for (const childId of childrenByParent.get(id) ?? []) {
      const child = byId.get(childId)
      if (child && child.header.origin === 'subagent') queue.push(childId)
    }
  }
  if (selected.length === 0) throw new Error('勾选的会话在磁盘上不存在')

  const baseline = await readWorkspaceBaseline(ctx, 'export')
  const workspaceById = new Map(
    baseline.baseline.items.map((item) => [String(item.workspaceId), item]),
  )
  const archived = new Set(baseline.baseline.archivedSessionIds.map(String))
  const pinned = new Set(baseline.baseline.pinnedSessionIds.map(String))
  const workspaceIdsBySession = new Map()
  for (const item of baseline.baseline.items) {
    for (const sessionId of item.sessionIds ?? []) {
      const key = String(sessionId)
      if (!workspaceIdsBySession.has(key)) workspaceIdsBySession.set(key, [])
      workspaceIdsBySession.get(key).push(String(item.workspaceId))
    }
  }

  const titles = new Map()
  const unknownTitleIds = []
  for (const id of selected) {
    const cached = titleCache.get(id)
    if (typeof cached === 'string') titles.set(id, cached)
    else unknownTitleIds.push(id)
  }
  if (unknownTitleIds.length > 0) {
    const titleResult = await readTitles(ctx, unknownTitleIds, signal, 'export')
    for (const [id, title] of titleResult.titles) {
      titles.set(id, title)
      rememberTitle(id, title)
    }
  }

  const entries = []
  const sessions = []
  let totalBytes = 0
  for (const id of selected) {
    const snapshot = byId.get(id)
    const dir = findSessionDir(id)
    if (!snapshot || !dir) continue
    const prefix = `sessions/${id}`
    const before = entries.length
    totalBytes += collectDirectoryEntries(dir, prefix, entries, EXPORT_MAX_BYTES - totalBytes)
    if (entries.length === before) continue
    const header = snapshot.header
    sessions.push({
      id,
      title: titles.get(id) ?? null,
      role: header.origin === 'subagent' ? 'subagent' : (header.parentSession ? 'fork' : 'root'),
      parentSession: typeof header.parentSession === 'string' ? header.parentSession : null,
      cwd: typeof header.cwd === 'string' ? header.cwd : null,
      createdAt: typeof header.createdAt === 'number' ? header.createdAt : null,
      formatStatus: typeof snapshot.formatStatus === 'string' ? snapshot.formatStatus : null,
      archived: archived.has(id),
      pinned: pinned.has(id),
      workspaceIds: workspaceIdsBySession.get(id) ?? [],
      projectDirName: basename(dirname(dir)),
      files: entries.slice(before).map((entry) => entry.name.slice(prefix.length + 1)),
    })
  }
  if (sessions.length === 0) throw new Error('没有可写入导出包的会话文件')

  const workspaces = []
  for (const workspaceId of [...new Set(sessions.flatMap((session) => session.workspaceIds))]) {
    const item = workspaceById.get(workspaceId)
    if (item) workspaces.push({ workspaceId, path: item.path, title: item.title })
  }

  const manifest = {
    format: 'dsh-sessions-library-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    source: { dshHome: DSH_HOME },
    // Session directories are copied verbatim; an importer restores them under
    // the target sessions root and reads workspace membership from here.
    workspaces,
    sessions,
  }
  entries.unshift({
    name: 'manifest.json',
    data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'),
  })

  const archive = buildStoredZip(entries)
  try {
    mkdirSync(targetDir, { recursive: true })
  } catch (error) {
    throw new Error(`无法写入导出位置：${describeError(error)}`)
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')
  // Two exports in the same second must not overwrite each other.
  let fileName = `dsh-sessions-${stamp}.zip`
  let target = join(targetDir, fileName)
  for (let index = 2; existsSync(target); index += 1) {
    fileName = `dsh-sessions-${stamp}-${index}.zip`
    target = join(targetDir, fileName)
  }
  writeFileSync(target, archive)
  for (const session of sessions) {
    appendOperation({
      action: 'export',
      sessionId: session.id,
      title: session.title,
      role: session.role,
    })
  }
  trace('export', 'end', `sessions=${sessions.length} bytes=${archive.length} file=${fileName}`)
  return {
    fileName,
    path: target,
    sessionCount: sessions.length,
    workspaceCount: workspaces.length,
    bytes: archive.length,
    missing: ids.filter((id) => !byId.has(id)).length,
  }
}

/**
 * Finish queued deletions after start.
 *
 * Runs shortly after start, when no Agent is live yet, so moving or removing a
 * stored session is always safe. Records flagged `purge` are destroyed here
 * instead of moving into the recycle bin; failures stay queued for the next
 * attempt.
 *
 * @param {object} ctx Cordis context.
 * @returns {Promise<void>} resolution after every queued session was handled.
 */
async function flushPendingTrash(ctx) {
  const items = readPendingTrash()
  const ids = Object.keys(items)
  if (ids.length === 0) return

  const registry = ctx.get('workspaceRegistry')
  const remaining = {}
  for (const id of ids) {
    const record = items[id] && typeof items[id] === 'object' ? items[id] : {}
    try {
      const dir = findSessionDir(id)
      if (!dir) {
        trace('trash', 'deferred-skip', `id=${id} already gone`)
        continue
      }
      // A queued permanent delete destroys the log here instead of creating a
      // trash entry: no Agent is live yet, and the durable audit records it.
      if (record.purge === true) {
        const sizeBytes = dirSize(dir)
        rmSync(dir, { recursive: true, force: true })
        await detachFromWorkspaces(registry, id)
        if (registry && typeof registry.unarchiveSession === 'function') {
          try {
            await registry.unarchiveSession(id)
          } catch {
            // Removing an id cannot introduce an unknown one.
          }
        }
        if (registry && typeof registry.unpinSession === 'function') {
          try {
            await registry.unpinSession(id)
          } catch {
            // Already unpinned or unknown; both are harmless.
          }
        }
        appendAudit({
          at: new Date().toISOString(),
          action: 'purge',
          deferred: true,
          entries: [{
            entryName: id,
            sessionId: id,
            familyRoot: typeof record.familyRoot === 'string' ? record.familyRoot : id,
            role: typeof record.role === 'string' ? record.role : 'root',
            sizeBytes,
          }],
        })
        trace('trash', 'purge-ok', `id=${id}`)
        appendOperation({
          action: 'flush-purge',
          sessionId: id,
          title: typeof record.title === 'string' ? record.title : null,
          role: typeof record.role === 'string' ? record.role : 'root',
        })
        continue
      }
      const deletedAt = Date.now()
      const entryName = `${deletedAt}-${id}`
      const entryDir = join(TRASH_ROOT, entryName)
      mkdirSync(entryDir, { recursive: true })
      renameSync(dir, join(entryDir, 'session'))
      const workspaceIds = await detachFromWorkspaces(registry, id)
      // The delete archived the session so the Native sidebar hid it; drop that
      // residue now that the log is really gone.
      if (registry && typeof registry.unarchiveSession === 'function') {
        try {
          await registry.unarchiveSession(id)
        } catch {
          // Removing an id cannot introduce an unknown one.
        }
      }
      if (registry && typeof registry.unpinSession === 'function') {
        try {
          await registry.unpinSession(id)
        } catch {
          // Already unpinned or unknown; both are harmless.
        }
      }
      writeFileSync(join(entryDir, 'manifest.json'), JSON.stringify({
        id,
        entryName,
        role: typeof record.role === 'string' ? record.role : 'root',
        familyRoot: typeof record.familyRoot === 'string' ? record.familyRoot : id,
        memberIds: [id],
        title: typeof record.title === 'string' ? record.title : null,
        cwd: typeof record.cwd === 'string' ? record.cwd : null,
        projectDirName: basename(dirname(dir)),
        originalDir: dir,
        workspaceIds,
        archived: false,
        pinned: false,
        sizeBytes: dirSize(join(entryDir, 'session')),
        deletedAt,
        deferred: true,
      }, null, 2))
      trace('trash', 'deferred-ok', `id=${id}`)
      appendOperation({
        action: 'flush-trash',
        sessionId: id,
        title: typeof record.title === 'string' ? record.title : null,
        role: typeof record.role === 'string' ? record.role : 'root',
      })
    } catch (error) {
      remaining[id] = record
      trace('trash', 'deferred-fail', `id=${id} ${describeError(error)}`)
    }
  }
  writePendingTrash(remaining)
}

/**
 * Activate the Host half.
 *
 * @param {object} ctx Cordis context.
 */
export function apply(ctx) {
  resetTrace(`plugin activated; dshHome=${DSH_HOME}`)

  ctx.inject(['connection'], (injected) => {
    const connection = injected.get('connection')
    const register = connection && connection.fetch && typeof connection.fetch.register === 'function'
      ? connection.fetch.register.bind(connection.fetch)
      : undefined
    if (!register) {
      trace('boot', 'route', 'connection.fetch.register unavailable')
      return
    }

    const routes = [
      {
        path: SNAPSHOT_PATH,
        label: 'snapshot',
        handler: async (request) => jsonResponse(await runSnapshot(ctx, request.signal)),
      },
      {
        path: DELETE_PREFLIGHT_PATH,
        label: 'delete-preflight',
        handler: async (request) => {
          const body = await readJsonBody(request)
          const normalized = normalizeIdList(body.sessionIds)
          if (normalized.requested > normalized.ids.length) {
            trace('delete-preflight', 'limit', `requested=${normalized.requested} accepted=${normalized.ids.length}`)
          }
          const families = await buildDeletePreflight(
            ctx,
            normalized.ids,
            request.signal,
            body.includeForks === true,
          )
          return jsonResponse({
            ok: true,
            families,
            limit: {
              max: DELETE_BATCH_LIMIT,
              requested: normalized.requested,
              accepted: normalized.ids.length,
            },
          })
        },
      },
      {
        path: DELETE_PATH,
        label: 'delete',
        handler: async (request) => {
          const body = await readJsonBody(request)
          const normalized = normalizeIdList(body.sessionIds)
          if (normalized.requested > normalized.ids.length) {
            trace('delete', 'limit', `requested=${normalized.requested} accepted=${normalized.ids.length}`)
          }
          const token = typeof body.progressToken === 'string' && body.progressToken.length > 0
            && body.progressToken.length <= 64
            ? body.progressToken
            : null
          let progress = null
          if (token !== null) {
            pruneDeleteProgress()
            progress = { done: 0, total: 0, current: '', finished: false, at: Date.now() }
            deleteProgress.set(token, progress)
          }
          const deleteStartedAt = Date.now()
          try {
            const outcome = await trashSessions(
              ctx,
              normalized.ids,
              request.signal,
              body.includeForks === true,
              progress,
            )
            trace('delete', 'done', `results=${outcome.results.length} ms=${Date.now() - deleteStartedAt}`)
            return jsonResponse({
              ok: true,
              results: outcome.results,
              families: outcome.families,
              limit: {
                max: DELETE_BATCH_LIMIT,
                requested: normalized.requested,
                accepted: normalized.ids.length,
              },
            })
          } finally {
            if (progress) {
              progress.finished = true
              progress.at = Date.now()
            }
          }
        },
      },
      {
        path: DELETE_PROGRESS_PATH,
        label: 'delete-progress',
        handler: async (request) => {
          const body = await readJsonBody(request)
          const token = typeof body.token === 'string' ? body.token : ''
          pruneDeleteProgress()
          const entry = token !== '' ? deleteProgress.get(token) : undefined
          return jsonResponse({
            ok: true,
            progress: entry
              ? {
                  done: entry.done,
                  total: entry.total,
                  current: entry.current,
                  finished: entry.finished === true,
                }
              : null,
          })
        },
      },
      {
        path: TRASH_LIST_PATH,
        label: 'trash-list',
        handler: async () => jsonResponse({ ok: true, entries: readTrashEntries() }),
      },
      {
        path: TRASH_RESTORE_PATH,
        label: 'trash-restore',
        handler: async (request) => {
          const body = await readJsonBody(request)
          const results = await restoreTrashEntries(ctx, body.entryNames, request.signal, {
            cancelPurgeOnly: body.cancelPurgeOnly === true,
          })
          return jsonResponse({ ok: true, results })
        },
      },
      {
        path: TRASH_PURGE_PATH,
        label: 'trash-purge',
        handler: async (request) => {
          const body = await readJsonBody(request)
          const results = await purgeTrashEntries(body.entryNames)
          return jsonResponse({ ok: true, results })
        },
      },
      {
        path: LOGS_PATH,
        label: 'logs',
        handler: async (request) => {
          const body = await readJsonBody(request)
          return jsonResponse({ ok: true, entries: readOperations(body.limit) })
        },
      },
      {
        path: LOGS_CLEAR_PATH,
        label: 'logs-clear',
        handler: async () => {
          clearOperations()
          trace('logs', 'cleared', '')
          return jsonResponse({ ok: true })
        },
      },
      {
        path: LOGS_DELETE_PATH,
        label: 'logs-delete',
        handler: async (request) => {
          const body = await readJsonBody(request)
          const removed = deleteOperations(body.ids)
          trace('logs', 'deleted', `rows=${removed}`)
          return jsonResponse({ ok: true, removed })
        },
      },
      {
        path: EXPORT_PATH,
        label: 'export',
        handler: async (request) => {
          const body = await readJsonBody(request)
          const result = await exportSessions(ctx, body.sessionIds, request.signal, {
            targetDir: typeof body.targetDir === 'string' ? body.targetDir : undefined,
            createDir: body.createDir === true,
          })
          return jsonResponse({ ok: true, ...result })
        },
      },
      {
        path: IMPORT_LIST_PATH,
        label: 'import-list',
        handler: async (request) => {
          const body = await readJsonBody(request)
          const listing = listImportCandidates(body.dir)
          return jsonResponse({ ok: true, ...listing })
        },
      },
      {
        path: IMPORT_PREFLIGHT_PATH,
        label: 'import-preflight',
        handler: async (request) => {
          const body = await readJsonBody(request)
          const report = await inspectImport(ctx, body.path)
          return jsonResponse({ ok: true, report })
        },
      },
      {
        path: IMPORT_RUN_PATH,
        label: 'import-run',
        handler: async (request) => {
          const body = await readJsonBody(request)
          const outcome = await importPackage(ctx, body.path, body.mapping)
          return jsonResponse({ ok: true, ...outcome })
        },
      },
    ]

    for (const route of routes) {
      ctx.effect(() => register({
        path: route.path,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          try {
            return await route.handler(request)
          } catch (error) {
            trace('route', route.label, describeError(error))
            // Domain errors may carry their own stable code so the Client can
            // react differently (for example: destination folder missing).
            const code = error && typeof error.code === 'string' && error.code !== ''
              ? error.code
              : `${route.label}-failed`
            return jsonResponse({
              ok: false,
              error: { code, message: describeError(error) },
            }, 500)
          }
        },
      }), `sessions-library: ${route.label} route`)
    }
    trace('boot', 'route', `registered ${routes.length}`)
  })

  // Debug-phase self test: proves which aggregation layers work after a restart
  // without needing the browser to open the page.
  const timer = setTimeout(() => {
    const requestId = 'selftest'
    trace(requestId, 'start', '')
    const signal = new AbortController().signal
    withTimeout(buildSnapshot(ctx, signal, requestId), SELF_TEST_TIMEOUT_MS).then((outcome) => {
      if (outcome.timedOut) {
        trace(requestId, 'end', `timeout>${SELF_TEST_TIMEOUT_MS}ms`)
        return
      }
      if (outcome.error) {
        trace(requestId, 'end', `throw ${describeError(outcome.error)}`)
        return
      }
      const snapshot = outcome.value
      trace(
        requestId,
        'end',
        `ok workspaces=${snapshot.workspaces.length} sessions=${snapshot.counts.total} ` +
          `archived=${snapshot.counts.archived} sources=${JSON.stringify(snapshot.sources)}`,
      )
      writeSnapshotFile(snapshot)
    })
  }, SELF_TEST_DELAY_MS)
  ctx.effect(() => () => clearTimeout(timer), 'sessions-library: self-test')

  // Deferred deletions are queued while the session was still loaded; move them
  // now that no Agent is live.
  const flushTimer = setTimeout(() => {
    flushPendingTrash(ctx).catch((error) => trace('trash', 'deferred-fail', describeError(error)))
  }, 6000)
  ctx.effect(() => () => clearTimeout(flushTimer), 'sessions-library: deferred trash flush')
}
