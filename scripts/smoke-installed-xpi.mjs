/**
 * Installed-XPI 冷启动 smoke。
 * 上游使用 release XPI 与 Zotero 可执行文件，下游只创建隔离临时 profile/data 并校验三次启动日志。
 */
import { spawn } from "node:child_process"
import { copyFile, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  buildReleasePaths,
  loadReleaseContext,
} from "./release-common.mjs"

export const INSTALLED_SMOKE_RUNS = 3
export const INSTALLED_SMOKE_START_MARKER = "[Jadense in Zotero] started"
export const INSTALLED_SMOKE_LOCALIZATION_MARKER = "[Jadense in Zotero] localization loaded"
export const INSTALLED_SMOKE_MANAGER_MARKER = "[Jadense in Zotero] manager booted"
export const INSTALLED_SMOKE_OPEN_MANAGER_PREF = "extensions.jadenseInZotero.smokeOpenManager"

const DEFAULT_TIMEOUT_MS = 30_000
const REJECTED_LOG_PATTERNS = [
  /ItemPaneSectionAPI.*Error/i,
  /MenuAPI.*Error/i,
  /Manager failed/i,
  /Missing resource.*jadense/i,
  /chrome:\/\/jadense[^\n]*(?:error|failed)/i,
  /(?:TypeError|ReferenceError|SyntaxError)/i,
  /(?:Chrome content|Preferences pane|Menu|Sync panel) registration failed/i,
  /Chrome content registration was unavailable/i,
]

function optionValue(argv, name) {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

function positiveInteger(value, fallback, label) {
  if (value === undefined || value === "") return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`)
  }
  return parsed
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function waitForProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode)
  return new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code) => resolve(code))
  })
}

async function stopZotero(child, profileDir) {
  if (process.platform === "win32") {
    const powershell = process.env.SystemRoot
      ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      : "powershell.exe"
    const command = [
      "$profile = $env:JADENSE_ZOTERO_SMOKE_PROFILE",
      [
        "Get-CimInstance Win32_Process -Filter \"Name='zotero.exe'\"",
        "Where-Object { $_.CommandLine -like ('*' + $profile + '*') }",
        "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
      ].join(" | "),
    ].join("; ")
    const stopper = spawn(powershell, ["-NoProfile", "-NonInteractive", "-Command", command], {
      env: {
        ...process.env,
        JADENSE_ZOTERO_SMOKE_PROFILE: profileDir,
      },
      windowsHide: true,
      stdio: "ignore",
    })
    const code = await waitForProcess(stopper)
    if (code !== 0) throw new Error(`Failed to stop isolated Zotero processes (exit code ${code}).`)
  } else if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM")
    await delay(1_000)
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
  }
  await delay(500)
}

async function readLog(filePath) {
  return readFile(filePath, "utf8").catch(() => "")
}

async function waitForStartMarker(stdoutPath, stderrPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const [stdout, stderr] = await Promise.all([readLog(stdoutPath), readLog(stderrPath)])
    if (`${stdout}\n${stderr}`.includes(INSTALLED_SMOKE_MANAGER_MARKER)) return null
    await delay(250)
  }
  return `Timed out after ${timeoutMs} ms waiting for ${INSTALLED_SMOKE_MANAGER_MARKER}.`
}

async function runColdStart({ zoteroExecutable, profileDir, dataDir, timeoutMs, stdoutPath, stderrPath }) {
  const stdoutFile = await open(stdoutPath, "w")
  const stderrFile = await open(stderrPath, "w")
  const child = spawn(zoteroExecutable, [
    "-no-remote",
    "-profile",
    profileDir,
    "-datadir",
    dataDir,
    "-ZoteroDebugText",
  ], {
    windowsHide: true,
    stdio: ["ignore", stdoutFile.fd, stderrFile.fd],
  })
  const spawnError = new Promise((resolve) => {
    child.once("error", (error) => resolve(`Zotero failed to start: ${error.message}`))
  })
  let startupError
  try {
    startupError = await Promise.race([
      waitForStartMarker(stdoutPath, stderrPath, timeoutMs),
      spawnError,
    ])
    await stopZotero(child, profileDir)
  } finally {
    await Promise.all([stdoutFile.close(), stderrFile.close()])
  }
  const [stdout, stderr] = await Promise.all([readLog(stdoutPath), readLog(stderrPath)])
  return { stdout, stderr, startupError }
}

export function validateInstalledSmokeLog({ stdout, stderr, pluginId }) {
  const combined = `${stdout}\n${stderr}`
  const failures = []
  if (!combined.includes(INSTALLED_SMOKE_START_MARKER)) {
    failures.push(`Missing startup marker: ${INSTALLED_SMOKE_START_MARKER}`)
  }
  if (!combined.includes(INSTALLED_SMOKE_LOCALIZATION_MARKER)) {
    failures.push(`Missing localization marker: ${INSTALLED_SMOKE_LOCALIZATION_MARKER}`)
  }
  if (!combined.includes(INSTALLED_SMOKE_MANAGER_MARKER)) {
    failures.push(`Missing manager boot marker: ${INSTALLED_SMOKE_MANAGER_MARKER}`)
  }
  const probeLabel = combined.match(/smoke l10n probe label: (.*)/)
  if (!probeLabel || !probeLabel[1].trim() || probeLabel[1].trim() === "(empty)") {
    failures.push("Missing resolved Fluent label for jadense-in-zotero-menu-main.")
  }
  if (!combined.includes(`Plugin ${pluginId} registered preference pane`)) {
    failures.push(`Missing installed-plugin registration marker for ${pluginId}.`)
  }
  for (const line of combined.split(/\r?\n/g)) {
    if (REJECTED_LOG_PATTERNS.some((pattern) => pattern.test(line))) {
      failures.push(`Rejected Zotero log line: ${line.trim()}`)
    }
  }
  return failures
}

async function main() {
  const argv = process.argv.slice(2)
  const positionalExecutable = argv.find((value) => !value.startsWith("-"))
  const zoteroExecutable = optionValue(argv, "--zotero")
    ?? process.env.ZOTERO_EXE
    ?? positionalExecutable
  if (!zoteroExecutable) {
    throw new Error(
      "Provide Zotero as the first positional path, with --zotero <path>, or through ZOTERO_EXE. Example: npm run smoke:installed -- D:\\Software\\zotero\\zotero.exe",
    )
  }
  const timeoutMs = positiveInteger(
    optionValue(argv, "--timeout-ms") ?? process.env.JADENSE_ZOTERO_SMOKE_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    "Installed smoke timeout",
  )
  const keepTemp = argv.includes("--keep-temp") || process.env.JADENSE_ZOTERO_SMOKE_KEEP === "1"
  const { facts, version } = await loadReleaseContext()
  const releasePaths = buildReleasePaths(facts, version)
  const xpiPath = path.resolve(optionValue(argv, "--xpi") ?? releasePaths.artifactPath)
  const pluginId = facts.manifest.applications.zotero.id
  const smokeRoot = await mkdtemp(path.join(tmpdir(), "jadense-zotero-installed-smoke-"))
  const profileDir = path.join(smokeRoot, "profile")
  const dataDir = path.join(smokeRoot, "data")
  const extensionsDir = path.join(profileDir, "extensions")
  let succeeded = false

  try {
    await mkdir(extensionsDir, { recursive: true })
    await mkdir(dataDir, { recursive: true })
    await copyFile(xpiPath, path.join(extensionsDir, `${pluginId}.xpi`))
    await writeFile(path.join(profileDir, "user.js"), [
      'user_pref("extensions.autoDisableScopes", 0);',
      'user_pref("extensions.enabledScopes", 15);',
      `user_pref("${INSTALLED_SMOKE_OPEN_MANAGER_PREF}", true);`,
      "",
    ].join("\n"))

    for (let run = 1; run <= INSTALLED_SMOKE_RUNS; run += 1) {
      const stdoutPath = path.join(smokeRoot, `cold-start-${run}.stdout.log`)
      const stderrPath = path.join(smokeRoot, `cold-start-${run}.stderr.log`)
      const result = await runColdStart({
        zoteroExecutable,
        profileDir,
        dataDir,
        timeoutMs,
        stdoutPath,
        stderrPath,
      })
      const failures = [
        ...(result.startupError ? [result.startupError] : []),
        ...validateInstalledSmokeLog({ ...result, pluginId }),
      ]
      if (failures.length > 0) {
        throw new Error(`Cold start ${run} failed:\n- ${failures.join("\n- ")}`)
      }
      console.log(`Cold start ${run}/${INSTALLED_SMOKE_RUNS} passed.`)
    }
    succeeded = true
    console.log(`Installed-XPI smoke passed (${INSTALLED_SMOKE_RUNS}/${INSTALLED_SMOKE_RUNS}).`)
  } finally {
    if (succeeded && !keepTemp) {
      await rm(smokeRoot, { recursive: true, force: true })
    } else {
      console.log(`Installed-XPI smoke artifacts: ${smokeRoot}`)
    }
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
