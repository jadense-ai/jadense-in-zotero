/** 功能模型选择器的共同展示：合并攻玉目录与本地 BYOK，供 Manager 和原生设置使用。 */
import type { JadenseChatModelCatalog, JadenseChatModelOption, JadenseChatSelection } from "@/jadense/api"
import { jadenseChatSelectionKey, normalizeJadenseChatSelection, readByokSettings, featureModelSelectionKey, type FeatureModelSelection } from "./ai-settings"
import type { ZoteroLike } from "./runtime"
import type { JdxSelectOption } from "./custom-select"
import { getUiLocale, uiText } from "./ui-preferences"

import modelLogos from "../../model-logos/catalog.json"

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
      ? option.lockReason || (english ? "Your subscription does not include this model or route." : "当前订阅不支持此模型或路由。")
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
      description: [subscription, option.description, features ? `${english ? "Supports: " : "支持："}${features}` : ""]
        .filter(Boolean)
        .join(" · "),
      group: option.kind === "route" ? (english ? "Jadense routes" : "攻玉智能路由") : (english ? "Jadense models" : "攻玉内置模型"),
      ...(meta ? { meta } : {}),
      disabled: option.locked,
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
    ? `${option.lockReason || uiText("当前订阅不支持所选模型或路由。", "Your subscription does not include this model or route.")} ${uiText("请更换可用模型，或升级订阅后重试。", "Choose an available model, or upgrade your subscription and retry.")}`
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
    description: `${settings.providers.find(provider => provider.id === model.providerId)?.name || (english ? "Provider" : "提供商")} · ${model.model || (english ? "Model ID is missing" : "尚未填写模型 ID")}`,
    group: english ? "BYOK models" : "BYOK 自配置模型",
  })))
  const key = featureModelSelectionKey(selection)
  if (!key) return options
  if (!options.some(option => option.value === key)) options.push({ value: key, label: english ? "Unavailable BYOK model" : "已失效的 BYOK 模型", group: english ? "Current selection" : "当前选择", disabled: true })
  return options
}
