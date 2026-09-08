import { describe, expect, it, vi } from "vitest"

import {
  BYOK_TEST_MAX_OUTPUT_TOKENS,
  ByokChatClient,
  consumeByokStream,
  defaultByokConfig,
  type ByokConfig,
  type ByokProtocol,
} from "./byok-chat"

function streamResponse(lines: string[], status = 200) {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line))
      controller.close()
    },
  }), { status, headers: { "content-type": "text/event-stream" } })
}

function config(protocol: ByokProtocol): ByokConfig {
  return {
    ...defaultByokConfig(),
    protocol,
    baseUrl: protocol === "anthropic-messages" ? "https://api.anthropic.com/v1/" : "https://api.openai.com/v1/",
    apiKey: "private-fixture-key",
    model: "fixture-model",
  }
}

describe("BYOK request protocols", () => {
  it("caps real connection probes at 3000 output tokens", () => {
    expect(BYOK_TEST_MAX_OUTPUT_TOKENS).toBe(3_000)
  })

  it.each([
    {
      protocol: "openai-chat-completions" as const,
      path: "https://api.openai.com/v1/chat/completions",
      auth: ["authorization", "Bearer private-fixture-key"],
      maxField: "max_completion_tokens",
      messageField: "messages",
    },
    {
      protocol: "anthropic-messages" as const,
      path: "https://api.anthropic.com/v1/messages",
      auth: ["x-api-key", "private-fixture-key"],
      maxField: "max_tokens",
      messageField: "messages",
    },
    {
      protocol: "openai-responses" as const,
      path: "https://api.openai.com/v1/responses",
      auth: ["authorization", "Bearer private-fixture-key"],
      maxField: "max_output_tokens",
      messageField: "input",
    },
  ])("sends $protocol directly with its standard shape", async ({ protocol, path, auth, maxField, messageField }) => {
    const endings = protocol === "openai-chat-completions"
      ? ['data: {"choices":[{"delta":{"content":"回答"},"finish_reason":"stop"}]}\n\n', "data: [DONE]\n\n"]
      : protocol === "anthropic-messages"
        ? ['data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"回答"}}\r\n\r\n', 'data: {"type":"message_stop"}\r\n\r\n']
        : ['data: {"type":"response.output_text.delta","delta":"回答"}\n\n', 'data: {"type":"response.completed"}\n\n']
    const fetchImpl = vi.fn().mockResolvedValue(streamResponse(endings))
    const client = new ByokChatClient({ config: config(protocol), fetchImpl })

    await expect(client.send({
      clientRequestId: "request-1",
      conversationId: "session-1",
      messages: [{ id: "user-1", role: "user", text: "问题" }],
      requireComplete: true,
    })).resolves.toBe("回答")

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    const headers = new Headers(init.headers)
    const body = JSON.parse(String(init.body))
    expect(url).toBe(path)
    expect(headers.get(auth[0]!)).toBe(auth[1])
    expect(body).toMatchObject({ model: "fixture-model", stream: true, [maxField]: 96_000 })
    expect(body[messageField]).toEqual([{ role: "user", content: "问题" }])
    if (protocol === "anthropic-messages") expect(headers.get("anthropic-version")).toBe("2023-06-01")
    if (protocol === "openai-responses") expect(body.store).toBe(false)
  })

  it("injects bounded local sources only into the latest user message", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(streamResponse(["data: [DONE]\n\n"]))
    const client = new ByokChatClient({ config: config("openai-chat-completions"), fetchImpl })
    await client.send({
      clientRequestId: "source-request",
      conversationId: "source-session",
      messages: [
        { id: "old", role: "user", text: "旧问题" },
        { id: "answer", role: "assistant", text: "旧回答" },
        { id: "latest", role: "user", text: "新问题" },
      ],
      sources: [{
        id: "source", kind: "file", itemID: 7, libraryID: 1, itemKey: "PDFKEY", title: "论文",
        text: "本地正文", localPath: "C:/private/paper.pdf", futureField: "ignored",
      } as never],
    })
    const body = JSON.parse(String((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body))
    expect(body.messages[0].content).toBe("旧问题")
    expect(body.messages[2].content).toMatch(/^新问题\n\n/)
    expect(body.messages[2].content).toContain("本地正文")
    expect(JSON.stringify(body)).not.toContain("C:/private")
    expect(JSON.stringify(body)).not.toContain("futureField")
  })

  it.each([
    {
      protocol: "openai-chat-completions" as const,
      field: "messages",
      content: [
        { type: "text", text: "解读图片" },
        { type: "image_url", image_url: { url: "data:image/png;base64,ZmFrZS1pbWFnZQ==" } },
      ],
    },
    {
      protocol: "anthropic-messages" as const,
      field: "messages",
      content: [
        { type: "text", text: "解读图片" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "ZmFrZS1pbWFnZQ==" } },
      ],
    },
    {
      protocol: "openai-responses" as const,
      field: "input",
      content: [
        { type: "input_text", text: "解读图片" },
        { type: "input_image", image_url: "data:image/png;base64,ZmFrZS1pbWFnZQ==" },
      ],
    },
  ])("projects ephemeral images for $protocol", async ({ protocol, field, content }) => {
    const endings = protocol === "openai-chat-completions"
      ? ["data: [DONE]\n\n"]
      : protocol === "anthropic-messages"
        ? ['data: {"type":"message_stop"}\n\n']
        : ['data: {"type":"response.completed"}\n\n']
    const fetchImpl = vi.fn().mockResolvedValue(streamResponse(endings))
    const client = new ByokChatClient({ config: config(protocol), fetchImpl })

    await client.send({
      clientRequestId: "image-request",
      conversationId: "image-session",
      messages: [
        { id: "old", role: "user", text: "旧问题" },
        { id: "answer", role: "assistant", text: "旧回答" },
        { id: "latest", role: "user", text: "解读图片" },
      ],
      images: [{
        dataUrl: "data:image/png;base64,ZmFrZS1pbWFnZQ==",
        mimeType: "image/png",
        name: "figure.png",
      }],
    })

    const body = JSON.parse(String((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body))
    expect(body[field][0]).toEqual({ role: "user", content: "旧问题" })
    expect(body[field][2]).toEqual({ role: "user", content })
  })

  it("surfaces an image-capability provider error without fallback", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { message: "fixture-model does not support image input" },
    }), { status: 400 }))
    const client = new ByokChatClient({ config: config("openai-chat-completions"), fetchImpl })

    await expect(client.send({
      clientRequestId: "unsupported-image",
      conversationId: "unsupported-image",
      messages: [{ id: "user", role: "user", text: "解读" }],
      images: [{ dataUrl: "data:image/png;base64,ZmFrZQ==", mimeType: "image/png" }],
    })).rejects.toThrow("fixture-model does not support image input")
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe("BYOK streams", () => {
  it("accepts split CRLF events and ignores unknown additive events", async () => {
    const onDelta = vi.fn()
    await expect(consumeByokStream(streamResponse([
      'data: {"type":"future.event","extra":true}\r\n\r\n',
      'data: {"type":"response.output_text.delta",', '"delta":"流式"}\r\n\r\n',
      'data: {"type":"response.completed"}\r\n\r\n',
    ]), "openai-responses", "secret", onDelta, true)).resolves.toBe("流式")
    expect(onDelta).toHaveBeenCalledWith("流式", "流式")
  })

  it.each([
    ["openai-chat-completions", 'data: {"choices":[{"delta":{"content":"片段"},"finish_reason":"length"}]}\n\n'],
    ["anthropic-messages", 'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}\n\n'],
    ["openai-responses", 'data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}\n\n'],
  ] as const)("rejects incomplete %s analysis", async (protocol, event) => {
    await expect(consumeByokStream(streamResponse([event]), protocol, "secret", undefined, true))
      .rejects.toThrow("未完整结束")
  })

  it("accepts a valid length-terminated stream only for the connection probe", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(streamResponse([
      'data: {"choices":[{"delta":{"content":"O"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
    ]))
    const client = new ByokChatClient({ config: config("openai-chat-completions"), fetchImpl })
    await expect(client.send({
      clientRequestId: "probe", conversationId: "probe", acceptTruncated: true,
      messages: [{ id: "user", role: "user", text: "Reply with OK." }],
    })).resolves.toBe("O")
  })

  it("requires a terminal event before annotation-capable output", async () => {
    await expect(consumeByokStream(streamResponse([
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"片段"}}\n\n',
    ]), "anthropic-messages", "secret", undefined, true)).rejects.toThrow("连接意外结束")
  })

  it("rejects malformed events and abnormal EOF for ordinary chat too", async () => {
    await expect(consumeByokStream(streamResponse(["data: not-json\n\n"]), "openai-responses", "secret"))
      .rejects.toThrow("无法解析")
    await expect(consumeByokStream(streamResponse([
      'data: {"type":"response.output_text.delta","delta":"片段"}\n\n',
    ]), "openai-responses", "secret")).rejects.toThrow("成功结束事件前")
  })

  it("redacts credentials from provider and HTTP errors", async () => {
    const response = new Response(JSON.stringify({
      error: { message: "bad private-fixture-key data:image/png;base64,ZmFrZS1pbWFnZQ==" },
    }), { status: 401 })
    await expect(consumeByokStream(response, "openai-chat-completions", "private-fixture-key"))
      .rejects.toThrow("bad [REDACTED] [图片数据已移除]")
  })

  it("redacts credentials from network and stream failures", async () => {
    const networkClient = new ByokChatClient({
      config: config("openai-chat-completions"),
      fetchImpl: vi.fn().mockRejectedValue(new Error("network private-fixture-key")),
    })
    await expect(networkClient.send({
      clientRequestId: "network", conversationId: "network",
      messages: [{ id: "user", role: "user", text: "问题" }],
    })).rejects.toThrow("network [REDACTED]")

    const encoder = new TextEncoder()
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"片段"}}]}\n\n'))
        controller.error(new Error("stream private-fixture-key"))
      },
    }))
    await expect(consumeByokStream(response, "openai-chat-completions", "private-fixture-key"))
      .rejects.toThrow("stream [REDACTED]")
  })

  it("forwards abort and releases the stream", async () => {
    const abort = new AbortController()
    let response: Response | undefined
    const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      response = new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"片段"}}]}\n\n'))
          init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true })
        },
      }))
      return Promise.resolve(response)
    })
    const client = new ByokChatClient({ config: config("openai-chat-completions"), fetchImpl })
    const result = client.send({
      clientRequestId: "abort", conversationId: "abort", signal: abort.signal,
      messages: [{ id: "user", role: "user", text: "问题" }], requireComplete: true,
    })
    abort.abort()
    await expect(result).rejects.toMatchObject({ name: "AbortError" })
    expect(response?.body?.locked).toBe(false)
  })

  it("keeps the Gecko Window receiver for default fetch", async () => {
    const fetchImpl = vi.fn(function (this: unknown) {
      expect(this).toBe(globalThis)
      return Promise.resolve(streamResponse(["data: [DONE]\n\n"]))
    })
    vi.stubGlobal("fetch", fetchImpl)
    try {
      const client = new ByokChatClient({ config: config("openai-chat-completions") })
      await client.send({
        clientRequestId: "receiver", conversationId: "receiver",
        messages: [{ id: "user", role: "user", text: "问题" }],
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
