/** 两个本机引擎的 profile 级位置与搬迁边界；旧目录在验证和偏好切换前始终保持可用。 */
import type { ZoteroLike } from './runtime'
import { uiText } from './ui-preferences'

export type EngineStorageKind = 'pdf' | 'ocr'
export type StorageProgress = (phase: 'preflight' | 'copy' | 'verify' | 'check' | 'commit' | 'cleanup', done?: number, total?: number) => void
type StoragePreference = { version: 1; parent: string; marker: string }
type Journal = { version: 1; phase: 'copy' | 'commit'; from: string; fromParent: string; to: string; stage: string; parent: string; marker: string; sourceExists: boolean }
type StorageIO = {
  exists(path: string): Promise<boolean>
  makeDirectory(path: string, options: { ignoreExisting: boolean }): Promise<unknown>
  getChildren(path: string): Promise<string[]>
  stat(path: string): Promise<{ type: string; size: number }>
  copy(from: string, to: string, options?: { noOverwrite: boolean }): Promise<unknown>
  move(from: string, to: string, options?: { noOverwrite: boolean }): Promise<unknown>
  remove(path: string, options?: { recursive?: boolean; ignoreAbsent?: boolean }): Promise<unknown>
  read(path: string, options?: { offset: number; maxBytes: number }): Promise<Uint8Array>
  readUTF8(path: string): Promise<string>
  writeUTF8(path: string, value: string, options?: { tmpPath: string }): Promise<unknown>
}
type StoragePlatform = { IOUtils: StorageIO; PathUtils: { profileDir: string; join(...parts: string[]): string; normalize(path: string): string; parent(path: string): string; filename(path: string): string } }
type StorageHost = ZoteroLike & { __jadenseStorageMoving?: Set<EngineStorageKind>; __jadenseStorageUnsettled?: Set<EngineStorageKind> }
const platform = () => globalThis as unknown as StoragePlatform
const prefKey = (kind: EngineStorageKind) => `extensions.jadenseInZotero.${kind === 'pdf' ? 'pdfEngineStorage' : 'ocrEngineStorage'}`
export const engineStoragePrefKey = prefKey
const leaf = (kind: EngineStorageKind) => kind === 'pdf' ? 'jadense-pdf-translation' : 'jadense-ocr'
const markerName = '.jadense-storage-id'
const migrationMarkerName = '.jadense-migration-id'
const sourceMarkerName = '.jadense-migration-source-id'
const profileRoot = (kind: EngineStorageKind) => {
  const paths = platform().PathUtils
  return paths.join(paths.profileDir, leaf(kind), ...(kind === 'ocr' ? ['v1'] : []))
}
const childRoot = (parent: string, kind: EngineStorageKind) => platform().PathUtils.join(parent, leaf(kind), ...(kind === 'ocr' ? ['v1'] : []))
const journalPath = (kind: EngineStorageKind) => platform().PathUtils.join(platform().PathUtils.profileDir, `jadense-${kind}-storage-migration.json`)

function saved(host: ZoteroLike, kind: EngineStorageKind): StoragePreference | undefined {
  const raw = host.Prefs?.get(prefKey(kind), true)
  if (!raw) return
  try {
    const value = JSON.parse(String(raw)) as StoragePreference
    if (value?.version === 1 && typeof value.parent === 'string' && typeof value.marker === 'string' && value.marker) return value
  } catch { /* 不把损坏的配置静默解释成 profile 目录。 */ }
  throw new Error(uiText('引擎存储配置无法读取，请修复配置后重试，原目录不会自动变更。', 'Engine storage settings are invalid. Repair them before retrying; the original location will not change automatically.'))
}

export function engineStorageParent(host: ZoteroLike, kind: EngineStorageKind) { return saved(host, kind)?.parent ?? platform().PathUtils.profileDir }
export function engineStorageRoot(host: ZoteroLike, kind: EngineStorageKind) {
  const value = saved(host, kind)
  return value ? childRoot(value.parent, kind) : profileRoot(kind)
}
export function previewEngineStorageRoot(host: ZoteroLike, kind: EngineStorageKind, input: string) {
  return childRoot(input.trim() ? canonical(input) : platform().PathUtils.profileDir, kind)
}
export function storageIsMoving(host: ZoteroLike, kind: EngineStorageKind) { return (host as StorageHost).__jadenseStorageMoving?.has(kind) === true }
export function assertStorageIdle(host: ZoteroLike, kind: EngineStorageKind) {
  if (storageIsMoving(host, kind)) throw new Error(uiText('正在迁移引擎存储位置，请完成后重试。', 'Engine storage is moving. Retry when it finishes.'))
  if ((host as StorageHost).__jadenseStorageUnsettled?.has(kind)) throw new Error(uiText('磁盘操作仍未结束，请等待或重启 Zotero 后重试。', 'A disk operation has not finished. Wait or restart Zotero before retrying.'))
}
export async function ensureEngineStorageAvailable(host: ZoteroLike, kind: EngineStorageKind) {
  assertStorageIdle(host, kind)
  const value = saved(host, kind)
  if (!value) return engineStorageRoot(host, kind)
  const root = engineStorageRoot(host, kind), file = platform().PathUtils.join(root, markerName)
  try { if (await platform().IOUtils.readUTF8(file) === value.marker) return root } catch { /* 离线磁盘或标记缺失。 */ }
  throw new Error(uiText(`存储位置不可用：${root}。请重新连接磁盘后重试。`, `Storage location unavailable: ${root}. Reconnect the drive and retry.`))
}

function canonical(path: string) {
  const paths = platform().PathUtils, value = path.trim().replace(/^"(.*)"$/u, '$1')
  if (!/^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+|\/)/iu.test(value)) throw new Error(uiText('请输入绝对文件夹路径。', 'Enter an absolute folder path.'))
  return paths.normalize(value)
}
function comparable(path: string) {
  const normalized = path.replace(/[\\/]+$/u, '').replace(/\\/gu, '/')
  return /^[a-z]:\//iu.test(normalized) || normalized.startsWith('//') ? normalized.toLowerCase() : normalized
}
function overlaps(first: string, second: string) {
  const a = comparable(first), b = comparable(second)
  return a === b || a.startsWith(b + '/') || b.startsWith(a + '/')
}
function cancelled(signal?: AbortSignal) { if (signal?.aborted) throw Object.assign(new Error(uiText('已取消位置迁移。', 'Storage move cancelled.')), { name: 'AbortError' }) }
async function journal(kind: EngineStorageKind, value: Journal | null) {
  const io = platform().IOUtils, path = journalPath(kind)
  if (value) await io.writeUTF8(path, JSON.stringify(value), { tmpPath: path + '.tmp' })
  else await io.remove(path, { ignoreAbsent: true })
}
export async function storageRecovery(kind: EngineStorageKind): Promise<Journal | undefined> {
  if (!await platform().IOUtils.exists(journalPath(kind))) return
  try {
    const value = JSON.parse(await platform().IOUtils.readUTF8(journalPath(kind))) as Journal
    if (value.version === 1 && (value.phase === 'copy' || value.phase === 'commit') && typeof value.marker === 'string' && /^[0-9a-f-]{36}$/iu.test(value.marker)
      && typeof value.sourceExists === 'boolean' && typeof value.parent === 'string' && typeof value.fromParent === 'string'
      && value.from === childRoot(value.fromParent, kind) && value.to === childRoot(value.parent, kind)
      && value.stage === platform().PathUtils.join(value.parent, `.jadense-${kind}-move-${value.marker}`) && !overlaps(value.from, value.to)) return value
  } catch { /* 损坏或不可信的记录不能自动覆盖。 */ }
  throw new Error(uiText('迁移记录损坏，请先检查配置目录中的迁移记录。', 'Storage migration record is invalid. Inspect the migration record in the profile folder.'))
}

type Entry = { relative: string; type: 'directory' | 'regular' | 'rebuildable-link'; size: number }
/** uv 与 Python 环境中的链接由目标目录的锁定依赖修复重新生成；成果中的链接不自动丢弃。 */
function rebuildableLink(path: string, relative: string) {
  const parts = relative.split('/')
  if (!(parts[0] === '.venv' || parts[0] === 'python' || parts[0] === 'uv-cache' || (parts[0] === 'runtime' && parts[1] === 'python'))) return false
  const globals = globalThis as unknown as { Cc?: Record<string, { createInstance(interfaceType: unknown): { initWithPath(value: string): void; isSymlink(): boolean } }>; Ci?: { nsIFile: unknown } }
  const factory = globals.Cc?.['@mozilla.org/file/local;1']
  if (!factory || !globals.Ci) return false
  const file = factory.createInstance(globals.Ci.nsIFile)
  file.initWithPath(path)
  return file.isSymlink()
}
async function inventory(root: string, signal?: AbortSignal): Promise<Entry[]> {
  const { IOUtils: io, PathUtils: paths } = platform(), entries: Entry[] = []
  const walk = async (directory: string, prefix: string) => {
    for (const child of await io.getChildren(directory)) {
      cancelled(signal)
      if (paths.filename(child) === migrationMarkerName || paths.filename(child) === sourceMarkerName) continue
      const relative = prefix ? `${prefix}/${paths.filename(child)}` : paths.filename(child)
      if (rebuildableLink(child, relative)) { entries.push({ relative, type: 'rebuildable-link', size: 0 }); continue }
      const info = await io.stat(child)
      if (info.type !== 'directory' && info.type !== 'regular') throw new Error(uiText(`包含无法安全迁移的特殊文件：${child}`, `Cannot safely move a special file: ${child}`))
      entries.push({ relative, type: info.type, size: info.type === 'regular' ? info.size : 0 })
      if (info.type === 'directory') await walk(child, relative)
    }
  }
  await walk(root, '')
  return entries.sort((a, b) => a.relative.localeCompare(b.relative))
}
function entryPath(root: string, relative: string) { return platform().PathUtils.join(root, ...relative.split('/')) }
async function equalFile(a: string, b: string, size: number, signal?: AbortSignal) {
  const io = platform().IOUtils
  for (let offset = 0; offset < size; offset += 1024 * 1024) {
    cancelled(signal)
    const maxBytes = Math.min(1024 * 1024, size - offset)
    const [left, right] = await Promise.all([io.read(a, { offset, maxBytes }), io.read(b, { offset, maxBytes })])
    if (left.length !== maxBytes || right.length !== maxBytes || left.some((value, index) => value !== right[index])) return false
  }
  return true
}
async function verifyCopy(source: string, target: string, baseline: Entry[], signal?: AbortSignal, progress?: StorageProgress) {
  const io = platform().IOUtils, actual = await inventory(source, signal)
  if (JSON.stringify(actual) !== JSON.stringify(baseline)) throw new Error(uiText('迁移期间原目录发生变化，已保留原目录。', 'The source changed during the move. Its files were retained.'))
  const total = baseline.filter(entry => entry.type === 'regular').reduce((sum, entry) => sum + entry.size, 0)
  let done = 0
  for (const entry of baseline) {
    cancelled(signal)
    if (entry.type === 'rebuildable-link') continue
    const destination = entryPath(target, entry.relative), info = await io.stat(destination)
    if (info.type !== entry.type || (entry.type === 'regular' && (info.size !== entry.size || !await equalFile(entryPath(source, entry.relative), destination, entry.size, signal)))) {
      throw new Error(uiText(`迁移校验失败：${entry.relative}`, `Storage verification failed: ${entry.relative}`))
    }
    if (entry.type === 'regular') { done += entry.size; progress?.('verify', done, total) }
  }
}

export type ChangeStorageOptions = {
  signal?: AbortSignal
  progress?: StorageProgress
  busy?: () => string | undefined
  stopIdle?: () => Promise<void>
  validate?: (root: string, signal: AbortSignal) => Promise<void>
  committed?: (root: string) => Promise<void> | void
}
export type ChangeStorageResult = { root: string; moved: boolean; oldRoot?: string; cleanupError?: string }

/** 每个阶段保持旧偏好到目标通过校验；仅删除本次记录的受管树。 */
export async function changeEngineStorage(host: ZoteroLike, kind: EngineStorageKind, input: string, options: ChangeStorageOptions = {}): Promise<ChangeStorageResult> {
  if (!host.Prefs) throw new Error(uiText('无法保存引擎存储位置。', 'Cannot save engine storage location.'))
  const moving = (host as StorageHost).__jadenseStorageMoving ??= new Set<EngineStorageKind>()
  if (moving.has(kind)) throw new Error(uiText('此引擎已有迁移正在进行。', 'A storage move is already running for this engine.'))
  const unsettled = (host as StorageHost).__jadenseStorageUnsettled ??= new Set<EngineStorageKind>()
  if (unsettled.has(kind)) throw new Error(uiText('上一轮磁盘操作仍未结束，请重启 Zotero 后清理暂存文件。', 'A previous disk operation has not finished. Restart Zotero, then clean up the staged files.'))
  const occupied = options.busy?.()
  if (occupied) throw new Error(occupied)
  const { IOUtils: io, PathUtils: paths } = platform(), parent = input.trim() ? canonical(input) : paths.profileDir
  const from = engineStorageRoot(host, kind), to = childRoot(parent, kind)
  if (comparable(from) === comparable(to)) return { root: from, moved: false }
  if (overlaps(from, to) || overlaps(to, engineStorageRoot(host, kind === 'pdf' ? 'ocr' : 'pdf'))) throw new Error(uiText('目标目录与现有引擎目录重叠，请选择其他文件夹。', 'Destination overlaps an engine directory. Choose another folder.'))
  const controller = new AbortController(), externalAbort = () => controller.abort()
  options.signal?.addEventListener('abort', externalAbort, { once: true })
  if (options.signal?.aborted) controller.abort()
  const signal = controller.signal, progress = options.progress
  /** IOUtils 无法中途取消单个 OS 调用；超时后不再提交或清理，待调用结束或重启后再处理暂存目录。 */
  const bounded = async <T>(work: Promise<T>, milliseconds = 5 * 60000): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined, settled = false
    void work.finally(() => { settled = true; unsettled.delete(kind) }).catch(() => {})
    const interruption = new Promise<never>((_, reject) => {
      const stop = () => {
        if (settled) return
        unsettled.add(kind)
        reject(Object.assign(new Error(uiText('磁盘操作已停止等待；请检查磁盘连接及当前目录，必要时重启 Zotero 后清理遗留文件。', 'Disk operation timed out or was cancelled. Check the drive and current location, then restart Zotero if cleanup remains pending.')), { name: signal.aborted ? 'AbortError' : 'TimeoutError' }))
      }
      signal.addEventListener('abort', stop, { once: true })
      timer = setTimeout(() => { stop(); controller.abort() }, milliseconds)
      work.finally(() => signal.removeEventListener('abort', stop)).catch(() => {})
      if (signal.aborted) stop()
    })
    try { return await Promise.race([work, interruption]) } finally { clearTimeout(timer) }
  }
  moving.add(kind)
  let committed = false, prepared = false, sourceExists = false, stage = ''
  const marker = crypto.randomUUID()
  try {
    progress?.('preflight'); cancelled(signal)
    const pending = await bounded(storageRecovery(kind), 30000)
    if (pending) throw new Error(uiText('上次迁移仍有待处理文件，请先点击“重试清理旧目录”。', 'A previous move still has pending files. Choose Retry cleanup first.'))
    const sourcePreference = saved(host, kind)
    if (sourcePreference) {
      let actual = ''
      try { actual = await bounded(io.readUTF8(paths.join(from, markerName)), 30000) } catch { /* 外置目录不可用。 */ }
      if (actual !== sourcePreference.marker) throw new Error(uiText(`当前存储位置不可用：${from}`, `Current storage location is unavailable: ${from}`))
    }
    if (options.stopIdle) await bounded(options.stopIdle(), 35000)
    cancelled(signal)
    await bounded(io.makeDirectory(parent, { ignoreExisting: true }), 30000)
    await bounded(io.makeDirectory(paths.parent(to), { ignoreExisting: true }), 30000)
    if (await bounded(io.exists(to), 30000)) {
      if ((await bounded(io.getChildren(to), 30000)).length) throw new Error(uiText(`目标目录已有文件：${to}。请选择空位置，避免覆盖。`, `Destination already contains files: ${to}. Choose an empty location to avoid overwriting.`))
      await bounded(io.remove(to, { recursive: true }), 30000)
    }
    sourceExists = await bounded(io.exists(from), 30000)
    stage = paths.join(parent, `.jadense-${kind}-move-${marker}`)
    if (await bounded(io.exists(stage), 30000)) throw new Error(uiText('迁移暂存目录已存在，请重试。', 'Storage staging directory already exists. Retry.'))
    const record = { version: 1, phase: 'copy', from, fromParent: engineStorageParent(host, kind), to, stage, parent, marker, sourceExists } as const
    if (sourceExists) await bounded(io.writeUTF8(paths.join(from, sourceMarkerName), marker), 30000)
    await bounded(journal(kind, record), 30000); prepared = true
    if (sourceExists) {
      const baseline = await bounded(inventory(from, signal))
      const total = baseline.filter(entry => entry.type === 'regular').reduce((sum, entry) => sum + entry.size, 0)
      await bounded(io.makeDirectory(stage, { ignoreExisting: false }))
      await bounded(io.writeUTF8(paths.join(stage, migrationMarkerName), marker))
      let done = 0
      for (const entry of baseline) {
        cancelled(signal)
        const destination = entryPath(stage, entry.relative)
        if (entry.type === 'directory') await bounded(io.makeDirectory(destination, { ignoreExisting: false }))
        else if (entry.type === 'regular') { await bounded(io.copy(entryPath(from, entry.relative), destination, { noOverwrite: true })); done += entry.size; progress?.('copy', done, total) }
      }
      await bounded(verifyCopy(from, stage, baseline, signal, progress))
      cancelled(signal)
      await bounded(io.move(stage, to, { noOverwrite: true }))
      cancelled(signal)
      if (options.validate) { progress?.('check'); await bounded(options.validate(to, signal), 35 * 60000) }
    } else {
      await bounded(io.makeDirectory(to, { ignoreExisting: false }))
      await bounded(io.writeUTF8(paths.join(to, migrationMarkerName), marker))
    }
    cancelled(signal)
    await bounded(io.writeUTF8(paths.join(to, markerName), marker))
    progress?.('commit')
    if (comparable(parent) === comparable(paths.profileDir)) host.Prefs?.clear(prefKey(kind), true)
    else host.Prefs?.set(prefKey(kind), JSON.stringify({ version: 1, parent, marker } satisfies StoragePreference), true)
    committed = true
    try {
      await options.committed?.(to)
      await bounded(journal(kind, { ...record, phase: 'commit' }), 30000)
      progress?.('cleanup')
      if (sourceExists) {
        if (await bounded(io.readUTF8(paths.join(from, sourceMarkerName)), 30000) !== marker) throw new Error(uiText('旧目录标记已变化，未自动删除。', 'Old folder marker changed; it was not removed.'))
        await bounded(io.remove(from, { recursive: true }), 15 * 60000)
      }
      await bounded(journal(kind, null), 30000)
    } catch (error) { return { root: to, moved: true, oldRoot: from, cleanupError: error instanceof Error ? error.message : String(error) } }
    return { root: to, moved: true }
  } catch (error) {
    if (!committed && prepared && !unsettled.has(kind) && !signal.aborted) {
      for (const target of [stage, to]) {
        if (!target) continue
        try { if (await io.readUTF8(paths.join(target, migrationMarkerName)) === marker) await io.remove(target, { recursive: true, ignoreAbsent: true }) } catch { /* 归属不明的目录保留。 */ }
      }
      if (sourceExists) {
        try { if (await io.readUTF8(paths.join(from, sourceMarkerName)) === marker) await io.remove(paths.join(from, sourceMarkerName), { ignoreAbsent: true }) } catch { /* 不删除被替换的标记。 */ }
      }
      await journal(kind, null).catch(() => {})
    }
    throw error
  } finally { moving.delete(kind); options.signal?.removeEventListener('abort', externalAbort) }
}

/** 仅重试清理已提交迁移记录的旧受管目录。 */
export async function retryEngineStorageCleanup(host: ZoteroLike, kind: EngineStorageKind, busy?: () => string | undefined) {
  assertStorageIdle(host, kind)
  const occupied = busy?.()
  if (occupied) throw new Error(occupied)
  const shared = host as StorageHost, moving = shared.__jadenseStorageMoving ??= new Set<EngineStorageKind>()
  const unsettled = shared.__jadenseStorageUnsettled ??= new Set<EngineStorageKind>()
  moving.add(kind)
  const bounded = async <T>(operation: Promise<T>, milliseconds = 30000): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined, timedOut = false
    void operation.finally(() => { if (timedOut) unsettled.delete(kind) }).catch(() => {})
    try {
      return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => {
        timedOut = true; unsettled.add(kind)
        reject(new Error(uiText('清理磁盘操作超时，请检查磁盘连接后重试。', 'Disk cleanup timed out. Check the drive and retry.')))
      }, milliseconds) })])
    } finally { clearTimeout(timer) }
  }
  try {
    const value = await bounded(storageRecovery(kind))
    if (!value) return false
    if (value.phase === 'commit' || comparable(engineStorageRoot(host, kind)) === comparable(value.to)) {
      if (comparable(engineStorageRoot(host, kind)) !== comparable(value.to)) throw new Error(uiText('旧目录清理记录与当前配置不符，未删除文件。', 'Cleanup record does not match current settings; no files were removed.'))
      if (await bounded(platform().IOUtils.readUTF8(platform().PathUtils.join(value.to, markerName))) !== value.marker) throw new Error(uiText('新目录标记已变化，未删除旧文件。', 'New folder marker changed; old files were not removed.'))
      if (value.sourceExists && await bounded(platform().IOUtils.exists(value.from))) {
        if (await bounded(platform().IOUtils.readUTF8(platform().PathUtils.join(value.from, sourceMarkerName))) !== value.marker) throw new Error(uiText('旧目录标记已变化，未删除文件。', 'Old folder marker changed; no files were removed.'))
        await bounded(platform().IOUtils.remove(value.from, { recursive: true, ignoreAbsent: true }), 2 * 60000)
      }
    } else {
      if (comparable(engineStorageRoot(host, kind)) !== comparable(value.from)) throw new Error(uiText('迁移记录与当前配置不符，未删除文件。', 'Move record does not match current settings; no files were removed.'))
      for (const target of [value.stage, value.to]) {
        if (!await bounded(platform().IOUtils.exists(target))) continue
        let marker = ''
        try { marker = await bounded(platform().IOUtils.readUTF8(platform().PathUtils.join(target, migrationMarkerName))) } catch { /* 非本次创建的目录不能清理。 */ }
        if (marker !== value.marker) throw new Error(uiText(`暂存目录内容无法确认：${target}。未删除文件。`, `Cannot verify staged folder ownership: ${target}. No files were removed.`))
        await bounded(platform().IOUtils.remove(target, { recursive: true, ignoreAbsent: true }), 2 * 60000)
      }
      if (value.sourceExists && await bounded(platform().IOUtils.exists(value.from)) && await bounded(platform().IOUtils.readUTF8(platform().PathUtils.join(value.from, sourceMarkerName))) === value.marker) await bounded(platform().IOUtils.remove(platform().PathUtils.join(value.from, sourceMarkerName), { ignoreAbsent: true }))
    }
    await bounded(journal(kind, null))
    return true
  } finally { moving.delete(kind) }
}

/** 旧版 Windows 两套安装器共用此可重建缓存；只在两个引擎均空闲时短暂封锁新任务后清理。 */
export async function cleanupLegacyUVCache(host: ZoteroLike, idle: () => boolean) {
  const shared = host as StorageHost, moving = shared.__jadenseStorageMoving ??= new Set<EngineStorageKind>()
  if (moving.size || !idle()) return false
  const processPlatform = globalThis as unknown as { ChromeUtils?: { importESModule(url: string): { Subprocess: { getEnvironment(): Record<string, string> } } } }
  const environment = processPlatform.ChromeUtils?.importESModule('resource://gre/modules/Subprocess.sys.mjs').Subprocess.getEnvironment()
  const local = environment?.LOCALAPPDATA
  if (!local) return false
  const io = platform().IOUtils, paths = platform().PathUtils
  const installed = await Promise.all((['pdf', 'ocr'] as const).map(async kind => {
    const root = engineStorageRoot(host, kind)
    return await io.exists(paths.join(root, '.venv')) || await io.exists(paths.join(root, 'runtime', 'python'))
  }))
  if (!installed.some(Boolean)) return false
  const cache = platform().PathUtils.join(local, 'Jadense', 'uv')
  if (!await io.exists(cache)) return false
  if (moving.size || !idle()) return false
  moving.add('pdf'); moving.add('ocr')
  let settled = false, operationStarted = false
  try {
    if (!idle()) return false
    const operation = platform().IOUtils.remove(cache, { recursive: true, ignoreAbsent: true })
    operationStarted = true
    void operation.finally(() => { settled = true; moving.delete('pdf'); moving.delete('ocr') }).catch(() => {})
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(uiText('旧缓存清理超时；新位置仍可使用。', 'Old cache cleanup timed out; the new location remains usable.'))), 2 * 60000) })])
    } finally { clearTimeout(timer) }
    return true
  } finally { if (!operationStarted || settled) { moving.delete('pdf'); moving.delete('ocr') } }
}
