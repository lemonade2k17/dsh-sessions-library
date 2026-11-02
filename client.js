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
    const LOGS_DELETE_PATH = 'api/sessions-library/logs-delete'
    const LOGS_LIMIT = 500
    const DELETE_PROGRESS_PATH = 'api/sessions-library/delete-progress'
    const EXPORT_PATH = 'api/sessions-library/export'
    const WORKSPACE_PREFLIGHT_PATH = 'api/sessions-library/workspace-preflight'
    const IMPORT_LIST_PATH = 'api/sessions-library/import-list'
    const IMPORT_PREFLIGHT_PATH = 'api/sessions-library/import-preflight'
    const IMPORT_RUN_PATH = 'api/sessions-library/import-run'
    const EXPORT_DIR_STORAGE_KEY = 'dsh-sessions-library:export-dir'
    const WORKSPACE_BROWSE_PATH = 'api/sessions-library/workspace-browse'

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
      import: '被导入',
      adopt: '被导入（沿用本地已归档副本，已取消归档）',
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
      // Status colours are the only non-neutral hues in this UI. They are declared
      // once here so the light theme can use darker, readable variants: the
      // original hexes clear 4.5:1 on the dark canvas but only reach 1.8–3.0:1 on
      // white. Dark keeps the values it was tuned against.
      '.sl-root { --sl-danger: #f06a6a; --sl-danger-text: #f08a8a; --sl-warn: #f0b37e; --sl-info: #6aa9f0; }',
      'body:not([data-ds-dark-theme]) .sl-root { --sl-danger: #b3261e; --sl-danger-text: #b3261e; --sl-warn: #8a5300; --sl-info: #1a5fb4; }',
      '.sl-root * { box-sizing: border-box; }',
      '.sl-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 4px 24px 106px; }',
      // Chosen exclusion paths: a fixed-height list with its own scrollbar, so a
      // long selection stays readable instead of stretching the dialog.
      '.sl-pathlist { scrollbar-gutter: stable; }',
      '.sl-pathlist-row { display: flex; align-items: center; gap: 8px; padding: 2px 8px; font-size: 12px; line-height: 1.7; border-radius: 4px; }',
      '.sl-pathlist-row:hover { background: color-mix(in srgb, currentColor 6%, transparent); }',
      '.sl-pathlist-path { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.sl-pathlist-empty { padding: 8px; font-size: 12px; opacity: 0.5; }',
      // One scrollbar treatment for the page and for every dialog scroll area.
      '.sl-root ::-webkit-scrollbar { width: 10px; height: 10px; }',
      '.sl-root ::-webkit-scrollbar-thumb { background: color-mix(in srgb, currentColor 18%, transparent); border-radius: 8px; border: 3px solid transparent; background-clip: content-box; }',
      '.sl-root ::-webkit-scrollbar-thumb:hover { background: color-mix(in srgb, currentColor 30%, transparent); }',
      '.sl-root ::-webkit-scrollbar-track, .sl-root ::-webkit-scrollbar-corner { background: transparent; }',
      // Hover/press feedback is background-color only (paint, never layout), and
      // short enough that a fast pointer reads as a state, not an animation.
      '.sl-group-head, .sl-row, .sl-logrow, .sl-check { transition: background-color 120ms ease, border-color 120ms ease; }',
      '.sl-group-head:hover { background: color-mix(in srgb, currentColor 6%, transparent); }',
      '.sl-group-head:active { background: color-mix(in srgb, currentColor 9%, transparent); }',
      '.sl-row:hover { background: color-mix(in srgb, currentColor 8%, transparent); }',
      '.sl-row:active { background: color-mix(in srgb, currentColor 12%, transparent); }',
      '.sl-logrow:hover { background: color-mix(in srgb, currentColor 5%, transparent); }',
      '.sl-btn:hover { background: color-mix(in srgb, currentColor 8%, transparent); }',
      '.sl-btn:active { background: color-mix(in srgb, currentColor 13%, transparent); }',
      '.sl-btn:disabled { cursor: not-allowed; opacity: 0.5; }',
      // Dock surfaces live in the stylesheet (not inline) so hover and press can
      // actually reach them; the layout stays inline with the render code.
      '.sl-fab { border: 1px solid color-mix(in srgb, currentColor 24%, transparent); background: color-mix(in srgb, currentColor 12%, Canvas); box-shadow: 0 6px 20px rgba(0, 0, 0, 0.28); transition: background-color 120ms ease, border-color 120ms ease, box-shadow 120ms ease, opacity 120ms ease; }',
      '.sl-fab:disabled { opacity: 0.45; box-shadow: none; }',
      '.sl-fab:hover:not(:disabled) { background: color-mix(in srgb, currentColor 18%, Canvas); border-color: color-mix(in srgb, currentColor 34%, transparent); }',
      '.sl-fab:active:not(:disabled) { background: color-mix(in srgb, currentColor 23%, Canvas); }',
      '.sl-dock-secondary { border: 1px solid color-mix(in srgb, currentColor 22%, transparent); background: color-mix(in srgb, currentColor 8%, Canvas); transition: background-color 120ms ease, border-color 120ms ease; }',
      '.sl-dock-secondary:hover:not(:disabled) { background: color-mix(in srgb, currentColor 14%, Canvas); border-color: color-mix(in srgb, currentColor 30%, transparent); }',
      '.sl-dock-secondary:active:not(:disabled) { background: color-mix(in srgb, currentColor 17%, Canvas); }',
      '.sl-check { position: relative; border: 1px solid color-mix(in srgb, currentColor 38%, transparent); background: transparent; }',
      // 5px transparent halo: the pointer target grows to 24x24 while the drawn
      // box stays 14x14, so the row layout does not shift.
      '.sl-check::before { content: ""; position: absolute; inset: -5px; border-radius: 6px; }',
      '.sl-check[aria-checked="true"], .sl-check[aria-checked="mixed"] { border-color: color-mix(in srgb, currentColor 60%, transparent); background: color-mix(in srgb, currentColor 26%, transparent); }',
      '.sl-check:hover { border-color: color-mix(in srgb, currentColor 62%, transparent); }',
      // Keyboard focus only: a click never draws these rings. 50% of the label
      // colour keeps the ring above the 3:1 non-text contrast bar on white too.
      '.sl-row:focus-visible, .sl-group-head:focus-visible, .sl-check:focus-visible, .sl-btn:focus-visible, .sl-fab:focus-visible, .sl-logrow:focus-visible { outline: 2px solid color-mix(in srgb, currentColor 50%, transparent); outline-offset: 1px; }',
      // Export dock backdrop: dark edges over a light theme, light edges over a
      // dark theme, so the strip stays visible in both palettes.
      '.sl-dock { background: linear-gradient(180deg, rgba(28, 32, 38, 0.04) 0%, rgba(110, 116, 126, 0.025) 26%, rgba(235, 238, 243, 0.015) 50%, rgba(110, 116, 126, 0.025) 74%, rgba(28, 32, 38, 0.04) 100%); }',
      'body[data-ds-dark-theme] .sl-dock { background: linear-gradient(180deg, rgba(243, 246, 249, 0.04) 0%, rgba(196, 202, 210, 0.025) 26%, rgba(118, 124, 134, 0.02) 50%, rgba(196, 202, 210, 0.025) 74%, rgba(243, 246, 249, 0.04) 100%); }',
      '.sl-input::placeholder { color: color-mix(in srgb, currentColor 45%, transparent); }',
      '.sl-input:focus { outline: 2px solid color-mix(in srgb, currentColor 28%, transparent); outline-offset: -1px; }',
      // Respect the OS setting: state changes stay instant, nothing animates.
      '@media (prefers-reduced-motion: reduce) { .sl-group-head, .sl-row, .sl-logrow, .sl-check { transition: none; } }',
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
        // Log-page selection and its delete confirmation; ids come from the Host
        // so a trim of the history file cannot point at the wrong row.
        const [logsSelected, setLogsSelected] = React.useState({})
        const [logsDeleteDialog, setLogsDeleteDialog] = React.useState(null)
        const [exportDialog, setExportDialog] = React.useState(null)
        const [exportTarget, setExportTarget] = React.useState(loadExportDir)
        // Directory browser used to pick paths excluded from the workspace backup.
        // Its selection lives in the export dialog, so it resets every export.
        const [excludePicker, setExcludePicker] = React.useState(null)
        // Non-null while asking whether a missing export folder should be created.
        const [createDirPrompt, setCreateDirPrompt] = React.useState(null)
        // Import wizard state: source → preview (with mapping) → done.
        const [importDialog, setImportDialog] = React.useState(null)
        const [trashQuery, setTrashQuery] = React.useState('')
        const [trashSort, setTrashSort] = React.useState('newest')
        const [logsQuery, setLogsQuery] = React.useState('')
        const [logsSort, setLogsSort] = React.useState('newest')
        const [query, setQuery] = React.useState('')
        const [reloadToken, setReloadToken] = React.useState(0)
        // Feedback for the library's "取消归档" action and the ids in flight.
        const [unarchiveNotice, setUnarchiveNotice] = React.useState(null)
        const [unarchiving, setUnarchiving] = React.useState({})

        // The effect reads the newest snapshot without depending on it.
        const snapshotRef = React.useRef(snapshot)
        snapshotRef.current = snapshot
        // The poll reads the current view without restarting its interval.
        const viewRef = React.useRef(view)
        viewRef.current = view
        // Timestamp of the last successful read for the visible view; the
        // activity-triggered sync uses it to avoid re-reading data that is
        // already fresh.
        const lastSyncRef = React.useRef(0)
        // Root element, used to tell clicks inside this page from clicks in the
        // native sidebar or another panel.
        const rootRef = React.useRef(null)

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
              lastSyncRef.current = Date.now()
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

        // Visible-page polling, plus an activity-triggered sync. The native
        // sidebar archives and unarchives sessions outside this page and DSH
        // emits no client event for it, so a click anywhere *outside* this page
        // schedules one silent re-read (debounced so the sidebar action has
        // landed, and rate-limited so a burst of input cannot hammer the Host).
        // The slow interval stays as the safety net for changes made while the
        // user does not touch the window at all.
        React.useEffect(() => {
          let timer = null
          let activityTimer = null
          const isVisible = () => document.visibilityState !== 'hidden'
          const stop = () => {
            if (timer !== null) {
              clearInterval(timer)
              timer = null
            }
          }
          const syncActiveView = () => {
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
          const tick = () => {
            if (!isVisible()) return
            syncActiveView()
          }
          const isInsidePage = (target) => {
            const root = rootRef.current
            if (!root || !target) return false
            try {
              return root.contains(target)
            } catch {
              return false
            }
          }
          const scheduleSync = () => {
            if (!isVisible()) return
            if (activityTimer !== null) clearTimeout(activityTimer)
            activityTimer = setTimeout(() => {
              activityTimer = null
              // Fresh data needs no re-read; this also absorbs double clicks.
              if (Date.now() - lastSyncRef.current < 900) return
              syncActiveView()
            }, 450)
          }
          const onPointer = (event) => {
            // Clicks inside this page already refresh what they change.
            if (isInsidePage(event && event.target)) return
            scheduleSync()
          }
          const onKey = (event) => {
            if (isInsidePage(event && event.target)) return
            scheduleSync()
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
          const onFocus = () => scheduleSync()
          start()
          document.addEventListener('visibilitychange', onVisibility)
          document.addEventListener('pointerdown', onPointer, true)
          document.addEventListener('keydown', onKey, true)
          window.addEventListener('focus', onFocus)
          return () => {
            stop()
            if (activityTimer !== null) clearTimeout(activityTimer)
            document.removeEventListener('visibilitychange', onVisibility)
            document.removeEventListener('pointerdown', onPointer, true)
            document.removeEventListener('keydown', onKey, true)
            window.removeEventListener('focus', onFocus)
          }
        }, [])

        // Keep the un-archive feedback short-lived: it announces one action and
        // must not linger as permanent chrome.
        React.useEffect(() => {
          if (unarchiveNotice === null) return undefined
          const timer = setTimeout(() => setUnarchiveNotice(null), 5000)
          return () => clearTimeout(timer)
        }, [unarchiveNotice])

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

        // Selected log rows, restricted to what the current filter shows so a
        // hidden selection can never be deleted by accident.
        const selectedLogs = visibleLogs.filter((entry) => entry && logsSelected[entry.id] === true)
        const selectedLogsCount = selectedLogs.length
        const allLogsSelected = visibleLogs.length > 0 && selectedLogsCount === visibleLogs.length
        // Row ids come from the Host half; a Host that predates the log-delete
        // route sends none, and rows without an id cannot be addressed safely.
        const logsSelectable = logs.some((entry) => entry && typeof entry.id === 'string')

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

        /**
         * Un-archive one session straight from the library page.
         *
         * The archive flag is owned by the workspace controller, which the Client
         * half can reach through its `uiWorkspace` service — no plugin route and
         * therefore no Host round trip is needed. The row comes back into the
         * Native sidebar only after the native session list is re-pulled.
         *
         * @param {object} session archived session row.
         * @returns {Promise<void>} resolution after the row refreshed.
         */
        async function unarchiveSession(session) {
          if (!session || typeof session.id !== 'string') return
          if (unarchiving[session.id] === true) return
          const label = session.title && session.title.trim() !== '' ? session.title : session.id
          setUnarchiveNotice(null)
          setUnarchiving((current) => ({ ...current, [session.id]: true }))
          try {
            const uiWorkspace = ctx.get('uiWorkspace')
            if (!uiWorkspace || typeof uiWorkspace.unarchiveSession !== 'function') {
              throw new Error('当前环境不支持取消归档')
            }
            await uiWorkspace.unarchiveSession(session.id)
            setUnarchiveNotice(`已取消归档：${label}（侧边栏已恢复显示）`)
            setReloadToken((token) => token + 1)
            refreshNativeSessionList()
          } catch (failure) {
            const message = failure && failure.message ? failure.message : String(failure)
            setUnarchiveNotice(`取消归档失败：${label} · ${message}`)
          } finally {
            setUnarchiving((current) => {
              const next = { ...current }
              delete next[session.id]
              return next
            })
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
            lastSyncRef.current = Date.now()
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
          // Leaving the library drops its selection: a selection made before a
          // detour into the bin must not stay armed for a batch action on return.
          setSelected({})
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
            const entries = Array.isArray(payload.entries) ? payload.entries : []
            setLogs(entries)
            // Keep the selection for rows that still exist: the visible-page poll
            // refreshes this list every 15s and must not silently drop what the
            // user just picked, nor keep ids that are gone.
            const alive = new Set(entries
              .map((entry) => (entry && typeof entry.id === 'string' ? entry.id : ''))
              .filter((id) => id !== ''))
            setLogsSelected((current) => {
              const next = {}
              let changed = false
              for (const id of Object.keys(current)) {
                if (alive.has(id)) next[id] = true
                else changed = true
              }
              // Same object when nothing was dropped: the 15s poll must not
              // re-render the whole list for an unchanged selection.
              return changed ? next : current
            })
            setLogsPhase('ready')
            lastSyncRef.current = Date.now()
          } catch (failure) {
            if (silent) return
            setLogsPhase('error')
            setLogsError(failure && failure.message ? failure.message : String(failure))
          }
        }

        function openLogs() {
          setView('logs')
          setLogsError(null)
          // Same rule as the bin: a library selection does not survive the trip.
          setSelected({})
          setLogsQuery('')
          setLogsSort('newest')
          setLogsSelected({})
          setLogsDeleteDialog(null)
          refreshLogs()
        }

        function closeLogs() {
          setView('library')
          setLogsError(null)
          setLogsSelected({})
          setLogsDeleteDialog(null)
          setReloadToken((token) => token + 1)
        }

        async function confirmClearLogs() {
          setClearLogsDialog(false)
          try {
            await postJson(LOGS_CLEAR_PATH, {})
            setLogs([])
            setLogsSelected({})
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
         * Open the import wizard and preload the packages found in the default
         * export folder.
         *
         * @returns {void}
         */
        function openImportDialog() {
          setImportDialog({
            phase: 'source',
            path: '',
            dir: '',
            files: [],
            ignored: [],
            report: null,
            mapping: {},
            // Workspace-file conflict policy: skip | overwrite | newer.
            workspaceConflict: 'skip',
            outcome: null,
            error: null,
          })
          loadImportCandidates('')
        }

        /**
         * List ZIP packages in one folder.
         *
         * @param {string} dir folder to scan; empty means the default folder.
         * @returns {Promise<void>} resolution after the list was refreshed.
         */
        async function loadImportCandidates(dir) {
          try {
            const payload = await postJson(IMPORT_LIST_PATH, dir === '' ? {} : { dir })
            setImportDialog((current) => (current && current.phase === 'source'
              ? {
                  ...current,
                  dir: typeof payload.dir === 'string' ? payload.dir : '',
                  files: Array.isArray(payload.files) ? payload.files : [],
                  ignored: Array.isArray(payload.ignored) ? payload.ignored : [],
                }
              : current))
          } catch (failure) {
            setImportDialog((current) => (current
              ? { ...current, error: failure && failure.message ? failure.message : String(failure) }
              : current))
          }
        }

        /**
         * Ask the native directory picker for the folder holding the package.
         *
         * @returns {Promise<void>} resolution after the picker settled.
         */
        async function pickImportFolder() {
          try {
            const picker = ctx.get('remote.directoryPicker')
            if (!picker || typeof picker.pick !== 'function') {
              setImportDialog((current) => (current
                ? { ...current, error: '当前环境不支持文件夹选择；可以直接输入会话包路径。' }
                : current))
              return
            }
            const result = await picker.pick()
            if (!result || result.ok !== true) {
              const message = result && result.error && result.error.message
                ? result.error.message
                : '选择文件夹失败'
              setImportDialog((current) => (current ? { ...current, error: message } : current))
              return
            }
            if (typeof result.value !== 'string' || result.value.trim() === '') return
            await loadImportCandidates(result.value)
          } catch (failure) {
            setImportDialog((current) => (current
              ? { ...current, error: failure && failure.message ? failure.message : String(failure) }
              : current))
          }
        }

        /**
         * Inspect the chosen package without writing anything.
         *
         * @returns {Promise<void>} resolution after the report arrived.
         */
        async function runImportPreflight() {
          const zipPath = importDialog && typeof importDialog.path === 'string' ? importDialog.path.trim() : ''
          if (zipPath === '') return
          setImportDialog((current) => (current ? { ...current, phase: 'checking', error: null } : current))
          try {
            const payload = await postJson(IMPORT_PREFLIGHT_PATH, { path: zipPath })
            const report = payload && payload.report ? payload.report : null
            if (!report) throw new Error('预检没有返回结果')
            const mapping = {}
            for (const workspace of report.workspaces || []) {
              mapping[workspace.workspaceId] = workspace.suggestedTargetId || ''
            }
            setImportDialog((current) => (current
              ? { ...current, phase: 'preview', report, mapping, error: null }
              : current))
          } catch (failure) {
            setImportDialog((current) => (current
              ? { ...current, phase: 'source', error: failure && failure.message ? failure.message : String(failure) }
              : current))
          }
        }

        /**
         * Change one source workspace's target workspace.
         *
         * @param {string} sourceId source workspace id.
         * @param {string} targetId local workspace id, empty for ungrouped.
         * @returns {void}
         */
        function setImportMapping(sourceId, targetId) {
          setImportDialog((current) => (current && current.phase === 'preview'
            ? { ...current, mapping: { ...current.mapping, [sourceId]: targetId } }
            : current))
        }

        /**
         * Write the package into the session store.
         *
         * @returns {Promise<void>} resolution after the import finished.
         */
        async function startImport() {
          if (!importDialog || importDialog.phase !== 'preview') return
          const zipPath = importDialog.path
          const mapping = importDialog.mapping || {}
          const workspaceConflict = importDialog.workspaceConflict === 'overwrite'
            || importDialog.workspaceConflict === 'newer'
            ? importDialog.workspaceConflict
            : 'skip'
          setImportDialog((current) => (current ? { ...current, phase: 'importing', error: null } : current))
          try {
            const payload = await postJson(IMPORT_RUN_PATH, { path: zipPath, mapping, workspaceConflict })
            setImportDialog((current) => (current
              ? {
                  ...current,
                  phase: 'done',
                  outcome: {
                    imported: Number(payload.imported) || 0,
                    adopted: Number(payload.adopted) || 0,
                    skipped: Number(payload.skipped) || 0,
                    failed: Number(payload.failed) || 0,
                    results: Array.isArray(payload.results) ? payload.results : [],
                    // Counters the result screen renders; dropping them used to
                    // hide every workspace-file and attachment line.
                    workspaceFiles: payload.workspaceFiles || null,
                    attachments: payload.attachments || null,
                  },
                }
              : current))
            if ((Number(payload.imported) || 0) > 0) {
              setReloadToken((token) => token + 1)
              refreshNativeSessionList()
            }
          } catch (failure) {
            setImportDialog((current) => (current
              ? { ...current, phase: 'preview', error: failure && failure.message ? failure.message : String(failure) }
              : current))
          }
        }

        /**
         * Open the export dialog, defaulting to the last used directory.
         *
         * @returns {void}
         */
        function openExportDialog() {
          const ids = selectedVisibleIds()
          if (ids.length === 0) return
          setExcludePicker(null)
          setExportDialog({
            phase: 'choose',
            path: '',
            fileName: '',
            sessionCount: 0,
            workspaceCount: 0,
            bytes: 0,
            error: null,
            // Filled by the preflight below; the option only shows once the walk
            // actually found files to include.
            workspaceInfo: null,
            includeWorkspaceFiles: true,
            // One-off selection: it lives only in this dialog instance, so every
            // new export starts with nothing excluded by hand.
            excludePaths: [],
          })
          loadExportPreflight(ids, [])
        }

        /**
         * Read how many workspace files the selected sessions would carry.
         *
         * @param {string[]} ids selected session ids.
         * @param {string[]} excludePaths paths picked in the directory browser.
         * @returns {Promise<void>} resolution after the preview settled.
         */
        async function loadExportPreflight(ids, excludePaths) {
          const workspaceResult = await postJson(WORKSPACE_PREFLIGHT_PATH, {
            sessionIds: ids,
            excludePaths: Array.isArray(excludePaths) ? excludePaths : [],
          }).catch(() => null)
          const workspaceInfo = {
            count: workspaceResult ? Number(workspaceResult.totalFiles) || 0 : 0,
            bytes: workspaceResult ? Number(workspaceResult.totalBytes) || 0 : 0,
            truncated: workspaceResult ? workspaceResult.truncated === true : false,
            workspaces: workspaceResult && Array.isArray(workspaceResult.workspaces)
              ? workspaceResult.workspaces
              : [],
          }
          setExportDialog((current) => (current && current.phase === 'choose'
            ? {
                ...current,
                workspaceInfo,
                includeWorkspaceFiles: workspaceInfo.count > 0,
              }
            : current))
        }

        /**
         * Toggle one picked path in the export dialog's exclusion selection.
         *
         * @param {string} path absolute path inside a workspace.
         * @returns {void}
         */
        function toggleExcludePath(path) {
          if (typeof path !== 'string' || path === '') return
          setExportDialog((current) => {
            if (!current) return current
            const currentPaths = Array.isArray(current.excludePaths) ? current.excludePaths : []
            const exists = currentPaths.includes(path)
            const nextPaths = exists
              ? currentPaths.filter((entry) => entry !== path)
              : [...currentPaths, path]
            return { ...current, excludePaths: nextPaths }
          })
        }

        /**
         * Open the exclusion browser at one workspace root.
         *
         * The first level is fetched *before* the dialog is mounted: opening with
         * an empty list and filling it one frame later is what read as a flash.
         * A slow disk still gets a loading frame after a short delay, so the click
         * never looks ignored.
         *
         * @param {string} startPath initial directory (a workspace root).
         * @param {string[]} roots every workspace root of the current selection.
         * @returns {Promise<void>} resolution after the first listing arrived.
         */
        async function openExcludePicker(startPath, roots = []) {
          if (typeof startPath !== 'string' || startPath === '') return
          const availableRoots = Array.isArray(roots) && roots.length > 0 ? roots : [startPath]
          const base = {
            root: startPath,
            roots: availableRoots,
            path: startPath,
            parent: null,
            entries: [],
            truncated: false,
            loading: false,
            error: null,
          }
          let settled = false
          const slowTimer = setTimeout(() => {
            if (!settled) setExcludePicker({ ...base, loading: true })
          }, 160)
          try {
            const payload = await postJson(WORKSPACE_BROWSE_PATH, { path: startPath, root: startPath })
            settled = true
            clearTimeout(slowTimer)
            setExcludePicker({
              ...base,
              path: typeof payload.path === 'string' ? payload.path : startPath,
              root: typeof payload.root === 'string' ? payload.root : startPath,
              parent: typeof payload.parent === 'string' ? payload.parent : null,
              entries: Array.isArray(payload.entries) ? payload.entries : [],
              truncated: payload.truncated === true,
            })
          } catch (failure) {
            settled = true
            clearTimeout(slowTimer)
            setExcludePicker({
              ...base,
              error: failure && failure.message ? failure.message : String(failure),
            })
          }
        }

        /**
         * Read one directory level for the exclusion browser.
         *
         * The previous entries stay on screen while the next level loads, so
         * navigating does not flash an empty list.
         *
         * @param {string} target absolute directory path.
         * @param {string} [rootOverride] workspace root to switch to.
         * @returns {Promise<void>} resolution after the listing arrived.
         */
        async function browseExcludeDirectory(target, rootOverride) {
          const root = typeof rootOverride === 'string' && rootOverride !== ''
            ? rootOverride
            : (excludePicker && typeof excludePicker.root === 'string' ? excludePicker.root : '')
          setExcludePicker((current) => (current
            ? { ...current, root: root || current.root, loading: true, error: null }
            : current))
          try {
            const payload = await postJson(WORKSPACE_BROWSE_PATH, {
              path: target,
              ...(root !== '' ? { root } : {}),
            })
            setExcludePicker((current) => (current
              ? {
                  ...current,
                  path: typeof payload.path === 'string' ? payload.path : target,
                  root: typeof payload.root === 'string' ? payload.root : current.root,
                  parent: typeof payload.parent === 'string' ? payload.parent : null,
                  entries: Array.isArray(payload.entries) ? payload.entries : [],
                  truncated: payload.truncated === true,
                  loading: false,
                  error: null,
                }
              : current))
          } catch (failure) {
            setExcludePicker((current) => (current
              ? {
                  ...current,
                  loading: false,
                  error: failure && failure.message ? failure.message : String(failure),
                }
              : current))
          }
        }

        /**
         * Re-run the preview after the exclusion selection changed.
         *
         * @returns {void}
         */
        function refreshExcludePreview() {
          const ids = selectedVisibleIds()
          if (ids.length === 0) return
          const currentPaths = exportDialog && Array.isArray(exportDialog.excludePaths)
            ? exportDialog.excludePaths
            : []
          loadExportPreflight(ids, currentPaths)
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
              ...(exportDialog !== null && exportDialog.includeWorkspaceFiles === true
                ? { includeWorkspaceFiles: true }
                : {}),
              ...(exportDialog !== null ? {
                excludePaths: Array.isArray(exportDialog.excludePaths) ? exportDialog.excludePaths : [],
              } : {}),
            })
            saveExportDir(targetDir)
            setExportDialog({
              phase: 'done',
              fileName: typeof payload.fileName === 'string' ? payload.fileName : '',
              path: typeof payload.path === 'string' ? payload.path : '',
              sessionCount: Number(payload.sessionCount) || 0,
              workspaceCount: Number(payload.workspaceCount) || 0,
              workspaceFileCount: Number(payload.workspaceFileCount) || 0,
              workspaceFileBytes: Number(payload.workspaceFileBytes) || 0,
              workspaceFilesSkipped: Number(payload.workspaceFilesSkipped) || 0,
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

        function toggleLogSelection(id) {
          if (typeof id !== 'string' || id === '') return
          setLogsSelected((current) => {
            const next = { ...current }
            if (next[id] === true) delete next[id]
            else next[id] = true
            return next
          })
        }

        function toggleLogsSelectAll() {
          if (allLogsSelected) {
            setLogsSelected({})
            return
          }
          const next = {}
          for (const entry of visibleLogs) {
            if (entry && typeof entry.id === 'string' && entry.id !== '') next[entry.id] = true
          }
          setLogsSelected(next)
        }

        function openLogsDeleteDialog() {
          if (selectedLogs.length === 0) return
          setLogsDeleteDialog({
            ids: selectedLogs.map((entry) => entry.id),
            busy: false,
            error: null,
          })
        }

        async function confirmDeleteLogs() {
          const pendingDialog = logsDeleteDialog
          if (!pendingDialog || pendingDialog.busy === true) return
          const ids = Array.isArray(pendingDialog.ids) ? pendingDialog.ids : []
          if (ids.length === 0) {
            setLogsDeleteDialog(null)
            return
          }
          setLogsDeleteDialog({ ...pendingDialog, busy: true, error: null })
          try {
            await postJson(LOGS_DELETE_PATH, { ids })
            setLogsDeleteDialog(null)
            setLogsError(null)
            await refreshLogs()
          } catch (failure) {
            const message = failure && failure.message ? failure.message : String(failure)
            setLogsDeleteDialog((current) => (current
              ? { ...current, busy: false, error: message }
              : current))
          }
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
         * Render one count-driven dock action.
         *
         * Every view's dock shares the same rule: dim and unclickable while
         * nothing is selected, filled and highlighted as soon as a selection
         * exists, and the count only appears while it means something.
         *
         * @param {object} options render inputs.
         * @param {string} options.label label without a count.
         * @param {number} options.count selected rows.
         * @param {Function} options.onClick action.
         * @param {string} options.idleTitle hint shown while nothing is selected.
         * @param {string} options.activeTitle hint shown with a selection.
         * @returns {object} React element.
         */
        function dockCountButton(options) {
          const { label, count, onClick, idleTitle, activeTitle } = options
          const active = count > 0
          return h(
            'button',
            {
              type: 'button',
              className: 'sl-btn sl-fab',
              style: active ? fabButtonStyle : fabDisabledStyle,
              disabled: !active,
              title: active ? activeTitle : idleTitle,
              onClick,
            },
            active ? `${label} ${count}` : label,
          )
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
          const baseRowStyle = session.archived ? { ...rowStyle, opacity: 0.72 } : rowStyle
          // A checked row keeps a tint plus a left accent bar, so the selection is
          // readable when the list is scrolled away from the checkboxes.
          const rowStyleForSession = checked
            ? {
                ...baseRowStyle,
                background: 'color-mix(in srgb, currentColor 9%, transparent)',
                boxShadow: 'inset 2px 0 0 color-mix(in srgb, currentColor 48%, transparent)',
              }
            : baseRowStyle
          return h(
            'div',
            {
              key: session.id,
              className: 'sl-row',
              role: 'button',
              tabIndex: 0,
              style: rowStyleForSession,
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
            session.archived
              ? h(
                  'button',
                  {
                    key: 'unarchive',
                    type: 'button',
                    className: 'sl-btn',
                    style: rowActionStyle,
                    title: '取消归档后，这个会话会重新出现在侧边栏',
                    disabled: unarchiving[session.id] === true,
                    onClick: (event) => {
                      event.stopPropagation()
                      unarchiveSession(session)
                    },
                    onKeyDown: (event) => event.stopPropagation(),
                  },
                  unarchiving[session.id] === true ? '取消归档中…' : '取消归档',
                )
              : null,
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
            return renderPlaceholder('正在读取回收站…', null)
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
            return renderPlaceholder('回收站是空的', '删除的会话会先放在这里，可恢复或永久删除')
          }
          if (trashFamilies.length === 0) {
            return renderPlaceholder('没有匹配的回收站条目', '换个搜索词，或清空筛选后再看')
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
            return renderPlaceholder('正在读取操作日志…', null)
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
            return renderPlaceholder('暂无操作日志', '导出、导入、删除、恢复等操作都会记录在这里')
          }
          if (visibleLogs.length === 0) {
            return renderPlaceholder('没有匹配的日志', '换个搜索词试试')
          }
          return h(
            'div',
            null,
            logsError !== null ? h('div', { style: warnStyle }, logsError) : null,
            visibleLogs.map((entry, index) => {
              const at = Date.parse(entry && entry.at)
              const rowId = entry && typeof entry.id === 'string' ? entry.id : ''
              const checked = rowId !== '' && logsSelected[rowId] === true
              return h(
                'div',
                {
                  key: rowId !== '' ? rowId : `${entry && entry.at ? entry.at : ''}-${index}`,
                  className: rowId !== '' ? 'sl-logrow' : undefined,
                  role: rowId !== '' ? 'button' : undefined,
                  tabIndex: rowId !== '' ? 0 : undefined,
                  style: rowId !== ''
                    ? { ...logsRowStyle, cursor: 'pointer' }
                    : logsRowStyle,
                  onClick: rowId !== '' ? () => toggleLogSelection(rowId) : undefined,
                  onKeyDown: rowId !== ''
                    ? (event) => {
                        if (event.key !== 'Enter' && event.key !== ' ') return
                        event.preventDefault()
                        toggleLogSelection(rowId)
                      }
                    : undefined,
                },
                rowId !== ''
                  ? renderCheckbox(checked ? 'all' : 'none', () => toggleLogSelection(rowId), '勾选这条日志')
                  : null,
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
            { style: overlayStyle },
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
            { style: overlayStyle },
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
            { style: overlayStyle },
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
         * Render the confirmation for deleting the selected log rows.
         *
         * @returns {object} React element.
         */
        function renderLogsDeleteDialog() {
          const busy = logsDeleteDialog.busy === true
          const count = Array.isArray(logsDeleteDialog.ids) ? logsDeleteDialog.ids.length : 0
          return h(
            'div',
            { style: overlayStyle },
            h(
              'div',
              { style: dialogStyle, onClick: (event) => event.stopPropagation() },
              h('h2', { style: dialogTitleStyle }, '删除所选日志'),
              h(
                'p',
                { style: dialogHintStyle },
                `将删除所选的 ${count} 条操作日志。已经执行的删除、恢复操作本身不受影响。`,
              ),
              logsDeleteDialog.error
                ? h('div', { style: dialogBlockerStyle }, `失败：${logsDeleteDialog.error}`)
                : null,
              h(
                'div',
                { style: dialogActionsStyle },
                h(
                  'button',
                  {
                    className: 'sl-btn',
                    style: actionButtonStyle,
                    disabled: busy,
                    onClick: () => setLogsDeleteDialog(null),
                  },
                  '取消',
                ),
                h(
                  'button',
                  {
                    className: 'sl-btn',
                    style: dangerButtonStyle,
                    disabled: busy,
                    onClick: confirmDeleteLogs,
                  },
                  busy ? '正在删除…' : `删除 ${count} 条`,
                ),
              ),
            ),
          )
        }

        /**
         * Render the import wizard: source file, dry-run report with workspace
         * mapping, and the final per-session results.
         *
         * @returns {object} React element.
         */
        function renderImportDialog() {
          const phase = importDialog.phase
          const report = importDialog.report || null
          const outcome = importDialog.outcome || null
          const busy = phase === 'checking' || phase === 'importing'
          const reportable = report ? Math.max(0, (report.counts && report.counts.importable) || 0) : 0
          const conflictLabel = {
            exists: '本地已存在',
            pending: '待重启队列中',
            missing: '包内缺文件',
            archived: '本地已归档 · 将取消归档',
          }
          const outcomeProblems = outcome && Array.isArray(outcome.results)
            ? outcome.results.filter((result) => (
              (result.status !== 'imported' && result.status !== 'adopted')
              || Boolean(result.warning)
            ))
            : []
          const actions = []
          if (phase === 'source') {
            actions.push(h(
              'button',
              { key: 'cancel', className: 'sl-btn', style: actionButtonStyle, onClick: () => setImportDialog(null) },
              '取消',
            ))
            actions.push(h(
              'button',
              {
                key: 'check',
                className: 'sl-btn',
                style: actionButtonStyle,
                disabled: !importDialog.path || importDialog.path.trim() === '',
                onClick: runImportPreflight,
              },
              '检查会话包',
            ))
          } else if (phase === 'preview') {
            actions.push(h(
              'button',
              {
                key: 'back',
                className: 'sl-btn',
                style: actionButtonStyle,
                onClick: () => setImportDialog((current) => (current
                  ? { ...current, phase: 'source', report: null, error: null }
                  : current)),
              },
              '返回',
            ))
            actions.push(h(
              'button',
              {
                key: 'run',
                className: 'sl-btn',
                style: actionButtonStyle,
                disabled: reportable === 0,
                onClick: startImport,
              },
              `开始导入 ${reportable}`,
            ))
          } else if (phase === 'done') {
            actions.push(h(
              'button',
              { key: 'close', className: 'sl-btn', style: actionButtonStyle, onClick: () => setImportDialog(null) },
              '关闭',
            ))
          }

          const sourceFiles = Array.isArray(importDialog.files) ? importDialog.files : []
          const localWorkspaces = report && Array.isArray(report.localWorkspaces) ? report.localWorkspaces : []

          return h(
            'div',
            { style: overlayStyle },
            h(
              'div',
              { style: dialogStyle, onClick: (event) => event.stopPropagation() },
              h('h2', { style: dialogTitleStyle }, phase === 'done' ? '导入结果' : '导入会话包'),

              phase === 'source'
                ? h(
                    'div',
                    null,
                    h('p', { style: dialogHintStyle }, '选择本插件导出的会话包（.zip）：可以先检查再导入，导入不会覆盖本地已存在的会话。'),
                    h('div', { style: dialogHintStyle }, '会话包路径'),
                    h('input', {
                      className: 'sl-input',
                      style: exportInputStyle,
                      value: importDialog.path,
                      placeholder: '例如 D:\\backup\\dsh-sessions-20261029-070139.zip',
                      onChange: (event) => setImportDialog((current) => (current
                        ? { ...current, path: event.target.value, error: null }
                        : current)),
                    }),
                    h(
                      'div',
                      { style: exportChooserActionsStyle },
                      h('button', { className: 'sl-btn', style: actionButtonStyle, onClick: pickImportFolder }, '选择文件夹…'),
                      h('button', {
                        className: 'sl-btn',
                        style: actionButtonStyle,
                        onClick: () => loadImportCandidates(importDialog.dir || ''),
                      }, '刷新列表'),
                    ),
                    importDialog.dir !== ''
                      ? h('p', { style: importPathHintStyle }, `列表来源：${importDialog.dir}`)
                      : null,
                    sourceFiles.length > 0
                      ? h(
                          'div',
                          { style: importListStyle },
                          sourceFiles.map((file) => {
                            const selected = importDialog.path === file.path
                            const label = `${file.name} · ${Number(file.sessionCount) || 0} 个会话 · ${(Number(file.size) / 1048576).toFixed(2)} MB`
                            return h(
                              'button',
                              {
                                key: file.path,
                                className: 'sl-btn',
                                style: selected ? importFileButtonSelectedStyle : importFileButtonStyle,
                                'aria-pressed': selected ? 'true' : 'false',
                                onClick: () => setImportDialog((current) => (current
                                  ? { ...current, path: file.path, error: null }
                                  : current)),
                              },
                              label,
                            )
                          }),
                        )
                      : h(
                          'p',
                          { style: dialogHintStyle },
                          importDialog.dir === ''
                            ? '默认目录里没有会话包，可直接填写路径或选择其他文件夹。'
                            : '这个文件夹里没有可识别的会话包，可直接填写路径或换一个文件夹。',
                        ),
                  )
                : null,

              phase === 'checking' ? h('p', { style: dialogHintStyle }, '正在检查会话包…') : null,
              phase === 'importing' ? h('p', { style: dialogHintStyle }, '正在导入会话…') : null,

              phase === 'preview' && report
                ? h(
                    'div',
                    null,
                    h(
                      'p',
                      { style: dialogHintStyle },
                      `会话包：${report.fileName}`
                        + `${report.exportedAt ? ` · 导出时间 ${formatAbsolute(Date.parse(report.exportedAt))}` : ''}`
                        + ` · 会话 ${report.counts.sessions} 个（可导入 ${report.counts.importable} 个`
                        + `${report.counts.adoptable > 0 ? `，其中已归档 ${report.counts.adoptable} 个` : ''}`
                        + `，冲突 ${report.counts.conflicts} 个）`
                        + `${Number(report.counts.workspaceFiles) > 0
                          ? ` · 工作区附件 ${report.counts.workspaceFiles} 个（${((Number(report.counts.workspaceFileBytes) || 0) / 1048576).toFixed(2)} MB）`
                          : ''}`,
                    ),
                    ...(report.warnings || []).map((warning, index) => h(
                      'div',
                      { key: `warning-${index}`, style: loadedHintStyle },
                      warning,
                    )),
                    h(
                      'div',
                      { style: importSectionTitleStyle },
                      '会话',
                    ),
                    h(
                      'div',
                      { style: dialogListStyle },
                      report.sessions.map((session) => h(
                        'div',
                        { key: session.id, style: dialogRowStyle },
                        h(
                          'span',
                          { style: badgeStyle },
                          session.role === 'subagent' ? '子智能体/队友' : session.role === 'fork' ? '分叉' : '会话',
                        ),
                        h('span', { style: sessionTitleStyle }, session.title || session.id),
                        session.conflict === 'archived'
                          ? h('span', { style: adoptBadgeStyle }, conflictLabel.archived)
                          : session.conflict
                            ? h('span', { style: blockedBadgeStyle }, conflictLabel[session.conflict] || session.conflict)
                            : h('span', { style: badgeStyle }, `${(session.bytes / 1048576).toFixed(1)} MB`),
                      )),
                    ),
                    report.workspaces.length > 0
                      ? h('div', { style: importSectionTitleStyle }, '工作区归属')
                      : null,
                    report.workspaces.length > 0
                      ? h(
                          'p',
                          { style: dialogHintStyle },
                          '选择目标工作区：若它与会话记录的工作目录不同，导入会把该会话的工作目录改写为目标工作区的目录（只改日志头信息，历史事件保持不变）。',
                        )
                      : null,
                    report.workspaces.length > 0
                      ? h(
                          'div',
                          { style: dialogListStyle },
                          report.workspaces.map((workspace) => h(
                            'div',
                            { key: workspace.workspaceId, style: dialogRowStyle },
                            h(
                              'div',
                              { style: importMappingLabelStyle },
                              h('div', null, workspace.title || workspace.path || workspace.workspaceId),
                              h('div', { style: importPathHintStyle }, `${workspace.path || '（无路径）'} · ${workspace.sessionCount} 个会话`),
                            ),
                            h(
                              'select',
                              {
                                className: 'sl-input',
                                style: sortSelectStyle,
                                value: importDialog.mapping[workspace.workspaceId] || '',
                                onChange: (event) => setImportMapping(workspace.workspaceId, event.target.value),
                              },
                              h('option', { value: '' }, '未分组'),
                              localWorkspaces.map((local) => h(
                                'option',
                                { key: local.workspaceId, value: local.workspaceId },
                                local.title || local.path || local.workspaceId,
                              )),
                            ),
                          )),
                        )
                      : null,
                    report.workspaces.length > 0
                      ? h(
                          'div',
                          { style: importConflictBlockStyle },
                          h('div', { style: importSectionTitleStyle }, '工作区文件冲突处理'),
                          h(
                            'p',
                            { style: dialogHintStyle },
                            '目标工作区已有同名文件时怎么办（只影响工作区附件，不影响会话本身）：',
                          ),
                          h(
                            'select',
                            {
                              className: 'sl-input',
                              style: importConflictSelectStyle,
                              value: importDialog.workspaceConflict || 'skip',
                              onChange: (event) => setImportDialog((current) => (current
                                ? { ...current, workspaceConflict: event.target.value }
                                : current)),
                            },
                            h('option', { value: 'skip' }, '跳过：保留本地已有文件（默认）'),
                            h('option', { value: 'overwrite' }, '覆盖：用包内文件替换本地文件'),
                            h('option', { value: 'newer' }, '保留较新：仅当包内文件更新时覆盖'),
                          ),
                          importDialog.workspaceConflict === 'overwrite'
                            ? h('div', { style: dialogBlockerStyle }, '覆盖不可撤销：本地已有的同名文件会被包内版本替换。')
                            : null,
                          importDialog.workspaceConflict === 'newer'
                            ? h(
                                'div',
                                { style: dialogHintStyle },
                                '按导出时记录的修改时间比较；旧包若没有记录时间，该文件会按“跳过”处理。',
                              )
                            : null,
                        )
                      : null,
                  )
                : null,

              phase === 'done' && outcome
                ? h(
                    'div',
                    null,
                    h(
                      'p',
                      { style: dialogHintStyle },
                      `已导入 ${outcome.imported} 个会话`
                        + `${outcome.adopted > 0 ? `，沿用本地已归档副本 ${outcome.adopted} 个（已取消归档）` : ''}`
                        + `，跳过 ${outcome.skipped} 个，失败 ${outcome.failed} 个。`
                        + `${outcome.imported > 0 || outcome.adopted > 0 ? '会话库已刷新，可在列表中查看。' : ''}`,
                    ),
                    outcome.workspaceFiles
                      && Number(outcome.workspaceFiles.restored) + Number(outcome.workspaceFiles.overwritten)
                        + Number(outcome.workspaceFiles.skipped) > 0
                      ? h(
                          'p',
                          { style: dialogHintStyle },
                          `工作区附件：新增 ${Number(outcome.workspaceFiles.restored) || 0} 个`
                            + `${Number(outcome.workspaceFiles.overwritten) > 0 ? `，覆盖 ${outcome.workspaceFiles.overwritten} 个` : ''}`
                            + `${Number(outcome.workspaceFiles.skipped) > 0 ? `，跳过 ${outcome.workspaceFiles.skipped} 个` : ''}`
                            + `${Number(outcome.workspaceFiles.failed) > 0 ? `，失败 ${outcome.workspaceFiles.failed} 个` : ''}`
                            + '；未选择目标工作区的文件不会被写入。',
                        )
                      : null,
                    outcome.results.some((result) => result.rewritten === true)
                      ? h(
                          'p',
                          { style: dialogHintStyle },
                          `${outcome.results.filter((result) => result.rewritten === true).length} 个会话的工作目录已改写为目标工作区目录。`,
                        )
                      : null,
                    outcomeProblems.length > 0
                      ? h(
                          'div',
                          { style: dialogListStyle },
                          outcomeProblems.map((result) => h(
                            'div',
                            { key: result.id, style: dialogRowStyle },
                            h('span', { style: sessionTitleStyle }, result.title || result.id),
                            h('span', { style: blockedBadgeStyle }, result.reason || result.warning || result.status),
                          )),
                        )
                      : null,
                  )
                : null,

              importDialog.error
                ? h('div', { style: dialogBlockerStyle }, importDialog.error)
                : null,

              actions.length > 0
                ? h('div', { style: dialogActionsStyle }, actions)
                : null,
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
          const workspaceInfo = exportDialog.workspaceInfo || null
          const workspaceFileCount = workspaceInfo ? Number(workspaceInfo.count) || 0 : 0
          const includeWorkspaceFiles = exportDialog.includeWorkspaceFiles === true && workspaceFileCount > 0
          const workspaceLabel = workspaceInfo === null
            ? '正在统计工作区文件…'
            : workspaceFileCount === 0
              ? '所选会话的工作区没有可备份的文件'
              : `包含工作区附件（工作区目录下的文件）：${workspaceFileCount} 个 · ${((Number(workspaceInfo.bytes) || 0) / 1048576).toFixed(2)} MB`
                + `${workspaceInfo.truncated ? '（已达上限，部分文件未包含）' : ''}`
          // Paths picked in the exclusion browser, and the workspace roots the
          // browser may start from.
          const exportExcludePaths = Array.isArray(exportDialog.excludePaths) ? exportDialog.excludePaths : []
          const exportExcludeRoots = workspaceInfo && Array.isArray(workspaceInfo.workspaces)
            ? [...new Set(workspaceInfo.workspaces
              .map((workspace) => (typeof workspace.path === 'string' ? workspace.path : ''))
              .filter((path) => path !== ''))]
            : []
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
            { style: overlayStyle },
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
                    h(
                      'div',
                      { style: exportOptionRowStyle },
                      renderCheckbox(
                        includeWorkspaceFiles ? 'all' : 'none',
                        () => {
                          if (workspaceFileCount === 0) return
                          setExportDialog((current) => (current
                            ? { ...current, includeWorkspaceFiles: current.includeWorkspaceFiles !== true }
                            : current))
                        },
                        '包含工作区附件',
                      ),
                      h('span', { style: exportOptionLabelStyle }, workspaceLabel),
                    ),
                    h(
                      'div',
                      { style: exportExcludeBlockStyle },
                      h(
                        'div',
                        { style: dialogHintStyle },
                        '排除目录或文件（点击选择，仅本次导出有效）',
                      ),
                      h(
                        'div',
                        { style: exportExcludeActionsStyle },
                        h(
                          'button',
                          {
                            className: 'sl-btn',
                            style: actionButtonStyle,
                            disabled: exportExcludeRoots.length === 0,
                            onClick: () => openExcludePicker(exportExcludeRoots[0], exportExcludeRoots),
                          },
                          '选择要排除的目录或文件…',
                        ),
                        exportExcludePaths.length > 0
                          ? h(
                              'button',
                              {
                                className: 'sl-btn',
                                style: actionButtonStyle,
                                onClick: () => {
                                  setExportDialog((current) => (current ? { ...current, excludePaths: [] } : current))
                                  const ids = selectedVisibleIds()
                                  if (ids.length > 0) loadExportPreflight(ids, [])
                                },
                              },
                              `清空选择（${exportExcludePaths.length}）`,
                            )
                          : null,
                      ),
                      h(
                        'div',
                        {
                          className: 'sl-pathlist',
                          style: exportExcludeListStyle,
                          role: 'list',
                        },
                        exportExcludePaths.length === 0
                          ? h('div', { className: 'sl-pathlist-empty' }, '尚未选择；不选则打包工作区目录下的全部文件')
                          : exportExcludePaths.map((excludedPath) => h(
                              'div',
                              { key: excludedPath, className: 'sl-pathlist-row', role: 'listitem' },
                              h('span', { className: 'sl-pathlist-path', title: excludedPath }, excludedPath),
                              h(
                                'button',
                                {
                                  className: 'sl-btn',
                                  style: exportPathRemoveStyle,
                                  onClick: () => {
                                    // Remove one entry: the state and the preview
                                    // both have to follow, so compute the next
                                    // list once and feed it to both.
                                    const nextPaths = exportExcludePaths.filter((entry) => entry !== excludedPath)
                                    setExportDialog((current) => (current
                                      ? { ...current, excludePaths: nextPaths }
                                      : current))
                                    const ids = selectedVisibleIds()
                                    if (ids.length > 0) loadExportPreflight(ids, nextPaths)
                                  },
                                },
                                '移除',
                              ),
                            )),
                      ),
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
                        + `包内包含 ${exportDialog.workspaceCount} 个工作区的信息（ID、路径、标题）。`
                        + (Number(exportDialog.workspaceFileCount) > 0
                          ? `工作区附件 ${exportDialog.workspaceFileCount} 个（${((Number(exportDialog.workspaceFileBytes) || 0) / 1048576).toFixed(2)} MB）也已打包。`
                          : ''),
                    ),
                    Number(exportDialog.workspaceFilesSkipped) > 0
                      ? h(
                          'p',
                          { style: dialogHintStyle },
                          `有 ${Number(exportDialog.workspaceFilesSkipped) || 0} 处工作区文件未能打包（工作区不可用或超出体积上限）。`,
                        )
                      : null,
                    h('div', { style: exportPathStyle }, exportDialog.path),
                    h('p', { style: dialogHintStyle }, '会话日志按原存储格式逐字节复制；对方可用本插件的「导入会话」还原，工作区附件会写回所选工作区目录。'),
                  )
                : null,
              actions.length > 0
                ? h('div', { style: dialogActionsStyle }, actions)
                : null,
            ),
            // The exclusion browser lives inside this overlay so the page keeps a
            // single dim layer: a second full-screen scrim made the background
            // darken again whenever the picker opened.
            excludePicker !== null ? renderExcludePicker({ transparent: true }) : null,
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
            { style: overlayStyle },
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

        /**
         * Render the exclusion browser: directory list plus checkboxes.
         *
         * Picking a path only edits the export dialog's selection; the dialog is
         * re-previewed once the browser closes.
         *
         * @param {{ transparent?: boolean }} [options] transparent overlay when the
         *   browser is nested inside another dialog's scrim.
         * @returns {object | null} React element, or null when closed.
         */
        function renderExcludePicker(options = {}) {
          const picker = excludePicker
          if (picker === null) return null
          // Nested mode adds no scrim: the export overlay underneath already dims
          // the page, and a second layer made it visibly darker.
          const layerStyle = options.transparent === true
            ? { ...overlayStyle, background: 'transparent' }
            : overlayStyle
          const selection = exportDialog && Array.isArray(exportDialog.excludePaths)
            ? exportDialog.excludePaths
            : []
          const roots = Array.isArray(picker.roots) ? picker.roots : []
          // The Host already reports no parent at the workspace root; keep the
          // button disabled there so the browse cannot leave the workspace.
          const canGoUp = typeof picker.parent === 'string' && picker.parent !== ''
          const atRoot = typeof picker.path === 'string' && typeof picker.root === 'string'
            && picker.path.toLowerCase() === picker.root.toLowerCase()
          const closePicker = () => {
            setExcludePicker(null)
            refreshExcludePreview()
          }
          const formatBytes = (value) => {
            const bytes = Number(value) || 0
            if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`
            if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
            return `${bytes} B`
          }
          // Show the path relative to the workspace root, so it stays short.
          const relativeLabel = picker.root && picker.path && picker.path.length > picker.root.length
            ? `.${picker.path.slice(picker.root.length)}`
            : '（工作区根目录）'
          // Select-all works on the current level: every row listed right now.
          const listedPaths = picker.entries.map((entry) => entry.path)
          const allListed = listedPaths.length > 0 && listedPaths.every((path) => selection.includes(path))
          const toggleAllListed = () => {
            const nextSelection = allListed
              ? selection.filter((path) => !listedPaths.includes(path))
              : [...selection, ...listedPaths.filter((path) => !selection.includes(path))]
            setExportDialog((current) => (current ? { ...current, excludePaths: nextSelection } : current))
          }
          return h(
            'div',
            { style: layerStyle },
            h(
              'div',
              { style: dialogStyle, onClick: (event) => event.stopPropagation() },
              h('h2', { style: dialogTitleStyle }, '选择要排除的目录或文件'),
              h(
                'p',
                { style: dialogHintStyle },
                '勾选目录会排除它下面的全部内容；勾选文件只排除该文件。选择只对本次导出有效。',
              ),
              roots.length > 1
                ? h(
                    'select',
                    {
                      className: 'sl-input',
                      style: importConflictSelectStyle,
                      value: picker.root,
                      onChange: (event) => browseExcludeDirectory(event.target.value, event.target.value),
                    },
                    roots.map((root) => h('option', { key: root, value: root }, root)),
                  )
                : null,
              h(
                'div',
                { style: exportPickerPathStyle, title: picker.path },
                `${relativeLabel}　·　${picker.root}`,
              ),
              h(
                'div',
                { style: exportPickerBarStyle },
                h(
                  'button',
                  {
                    className: 'sl-btn',
                    style: canGoUp
                      ? actionButtonStyle
                      : { ...actionButtonStyle, opacity: 0.45, cursor: 'not-allowed' },
                    disabled: !canGoUp,
                    onClick: () => { if (canGoUp) browseExcludeDirectory(picker.parent) },
                  },
                  '上一级',
                ),
                h(
                  'button',
                  {
                    className: 'sl-btn',
                    style: listedPaths.length === 0
                      ? { ...actionButtonStyle, opacity: 0.45, cursor: 'not-allowed' }
                      : actionButtonStyle,
                    disabled: listedPaths.length === 0,
                    onClick: toggleAllListed,
                  },
                  allListed ? '取消全选' : '全选',
                ),
                h(
                  'span',
                  { style: exportPickerCountStyle },
                  atRoot ? `已到工作区根目录 · 已选 ${selection.length} 项` : `已选 ${selection.length} 项`,
                ),
              ),
              picker.error !== null
                ? h('div', { style: dialogBlockerStyle }, `读取目录失败：${picker.error}`)
                : null,
              h(
                'div',
                { style: exportPickerListStyle },
                // Keep the previous rows visible while the next level loads: a
                // blank list on every click reads as a flicker.
                picker.entries.length === 0 && picker.loading
                  ? h('div', { style: dialogHintStyle }, '正在读取目录…')
                  : picker.entries.length === 0
                    ? h('div', { style: dialogHintStyle }, '这个目录是空的')
                    : picker.entries.map((entry) => h(
                        'div',
                        { key: entry.path, style: exportPickerRowStyle },
                        renderCheckbox(
                          selection.includes(entry.path) ? 'all' : 'none',
                          () => toggleExcludePath(entry.path),
                          `排除 ${entry.name}`,
                        ),
                        h(
                          'span',
                          {
                            style: entry.isDirectory ? exportPickerDirStyle : exportPickerFileStyle,
                            title: entry.path,
                            onClick: () => { if (entry.isDirectory === true) browseExcludeDirectory(entry.path) },
                          },
                          entry.isDirectory === true ? `▸ ${entry.name}/` : entry.name,
                        ),
                        h(
                          'span',
                          { style: exportPickerSizeStyle },
                          entry.isDirectory === true ? '' : formatBytes(entry.bytes),
                        ),
                      )),
              ),
              picker.truncated
                ? h('div', { style: dialogHintStyle }, '目录项过多，仅显示前 500 项')
                : null,
              h(
                'div',
                { style: dialogActionsStyle },
                h(
                  'button',
                  { className: 'sl-btn', style: actionButtonStyle, onClick: closePicker },
                  '确定',
                ),
              ),
            ),
          )
        }

        /**
         * Render a centred empty/loading placeholder.
         *
         * Two nodes at most, and only while the list is empty, so it costs
         * nothing once rows exist.
         *
         * @param {string} title main line.
         * @param {string | null} [hint] dim second line.
         * @returns {object} React element.
         */
        function renderPlaceholder(title, hint) {
          return h(
            'div',
            { style: placeholderStyle },
            h('div', null, title),
            hint ? h('div', { style: placeholderHintStyle }, hint) : null,
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
            '返回会话库',
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
            '返回会话库',
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
              style: logsSelectable ? actionButtonStyle : { ...actionButtonStyle, opacity: 0.45, cursor: 'not-allowed' },
              disabled: !logsSelectable,
              onClick: toggleLogsSelectAll,
            },
            allLogsSelected ? '取消全选' : '全选',
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
          body = renderPlaceholder('正在读取会话…', null)
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
          body = renderPlaceholder(
            query.trim() !== '' ? '没有匹配的会话' : '还没有会话',
            query.trim() !== ''
              ? '换个搜索词，或切换筛选后再看'
              : '在任意工作区里开始一个会话后，这里会按工作区分组列出',
          )
        } else {
          body = groups.map(renderGroup)
        }

        const sources = snapshot && snapshot.sources
          ? `数据来源：工作区 ${snapshot.sources.workspaces} · 会话 ${snapshot.sources.sessions ?? snapshot.sources.summaries} · 标题 ${snapshot.sources.titles}`
          : ''

        return h(
          'div',
          { className: 'sl-root', ref: rootRef },
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
                    ? `操作日志 · ${visibleLogs.length} 条${logsQuery.trim() !== '' ? ` / 共 ${logs.length} 条` : ''}${selectedLogsCount > 0 ? ` · 已选 ${selectedLogsCount}` : ''}`
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
          view === 'library' && unarchiveNotice !== null
            ? h('div', { style: infoStyle }, unarchiveNotice)
            : null,
          h('div', { className: 'sl-scroll' }, body),
          // Floating action docks: a soft gradient panel hovering over the rows,
          // each action disabled until something is selected.
          view === 'library'
            ? h(
                'div',
                { className: 'sl-dock', style: exportDockStyle },
                h(
                  'div',
                  { style: dockActionsStyle },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'sl-btn sl-dock-secondary',
                      style: dockSecondaryButtonStyle,
                      onClick: openImportDialog,
                    },
                    '导入会话',
                  ),
                  dockCountButton({
                    label: '清除选择',
                    count: selectedCount,
                    onClick: clearSelection,
                    idleTitle: '没有已选的会话',
                    activeTitle: `清除已选的 ${selectedCount} 个会话`,
                  }),
                  dockCountButton({
                    label: '移入回收站',
                    count: selectedCount,
                    onClick: () => beginDelete(false),
                    idleTitle: '请先勾选要移入回收站的会话',
                    activeTitle: `把选中的 ${selectedCount} 个会话移入回收站`,
                  }),
                  dockCountButton({
                    label: '导出所选',
                    count: selectedCount,
                    onClick: openExportDialog,
                    idleTitle: '请先勾选要导出的会话',
                    activeTitle: `导出所选的 ${selectedCount} 个会话`,
                  }),
                ),
              )
            : null,
          // The permanent-delete action lives in the same dock so it stays put
          // while scrolling; it mirrors the export action: dim with nothing
          // selected, highlighted once something is.
          view === 'trash'
            ? h(
                'div',
                { className: 'sl-dock', style: exportDockStyle },
                h(
                  'div',
                  { style: dockActionsStyle },
                  dockCountButton({
                    label: '永久删除',
                    count: selectedTrashCount,
                    onClick: openPurgeDialog,
                    idleTitle: '请先勾选要永久删除的会话',
                    activeTitle: `永久删除所选的 ${selectedTrashCount} 个会话`,
                  }),
                ),
              )
            : null,
          // Log page: the same dock, so the destructive actions sit in one place
          // on every view. Bulk clear stays secondary; the selected-row delete is
          // the primary action and follows the same dim/highlight rule.
          view === 'logs'
            ? h(
                'div',
                { className: 'sl-dock', style: exportDockStyle },
                h(
                  'div',
                  { style: dockActionsStyle },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'sl-btn sl-dock-secondary',
                      style: dockSecondaryButtonStyle,
                      onClick: () => setClearLogsDialog(true),
                    },
                    '清空日志',
                  ),
                  dockCountButton({
                    label: '删除所选',
                    count: selectedLogsCount,
                    onClick: openLogsDeleteDialog,
                    idleTitle: '请先勾选要删除的日志',
                    activeTitle: `删除所选的 ${selectedLogsCount} 条日志`,
                  }),
                ),
              )
            : null,
          sources !== ''
            ? h('div', { style: footerStyle }, sources)
            : null,
          dialog !== null ? renderDialog() : null,
          purgeDialog !== null ? renderPurgeDialog() : null,
          clearLogsDialog ? renderClearLogsDialog() : null,
          logsDeleteDialog !== null ? renderLogsDeleteDialog() : null,
          exportDialog !== null ? renderExportDialog() : null,
          // Normally nested inside the export overlay (single scrim); this fallback
          // only matters if the picker were ever open without its parent dialog.
          exportDialog === null && excludePicker !== null ? renderExcludePicker() : null,
          importDialog !== null ? renderImportDialog() : null,
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
    const groupCountStyle = {
      flex: '0 0 auto',
      fontSize: 12,
      fontWeight: 400,
      opacity: 0.6,
      fontVariantNumeric: 'tabular-nums',
    }
    const groupTimeStyle = {
      flex: '0 0 auto',
      fontSize: 12,
      fontWeight: 400,
      opacity: 0.45,
      width: 72,
      textAlign: 'right',
      fontVariantNumeric: 'tabular-nums',
    }
    // Rows and group heads keep their background unset: the stylesheet owns the
    // hover/press tint, and an inline "transparent" would outrank it.
    const rowStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      width: '100%',
      textAlign: 'left',
      padding: '7px 10px 7px 32px',
      border: 'none',
      borderRadius: 6,
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
    const sessionTimeStyle = {
      flex: '0 0 auto',
      fontSize: 12,
      opacity: 0.45,
      width: 72,
      textAlign: 'right',
      // Equal-width digits keep the time column from jittering between rows.
      fontVariantNumeric: 'tabular-nums',
    }
    // Inline row action (currently only "取消归档"): small, quiet and clearly
    // separate from the row's own click target.
    const rowActionStyle = {
      flex: '0 0 auto',
      height: 22,
      padding: '0 9px',
      borderRadius: 999,
      border: '1px solid color-mix(in srgb, currentColor 30%, transparent)',
      color: 'inherit',
      font: 'inherit',
      fontSize: 11,
      fontWeight: 500,
      cursor: 'pointer',
    }
    const badgeStyle = {
      flex: '0 0 auto',
      fontSize: 11,
      lineHeight: '16px',
      padding: '0 6px',
      borderRadius: 999,
      border: '1px solid color-mix(in srgb, currentColor 24%, transparent)',
      opacity: 0.75,
    }
    // Layout only: the border and fill live in the stylesheet, keyed off
    // `aria-checked`, so the hover state is not blocked by an inline value.
    const checkboxStyle = () => ({
      flex: '0 0 auto',
      width: 14,
      height: 14,
      position: 'relative',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 4,
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
      // The active chip keeps its own fill; the inactive one leaves the
      // background to the stylesheet so hover feedback can show through.
      background: active ? 'color-mix(in srgb, currentColor 14%, transparent)' : undefined,
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
      border: '1px solid color-mix(in srgb, var(--sl-danger, #f06a6a) 55%, transparent)',
      color: 'var(--sl-danger-text, #f08a8a)',
      opacity: 0.9,
    }
    // Neutral sibling of the blocked badge: the row is importable, it just needs
    // the session un-archived first, so it must not read as an error.
    const adoptBadgeStyle = {
      flex: '0 0 auto',
      fontSize: 11,
      lineHeight: '16px',
      padding: '0 6px',
      borderRadius: 999,
      border: '1px solid color-mix(in srgb, currentColor 34%, transparent)',
      background: 'color-mix(in srgb, currentColor 10%, Canvas)',
      whiteSpace: 'nowrap',
      opacity: 0.9,
    }
    const dangerButtonStyle = {
      flex: '0 0 auto',
      height: 30,
      padding: '0 12px',
      borderRadius: 6,
      border: '1px solid color-mix(in srgb, var(--sl-danger, #f06a6a) 55%, transparent)',
      background: 'color-mix(in srgb, var(--sl-danger, #f06a6a) 14%, transparent)',
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
      fontVariantNumeric: 'tabular-nums',
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
      alignItems: 'center',
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
    // Attachment opt-in row: the checkbox keeps its 14px box, the label carries
    // the count and size so the option is judged before exporting.
    const exportOptionRowStyle = { display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }
    const exportOptionLabelStyle = { fontSize: 12, opacity: 0.75, lineHeight: 1.5 }
    const exportExcludeBlockStyle = { marginTop: 12 }
    const exportExcludeActionsStyle = { display: 'flex', gap: 8, marginTop: 6, marginBottom: 6 }
    // Fixed-height scroll box for the chosen paths: one item or ten, the box keeps
    // the same footprint so the dialog does not jump while paths are picked.
    const exportExcludeListStyle = {
      height: 104,
      overflowY: 'auto',
      padding: '4px 2px',
      borderRadius: 6,
      border: '1px solid color-mix(in srgb, currentColor 16%, transparent)',
      background: 'Canvas',
    }
    const exportPathRemoveStyle = {
      flex: '0 0 auto',
      padding: '1px 6px',
      fontSize: 11,
      borderRadius: 4,
      border: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
      background: 'transparent',
      color: 'inherit',
      cursor: 'pointer',
    }
    // Exclusion browser (directory list) styles.
    const exportPickerPathStyle = {
      marginBottom: 6,
      fontSize: 12,
      opacity: 0.8,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    }
    const exportPickerBarStyle = { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }
    const exportPickerCountStyle = { fontSize: 12, opacity: 0.55 }
    // Fixed height: the dialog keeps its size while navigating between a folder
    // with three entries and one with three hundred.
    const exportPickerListStyle = {
      height: 260,
      overflow: 'auto',
      border: '1px solid color-mix(in srgb, currentColor 12%, transparent)',
      borderRadius: 6,
      padding: '4px 2px',
    }
    const exportPickerRowStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '3px 6px',
      borderRadius: 4,
    }
    const exportPickerDirStyle = { flex: '1 1 auto', cursor: 'pointer', fontSize: 13 }
    const exportPickerFileStyle = { flex: '1 1 auto', cursor: 'default', fontSize: 13, opacity: 0.85 }
    const exportPickerSizeStyle = { fontSize: 11, opacity: 0.45, minWidth: 56, textAlign: 'right' }
    const importListStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
      margin: '8px 0 4px',
      maxHeight: 180,
      overflowY: 'auto',
    }
    const importFileButtonStyle = {
      height: 30,
      padding: '0 10px',
      borderRadius: 6,
      border: '1px solid color-mix(in srgb, currentColor 16%, transparent)',
      color: 'inherit',
      font: 'inherit',
      fontSize: 12,
      textAlign: 'left',
      cursor: 'pointer',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    }
    // Same highlight recipe as the dock's enabled export action: a light fill
    // mixed over Canvas, a slightly stronger border, and semibold text.
    const importFileButtonSelectedStyle = {
      ...importFileButtonStyle,
      border: '1px solid color-mix(in srgb, currentColor 24%, transparent)',
      background: 'color-mix(in srgb, currentColor 12%, Canvas)',
      fontWeight: 600,
    }
    const importSectionTitleStyle = {
      margin: '12px 0 6px',
      fontSize: 12,
      fontWeight: 600,
      opacity: 0.75,
    }
    const importMappingLabelStyle = {
      flex: '1 1 auto',
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      fontSize: 13,
    }
    const importPathHintStyle = {
      fontSize: 11,
      opacity: 0.45,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    }
    // Workspace-file conflict policy block: a full-width select plus its hint.
    const importConflictBlockStyle = { marginTop: 14 }
    const importConflictSelectStyle = {
      width: '100%',
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
      // A hairline edge keeps the strip readable when it floats over a row of
      // similar brightness; the backdrop blur stays the only expensive effect.
      border: '1px solid color-mix(in srgb, currentColor 7%, transparent)',
      backdropFilter: 'blur(8px)',
      WebkitBackdropFilter: 'blur(8px)',
      pointerEvents: 'none',
    }
    const dockActionsStyle = {
      position: 'relative',
      zIndex: 1,
      display: 'flex',
      alignItems: 'center',
      gap: 15,
      pointerEvents: 'none',
    }
    const dockSecondaryButtonStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      // Same fixed box as the export action so the dock reads as one row. The
      // surface (background/border) comes from the `.sl-dock-secondary` class so
      // hover and pressed states are not blocked by an inline value.
      width: 116,
      height: 38,
      padding: 0,
      borderRadius: 999,
      color: 'inherit',
      font: 'inherit',
      fontSize: 13,
      fontWeight: 500,
      cursor: 'pointer',
      pointerEvents: 'auto',
    }
    const fabButtonStyle = {
      position: 'relative',
      zIndex: 1,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      // Fixed width: the label gains a count while selecting, and a growing
      // button reads as jitter next to the dock's other action.
      width: 116,
      height: 38,
      padding: 0,
      borderRadius: 999,
      color: 'inherit',
      font: 'inherit',
      fontSize: 13,
      fontWeight: 600,
      cursor: 'pointer',
      pointerEvents: 'auto',
    }
    // The disabled look (dim, no shadow) comes from `.sl-fab:disabled`; the style
    // object only has to stay layout-compatible.
    const fabDisabledStyle = { ...fabButtonStyle }
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
      border: '1px solid color-mix(in srgb, var(--sl-warn, #f0b37e) 45%, transparent)',
      color: 'var(--sl-warn, #f0b37e)',
      background: 'color-mix(in srgb, var(--sl-warn, #f0b37e) 10%, transparent)',
    }
    const purgeInputStyle = {
      width: '100%',
      height: 32,
      padding: '0 10px',
      borderRadius: 6,
      border: '1px solid color-mix(in srgb, var(--sl-danger, #f06a6a) 45%, transparent)',
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
      fontSize: 13,
    }
    const placeholderStyle = {
      padding: '56px 16px',
      fontSize: 13,
      opacity: 0.55,
      textAlign: 'center',
      lineHeight: 1.6,
    }
    const placeholderHintStyle = { marginTop: 6, fontSize: 12, opacity: 0.6 }
    const infoStyle = {
      fontSize: 12,
      lineHeight: 1.6,
      padding: '8px 10px',
      margin: '4px 0 10px',
      borderRadius: 6,
      border: '1px solid color-mix(in srgb, var(--sl-info, #6aa9f0) 45%, transparent)',
      color: 'var(--sl-info, #6aa9f0)',
      background: 'color-mix(in srgb, var(--sl-info, #6aa9f0) 10%, transparent)',
    }
    const dialogBlockerStyle = {
      fontSize: 12,
      lineHeight: 1.6,
      padding: '6px 8px',
      margin: '6px 0 2px',
      borderRadius: 6,
      color: 'var(--sl-warn, #f0b37e)',
      background: 'color-mix(in srgb, var(--sl-warn, #f0b37e) 12%, transparent)',
      textAlign: 'left',
    }
    const warnStyle = {
      flex: '0 0 auto',
      padding: '6px 24px',
      fontSize: 12,
      color: 'var(--sl-warn, #f0b37e)',
      background: 'color-mix(in srgb, var(--sl-warn, #f0b37e) 12%, transparent)',
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
