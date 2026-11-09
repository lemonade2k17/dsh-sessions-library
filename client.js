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
    // Per-request budgets. The Host does not roll back file work when the
    // browser aborts, so a request that is merely slow must be allowed to
    // finish: packaging an export, writing an import or moving a full delete
    // batch all take far longer than a page read.
    const REQUEST_TIMEOUT_MS = 30000
    const BATCH_TIMEOUT_MS = 90000
    const LONG_REQUEST_TIMEOUT_MS = 180000

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
    // Same idea for the recycle bin: reopening it renders the last listing at
    // once and refreshes silently, so the loading placeholder stops flashing
    // on every visit.
    let cachedTrashEntries = null
    // And for the operation log page, which had the identical placeholder flash.
    let cachedLogEntries = null
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

    // One stylesheet for the whole page. Visual rules live here rather than in
    // inline styles so hover, focus and press states stay reachable; layout keeps
    // living with the render code, next to the markup it describes.
    const CSS = [
      // --- tokens -----------------------------------------------------------
      // Colours are mixed against `Canvas`, so the page follows the host theme
      // without a second palette. Status hues are the only saturated ones.
      '.sl-root { position: relative; height: 100%; min-height: 0; width: 100%; align-self: stretch; justify-self: stretch; flex: 1 1 auto; display: flex; flex-direction: column; color: inherit;'
        + ' --sl-line: color-mix(in srgb, currentColor 10%, transparent);'
        + ' --sl-line-strong: color-mix(in srgb, currentColor 19%, transparent);'
        + ' --sl-surface: color-mix(in srgb, currentColor 3.5%, Canvas);'
        + ' --sl-surface-2: color-mix(in srgb, currentColor 6.5%, Canvas);'
        + ' --sl-sheen: color-mix(in srgb, currentColor 5%, transparent);'
        + ' --sl-muted: color-mix(in srgb, currentColor 56%, transparent);'
        + ' --sl-faint: color-mix(in srgb, currentColor 44%, transparent);'
        + ' --sl-accent: #6d93ff; --sl-accent-ink: #0a1020;'
        + ' --sl-radius-lg: 14px; --sl-radius: 10px; --sl-radius-sm: 8px;'
        // Status colours: declared once so the light theme can use variants that
        // clear 4.5:1 on white (the dark values only reach 1.8–3.0:1 there).
        + ' --sl-danger: #f06a6a; --sl-danger-text: #f08a8a; --sl-warn: #f0b37e; --sl-info: #6aa9f0; }',
      'body:not([data-ds-dark-theme]) .sl-root { --sl-accent: #2f5bd7; --sl-accent-ink: #ffffff;'
        + ' --sl-danger: #b3261e; --sl-danger-text: #b3261e; --sl-warn: #8a5300; --sl-info: #1a5fb4; }',
      '.sl-root * { box-sizing: border-box; }',
      '.sl-root ::selection { background: color-mix(in srgb, var(--sl-accent) 30%, transparent); }',
      '.sl-container { width: 1200px; max-width: 100%; margin: 0 auto; padding: 0 20px; }',

      // --- page shell -------------------------------------------------------
      // A whisper of tint at the top edge separates the header from the rows
      // without drawing a box around it.
      '.sl-header { flex: 0 0 auto; padding: 18px 0 10px; border-bottom: 1px solid var(--sl-line);'
        + ' background: linear-gradient(180deg, color-mix(in srgb, currentColor 2.5%, Canvas) 0%, Canvas 72%); }',
      '.sl-titlebar { display: flex; align-items: center; gap: 10px; min-height: 28px; }',
      '.sl-heading { margin: 0; font-size: 16px; font-weight: 650; letter-spacing: 0.01em; }',
      '.sl-subtitle { font-size: 12px; color: var(--sl-faint); font-variant-numeric: tabular-nums; }',
      '.sl-actions { margin-left: auto; display: flex; align-items: center; gap: 2px; }',
      '.sl-toolbar { display: flex; align-items: center; gap: 8px; margin-top: 12px; animation: sl-toolbar-in 160ms cubic-bezier(0.23, 1, 0.32, 1); }',
      '.sl-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 12px 0 20px; }',
      // View panels arrive instead of switching: the incoming view fades and
      // rises over an already-vacated frame, so the swap never flashes as a
      // hard cut. The toolbar above moves less (4px) and slightly faster —
      // chrome settles first, content lands second.
      '.sl-panel { animation: sl-panel-in 200ms cubic-bezier(0.23, 1, 0.32, 1); }',
      '@keyframes sl-panel-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }',
      '@keyframes sl-toolbar-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }',

      // --- buttons ----------------------------------------------------------
      // One base for every text button: 1px hairline, 8px radius, and a press
      // that lands in 140ms so the interface answers immediately.
      '.sl-btn { border: 1px solid var(--sl-line-strong); border-radius: 8px; background: transparent; color: inherit;'
        + ' font: inherit; cursor: pointer; transition: background-color 140ms ease, border-color 140ms ease, transform 140ms ease, opacity 140ms ease; }',
      '.sl-btn:hover:not(:disabled) { background: var(--sl-surface-2); }',
      '.sl-btn:active:not(:disabled) { transform: scale(0.97); }',
      '.sl-btn:disabled { opacity: 0.45; cursor: not-allowed; }',
      // Destructive confirmations keep their hue on hover: the tint deepens behind
      // the same border instead of flashing the neutral grey hover over it.
      '.sl-btn[data-tone="danger"] { border-color: color-mix(in srgb, var(--sl-danger) 52%, transparent);'
        + ' background: color-mix(in srgb, var(--sl-danger) 12%, transparent); }',
      '.sl-btn[data-tone="danger"]:hover:not(:disabled) { border-color: color-mix(in srgb, var(--sl-danger) 68%, transparent);'
        + ' background: color-mix(in srgb, var(--sl-danger) 18%, transparent); }',
      '.sl-btn[data-tone="danger"]:active:not(:disabled) { background: color-mix(in srgb, var(--sl-danger) 24%, transparent); }',
      '.sl-btn[data-tone="danger"]:disabled { border-color: color-mix(in srgb, var(--sl-danger) 26%, transparent);'
        + ' background: color-mix(in srgb, var(--sl-danger) 6%, transparent); color: var(--sl-faint); }',
      '.sl-ghost { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 9px; border: 1px solid transparent;'
        + ' border-radius: 8px; background: transparent; color: var(--sl-muted); font: inherit; font-size: 12.5px; cursor: pointer;'
        + ' transition: background-color 140ms ease, color 140ms ease, transform 140ms ease; }',
      '.sl-ghost:hover { background: var(--sl-surface-2); color: inherit; }',
      '.sl-ghost:active { transform: scale(0.97); }',
      '.sl-ghost svg { width: 14px; height: 14px; opacity: 0.8; }',

      // --- search + segmented filter ---------------------------------------
      '.sl-search { display: flex; align-items: center; gap: 8px; flex: 1 1 auto; min-width: 160px; height: 32px; padding: 0 8px 0 10px;'
        + ' border: 1px solid var(--sl-line); border-radius: var(--sl-radius-sm); background: color-mix(in srgb, currentColor 2.5%, Canvas);'
        + ' transition: border-color 140ms ease, box-shadow 140ms ease, background-color 140ms ease; }',
      '.sl-search:focus-within { background: Canvas; border-color: color-mix(in srgb, var(--sl-accent) 55%, transparent);'
        + ' box-shadow: 0 0 0 3px color-mix(in srgb, var(--sl-accent) 15%, transparent); }',
      '.sl-search > svg { flex: 0 0 auto; width: 14px; height: 14px; color: var(--sl-faint); }',
      '.sl-search input { flex: 1 1 auto; min-width: 0; height: 100%; padding: 0; border: none; outline: none; background: transparent;'
        + ' color: inherit; font: inherit; font-size: 13px; }',
      '.sl-search input::placeholder { color: color-mix(in srgb, currentColor 38%, transparent); }',
      '.sl-search-clear { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; padding: 0;'
        + ' border: none; border-radius: 999px; background: color-mix(in srgb, currentColor 11%, transparent); color: inherit;'
        + ' cursor: pointer; opacity: 0.65; transition: opacity 120ms ease, background-color 120ms ease, transform 120ms ease; }',
      '.sl-search-clear:hover { opacity: 1; background: color-mix(in srgb, currentColor 16%, transparent); }',
      // Micro-control floor: an 18px icon button needs a visible shrink to read
      // as pressed (4% would be invisible), so the press baseline is 0.90 here —
      // the deliberate small-size exception to the 0.96 surface-button scale.
      '.sl-search-clear:active { transform: scale(0.9); }',
      '.sl-seg { display: inline-flex; align-items: center; gap: 2px; flex: 0 0 auto; padding: 2px; border: 1px solid var(--sl-line);'
        + ' border-radius: var(--sl-radius-sm); background: color-mix(in srgb, currentColor 4%, Canvas); }',
      '.sl-seg-btn { height: 24px; padding: 0 10px; border: none; border-radius: 6px; background: transparent; color: var(--sl-muted);'
        + ' font: inherit; font-size: 12px; font-weight: 500; font-variant-numeric: tabular-nums; cursor: pointer;'
        + ' transition: background-color 140ms ease, color 140ms ease, box-shadow 140ms ease, transform 140ms ease; }',
      '.sl-seg-btn:hover { color: inherit; }',
      '.sl-seg-btn:active { transform: scale(0.96); }',
      '.sl-seg-btn[data-active="true"] { background: color-mix(in srgb, currentColor 10%, Canvas); color: inherit;'
        + ' box-shadow: 0 1px 2px rgba(0, 0, 0, 0.16); }',

      // --- group card -------------------------------------------------------
      // Groups are cards: a single hairline holds a dozen rows together, which
      // reads calmer than one separator per row.
      '.sl-group { margin: 0 0 8px; border: 1px solid var(--sl-line); border-radius: var(--sl-radius-lg); background: var(--sl-surface);'
        + ' overflow: hidden; transition: border-color 160ms ease, background-color 160ms ease; }',
      // Hover lifts the edge only: tinting the whole card would flash every row
      // the moment the pointer crosses the group.
      '.sl-group:hover { border-color: var(--sl-line-strong); }',
      '.sl-group-head { display: flex; align-items: center; gap: 8px; width: 100%; padding: 9px 12px; border: none; background: transparent;'
        + ' color: inherit; font: inherit; font-size: 13px; font-weight: 600; text-align: left; cursor: pointer;'
        + ' transition: background-color 140ms ease; }',
      '.sl-group-head:hover { background: var(--sl-sheen); }',
      '.sl-group-head:active { background: color-mix(in srgb, currentColor 8%, transparent); }',
      '.sl-group-body { padding: 0 6px 6px; animation: sl-reveal 170ms cubic-bezier(0.23, 1, 0.32, 1); }',
      // Rows arrive by settling down 3px, the way a card lands when dropped;
      // collapsing stays instant because removing chrome should never wait.
      // The bin and the log use the same card shell for their flat lists.
      '.sl-list-card { border: 1px solid var(--sl-line); border-radius: var(--sl-radius-lg); background: var(--sl-surface); overflow: hidden; }',
      '.sl-list-card > *:last-child { border-bottom: none; }',
      // The bin's list settles in the same way an empty state does, so a load
      // never snaps a screenful of cards into place; a family that just left
      // (restored or purged) fades where it stands before the re-read.
      '.sl-trash-panel { animation: sl-empty-in 190ms cubic-bezier(0.23, 1, 0.32, 1) both; }',
      '.sl-trash-family[data-removing="true"] { animation: sl-trash-out 150ms ease-out both; pointer-events: none; }',
      // A workspace group whose last family left fades as a whole, so the card
      // does not simply vanish and drop the groups below it mid-read.
      '.sl-group[data-removing="true"] { animation: sl-trash-out 150ms ease-out both; pointer-events: none; }',
      // A finished library load settles in instead of snapping a screenful of
      // cards into place; the same curve as the empty state and the bin.
      '.sl-settle { animation: sl-empty-in 190ms cubic-bezier(0.23, 1, 0.32, 1) both; }',
      '@keyframes sl-trash-out { from { opacity: 1; transform: none; } to { opacity: 0; transform: translateY(-2px); } }',
      // The chevron is a drawn glyph, not a font character: it rotates in place
      // and keeps its optical centre on every platform.
      '.sl-chevron { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px;'
        + ' color: var(--sl-faint); transition: transform 200ms cubic-bezier(0.23, 1, 0.32, 1); }',
      '.sl-chevron[data-open="true"] { transform: rotate(90deg); }',
      '.sl-chevron svg { width: 16px; height: 16px; }',
      '.sl-group-title { flex: 0 0 auto; max-width: 42%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.sl-group-path { flex: 1 1 auto; min-width: 0; font-size: 11.5px; font-weight: 400; color: var(--sl-faint);'
        + ' overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.sl-count { flex: 0 0 auto; padding: 1px 7px; border-radius: 999px; background: color-mix(in srgb, currentColor 7%, transparent);'
        + ' font-size: 11px; font-weight: 500; color: var(--sl-muted); font-variant-numeric: tabular-nums; }',
      '.sl-time { flex: 0 0 auto; width: 68px; text-align: right; font-size: 11.5px; font-weight: 400; color: var(--sl-faint);'
        + ' font-variant-numeric: tabular-nums; }',

      // --- rows -------------------------------------------------------------
      '.sl-row { display: flex; align-items: center; gap: 8px; width: 100%; margin: 1px 0; padding: 7px 10px 7px 26px; border: none;'
        + ' border-radius: 8px; background: transparent; color: inherit; font: inherit; font-size: 13px; text-align: left; cursor: pointer;'
        + ' transition: background-color 120ms ease, box-shadow 120ms ease; }',
      '.sl-row:hover { background: color-mix(in srgb, currentColor 5%, transparent); }',
      '.sl-row:active { background: color-mix(in srgb, currentColor 8%, transparent); }',
      // A checked row keeps an accent tint plus a left bar, so the selection is
      // still readable when the list is scrolled away from the checkboxes.
      '.sl-row[data-checked="true"] { background: color-mix(in srgb, var(--sl-accent) 13%, transparent);'
        + ' box-shadow: inset 2px 0 0 var(--sl-accent); }',
      '.sl-row[data-checked="true"]:hover { background: color-mix(in srgb, var(--sl-accent) 17%, transparent); }',
      '.sl-logrow { border-bottom: 1px solid color-mix(in srgb, currentColor 8%, transparent); transition: background-color 120ms ease; }',
      '.sl-logrow:hover { background: var(--sl-sheen); }',
      // Log rows arrive and leave softly; an instant swap of a dense list reads
      // as a flicker. Enter runs 150ms with a short capped stagger (set inline
      // per row), exit is a quick fade so a deletion never looks stuck.
      '.sl-logrow { animation: sl-log-in 150ms cubic-bezier(0.23, 1, 0.32, 1) both; }',
      '.sl-logrow[data-removing="true"] { animation: sl-log-out 150ms ease-out both; pointer-events: none; }',
      '@keyframes sl-log-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }',
      '@keyframes sl-log-out { from { opacity: 1; transform: none; } to { opacity: 0; transform: translateY(-3px); } }',
      '.sl-badge { display: inline-flex; align-items: center; gap: 5px; flex: 0 0 auto; height: 18px; padding: 0 7px; border-radius: 999px;'
        + ' background: color-mix(in srgb, currentColor 7%, transparent); color: var(--sl-muted); font-size: 11px; font-weight: 500;'
        + ' line-height: 1; white-space: nowrap; }',
      '.sl-badge[data-tone="running"] { color: color-mix(in srgb, #59c98d 80%, currentColor);'
        + ' background: color-mix(in srgb, #59c98d 14%, transparent); }',
      '.sl-dot { width: 5px; height: 5px; border-radius: 999px; background: currentColor; }',
      // "运行中" breathes on the dot alone: it marks a live state without
      // pushing a whole-badge flicker into the periphery.
      '.sl-badge[data-tone="running"] .sl-dot { animation: sl-pulse 2.4s ease-in-out infinite; }',
      '@keyframes sl-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }',

      // --- checkbox ---------------------------------------------------------
      // The drawn box is 15px; a transparent halo grows the pointer target to
      // 27px without moving a single row. `color: transparent` hides the glyph
      // while `currentColor` still feeds the border, so the border uses the
      // system text colour instead.
      '.sl-check { position: relative; flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center;'
        + ' width: 15px; height: 15px; border: 1.5px solid color-mix(in srgb, CanvasText 30%, transparent); border-radius: 4.5px;'
        + ' background: transparent; color: transparent;'
        + ' transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease, transform 140ms cubic-bezier(0.23, 1, 0.32, 1); }',
      '.sl-check::before { content: ""; position: absolute; inset: -6px; border-radius: 7px; }',
      '.sl-check:hover { border-color: color-mix(in srgb, CanvasText 52%, transparent); }',
      // A 5% breathe up sells "recorded": the box settles a touch larger when the
      // answer is on, without ever crossing into a wobble.
      '.sl-check[aria-checked="true"], .sl-check[aria-checked="mixed"] { border-color: var(--sl-accent); background: var(--sl-accent);'
        + ' color: var(--sl-accent-ink); transform: scale(1.05); }',
      '.sl-check[aria-checked="true"]:hover, .sl-check[aria-checked="mixed"]:hover { border-color: var(--sl-accent); }',

      // --- dock -------------------------------------------------------------
      // A floating glass bar, sized to its content, sitting over the empty tail
      // the list reserves for it.
      '.sl-dock { border: 1px solid var(--sl-line-strong); border-radius: 15px;'
        + ' background: color-mix(in srgb, Canvas 82%, transparent);'
        + ' backdrop-filter: blur(18px) saturate(140%); -webkit-backdrop-filter: blur(18px) saturate(140%);'
        + ' box-shadow: 0 14px 40px rgba(0, 0, 0, 0.26), 0 1px 0 color-mix(in srgb, currentColor 6%, transparent) inset; }',
      '.sl-dock-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 32px; padding: 0 12px;'
        + ' border: 1px solid transparent; border-radius: 10px; background: transparent; color: var(--sl-muted); font: inherit;'
        + ' font-size: 12.5px; font-weight: 500; white-space: nowrap; cursor: pointer;'
        + ' transition: background-color 140ms ease, color 140ms ease, border-color 140ms ease, transform 140ms ease; }',
      '.sl-dock-btn:hover:not(:disabled) { background: var(--sl-surface-2); color: inherit; }',
      '.sl-dock-btn:active:not(:disabled) { transform: scale(0.97); }',
      '.sl-dock-btn:disabled { opacity: 0.4; cursor: not-allowed; }',
      '.sl-dock-btn[data-tone="accent"]:not(:disabled) { color: inherit; background: var(--sl-surface-2); border-color: var(--sl-line-strong); }',
      '.sl-dock-btn[data-tone="danger"]:not(:disabled) { color: var(--sl-danger-text);'
        + ' background: color-mix(in srgb, var(--sl-danger) 10%, transparent);'
        + ' border-color: color-mix(in srgb, var(--sl-danger) 38%, transparent); }',
      '.sl-dock-btn[data-tone="danger"]:hover:not(:disabled) { background: color-mix(in srgb, var(--sl-danger) 16%, transparent);'
        + ' color: var(--sl-danger-text); }',
      '.sl-dock-count { min-width: 18px; height: 18px; padding: 0 5px; display: inline-flex; align-items: center; justify-content: center;'
        + ' border-radius: 999px; background: color-mix(in srgb, currentColor 10%, transparent);'
        + ' font-size: 11px; font-variant-numeric: tabular-nums; }',
      // The dock rises 10px while fading in: it floats into place instead of
      // snapping over the last rows the pointer may still be resting on.
      '.sl-dock { animation: sl-dock-in 200ms cubic-bezier(0.23, 1, 0.32, 1) both; }',
      '@keyframes sl-dock-in { from { opacity: 0; transform: translate(-50%, 10px); } to { opacity: 1; transform: translate(-50%, 0); } }',

      // --- empty + loading --------------------------------------------------
      // An empty state settles in instead of snapping onto a blank page: one
      // quiet fade with a 6px rise. Kept on the container alone — staggering
      // the children on top of it doubled the travel and read as fussy.
      '.sl-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 76px 20px; text-align: center;'
        + ' animation: sl-empty-in 190ms cubic-bezier(0.23, 1, 0.32, 1) both; }',
      '@keyframes sl-empty-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }',
      '.sl-empty-icon { display: flex; align-items: center; justify-content: center; width: 44px; height: 44px; margin-bottom: 4px;'
        + ' border: 1px solid var(--sl-line); border-radius: 14px; background: var(--sl-surface); color: var(--sl-faint); }',
      '.sl-empty-title { font-size: 13.5px; font-weight: 600; }',
      '.sl-empty-hint { max-width: 340px; font-size: 12px; line-height: 1.65; color: var(--sl-faint); }',
      '.sl-skel { margin-bottom: 8px; padding: 14px; border: 1px solid var(--sl-line); border-radius: var(--sl-radius-lg);'
        + ' background: var(--sl-surface); }',
      '.sl-skel-line { height: 9px; border-radius: 999px; background: color-mix(in srgb, currentColor 9%, transparent);'
        + ' animation: sl-breathe 1.6s ease-in-out infinite; }',
      '.sl-skel-line + .sl-skel-line { margin-top: 9px; }',
      '@keyframes sl-breathe { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }',

      // --- dialogs ----------------------------------------------------------
      '.sl-overlay { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 24px;'
        + ' background: color-mix(in srgb, #000 55%, transparent); backdrop-filter: blur(3px);'
        + ' -webkit-backdrop-filter: blur(3px); animation: sl-fade 140ms ease-out both; }',
      '.sl-dialog { border: 1px solid var(--sl-line-strong); border-radius: 16px; background: Canvas; color: CanvasText;'
        + ' box-shadow: 0 24px 70px rgba(0, 0, 0, 0.42); animation: sl-pop 200ms cubic-bezier(0.23, 1, 0.32, 1) both; }',
      '@keyframes sl-fade { from { opacity: 0; } to { opacity: 1; } }',
      // Modals are the one surface that stays centred; they are not anchored to
      // a trigger, so a 6px lift reads as "arrived", not "shot out of nowhere".
      '@keyframes sl-pop { from { opacity: 0; transform: translateY(6px) scale(0.985); } to { opacity: 1; transform: none; } }',
      // Expansion reveal for group bodies; reserved space, no keyframe below it.
      '@keyframes sl-reveal { from { opacity: 0; transform: translateY(-3px); } }',

      // --- notices ----------------------------------------------------------
      // One recipe for every inline status strip: tone and amount of tint are
      // decided by data-tone, so an error in any dialog looks like the rest.
      '.sl-note { margin: 4px 0 10px; padding: 8px 10px; border: 1px solid transparent; border-radius: 8px; font-size: 12px; line-height: 1.6;'
        + ' animation: sl-note-in 160ms cubic-bezier(0.23, 1, 0.32, 1); }',
      '.sl-note[data-tone="info"] { border-color: color-mix(in srgb, var(--sl-info) 42%, transparent); color: var(--sl-info);'
        + ' background: color-mix(in srgb, var(--sl-info) 9%, transparent); }',
      // Stand-alone strips (top of a view) sit alone and keep their own spacing.
      '.sl-note[data-tone="warn"] { border-color: color-mix(in srgb, var(--sl-warn) 42%, transparent); color: var(--sl-warn);'
        + ' background: color-mix(in srgb, var(--sl-warn) 11%, transparent); padding: 7px 12px; margin: 0; }',
      '.sl-note[data-tone="caution"] { border-color: color-mix(in srgb, var(--sl-warn) 42%, transparent); color: var(--sl-warn);'
        + ' background: color-mix(in srgb, var(--sl-warn) 9%, transparent); }',
      // Inline error copy inside dialogs tucks closer to the fields above it.
      '.sl-note[data-tone="blocker"] { border-color: color-mix(in srgb, var(--sl-warn) 44%, transparent); color: var(--sl-warn);'
        + ' background: color-mix(in srgb, var(--sl-warn) 11%, transparent); padding: 6px 8px; margin: 6px 0 2px; }',
      '@keyframes sl-note-in { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }',

      // --- footer + inputs --------------------------------------------------
      // Root-level footer: a fixed strip under the scroll area. It sits above the
      // floating dock in the library view (the extra bottom padding is applied
      // there in the markup). The text uses the same container as the list, so it
      // lines up with the rows on a wide panel.
      '.sl-footer { flex: 0 0 auto; padding: 6px 0 10px; }',
      '.sl-footer .sl-container { font-size: 10.5px; color: var(--sl-faint); opacity: 0.8;'
        + ' white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: none; }',
      // Shared field chrome: border, fill, radius and the focus ring live here
      // so per-slot inline styles only carry geometry (width, margins, height).
      '.sl-input { height: 32px; padding: 0 8px; border: 1px solid var(--sl-line-strong); border-radius: 8px;'
        + ' background: color-mix(in srgb, currentColor 2.5%, Canvas); color: inherit; font: inherit; font-size: 12.5px; cursor: pointer;'
        + ' transition: border-color 140ms ease, background-color 140ms ease, box-shadow 140ms ease; }',
      '.sl-input::placeholder { color: color-mix(in srgb, currentColor 38%, transparent); }',
      '.sl-input:focus { outline: none; border-color: color-mix(in srgb, var(--sl-accent) 55%, transparent);'
        + ' box-shadow: 0 0 0 3px color-mix(in srgb, var(--sl-accent) 12%, transparent); }',
      '.sl-input[data-variant="danger"] { border-color: color-mix(in srgb, var(--sl-danger) 45%, transparent); }',
      // Chosen exclusion paths: a fixed-height list with its own scrollbar, so a
      // long selection stays readable instead of stretching the dialog.
      '.sl-pathlist { scrollbar-gutter: stable; }',
      '.sl-pathlist-row { display: flex; align-items: center; gap: 8px; padding: 2px 8px; font-size: 12px; line-height: 1.7; border-radius: 4px; }',
      '.sl-pathlist-row:hover { background: var(--sl-sheen); }',
      '.sl-pathlist-path { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.sl-pathlist-empty { padding: 8px; font-size: 12px; opacity: 0.5; }',

      // --- package list buttons (import wheel) ------------------------------
      // Selecting one is a durable state: its accent fill stays put while
      // hover lifts the border a notch above the resting line.
      '.sl-filebtn { height: 30px; padding: 0 10px; border: 1px solid var(--sl-line); border-radius: 8px; background: transparent;'
        + ' color: inherit; font: inherit; font-size: 12px; text-align: left; cursor: pointer; overflow: hidden; text-overflow: ellipsis;'
        + ' white-space: nowrap;'
        + ' transition: background-color 140ms ease, border-color 140ms ease, transform 140ms ease; }',
      '.sl-filebtn:hover { border-color: var(--sl-line-strong); background: color-mix(in srgb, currentColor 4%, Canvas); }',
      '.sl-filebtn:active { transform: scale(0.97); }',
      '.sl-filebtn[data-selected="true"] { border-color: color-mix(in srgb, var(--sl-accent) 45%, transparent);'
        + ' background: color-mix(in srgb, var(--sl-accent) 10%, Canvas); font-weight: 600; }',
      '.sl-filebtn[data-selected="true"]:hover { border-color: color-mix(in srgb, var(--sl-accent) 62%, transparent);'
        + ' background: color-mix(in srgb, var(--sl-accent) 15%, Canvas); }',

      // --- scrollbar + focus + motion --------------------------------------
      '.sl-root ::-webkit-scrollbar { width: 10px; height: 10px; }',
      '.sl-root ::-webkit-scrollbar-thumb { background: color-mix(in srgb, currentColor 15%, transparent); border-radius: 999px;'
        + ' border: 3px solid transparent; background-clip: content-box; }',
      '.sl-root ::-webkit-scrollbar-thumb:hover { background: color-mix(in srgb, currentColor 27%, transparent); }',
      '.sl-root ::-webkit-scrollbar-track, .sl-root ::-webkit-scrollbar-corner { background: transparent; }',
      // Keyboard focus only: a pointer click never draws these rings.
      '.sl-root :focus-visible { outline: 2px solid color-mix(in srgb, var(--sl-accent) 70%, transparent); outline-offset: 2px; }',
      '.sl-search input:focus-visible { outline: none; }',
      // The OS setting wins: state changes stay instant, nothing moves.
      '@media (prefers-reduced-motion: reduce) {'
        + ' .sl-root *, .sl-root *::before, .sl-root *::after { animation: none !important; transition: none !important; }'
        + ' .sl-chevron[data-open="true"] { transform: rotate(90deg); } }',
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

    // Small stroke icon set (24px grid, 1.85px stroke) shared by the page and
    // the dialogs. Drawn rather than typed: a glyph would inherit whichever
    // font the host happens to load.
    const ICONS = {
      chevron: ['M9 5l7 7-7 7'],
      search: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z', 'M21 21l-4.3-4.3'],
      close: ['M6 6l12 12', 'M18 6L6 18'],
      refresh: ['M20.5 12a8.5 8.5 0 1 1-2.5-6', 'M20.5 3.5V10h-6.5'],
      trash: ['M4 7h16', 'M9.5 7V4.8h5V7', 'M6.5 7l.9 12.2h9.2L17.5 7'],
      log: ['M4 6.5h16', 'M4 12h16', 'M4 17.5h10'],
      back: ['M15 5l-7 7 7 7'],
      folder: [
        // Workspace marker: the corner notch keeps it recognisable at 11px.
        'M4 8.5v-2A1.5 1.5 0 0 1 5.5 5h4l2 2.5h7A1.5 1.5 0 0 1 20 9v7.5A1.5 1.5 0 0 1 18.5 18h-13A1.5 1.5 0 0 1 4 16.5z',
      ],
      expand: [
        'M9 4H5.5A1.5 1.5 0 0 0 4 5.5V9',
        'M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9',
        'M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15',
        'M15 20h3.5a1.5 1.5 0 0 0 1.5-1.5V15',
      ],
      inbox: [
        'M4 13.5h3.5l1.2 2.4h6.6l1.2-2.4H20',
        'M4 13.5L6 5h12l2 8.5v4a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z',
      ],
      export: [
        'M12 15.5V4.5',
        'M7.5 9L12 4.5 16.5 9',
        'M5 14v4.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V14',
      ],
    }

    /**
     * Render one stroke icon from {@link ICONS}.
     *
     * @param {object} props element props.
     * @param {string} props.name key in the icon set.
     * @param {number} [props.size] edge length in px.
     * @returns {object} React element.
     */
    function Icon(props) {
      const { name, size = 14, strokeWidth = 1.85 } = props
      const paths = ICONS[name] || []
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        paths.map((path, index) => h('path', { key: index, d: path })),
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
      // The Host reads the workspace baseline, the session store and the title
      // batch one after another with bounded waits, so a slow machine can take
      // well over 20 s to answer; aborting first only reported a timeout for a
      // request that was still going to succeed.
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 45000)
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
          throw new Error('读取超时（45 秒）')
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
     * @param {{ timeoutMs?: number }} [options] per-call abort budget.
     * @returns {Promise<object>} the parsed response payload.
     */
    async function postJson(path, body, options = {}) {
      // Long operations (packaging an export, writing an import, moving a whole
      // delete batch) legitimately run past the default budget. The Host keeps
      // working after the browser gives up, so an early abort only produced a
      // false failure followed by a retry on half-applied state.
      const requestedTimeout = Number(options.timeoutMs)
      const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
        ? requestedTimeout
        : REQUEST_TIMEOUT_MS
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
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
      } catch (failure) {
        if (failure && failure.name === 'AbortError') {
          throw new Error(
            `请求超过 ${Math.round(timeoutMs / 1000)} 秒没有返回；Host 可能仍在处理，请刷新页面确认结果后再重试`,
          )
        }
        throw failure
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
        // Workspace groups in the bin start collapsed: the header already
        // carries families, sessions and size, so opening the bin gives a
        // summary to drill into, and every visit starts that way again.
        const [trashExpanded, setTrashExpanded] = React.useState({})
        // Families that just left (restored or purged) and are fading out
        // before the silent re-read swaps the list under them.
        const [trashRemoving, setTrashRemoving] = React.useState({})
        // Groups left with no family at all: they fade out together with their
        // last family, so nothing in the list disappears without a beat.
        const [trashRemovingGroups, setTrashRemovingGroups] = React.useState({})
        const [purgeDialog, setPurgeDialog] = React.useState(null)
        const [logs, setLogs] = React.useState([])
        const [logsPhase, setLogsPhase] = React.useState('idle')
        const [logsError, setLogsError] = React.useState(null)
        const [clearLogsDialog, setClearLogsDialog] = React.useState(false)
        // Log-page selection and its delete confirmation; ids come from the Host
        // so a trim of the history file cannot point at the wrong row.
        const [logsSelected, setLogsSelected] = React.useState({})
        // Rows just deleted and fading out before the list is re-read: an
        // instant swap made a deletion read as a flicker.
        const [logsRemoving, setLogsRemoving] = React.useState({})
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
        // Scroll container; a view switch resets its offset so the new view
        // starts at its own top instead of inheriting the previous list's
        // position (which makes the swap read as a content flash).
        const scrollRef = React.useRef(null)

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

        // Re-enter each view from the top. useLayoutEffect runs before the
        // browser paints, so the previous view's offset cannot flash for a
        // frame while the new panel is still transparent.
        React.useLayoutEffect(() => {
          const container = scrollRef.current
          if (container) container.scrollTop = 0
        }, [view])

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

        // The bin reads best the way the library does: one card per workspace,
        // with the families the user deleted inside it. Buckets keep a fixed
        // order — live workspaces in registry order, deleted workspaces, then
        // the ungrouped and unrecorded tails — so a group never jumps around
        // while the list refreshes.
        const trashGroups = React.useMemo(() => {
          const orderById = new Map()
          const snapshotWorkspaces = snapshot && Array.isArray(snapshot.workspaces)
            ? snapshot.workspaces
            : []
          snapshotWorkspaces.forEach((group, index) => {
            if (group && typeof group.id === 'string') orderById.set(`workspace:${group.id}`, index)
          })
          const buckets = new Map()
          for (const family of trashFamilies) {
            const rootEntry = family.entries.find((entry) => entry.role === 'root') || family.entries[0]
            const identity = readTrashWorkspaceKey(rootEntry)
            if (!buckets.has(identity.key)) {
              buckets.set(identity.key, { ...identity, families: [] })
            }
            buckets.get(identity.key).families.push(family)
          }
          const rankOf = (bucket) => {
            if (bucket.kind === 'live') return 0
            if (bucket.kind === 'gone') return 1
            if (bucket.kind === 'ungrouped') return 2
            return 3
          }
          const list = Array.from(buckets.values())
          list.sort((left, right) => {
            const rankDiff = rankOf(left) - rankOf(right)
            if (rankDiff !== 0) return rankDiff
            if (left.kind === 'live') {
              const leftOrder = orderById.has(left.key) ? orderById.get(left.key) : Number.MAX_SAFE_INTEGER
              const rightOrder = orderById.has(right.key) ? orderById.get(right.key) : Number.MAX_SAFE_INTEGER
              if (leftOrder !== rightOrder) return leftOrder - rightOrder
            }
            return left.title.localeCompare(right.title, 'zh-Hans-CN')
          })
          return list
        }, [trashFamilies, snapshot])

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
        // No visible workspace group is expanded: the toolbar button flips to
        // "全部展开" so one click opens the whole bin again.
        const trashAllCollapsed = trashGroups.length > 0
          && trashGroups.every((bucket) => trashExpanded[bucket.key] !== true)

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
          // Collapsing resets this group's "查看全部": reopening it should start
          // from the short list again rather than remembering the wide view.
          const closing = (expandedByFilter[filter] || {})[groupId] === true
          setExpandedByFilter((current) => {
            const scoped = { ...(current[filter] || {}) }
            if (scoped[groupId] === true) delete scoped[groupId]
            else scoped[groupId] = true
            const next = { ...current, [filter]: scoped }
            saveExpandedGroups(next)
            return next
          })
          if (closing) {
            setShowAll((current) => {
              if (current[groupId] !== true) return current
              const next = { ...current }
              delete next[groupId]
              return next
            })
          }
        }

        function toggleAllGroups() {
          const scoped = {}
          if (!anyOpen) {
            for (const group of groups) scoped[group.id] = true
          }
          const next = { ...expandedByFilter, [filter]: scoped }
          saveExpandedGroups(next)
          setExpandedByFilter(next)
          // 收起全部 closes every group, so every "查看全部" goes with it.
          if (anyOpen) setShowAll({})
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
            cachedTrashEntries = entries
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
          setTrashExpanded({})
          setTrashRemoving({})
          setTrashRemovingGroups({})
          // Warm start: a bin that already has a listing shows it instantly
          // and corrects itself silently, instead of flashing the loading
          // placeholder for a beat on every visit.
          if (cachedTrashEntries !== null) {
            setTrash(cachedTrashEntries)
            setTrashPhase('ready')
            refreshTrash({ silent: true })
          } else {
            refreshTrash()
          }
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
            cachedLogEntries = entries
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
          setLogsRemoving({})
          setLogsDeleteDialog(null)
          // Warm start, same as the bin: a page that already has a listing
          // shows it immediately and corrects itself silently, so visiting the
          // log no longer flashes the reading placeholder.
          if (cachedLogEntries !== null) {
            setLogs(cachedLogEntries)
            setLogsPhase('ready')
            refreshLogs({ silent: true })
          } else {
            refreshLogs()
          }
        }

        function closeLogs() {
          setView('library')
          setLogsError(null)
          setLogsSelected({})
          setLogsRemoving({})
          setLogsDeleteDialog(null)
          setReloadToken((token) => token + 1)
        }

        async function confirmClearLogs() {
          setClearLogsDialog(false)
          try {
            await postJson(LOGS_CLEAR_PATH, {})
            // Let the rows leave before the list empties: the records are
            // already gone on disk, and an instant swap of a long list reads
            // as a flicker.
            const leaving = {}
            for (const entry of logs) {
              if (entry && typeof entry.id === 'string' && entry.id !== '') leaving[entry.id] = true
            }
            if (Object.keys(leaving).length > 0) {
              setLogsRemoving(leaving)
              await new Promise((resolve) => setTimeout(resolve, 160))
            }
            setLogsRemoving({})
            // Keep the warm copy honest: the next visit must not flash the
            // rows that were just cleared.
            cachedLogEntries = []
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
            }, { timeoutMs: BATCH_TIMEOUT_MS })
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
            const payload = await postJson(IMPORT_PREFLIGHT_PATH, { path: zipPath }, { timeoutMs: BATCH_TIMEOUT_MS })
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
            const payload = await postJson(IMPORT_RUN_PATH, { path: zipPath, mapping, workspaceConflict }, {
              timeoutMs: LONG_REQUEST_TIMEOUT_MS,
            })
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
          }, { timeoutMs: BATCH_TIMEOUT_MS }).catch(() => null)
          const workspaceInfo = {
            count: workspaceResult ? Number(workspaceResult.totalFiles) || 0 : 0,
            bytes: workspaceResult ? Number(workspaceResult.totalBytes) || 0 : 0,
            truncated: workspaceResult ? workspaceResult.truncated === true : false,
            // The Host caps one batch; echo it so the dialog can say the
            // preview (and the export) only covers the head of the selection.
            limit: readBatchLimit(workspaceResult && workspaceResult.limit),
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
            }, { timeoutMs: LONG_REQUEST_TIMEOUT_MS })
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
              limit: readBatchLimit(payload.limit),
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
            }, { timeoutMs: LONG_REQUEST_TIMEOUT_MS })
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
        /**
         * Let restored or purged families fade before the list is re-read.
         *
         * The entries are already gone on the Host; keeping them on screen for
         * one short beat stops the list from jumping while the pointer is still
         * on the button that triggered the change.
         *
         * @param {string[]} entryNames names of the entries that are leaving.
         * @returns {Promise<void>} resolution after the fade finished.
         */
        async function fadeOutTrashFamilies(entryNames) {
          if (!Array.isArray(entryNames) || entryNames.length === 0) return
          const names = new Set(entryNames)
          const keys = {}
          const groupKeys = {}
          for (const bucket of trashGroups) {
            const leaving = bucket.families.filter(
              (family) => family.entries.some((entry) => entry && names.has(entry.entryName)),
            )
            if (leaving.length === 0) continue
            for (const family of leaving) keys[family.key] = true
            // A group whose every family is leaving fades as a whole.
            if (leaving.length === bucket.families.length) groupKeys[bucket.key] = true
          }
          if (Object.keys(keys).length === 0) return
          setTrashRemoving(keys)
          if (Object.keys(groupKeys).length > 0) setTrashRemovingGroups(groupKeys)
          await new Promise((resolve) => setTimeout(resolve, 160))
        }

        async function cancelQueuedPurge(entryNames) {
          if (!Array.isArray(entryNames) || entryNames.length === 0) return
          setTrashError(null)
          setTrashNotice(null)
          try {
            const payload = await postJson('api/sessions-library/trash-restore', {
              entryNames,
              cancelPurgeOnly: true,
            }, { timeoutMs: BATCH_TIMEOUT_MS })
            const results = Array.isArray(payload.results) ? payload.results : []
            const failed = results.find((result) => result.status !== 'canceled')
            if (failed) {
              setTrashError(failed.reason || '取消失败')
              await refreshTrash({ silent: true })
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
            // The entry stays in the bin here, so only the list refreshes: no
            // fade, and a silent re-read keeps the view steady.
            await refreshTrash({ silent: true })
          } catch (failure) {
            setTrashError(failure && failure.message ? failure.message : String(failure))
          }
        }

        async function restoreFamily(entryNames) {
          setTrashError(null)
          setTrashNotice(null)
          try {
            const payload = await postJson('api/sessions-library/trash-restore', { entryNames }, {
              timeoutMs: BATCH_TIMEOUT_MS,
            })
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
              // The family leaves the bin: fade it out first, then let the
              // silent re-read remove it for real.
              await fadeOutTrashFamilies(entryNames)
            }
            await refreshTrash({ silent: true })
            setTrashRemoving({})
            setTrashRemovingGroups({})
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

        function toggleTrashGroup(groupKey) {
          setTrashExpanded((current) => {
            const next = { ...current }
            if (next[groupKey] === true) delete next[groupKey]
            else next[groupKey] = true
            return next
          })
        }

        function toggleAllTrashGroups() {
          // "全部展开" fills the map; "全部收起" empties it, which is also the
          // state every fresh visit starts in.
          if (trashAllCollapsed) {
            const next = {}
            for (const bucket of trashGroups) next[bucket.key] = true
            setTrashExpanded(next)
            return
          }
          setTrashExpanded({})
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
            // Same soft exit as the bulk clear: mark the rows, let the fade
            // finish, then re-read so the page and the Host agree.
            const leaving = {}
            for (const id of ids) leaving[id] = true
            setLogsRemoving(leaving)
            await new Promise((resolve) => setTimeout(resolve, 165))
            setLogsRemoving({})
            // Drop the faded rows now instead of leaving invisible ones in
            // place while the re-read travels; the silent refresh below
            // reconciles with whatever the Host actually removed, and never
            // swaps the list for a loading placeholder mid-delete.
            const removed = new Set(ids)
            setLogs((current) => current.filter((entry) => !(entry && removed.has(entry.id))))
            await refreshLogs({ silent: true })
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
            const payload = await postJson('api/sessions-library/trash-purge', { entryNames }, {
              timeoutMs: BATCH_TIMEOUT_MS,
            })
            const results = Array.isArray(payload.results) ? payload.results : []
            setPurgeDialog((current) => ({ ...(current || {}), phase: 'done', results }))
            setTrashSelected({})
            // Only the fully purged entries leave the bin; queued ones stay
            // listed as pending, so they must not fade.
            const purgedNames = results
              .filter((result) => result && result.status === 'purged' && typeof result.entryName === 'string')
              .map((result) => result.entryName)
            await fadeOutTrashFamilies(purgedNames)
            await refreshTrash({ silent: true })
            setTrashRemoving({})
            setTrashRemovingGroups({})
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
          const { label, count, onClick, idleTitle, activeTitle, tone, icon } = options
          const active = count > 0
          return h(
            'button',
            {
              type: 'button',
              className: 'sl-dock-btn',
              'data-tone': tone === undefined ? 'plain' : tone,
              disabled: !active,
              title: active ? activeTitle : idleTitle,
              onClick,
            },
            icon ? h(Icon, { name: icon, size: 13 }) : null,
            label,
            active ? h('span', { className: 'sl-dock-count' }, count) : null,
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
          if (session.pinned) badges.push(h('span', { key: 'pin', className: 'sl-badge' }, '置顶'))
          if (session.archived) badges.push(h('span', { key: 'archived', className: 'sl-badge' }, '已归档'))
          if (session.running) {
            badges.push(
              h(
                'span',
                { key: 'running', className: 'sl-badge', 'data-tone': 'running' },
                h('span', { className: 'sl-dot' }),
                '运行中',
              ),
            )
          }
          const checked = selected[session.id] === true
          const rowStyleForSession = session.archived ? { ...rowStyle, opacity: 0.66 } : rowStyle
          return h(
            'div',
            {
              key: session.id,
              className: 'sl-row',
              // Selection is painted by the stylesheet so hover can still win.
              'data-checked': checked ? 'true' : 'false',
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
              'aria-expanded': open ? 'true' : 'false',
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
            h(
              'span',
              { className: 'sl-chevron', 'data-open': open ? 'true' : 'false' },
              h(Icon, { name: 'chevron', size: 16 }),
            ),
            h('span', { className: 'sl-group-title' }, group.title),
            group.kind === 'ungrouped'
              ? h('span', { className: 'sl-group-path' }, '工作区之外')
              : h('span', { className: 'sl-group-path', title: group.path }, group.path || ''),
            h('span', { className: 'sl-count' }, countLabel),
            h('span', { className: 'sl-time' }, formatRelative(newest?.updatedAt)),
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

          return h(
            'section',
            { key: group.id, className: 'sl-group' },
            head,
            open ? h('div', { className: 'sl-group-body' }, rows) : null,
          )
        }

        /**
         * Render the origin-workspace badge for one trash entry.
         *
         * Hints were recorded the moment the family was trashed, so a workspace
         * the user later removed can still be named; `gone` flags the case
         * where the registry lost the id. Entries deleted by an older Host
         * without hints fall back to an honest "未记录" answer.
         *
         * @param {object} entry trash entry carrying workspace hints.
         * @returns {object} React element.
         */
        /**
         * Extract the trailing segment of a filesystem path.
         *
         * @param {any} value raw path.
         * @returns {string | null} last non-empty segment, or null when there is none.
         */
        function pathTailOf(value) {
          if (typeof value !== 'string') return null
          const segments = value.split(/[\\/]+/).filter((segment) => segment !== '')
          return segments.length > 0 ? segments[segments.length - 1] : null
        }

        /**
         * Classify one trash entry into the workspace bucket it belongs to.
         *
         * The key is stable for grouping: a live workspace id, a deleted
         * workspace id (one bucket per deleted workspace), or one of the fixed
         * buckets for sessions that were ungrouped when deleted or whose origin
         * was never recorded. A Host that predates the hints sends no flag at
         * all, and every entry then lands in the "unrecorded" bucket.
         *
         * @param {object} entry trash entry carrying workspace hints.
         * @returns {{ key: string, kind: string, workspaceId: string, title: string, path: string | null }} bucket identity.
         */
        function readTrashWorkspaceKey(entry) {
          const unrecorded = {
            key: 'workspace:unrecorded',
            kind: 'unrecorded',
            workspaceId: '',
            title: '原工作区未记录',
            path: null,
          }
          if (!entry || typeof entry.workspacesRecorded !== 'boolean') return unrecorded
          const hints = Array.isArray(entry.workspaces)
            ? entry.workspaces.filter((hint) => hint && typeof hint === 'object')
            : []
          if (hints.length === 0) {
            if (entry.workspacesRecorded === true) {
              return {
                key: 'workspace:ungrouped',
                kind: 'ungrouped',
                workspaceId: '',
                title: '原工作区：未分组',
                path: null,
              }
            }
            return unrecorded
          }
          const first = hints[0]
          const workspaceId = typeof first.workspaceId === 'string' ? first.workspaceId : ''
          const name = typeof first.title === 'string' && first.title.trim() !== '' ? first.title : ''
          const path = typeof first.path === 'string' && first.path !== '' ? first.path : null
          if (first.gone === true) {
            return {
              key: `workspace-gone:${workspaceId}`,
              kind: 'gone',
              workspaceId,
              title: name ? `已删工作区 · ${name}` : '已删工作区',
              path,
            }
          }
          return {
            key: `workspace:${workspaceId}`,
            kind: 'live',
            workspaceId,
            title: name || pathTailOf(path) || '工作区',
            path,
          }
        }

        function renderTrashWorkspaceBadge(entry) {
          // A Host that predates the hints serves no workspace data at all:
          // pretending to know would be worse than silence, and the annotation
          // appears for real after DSH is restarted onto the new Host.
          if (!entry || typeof entry.workspacesRecorded !== 'boolean') return null
          const hints = Array.isArray(entry.workspaces)
            ? entry.workspaces.filter((hint) => hint && typeof hint === 'object')
            : []
          const folderGlyph = h(Icon, { name: 'folder', size: 11, strokeWidth: 2 })
          if (hints.length === 0) {
            if (entry.workspacesRecorded === true) {
              return h(
                'span',
                { style: trashWorkspaceBadgeStyle, title: '删除时该会话不属于任何工作区' },
                folderGlyph,
                '原工作区：未分组',
              )
            }
            return h(
              'span',
              {
                style: trashWorkspaceUnknownBadgeStyle,
                title: '该条目由旧版本插件删除，未记录原工作区；如需确认可看会话的原始工作目录',
              },
              folderGlyph,
              '原工作区未记录',
            )
          }
          const first = hints[0]
          const extra = hints.length > 1 ? ` +${hints.length - 1}` : ''
          const name = typeof first.title === 'string' && first.title.trim() !== ''
            ? first.title
            : null
          if (first.gone === true) {
            // The registry lost the workspace. The main label never exposes the
            // internal id; the id only rides in the tooltip as a diagnostic.
            const label = name ? `原工作区已删除 · ${name}${extra}` : `原工作区已删除${extra}`
            const tooltipParts = []
            tooltipParts.push(name ? `原工作区「${name}」已从注册表删除` : '原工作区已从注册表删除')
            if (typeof first.workspaceId === 'string' && first.workspaceId !== '') {
              tooltipParts.push(`工作区标识 ${first.workspaceId}（内部诊断用）`)
            }
            tooltipParts.push('恢复该会话不会回到原工作区')
            return h(
              'span',
              { style: trashWorkspaceGoneBadgeStyle, title: tooltipParts.join('；') },
              folderGlyph,
              label,
            )
          }
          const fallbackName = name || pathTailOf(first.path) || '工作区'
          return h(
            'span',
            { style: trashWorkspaceBadgeStyle, title: first.path || first.title || fallbackName },
            folderGlyph,
            `${fallbackName}${extra}`,
          )
        }

        /**
         * Render one recycle-bin family card.
         *
         * Inside a workspace group the card drops its own box: the group card
         * already draws it, and stacking two bordered cards read heavy. Members
         * only repeat a workspace badge when their origin differs from the
         * bucket they are listed under — the group header already names it.
         *
         * @param {object} family one delete family.
         * @param {object | null} bucket workspace bucket the family belongs to.
         * @param {boolean} isFirst whether this is the first family in the group.
         * @returns {object} React element.
         */
        /**
         * Title shown for a bin row.
         *
         * A session gets its title from a `session/title` event in its own log. A
         * session whose first turn never completed has no such event, so the trash
         * manifest stores `title: null`; showing the raw `session-<uuid>` there is
         * noise, and the library already falls back to 未命名. The id stays
         * available as the tooltip.
         *
         * @param {object} entry trash entry.
         * @returns {string} display title.
         */
        function trashTitleOf(entry) {
          const title = entry && typeof entry.title === 'string' ? entry.title.trim() : ''
          return title !== '' ? title : '未命名'
        }

        function renderTrashFamily(family, bucket, isFirst) {
          const rootEntry = family.entries.find((entry) => entry.role === 'root') || family.entries[0]
          const canRestore = family.entries.every((entry) => entry.restoreAvailable === true)
          const queuedNames = family.entries
            .filter((entry) => entry.purge === true)
            .map((entry) => entry.entryName)
          const cardStyle = bucket
            ? {
                padding: '6px 8px 8px',
                ...(isFirst ? {} : { borderTop: '1px solid color-mix(in srgb, currentColor 8%, transparent)' }),
              }
            : dialogFamilyStyle
          return h(
            'div',
            {
              key: family.key,
              className: 'sl-trash-family',
              'data-removing': trashRemoving[family.key] === true ? 'true' : 'false',
              style: cardStyle,
            },
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
                { style: sessionTitleStyle, title: rootEntry.sessionId },
                trashTitleOf(rootEntry),
              ),
              h('span', { style: badgeStyle }, `${family.entries.length} 个会话`),
              bucket ? null : renderTrashWorkspaceBadge(rootEntry),
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
              bucket && readTrashWorkspaceKey(entry).key === bucket.key
                ? null
                : renderTrashWorkspaceBadge(entry),
              h(
                'span',
                { style: sessionTitleStyle, title: entry.sessionId },
                trashTitleOf(entry),
              ),
              // Members of one delete share the family timestamp; only a
              // pending member (or a mixed family) carries its own.
              entry.deletedAt !== family.deletedAt
                ? h('span', { style: trashTimeStyle }, formatAbsolute(entry.deletedAt))
                : null,
              h('span', { style: trashMetaStyle }, `${(entry.sizeBytes / 1048576).toFixed(1)} MB`),
            )),
          )
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

          return h(
            'div',
            { className: 'sl-trash-panel' },
            trashError !== null ? h('div', { className: 'sl-note', 'data-tone': 'warn' }, trashError) : null,
            trashNotice !== null ? h('div', { className: 'sl-note', 'data-tone': 'info' }, trashNotice) : null,
            trashGroups.map((bucket) => {
              // A search forces groups open: results must be visible the moment
              // the query matches, while the manual expansion state is kept for
              // when the query is cleared.
              const searchActive = trashQuery.trim() !== ''
              const collapsed = !searchActive && trashExpanded[bucket.key] !== true
              const sessionCount = bucket.families.reduce((sum, family) => sum + family.entries.length, 0)
              const bytes = bucket.families.reduce((sum, family) => sum + family.totalBytes, 0)
              return h(
                'section',
                {
                  key: bucket.key,
                  className: 'sl-group',
                  'data-removing': trashRemovingGroups[bucket.key] === true ? 'true' : 'false',
                },
                h(
                  'div',
                  {
                    className: 'sl-group-head',
                    role: 'button',
                    tabIndex: 0,
                    'aria-expanded': collapsed ? 'false' : 'true',
                    onClick: () => toggleTrashGroup(bucket.key),
                    onKeyDown: (event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return
                      event.preventDefault()
                      toggleTrashGroup(bucket.key)
                    },
                  },
                  h(
                    'span',
                    { className: 'sl-chevron', 'data-open': collapsed ? 'false' : 'true' },
                    h(Icon, { name: 'chevron', size: 16 }),
                  ),
                  h(
                    'span',
                    {
                      className: 'sl-group-title',
                      style: bucket.kind === 'gone' ? { color: 'var(--sl-warn, #f0b37e)' } : undefined,
                    },
                    bucket.title,
                  ),
                  // Keep the flexible path slot even when the bucket has no path
                  // (a deleted workspace often has none): without it the count
                  // pill and the size collapse against the title instead of
                  // right-aligning like every other group.
                  h(
                    'span',
                    bucket.path
                      ? { className: 'sl-group-path', title: bucket.path }
                      : { className: 'sl-group-path', 'aria-hidden': 'true' },
                    bucket.path || '',
                  ),
                  h('span', { className: 'sl-count' }, `${bucket.families.length} 个家族 · ${sessionCount} 个会话`),
                  h('span', { style: trashMetaStyle }, `${(bytes / 1048576).toFixed(1)} MB`),
                ),
                collapsed
                  ? null
                  : h(
                      'div',
                      { className: 'sl-group-body' },
                      bucket.families.map((family, index) => renderTrashFamily(family, bucket, index === 0)),
                    ),
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
            logsError !== null ? h('div', { className: 'sl-note', 'data-tone': 'warn' }, logsError) : null,
            h(
              'div',
              { className: 'sl-list-card' },
              visibleLogs.map((entry, index) => {
                const at = Date.parse(entry && entry.at)
                const rowId = entry && typeof entry.id === 'string' ? entry.id : ''
                const checked = rowId !== '' && logsSelected[rowId] === true
                return h(
                  'div',
                  {
                    key: rowId !== '' ? rowId : `${entry && entry.at ? entry.at : ''}-${index}`,
                    className: 'sl-logrow',
                    // A row that is being deleted fades out where it stands;
                    // everything else enters with a short capped stagger so a
                    // full page of history never waits on its own animation.
                    'data-removing': rowId !== '' && logsRemoving[rowId] === true ? 'true' : 'false',
                    role: rowId !== '' ? 'button' : undefined,
                    tabIndex: rowId !== '' ? 0 : undefined,
                    style: {
                      ...(rowId !== '' ? { ...logsRowStyle, cursor: 'pointer' } : logsRowStyle),
                      animationDelay: rowId !== '' && logsRemoving[rowId] === true
                        ? '0ms'
                        : `${Math.min(index, 8) * 24}ms`,
                    },
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
            ),
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
              ? h('div', { className: 'sl-note', 'data-tone': 'blocker' }, family.blockers.map((blocker) => blocker.message).join('；'))
              : null,
          ))

          return h(
            'div',
            { className: 'sl-overlay', style: overlayStyle },
            h(
              'div',
              { className: 'sl-dialog', style: dialogStyle, onClick: (event) => event.stopPropagation() },
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
                    { className: 'sl-note', 'data-tone': 'caution' },
                    `本次勾选了 ${limit.requested} 个会话，单次最多处理 ${limit.max} 个，因此只会处理前 ${limit.accepted} 个；其余 ${limit.requested - limit.accepted} 个请再删一次。`,
                  )
                : null,
              dialog.phase === 'busy' ? renderDeleteProgress(dialog.progress) : null,
              dialog.phase === 'error' ? h('div', { className: 'sl-note', 'data-tone': 'blocker' }, `失败：${dialog.error}`) : null,
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
                    { className: 'sl-note', 'data-tone': 'caution' },
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
                        style: actionButtonStyle,
                        'data-tone': 'danger',
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
                  { style: sessionTitleStyle, title: rootEntry.sessionId },
                  trashTitleOf(rootEntry),
                ),
                h('span', { style: badgeStyle }, `${family.entries.length} 个会话`),
                renderTrashWorkspaceBadge(rootEntry),
                h('span', { style: trashMetaStyle }, `${(family.totalBytes / 1048576).toFixed(1)} MB`),
              ),
            )
          })

          return h(
            'div',
            { className: 'sl-overlay', style: overlayStyle },
            h(
              'div',
              { className: 'sl-dialog', style: dialogStyle, onClick: (event) => event.stopPropagation() },
              h('h2', { style: dialogTitleStyle }, purgeDialog.phase === 'done' ? doneTitle : '永久删除'),
              h(
                'p',
                { style: dialogHintStyle },
                purgeDialog.phase === 'done'
                  ? doneSummary
                  : `将永久删除 ${sessionCount} 个会话（${(totalBytes / 1048576).toFixed(1)} MB）。此操作不可恢复；附件与成本账本不会被清理。${pendingCount > 0 ? `其中 ${pendingCount} 个仍被应用打开，将在重启 DSH 后删除。` : ''}`,
              ),
              purgeDialog.phase === 'confirm' ? h('div', { style: dialogListStyle }, familyBlocks) : null,
              purgeDialog.error ? h('div', { className: 'sl-note', 'data-tone': 'blocker' }, `失败：${purgeDialog.error}`) : null,
              purgeDialog.phase === 'confirm'
                ? h(
                    'div',
                    { style: { margin: '4px 0 11px' } },
                    h('div', { style: dialogHintStyle }, '请输入「永久删除」以确认：'),
                    h('input', {
                      className: 'sl-input',
                      'data-variant': 'danger',
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
                        style: actionButtonStyle,
                        'data-tone': 'danger',
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
            { className: 'sl-overlay', style: overlayStyle },
            h(
              'div',
              { className: 'sl-dialog', style: dialogStyle, onClick: (event) => event.stopPropagation() },
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
                  { className: 'sl-btn', style: actionButtonStyle, 'data-tone': 'danger', onClick: confirmClearLogs },
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
            { className: 'sl-overlay', style: overlayStyle },
            h(
              'div',
              { className: 'sl-dialog', style: dialogStyle, onClick: (event) => event.stopPropagation() },
              h('h2', { style: dialogTitleStyle }, '删除所选日志'),
              h(
                'p',
                { style: dialogHintStyle },
                `将删除所选的 ${count} 条操作日志。已经执行的删除、恢复操作本身不受影响。`,
              ),
              logsDeleteDialog.error
                ? h('div', { className: 'sl-note', 'data-tone': 'blocker' }, `失败：${logsDeleteDialog.error}`)
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
                    style: actionButtonStyle,
                    'data-tone': 'danger',
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
            { className: 'sl-overlay', style: overlayStyle },
            h(
              'div',
              { className: 'sl-dialog', style: dialogStyle, onClick: (event) => event.stopPropagation() },
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
                                className: 'sl-filebtn',
                                'data-selected': selected ? 'true' : 'false',
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
                      { key: `warning-${index}`, className: 'sl-note', 'data-tone': 'caution' },
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
                          report.workspaces.map((workspace) => {
                            const fileCount = Number(workspace.workspaceFileCount) || 0
                            const fileBytes = Number(workspace.workspaceFileBytes) || 0
                            const mapped = (importDialog.mapping[workspace.workspaceId] || '') !== ''
                            // Scoped on purpose: the note only appears when this
                            // workspace really carries files and the sessions would land
                            // in 未分组, which is the one case where the packaged files
                            // are silently left inside the zip.
                            const showUnmappedNote = fileCount > 0 && !mapped
                            return h(
                              'div',
                              { key: workspace.workspaceId },
                              h(
                                'div',
                                { style: dialogRowStyle },
                                h(
                                  'div',
                                  { style: importMappingLabelStyle },
                                  h('div', null, workspace.title || workspace.path || workspace.workspaceId),
                                  h(
                                    'div',
                                    { style: importPathHintStyle },
                                    `${workspace.path || '（无路径）'} · ${workspace.sessionCount} 个会话`
                                      + `${fileCount > 0 ? ` · ${fileCount} 个文件（${(fileBytes / 1048576).toFixed(2)} MB）` : ''}`,
                                  ),
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
                              ),
                              showUnmappedNote
                                ? h(
                                    'div',
                                    { className: 'sl-note', 'data-tone': 'caution', style: importUnmappedNoteStyle },
                                    `未选择目标工作区：这 ${fileCount} 个文件不会写入；把会话导入到任意目标工作区后才会解压到该目录。`,
                                  )
                                : null,
                            )
                          }),
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
                            ? h('div', { className: 'sl-note', 'data-tone': 'blocker' }, '覆盖不可撤销：本地已有的同名文件会被包内版本替换。')
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
                ? h('div', { className: 'sl-note', 'data-tone': 'blocker' }, importDialog.error)
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
          // Batch bound: the Host caps one request, so the preview and the
          // finished package only cover the head of the selection. Say so
          // instead of letting "exported N" read as the whole selection.
          const batchLimit = readBatchLimit(exportDialog.limit)
            || (workspaceInfo !== null ? readBatchLimit(workspaceInfo.limit) : null)
          const batchTruncated = Boolean(batchLimit && batchLimit.requested > batchLimit.accepted)
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
            { className: 'sl-overlay', style: overlayStyle },
            h(
              'div',
              { className: 'sl-dialog', style: dialogStyle, onClick: (event) => event.stopPropagation() },
              h('h2', { style: dialogTitleStyle }, title),
              choosing
                ? h(
                    'div',
                    { style: exportChooserStyle },
                    h('p', { style: dialogHintStyle }, '选择保存位置后开始导出；留空则保存到插件默认目录（~/.dsh/sessions-library/exports）。'),
                    batchTruncated
                      ? h(
                          'div',
                          { className: 'sl-note', 'data-tone': 'caution' },
                          `本次勾选了 ${batchLimit.requested} 个会话，单次最多导出 ${batchLimit.max} 个，因此只会导出前 ${batchLimit.accepted} 个；其余 ${batchLimit.requested - batchLimit.accepted} 个请再导一次。`,
                        )
                      : null,
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
                ? h('div', { className: 'sl-note', 'data-tone': 'blocker' }, exportDialog.error)
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
                    batchTruncated
                      ? h(
                          'div',
                          { className: 'sl-note', 'data-tone': 'caution' },
                          `本次只导出了前 ${batchLimit.accepted} 个会话（单次上限 ${batchLimit.max} 个）；其余 ${batchLimit.requested - batchLimit.accepted} 个未包含在这个包里，请再导一次。`,
                        )
                      : null,
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
            { className: 'sl-overlay', style: overlayStyle },
            h(
              'div',
              { className: 'sl-dialog', style: dialogStyle, onClick: (event) => event.stopPropagation() },
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
            ? { ...overlayStyle, background: 'transparent', backdropFilter: 'none', WebkitBackdropFilter: 'none', animation: 'none' }
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
            { className: 'sl-overlay', style: layerStyle },
            h(
              'div',
              { className: 'sl-dialog', style: dialogStyle, onClick: (event) => event.stopPropagation() },
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
                ? h('div', { className: 'sl-note', 'data-tone': 'blocker' }, `读取目录失败：${picker.error}`)
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
            { className: 'sl-empty' },
            h('div', { className: 'sl-empty-icon' }, h(Icon, { name: 'inbox', size: 20 })),
            h('div', { className: 'sl-empty-title' }, title),
            hint ? h('div', { className: 'sl-empty-hint' }, hint) : null,
          )
        }

        /**
         * Skeleton cards for the first load.
         *
         * The page keeps its shape while the snapshot arrives, so the real rows
         * land without the layout jumping under the pointer.
         *
         * @returns {object} React element.
         */
        function renderSkeleton() {
          return h(
            'div',
            { 'aria-hidden': true },
            [0, 1, 2].map((index) => h(
              'div',
              { key: index, className: 'sl-skel' },
              h('div', { className: 'sl-skel-line', style: { width: `${36 + index * 8}%` } }),
              h('div', { className: 'sl-skel-line', style: { width: '16%' } }),
            )),
          )
        }

        /**
         * Render the shared search field.
         *
         * The magnifier and the clear button live inside the field so the box
         * keeps a single 32px height and never shifts while typing.
         *
         * @param {string} value current query.
         * @param {string} placeholder hint text, also used as the accessible name.
         * @param {Function} onChange change handler.
         * @returns {object} React element.
         */
        const searchBox = (value, placeholder, onChange) => h(
          'div',
          { className: 'sl-search' },
          h(Icon, { name: 'search', size: 14 }),
          h('input', {
            value,
            placeholder,
            'aria-label': placeholder,
            onChange: (event) => onChange(event.target.value),
          }),
          value !== ''
            ? h(
                'button',
                {
                  key: 'clear',
                  type: 'button',
                  className: 'sl-search-clear',
                  title: '清空搜索',
                  'aria-label': '清空搜索',
                  onClick: () => onChange(''),
                },
                h(Icon, { name: 'close', size: 11 }),
              )
            : null,
        )

        const filterButton = (value, label, count) => h(
          'button',
          {
            className: 'sl-seg-btn',
            'data-active': filter === value ? 'true' : 'false',
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
          // Keyed by view so the toolbar remounts on view switches and its
          // entrance animation plays; the same position renders children only.
          { className: 'sl-toolbar', key: view },
          searchBox(query, '搜索标题或工作区', setQuery),
          h(
            'div',
            { className: 'sl-seg' },
            filterButton('unarchived', '未归档会话', totals.active),
            filterButton('all', '全部会话', totals.total),
          ),
          h(
            'button',
            { className: 'sl-ghost', onClick: toggleAllGroups },
            h(Icon, { name: 'expand', size: 14 }),
            anyOpen ? '全部收起' : '全部展开',
          ),
        )

        const trashControls = h(
          'div',
          { className: 'sl-toolbar', key: view },
          h(
            'button',
            { className: 'sl-ghost', onClick: closeTrash },
            h(Icon, { name: 'back', size: 14 }),
            '会话库',
          ),
          searchBox(trashQuery, '搜索标题或会话 ID', setTrashQuery),
          sortSelect(trashSort, [
            { value: 'newest', label: '删除时间 新→旧' },
            { value: 'oldest', label: '删除时间 旧→新' },
            { value: 'largest', label: '体积 大→小' },
            { value: 'smallest', label: '体积 小→大' },
          ], setTrashSort),
          h(
            'button',
            { className: 'sl-ghost', onClick: toggleAllTrashGroups },
            h(Icon, { name: 'expand', size: 14 }),
            trashAllCollapsed ? '全部展开' : '全部收起',
          ),
          h(
            'button',
            { className: 'sl-ghost', onClick: toggleTrashSelectAll },
            allTrashSelected ? '取消全选' : '全选',
          ),
        )

        const logsControls = h(
          'div',
          { className: 'sl-toolbar', key: view },
          h(
            'button',
            { className: 'sl-ghost', onClick: closeLogs },
            h(Icon, { name: 'back', size: 14 }),
            '会话库',
          ),
          searchBox(logsQuery, '搜索日志内容或会话 ID', setLogsQuery),
          sortSelect(logsSort, [
            { value: 'newest', label: '时间 新→旧' },
            { value: 'oldest', label: '时间 旧→新' },
          ], setLogsSort),
          h(
            'button',
            {
              className: 'sl-ghost',
              disabled: !logsSelectable,
              style: logsSelectable ? undefined : { opacity: 0.45, cursor: 'not-allowed' },
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

        // View switching and refresh live in the title bar, so the toolbar row
        // stays dedicated to finding and filtering.
        const headerActions = h(
          'div',
          { className: 'sl-actions' },
          h(
            'button',
            {
              className: 'sl-ghost',
              onClick: () => {
                if (view === 'trash') refreshTrash()
                else if (view === 'logs') refreshLogs()
                else setReloadToken((token) => token + 1)
              },
            },
            h(Icon, { name: 'refresh', size: 14 }),
            '刷新',
          ),
          view === 'library'
            ? h(
                'button',
                { key: 'trash', className: 'sl-ghost', onClick: openTrash },
                h(Icon, { name: 'trash', size: 14 }),
                '回收站',
              )
            : null,
          view === 'library'
            ? h(
                'button',
                { key: 'logs', className: 'sl-ghost', onClick: openLogs },
                h(Icon, { name: 'log', size: 14 }),
                '操作日志',
              )
            : null,
        )

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

        const loading = view === 'library' && (phase === 'loading' || phase === 'idle')
        // Which body is on screen. The same three answers the render picks
        // between; used to decide when a fresh mount should settle in instead
        // of snapping (a finished load, or an empty state turning into rows).
        const bodyKind = view !== 'library'
          ? view
          : loading
            ? 'loading'
            : groups.length === 0
              ? 'empty'
              : 'list'

        return h(
          'div',
          { className: 'sl-root', ref: rootRef },
          h('style', null, CSS),
          h(
            'header',
            { className: 'sl-header' },
            h(
              'div',
              { className: 'sl-container' },
              h(
                'div',
                { className: 'sl-titlebar' },
                h('h1', { className: 'sl-heading' }, '会话库'),
                h(
                  'span',
                  { className: 'sl-subtitle' },
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
                headerActions,
              ),
              controls,
            ),
          ),
          refreshError !== null || (view === 'library' && unarchiveNotice !== null)
            ? h(
                'div',
                { className: 'sl-container', style: { paddingTop: 8 } },
                refreshError !== null
                  ? h('div', { className: 'sl-note', 'data-tone': 'warn' }, `刷新失败：${refreshError}（显示的是上次读取的结果）`)
                  : null,
                view === 'library' && unarchiveNotice !== null
                  ? h('div', { className: 'sl-note', 'data-tone': 'info' }, unarchiveNotice)
                  : null,
              )
            : null,
          h(
            'div',
            { className: 'sl-scroll', ref: scrollRef },
            h(
              'div',
              // Keyed by view: switching panels remounts this wrapper, so the
              // entrance animation plays exactly at the moment of the swap.
              { key: view, className: 'sl-panel sl-container' },
              h(
                'div',
                // Keyed by body kind, so finishing a load (or an empty state
                // turning into rows) mounts a fresh node that settles in rather
                // than snapping. Updates inside one kind keep the same key and
                // therefore stay instant.
                { key: bodyKind, className: bodyKind === 'list' ? 'sl-settle' : undefined },
                loading ? renderSkeleton() : body,
              ),
            ),
          ),
          // Provenance line: pinned under the list as panel chrome. Inside the
          // scroll area it looked like a stray row floating above empty space.
          sources !== ''
            ? h(
                'div',
                {
                  className: 'sl-footer',
                  style: view === 'library' ? { paddingBottom: 62 } : undefined,
                  title: sources,
                },
                h('div', { className: 'sl-container' }, sources),
              )
            : null,
          // Floating dock: one glass bar sized to its actions, each action dim
          // until something is selected.
          view === 'library'
            ? h(
                'div',
                { className: 'sl-dock', style: exportDockStyle },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'sl-dock-btn',
                    onClick: openImportDialog,
                  },
                  h(Icon, { name: 'inbox', size: 14 }),
                  '导入会话',
                ),
                dockCountButton({
                  label: '清除选择',
                  count: selectedCount,
                  icon: 'close',
                  onClick: clearSelection,
                  idleTitle: '没有已选的会话',
                  activeTitle: `清除已选的 ${selectedCount} 个会话`,
                }),
                dockCountButton({
                  label: '移入回收站',
                  count: selectedCount,
                  tone: 'danger',
                  icon: 'trash',
                  onClick: () => beginDelete(false),
                  idleTitle: '请先勾选要移入回收站的会话',
                  activeTitle: `把选中的 ${selectedCount} 个会话移入回收站`,
                }),
                dockCountButton({
                  label: '导出所选',
                  count: selectedCount,
                  tone: 'accent',
                  icon: 'export',
                  onClick: openExportDialog,
                  idleTitle: '请先勾选要导出的会话',
                  activeTitle: `导出所选的 ${selectedCount} 个会话`,
                }),
              )
            : null,
          // The permanent-delete action lives in the same dock so it stays put
          // while scrolling; it mirrors the export action: dim with nothing
          // selected, highlighted once something is.
          view === 'trash'
            ? h(
                'div',
                { className: 'sl-dock', style: exportDockStyle },
                dockCountButton({
                  label: '永久删除',
                  count: selectedTrashCount,
                  tone: 'danger',
                  icon: 'trash',
                  onClick: openPurgeDialog,
                  idleTitle: '请先勾选要永久删除的会话',
                  activeTitle: `永久删除所选的 ${selectedTrashCount} 个会话`,
                }),
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
                  'button',
                  {
                    type: 'button',
                    className: 'sl-dock-btn',
                    onClick: () => setClearLogsDialog(true),
                  },
                  '清空日志',
                ),
                dockCountButton({
                  label: '删除所选',
                  count: selectedLogsCount,
                  tone: 'danger',
                  icon: 'trash',
                  onClick: openLogsDeleteDialog,
                  idleTitle: '请先勾选要删除的日志',
                  activeTitle: `删除所选的 ${selectedLogsCount} 条日志`,
                }),
              )
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

    // Layout constants. Colour, border, radius, shadow and motion live in the
    // stylesheet; what stays here is box geometry the render code reads best
    // next to the markup that uses it.

    const rowStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      width: '100%',
      padding: '7px 10px 7px 26px',
      border: 'none',
      borderRadius: 8,
      color: 'inherit',
      font: 'inherit',
      fontSize: 13,
      textAlign: 'left',
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
      width: 68,
      textAlign: 'right',
      fontSize: 11.5,
      color: 'var(--sl-faint)',
      // Equal-width digits keep the time column from jittering between rows.
      fontVariantNumeric: 'tabular-nums',
    }
    // Inline row action (currently only "取消归档"): small, quiet, and clearly
    // separate from the row's own click target.
    const rowActionStyle = {
      flex: '0 0 auto',
      height: 20,
      padding: '0 8px',
      borderRadius: 999,
      fontSize: 11,
      fontWeight: 500,
      color: 'var(--sl-muted)',
    }
    const badgeStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      flex: '0 0 auto',
      height: 18,
      padding: '0 7px',
      borderRadius: 999,
      background: 'color-mix(in srgb, currentColor 7%, transparent)',
      color: 'var(--sl-muted)',
      fontSize: 11,
      lineHeight: 1,
      whiteSpace: 'nowrap',
    }
    // Trash rows carry the origin workspace next to the title, so a purge
    // decision can be judged against the workspace a session came from — even
    // when that workspace is gone by now. The info tone plus a folder glyph
    // keep the badge recognisable at a glance; warn tones mark the gone case.
    const trashWorkspaceBadgeStyle = {
      ...badgeStyle,
      gap: 5,
      maxWidth: 240,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      color: 'var(--sl-info, #6aa9f0)',
      background: 'color-mix(in srgb, var(--sl-info, #6aa9f0) 10%, transparent)',
      fontWeight: 500,
    }
    const trashWorkspaceGoneBadgeStyle = {
      ...trashWorkspaceBadgeStyle,
      color: 'var(--sl-warn, #f0b37e)',
      background: 'color-mix(in srgb, var(--sl-warn, #f0b37e) 16%, transparent)',
      border: '1px solid color-mix(in srgb, var(--sl-warn, #f0b37e) 45%, transparent)',
      lineHeight: '16px',
      fontWeight: 600,
    }
    // Entries deleted before hints were recorded: the facts are simply missing,
    // so the badge stays quiet instead of dressing ignorance up as a result.
    const trashWorkspaceUnknownBadgeStyle = {
      ...badgeStyle,
      gap: 5,
      maxWidth: 240,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      opacity: 0.8,
    }
    // Layout only: the border, fill and glyph colour live in the stylesheet,
    // keyed off `aria-checked`, so hover is never blocked by an inline value.
    const checkboxStyle = () => ({
      flex: '0 0 auto',
      width: 15,
      height: 15,
      fontSize: 9.5,
      lineHeight: 1,
      cursor: 'pointer',
      userSelect: 'none',
    })
    const showAllButtonStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      margin: '2px 0 6px 26px',
      padding: '4px 8px',
      border: 'none',
      borderRadius: 6,
      color: 'inherit',
      font: 'inherit',
      fontSize: 12,
      opacity: 0.6,
      cursor: 'pointer',
    }
    const sortSelectStyle = { flex: '0 0 auto', cursor: 'pointer' }
    const actionButtonStyle = {
      flex: '0 0 auto',
      height: 30,
      padding: '0 12px',
      font: 'inherit',
      fontSize: 12,
    }
    const blockedBadgeStyle = {
      flex: '0 0 auto',
      height: 18,
      padding: '0 7px',
      borderRadius: 999,
      border: '1px solid color-mix(in srgb, var(--sl-danger, #f06a6a) 55%, transparent)',
      color: 'var(--sl-danger-text, #f08a8a)',
      fontSize: 11,
      lineHeight: '16px',
      whiteSpace: 'nowrap',
    }
    // Neutral sibling of the blocked badge: the row is importable, it just needs
    // the session un-archived first, so it must not read as an error.
    const adoptBadgeStyle = {
      flex: '0 0 auto',
      height: 18,
      padding: '0 7px',
      borderRadius: 999,
      border: '1px solid color-mix(in srgb, currentColor 30%, transparent)',
      background: 'color-mix(in srgb, currentColor 8%, transparent)',
      fontSize: 11,
      lineHeight: '16px',
      whiteSpace: 'nowrap',
    }
    // Danger confirmations carry their border/fill from the stylesheet's
    // data-tone rules, so hover, active and disabled states stay reachable;
    // the inline style here would pin those colours and lock the button flat.
    const trashMetaStyle = {
      flex: '0 0 auto',
      width: 88,
      textAlign: 'right',
      fontSize: 12,
      color: 'var(--sl-faint)',
      fontVariantNumeric: 'tabular-nums',
    }
    // Deletion timestamps are long enough to wrap inside the fixed meta column,
    // so they get their own single-line slot.
    const trashTimeStyle = {
      flex: '0 0 auto',
      fontSize: 11.5,
      color: 'var(--sl-faint)',
      whiteSpace: 'nowrap',
      fontVariantNumeric: 'tabular-nums',
    }
    const logsRowStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      padding: '9px 12px',
      fontSize: 13,
    }
    const logsTextStyle = {
      flex: '1 1 auto',
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    }
    const progressBlockStyle = { margin: '10px 0 2px' }
    const progressLabelStyle = { fontSize: 12, color: 'var(--sl-muted)', marginBottom: 6 }
    const progressTrackStyle = {
      height: 6,
      borderRadius: 999,
      overflow: 'hidden',
      background: 'color-mix(in srgb, currentColor 12%, transparent)',
    }
    // Fill works on the compositor: the bar is always full width and scaleX
    // carries the percentage, so advancing progress never reflows layout.
    const progressFillStyle = (pct) => ({
      height: '100%',
      width: '100%',
      borderRadius: '999px',
      background: 'var(--sl-accent)',
      transform: `scaleX(${Math.max(0, Math.min(1, pct / 100))})`,
      transformOrigin: '0 50%',
      transition: 'transform 200ms linear',
    })
    const progressCurrentStyle = {
      fontSize: 12,
      color: 'var(--sl-faint)',
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
    // Attachment opt-in row: the checkbox keeps its 15px box, the label carries
    // the count and size so the option is judged before exporting.
    const exportOptionRowStyle = { display: 'flex', alignItems: 'center', gap: 8, marginTop: 14 }
    const exportOptionLabelStyle = { fontSize: 12, color: 'var(--sl-muted)', lineHeight: 1.5 }
    const exportExcludeBlockStyle = { marginTop: 14 }
    const exportExcludeActionsStyle = { display: 'flex', gap: 8, marginTop: 6, marginBottom: 6 }
    // Fixed-height scroll box for the chosen paths: one item or ten, the box keeps
    // the same footprint so the dialog does not jump while paths are picked.
    const exportExcludeListStyle = {
      height: 104,
      overflowY: 'auto',
      padding: '4px 2px',
      borderRadius: 8,
      border: '1px solid var(--sl-line)',
      background: 'color-mix(in srgb, currentColor 2%, Canvas)',
    }
    const exportPathRemoveStyle = {
      flex: '0 0 auto',
      padding: '1px 6px',
      fontSize: 11,
      borderRadius: 4,
    }
    // Exclusion browser (directory list) styles.
    const exportPickerPathStyle = {
      marginBottom: 6,
      fontSize: 12,
      color: 'var(--sl-muted)',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    }
    const exportPickerBarStyle = { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }
    const exportPickerCountStyle = { fontSize: 12, color: 'var(--sl-faint)' }
    // Fixed height: the dialog keeps its size while navigating between a folder
    // with three entries and one with three hundred.
    const exportPickerListStyle = {
      height: 260,
      overflow: 'auto',
      border: '1px solid var(--sl-line)',
      borderRadius: 8,
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
    const exportPickerSizeStyle = { fontSize: 11, color: 'var(--sl-faint)', minWidth: 56, textAlign: 'right' }
    const importListStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
      margin: '8px 0 4px',
      maxHeight: 180,
      overflowY: 'auto',
    }
    // Package buttons carry their chrome from the .sl-filebtn stylesheet rule;
    // selected state is a data attribute so the accent fill can change under
    // hover rather than being pinned by an inline value.
    const importSectionTitleStyle = {
      margin: '14px 0 6px',
      fontSize: 12,
      fontWeight: 600,
      color: 'var(--sl-muted)',
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
      color: 'var(--sl-faint)',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    }
    // Sits under one workspace row in the import preview; .sl-note supplies the
    // tinted box, this only tightens the spacing.
    const importUnmappedNoteStyle = { margin: '0 0 8px', fontSize: 11.5 }
    // Workspace-file conflict policy block: a full-width select plus its hint.
    const importConflictBlockStyle = { marginTop: 14 }
    const importConflictSelectStyle = { width: '100%' }
    const exportInputStyle = {
      width: '100%',
      height: 34,
      marginTop: 6,
      padding: '0 10px',
      cursor: 'text',
      fontSize: 13,
    }
    // Floating dock: one bar, centred over the empty tail the list reserves for
    // it. It is sized by its actions, so it never blocks a row it does not cover.
    const exportDockStyle = {
      position: 'absolute',
      left: '50%',
      bottom: 16,
      transform: 'translateX(-50%)',
      zIndex: 30,
      display: 'flex',
      alignItems: 'center',
      gap: 4,
      padding: 6,
      maxWidth: 'calc(100% - 24px)',
    }
    // Modals keep `transform-origin: center`: they are not anchored to a trigger.
    const overlayStyle = {
      position: 'fixed',
      inset: 0,
      zIndex: 1000,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
    }
    const dialogStyle = {
      width: 'min(560px, 92vw)',
      maxHeight: '80vh',
      overflow: 'auto',
      padding: '20px 22px',
    }
    const dialogTitleStyle = { margin: '0 0 8px', fontSize: 16, fontWeight: 600, letterSpacing: '0.01em' }
    const dialogHintStyle = { margin: '0 0 12px', fontSize: 12, lineHeight: 1.65, color: 'var(--sl-muted)' }
    const dialogTextStyle = { padding: '8px 0', fontSize: 13, color: 'var(--sl-muted)' }
    const dialogListStyle = {
      margin: '4px 0 12px',
      borderTop: '1px solid var(--sl-line)',
    }
    const dialogRowStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '8px 2px',
      borderBottom: '1px solid var(--sl-line)',
      fontSize: 13,
    }
    const dialogActionsStyle = { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }
    const dialogFamilyStyle = {
      border: '1px solid var(--sl-line)',
      borderRadius: 12,
      background: 'var(--sl-surface)',
      padding: '8px 10px',
      marginBottom: 10,
    }
    const dialogFamilyHeadStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '4px 2px',
      fontWeight: 600,
    }
    const forkOptionStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      fontSize: 12,
      color: 'var(--sl-muted)',
      margin: '4px 0 10px',
      cursor: 'pointer',
    }
    const purgeInputStyle = {
      width: '100%',
      height: 34,
      padding: '0 10px',
      cursor: 'text',
      fontSize: 13,
    }
    const placeholderStyle = {
      padding: '56px 20px',
      textAlign: 'center',
      fontSize: 13,
      lineHeight: 1.7,
      color: 'var(--sl-muted)',
    }
    // The remaining inline styles here carry geometry only; colour, hover and
    // motion decisions live in the stylesheet so every state stays reachable.

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
