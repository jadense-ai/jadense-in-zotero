/** 功能模型选择器的共同展示：合并攻玉目录与本地 BYOK，供 Manager 和原生设置使用。 */
import type { JadenseChatModelCatalog, JadenseChatModelOption, JadenseChatSelection } from "@/jadense/api"
import { jadenseChatSelectionKey, normalizeJadenseChatSelection, readByokSettings, featureModelSelectionKey, effectiveFeatureModelSelection, featureFollowsChat, saveFeatureModelSelection, type AiFeature, type FeatureModelSelection } from "./ai-settings"
import type { ZoteroLike } from "./runtime"
import type { JdxSelect, JdxSelectOption } from "./custom-select"
import { show } from "./ui/toast"
import { getUiLocale, uiText } from "./ui-preferences"

import modelLogos from "../../model-logos/catalog.json"

export function shouldRefreshModelCatalog(updatedAt: number, now = Date.now()) {
  return now - updatedAt >= 60_000
}

/** 根据实际模型 ID 匹配共享品牌素材；未知品牌保留现有后备图标。 */
function modelLogo(modelID: string) {
  const tokens = modelID.toLowerCase().split(/[^a-z0-9]+/)
  const logo = modelLogos.find(entry => entry.aliases.some(alias => tokens.includes(alias)))
  return logo ? { iconSrc: `chrome://jadense-in-zotero/content/model-logos/${logo.src.split("/").at(-1)}`, iconThemed: logo.mode === "themed" } : {}
}

function jadenseModelOptionKey(option: JadenseChatModelOption) {
  return option.kind === "route" ? `route:${option.routeTier}` : `model:${option.modelId}`
}

function capabilityLabels(capabilities: readonly string[], english: boolean) {
  const labels: Record<string, string> = {
    text: english ? "Text" : "文本",
    imageInput: english ? "Images" : "图片",
    videoInput: english ? "Video" : "视频",
  }
  return capabilities.flatMap(capability => labels[capability] ?? []).join(english ? ", " : "、")
}

/** 同 Webapp 档位术语；服务端新增档位保留原值，不缩减目录能力。 */
export function modelThinkingLabel(value: string, english = getUiLocale() === "en-US") {
  const labels: Record<string, [string, string]> = { none: ["关闭", "Off"], minimal: ["最低", "Minimal"], low: ["低", "Low"], medium: ["中", "Medium"], high: ["高", "High"], xhigh: ["极高", "Extra high"], max: ["最高", "Max"], auto: ["自动", "Auto"] }
  return labels[value]?.[english ? 1 : 0] ?? value
}

/** 为已有选择器接入功能偏好；自动跟随时写对话设置，独立功能互不覆盖。 */
export function configureFeatureModelThinking(select: JdxSelect, zotero: ZoteroLike, feature: AiFeature, catalog: JadenseChatModelCatalog) {
  configureModelThinking(select, catalog, () => effectiveFeatureModelSelection(zotero, feature), selection => {
    saveFeatureModelSelection(zotero, featureFollowsChat(zotero, feature) ? "chat" : feature, selection, catalog)
  })
}

/** 私有功能也复用展示和手势，偏好所有权仍由各自宿主保留。 */
export function configureModelThinking(select: JdxSelect, catalog: JadenseChatModelCatalog, read: () => FeatureModelSelection, save: (selection: FeatureModelSelection) => void) {
  const selection = read()
  const selected = selection.route === "jadense" ? selection.selection : undefined
  const option = catalog.options.find(option => selected?.kind === "model" && option.kind === "model" && option.modelId === selected.modelId)
  const value = selected?.kind === "model" ? selected.thinkingEffort ?? option?.defaultThinkingEffort ?? "auto" : "auto"
  const efforts = option?.reasoningConfig?.reasoningEfforts ?? []
  const levels = [...new Set([...efforts.filter(value => value !== 'none'), ...(option?.reasoningConfig?.reasoningRequired === false ? ['none'] : []), ...(efforts.length ? ['auto'] : [])])].map(value => ({ value, label: modelThinkingLabel(value) }))
  const warning = uiText('服务端尚未确认支持思考设置', 'The server has not confirmed thinking settings support')
  let notice = select.element.parentElement?.querySelector<HTMLElement>('[data-thinking-contract-notice]')
  if (!notice) { notice = select.element.ownerDocument.createElementNS('http://www.w3.org/1999/xhtml', 'p'); notice.setAttribute('data-thinking-contract-notice', ''); notice.className = 'jdx-setting-description'; select.element.after(notice) }
  notice.hidden = selection.route !== 'jadense' || selected?.kind !== 'model' || catalog.thinkingContractVersion === 1
  notice.textContent = notice.hidden ? '' : warning
  const label = selection.route === 'byok' ? uiText('提供商默认', 'Provider default') : selected?.kind === 'route' ? uiText('由实际路由决定', 'Route default') : !efforts.length ? uiText('提供商默认', 'Provider default') : modelThinkingLabel(value)
  select.setModelControl({ selectionKey: featureModelSelectionKey(selection), levels, value, label,
    ...(selected?.kind === "model" && option && !option.locked && levels.length ? { onCommit: (thinkingEffort: string) => {
      try {
        // 目录刷新/跨窗换模型之后，旧手势不能覆盖新选择。
        const current = read()
        if (featureModelSelectionKey(current) !== featureModelSelectionKey(selection)) return
        save({ route: "jadense", selection: { ...selected, thinkingEffort } })
        configureModelThinking(select, catalog, read, save)
      } catch {
        show({ document: select.element.ownerDocument, themeRoot: select.element, type: "error", message: uiText("思考档位保存失败，请重试。", "Could not save thinking effort. Retry.") })
        configureModelThinking(select, catalog, read, save)
      }
    } } : {}),
  })
}

function capacityDescription(option: { contextWindow?: number; maxOutputTokens?: number }, english: boolean) {
  return [option.contextWindow ? `${english ? "Context" : "上下文"}: ${option.contextWindow.toLocaleString("en-US")} tokens` : "",
    option.maxOutputTokens ? `${english ? "Max output" : "最大输出"}: ${option.maxOutputTokens.toLocaleString("en-US")} tokens` : ""].filter(Boolean).join(" · ")
}

function modelLockReason(option: JadenseChatModelOption, english: boolean) {
  if (option.lockReason?.trim()) return option.lockReason.trim()
  const plan = option.minimumPlanCode?.trim().toUpperCase()
  if (english) return plan && plan !== "FREE"
    ? `Upgrade to ${plan} or higher to select this model or route.`
    : "Your subscription does not include this model or route."
  return plan && plan !== "FREE" ? `当前订阅不支持此模型或路由；升级到 ${plan} 或更高计划后可选择。` : "当前订阅不支持此模型或路由。"
}

/** 禁选反馈绑定在共享选择器，Manager、Reader、偏好和私有功能保持一致。 */
export function bindModelSelectToast(select: JdxSelect) {
  select.onDisabledSelect(option => {
    show({
      document: select.element.ownerDocument,
      themeRoot: select.element,
      type: "warning",
      message: option.disabledReason || uiText("当前模型不可选择。", "This model cannot be selected."),
    })
  })
}

export function buildJadenseChatModelSelectOptions(
  catalog: JadenseChatModelCatalog,
  selection?: JadenseChatSelection,
  english = getUiLocale() === "en-US",
): JdxSelectOption[] {
  const options: JdxSelectOption[] = catalog.options.map(option => {
    const features = option.kind === "model" ? capabilityLabels(option.capabilities, english) : ""
    const plan = option.minimumPlanCode?.trim().toUpperCase()
    const minimumPlan = plan && plan !== "FREE" ? plan : null
    const subscription = option.locked
      ? modelLockReason(option, english)
      : minimumPlan ? (english ? `Minimum subscription: ${minimumPlan}` : `最低订阅：${minimumPlan}`) : ""
    const meta = [
      option.locked ? (minimumPlan ? (english ? `Requires ${minimumPlan}` : `需 ${minimumPlan}`) : (english ? "Upgrade required" : "需升级订阅")) : "",
      option.kind === "model" && option.consumptionMultiplier !== undefined ? `${option.consumptionMultiplier.toFixed(2)}x` : "",
    ].filter(Boolean).join(" · ")
    return {
      value: jadenseModelOptionKey(option),
      ...(option.kind === "model" ? modelLogo(option.modelId) : {}),
      iconPath: option.kind === "route" ? "M3 12a2 2 0 1 0 4 0a2 2 0 1 0-4 0M7 12h2.5c4 0 5-5 7.5-5M7 12h2.5c4 0 5 5 7.5 5M17 7a2 2 0 1 0 4 0a2 2 0 1 0-4 0M17 17a2 2 0 1 0 4 0a2 2 0 1 0-4 0"
        : "M6 6h12v12H6zM9 9h6v6H9zM9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4",
      label: `${option.displayName}${option.locked ? (english ? " (upgrade required)" : "（需升级）") : ""}`,
      description: [subscription, option.description, features ? `${english ? "Supports: " : "支持："}${features}` : "", capacityDescription(option, english)]
        .filter(Boolean)
        .join(" · "),
      group: option.kind === "route" ? (english ? "Jadense routes" : "攻玉智能路由") : (english ? "Jadense models" : "攻玉内置模型"),
      ...(meta ? { meta } : {}),
      disabled: option.locked,
      ...(option.locked ? { disabledReason: subscription } : {}),
    }
  })
  if (!selection) return options
  selection = normalizeJadenseChatSelection(selection)
  const selectedKey = jadenseChatSelectionKey(selection)
  if (!options.some(option => option.value === selectedKey)) {
    options.push({
      value: selectedKey,
      label: selection.kind === "model" ? selection.modelId : selection.routeTier,
      description: english ? "Saved selection; refresh the catalog to check availability." : "当前选择；加载模型目录后可查看可用状态。",
      group: english ? "Current selection" : "当前选择",
      disabled: true,
      disabledReason: english ? "This saved model or route is unavailable. Choose another one." : "此前选择的攻玉模型或路由已不可用，请重新选择。",
    })
  }
  return options
}

export function jadenseChatModelSelectionIssue(
  catalog: JadenseChatModelCatalog,
  selection: JadenseChatSelection,
) {
  const option = catalog.options.find(item => jadenseModelOptionKey(item) === jadenseChatSelectionKey(selection))
  if (!option) return uiText("此前选择的攻玉模型或路由已不可用，请重新选择。", "The saved Jadense model or route is unavailable. Select another one.")
  return option.locked
    ? `${modelLockReason(option, getUiLocale() === "en-US")} ${uiText("请更换可用模型，或升级订阅后重试。", "Choose an available model, or upgrade your subscription and retry.")}`
    : ""
}

/** 两种来源始终同时可选；空目录或未登录不隐藏已保存的 BYOK 模型。 */
export function buildFeatureModelSelectOptions(zotero: ZoteroLike, catalog: JadenseChatModelCatalog, selection: FeatureModelSelection, english = getUiLocale() === "en-US"): JdxSelectOption[] {
  const options = buildJadenseChatModelSelectOptions(catalog, selection.route === "jadense" ? normalizeJadenseChatSelection(selection.selection) : undefined, english)
  const settings = readByokSettings(zotero)
  options.push(...settings.models.map(model => ({
    value: `byok:${model.id}`,
    ...modelLogo(model.model),
    iconPath: "M5.5 8h3A2.5 2.5 0 0 1 11 10.5v3A2.5 2.5 0 0 1 8.5 16h-3A2.5 2.5 0 0 1 3 13.5v-3A2.5 2.5 0 0 1 5.5 8M6.4 12a.6.6 0 1 0 1.2 0a.6.6 0 1 0-1.2 0M11 12h10M17 12v3.5M20.5 12v2.5",
    label: model.name || model.model || (english ? "Unnamed model" : "未命名模型"),
    description: [settings.providers.find(provider => provider.id === model.providerId)?.name || (english ? "Provider" : "提供商"), model.model || (english ? "Model ID is missing" : "尚未填写模型 ID"), capacityDescription(model, english)].filter(Boolean).join(" · "),
    group: english ? "BYOK models" : "BYOK 自配置模型",
  })))
  const key = featureModelSelectionKey(selection)
  if (!key) return options
  if (!options.some(option => option.value === key)) options.push({ value: key, label: english ? "Unavailable BYOK model" : "已失效的 BYOK 模型", group: english ? "Current selection" : "当前选择", disabled: true, disabledReason: english ? "This BYOK model is unavailable." : "此 BYOK 模型已不可用。" })
  return options
}
