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
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

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
const DELETE_BATCH_LIMIT = 100

// Identifies one Host process. The Client compares it with the value it stored
// last time: a different value means DSH restarted, so view state resets.
const BOOT_AT = Date.now()

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
 * Normalize a session-id list from a request body.
 *
 * @param {any} value raw value.
 * @returns {string[]} unique safe ids.
 */
function normalizeIds(value) {
  if (!Array.isArray(value)) return []
  const ids = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const id = item.trim()
    if (id === '' || id.includes('/') || id.includes('\\') || id.includes('..')) continue
    ids.push(id)
  }
  return [...new Set(ids)].slice(0, DELETE_BATCH_LIMIT)
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
  const persistence = ctx.get('sessionPersistence')
  let snapshots = []
  if (persistence && typeof persistence.list === 'function') {
    const outcome = await withTimeout(Promise.resolve().then(() => persistence.list({ signal })), SUMMARIES_TIMEOUT_MS)
    if (!outcome.timedOut && !outcome.error && Array.isArray(outcome.value)) snapshots = outcome.value
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
  const controller = ctx.get('sessionController')
  const runningById = new Map()
  if (controller && typeof controller.list === 'function') {
    const outcome = await withTimeout(Promise.resolve().then(() => controller.list({}, signal)), SUMMARIES_TIMEOUT_MS)
    if (!outcome.timedOut && !outcome.error && outcome.value && Array.isArray(outcome.value.items)) {
      for (const item of outcome.value.items) runningById.set(String(item.sessionId), item.running === true)
    }
  }

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
  const titleResult = await readTitles(ctx, memberIds, signal, 'delete-preflight')

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
      members.push({
        id: entry.id,
        role: entry.role,
        title: titleResult.titles.get(entry.id) ?? null,
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
        title: titleResult.titles.get(forkId) ?? null,
        sizeBytes: dir ? dirSize(dir) : 0,
      }
    })

    families.push({
      rootId,
      rootTitle: titleResult.titles.get(rootId) ?? null,
      members,
      forks,
      memberCount: members.length,
      forkCount: forks.length,
      totalBytes: members.reduce((sum, member) => sum + member.sizeBytes, 0),
      canTrash: blockers.length === 0 && members.length > 0,
      blockers,
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
  if (!existsSync(TRASH_ROOT)) return []
  let names = []
  try {
    names = readdirSync(TRASH_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
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
 * @returns {Promise<{ results: Array<object>, families: Array<object> }>} per-member results and family summaries.
 */
async function trashSessions(ctx, rawIds, signal, includeForks) {
  const ids = normalizeIds(rawIds)
  if (ids.length === 0) return { results: [], families: [] }

  const preflight = await buildDeletePreflight(ctx, ids, signal, includeForks)
  const baseline = await readWorkspaceBaseline(ctx, 'trash')
  const archived = new Set(baseline.baseline.archivedSessionIds)
  const pinned = new Set(baseline.baseline.pinnedSessionIds)
  const registry = ctx.get('workspaceRegistry')
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
      }
      continue
    }

    const deletedAt = Date.now()
    const memberIds = family.members.map((member) => member.id)

    for (const member of family.members) {
      try {
        const dir = findSessionDir(member.id)
        if (!dir) {
          results.push({ id: member.id, familyRoot: family.rootId, status: 'failed', reason: '找不到会话目录' })
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
        results.push({ id: member.id, familyRoot: family.rootId, role: member.role, status: 'trashed', entryName })
      } catch (error) {
        trace('trash', 'end', `throw id=${member.id} ${describeError(error)}`)
        results.push({ id: member.id, familyRoot: family.rootId, status: 'failed', reason: describeError(error) })
      }
    }

    families.push({ familyRoot: family.rootId, memberCount: memberIds.length })
  }

  return { results, families }
}

/**
 * Restore recycle-bin entries.
 *
 * @param {object} ctx Cordis context.
 * @param {any} rawNames requested entry names.
 * @param {AbortSignal} signal request cancellation.
 * @returns {Promise<Array<object>>} one result per entry.
 */
async function restoreTrashEntries(ctx, rawNames, signal) {
  const allowed = new Set(readTrashEntries().map((entry) => entry.entryName))
  const registry = ctx.get('workspaceRegistry')
  const results = []

  for (const rawName of Array.isArray(rawNames) ? rawNames : []) {
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
      results.push({ entryName: rawName, sessionId: manifest.id, status: 'restored' })
    } catch (error) {
      trace('restore', 'end', `throw entry=${rawName} ${describeError(error)}`)
      results.push({ entryName: rawName, status: 'failed', reason: describeError(error) })
    }
  }

  return results
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
          const families = await buildDeletePreflight(
            ctx,
            normalizeIds(body.sessionIds),
            request.signal,
            body.includeForks === true,
          )
          return jsonResponse({ ok: true, families })
        },
      },
      {
        path: DELETE_PATH,
        label: 'delete',
        handler: async (request) => {
          const body = await readJsonBody(request)
          const outcome = await trashSessions(ctx, body.sessionIds, request.signal, body.includeForks === true)
          return jsonResponse({ ok: true, results: outcome.results, families: outcome.families })
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
          const results = await restoreTrashEntries(ctx, body.entryNames, request.signal)
          return jsonResponse({ ok: true, results })
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
            return jsonResponse({
              ok: false,
              error: { code: `${route.label}-failed`, message: describeError(error) },
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
}
