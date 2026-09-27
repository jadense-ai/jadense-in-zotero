/** 可选发行模块接缝：基础源码使用空实现，发行构建可替换实现而不引入私有源码依赖。 */
import type { ZoteroLike } from './runtime'
export type OptionalPageContext = {
  host: ZoteroLike
  document: Document
  registerPage(id: string, label: string, icon: string): { section: HTMLElement; button: HTMLButtonElement; open(): void }
}
export function startOptionalFeatures(_host: ZoteroLike): void { /* 基础发行无可选模块。 */ }
export function stopOptionalFeatures(_host: ZoteroLike): void { /* 基础发行无可选模块。 */ }
export function mountOptionalFeatures(_context: OptionalPageContext): () => void { return () => {} }
