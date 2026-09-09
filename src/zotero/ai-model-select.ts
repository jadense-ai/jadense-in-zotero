/** 功能模型选择器的共同展示：合并攻玉目录与本地 BYOK，供 Manager 和原生设置使用。 */
import type { JadenseChatModelCatalog, JadenseChatModelOption, JadenseChatSelection } from "@/jadense/api"
import { jadenseChatSelectionKey, normalizeJadenseChatSelection, readByokSettings, featureModelSelectionKey, type FeatureModelSelection } from "./ai-settings"
import type { ZoteroLike } from "./runtime"
import type { JdxSelectOption } from "./custom-select"
import { getUiLocale, uiText } from "./ui-preferences"

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
    label: model.name || model.model || (english ? "Unnamed model" : "未命名模型"),
    description: `${settings.providers.find(provider => provider.id === model.providerId)?.name || (english ? "Provider" : "提供商")} · ${model.model || (english ? "Model ID is missing" : "尚未填写模型 ID")}`,
    group: english ? "BYOK models" : "BYOK 自配置模型",
  })))
  const key = featureModelSelectionKey(selection)
  if (!options.some(option => option.value === key)) options.push({ value: key, label: english ? "Unavailable BYOK model" : "已失效的 BYOK 模型", group: english ? "Current selection" : "当前选择", disabled: true })
  return options
}
