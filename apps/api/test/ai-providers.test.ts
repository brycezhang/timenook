import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DoubaoFileAsr,
  DeepSeekText,
  AsrSourcePreflightError,
} from "../src/probe/ai-providers";

const config = {
  apiKey: "synthetic-key",
  resourceId: "volc.bigasr.auc",
  fetchWindowSeconds: 600,
};
const id = "00000000-0000-4000-8000-000000000003";
const source = {
  url: "https://synthetic.oss-cn-hangzhou.aliyuncs.com/sealed/synthetic.mp3?secret=synthetic",
  expiresAt: new Date(Date.now() + 700000).toISOString(),
  credentialsExpireAt: new Date(Date.now() + 800000).toISOString(),
};
test("Doubao standard file protocol distinguishes HTTP acceptance from query success and preserves the request UUID", async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const replies = [
    new Response(null, { headers: { "X-Api-Status-Code": "20000000" } }),
    new Response("{}", { headers: { "X-Api-Status-Code": "20000001" } }),
    new Response('{"result":{"text":"合成讲述。"}}', {
      headers: { "X-Api-Status-Code": "20000000" },
    }),
  ];
  const provider = new DoubaoFileAsr(config, async (url, init) => {
    requests.push({ url: String(url), init: init! });
    return replies.shift()!;
  });
  assert.equal((await provider.submit(id, source)).state, "accepted");
  assert.equal((await provider.query(id)).state, "processing");
  assert.deepEqual(await provider.query(id), {
    state: "succeeded",
    code: "20000000",
    transcript: "合成讲述。",
  });
  assert.deepEqual(
    requests.map((r) => r.url),
    [
      "https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit",
      "https://openspeech.bytedance.com/api/v3/auc/bigmodel/query",
      "https://openspeech.bytedance.com/api/v3/auc/bigmodel/query",
    ],
  );
  for (const r of requests) {
    assert.equal(r.init.method, "POST");
    const h = new Headers(r.init.headers);
    assert.equal(h.get("X-Api-Request-Id"), id);
    assert.equal(h.get("X-Api-Key"), "synthetic-key");
    assert.equal(h.get("X-Api-Resource-Id"), "volc.bigasr.auc");
    assert.equal(h.has("X-Api-App-Key"), false);
  }
  assert.equal(
    new Headers(requests[0].init.headers).get("X-Api-Sequence"),
    "-1",
  );
  assert.equal(
    JSON.parse(String(requests[0].init.body)).request.model_name,
    "bigmodel",
  );
  assert.equal(requests[1].init.body, "{}");
});

test("ASR never converts ambiguous responses into success or retries, and rejects unsafe source windows before network I/O", async () => {
  for (const [code, text, expected] of [
    ["20000002", "{}", "queued"],
    ["20000003", "{}", "no_speech"],
    ["45000002", "{}", "no_speech"],
    ["20000000", '{"result":{"text":"  "}}', "no_speech"],
    ["20000000", "{}", "unknown"],
    ["45000001", "{}", "unknown"],
    ["55000031", "{}", "unknown"],
    ["20000000", '{"task_id":"different"}', "unknown"],
    ["45000151", "{}", "failed"],
  ]) {
    const provider = new DoubaoFileAsr(
      config,
      async () =>
        new Response(text, { headers: { "X-Api-Status-Code": code } }),
    );
    assert.equal((await provider.query(id)).state, expected, code + text);
  }
  for (const bad of [
    { ...source, url: "http://127.0.0.1/private" },
    {
      ...source,
      url: "https://synthetic.oss-cn-hangzhou-internal.aliyuncs.com/a",
    },
    { ...source, expiresAt: new Date(Date.now() + 1000).toISOString() },
    {
      ...source,
      credentialsExpireAt: new Date(Date.now() + 1000).toISOString(),
    },
  ]) {
    const provider = new DoubaoFileAsr(config, async () => {
      throw new Error("Unexpected network I/O");
    });
    await assert.rejects(provider.submit(id, bad), /source/i);
  }
  let calls = 0;
  const transportError = new DoubaoFileAsr(config, async () => {
    calls++;
    // The same error class after transport entry is not proof of non-submission.
    throw new AsrSourcePreflightError("synthetic external failure");
  });
  assert.deepEqual(await transportError.submit(id, source), {
    state: "unknown",
    code: null,
  });
  assert.equal(calls, 1);
});

test("DeepSeek returns one sourced optional question with provider usage, without mutating the transcript", async () => {
  const input = {
    clipId: id,
    transcript: "合成讲述：约在八十年代。",
    transcriptHash: "a".repeat(64),
  };
  const output = {
    action: "ask",
    question: "关于这段经历，您还想补充什么？",
    intent: "specific_detail",
    sourceRefs: [`transcript:${id}:${input.transcriptHash}`],
    reasonCode: "DETAIL_AVAILABLE",
  };
  let body: any;
  const provider = new DeepSeekText(
    { apiKey: "synthetic-key", model: "explicit-candidate", maxTokens: 1024 },
    async (url, init) => {
      assert.equal(String(url), "https://api.deepseek.com/chat/completions");
      body = JSON.parse(String(init?.body));
      return Response.json({
        model: "explicit-candidate",
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: JSON.stringify(output) },
          },
        ],
        usage: {
          prompt_tokens: 30,
          completion_tokens: 20,
          total_tokens: 50,
          prompt_cache_hit_tokens: 10,
          prompt_cache_miss_tokens: 20,
        },
      });
    },
  );
  const result = await provider.generate("question", input);
  assert.equal(result.state, "succeeded");
  assert.deepEqual(result.output, output);
  assert.deepEqual(result.usage, {
    prompt_tokens: 30,
    completion_tokens: 20,
    total_tokens: 50,
    prompt_cache_hit_tokens: 10,
    prompt_cache_miss_tokens: 20,
  });
  assert.deepEqual(
    JSON.parse(body.messages[1].content).sourceRefs,
    output.sourceRefs,
  );
  assert.equal(body.model, "explicit-candidate");
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(body.tools, undefined);
  assert.match(body.messages[0].content, /json/i);
  assert.equal(
    JSON.parse(body.messages[1].content).transcript,
    input.transcript,
  );
});

test("DeepSeek validates agreed sourceRefs contracts, completion boundaries, nulls and explicit no-content results", async () => {
  const input = {
    clipId: id,
    transcript: "合成：约在八十年代。也可能是九十年代。",
    transcriptHash: "a".repeat(64),
  };
  const ref = `transcript:${id}:${input.transcriptHash}`;
  const valid = {
    action: "ask",
    question: "您还想补充什么？",
    intent: "specific_detail",
    sourceRefs: [ref],
    reasonCode: "DETAIL_AVAILABLE",
  };
  async function generate(
    output: unknown,
    extra: any = {},
    kind: "question" | "story" = "question",
  ) {
    return new DeepSeekText(
      { apiKey: "synthetic", model: "candidate", maxTokens: 1024 },
      async () =>
        Response.json({
          model: "candidate",
          choices: [
            {
              finish_reason: "stop",
              message: { role: "assistant", content: JSON.stringify(output) },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
          ...extra,
        }),
    ).generate(kind, input);
  }
  for (const output of [
    null,
    {},
    { ...valid, question: null },
    { ...valid, question: "发生了什么？你后来怎么办？" },
    { ...valid, sourceRefs: ["transcript:other:unknown"] },
    { ...valid, sourceRefs: [] },
    { ...valid, sourceRefs: [ref, ref] },
    { ...valid, intent: null },
    { ...valid, reasonCode: "UNKNOWN" },
    { ...valid, unexpected: "field" },
    { ...valid, action: "finish", reasonCode: "DECLINED" },
    {
      action: "finish",
      question: null,
      intent: null,
      sourceRefs: [],
      reasonCode: "UNKNOWN",
    },
    {
      status: "ok",
      question: "还想补充什么？",
      sources: [
        {
          clipId: id,
          transcriptHash: input.transcriptHash,
          quote: "约在八十年代",
        },
      ],
    },
  ])
    assert.equal((await generate(output)).state, "failed");
  for (const reason of ["length", "content_filter", "tool_calls", "aborted"])
    assert.equal(
      (
        await generate(valid, {
          choices: [
            {
              finish_reason: reason,
              message: { role: "assistant", content: JSON.stringify(valid) },
            },
          ],
        })
      ).state,
      "failed",
    );
  assert.equal(
    (
      await generate(valid, {
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: " " },
          },
        ],
      })
    ).state,
    "failed",
  );
  assert.equal(
    (
      await generate(valid, {
        usage: { prompt_tokens: -1, completion_tokens: 20, total_tokens: 19 },
      })
    ).state,
    "failed",
  );
  for (const [intent, reasonCode] of [
    ["scene", "SCENE_AVAILABLE"],
    ["specific_detail", "DETAIL_AVAILABLE"],
    ["feeling", "FEELING_AVAILABLE"],
    ["meaning", "MEANING_AVAILABLE"],
  ])
    assert.equal(
      (await generate({ ...valid, intent, reasonCode })).state,
      "succeeded",
    );
  for (const [reasonCode, expected] of [
    ["DECLINED", "declined"],
    ["NOT_APPLICABLE", "not_applicable"],
    ["ENOUGH_DETAIL", "finished"],
    ["USER_FINISHED", "finished"],
  ]) {
    const output = {
      action: "finish",
      question: null,
      intent: null,
      sourceRefs: [],
      reasonCode,
    };
    const result = await generate(output);
    assert.equal(result.state, expected);
    assert.deepEqual(result.output, output);
    assert.equal(
      (await generate({ ...output, sourceRefs: [ref] })).state,
      "failed",
    );
  }
  const story = {
    title: "合成回忆",
    paragraphs: [
      { text: "我记得约在八十年代，也可能是九十年代。", sourceRefs: [ref] },
    ],
    theme: "年代不确定的合成回忆",
    reviewItems: ["年代有矛盾，待本人核对"],
  };
  const result = await generate(story, {}, "story");
  assert.equal(result.state, "succeeded");
  assert.deepEqual(result.output, story);
  const { theme: _theme, ...withoutTheme } = story;
  const { reviewItems: _reviewItems, ...withoutReviewItems } = story;
  for (const output of [
    withoutTheme,
    withoutReviewItems,
    { ...story, theme: null },
    { ...story, reviewItems: [null] },
    { ...story, paragraphs: [] },
    { ...story, paragraphs: [{ text: "合成", sourceRefs: [] }] },
    { ...story, paragraphs: [{ text: "合成", sourceRefs: ["unknown"] }] },
    { ...story, paragraphs: [{ text: "合成", sources: [ref] }] },
    { ...story, status: "ok" },
    { ...story, status: "declined" },
    {
      status: "ok",
      title: story.title,
      paragraphs: [
        {
          text: "合成",
          sources: [
            {
              clipId: id,
              transcriptHash: input.transcriptHash,
              quote: "约在八十年代",
            },
          ],
        },
      ],
      uncertainties: [],
    },
  ])
    assert.equal((await generate(output, {}, "story")).state, "failed");
  for (const status of ["declined", "not_applicable"]) {
    const output = {
      status,
      title: null,
      paragraphs: [],
      theme: null,
      reviewItems: [],
    };
    assert.equal((await generate(output, {}, "story")).state, status);
    assert.equal(
      (await generate({ ...output, reviewItems: ["仍输出内容"] }, {}, "story"))
        .state,
      "failed",
    );
  }
});

test("provider response bodies are bounded and transport failures remain unknown without secret error text", async () => {
  const provider = new DoubaoFileAsr(config, async () =>
    Response.json(
      { result: { text: "x".repeat(1048577) } },
      { headers: { "X-Api-Status-Code": "20000000" } },
    ),
  );
  assert.equal((await provider.query(id)).state, "unknown");
  const deepseek = new DeepSeekText(
    { apiKey: "synthetic", model: "candidate", maxTokens: 100 },
    async () => {
      throw new Error("secret-url?key=secret");
    },
  );
  assert.deepEqual(
    await deepseek.generate("story", {
      clipId: id,
      transcript: "合成",
      transcriptHash: "a".repeat(64),
    }),
    { state: "unknown", failure: "transport_or_response_unknown" },
  );
});

test("ASR accepts explicit static signing without a fabricated credential expiry but keeps URL window checks", async () => {
  let calls = 0;
  const provider = new DoubaoFileAsr(config, async () => {
    calls++;
    return new Response(null, { headers: { "X-Api-Status-Code": "20000000" } });
  });
  assert.equal(
    (
      await provider.submit(id, {
        ...source,
        credentialMode: "static",
        credentialsExpireAt: null,
      })
    ).state,
    "accepted",
  );
  assert.equal(calls, 1);
  for (const invalid of [
    { ...source, credentialsExpireAt: null },
    { ...source, credentialMode: "unknown" },
    {
      ...source,
      credentialMode: "static",
      credentialsExpireAt: source.credentialsExpireAt,
    },
    {
      ...source,
      credentialMode: "static",
      credentialsExpireAt: null,
      expiresAt: new Date(Date.now() + 1000).toISOString(),
    },
  ])
    await assert.rejects(
      provider.submit(id, invalid as Parameters<DoubaoFileAsr["submit"]>[1]),
      /source/i,
    );
  assert.equal(calls, 1);
});

test("DeepSeek relay preserves its base path and never falls back to another endpoint", async () => {
  const input = {
    clipId: id,
    transcript: "合成讲述",
    transcriptHash: "a".repeat(64),
  };
  for (const baseUrl of [
    "https://cf.api.fan/v1",
    "https://cf.api.fan/v1/",
    "https://relay.synthetic/gateway/openai/v1/",
  ]) {
    const calls: string[] = [];
    const provider = new DeepSeekText(
      {
        apiKey: "synthetic-relay-key",
        model: "synthetic-model",
        maxTokens: 1024,
        baseUrl,
      },
      async (url, init) => {
        calls.push(String(url));
        assert.equal(
          new Headers(init?.headers).get("Authorization"),
          "Bearer synthetic-relay-key",
        );
        return new Response(null, { status: 401 });
      },
    );
    assert.deepEqual(await provider.generate("story", input), {
      state: "unknown",
      failure: "http_error",
    });
    assert.deepEqual(calls, [
      baseUrl.replace(/\/+$/, "") + "/chat/completions",
    ]);
  }
  for (const baseUrl of [
    "http://relay.synthetic/v1",
    "https://user:secret@relay.synthetic/v1",
    "https://relay.synthetic/v1?secret=key",
    "https://relay.synthetic/v1/chat/completions",
  ])
    assert.throws(
      () =>
        new DeepSeekText({
          apiKey: "synthetic",
          model: "synthetic",
          maxTokens: 1024,
          baseUrl,
        }),
    );
});
