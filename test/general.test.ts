import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { accuracy, changeRatio, normalizeNative } from "../src/general/metrics.js";

test("general: normalisation ignores punctuation, digit script and zero-width joiners", () => {
  assert.equal(normalizeNative("দূরের দৃষ্টি ৬/৬। ঠিক আছে?"), "দূরের দৃষ্টি 6/6 ঠিক আছে");
  assert.equal(normalizeNative("प्लस १.५० ऐड"), "प्लस 1.50 ऐड");
  assert.equal(normalizeNative("Hello, World!"), "hello world");
  assert.equal(normalizeNative("র‍্যাব"), normalizeNative("র্যাব"));
});

test("general: perfect transcript = 0 errors; speaker labels in the reference are ignored", () => {
  const r = accuracy("আমার নাম গোপাল মণ্ডল", "রোগী: আমার নাম গোপাল মণ্ডল।");
  assert.equal(r.wer, 0);
  assert.equal(r.cer, 0);
  assert.equal(r.wordAccuracy, 1);
});

test("general: substitutions, deletions and insertions are counted and aligned", () => {
  // reference 6 words; hyp: 1 substitution (কাছের→চাষ), 1 deletion (না), 1 insertion (আর)
  const r = accuracy("ছয় মাস ধরে চাষ জিনিস পারছি আর", "ছয় মাস ধরে কাছের জিনিস পারছি না");
  assert.equal(r.refWords, 7);
  assert.equal(r.substitutions + r.deletions + r.insertions >= 2, true);
  assert.ok(r.wer > 0.2 && r.wer < 0.5, `wer ${r.wer}`);
  assert.deepEqual(r.topErrors[0], { ref: "কাছের", hyp: "চাষ", count: 1 });
  assert.ok(r.alignment.some((a) => a.op === "sub" && a.ref === "কাছের" && a.hyp === "চাষ"));
});

test("general: coverage exposes skipped audio", () => {
  const ref = "এক দুই তিন চার পাঁচ ছয় সাত আট নয় দশ";
  const r = accuracy("এক দুই তিন", ref);
  assert.ok(r.coverage < 0.4);
  assert.equal(r.deletions, 7);
});

test("general: changeRatio flags an LLM rewrite", () => {
  assert.equal(changeRatio("আমার নাম গোপাল", "আমার নাম গোপাল"), 0);
  assert.ok(changeRatio("আমার নাম গোপাল", "My name is Gopal") > 0.9);
});

test("general: LLM review — correction used, estimate returned, rewrite rejected", async () => {
  let reply: any = {};
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      if (req.url?.endsWith("/models")) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ data: [{ id: "test-llm", type: "llm", state: "loaded" }] })); }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ model: "test-llm", choices: [{ delta: { content: JSON.stringify(reply) } }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as any).port;
  process.env.LLM_PROVIDER = "lmstudio";
  process.env.LLM_BASE_URL = `http://127.0.0.1:${port}/v1`;
  process.env.LLM_MODEL = "test-llm";
  const { config } = await import("../src/config.js");
  config.llm.provider = "lmstudio" as any;
  config.llm.baseUrl = `http://127.0.0.1:${port}/v1`;
  config.llm.model = "test-llm";
  const { evaluateTranscript } = await import("../src/general/run.js");
  try {
    const raw = "ছয় মাস ধরে চাষ জিনিস পড়তে পারছি না";
    reply = { language: "bn", corrected_text: "ছয় মাস ধরে কাছের জিনিস পড়তে পারছি না", estimated_accuracy: 80, quality: "medium", issues: [{ text: "চাষ", type: "misheard_word", suggestion: "কাছের" }], summary: "One misheard word." };
    const r = await evaluateTranscript(raw, { language: "bn", reference: "ছয় মাস ধরে কাছের জিনিস পড়তে পারছি না" });
    assert.equal(r.llm?.estimatedAccuracy, 80);
    assert.equal(r.llm?.correctionUsed, true);
    assert.ok(r.measured!.corrected!.wer < r.measured!.raw.wer);
    assert.equal(r.measured!.llmHelped, true);
    assert.equal(r.accuracy.source, "measured (raw ASR)");

    reply = { ...reply, corrected_text: "For six months I cannot read things up close." };
    const r2 = await evaluateTranscript(raw, { language: "bn" });
    assert.equal(r2.llm?.correctionUsed, false);
    assert.ok(r2.llm?.warnings.some((w) => w.includes("rewrite")));
    assert.equal(r2.accuracy.source, "LLM estimate");
    assert.equal(r2.accuracy.value, 0.8);
  } finally {
    srv.close();
  }
});
