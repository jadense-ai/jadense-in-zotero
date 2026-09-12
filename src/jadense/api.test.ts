import { describe, expect, it, vi } from "vitest"

import { JadenseApiClient, JadenseApiError, jadenseModelSubscriptionErrorMessage, parseJadenseChatModelCatalog, readJadenseApiError } from "./api"

describe("JadenseApiClient", () => {
  it('distinguishes an empty HTTP rejection from a failed response-body read', async () => {
    const empty = await readJadenseApiError(new Response(null, { status: 400, headers: { 'x-request-id': 'test-request-400' } }), undefined, true)
    expect(empty.message).toContain('400'); expect(empty.message).toContain('响应正文为空')
    expect(empty.message).toContain('test-request-400')
    const broken = new Response(null, { status: 400 })
    vi.spyOn(broken, 'text').mockRejectedValue(new Error('stream failed'))
    const failed = await readJadenseApiError(broken, undefined, true)
    expect(failed.message).toContain('响应正文读取失败'); expect(failed.message).not.toContain('响应正文为空')
    const normal = await readJadenseApiError(new Response(null, { status: 400 }))
    expect(normal.message).toBe('攻玉请求失败（400）')
  })
  it.each(['<html>proxy</html>', 'x'.repeat(500), '{"detail":"unrecognized shape"}'])('explains an unreadable error response instead of falling back to a bare status: %s', async body => {
    const error = await readJadenseApiError(new Response(body, { status: 400 }), undefined, true)
    expect(error.message).toContain('400'); expect(error.message).not.toBe('攻玉请求失败（400）')
    expect(error.message).not.toContain('<html>')
  })
  it('shows a short plain-text rejection without displaying an HTML proxy page', async () => {
    const error = await readJadenseApiError(new Response('Invalid body', { status: 400 }), undefined, true)
    expect(error.message).toContain('Invalid body'); expect(error.message).toContain('400')
    const html = await readJadenseApiError(new Response('<html>proxy</html>', { status: 400 }), undefined, true)
    expect(html.message).not.toContain('<html>')
  })
  it("preserves optional subscription requirements without inferring locks or rejecting future fields", () => {
    const catalog = parseJadenseChatModelCatalog({ options: [
      { kind: "model", modelId: "paid", displayName: "Paid", minimumPlanCode: " go ", locked: true, lockReason: "需要 GO", future: true },
      { kind: "route", routeTier: "premium", displayName: "Premium", minimumPlanCode: "future-plan", locked: false },
      { kind: "model", modelId: "basic", displayName: "Basic", minimumPlanCode: null, locked: false },
    ] })
    expect(catalog.options).toHaveLength(3)
    expect(catalog.options[0]).toMatchObject({ minimumPlanCode: "go", locked: true, lockReason: "需要 GO" })
    expect(catalog.options[1]).toMatchObject({ minimumPlanCode: "future-plan", locked: false })
    expect(catalog.options[2]).not.toHaveProperty("minimumPlanCode")
  })

  it("does not confuse subscription restrictions with missing token scopes, points or BYOK errors", () => {
    for (const code of ["POINTS_INSUFFICIENT", "insufficient_scope", "AI_MODEL_SELECTION_UNAVAILABLE"]) {
      expect(jadenseModelSubscriptionErrorMessage(new JadenseApiError({ code, status: 403, body: "", message: "original" }))).toBeNull()
    }
    expect(jadenseModelSubscriptionErrorMessage(Object.assign(new Error("BYOK rejected"), { code: "AI_MODEL_SELECTION_PLAN_REQUIRED" }))).toBeNull()
  })

  it("loads the shared route/model catalog with temporary-chat bearer auth", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      options: [
        { kind: "route", routeTier: "standard", displayName: "标准", description: "自动选择", locked: false, future: true },
        { kind: "model", modelId: "glm-5", displayName: "GLM-5", description: "长文模型", locked: false, capabilities: ["text", "imageInput"], consumptionMultiplier: 1.25, labels: ["new"] },
        { kind: "future-kind", id: "ignored" },
      ],
      defaultSelection: { kind: "route", routeTier: "standard", future: true },
      futureRoot: true,
    })))
    const client = new JadenseApiClient({
      baseUrl: "https://jadense.cn/",
      token: "jdx_ext_secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await expect(client.getChatModels()).resolves.toEqual({
      options: [
        { kind: "route", routeTier: "standard", displayName: "标准", description: "自动选择", locked: false },
        { kind: "model", modelId: "glm-5", displayName: "GLM-5", description: "长文模型", locked: false, capabilities: ["text", "imageInput"], consumptionMultiplier: 1.25 },
      ],
      defaultSelection: { kind: "route", routeTier: "standard" },
    })
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://jadense.cn/api/extension/chat/models",
      expect.objectContaining({ headers: expect.any(Headers) }),
    )
    expect((fetchImpl.mock.calls[0]?.[1]?.headers as Headers).get("authorization")).toBe("Bearer jdx_ext_secret")
  })

  it("drops malformed optional model rows but rejects a missing options collection", () => {
    expect(parseJadenseChatModelCatalog({
      options: [
        { kind: "model", modelId: "", displayName: "Broken" },
        { kind: "route", routeTier: "premium", displayName: "高阶", locked: true, lockReason: "需要升级" },
      ],
      defaultSelection: { kind: "future", id: "ignored" },
    })).toEqual({
      options: [{ kind: "route", routeTier: "premium", displayName: "高阶", description: "", locked: true, lockReason: "需要升级" }],
      defaultSelection: null,
    })
    expect(() => parseJadenseChatModelCatalog({ future: true })).toThrow("模型目录响应格式无效")
  })

  it("preserves HTTP status, stable code, message, and raw body on API failures", async () => {
    const body = JSON.stringify({ error: "Extension token does not include the required scopes.", code: "insufficient_scope" })
    const client = new JadenseApiClient({
      baseUrl: "https://jadense.cn",
      token: "jdx_ext_secret",
      fetchImpl: vi.fn().mockResolvedValue(new Response(body, { status: 403 })) as unknown as typeof fetch,
    })

    await expect(client.getPointsStatus()).rejects.toMatchObject({
      name: "JadenseApiError",
      status: 403,
      code: "insufficient_scope",
      message: "Extension token does not include the required scopes.",
      body,
    } satisfies Partial<JadenseApiError>)
  })

  it.each([403, 429])("keeps non-JSON HTTP %s bodies diagnostic-only", async (status) => {
    const body = "<html><body>upstream details</body></html>"
    const client = new JadenseApiClient({
      baseUrl: "https://jadense.cn",
      token: "jdx_ext_secret",
      fetchImpl: vi.fn().mockResolvedValue(new Response(body, {
        status,
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch,
    })

    await expect(client.getCurrentProfile()).rejects.toMatchObject({
      status,
      code: null,
      body,
      message: `攻玉请求失败（${status}）`,
    } satisfies Partial<JadenseApiError>)
  })

  it("loads profile and points, then posts a check-in through extension endpoints", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        userId: "user-1", displayName: "测试用户", avatarUrl: null, avatarSrc: null,
        subscription: { code: "pro", label: "PRO" }, futureField: true,
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        billing: { sourceKind: "team", teamId: "team-1", balancePoints: 36, primaryBalancePoints: 30, fallbackBalancePoints: 6 },
        checkIn: { signedToday: false, currentStreakDays: 4, todayReward: { grantedPoints: 2 } }, futureField: true,
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ alreadyCheckedIn: false, balanceAfter: 38, grantedPoints: 2, ignored: true })))
    const client = new JadenseApiClient({
      baseUrl: "https://jadense.cn/",
      token: "jdx_ext_secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const signal = new AbortController().signal

    const profile = await client.getCurrentProfile(signal)
    const points = await client.getPointsStatus(signal)
    expect(profile).toMatchObject({ displayName: "测试用户" })
    expect(profile).not.toHaveProperty("futureField")
    expect(points).toMatchObject({ billing: { balancePoints: 36 } })
    expect(points).not.toHaveProperty("futureField")
    await expect(client.checkInPoints(signal)).resolves.toEqual({ alreadyCheckedIn: false, balanceAfter: 38, grantedPoints: 2 })

    expect(fetchImpl.mock.calls.map(([url, init]) => [url, init?.method ?? "GET"])).toEqual([
      ["https://jadense.cn/api/extension/profile/me", "GET"],
      ["https://jadense.cn/api/extension/points/status", "GET"],
      ["https://jadense.cn/api/extension/points/check-in", "POST"],
    ])
    for (const [, init] of fetchImpl.mock.calls) {
      expect((init?.headers as Headers).get("authorization")).toBe("Bearer jdx_ext_secret")
      expect(init?.signal).toBe(signal)
    }
  })

  it("rejects malformed successful account payloads locally", async () => {
    const malformed = () => new JadenseApiClient({
      baseUrl: "https://jadense.cn",
      token: "jdx_ext_secret",
      fetchImpl: vi.fn().mockResolvedValue(new Response(JSON.stringify({ futureField: true }))) as unknown as typeof fetch,
    })

    await expect(malformed().getCurrentProfile()).rejects.toThrow("账号资料响应格式无效")
    await expect(malformed().getPointsStatus()).rejects.toThrow("积分状态响应格式无效")
    await expect(malformed().checkInPoints()).rejects.toThrow("签到响应格式无效")
  })

  it("normalizes empty and non-JSON successful account payloads at the API seam", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("<html>not JSON</html>", { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response("not JSON", { status: 200 }))
    const client = new JadenseApiClient({
      baseUrl: "https://jadense.cn",
      token: "jdx_ext_secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await expect(client.getCurrentProfile()).rejects.toThrow("攻玉账号资料响应格式无效")
    await expect(client.getPointsStatus()).rejects.toThrow("攻玉积分状态响应格式无效")
    await expect(client.checkInPoints()).rejects.toThrow("攻玉签到响应格式无效")
  })

  it("keeps zero and negative effective balances as valid status values", async () => {
    const client = new JadenseApiClient({
      baseUrl: "https://jadense.cn",
      token: "jdx_ext_secret",
      fetchImpl: vi.fn().mockResolvedValue(new Response(JSON.stringify({
        billing: { sourceKind: "personal", teamId: null, balancePoints: -5, primaryBalancePoints: 0, fallbackBalancePoints: null },
        checkIn: { signedToday: true, currentStreakDays: 0, todayReward: { grantedPoints: 0 } },
      }))) as unknown as typeof fetch,
    })

    await expect(client.getPointsStatus()).resolves.toMatchObject({
      billing: { sourceKind: "personal", balancePoints: -5, primaryBalancePoints: 0 },
      checkIn: { signedToday: true, currentStreakDays: 0 },
    })
  })

  it("keeps the Window receiver when using the default Gecko fetch", async () => {
    const fetchImpl = vi.fn(function (this: unknown) {
      expect(this).toBe(globalThis)
      return Promise.resolve({
        ok: true,
        json: async () => ({ items: [] }),
      })
    })
    vi.stubGlobal("fetch", fetchImpl)
    try {
      const client = new JadenseApiClient({
        baseUrl: "https://jadense.cn",
        token: "jdx_ext_secret",
      })
      await expect(client.listFavoriteItems("folder-1")).resolves.toEqual({ items: [] })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("calls extension favorite item export with bearer auth", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [] }),
    })
    const client = new JadenseApiClient({
        baseUrl: "https://jadense.cn/",
      token: "jdx_ext_secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await expect(client.listFavoriteItems("folder-1")).resolves.toEqual({ items: [] })

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://jadense.cn/api/extension/favorite/items?folderId=folder-1&field=title",
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    )
    const headers = fetchImpl.mock.calls[0]?.[1]?.headers as Headers
    expect(headers.get("authorization")).toBe("Bearer jdx_ext_secret")
  })

  it("posts Zotero import batches", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ importedCount: 1, skippedCount: 0, failedCount: 0, results: [] }),
    })
    const client = new JadenseApiClient({
      baseUrl: "http://localhost:3000",
      token: "jdx_ext_secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await client.importZoteroItems(["folder-1"], [
      {
        clientItemId: "zotero:L1/I1",
        metadata: {
          doi: null,
          externalSource: null,
          externalId: null,
          title: "Paper",
          authors: [],
          venueName: null,
          publicationDate: null,
          abstract: null,
          canonicalUrl: null,
          pageUrl: null,
          sourceMetadata: {},
        },
      },
    ])

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://localhost:3000/api/extension/favorite/import-zotero-items",
      expect.objectContaining({ method: "POST" }),
    )
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))
    expect(body).toEqual({
      folderIds: ["folder-1"],
      items: [
        {
          clientItemId: "zotero:L1/I1",
          metadata: expect.objectContaining({ title: "Paper" }),
        },
      ],
    })
  })

  it("uploads Zotero PDF imports as multipart form data", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ itemKind: "literature", articleId: null, insertedFolderIds: ["folder-1"], skippedFolderIds: [] }),
    })
    const client = new JadenseApiClient({
      baseUrl: "http://localhost:3000",
      token: "jdx_ext_secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await client.importFavoritePdf({
      folderIds: ["folder-1"],
      file: new Blob(["pdf"], { type: "application/pdf" }),
      filename: "paper.pdf",
      item: {
        clientItemId: "zotero:L1/I1",
        metadata: {
          doi: null,
          externalSource: null,
          externalId: null,
          title: "Paper",
          authors: [],
          venueName: "Zotero Venue",
          publicationDate: null,
          abstract: null,
          canonicalUrl: null,
          pageUrl: null,
          sourceMetadata: {},
        },
      },
    })

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://localhost:3000/api/extension/favorite/import-page-pdf",
      expect.objectContaining({ method: "POST", body: expect.any(FormData) }),
    )
    const headers = fetchImpl.mock.calls[0]?.[1]?.headers as Headers
    expect(headers.get("authorization")).toBe("Bearer jdx_ext_secret")
    expect(headers.has("content-type")).toBe(false)
    const form = fetchImpl.mock.calls[0]?.[1]?.body as FormData
    const paper = JSON.parse(String(form.get("paper")))
    expect(paper.metadata).toMatchObject({
      title: "Paper",
      venueName: "Zotero Venue",
    })
    expect(paper.metadata).not.toHaveProperty("journal")
  })

  it("uses an injected Window FormData factory across the Zotero bootstrap realm", async () => {
    const windowForm = new FormData()
    const formDataFactory = vi.fn(() => windowForm)
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ itemKind: "literature", articleId: null, insertedFolderIds: [], skippedFolderIds: [] }),
    })
    const client = new JadenseApiClient({
      baseUrl: "http://localhost:3000",
      token: "jdx_ext_secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      formDataFactory,
    })

    await client.importFavoritePdf({
      folderIds: ["folder-1"],
      file: new Blob(["%PDF-1.4"], { type: "application/pdf" }),
      filename: "paper.pdf",
      item: {
        clientItemId: "zotero:L1/I1",
        metadata: {
          doi: null,
          externalSource: null,
          externalId: null,
          title: "Paper",
          authors: [],
          venueName: null,
          publicationDate: null,
          abstract: null,
          canonicalUrl: null,
          pageUrl: null,
          sourceMetadata: {},
        },
      },
    })

    expect(formDataFactory).toHaveBeenCalledOnce()
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://localhost:3000/api/extension/favorite/import-page-pdf",
      expect.objectContaining({ body: windowForm }),
    )
    const headers = fetchImpl.mock.calls[0]?.[1]?.headers as Headers
    expect(headers.has("content-type")).toBe(false)
  })
})
