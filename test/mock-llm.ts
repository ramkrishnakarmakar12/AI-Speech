/**
 * Mock LLM server speaking both Ollama (/api/chat, /api/tags) and OpenAI (/v1/chat/completions, /v1/models).
 * Returns a canned answer so the pipeline plumbing can be tested without a real model.
 * It records the last request body to test/.last-request.json for inspection.
 */
import http from "node:http";
import fs from "node:fs";

const answer = {
  patient: { name: "Ramesh Kumar", age: "64", sex: "M" },
  chief_complaints: [{ complaint: "Diminution of vision", kb_id: "SYM-001", eye: "RE", duration: "1 year", character: "gradual, painless", patient_words: "right eye se dhundhla dikhta hai" }],
  history: { systemic: [{ condition: "Diabetes mellitus", kb_id: "ABR-005", duration: "10 years", treatment: "oral tablets" }, { condition: "Hypertension", kb_id: "", duration: "", treatment: "amlodipine" }], ocular: [], current_medications: ["amlodipine"], allergies: [] },
  examination: [{ test: "Visual acuity", kb_id: "TST-001", eye: "RE", result: "6/36, 6/18 with PH" }],
  clinical_findings: [],
  diagnosis: [{ condition: "Nuclear cataract", kb_id: "DIS-002", eye: "RE", grade_or_notes: "NS3", certainty: "confirmed" }, { condition: "NPDR mild", kb_id: "MED-001", eye: "BE", grade_or_notes: "no DME", certainty: "confirmed" }],
  medications: [
    { kb_id: "", generic_name: "", brand_said: "Moxicip", form: "E/D", strength: "", eye: "RE", dose: "1 drop", frequency: "QID", duration: "3 days", phase: "pre-op", instructions: "" },
    { kb_id: "MED-028", generic_name: "Nepafenac", brand_said: "", form: "E/D", strength: "", eye: "RE", dose: "1 drop", frequency: "TID", duration: "4 weeks", phase: "post-op", instructions: "" },
    { kb_id: "", generic_name: "Timolol", brand_said: "", form: "E/D", strength: "", eye: "", dose: "", frequency: "", duration: "", phase: "", instructions: "" }
  ],
  procedures: [{ procedure: "Phaco with PCIOL", kb_id: "", eye: "RE", notes: "topical, day care" }],
  investigations: [{ test: "Biometry", kb_id: "TST-037", eye: "RE", purpose: "IOL power" }],
  glasses: [],
  advice: [{ text: "Keep a 5-minute gap between two different eye drops.", kb_id: "CNS-003" }],
  follow_up: [{ when: "POD 1, 1 week, 1 month", purpose: "post-op review" }],
  terms: [{ heard: "motiyabind", kb_id: "DIS-001", canonical: "x", category: "disease" }, { heard: "bogus", kb_id: "ZZZ-999", canonical: "bogus", category: "?" }]
};
const content = JSON.stringify(answer);

http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    if (body) fs.writeFileSync(new URL("./.last-request.json", import.meta.url), body);
    const json = (o: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.url === "/api/tags") return json({ models: [{ name: "qwen3:8b" }] });
    if (req.url === "/v1/models") return json({ data: [{ id: "text-embedding-nomic" }, { id: "qwen3-8b" }] });
    if (req.url === "/api/v0/models")
      return json({ data: [
        { id: "text-embedding-nomic", type: "embeddings", state: "not-loaded" },
        { id: "gemma-4-e4b", type: "llm", state: "not-loaded" },
        { id: "qwen3-8b", type: "llm", state: "loaded", loaded_context_length: Number(process.env.MOCK_CTX ?? 16384) },
      ] });
    if (req.url === "/api/chat") {
      const b = JSON.parse(body);
      if (b.think !== undefined && process.env.MOCK_NO_THINK) { res.writeHead(400); return res.end(JSON.stringify({ error: `"${b.model}" does not support thinking` })); }
      if (b.model === "missing:1b") { res.writeHead(404); return res.end(JSON.stringify({ error: `model "${b.model}" not found, try pulling it first` })); }
      if (!b.stream) return json({ model: b.model, message: { role: "assistant", content }, prompt_eval_count: 1234, eval_count: 456 });
      // stream NDJSON in small pieces, like Ollama
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      const pieces = content.match(/.{1,40}/gs) ?? [];
      let i = 0;
      const tick = () => {
        if (i < pieces.length) { res.write(JSON.stringify({ model: b.model, message: { role: "assistant", content: pieces[i++] }, done: false }) + "\n"); setTimeout(tick, 2); }
        else { res.end(JSON.stringify({ model: b.model, message: { role: "assistant", content: "" }, done: true, prompt_eval_count: 1234, eval_count: pieces.length }) + "\n"); }
      };
      return tick();
    }
    if (req.url === "/v1/chat/completions" && process.env.MOCK_CTX && Number(process.env.MOCK_CTX) < 8000) {
      res.writeHead(400); return res.end(JSON.stringify({ error: "Trying to keep the first 5321 tokens when context the overflows. However, the model is loaded with context length of only 4096 tokens" }));
    }
    if (req.url === "/v1/chat/completions" && JSON.parse(body).stream && process.env.MOCK_MODE) {
      // misbehaving models: "loop" repeats the same terms[] item forever, "think" reasons forever
      res.writeHead(200, { "content-type": "text/event-stream" });
      const head = content.slice(0, content.indexOf('"terms":[') + 9);
      const item = '{"heard":"motiyabind","kb_id":"DIS-001","canonical":"Age-related cataract","category":"disease"},';
      let i = 0;
      const send = (delta: object) => res.write(`data: ${JSON.stringify({ model: "qwen/qwen3-vl-4b", choices: [{ delta }] })}\n\n`);
      if (process.env.MOCK_MODE === "loop") send({ content: head });
      const t = setInterval(() => {
        if (res.destroyed || i++ > 100000) return clearInterval(t);
        if (process.env.MOCK_MODE === "loop") send({ content: item });
        else send({ reasoning_content: "Let me think about the dosage again. " });
      }, 1);
      res.on("close", () => clearInterval(t));
      return;
    }
    if (req.url === "/v1/chat/completions" && JSON.parse(body).stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const full = "<think>\n</think>\n" + content;
      for (const p of full.match(/.{1,50}/gs) ?? []) res.write(`data: ${JSON.stringify({ model: "qwen3-8b", choices: [{ delta: { content: p } }] })}\n\n`);
      return res.end("data: [DONE]\n\n");
    }
    if (req.url === "/v1/chat/completions") return json({ model: "qwen3-8b", choices: [{ message: { content: "<think>\n</think>\n```json\n" + content + "\n```" } }], usage: { prompt_tokens: 1, completion_tokens: 2 } });
    res.writeHead(404); res.end();
  });
}).listen(Number(process.env.MOCK_PORT ?? 11999), () => console.log("mock llm up"));
