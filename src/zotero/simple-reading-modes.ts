/** 两种插件阅读视图的互斥接缝；各自负责完整恢复原生宿主。 */
const modes = new Map<object, { kind: 'sdt' | 'pdf'; close(): void | Promise<void> }>()
const transitions = new WeakMap<object, Promise<unknown>>()
/** 同一 Reader 的异步进入流程串行，快速交替点击不能挂载两个视图。 */
export function readingTransition<T>(reader: object, mount: () => Promise<T>): Promise<T> {
  const next = (transitions.get(reader) ?? Promise.resolve()).catch(() => {}).then(mount)
  transitions.set(reader, next)
  void next.finally(() => { if (transitions.get(reader) === next) transitions.delete(reader) }).catch(() => {})
  return next
}
export async function leaveOtherReadingMode(reader: object, kind: 'sdt' | 'pdf') {
  const mode = modes.get(reader)
  if (mode && mode.kind !== kind) { modes.delete(reader); await mode.close() }
}
export function registerReadingMode(reader: object, kind: 'sdt' | 'pdf', close: () => void | Promise<void>) {
  const mode = { kind, close }; modes.set(reader, mode)
  return () => { if (modes.get(reader) === mode) modes.delete(reader) }
}
