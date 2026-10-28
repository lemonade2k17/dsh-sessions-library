// Client half of the sessions-library bundle.
//
// Registered surfaces:
//   - `sidebar.panellist` (list slot): the sidebar entry, id `sessions-library`
//   - `main` (keyed slot): the page, key `sessions-library`
// Both use the same id so clicking the sidebar entry selects this page.
//
// Data comes from the Host half's snapshot route; the page never folds session
// logs and never touches the filesystem.
window.__ModuleLoader__.load({
  id: 'dsh-sessions-library',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Sessions shown per group before "view all". */
    const PREVIEW_LIMIT = 5
    const SNAPSHOT_PATH = 'api/sessions-library/snapshot'
    const LOGS_PATH = 'api/sessions-library/logs'
    const LOGS_CLEAR_PATH = 'api/sessions-library/logs-clear'
    const LOGS_LIMIT = 500
    const DELETE_PROGRESS_PATH = 'api/sessions-library/delete-progress'
    const EXPORT_PATH = 'api/sessions-library/export'
    const EXPORT_DIR_STORAGE_KEY = 'dsh-sessions-library:export-dir'

    /**
     * Read the last chosen export directory.
     *
     * @returns {string} saved path, or an empty string for the default location.
     */
    function loadExportDir() {
      try {
        const stored = window.localStorage.getItem(EXPORT_DIR_STORAGE_KEY)
        return typeof stored === 'string' ? stored : ''
      } catch {
        return ''
      }
    }

    /**
     * Remember the chosen export directory for the next export.
     *
     * @param {string} path chosen directory, empty for the default location.
     */
    function saveExportDir(path) {
      try {
        if (typeof path === 'string' && path.trim() !== '') {
          window.localStorage.setItem(EXPORT_DIR_STORAGE_KEY, path.trim())
        } else {
          window.localStorage.removeItem(EXPORT_DIR_STORAGE_KEY)
        }
      } catch {
        // Remembering the path is cosmetic.
      }
    }

    /** Forget the chosen export directory (a DSH restart starts from default). */
    function clearExportDir() {
      try {
        window.localStorage.removeItem(EXPORT_DIR_STORAGE_KEY)
      } catch {
        // Storage is best effort.
      }
    }

    /**
     * Token identifying one delete batch's live progress on the Host.
     *
     * @returns {string} a short unique token.
     */
    function makeProgressToken() {
      try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
      } catch {
        // Fall through to the timestamp token.
      }
      return `t-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    }

    // Human text for every action the Host records in the operation history.
    const LOG_ACTION_TEXT = {
      trash: '被移入回收站',
      defer: '被移入回收站（重启后完成整理）',
      'flush-trash': '已完成延迟整理，移入回收站',
      restore: '被恢复',
      purge: '被永久删除',
      'flush-purge': '被永久删除（延迟执行）',
      'queue-purge': '被排队永久删除（重启后执行）',
      'cancel-purge': '取消了排队永久删除',
      export: '被导出为会话包',
    }

    /**
     * Render one operation record as a sentence.
     *
     * @param {object} entry operation record.
     * @returns {string} the sentence.
     */
    function formatLogEntry(entry) {
      const title = entry && typeof entry.title === 'string' && entry.title.trim() !== ''
        ? entry.title
        : (entry && typeof entry.sessionId === 'string' && entry.sessionId !== '' ? entry.sessionId : '未知会话')
      const role = entry && typeof entry.role === 'string' ? entry.role : 'root'
      const roleSuffix = role === 'subagent' ? '（子智能体/队友）' : role === 'fork' ? '（分叉）' : ''
      const action = entry && typeof entry.action === 'string' ? entry.action : ''
      return `「${title}」${roleSuffix}${LOG_ACTION_TEXT[action] || '有一条操作记录'}`
    }

    // Last successful snapshot: a re-opened panel renders it immediately and
    // refreshes in the background, so only the very first open waits.
    let cachedSnapshot = null
    // Host boot identity this page already synchronized with.
    let knownBootAt = null

    /**
     * Collect every session id a snapshot carries.
     *
     * @param {object | null} snapshot snapshot payload.
     * @returns {string[]} session ids.
     */
    function collectSessionIds(snapshot) {
      if (!snapshot) return []
      const ids = []
      for (const group of snapshot.workspaces || []) {
        for (const session of group.sessions || []) ids.push(session.id)
      }
      for (const session of snapshot.ungrouped?.sessions || []) ids.push(session.id)
      return ids
    }

    const EXPANDED_STORAGE_KEY = 'dsh-sessions-library:expanded'

    /**
     * Keep only the ids recorded as expanded.
     *
     * @param {any} value raw map.
     * @returns {object} group id to true.
     */
    function expandedIdsOf(value) {
      const result = {}
      if (!value || typeof value !== 'object' || Array.isArray(value)) return result
      for (const key of Object.keys(value)) {
        if (value[key] === true) result[key] = true
      }
      return result
    }

    /**
     * Read the recorded expansion state, one map per filter view.
     * Legacy flat maps are adopted as the unarchived view's state.
     *
     * @returns {{ unarchived: object, all: object }} expansion state per view.
     */
    function loadExpandedGroups() {
      try {
        const raw = window.localStorage.getItem(EXPANDED_STORAGE_KEY)
        if (!raw) return { unarchived: {}, all: {} }
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return { unarchived: {}, all: {} }
        }
        if (parsed.unarchived !== undefined || parsed.all !== undefined) {
          return {
            unarchived: expandedIdsOf(parsed.unarchived),
            all: expandedIdsOf(parsed.all),
          }
        }
        return { unarchived: expandedIdsOf(parsed), all: {} }
      } catch {
        return { unarchived: {}, all: {} }
      }
    }

    /**
     * Persist the per-view expansion state.
     *
     * @param {{ unarchived: object, all: object }} expanded expansion state per view.
     */
    function saveExpandedGroups(expanded) {
      try {
        window.localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify(expanded))
      } catch {
        // Storage is best effort; the in-memory state still applies.
      }
    }

    const FILTER_STORAGE_KEY = 'dsh-sessions-library:filter'

    /**
     * Read the recorded filter view; the first visit starts on unarchived.
     *
     * @returns {string} 'unarchived' or 'all'.
     */
    function loadFilterState() {
      try {
        const raw = window.localStorage.getItem(FILTER_STORAGE_KEY)
        return raw === 'all' ? 'all' : 'unarchived'
      } catch {
        return 'unarchived'
      }
    }

    /**
     * Persist the filter view.
     *
     * @param {string} filter 'unarchived' or 'all'.
     */
    function saveFilterState(filter) {
      try {
        window.localStorage.setItem(FILTER_STORAGE_KEY, filter)
      } catch {
        // Storage is best effort; the in-memory state still applies.
      }
    }

    const BOOT_STORAGE_KEY = 'dsh-sessions-library:boot'

    /**
     * Read the Host boot timestamp remembered by this browser.
     *
     * @returns {number | null} the stored boot timestamp, when present.
     */
    function loadBootAt() {
      try {
        const value = Number(window.localStorage.getItem(BOOT_STORAGE_KEY))
        return Number.isFinite(value) && value > 0 ? value : null
      } catch {
        return null
      }
    }

    /**
     * Persist the Host boot timestamp.
     *
     * @param {number} bootAt epoch milliseconds.
     */
    function saveBootAt(bootAt) {
      try {
        window.localStorage.setItem(BOOT_STORAGE_KEY, String(bootAt))
      } catch {
        // Storage is best effort.
      }
    }

    const CSS = [
      '.sl-root { position: relative; height: 100%; min-height: 0; display: flex; flex-direction: column; color: inherit; }',
      '.sl-root * { box-sizing: border-box; }',
      '.sl-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 4px 24px 106px; }',
      '.sl-scroll::-webkit-scrollbar { width: 10px; }',
      '.sl-scroll::-webkit-scrollbar-thumb { background: color-mix(in srgb, currentColor 18%, transparent); border-radius: 8px; border: 3px solid transparent; background-clip: content-box; }',
      '.sl-group-head:hover { background: color-mix(in srgb, currentColor 6%, transparent); }',
      '.sl-row:hover { background: color-mix(in srgb, currentColor 8%, transparent); }',
      '.sl-btn:hover { background: color-mix(in srgb, currentColor 8%, transparent); }',
      '.sl-btn:disabled { cursor: not-allowed; opacity: 0.5; }',
      '.sl-fab:hover:not(:disabled) { background: color-mix(in srgb, currentColor 18%, Canvas); }',
      // Export dock backdrop: dark edges over a light theme, light edges over a
      // dark theme, so the strip stays visible in both palettes.
      '.sl-dock { background: linear-gradient(180deg, rgba(28, 32, 38, 0.04) 0%, rgba(110, 116, 126, 0.025) 26%, rgba(235, 238, 243, 0.015) 50%, rgba(110, 116, 126, 0.025) 74%, rgba(28, 32, 38, 0.04) 100%); }',
      'body[data-ds-dark-theme] .sl-dock { background: linear-gradient(180deg, rgba(243, 246, 249, 0.04) 0%, rgba(196, 202, 210, 0.025) 26%, rgba(118, 124, 134, 0.02) 50%, rgba(196, 202, 210, 0.025) 74%, rgba(243, 246, 249, 0.04) 100%); }',
      '.sl-input::placeholder { color: color-mix(in srgb, currentColor 45%, transparent); }',
      '.sl-input:focus { outline: 2px solid color-mix(in srgb, currentColor 28%, transparent); outline-offset: -1px; }',
    ].join('\n')

    /** Sidebar entry icon; the panellist passes the host size. */
    function LibraryIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 20
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M4 6.5h16' }),
        h('path', { d: 'M4 12h16' }),
        h('path', { d: 'M4 17.5h9' }),
        h('path', { d: 'M15.5 15l3 2.5-3 2.5' }),
      )
    }

    /**
     * Render a compact relative time label.
     *
     * @param {number} timestamp epoch milliseconds.
     * @returns {string} the label.
     */
    function formatRelative(timestamp) {
      if (typeof timestamp !== 'number' || timestamp <= 0) return ''
      const minutes = Math.floor((Date.now() - timestamp) / 60000)
      if (minutes < 1) return '刚刚'
      if (minutes < 60) return `${minutes} 分钟前`
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return `${hours} 小时前`
      const days = Math.floor(hours / 24)
      if (days < 7) return `${days} 天前`
      const date = new Date(timestamp)
      const month = `${date.getMonth() + 1}`.padStart(2, '0')
      const day = `${date.getDate()}`.padStart(2, '0')
      return `${month}-${day}`
    }

    /**
     * Format a timestamp as a local, second-precise wall-clock label.
     *
     * @param {number} timestamp epoch milliseconds.
     * @returns {string} `YYYY-MM-DD HH:mm:ss`, or an empty string for no value.
     */
    function formatAbsolute(timestamp) {
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) return ''
      const date = new Date(timestamp)
      const pad = (value) => String(value).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
        + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    /**
     * Normalize the Host report about how much of a batch the Host accepts.
     *
     * @param {any} value raw payload field.
     * @returns {{ max: number, requested: number, accepted: number } | null} limit info.
     */
    function readBatchLimit(value) {
      if (!value || typeof value !== 'object') return null
      const max = Number(value.max)
      const requested = Number(value.requested)
      const accepted = Number(value.accepted)
      if (!Number.isFinite(max) || !Number.isFinite(requested) || !Number.isFinite(accepted)) return null
      return { max, requested, accepted }
    }

    /**
     * Order pinned sessions first, then most recently active first.
     *
     * @param {object} left session.
     * @param {object} right session.
     * @returns {number} comparator result.
     */
    function compareSessions(left, right) {
      if (left.pinned !== right.pinned) return left.pinned ? -1 : 1
      return (right.updatedAt || 0) - (left.updatedAt || 0)
    }

    /**
     * Order sessions for the library list: unarchived rows first, then archived
     * rows, each block by recency (pinned rows lead inside their block).
     *
     * @param {object} left session.
     * @param {object} right session.
     * @returns {number} comparator result.
     */
    function compareListSessions(left, right) {
      const leftArchived = left.archived === true
      const rightArchived = right.archived === true
      if (leftArchived !== rightArchived) return leftArchived ? 1 : -1
      return compareSessions(left, right)
    }

    /**
     * Read the Host snapshot, retrying once with an absolute path when the
     * document-relative URL does not resolve.
     *
     * @returns {Promise<object>} the snapshot payload.
     */
    async function fetchSnapshot() {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 20000)
      const request = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        signal: controller.signal,
      }
      try {
        let response = await fetch(SNAPSHOT_PATH, request)
        if (!response.ok && response.status === 404) {
          response = await fetch(`/${SNAPSHOT_PATH}`, request)
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const payload = await response.json()
        if (payload && payload.ok === false) {
          throw new Error(payload.error?.message || 'snapshot failed')
        }
        return payload
      } catch (failure) {
        if (failure && failure.name === 'AbortError') {
          throw new Error('读取超时（20 秒）')
        }
        throw failure
      } finally {
        clearTimeout(timer)
      }
    }

    /**
     * POST a JSON body to one plugin route.
     *
     * @param {string} path route path relative to the document.
     * @param {object} body request payload.
     * @returns {Promise<object>} the parsed response payload.
     */
    async function postJson(path, body) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 30000)
      try {
        const response = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
          signal: controller.signal,
        })
        if (response.status === 404) {
          throw new Error('插件 Host 端尚未加载新版本，请重启桌面应用后重试')
        }
        // Domain errors answer with a JSON body even on a 5xx status, so read it
        // first and surface its message plus the stable code.
        let payload = null
        try {
          payload = await response.json()
        } catch {
          payload = null
        }
        if (!response.ok || (payload && payload.ok === false)) {
          const message = payload && payload.error && payload.error.message
            ? payload.error.message
            : `HTTP ${response.status}`
          const error = new Error(message)
          if (payload && payload.error && typeof payload.error.code === 'string') {
            error.code = payload.error.code
          }
          throw error
        }
        return payload
      } finally {
        clearTimeout(timer)
      }
    }

    /**
     * Build the page component with access to the plugin context.
     *
     * @param {object} ctx Client Cordis context.
     * @returns {Function} the page component.
     */
    function makePage(ctx) {
      return function SessionsLibraryPage() {
        const [phase, setPhase] = React.useState(cachedSnapshot ? 'ready' : 'loading')
        const [error, setError] = React.useState(null)
        const [refreshError, setRefreshError] = React.useState(null)
        const [addedCount, setAddedCount] = React.useState(0)
        const [snapshot, setSnapshot] = React.useState(cachedSnapshot)
        const [filter, setFilter] = React.useState(loadFilterState)
        // First open starts fully collapsed; each workspace records its own
        // state and the next open restores it.
        const [expandedByFilter, setExpandedByFilter] = React.useState(loadExpandedGroups)
        const [showAll, setShowAll] = React.useState({})
        const [selected, setSelected] = React.useState({})
        const [view, setView] = React.useState('library')
        const [trash, setTrash] = React.useState([])
        const [trashPhase, setTrashPhase] = React.useState('idle')
        const [trashError, setTrashError] = React.useState(null)
        const [trashNotice, setTrashNotice] = React.useState(null)
        const [dialog, setDialog] = React.useState(null)
        const [trashSelected, setTrashSelected] = React.useState({})
        const [purgeDialog, setPurgeDialog] = React.useState(null)
        const [logs, setLogs] = React.useState([])
        const [logsPhase, setLogsPhase] = React.useState('idle')
        const [logsError, setLogsError] = React.useState(null)
        const [clearLogsDialog, setClearLogsDialog] = React.useState(false)
        const [exportDialog, setExportDialog] = React.useState(null)
        const [exportTarget, setExportTarget] = React.useState(loadExportDir)
        // Non-null while asking whether a missing export folder should be created.
        const [createDirPrompt, setCreateDirPrompt] = React.useState(null)
        const [trashQuery, setTrashQuery] = React.useState('')
        const [trashSort, setTrashSort] = React.useState('newest')
        const [logsQuery, setLogsQuery] = React.useState('')
        const [logsSort, setLogsSort] = React.useState('newest')
        const [query, setQuery] = React.useState('')
        const [reloadToken, setReloadToken] = React.useState(0)

        // The effect reads the newest snapshot without depending on it.
        const snapshotRef = React.useRef(snapshot)
        snapshotRef.current = snapshot
        // The poll reads the current view without restarting its interval.
        const viewRef = React.useRef(view)
        viewRef.current = view

        React.useEffect(() => {
          let cancelled = false
          const previous = snapshotRef.current
          setRefreshError(null)
          if (!previous) setPhase('loading')
          fetchSnapshot()
            .then((data) => {
              if (cancelled) return
              const previousIds = new Set(collectSessionIds(previous))
              const added = previousIds.size === 0
                ? 0
                : collectSessionIds(data).filter((id) => !previousIds.has(id)).length
              applyBootBoundary(data)
              cachedSnapshot = data
              setSnapshot(data)
              setAddedCount(added)
              setError(null)
              setPhase('ready')
            })
            .catch((failure) => {
              if (cancelled) return
              const message = failure && failure.message ? failure.message : String(failure)
              if (previous) {
                setRefreshError(message)
                setPhase('ready')
              } else {
                setError(message)
                setPhase('error')
              }
            })
          return () => {
            cancelled = true
          }
        }, [reloadToken])

        // Visible-page polling: archiving happens in the native sidebar, files
        // move on other views, and the startup flush turns deferred deletions
        // into real bin entries. The view that is on screen re-reads its data
        // every 15s; hidden tabs pause and refresh once when they come back.
        React.useEffect(() => {
          let timer = null
          const isVisible = () => document.visibilityState !== 'hidden'
          const stop = () => {
            if (timer !== null) {
              clearInterval(timer)
              timer = null
            }
          }
          const tick = () => {
            if (!isVisible()) return
            if (viewRef.current === 'trash') {
              // Silent: a poll must not flash the loading or error placeholder.
              refreshTrash({ silent: true })
            } else if (viewRef.current === 'logs') {
              refreshLogs({ silent: true })
            } else {
              setReloadToken((token) => token + 1)
            }
          }
          const start = () => {
            if (timer !== null || !isVisible()) return
            timer = setInterval(tick, 15000)
          }
          const onVisibility = () => {
            if (isVisible()) {
              start()
              tick()
            } else {
              stop()
            }
          }
          start()
          document.addEventListener('visibilitychange', onVisibility)
          return () => {
            stop()
            document.removeEventListener('visibilitychange', onVisibility)
          }
        }, [])

        // Every group, independent of the filter and the query.
        const allGroups = React.useMemo(() => {
          if (!snapshot) return []
          const keep = (session) => session.origin !== 'subagent' && session.blank !== true
          const groups = []
          for (const group of snapshot.workspaces || []) {
            const sessions = (group.sessions || []).filter(keep).sort(compareListSessions)
            groups.push({
              kind: 'workspace',
              id: group.id,
              title: group.title || group.path || '未命名工作区',
              path: group.path,
              sessions,
            })
          }
          const ungrouped = (snapshot.ungrouped?.sessions || []).filter(keep).sort(compareListSessions)
          groups.push({ kind: 'ungrouped', id: '__ungrouped__', title: '未分组', sessions: ungrouped })
          return groups
        }, [snapshot])

        const totals = React.useMemo(() => {
          let total = 0
          let archived = 0
          for (const group of allGroups) {
            total += group.sessions.length
            for (const session of group.sessions) if (session.archived) archived += 1
          }
          return { total, archived, active: total - archived }
        }, [allGroups])

        // Groups as displayed: filter + query applied, empty groups dropped.
        const groups = React.useMemo(() => {
          const lowered = query.trim().toLowerCase()
          const isVisible = (session) => (filter === 'all' ? true : !session.archived)
          const matches = (session, groupTitle) => {
            if (lowered === '') return true
            const title = (session.title || '').toLowerCase()
            return title.includes(lowered) || groupTitle.toLowerCase().includes(lowered)
          }
          const result = []
          for (const group of allGroups) {
            const sessions = group.sessions.filter(
              (session) => isVisible(session) && matches(session, group.title),
            )
            if (sessions.length === 0) continue
            result.push({ ...group, sessions, totalSessions: group.sessions.length })
          }
          return result
        }, [allGroups, filter, query])

        // Recycle-bin entries grouped into the families they were deleted as,
        // then narrowed by the bin search and ordered by the chosen sort.
        const trashFamilies = React.useMemo(() => {
          const lowered = trashQuery.trim().toLowerCase()
          const families = []
          const byFamily = new Map()
          for (const entry of trash) {
            const key = entry.familyRoot || entry.sessionId
            if (!byFamily.has(key)) {
              const family = { key, entries: [], deletedAt: 0, totalBytes: 0 }
              byFamily.set(key, family)
              families.push(family)
            }
            const family = byFamily.get(key)
            family.entries.push(entry)
            family.deletedAt = Math.max(family.deletedAt, entry.deletedAt || 0)
            family.totalBytes += entry.sizeBytes || 0
          }
          const matches = (family) => lowered === '' || family.entries.some((entry) => {
            const title = typeof entry.title === 'string' ? entry.title.toLowerCase() : ''
            const id = typeof entry.sessionId === 'string' ? entry.sessionId.toLowerCase() : ''
            return title.includes(lowered) || id.includes(lowered)
          })
          const visible = families.filter(matches)
          switch (trashSort) {
            case 'oldest':
              visible.sort((left, right) => left.deletedAt - right.deletedAt)
              break
            case 'largest':
              visible.sort((left, right) => right.totalBytes - left.totalBytes)
              break
            case 'smallest':
              visible.sort((left, right) => left.totalBytes - right.totalBytes)
              break
            default:
              visible.sort((left, right) => right.deletedAt - left.deletedAt)
          }
          return visible
        }, [trash, trashQuery, trashSort])

        // Operation-log rows after the query and the time order are applied.
        const visibleLogs = React.useMemo(() => {
          const lowered = logsQuery.trim().toLowerCase()
          const matches = (entry) => {
            if (lowered === '') return true
            const message = formatLogEntry(entry).toLowerCase()
            const title = typeof entry.title === 'string' ? entry.title.toLowerCase() : ''
            const id = typeof entry.sessionId === 'string' ? entry.sessionId.toLowerCase() : ''
            return message.includes(lowered) || title.includes(lowered) || id.includes(lowered)
          }
          const rows = logs.filter(matches)
          rows.sort((left, right) => {
            const leftAt = Date.parse(left && left.at) || 0
            const rightAt = Date.parse(right && right.at) || 0
            return logsSort === 'oldest' ? leftAt - rightAt : rightAt - leftAt
          })
          return rows
        }, [logs, logsQuery, logsSort])

        const visibleCount = groups.reduce((sum, group) => sum + group.sessions.length, 0)
        // Count only what is on screen, so a filter change cannot show a
        // selection the user cannot see.
        const selectedCount = groups.reduce(
          (sum, group) => sum + group.sessions.filter((session) => selected[session.id] === true).length,
          0,
        )
        // Expansion is tracked per filter view, so 未归档 and 全部会话 keep
        // independent expansion state.
        const expandedGroups = expandedByFilter[filter] || {}
        const anyOpen = groups.some((group) => expandedGroups[group.id] === true)
        const selectedTrashFamilies = trashFamilies.filter((family) => trashSelected[family.key] === true)
        const selectedTrashEntries = selectedTrashFamilies.flatMap((family) => family.entries)
        const selectedTrashCount = selectedTrashEntries.length
        const allTrashSelected = trashFamilies.length > 0
          && trashFamilies.every((family) => trashSelected[family.key] === true)

        /** Select one session in the Conversation. */
        function openSession(sessionId) {
          try {
            const uiWorkspace = ctx.get('uiWorkspace')
            if (uiWorkspace && typeof uiWorkspace.openSession === 'function') {
              uiWorkspace.openSession(sessionId)
            }
          } catch (failure) {
            // Navigation failure must not break the page.
          }
        }

        /**
         * Re-pull the Native session list after this plugin moved files.
         *
         * The Native sidebar renders workspace members intersected with the
         * Client session list, and that list is only re-pulled on connect or
         * through this call. Moving files is an external change that produces
         * no Host event, so without this the restored row stays missing (and a
         * deleted row lingers) until the page reloads.
         */
        function refreshNativeSessionList() {
          try {
            const sessions = ctx.get('sessions')
            if (sessions && typeof sessions.refresh === 'function') {
              Promise.resolve(sessions.refresh()).catch(() => {})
            }
          } catch {
            // Without the session controller the list refreshes on page reload,
            // so a failure here only delays the row.
          }
        }

        function toggleGroup(groupId) {
          setExpandedByFilter((current) => {
            const scoped = { ...(current[filter] || {}) }
            if (scoped[groupId] === true) delete scoped[groupId]
            else scoped[groupId] = true
            const next = { ...current, [filter]: scoped }
            saveExpandedGroups(next)
            return next
          })
        }

        function toggleAllGroups() {
          const scoped = {}
          if (!anyOpen) {
            for (const group of groups) scoped[group.id] = true
          }
          const next = { ...expandedByFilter, [filter]: scoped }
          saveExpandedGroups(next)
          setExpandedByFilter(next)
        }

        function toggleShowAll(groupId) {
          setShowAll((current) => ({ ...current, [groupId]: !current[groupId] }))
        }

        /**
         * Tri-state selection of one group's displayed sessions.
         *
         * @param {object} map session id to whether it is selected.
         * @param {Array<object>} sessions displayed sessions.
         * @returns {string} 'none' | 'partial' | 'all'.
         */
        function selectionStateOf(map, sessions) {
          if (sessions.length === 0) return 'none'
          let count = 0
          for (const session of sessions) if (map[session.id] === true) count += 1
          if (count === 0) return 'none'
          return count === sessions.length ? 'all' : 'partial'
        }

        function toggleSession(sessionId) {
          setSelected((current) => {
            const next = { ...current }
            if (next[sessionId] === true) delete next[sessionId]
            else next[sessionId] = true
            return next
          })
        }

        function toggleGroupSelection(sessions) {
          setSelected((current) => {
            const next = { ...current }
            if (selectionStateOf(current, sessions) === 'all') {
              for (const session of sessions) delete next[session.id]
            } else {
              for (const session of sessions) next[session.id] = true
            }
            return next
          })
        }

        function clearSelection() {
          setSelected({})
        }

        function changeFilter(value) {
          saveFilterState(value)
          setFilter(value)
        }

        /**
         * Restore the first-visit defaults: unarchived view, every group
         * collapsed, nothing selected, and the default export location.
         */
        function resetViewState() {
          const emptyExpansion = { unarchived: {}, all: {} }
          saveExpandedGroups(emptyExpansion)
          saveFilterState('unarchived')
          setExpandedByFilter(emptyExpansion)
          setFilter('unarchived')
          setSelected({})
          setShowAll({})
          // The export destination is remembered only inside one DSH run.
          clearExportDir()
          setExportTarget('')
        }

        /**
         * Reset remembered view state when the Host process changed, so a DSH
         * restart always starts from the first-visit defaults while a panel
         * switch inside one process keeps the state.
         *
         * @param {object} snapshotData fresh snapshot payload.
         */
        function applyBootBoundary(snapshotData) {
          const bootAt = typeof snapshotData.bootAt === 'number' ? snapshotData.bootAt : null
          if (bootAt === null) return
          const stored = loadBootAt()
          if (knownBootAt === null) {
            knownBootAt = bootAt
            if (stored !== null && stored !== bootAt) resetViewState()
            saveBootAt(bootAt)
            return
          }
          if (knownBootAt !== bootAt) {
            knownBootAt = bootAt
            resetViewState()
            saveBootAt(bootAt)
          }
        }

        /**
         * Collect the selected sessions that are currently on screen.
         *
         * @returns {string[]} session ids.
         */
        function selectedVisibleIds() {
          const ids = []
          for (const group of groups) {
            for (const session of group.sessions) {
              if (selected[session.id] === true) ids.push(session.id)
            }
          }
          return ids
        }

        /**
         * Re-read the recycle bin.
         *
         * @param {{ silent?: boolean }} [options] silent keeps the current list on
         *   screen: it backs the visible-page poll, which must not flash the
         *   loading or error placeholder every time it ticks.
         * @returns {Promise<void>} resolution after the list was refreshed.
         */
        async function refreshTrash(options = {}) {
          const silent = options.silent === true
          if (!silent) {
            setTrashPhase('loading')
            setTrashError(null)
          }
          try {
            const payload = await postJson('api/sessions-library/trash-list', {})
            const entries = Array.isArray(payload.entries) ? payload.entries : []
            setTrash(entries)
            setTrashSelected((current) => {
              const keys = new Set(entries.map((entry) => entry.familyRoot || entry.sessionId))
              const next = {}
              for (const key of Object.keys(current)) if (keys.has(key)) next[key] = true
              return next
            })
            setTrashPhase('ready')
          } catch (failure) {
            // A silent failure keeps the last good list instead of replacing it
            // with an error screen the user did not ask for.
            if (silent) return
            setTrashPhase('error')
            setTrashError(failure && failure.message ? failure.message : String(failure))
          }
        }

        function openTrash() {
          setView('trash')
          setTrashNotice(null)
          // A fresh visit starts with nothing selected: a selection carried over
          // from an earlier visit would keep "永久删除" armed with stale intent.
          setTrashSelected({})
          setTrashQuery('')
          setTrashSort('newest')
          refreshTrash()
        }

        function closeTrash() {
          setView('library')
          setTrashNotice(null)
          setTrashSelected({})
          // Time spent in the bin may have changed the library (restores and
          // purges), so pull a fresh snapshot when the library comes back.
          setReloadToken((token) => token + 1)
        }

        /**
         * Read the operation history.
         *
         * @param {{ silent?: boolean }} [options] silent keeps the current list on
         *   screen instead of flashing the loading or error placeholder.
         * @returns {Promise<void>} resolution after the list was refreshed.
         */
        async function refreshLogs(options = {}) {
          const silent = options.silent === true
          if (!silent) {
            setLogsPhase('loading')
            setLogsError(null)
          }
          try {
            const payload = await postJson(LOGS_PATH, { limit: LOGS_LIMIT })
            setLogs(Array.isArray(payload.entries) ? payload.entries : [])
            setLogsPhase('ready')
          } catch (failure) {
            if (silent) return
            setLogsPhase('error')
            setLogsError(failure && failure.message ? failure.message : String(failure))
          }
        }

        function openLogs() {
          setView('logs')
          setLogsError(null)
          setLogsQuery('')
          setLogsSort('newest')
          refreshLogs()
        }

        function closeLogs() {
          setView('library')
          setLogsError(null)
          setReloadToken((token) => token + 1)
        }

        async function confirmClearLogs() {
          setClearLogsDialog(false)
          try {
            await postJson(LOGS_CLEAR_PATH, {})
            setLogs([])
            setLogsPhase('ready')
            setLogsError(null)
          } catch (failure) {
            setLogsError(failure && failure.message ? failure.message : String(failure))
          }
        }

        async function beginDelete(includeForks) {
          const ids = selectedVisibleIds()
          if (ids.length === 0) return
          const withForks = includeForks === true
          setDialog({ phase: 'loading', families: [], results: [], includeForks: withForks, error: null, limit: null })
          try {
            const payload = await postJson('api/sessions-library/delete-preflight', {
              sessionIds: ids,
              includeForks: withForks,
            })
            setDialog({
              phase: 'ready',
              families: Array.isArray(payload.families) ? payload.families : [],
              results: [],
              includeForks: withForks,
              error: null,
              limit: readBatchLimit(payload.limit),
            })
          } catch (failure) {
            setDialog({
              phase: 'error',
              families: [],
              results: [],
              includeForks: withForks,
              error: failure && failure.message ? failure.message : String(failure),
              limit: null,
            })
          }
        }

        function toggleIncludeForks() {
          beginDelete(dialog === null || dialog.includeForks !== true)
        }

        /**
         * Open the export dialog, defaulting to the last used directory.
         *
         * @returns {void}
         */
        function openExportDialog() {
          if (selectedVisibleIds().length === 0) return
          setExportDialog({
            phase: 'choose',
            path: '',
            fileName: '',
            sessionCount: 0,
            workspaceCount: 0,
            bytes: 0,
            error: null,
          })
        }

        /**
         * Ask the native directory picker for an export destination.
         *
         * @returns {Promise<void>} resolution after the picker settled.
         */
        async function pickExportDirectory() {
          try {
            // Remote namespaces are mounted as `remote.<namespace>` services, so
            // the picker is fetched by its service key: reading it off the Remote
            // object would trip the inject guard instead.
            const picker = ctx.get('remote.directoryPicker')
            if (!picker || typeof picker.pick !== 'function') {
              setExportDialog((current) => (current
                ? { ...current, error: '当前环境不支持文件夹选择；可以直接输入路径，或留空使用默认位置。' }
                : current))
              return
            }
            const result = await picker.pick()
            if (!result || result.ok !== true) {
              const message = result && result.error && result.error.message
                ? result.error.message
                : '选择文件夹失败'
              setExportDialog((current) => (current ? { ...current, error: message } : current))
              return
            }
            if (typeof result.value !== 'string' || result.value.trim() === '') return
            setExportTarget(result.value)
            setExportDialog((current) => (current ? { ...current, error: null } : current))
          } catch (failure) {
            setExportDialog((current) => (current
              ? { ...current, error: failure && failure.message ? failure.message : String(failure) }
              : current))
          }
        }

        /**
         * Package the selected sessions into the chosen directory.
         *
         * @param {boolean} [createDir] whether a missing destination may be created.
         * @returns {Promise<void>} resolution after the dialog state settled.
         */
        async function beginExport(createDir = false) {
          const ids = selectedVisibleIds()
          if (ids.length === 0) return
          const targetDir = exportTarget.trim()
          setExportDialog((current) => ({ ...(current || {}), phase: 'busy', error: null }))
          try {
            const payload = await postJson(EXPORT_PATH, {
              sessionIds: ids,
              ...(targetDir !== '' ? { targetDir } : {}),
              ...(createDir === true ? { createDir: true } : {}),
            })
            saveExportDir(targetDir)
            setExportDialog({
              phase: 'done',
              fileName: typeof payload.fileName === 'string' ? payload.fileName : '',
              path: typeof payload.path === 'string' ? payload.path : '',
              sessionCount: Number(payload.sessionCount) || 0,
              workspaceCount: Number(payload.workspaceCount) || 0,
              bytes: Number(payload.bytes) || 0,
              error: null,
            })
          } catch (failure) {
            // A missing folder is not a hard failure: ask the user whether to
            // create it, and keep the chooser open instead of showing an error.
            if (failure && failure.code === 'export-dir-missing' && targetDir !== '') {
              setCreateDirPrompt({ targetDir })
              setExportDialog((current) => (current ? { ...current, phase: 'choose', error: null } : current))
              return
            }
            setExportDialog({
              phase: 'error',
              path: '',
              fileName: '',
              sessionCount: 0,
              error: failure && failure.message ? failure.message : String(failure),
            })
          }
        }

        async function confirmDelete() {
          const ids = selectedVisibleIds()
          if (ids.length === 0) return
          const withForks = dialog === null || dialog.includeForks === true
          const progressToken = makeProgressToken()
          setDialog((current) => ({
            ...(current || {}),
            phase: 'busy',
            progress: { done: 0, total: 0, current: '' },
          }))
          let pollTimer = null
          const stopPolling = () => {
            if (pollTimer !== null) {
              clearInterval(pollTimer)
              pollTimer = null
            }
          }
          const pollProgress = async () => {
            try {
              const payload = await postJson(DELETE_PROGRESS_PATH, { token: progressToken })
              const progress = payload && payload.progress
              if (!progress || typeof progress !== 'object') return
              setDialog((current) => (current && current.phase === 'busy'
                ? {
                    ...current,
                    progress: {
                      done: Number(progress.done) || 0,
                      total: Number(progress.total) || 0,
                      current: typeof progress.current === 'string' ? progress.current : '',
                    },
                  }
                : current))
            } catch {
              // Progress is cosmetic; a failed poll must not break the delete.
            }
          }
          pollTimer = setInterval(pollProgress, 350)
          pollProgress()
          try {
            const payload = await postJson('api/sessions-library/delete', {
              sessionIds: ids,
              includeForks: withForks,
              progressToken,
            })
            const results = Array.isArray(payload.results) ? payload.results : []
            const trashedIds = results.filter((result) => result.status === 'trashed').map((result) => result.id)
            const deferredCount = results.filter((result) => result.status === 'deferred').length
            setDialog((current) => ({
              ...(current || {}),
              phase: 'done',
              results,
              limit: readBatchLimit(payload.limit) || (current && current.limit) || null,
            }))
            // Keep the bin warm without leaving the library: the next visit sees
            // the new entries, and a deferred one is listed as pending at once.
            if (trashedIds.length > 0 || deferredCount > 0) refreshTrash({ silent: true })
            if (trashedIds.length > 0) {
              setSelected((current) => {
                const next = { ...current }
                for (const id of trashedIds) delete next[id]
                return next
              })
              setReloadToken((token) => token + 1)
              // Drop the deleted rows from the Native list as well; the offline
              // move emits no Host event, so it would otherwise stay stale.
              refreshNativeSessionList()
            }
          } catch (failure) {
            setDialog((current) => ({
              ...(current || {}),
              phase: 'error',
              error: failure && failure.message ? failure.message : String(failure),
            }))
          } finally {
            stopPolling()
          }
        }

        /**
         * Cancel a queued permanent delete without restoring the session.
         *
         * The session stays deleted: it keeps its pending record, remains hidden
         * from both the library and the Native sidebar, and the next start moves
         * it into the recycle bin as usual.
         *
         * @param {string[]} entryNames pending entry names to un-queue.
         * @returns {Promise<void>} resolution after the recycle bin refreshed.
         */
        async function cancelQueuedPurge(entryNames) {
          if (!Array.isArray(entryNames) || entryNames.length === 0) return
          setTrashError(null)
          setTrashNotice(null)
          try {
            const payload = await postJson('api/sessions-library/trash-restore', {
              entryNames,
              cancelPurgeOnly: true,
            })
            const results = Array.isArray(payload.results) ? payload.results : []
            const failed = results.find((result) => result.status !== 'canceled')
            if (failed) {
              setTrashError(failed.reason || '取消失败')
              await refreshTrash()
              return
            }
            // Verify what really happened: a Host that predates the flag ignores
            // it and restores the session instead, which must never pass unseen.
            const listPayload = await postJson('api/sessions-library/trash-list', {})
            const list = Array.isArray(listPayload.entries) ? listPayload.entries : []
            const stillListed = entryNames.every((name) => list.some((entry) => entry.entryName === name))
            if (!stillListed) {
              setTrashError('取消永久删除没有按预期生效：Host 端可能仍在运行旧版本，会话已被按旧逻辑恢复。请完全退出并重新打开 DSH 后，重新删除该会话并重试。')
              refreshNativeSessionList()
            } else {
              setTrashNotice('已取消永久删除：会话仍在回收站（待重启整理），重启 DSH 后照常移入回收站，不会被删除。如需把会话找回来，现在会显示「恢复会话」按钮。')
            }
            await refreshTrash()
          } catch (failure) {
            setTrashError(failure && failure.message ? failure.message : String(failure))
          }
        }

        async function restoreFamily(entryNames) {
          setTrashError(null)
          setTrashNotice(null)
          try {
            const payload = await postJson('api/sessions-library/trash-restore', { entryNames })
            const results = Array.isArray(payload.results) ? payload.results : []
            const failed = results.find((result) => result.status !== 'restored')
            if (failed) {
              setTrashError(failed.reason || '恢复失败')
            } else {
              setTrashNotice('已恢复。会话库立即可见；已请求原生侧边栏刷新，若未出现请刷新页面。')
              // Both kinds must show up at once: a pending entry only needed its
              // archive undone, a trashed one also needs the Client session list
              // to re-pull the row this plugin put back on disk.
              refreshNativeSessionList()
            }
            await refreshTrash()
            setReloadToken((token) => token + 1)
          } catch (failure) {
            setTrashError(failure && failure.message ? failure.message : String(failure))
          }
        }

        function toggleTrashFamily(familyKey) {
          setTrashSelected((current) => {
            const next = { ...current }
            if (next[familyKey] === true) delete next[familyKey]
            else next[familyKey] = true
            return next
          })
        }

        function toggleTrashSelectAll() {
          if (allTrashSelected) {
            setTrashSelected({})
            return
          }
          const next = {}
          for (const family of trashFamilies) next[family.key] = true
          setTrashSelected(next)
        }

        function openPurgeDialog() {
          if (selectedTrashEntries.length === 0) return
          setPurgeDialog({
            phase: 'confirm',
            families: selectedTrashFamilies,
            text: '',
            error: null,
            results: [],
          })
        }

        async function confirmPurge() {
          if (purgeDialog === null || purgeDialog.phase === 'busy') return
          if ((purgeDialog.text || '').trim() !== '永久删除') return
          const entryNames = (purgeDialog.families || []).flatMap(
            (family) => family.entries.map((entry) => entry.entryName),
          )
          setPurgeDialog((current) => ({ ...(current || {}), phase: 'busy' }))
          try {
            const payload = await postJson('api/sessions-library/trash-purge', { entryNames })
            const results = Array.isArray(payload.results) ? payload.results : []
            setPurgeDialog((current) => ({ ...(current || {}), phase: 'done', results }))
            setTrashSelected({})
            await refreshTrash()
          } catch (failure) {
            setPurgeDialog((current) => ({
              ...(current || {}),
              phase: 'confirm',
              error: failure && failure.message ? failure.message : String(failure),
            }))
          }
        }

        /**
         * Render the shared tri-state checkbox.
         *
         * @param {string} state 'none' | 'partial' | 'all'.
         * @param {Function} onToggle toggle handler.
         * @param {string} label accessible label.
         * @returns {object} React element.
         */
        function renderCheckbox(state, onToggle, label) {
          return h(
            'span',
            {
              role: 'checkbox',
              'aria-checked': state === 'all' ? 'true' : state === 'partial' ? 'mixed' : 'false',
              'aria-label': label,
              title: label,
              tabIndex: 0,
              className: 'sl-check',
              style: checkboxStyle(state),
              onClick: (event) => {
                event.stopPropagation()
                onToggle()
              },
              onKeyDown: (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                event.stopPropagation()
                onToggle()
              },
            },
            state === 'all' ? '✓' : state === 'partial' ? '−' : '',
          )
        }

        function renderSession(session) {
          const title = session.title && session.title.trim() !== '' ? session.title : '未命名'
          const badges = []
          if (session.pinned) badges.push(h('span', { key: 'pin', style: badgeStyle }, '置顶'))
          if (session.archived) badges.push(h('span', { key: 'archived', style: badgeStyle }, '已归档'))
          if (session.running) badges.push(h('span', { key: 'running', style: badgeStyle }, '运行中'))
          const checked = selected[session.id] === true
          return h(
            'div',
            {
              key: session.id,
              className: 'sl-row',
              role: 'button',
              tabIndex: 0,
              style: session.archived ? { ...rowStyle, opacity: 0.55 } : rowStyle,
              title: session.cwd || session.id,
              onClick: () => openSession(session.id),
              onKeyDown: (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                openSession(session.id)
              },
            },
            renderCheckbox(checked ? 'all' : 'none', () => toggleSession(session.id), `勾选 ${title}`),
            h('span', { style: sessionTitleStyle }, title),
            badges,
            h('span', { style: sessionTimeStyle }, formatRelative(session.updatedAt)),
          )
        }

        function renderGroup(group) {
          const open = expandedGroups[group.id] === true
          const full = showAll[group.id] === true
          const limit = full ? group.sessions.length : PREVIEW_LIMIT
          const rows = open ? group.sessions.slice(0, limit).map(renderSession) : []
          const hasMore = group.sessions.length > PREVIEW_LIMIT
          const newest = group.sessions[0]
          const countLabel = group.sessions.length === group.totalSessions
            ? `${group.sessions.length} 个会话`
            : `${group.sessions.length} / ${group.totalSessions} 个会话`

          const groupSelection = selectionStateOf(selected, group.sessions)
          const head = h(
            'div',
            {
              key: 'head',
              className: 'sl-group-head',
              role: 'button',
              tabIndex: 0,
              style: groupHeaderStyle,
              onClick: () => toggleGroup(group.id),
              onKeyDown: (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                toggleGroup(group.id)
              },
            },
            renderCheckbox(
              groupSelection,
              () => toggleGroupSelection(group.sessions),
              `勾选「${group.title}」中的会话`,
            ),
            h('span', { style: chevronStyle }, open ? '▾' : '▸'),
            h('span', { style: groupTitleStyle }, group.title),
            group.kind === 'ungrouped'
              ? h('span', { style: groupPathStyle }, '工作区之外')
              : h('span', { style: groupPathStyle, title: group.path }, group.path || ''),
            h('span', { style: groupCountStyle }, countLabel),
            h('span', { style: groupTimeStyle }, formatRelative(newest?.updatedAt)),
          )

          if (open && hasMore) {
            rows.push(
              h(
                'button',
                {
                  key: 'more',
                  className: 'sl-btn',
                  style: showAllButtonStyle,
                  onClick: () => toggleShowAll(group.id),
                },
                full ? '收起' : `查看全部 ${group.sessions.length} 条`,
              ),
            )
          }

          return h('section', { key: group.id, style: groupStyle }, head, rows)
        }

        function renderTrash() {
          if (trashPhase === 'loading' || trashPhase === 'idle') {
            return h('div', { style: placeholderStyle }, '正在读取回收站…')
          }
          if (trashPhase === 'error') {
            return h(
              'div',
              { style: placeholderStyle },
              h('div', { style: { marginBottom: 10 } }, `读取回收站失败：${trashError}`),
              h('button', { className: 'sl-btn', style: actionButtonStyle, onClick: refreshTrash }, '重试'),
            )
          }
          if (trash.length === 0) {
            return h('div', { style: placeholderStyle }, '回收站是空的')
          }
          if (trashFamilies.length === 0) {
            return h('div', { style: placeholderStyle }, '没有匹配的回收站条目')
          }

          const families = trashFamilies

          return h(
            'div',
            null,
            trashError !== null ? h('div', { style: warnStyle }, trashError) : null,
            trashNotice !== null ? h('div', { style: infoStyle }, trashNotice) : null,
            families.map((family) => {
              const rootEntry = family.entries.find((entry) => entry.role === 'root') || family.entries[0]
              const canRestore = family.entries.every((entry) => entry.restoreAvailable === true)
              const queuedNames = family.entries
                .filter((entry) => entry.purge === true)
                .map((entry) => entry.entryName)
              return h(
                'div',
                { key: family.key, style: dialogFamilyStyle },
                h(
                  'div',
                  { style: dialogFamilyHeadStyle },
                  renderCheckbox(
                    trashSelected[family.key] === true ? 'all' : 'none',
                    () => toggleTrashFamily(family.key),
                    '选择该回收站条目',
                  ),
                  h(
                    'span',
                    { style: sessionTitleStyle },
                    rootEntry.title && rootEntry.title.trim() !== '' ? rootEntry.title : rootEntry.sessionId,
                  ),
                  h('span', { style: badgeStyle }, `${family.entries.length} 个会话`),
                  h('span', { style: trashTimeStyle }, formatAbsolute(family.deletedAt)),
                  h('span', { style: trashMetaStyle }, `${(family.totalBytes / 1048576).toFixed(1)} MB`),
                  // A queued permanent delete offers exactly one action: abandon
                  // it and stay in the bin. Restoring is only offered once the
                  // entry is no longer queued for deletion.
                  queuedNames.length > 0
                    ? h(
                        'button',
                        {
                          className: 'sl-btn',
                          style: actionButtonStyle,
                          onClick: () => cancelQueuedPurge(queuedNames),
                        },
                        '放弃永久删除（留在回收站）',
                      )
                    : canRestore
                      ? h(
                          'button',
                          {
                            className: 'sl-btn',
                            style: actionButtonStyle,
                            onClick: () => restoreFamily(family.entries.map((entry) => entry.entryName)),
                          },
                          '恢复会话（回到会话库）',
                        )
                      : h('span', { style: badgeStyle }, '数据缺失'),
                ),
                family.entries.map((entry) => h(
                  'div',
                  { key: entry.entryName, style: dialogRowStyle },
                  h(
                    'span',
                    { style: badgeStyle },
                    entry.role === 'subagent' ? '子智能体/队友' : entry.role === 'fork' ? '分叉' : '会话',
                  ),
                  entry.pending === true
                    ? h('span', { style: badgeStyle }, entry.purge === true ? '待重启永久删除' : '待重启整理')
                    : null,
                  h(
                    'span',
                    { style: sessionTitleStyle },
                    entry.title && entry.title.trim() !== '' ? entry.title : entry.sessionId,
                  ),
                  // Members of one delete share the family timestamp; only a
                  // pending member (or a mixed family) carries its own.
                  entry.deletedAt !== family.deletedAt
                    ? h('span', { style: trashTimeStyle }, formatAbsolute(entry.deletedAt))
                    : null,
                  h('span', { style: trashMetaStyle }, `${(entry.sizeBytes / 1048576).toFixed(1)} MB`),
                )),
              )
            }),
          )
        }

        function renderLogs() {
          if (logsPhase === 'loading' || logsPhase === 'idle') {
            return h('div', { style: placeholderStyle }, '正在读取操作日志…')
          }
          if (logsPhase === 'error') {
            return h(
              'div',
              { style: placeholderStyle },
              h('div', { style: { marginBottom: 10 } }, `读取日志失败：${logsError}`),
              h(
                'button',
                { className: 'sl-btn', style: actionButtonStyle, onClick: () => refreshLogs() },
                '重试',
              ),
            )
          }
          if (logs.length === 0) {
            return h('div', { style: placeholderStyle }, '暂无操作日志')
          }
          if (visibleLogs.length === 0) {
            return h('div', { style: placeholderStyle }, '没有匹配的日志')
          }
          return h(
            'div',
            null,
            logsError !== null ? h('div', { style: warnStyle }, logsError) : null,
            visibleLogs.map((entry, index) => {
              const at = Date.parse(entry && entry.at)
              return h(
                'div',
                { key: `${entry && entry.at ? entry.at : ''}-${index}`, style: logsRowStyle },
                h('span', { style: logsTextStyle }, formatLogEntry(entry)),
                h('span', { style: trashTimeStyle }, formatAbsolute(Number.isFinite(at) ? at : 0)),
              )
            }),
          )
        }

        /**
         * Render the live progress of a running delete batch.
         *
         * @param {{ done?: number, total?: number, current?: string } | null} progress live progress.
         * @returns {object} React element.
         */
        function renderDeleteProgress(progress) {
          const total = progress && Number(progress.total) > 0 ? Number(progress.total) : 0
          const done = progress ? Math.max(0, Number(progress.done) || 0) : 0
          const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
          return h(
            'div',
            { style: progressBlockStyle },
            h(
              'div',
              { style: progressLabelStyle },
              total > 0 ? `正在移入回收站… ${done} / ${total}` : '正在检查并移入回收站…',
            ),
            h(
              'div',
              { style: progressTrackStyle },
              h('div', { style: progressFillStyle(pct) }),
            ),
            progress && progress.current
              ? h('div', { style: progressCurrentStyle }, progress.current)
              : null,
          )
        }

        function renderDialog() {
          const families = dialog.families || []
          const results = dialog.results || []
          const trashed = results.filter((result) => result.status === 'trashed')
          const deferred = results.filter((result) => result.status === 'deferred')
          const skipped = results.filter((result) => result.status !== 'trashed' && result.status !== 'deferred')
          const blocked = families.filter((family) => family.canTrash === false)
          const memberTotal = families.reduce((sum, family) => sum + family.memberCount, 0)
          const forkTotal = families.reduce((sum, family) => sum + family.forkCount, 0)
          // In the "keep forks" mode forks are listed separately; in the
          // "include forks" mode they arrive as members. Sum both so the
          // checkbox stays available and can always be toggled back.
          const forkIncluded = families.reduce(
            (sum, family) => sum + (family.members || []).filter((member) => member.role === 'fork').length,
            0,
          )
          const forkCandidates = forkTotal + forkIncluded
          const roleLabel = { root: '会话', subagent: '子智能体/队友', fork: '分叉' }
          const limit = dialog.limit || null
          const truncated = Boolean(limit && limit.requested > limit.accepted)

          const familyBlocks = families.map((family) => h(
            'div',
            { key: family.rootId, style: dialogFamilyStyle },
            h(
              'div',
              { style: dialogFamilyHeadStyle },
              h(
                'span',
                { style: sessionTitleStyle },
                family.rootTitle && family.rootTitle.trim() !== '' ? family.rootTitle : family.rootId,
              ),
              h('span', { style: badgeStyle }, `${family.memberCount} 个会话`),
              h('span', { style: trashMetaStyle }, `${(family.totalBytes / 1048576).toFixed(1)} MB`),
            ),
            family.members.map((member) => h(
              'div',
              { key: member.id, style: dialogRowStyle },
              h('span', { style: badgeStyle }, roleLabel[member.role] || member.role),
              h(
                'span',
                { style: sessionTitleStyle },
                member.title && member.title.trim() !== '' ? member.title : member.id,
              ),
              member.running
                ? h('span', { style: blockedBadgeStyle }, '正在运行')
                : member.loaded
                  ? h('span', { style: badgeStyle }, '已打开')
                  : null,
              h('span', { style: trashMetaStyle }, `${(member.sizeBytes / 1048576).toFixed(1)} MB`),
            )),
            family.forkCount > 0 || (family.members || []).some((member) => member.role === 'fork')
              ? h(
                  'div',
                  { style: dialogHintStyle },
                  dialog.includeForks === true
                    ? `将一并移入 ${(family.members || []).filter((member) => member.role === 'fork').length} 个分叉会话`
                    : `保留 ${family.forkCount} 个分叉会话，不随本次删除移动`,
                )
              : null,
            family.blockers.length > 0
              ? h('div', { style: dialogBlockerStyle }, family.blockers.map((blocker) => blocker.message).join('；'))
              : null,
          ))

          return h(
            'div',
            { style: overlayStyle, onClick: () => { if (dialog.phase !== 'busy') setDialog(null) } },
            h(
              'div',
              { style: dialogStyle, onClick: (event) => event.stopPropagation() },
              h('h2', { style: dialogTitleStyle }, dialog.phase === 'done' ? '已移入回收站' : '移入回收站'),
              h(
                'p',
                { style: dialogHintStyle },
                dialog.phase === 'done'
                  ? `已移入 ${trashed.length} 个会话${deferred.length > 0 ? `，${deferred.length} 个将在下次启动 DSH 时自动移入` : ''}${skipped.length > 0 ? `，跳过 ${skipped.length} 个` : ''}。可从回收站恢复。`
                  : `将移入 ${memberTotal} 个会话${dialog.includeForks === true ? '（含分叉）' : ''}；子智能体/队友会一并移入，可从回收站恢复，不会彻底删除文件。`,
              ),
              dialog.phase === 'loading' ? h('div', { style: dialogTextStyle }, '正在检查…') : null,
              // The Host accepts a bounded batch; never let the rest look
              // processed when it was silently dropped.
              truncated
                ? h(
                    'div',
                    { style: loadedHintStyle },
                    `本次勾选了 ${limit.requested} 个会话，单次最多处理 ${limit.max} 个，因此只会处理前 ${limit.accepted} 个；其余 ${limit.requested - limit.accepted} 个请再删一次。`,
                  )
                : null,
              dialog.phase === 'busy' ? renderDeleteProgress(dialog.progress) : null,
              dialog.phase === 'error' ? h('div', { style: dialogBlockerStyle }, `失败：${dialog.error}`) : null,
              dialog.phase === 'ready' ? h('div', { style: dialogListStyle }, familyBlocks) : null,
              dialog.phase === 'ready' && forkCandidates > 0
                ? h(
                    'label',
                    { style: forkOptionStyle },
                    h('input', {
                      type: 'checkbox',
                      checked: dialog.includeForks === true,
                      onChange: toggleIncludeForks,
                    }),
                    h('span', null, `一并删除 ${forkCandidates} 个分叉会话`),
                  )
                : null,
              dialog.phase === 'ready'
                && families.some((family) => (family.warnings || []).some((warning) => warning.code === 'loaded'))
                ? h(
                    'div',
                    { style: loadedHintStyle },
                    '提示：仍被应用保留（已打开）的会话会立即从侧边栏隐藏并出现在回收站（标为待重启整理），日志文件在下次启动 DSH 时完成移动；期间不影响任何使用。',
                  )
                : null,
              dialog.phase === 'done' && skipped.length > 0
                ? h('div', { style: dialogListStyle }, skipped.map((result) => h(
                    'div',
                    { key: result.id, style: dialogRowStyle },
                    h('span', { style: sessionTitleStyle }, result.id),
                    h('span', { style: badgeStyle }, result.reason || result.status),
                  )))
                : null,
              h(
                'div',
                { style: dialogActionsStyle },
                h(
                  'button',
                  {
                    className: 'sl-btn',
                    style: actionButtonStyle,
                    disabled: dialog.phase === 'busy',
                    onClick: () => setDialog(null),
                  },
                  dialog.phase === 'done' ? '关闭' : '取消',
                ),
                dialog.phase === 'ready'
                  ? h(
                      'button',
                      {
                        className: 'sl-btn',
                        style: dangerButtonStyle,
                        disabled: blocked.length > 0 || memberTotal === 0,
                        onClick: confirmDelete,
                      },
                      `确认移入回收站（${memberTotal}）`,
                    )
                  : null,
              ),
            ),
          )
        }

        function renderPurgeDialog() {
          const families = purgeDialog.families || []
          const results = purgeDialog.results || []
          const purged = results.filter((result) => result.status === 'purged')
          const queued = results.filter((result) => result.status === 'queued')
          const failed = results.filter(
            (result) => result.status !== 'purged' && result.status !== 'queued',
          )
          const sessionCount = families.reduce((sum, family) => sum + family.entries.length, 0)
          const pendingCount = families.reduce(
            (sum, family) => sum + family.entries.filter((entry) => entry.pending === true).length,
            0,
          )
          const totalBytes = families.reduce((sum, family) => sum + family.totalBytes, 0)
          const confirmText = purgeDialog.text || ''
          // A queued deletion is not irreversible yet: it runs at the next start
          // and the recycle bin can still cancel it before then.
          const doneParts = []
          if (purged.length > 0) doneParts.push(`已永久删除 ${purged.length} 个会话`)
          if (queued.length > 0) doneParts.push(`${queued.length} 个已排队（重启 DSH 后删除，重启前可取消）`)
          if (failed.length > 0) doneParts.push(`${failed.length} 个失败`)
          const doneSummary = doneParts.length > 0 ? `${doneParts.join('；')}。` : '已完成。'
          const doneTitle = purged.length > 0 ? '已永久删除' : queued.length > 0 ? '已排队永久删除' : '已完成'

          const familyBlocks = families.map((family) => {
            const rootEntry = family.entries.find((entry) => entry.role === 'root') || family.entries[0]
            return h(
              'div',
              { key: family.key, style: dialogFamilyStyle },
              h(
                'div',
                { style: dialogFamilyHeadStyle },
                h(
                  'span',
                  { style: sessionTitleStyle },
                  rootEntry.title && rootEntry.title.trim() !== '' ? rootEntry.title : rootEntry.sessionId,
                ),
                h('span', { style: badgeStyle }, `${family.entries.length} 个会话`),
                h('span', { style: trashMetaStyle }, `${(family.totalBytes / 1048576).toFixed(1)} MB`),
              ),
            )
          })

          return h(
            'div',
            { style: overlayStyle, onClick: () => { if (purgeDialog.phase !== 'busy') setPurgeDialog(null) } },
            h(
              'div',
              { style: dialogStyle, onClick: (event) => event.stopPropagation() },
              h('h2', { style: dialogTitleStyle }, purgeDialog.phase === 'done' ? doneTitle : '永久删除'),
              h(
                'p',
                { style: dialogHintStyle },
                purgeDialog.phase === 'done'
                  ? doneSummary
                  : `将永久删除 ${sessionCount} 个会话（${(totalBytes / 1048576).toFixed(1)} MB）。此操作不可恢复；附件与成本账本不会被清理。${pendingCount > 0 ? `其中 ${pendingCount} 个仍被应用打开，将在重启 DSH 后删除。` : ''}`,
              ),
              purgeDialog.phase === 'confirm' ? h('div', { style: dialogListStyle }, familyBlocks) : null,
              purgeDialog.error ? h('div', { style: dialogBlockerStyle }, `失败：${purgeDialog.error}`) : null,
              purgeDialog.phase === 'confirm'
                ? h(
                    'div',
                    { style: { margin: '4px 0 11px' } },
                    h('div', { style: dialogHintStyle }, '请输入「永久删除」以确认：'),
                    h('input', {
                      className: 'sl-input',
                      style: purgeInputStyle,
                      value: confirmText,
                      placeholder: '永久删除',
                      onChange: (event) => setPurgeDialog((current) => ({
                        ...(current || {}),
                        text: event.target.value,
                      })),
                    }),
                  )
                : null,
              purgeDialog.phase === 'done' && failed.length > 0
                ? h('div', { style: dialogListStyle }, failed.map((result) => h(
                    'div',
                    { key: result.entryName, style: dialogRowStyle },
                    h('span', { style: sessionTitleStyle }, result.entryName),
                    h('span', { style: blockedBadgeStyle }, result.reason || result.status),
                  )))
                : null,
              h(
                'div',
                { style: dialogActionsStyle },
                h(
                  'button',
                  {
                    className: 'sl-btn',
                    style: actionButtonStyle,
                    disabled: purgeDialog.phase === 'busy',
                    onClick: () => setPurgeDialog(null),
                  },
                  purgeDialog.phase === 'done' ? '关闭' : '取消',
                ),
                purgeDialog.phase === 'confirm'
                  ? h(
                      'button',
                      {
                        className: 'sl-btn',
                        style: dangerButtonStyle,
                        disabled: confirmText.trim() !== '永久删除',
                        onClick: confirmPurge,
                      },
                      `永久删除 ${sessionCount} 个会话`,
                    )
                  : null,
              ),
            ),
          )
        }

        function renderClearLogsDialog() {
          return h(
            'div',
            { style: overlayStyle, onClick: () => setClearLogsDialog(false) },
            h(
              'div',
              { style: dialogStyle, onClick: (event) => event.stopPropagation() },
              h('h2', { style: dialogTitleStyle }, '清空操作日志'),
              h(
                'p',
                { style: dialogHintStyle },
                `将删除全部 ${logs.length} 条操作日志。已经执行的删除、恢复操作本身不受影响。`,
              ),
              h(
                'div',
                { style: dialogActionsStyle },
                h(
                  'button',
                  { className: 'sl-btn', style: actionButtonStyle, onClick: () => setClearLogsDialog(false) },
                  '取消',
                ),
                h(
                  'button',
                  { className: 'sl-btn', style: dangerButtonStyle, onClick: confirmClearLogs },
                  '清空日志',
                ),
              ),
            ),
          )
        }

        /**
         * Render the export dialog: destination choice, progress, result or error.
         *
         * @returns {object} React element.
         */
        function renderExportDialog() {
          const phase = exportDialog.phase
          const done = phase === 'done'
          const choosing = phase === 'choose'
          const busy = phase === 'busy'
          const failed = phase === 'error'
          const bytes = Number(exportDialog.bytes) || 0
          const title = done ? '已导出会话' : failed ? '导出失败' : '导出会话'
          const actions = []
          if (choosing) {
            actions.push(h(
              'button',
              { key: 'cancel', className: 'sl-btn', style: actionButtonStyle, onClick: () => setExportDialog(null) },
              '取消',
            ))
            actions.push(h(
              'button',
              { key: 'start', className: 'sl-btn', style: actionButtonStyle, onClick: () => beginExport(false) },
              '开始导出',
            ))
          } else if (failed) {
            actions.push(h(
              'button',
              { key: 'back', className: 'sl-btn', style: actionButtonStyle, onClick: () => setExportDialog((current) => ({ ...(current || {}), phase: 'choose', error: null })) },
              '返回修改位置',
            ))
            actions.push(h(
              'button',
              { key: 'close', className: 'sl-btn', style: actionButtonStyle, onClick: () => setExportDialog(null) },
              '关闭',
            ))
          } else if (done) {
            actions.push(h(
              'button',
              { key: 'close', className: 'sl-btn', style: actionButtonStyle, onClick: () => setExportDialog(null) },
              '关闭',
            ))
          }
          return h(
            'div',
            { style: overlayStyle, onClick: () => { if (!busy) setExportDialog(null) } },
            h(
              'div',
              { style: dialogStyle, onClick: (event) => event.stopPropagation() },
              h('h2', { style: dialogTitleStyle }, title),
              choosing
                ? h(
                    'div',
                    { style: exportChooserStyle },
                    h('p', { style: dialogHintStyle }, '选择保存位置后开始导出；留空则保存到插件默认目录（~/.dsh/sessions-library/exports）。'),
                    h('div', { style: dialogHintStyle }, '导出位置'),
                    h('input', {
                      className: 'sl-input',
                      style: exportInputStyle,
                      value: exportTarget,
                      placeholder: '留空使用默认目录',
                      onChange: (event) => setExportTarget(event.target.value),
                    }),
                    h(
                      'div',
                      { style: exportChooserActionsStyle },
                      h(
                        'button',
                        { className: 'sl-btn', style: actionButtonStyle, onClick: pickExportDirectory },
                        '选择文件夹…',
                      ),
                      exportTarget !== ''
                        ? h(
                            'button',
                            {
                              className: 'sl-btn',
                              style: actionButtonStyle,
                              onClick: () => setExportTarget(''),
                            },
                            '使用默认位置',
                          )
                        : null,
                    ),
                  )
                : null,
              busy
                ? h('p', { style: dialogHintStyle }, '正在打包会话日志与工作区信息…')
                : null,
              exportDialog.error
                ? h('div', { style: dialogBlockerStyle }, exportDialog.error)
                : null,
              done
                ? h(
                    'div',
                    null,
                    h(
                      'p',
                      { style: dialogHintStyle },
                      `已导出 ${exportDialog.sessionCount} 个会话（${(bytes / 1048576).toFixed(2)} MB），`
                        + `包内包含 ${exportDialog.workspaceCount} 个工作区的信息（ID、路径、标题）。`,
                    ),
                    h('div', { style: exportPathStyle }, exportDialog.path),
                    h('p', { style: dialogHintStyle }, '会话日志按原存储格式逐字节复制；导入功能尚未实现，这个包用于先备份或跨机器携带。'),
                  )
                : null,
              actions.length > 0
                ? h('div', { style: dialogActionsStyle }, actions)
                : null,
            ),
          )
        }

        /**
         * Ask whether a missing export destination should be created.
         *
         * @returns {object} React element.
         */
        function renderCreateDirPrompt() {
          const targetDir = createDirPrompt && typeof createDirPrompt.targetDir === 'string'
            ? createDirPrompt.targetDir
            : ''
          return h(
            'div',
            { style: overlayStyle, onClick: () => setCreateDirPrompt(null) },
            h(
              'div',
              { style: dialogStyle, onClick: (event) => event.stopPropagation() },
              h('h2', { style: dialogTitleStyle }, '文件夹不存在'),
              h(
                'p',
                { style: dialogHintStyle },
                `导出位置不存在：${targetDir}。是否创建该文件夹？`,
              ),
              h(
                'div',
                { style: dialogActionsStyle },
                h(
                  'button',
                  {
                    className: 'sl-btn',
                    style: actionButtonStyle,
                    onClick: () => setCreateDirPrompt(null),
                  },
                  '否',
                ),
                h(
                  'button',
                  {
                    className: 'sl-btn',
                    style: actionButtonStyle,
                    onClick: () => {
                      setCreateDirPrompt(null)
                      beginExport(true)
                    },
                  },
                  '是，创建并导出',
                ),
              ),
            ),
          )
        }

        const filterButton = (value, label, count) => h(
          'button',
          {
            className: 'sl-btn',
            style: filterButtonStyle(filter === value),
            onClick: () => changeFilter(value),
          },
          `${label} ${count}`,
        )

        /**
         * Build the compact sort selector used by the bin and log views.
         *
         * @param {string} value selected option value.
         * @param {Array<{ value: string, label: string }>} options available options.
         * @param {Function} onChange selection handler.
         * @returns {object} React element.
         */
        const sortSelect = (value, options, onChange) => h(
          'select',
          {
            className: 'sl-input',
            style: sortSelectStyle,
            value,
            onChange: (event) => onChange(event.target.value),
          },
          options.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
        )

        const libraryControls = h(
          'div',
          { style: controlsStyle },
          h('input', {
            className: 'sl-input',
            style: searchStyle,
            value: query,
            placeholder: '搜索标题或工作区',
            onChange: (event) => setQuery(event.target.value),
          }),
          h(
            'div',
            { style: segmentedStyle },
            filterButton('unarchived', '未归档会话', totals.active),
            filterButton('all', '全部会话', totals.total),
          ),
          selectedCount > 0
            ? h(
                'button',
                {
                  className: 'sl-btn',
                  style: dangerButtonStyle,
                  onClick: () => beginDelete(false),
                },
                `移入回收站 ${selectedCount}`,
              )
            : null,
          selectedCount > 0
            ? h(
                'button',
                {
                  className: 'sl-btn',
                  style: actionButtonStyle,
                  onClick: clearSelection,
                },
                `清除选择 ${selectedCount}`,
              )
            : null,
          h(
            'button',
            {
              className: 'sl-btn',
              style: actionButtonStyle,
              onClick: toggleAllGroups,
            },
            anyOpen ? '全部收起' : '全部展开',
          ),
          h(
            'button',
            {
              className: 'sl-btn',
              style: actionButtonStyle,
              onClick: () => setReloadToken((token) => token + 1),
            },
            '刷新',
          ),
          h(
            'button',
            {
              className: 'sl-btn',
              style: actionButtonStyle,
              onClick: openTrash,
            },
            '回收站',
          ),
          h(
            'button',
            {
              className: 'sl-btn',
              style: actionButtonStyle,
              onClick: openLogs,
            },
            '操作日志',
          ),
        )

        const trashControls = h(
          'div',
          { style: controlsStyle },
          h(
            'button',
            {
              className: 'sl-btn',
              style: actionButtonStyle,
              onClick: closeTrash,
            },
            '← 返回会话库',
          ),
          h('input', {
            className: 'sl-input',
            style: searchStyle,
            value: trashQuery,
            placeholder: '搜索标题或会话 ID',
            onChange: (event) => setTrashQuery(event.target.value),
          }),
          sortSelect(trashSort, [
            { value: 'newest', label: '删除时间 新→旧' },
            { value: 'oldest', label: '删除时间 旧→新' },
            { value: 'largest', label: '体积 大→小' },
            { value: 'smallest', label: '体积 小→大' },
          ], setTrashSort),
          h(
            'button',
            {
              className: 'sl-btn',
              style: actionButtonStyle,
              onClick: refreshTrash,
            },
            '刷新回收站',
          ),
          h(
            'button',
            {
              className: 'sl-btn',
              style: actionButtonStyle,
              onClick: toggleTrashSelectAll,
            },
            allTrashSelected ? '取消全选' : '全选',
          ),
          selectedTrashCount > 0
            ? h(
                'button',
                {
                  className: 'sl-btn',
                  style: dangerButtonStyle,
                  onClick: openPurgeDialog,
                },
                `永久删除 ${selectedTrashCount} 个会话`,
              )
            : null,
        )

        const logsControls = h(
          'div',
          { style: controlsStyle },
          h(
            'button',
            {
              className: 'sl-btn',
              style: actionButtonStyle,
              onClick: closeLogs,
            },
            '← 返回会话库',
          ),
          h('input', {
            className: 'sl-input',
            style: searchStyle,
            value: logsQuery,
            placeholder: '搜索日志内容或会话 ID',
            onChange: (event) => setLogsQuery(event.target.value),
          }),
          sortSelect(logsSort, [
            { value: 'newest', label: '时间 新→旧' },
            { value: 'oldest', label: '时间 旧→新' },
          ], setLogsSort),
          h(
            'button',
            {
              className: 'sl-btn',
              style: actionButtonStyle,
              onClick: () => refreshLogs(),
            },
            '刷新日志',
          ),
          h(
            'button',
            {
              className: 'sl-btn',
              style: dangerButtonStyle,
              onClick: () => setClearLogsDialog(true),
            },
            '清空日志',
          ),
        )

        const controls = view === 'trash'
          ? trashControls
          : view === 'logs'
            ? logsControls
            : libraryControls

        let body = null
        if (view === 'trash') {
          body = renderTrash()
        } else if (view === 'logs') {
          body = renderLogs()
        } else if (phase === 'loading') {
          body = h('div', { style: placeholderStyle }, '正在读取会话…')
        } else if (phase === 'error') {
          body = h(
            'div',
            { style: placeholderStyle },
            h('div', { style: { marginBottom: 10 } }, `读取失败：${error}`),
            h(
              'button',
              {
                className: 'sl-btn',
                style: actionButtonStyle,
                onClick: () => setReloadToken((token) => token + 1),
              },
              '重试',
            ),
          )
        } else if (groups.length === 0) {
          body = h('div', { style: placeholderStyle }, query.trim() !== '' ? '没有匹配的会话' : '还没有会话')
        } else {
          body = groups.map(renderGroup)
        }

        const sources = snapshot && snapshot.sources
          ? `数据来源：工作区 ${snapshot.sources.workspaces} · 会话 ${snapshot.sources.sessions ?? snapshot.sources.summaries} · 标题 ${snapshot.sources.titles}`
          : ''

        return h(
          'div',
          { className: 'sl-root' },
          h('style', null, CSS),
          h(
            'header',
            { style: headerStyle },
            h(
              'div',
              { style: titleRowStyle },
              h('h1', { style: headingStyle }, '会话库'),
              h(
                'span',
                { style: subtitleStyle },
                view === 'trash'
                  ? `回收站 · ${trashFamilies.length} 组 · ${trash.length} 个会话`
                  : view === 'logs'
                    ? `操作日志 · ${visibleLogs.length} 条${logsQuery.trim() !== '' ? ` / 共 ${logs.length} 条` : ''}`
                    : snapshot
                    ? [
                        `${visibleCount} 个会话 · ${groups.length} 个工作区`,
                        selectedCount > 0 ? `已选 ${selectedCount}` : '',
                        addedCount > 0 ? `新增 ${addedCount}` : '',
                      ]
                        .filter((part) => part !== '')
                        .join(' · ')
                    : '',
              ),
            ),
            controls,
          ),
          refreshError !== null
            ? h('div', { style: warnStyle }, `刷新失败：${refreshError}（显示的是上次读取的结果）`)
            : null,
          h('div', { className: 'sl-scroll' }, body),
          // Floating export dock: a soft gradient panel hovering over the session
          // rows, with the action disabled until something is selected.
          view === 'library'
            ? h(
                'div',
                { className: 'sl-dock', style: exportDockStyle },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'sl-btn sl-fab',
                    style: selectedCount > 0 ? fabButtonStyle : fabDisabledStyle,
                    disabled: selectedCount === 0,
                    title: selectedCount > 0
                      ? `导出所选的 ${selectedCount} 个会话`
                      : '请先勾选要导出的会话',
                    onClick: openExportDialog,
                  },
                  selectedCount > 0 ? `导出所选 ${selectedCount}` : '导出所选',
                ),
              )
            : null,
          sources !== ''
            ? h('div', { style: footerStyle }, sources)
            : null,
          dialog !== null ? renderDialog() : null,
          purgeDialog !== null ? renderPurgeDialog() : null,
          clearLogsDialog ? renderClearLogsDialog() : null,
          exportDialog !== null ? renderExportDialog() : null,
          createDirPrompt !== null ? renderCreateDirPrompt() : null,
        )
      }
    }

    const groupStyle = {
      borderBottom: '1px solid color-mix(in srgb, currentColor 10%, transparent)',
      padding: '4px 0',
    }
    const groupHeaderStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      width: '100%',
      padding: '8px 10px',
      border: 'none',
      borderRadius: 6,
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
      fontSize: 13,
      fontWeight: 600,
      cursor: 'pointer',
      textAlign: 'left',
    }
    const chevronStyle = { width: 14, flex: '0 0 auto', opacity: 0.6 }
    const groupTitleStyle = {
      flex: '0 0 auto',
      maxWidth: '38%',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    }
    const groupPathStyle = {
      flex: '1 1 auto',
      minWidth: 0,
      fontWeight: 400,
      fontSize: 12,
      opacity: 0.45,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    }
    const groupCountStyle = { flex: '0 0 auto', fontSize: 12, fontWeight: 400, opacity: 0.6 }
    const groupTimeStyle = {
      flex: '0 0 auto',
      fontSize: 12,
      fontWeight: 400,
      opacity: 0.45,
      width: 72,
      textAlign: 'right',
    }
    const rowStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      width: '100%',
      textAlign: 'left',
      padding: '7px 10px 7px 32px',
      border: 'none',
      borderRadius: 6,
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
      fontSize: 13,
      cursor: 'pointer',
    }
    const sessionTitleStyle = {
      flex: '1 1 auto',
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    }
    const sessionTimeStyle = { flex: '0 0 auto', fontSize: 12, opacity: 0.45, width: 72, textAlign: 'right' }
    const badgeStyle = {
      flex: '0 0 auto',
      fontSize: 11,
      lineHeight: '16px',
      padding: '0 6px',
      borderRadius: 999,
      border: '1px solid color-mix(in srgb, currentColor 24%, transparent)',
      opacity: 0.75,
    }
    const checkboxStyle = (state) => ({
      flex: '0 0 auto',
      width: 14,
      height: 14,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 3,
      border: '1px solid color-mix(in srgb, currentColor 38%, transparent)',
      background: state === 'none' ? 'transparent' : 'color-mix(in srgb, currentColor 20%, transparent)',
      fontSize: 10,
      lineHeight: 1,
      cursor: 'pointer',
      userSelect: 'none',
    })
    const showAllButtonStyle = {
      display: 'block',
      margin: '2px 0 6px 54px',
      padding: '5px 10px',
      border: 'none',
      borderRadius: 6,
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
      fontSize: 12,
      opacity: 0.6,
      cursor: 'pointer',
    }
    const headerStyle = {
      flex: '0 0 auto',
      padding: '18px 24px 12px',
      borderBottom: '1px solid color-mix(in srgb, currentColor 10%, transparent)',
    }
    const titleRowStyle = { display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 12 }
    const headingStyle = { margin: 0, fontSize: 17, fontWeight: 600 }
    const subtitleStyle = { fontSize: 12, opacity: 0.5 }
    const controlsStyle = { display: 'flex', alignItems: 'center', gap: 8 }
    const searchStyle = {
      flex: '1 1 auto',
      minWidth: 120,
      height: 30,
      padding: '0 10px',
      borderRadius: 6,
      border: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
      fontSize: 13,
    }
    const sortSelectStyle = {
      flex: '0 0 auto',
      height: 30,
      padding: '0 8px',
      borderRadius: 6,
      border: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
      background: 'Canvas',
      color: 'inherit',
      font: 'inherit',
      fontSize: 12,
      cursor: 'pointer',
    }
    const segmentedStyle = {
      display: 'flex',
      flex: '0 0 auto',
      padding: 2,
      gap: 2,
      borderRadius: 7,
      border: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
    }
    const filterButtonStyle = (active) => ({
      padding: '4px 10px',
      border: 'none',
      borderRadius: 5,
      background: active ? 'color-mix(in srgb, currentColor 14%, transparent)' : 'transparent',
      color: 'inherit',
      font: 'inherit',
      fontSize: 12,
      fontWeight: active ? 600 : 400,
      cursor: 'pointer',
    })
    const actionButtonStyle = {
      flex: '0 0 auto',
      height: 30,
      padding: '0 12px',
      borderRadius: 6,
      border: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
      fontSize: 12,
      cursor: 'pointer',
    }
    const blockedBadgeStyle = {
      flex: '0 0 auto',
      fontSize: 11,
      lineHeight: '16px',
      padding: '0 6px',
      borderRadius: 999,
      border: '1px solid color-mix(in srgb, #f06a6a 55%, transparent)',
      color: '#f08a8a',
      opacity: 0.9,
    }
    const dangerButtonStyle = {
      flex: '0 0 auto',
      height: 30,
      padding: '0 12px',
      borderRadius: 6,
      border: '1px solid color-mix(in srgb, #f06a6a 55%, transparent)',
      background: 'color-mix(in srgb, #f06a6a 14%, transparent)',
      color: 'inherit',
      font: 'inherit',
      fontSize: 12,
      cursor: 'pointer',
    }
    const trashRowStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '8px 10px',
      borderBottom: '1px solid color-mix(in srgb, currentColor 10%, transparent)',
      fontSize: 13,
    }
    const trashMetaStyle = {
      flex: '0 0 auto',
      fontSize: 12,
      opacity: 0.5,
      width: 88,
      textAlign: 'right',
    }
    // Deletion timestamps are long enough to wrap inside the fixed meta column,
    // so they get their own single-line slot.
    const trashTimeStyle = {
      flex: '0 0 auto',
      fontSize: 12,
      opacity: 0.5,
      whiteSpace: 'nowrap',
      fontVariantNumeric: 'tabular-nums',
    }
    const logsRowStyle = {
      display: 'flex',
      alignItems: 'baseline',
      gap: 12,
      padding: '8px 10px',
      borderBottom: '1px solid color-mix(in srgb, currentColor 10%, transparent)',
      fontSize: 13,
    }
    const logsTextStyle = {
      flex: '1 1 auto',
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    }
    const progressBlockStyle = { margin: '8px 0 2px' }
    const progressLabelStyle = { fontSize: 12, opacity: 0.75, marginBottom: 6 }
    const progressTrackStyle = {
      height: 6,
      borderRadius: 999,
      overflow: 'hidden',
      background: 'color-mix(in srgb, currentColor 14%, transparent)',
    }
    const progressFillStyle = (pct) => ({
      height: '100%',
      width: `${pct}%`,
      borderRadius: 999,
      background: 'color-mix(in srgb, currentColor 55%, transparent)',
      transition: 'width 0.2s linear',
    })
    const progressCurrentStyle = {
      fontSize: 12,
      opacity: 0.5,
      marginTop: 6,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    }
    // Result path: plain selectable text, not a boxed field.
    const exportPathStyle = {
      margin: '8px 0 10px',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.7,
      wordBreak: 'break-all',
      userSelect: 'text',
    }
    const exportChooserStyle = { margin: '4px 0 10px' }
    const exportChooserActionsStyle = { display: 'flex', gap: 8, marginTop: 8 }
    const exportInputStyle = {
      width: '100%',
      height: 32,
      marginTop: 6,
      padding: '0 10px',
      borderRadius: 6,
      border: '1px solid color-mix(in srgb, currentColor 22%, transparent)',
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
      fontSize: 13,
    }
    // Full-width export dock: a bottom gradient strip floating over the session
    // list, with the action pinned to its right edge.
    const exportDockStyle = {
      position: 'absolute',
      left: 12,
      right: 12,
      bottom: 24,
      height: 80,
      borderRadius: 20,
      overflow: 'hidden',
      zIndex: 30,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'flex-end',
      padding: '0 20px',
      backdropFilter: 'blur(8px)',
      WebkitBackdropFilter: 'blur(8px)',
      pointerEvents: 'none',
    }
    const fabButtonStyle = {
      position: 'relative',
      zIndex: 1,
      height: 38,
      padding: '0 18px',
      borderRadius: 999,
      border: '1px solid color-mix(in srgb, currentColor 24%, transparent)',
      background: 'color-mix(in srgb, currentColor 12%, Canvas)',
      color: 'inherit',
      font: 'inherit',
      fontSize: 13,
      fontWeight: 600,
      boxShadow: '0 6px 20px rgba(0, 0, 0, 0.28)',
      cursor: 'pointer',
      pointerEvents: 'auto',
    }
    const fabDisabledStyle = {
      ...fabButtonStyle,
      opacity: 0.45,
      cursor: 'not-allowed',
      boxShadow: 'none',
    }
    const overlayStyle = {
      position: 'fixed',
      inset: 0,
      background: 'rgba(0, 0, 0, 0.45)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 1000,
    }
    const dialogStyle = {
      width: 'min(560px, 90vw)',
      maxHeight: '78vh',
      overflow: 'auto',
      padding: '20px 22px',
      borderRadius: 12,
      border: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
      background: 'Canvas',
      color: 'CanvasText',
      boxShadow: '0 18px 50px rgba(0, 0, 0, 0.45)',
    }
    const dialogTitleStyle = { margin: '0 0 8px', fontSize: 16, fontWeight: 600 }
    const dialogHintStyle = { margin: '0 0 12px', fontSize: 12, opacity: 0.6, lineHeight: 1.6 }
    const dialogTextStyle = { fontSize: 13, opacity: 0.7, padding: '8px 0' }
    const dialogListStyle = {
      borderTop: '1px solid color-mix(in srgb, currentColor 12%, transparent)',
      margin: '4px 0 12px',
    }
    const dialogRowStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '8px 2px',
      borderBottom: '1px solid color-mix(in srgb, currentColor 10%, transparent)',
      fontSize: 13,
    }
    const dialogActionsStyle = { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }
    const dialogFamilyStyle = {
      border: '1px solid color-mix(in srgb, currentColor 12%, transparent)',
      borderRadius: 8,
      padding: '6px 8px',
      marginBottom: 10,
    }
    const dialogFamilyHeadStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '6px 2px',
      fontWeight: 600,
    }
    const forkOptionStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      fontSize: 12,
      opacity: 0.85,
      margin: '4px 0 10px',
      cursor: 'pointer',
    }
    const loadedHintStyle = {
      fontSize: 12,
      lineHeight: 1.6,
      padding: '8px 10px',
      margin: '4px 0 10px',
      borderRadius: 6,
      border: '1px solid color-mix(in srgb, #f0b37e 45%, transparent)',
      color: '#f0b37e',
      background: 'color-mix(in srgb, #f0b37e 10%, transparent)',
    }
    const purgeInputStyle = {
      width: '100%',
      height: 32,
      padding: '0 10px',
      borderRadius: 6,
      border: '1px solid color-mix(in srgb, #f06a6a 45%, transparent)',
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
      fontSize: 13,
    }
    const placeholderStyle = { padding: '40px 10px', fontSize: 13, opacity: 0.55, textAlign: 'center' }
    const infoStyle = {
      fontSize: 12,
      lineHeight: 1.6,
      padding: '8px 10px',
      margin: '4px 0 10px',
      borderRadius: 6,
      border: '1px solid color-mix(in srgb, #6aa9f0 45%, transparent)',
      color: '#6aa9f0',
      background: 'color-mix(in srgb, #6aa9f0 10%, transparent)',
    }
    const dialogBlockerStyle = {
      fontSize: 12,
      lineHeight: 1.6,
      padding: '6px 8px',
      margin: '6px 0 2px',
      borderRadius: 6,
      color: '#f0b37e',
      background: 'color-mix(in srgb, #f0b37e 12%, transparent)',
      textAlign: 'left',
    }
    const warnStyle = {
      flex: '0 0 auto',
      padding: '6px 24px',
      fontSize: 12,
      color: '#f0b37e',
      background: 'color-mix(in srgb, #f0b37e 12%, transparent)',
    }
    const footerStyle = { flex: '0 0 auto', padding: '6px 24px', fontSize: 11, opacity: 0.35 }

    return {
      name: 'dsh-sessions-library',
      inject: ['slots'],
      apply(ctx) {
        const Page = makePage(ctx)
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'sessions-library' }, Page),
        )
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: 'sessions-library',
              order: 21,
              label: '会话库',
            },
            LibraryIcon,
          ),
        )
      },
    }
  },
})
