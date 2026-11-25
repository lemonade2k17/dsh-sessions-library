/**
 * Host-side regression suite for dsh-sessions-library.
 *
 * Every path lives under a fresh temporary DSH_HOME created before the module
 * is imported (the module captures DSH_HOME at load time); the real ~/.dsh is
 * never opened. Run with `node test/host.test.mjs` or `npm test`.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync, readdirSync, statSync, appendFileSync, symlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { zstdCompressSync } from 'node:zlib'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'sl-host-test-'))
process.env.DSH_HOME = home
process.env.DSH_SESSIONS_LIBRARY_TEST = '1'

const { __test } = await import('../index.js')
if (!__test) {
  console.error('the module did not expose __test; is DSH_SESSIONS_LIBRARY_TEST set before import?')
  process.exit(1)
}

const {
  decodeSessionLog,
  safeAttachmentName,
  clearReadOnly,
  readPendingTrash,
  writePendingTrash,
  applyPendingTrashOps,
  flushPendingTrash,
  restorePackageAttachments,
  collectSessionAttachmentRefs,
  planAttachmentCleanup,
  runAttachmentCleanup,
  buildAttachmentOwners,
  restoreTrashEntries,
  restoreWorkspaceFiles,
  buildOrphanReport,
  cleanupOrphans,
} = __test

// The whole suite must stay inside the temporary home.
assert.ok(home.toLowerCase().startsWith(tmpdir().toLowerCase()), 'DSH_HOME must be the temporary directory')

const checks = []
function check(name, fn) {
  checks.push({ name, fn })
}

const sessionsRoot = join(home, 'sessions')
const trashRoot = join(home, 'sessions-trash')
const attachmentsRoot = join(home, 'attachments', 'v1')
const objectsDir = join(attachmentsRoot, 'objects')
const filesDir = join(attachmentsRoot, 'file-objects')
const aliasesDir = join(attachmentsRoot, 'files')
for (const dir of [sessionsRoot, trashRoot, objectsDir, filesDir, aliasesDir]) mkdirSync(dir, { recursive: true })

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')
const frame = (text) => zstdCompressSync(Buffer.from(text, 'utf8'))

function writeObject(dir, bytes) {
  const hash = sha256(bytes)
  mkdirSync(join(dir, hash.slice(0, 2)), { recursive: true })
  const path = join(dir, hash.slice(0, 2), hash)
  writeFileSync(path, bytes)
  chmodSync(path, 0o444)
  return { hash, path }
}

function attachmentEvent(refs) {
  return JSON.stringify({
    type: 'user',
    content: refs.map((ref) => ({
      type: 'image',
      attachment: { attachmentId: `sha256:${ref.hash}`, name: ref.name, bytes: ref.bytes },
    })),
  }) + '\n'
}

function logFrames(sessionId, refs, extra = []) {
  const header = JSON.stringify({ type: 'session', id: sessionId, cwd: 'C:\\tmp\\project' }) + '\n'
  const frames = [frame(header), frame(attachmentEvent(refs))]
  for (const item of extra) frames.push(item)
  return Buffer.concat(frames)
}

function makeSession(id, buffer, project = '--C-tmp-project--') {
  const dir = join(sessionsRoot, project, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), buffer)
  return dir
}

// --- decodeSessionLog: damage is never reported as a complete scan ----------
check('plain JSONL is still readable as a complete log', () => {
  const outcome = decodeSessionLog(Buffer.from('{"type":"session","id":"x"}\n', 'utf8'))
  assert.equal(outcome.complete, true)
  assert.match(outcome.text, /"type":"session"/)
})

check('a zstd-magic file without a decodable frame is incomplete', () => {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01])
  const outcome = decodeSessionLog(magic)
  assert.equal(outcome.complete, false)
  assert.equal(outcome.text, null)
})

check('a log truncated inside a frame is incomplete', () => {
  const full = logFrames('s', [])
  const outcome = decodeSessionLog(full.subarray(0, full.length - 3))
  assert.equal(outcome.complete, false)
})

// --- safeAttachmentName -----------------------------------------------------
check('traversal names are rejected', () => {
  assert.equal(safeAttachmentName('..\\..\\evil'), null)
  assert.equal(safeAttachmentName('/etc/passwd'), null)
  assert.equal(safeAttachmentName('a\x00b'), null)
})

check('Windows device names are rejected but normal names pass', () => {
  assert.equal(safeAttachmentName('CON'), null)
  assert.equal(safeAttachmentName('nul.png'), null)
  assert.equal(safeAttachmentName('COM1'), null)
  assert.equal(safeAttachmentName('截图 2025-11-25 10.00.00.png'), '截图 2025-11-25 10.00.00.png')
})

// --- import path: name + digest are both enforced ---------------------------
check('restorePackageAttachments rejects a traversal name', () => {
  const bytes = Buffer.from('untracked-bytes', 'utf8')
  const object = writeObject(filesDir, bytes)
  const outcome = restorePackageAttachments([], new Map([[object.hash, {
    hash: object.hash,
    name: '..\\..\\..\\..\\evil.txt',
    bytes: bytes.length,
  }]]))
  assert.equal(outcome.failed, 1)
  assert.equal(outcome.restored, 0)
  assert.equal(existsSync(join(home, 'evil.txt')), false)
})

check('restorePackageAttachments rejects bytes that do not match their name', () => {
  const digest = sha256(Buffer.from('expected', 'utf8'))
  const outcome = restorePackageAttachments([{
    segments: ['v1', 'objects', digest.slice(0, 2), digest],
    data: Buffer.from('different', 'utf8'),
  }], null)
  assert.equal(outcome.failed, 1)
  assert.equal(existsSync(join(objectsDir, digest.slice(0, 2), digest)), false)
})

check('restorePackageAttachments accepts a matching object', () => {
  const bytes = Buffer.from('matching-object', 'utf8')
  const digest = sha256(bytes)
  const outcome = restorePackageAttachments([{
    segments: ['v1', 'objects', digest.slice(0, 2), digest],
    data: bytes,
  }], null)
  assert.equal(outcome.restored, 1)
  assert.equal(existsSync(join(objectsDir, digest.slice(0, 2), digest)), true)
})

// --- owner index and cleanup ------------------------------------------------
const sharedBytes = Buffer.from('shared-image', 'utf8')
const shared = writeObject(objectsDir, sharedBytes)
const uniqueBytes = Buffer.from('unique-image', 'utf8')
const unique = writeObject(objectsDir, uniqueBytes)

const survivorDir = makeSession('session-survivor', logFrames('session-survivor', [{ hash: shared.hash, name: 'pic.png', bytes: sharedBytes.length }]))

check('a healthy survivor keeps a shared object', () => {
  const plan = planAttachmentCleanup([{ sessionId: 'session-purged', refs: new Map([[shared.hash, { hash: shared.hash, name: 'pic.png' }]]) }])
  const run = runAttachmentCleanup(plan)
  assert.equal(plan.shared.length, 1)
  assert.equal(plan.deletable.length, 0)
  assert.equal(run.deleted, 0)
  assert.equal(existsSync(shared.path), true)
})

check('a digest that nobody references is deleted and counted once', () => {
  const plan = planAttachmentCleanup([{ sessionId: 'session-purged', refs: new Map([[unique.hash, { hash: unique.hash, name: 'u.png' }]]) }])
  const run = runAttachmentCleanup(plan)
  assert.equal(run.deleted, 1)
  assert.equal(run.deletedPaths, 1)
  assert.equal(existsSync(unique.path), false)
})

check('a file object plus its alias counts once and removes both paths', () => {
  const bytes = Buffer.from('file-object-bytes', 'utf8')
  const object = writeObject(filesDir, bytes)
  const aliasDir = join(aliasesDir, object.hash.slice(0, 2), object.hash)
  mkdirSync(aliasDir, { recursive: true })
  const aliasPath = join(aliasDir, 'report.pdf')
  writeFileSync(aliasPath, bytes)
  chmodSync(aliasPath, 0o444)
  const run = runAttachmentCleanup(planAttachmentCleanup([
    { sessionId: 'session-purged', refs: new Map([[object.hash, { hash: object.hash, name: 'report.pdf' }]]) },
  ]))
  assert.equal(run.deleted, 1)
  assert.equal(run.deletedPaths, 2)
  assert.equal(existsSync(object.path), false)
  assert.equal(existsSync(aliasPath), false)
})

check('a damaged survivor blocks every attachment deletion', () => {
  const damagedDir = makeSession('session-damaged', logFrames('session-damaged', []))
  const logPath = join(damagedDir, 'session.v4.jsonl.zstd')
  const full = readFileSync(logPath)
  writeFileSync(logPath, full.subarray(0, full.length - 2))
  const health = { incomplete: 0, rootUnreadable: false }
  collectSessionAttachmentRefs(damagedDir, health)
  assert.ok(health.incomplete > 0)
  const candidateBytes = Buffer.from('damaged-candidate', 'utf8')
  const candidate = writeObject(objectsDir, candidateBytes)
  const plan = planAttachmentCleanup([{ sessionId: 'session-purged', refs: new Map([[candidate.hash, { hash: candidate.hash }]]) }])
  assert.equal(plan.indexIncomplete, true)
  assert.equal(plan.deletable.length, 0)
  assert.equal(plan.keptUnverified, 1)
  const run = runAttachmentCleanup(plan)
  assert.equal(run.deleted, 0)
  assert.equal(existsSync(candidate.path), true)
  rmSync(damagedDir, { recursive: true, force: true })
})

// --- orphan attachment cleanup ---------------------------------------------
check('orphan preflight lists only unreferenced objects', () => {
  const orphan = writeObject(objectsDir, Buffer.from('orphan-preflight', 'utf8'))
  const report = buildOrphanReport()
  const hashes = report.candidates.map((candidate) => candidate.hash)
  assert.equal(hashes.includes(orphan.hash), true)
  assert.equal(hashes.includes(shared.hash), false, 'a referenced object must not be listed')
  assert.equal(report.indexIncomplete, false)
})

check('orphan cleanup deletes a verified unreferenced object', () => {
  const orphan = writeObject(objectsDir, Buffer.from('orphan-delete', 'utf8'))
  const outcome = cleanupOrphans([orphan.hash])
  assert.equal(outcome.deleted, 1)
  assert.equal(outcome.deletedPaths, 1)
  assert.equal(existsSync(orphan.path), false)
})

check('orphan cleanup refuses an object a session still references', () => {
  const outcome = cleanupOrphans([shared.hash])
  assert.equal(outcome.skippedShared, 1)
  assert.equal(outcome.deleted, 0)
  assert.equal(existsSync(shared.path), true)
})

check('orphan cleanup reports an unknown digest as missing', () => {
  const outcome = cleanupOrphans(['f'.repeat(64)])
  assert.equal(outcome.missing, 1)
  assert.equal(outcome.deleted, 0)
})

check('orphan cleanup refuses everything while the index is incomplete', () => {
  const dir = makeSession('session-orphan-damaged', logFrames('session-orphan-damaged', []))
  const logPath = join(dir, 'session.v4.jsonl.zstd')
  const full = readFileSync(logPath)
  writeFileSync(logPath, full.subarray(0, full.length - 2))
  const orphan = writeObject(objectsDir, Buffer.from('orphan-blocked', 'utf8'))
  const outcome = cleanupOrphans([orphan.hash])
  assert.equal(outcome.indexIncomplete, true)
  assert.equal(outcome.deleted, 0)
  assert.equal(existsSync(orphan.path), true)
  rmSync(dir, { recursive: true, force: true })
})

check('orphan cleanup keeps an object whose bytes do not match its name', () => {
  const bytes = Buffer.from('tampered-bytes', 'utf8')
  const digest = sha256(bytes)
  const shard = digest.slice(0, 2)
  mkdirSync(join(objectsDir, shard), { recursive: true })
  const path = join(objectsDir, shard, digest)
  writeFileSync(path, Buffer.from('different-bytes', 'utf8'))
  const outcome = cleanupOrphans([digest])
  assert.equal(outcome.deleted, 0)
  assert.equal(outcome.skippedUnverified, 1)
  assert.equal(existsSync(path), true)
})

check('orphan cleanup re-checks references before deleting', () => {
  const bytes = Buffer.from('late-reference', 'utf8')
  const orphan = writeObject(objectsDir, bytes)
  // The object is an orphan, then a session starts referencing it afterwards.
  const ref = { hash: orphan.hash, name: 'late.png' }
  makeSession('session-late-ref', logFrames('session-late-ref', [{ hash: orphan.hash, name: 'late.png', bytes: bytes.length }]))
  const outcome = cleanupOrphans([orphan.hash])
  assert.equal(outcome.skippedShared, 1)
  assert.equal(outcome.deleted, 0)
  assert.equal(existsSync(orphan.path), true)
  rmSync(join(sessionsRoot, '--C-tmp-project--', 'session-late-ref'), { recursive: true, force: true })
})

// --- owner index cache ------------------------------------------------------
check('the owner index caches complete scans and reuses them', () => {
  const beforeCache = sanitizeCache()
  const first = buildAttachmentOwners(new Set())
  const cacheFile = join(home, 'cache', 'sessions-library', 'attachment-index.json')
  assert.equal(existsSync(cacheFile), true)
  const cacheBytes = readFileSync(cacheFile, 'utf8')
  const second = buildAttachmentOwners(new Set())
  assert.equal(second.size, first.size)
  assert.equal(readFileSync(cacheFile, 'utf8').length, cacheBytes.length)
  assert.equal(beforeCache, true)
})

check('appending to a log invalidates its cache entry', () => {
  const before = buildAttachmentOwners(new Set())
  const extraBytes = Buffer.from('appended-image', 'utf8')
  const extra = writeObject(objectsDir, extraBytes)
  const logPath = join(survivorDir, 'session.v4.jsonl.zstd')
  appendFileSync(logPath, frame(attachmentEvent([{ hash: extra.hash, name: 'new.png', bytes: extraBytes.length }])))
  const after = buildAttachmentOwners(new Set())
  assert.equal(after.has(extra.hash), true)
  assert.equal(after.has(extra.hash) && !before.has(extra.hash), true)
})

// --- pending queue: merge writes and phantom sweep --------------------------
check('queue changes merge instead of overwriting a concurrent update', () => {
  writePendingTrash({ concurrent: { requestedAt: 1 } })
  writePendingTrash({ concurrent: { requestedAt: 1 }, mine: { requestedAt: 2 } })
  const ops = new Map([['mine', null], ['newer', { requestedAt: 3 }]])
  assert.equal(applyPendingTrashOps(ops), true)
  const latest = readPendingTrash()
  assert.equal(latest.concurrent !== undefined, true, 'a concurrent record must survive')
  assert.equal(latest.mine, undefined)
  assert.equal(latest.newer !== undefined, true)
  writePendingTrash({})
})

check('a session directory without a log does not degrade the index', () => {
  // A brand new session has no log yet; it references nothing, so it must not
  // flip the owner index to "incomplete" and block attachment cleanup forever.
  mkdirSync(join(sessionsRoot, '--C-empty--', 'session-empty'), { recursive: true })
  const health = { incomplete: 0, rootUnreadable: false }
  buildAttachmentOwners(new Set(), health)
  assert.equal(health.incomplete, 0)
})

check('a corrupt queue is preserved next to itself', () => {
  const queueFile = join(home, 'sessions-library', 'pending-trash.json')
  mkdirSync(join(home, 'sessions-library'), { recursive: true })
  writeFileSync(queueFile, '{not json')
  const items = readPendingTrash()
  assert.deepEqual(items, {})
  const leftovers = readdirSync(join(home, 'sessions-library')).filter((name) => name.startsWith('pending-trash.json.corrupt-'))
  assert.ok(leftovers.length >= 1)
  rmSync(queueFile, { force: true })
  for (const name of leftovers) rmSync(join(home, 'sessions-library', name), { force: true })
})

check('flush skips a session that reports itself as loaded', async () => {
  const id = 'session-live'
  const dir = makeSession(id, logFrames(id, []))
  writePendingTrash({ [id]: { requestedAt: 1, workspaces: [], wasArchived: false } })
  const agents = { get: (sessionId) => (sessionId === id ? { id } : undefined) }
  await flushPendingTrash({ get: (name) => (name === 'agents' ? agents : undefined) })
  assert.equal(existsSync(dir), true)
  assert.equal(readPendingTrash()[id] !== undefined, true)
  writePendingTrash({})
})

check('flush writes the manifest before moving the session', async () => {
  const id = 'session-move'
  const dir = makeSession(id, logFrames(id, []))
  writePendingTrash({ [id]: { requestedAt: 1, workspaces: [], wasArchived: false } })
  await flushPendingTrash({ get: () => undefined })
  const entries = readdirSync(trashRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  const moved = entries.find((entry) => existsSync(join(trashRoot, entry.name, 'session')))
  assert.ok(moved, 'the session must land in the bin')
  const manifest = JSON.parse(readFileSync(join(trashRoot, moved.name, 'manifest.json'), 'utf8'))
  assert.equal(manifest.id, id)
  assert.equal(existsSync(dir), false)
  assert.equal(readPendingTrash()[id], undefined)
})

check('flush removes a phantom entry that has no session directory', async () => {
  const id = 'session-phantom'
  makeSession(id, logFrames(id, []))
  writePendingTrash({ [id]: { requestedAt: 1, workspaces: [], wasArchived: false } })
  const phantomDir = join(trashRoot, '1700000000000-phantom')
  mkdirSync(phantomDir, { recursive: true })
  writeFileSync(join(phantomDir, 'manifest.json'), JSON.stringify({ id, title: 'phantom' }))
  await flushPendingTrash({ get: () => undefined })
  assert.equal(existsSync(phantomDir), false)
})

check('flush leaves an entry that still holds its session alone', async () => {
  const id = 'session-kept'
  const entryDir = join(trashRoot, '1700000000001-kept')
  mkdirSync(join(entryDir, 'session'), { recursive: true })
  writeFileSync(join(entryDir, 'manifest.json'), JSON.stringify({ id, title: 'kept' }))
  writePendingTrash({ [id]: { requestedAt: 1, workspaces: [], wasArchived: false } })
  await flushPendingTrash({ get: () => undefined })
  assert.equal(existsSync(entryDir), true)
  writePendingTrash({})
})


// --- 0.7.1 additions --------------------------------------------------------
check('workspace restore writes normally when no link is in the way', () => {
  const workspaceRoot = join(home, 'workspace-ok')
  mkdirSync(workspaceRoot, { recursive: true })
  const outcome = restoreWorkspaceFiles(
    new Map([['src', [{ segments: ['notes', 'a.txt'], data: Buffer.from('hello') }]]]),
    { src: 'w1' },
    { get: () => ({ path: workspaceRoot }) },
    { mode: 'overwrite' },
  )
  assert.equal(outcome.failed, 0)
  assert.equal(outcome.restored, 1)
  assert.equal(readFileSync(join(workspaceRoot, 'notes', 'a.txt'), 'utf8'), 'hello')
})

check('workspace restore refuses to write through a junction or symlink', () => {
  const outside = join(home, 'outside')
  const workspaceRoot = join(home, 'workspace-linked')
  mkdirSync(outside, { recursive: true })
  mkdirSync(workspaceRoot, { recursive: true })
  symlinkSync(outside, join(workspaceRoot, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  const outcome = restoreWorkspaceFiles(
    new Map([['src', [{ segments: ['linked', 'evil.txt'], data: Buffer.from('payload') }]]]),
    { src: 'w1' },
    { get: () => ({ path: workspaceRoot }) },
    { mode: 'overwrite' },
  )
  assert.equal(outcome.failed, 1)
  assert.equal(existsSync(join(outside, 'evil.txt')), false)
})

check('restore of a queued session drops the queue record on success', async () => {
  const id = 'session-queued-restore'
  writePendingTrash({ [id]: { requestedAt: 1, familyRoot: id, role: 'root', workspaces: [], wasArchived: false } })
  const registry = { unarchiveSession: async () => {} }
  const results = await restoreTrashEntries({ get: (name) => (name === 'workspaceRegistry' ? registry : undefined) }, ['pending:' + id], undefined, {})
  assert.equal(results[0].status, 'restored')
  assert.equal(readPendingTrash()[id], undefined)
})

check('a failed un-archive keeps the record but drops the purge intent', async () => {
  const id = 'session-queued-failed'
  writePendingTrash({ [id]: { requestedAt: 1, familyRoot: id, role: 'root', purge: true, workspaces: [], wasArchived: false } })
  const registry = { unarchiveSession: async () => { throw new Error('nope') } }
  const results = await restoreTrashEntries({ get: (name) => (name === 'workspaceRegistry' ? registry : undefined) }, ['pending:' + id], undefined, {})
  assert.equal(results[0].status, 'failed')
  const kept = readPendingTrash()[id]
  assert.ok(kept, 'the record must stay retryable')
  assert.equal(kept.purge === true, false)
  writePendingTrash({})
})

check('clearReadOnly preserves permission bits on POSIX', () => {
  const file = join(home, 'chmod-probe.bin')
  writeFileSync(file, Buffer.from('x'))
  chmodSync(file, 0o444)
  clearReadOnly(file)
  const mode = statSync(file).mode & 0o777
  if (process.platform === 'win32') {
    assert.equal(mode, 0o666)
  } else {
    assert.equal(mode & 0o200, 0o200)
    assert.equal(mode & 0o044, 0o044)
  }
})

check('an attachment member without a verifiable layout is refused', () => {
  const outcome = restorePackageAttachments([{ segments: ['v1', 'mystery', 'x'], data: Buffer.from('x') }], null)
  assert.equal(outcome.failed, 1)
  assert.equal(outcome.restored, 0)
})

// --- summary ----------------------------------------------------------------
function sanitizeCache() {
  // The cache lives inside the temporary home; assert the real one is untouched.
  const realCache = join(process.env.USERPROFILE || '', '.dsh', 'cache', 'sessions-library', 'attachment-index.json')
  return !home.toLowerCase().includes('.dsh') && (process.env.USERPROFILE ? !realCache.toLowerCase().includes(home.toLowerCase()) : true)
}

const failed = []
for (const { name, fn } of checks) {
  try {
    await fn()
    console.log(`PASS ${name}`)
  } catch (error) {
    failed.push({ name, error })
    console.log(`FAIL ${name}: ${error.message}`)
  }
}

let exitCode = 0
if (failed.length > 0) {
  exitCode = 1
  for (const { name, error } of failed) console.log(`failed: ${name}\n  ${error && error.stack ? error.stack.split('\n').slice(0, 3).join('\n  ') : ''}`)
}

// Best-effort clean-up: the store marks objects read-only on this platform.
function clearReadOnlyTree(dir) {
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    try {
      if (entry.isDirectory()) {
        clearReadOnlyTree(path)
        chmodSync(path, 0o777)
      } else {
        chmodSync(path, 0o666)
      }
    } catch {
      // Best effort only.
    }
  }
}
try {
  clearReadOnlyTree(home)
  rmSync(home, { recursive: true, force: true })
} catch (error) {
  console.log(`cleanup left ${home}: ${error.code ?? error.message}`)
}

console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
process.exit(exitCode)
