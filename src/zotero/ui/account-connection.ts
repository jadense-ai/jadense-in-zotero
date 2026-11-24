/** 两个 Zotero 设置入口共用同一次浏览器授权，凭据始终留在连接模块。 */
import { authorizeJadenseAccount, cancelJadenseAuthorization, disconnectJadenseAccount, readJadenseAuthorizationState } from "../account-authorization"
import type { ZoteroLike } from "../runtime"
import { uiText } from "../ui-preferences"

export function renderAccountButton(button: HTMLButtonElement, host: ZoteroLike) {
  const state = readJadenseAuthorizationState(host)
  button.dataset.restore = String(state.mode !== "disconnected" && !state.available)
  button.textContent = state.pending ? uiText("取消授权", "Cancel authorization")
    : state.mode !== "disconnected" && !state.available ? uiText("读取已保存的账号", "Restore saved account")
    : state.mode === "legacy" ? uiText("改用账号授权", "Switch to account authorization")
    : state.mode === "browser" ? uiText("重新连接账号", "Reconnect account")
    : uiText("连接攻玉账号", "Connect Jadense account")
}

/** 先持久化新连接再更新界面；从旧令牌迁移失败时仍可使用旧连接。 */
export function wireAccountButton(button: HTMLButtonElement, host: ZoteroLike,
  status: (message: string, kind?: "success" | "error") => void, onConnected: () => void) {
  renderAccountButton(button, host)
  button.addEventListener("click", async () => {
    const state = readJadenseAuthorizationState(host)
    if (button.dataset.restore === "true" && state.available) {
      renderAccountButton(button, host)
      onConnected()
      status(uiText("已读取本机账号。", "Saved account restored."), "success")
      return
    }
    if (state.mode !== "disconnected" && !state.available) {
      status(uiText("请解锁 Zotero 密码管理器，然后重试。", "Unlock the Zotero password manager and try again."), "error")
      return
    }
    if (state.pending) {
      cancelJadenseAuthorization(host)
      return
    }
    try {
      const attempt = authorizeJadenseAccount(host)
      renderAccountButton(button, host)
      status(uiText("请在浏览器中确认连接。", "Confirm the connection in your browser."))
      await attempt
      onConnected()
      status(uiText("攻玉账号已连接。", "Jadense account connected."), "success")
    } catch (error) {
      status(error instanceof Error ? error.message : uiText("授权未完成。", "Authorization did not finish."), "error")
    } finally {
      renderAccountButton(button, host)
    }
  })
}

export async function disconnectWithStatus(host: ZoteroLike): Promise<string> {
  const result = await disconnectJadenseAccount(host)
  return result.revocation === "unconfirmed"
    ? uiText("本机已退出。请在攻玉网站的集成设置中断开这台设备。", "Signed out locally. Disconnect this device in Jadense integration settings.")
    : uiText("本机已断开攻玉账号。", "Jadense account disconnected from this device.")
}
