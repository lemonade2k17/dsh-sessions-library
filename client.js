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
      '.sl-root { height: 100%; min-height: 0; display: flex; flex-direction: column; color: inherit; }',
      '.sl-root * { box-sizing: border-box; }',
      '.sl-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 4px 24px 24px; }',
      '.sl-scroll::-webkit-scrollbar { width: 10px; }',
      '.sl-scroll::-webkit-scrollbar-thumb { background: color-mix(in srgb, currentColor 18%, transparent); border-radius: 8px; border: 3px solid transparent; background-clip: content-box; }',
      '.sl-group-head:hover { background: color-mix(in srgb, currentColor 6%, transparent); }',
      '.sl-row:hover { background: color-mix(in srgb, currentColor 8%, transparent); }',
      '.sl-btn:hover { background: color-mix(in srgb, currentColor 8%, transparent); }',
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
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const payload = await response.json()
        if (payload && payload.ok === false) {
          throw new Error(payload.error?.message || 'request failed')
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
        const [query, setQuery] = React.useState('')
        const [reloadToken, setReloadToken] = React.useState(0)

        // The effect reads the newest snapshot without depending on it.
        const snapshotRef = React.useRef(snapshot)
        snapshotRef.current = snapshot

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

        // Visible-page polling: archiving happens in the native sidebar, so the
        // library re-reads the whole snapshot every 15s while it is on screen.
        // Hidden tabs pause; coming back refreshes once immediately.
        React.useEffect(() => {
          let timer = null
          const isVisible = () => document.visibilityState !== 'hidden'
          const stop = () => {
            if (timer !== null) {
              clearInterval(timer)
              timer = null
            }
          }
          const start = () => {
            if (timer !== null || !isVisible()) return
            timer = setInterval(() => {
              if (isVisible()) setReloadToken((token) => token + 1)
            }, 15000)
          }
          const onVisibility = () => {
            if (isVisible()) {
              start()
              setReloadToken((token) => token + 1)
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
            const sessions = (group.sessions || []).filter(keep).sort(compareSessions)
            groups.push({
              kind: 'workspace',
              id: group.id,
              title: group.title || group.path || '未命名工作区',
              path: group.path,
              sessions,
            })
          }
          const ungrouped = (snapshot.ungrouped?.sessions || []).filter(keep).sort(compareSessions)
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

        // Recycle-bin entries grouped into the families they were deleted as.
        const trashFamilies = React.useMemo(() => {
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
          families.sort((left, right) => right.deletedAt - left.deletedAt)
          return families
        }, [trash])

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
         * collapsed, nothing selected.
         */
        function resetViewState() {
          const emptyExpansion = { unarchived: {}, all: {} }
          saveExpandedGroups(emptyExpansion)
          saveFilterState('unarchived')
          setExpandedByFilter(emptyExpansion)
          setFilter('unarchived')
          setSelected({})
          setShowAll({})
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

        async function refreshTrash() {
          setTrashPhase('loading')
          setTrashError(null)
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
          refreshTrash()
        }

        function closeTrash() {
          setView('library')
          setTrashNotice(null)
          setTrashSelected({})
        }

        async function beginDelete(includeForks) {
          const ids = selectedVisibleIds()
          if (ids.length === 0) return
          const withForks = includeForks === true
          setDialog({ phase: 'loading', families: [], results: [], includeForks: withForks, error: null })
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
            })
          } catch (failure) {
            setDialog({
              phase: 'error',
              families: [],
              results: [],
              includeForks: withForks,
              error: failure && failure.message ? failure.message : String(failure),
            })
          }
        }

        function toggleIncludeForks() {
          beginDelete(dialog === null || dialog.includeForks !== true)
        }

        async function confirmDelete() {
          const ids = selectedVisibleIds()
          if (ids.length === 0) return
          const withForks = dialog === null || dialog.includeForks === true
          setDialog((current) => ({ ...(current || {}), phase: 'busy' }))
          try {
            const payload = await postJson('api/sessions-library/delete', {
              sessionIds: ids,
              includeForks: withForks,
            })
            const results = Array.isArray(payload.results) ? payload.results : []
            const trashedIds = results.filter((result) => result.status === 'trashed').map((result) => result.id)
            setDialog((current) => ({ ...(current || {}), phase: 'done', results }))
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
                  h('span', { style: trashMetaStyle }, formatRelative(family.deletedAt)),
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
                          family.entries.length > 1
                            ? `恢复会话（回到会话库，${family.entries.length} 个）`
                            : '恢复会话（回到会话库）',
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
                  h('span', { style: trashMetaStyle }, `${(entry.sizeBytes / 1048576).toFixed(1)} MB`),
                )),
              )
            }),
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
              dialog.phase === 'busy' ? h('div', { style: dialogTextStyle }, '正在移入回收站…') : null,
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

        const filterButton = (value, label, count) => h(
          'button',
          {
            className: 'sl-btn',
            style: filterButtonStyle(filter === value),
            onClick: () => changeFilter(value),
          },
          `${label} ${count}`,
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

        const controls = view === 'trash' ? trashControls : libraryControls

        let body = null
        if (view === 'trash') {
          body = renderTrash()
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
                  ? `回收站 · ${trash.length} 个会话`
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
          sources !== ''
            ? h('div', { style: footerStyle }, sources)
            : null,
          dialog !== null ? renderDialog() : null,
          purgeDialog !== null ? renderPurgeDialog() : null,
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
