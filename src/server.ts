/** Tiny local web UI + JSON API.  npm run serve  →  http://localhost:5055 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config, llmBaseUrl, ROOT } from "./config.js";
import { loadKb } from "./kb/build-kb.js";
import { findMatches } from "./match/matcher.js";
import { analyzeTranscript, asrSignals, extractFromTranscript, runFromAudio } from "./pipeline.js";
import type { AsrSignals } from "./quality/accuracy.js";
import { renderMarkdown } from "./render.js";
import { transcribe } from "./asr/index.js";
import { resolveModel } from "./llm/client.js";
import { evaluateAudio, evaluateTranscript } from "./general/run.js";
import { renderGeneral } from "./general/render.js";
import { loadApproved, saveApproved } from "./domain/examples.js";

const page = fs.readFileSync(path.join(ROOT, "src/web/index.html"), "utf8");
const generalPage = () => fs.readFileSync(path.join(ROOT, "src/web/general.html"), "utf8");

function send(res: http.ServerResponse, code: number, body: unknown, type = "application/json") {
  res.writeHead(code, { "content-type": type });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

async function readForm(req: http.IncomingMessage): Promise<FormData> {
  const request = new Request(`http://x${req.url}`, {
    method: req.method,
    headers: req.headers as Record<string, string>,
    body: req as any,
    duplex: "half",
  } as RequestInit);
  return request.formData();
}

async function fieldText(v: FormDataEntryValue | null): Promise<string> {
  if (!v) return "";
  return typeof v === "string" ? v : await v.text();
}

/** ASR signals the UI got from /api/transcribe; only sent back while the transcript is unedited */
async function asrField(v: FormDataEntryValue | null): Promise<AsrSignals | undefined> {
  const t = await fieldText(v);
  if (!t) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

async function saveUpload(f: FormDataEntryValue | null): Promise<string | null> {
  if (!f || typeof f === "string" || f.size === 0) return null;
  const ext = path.extname(f.name || "") || ".webm";
  const p = path.join(os.tmpdir(), `upload-${Date.now()}${ext}`);
  fs.writeFileSync(p, Buffer.from(await f.arrayBuffer()));
  return p;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) return send(res, 200, page, "text/html; charset=utf-8");
    if (req.method === "GET" && req.url === "/api/config")
      return send(res, 200, {
        modelEnv: config.modelEnv,
        asr: config.asr.backend,
        asrModels: config.asr.backend === "indic" ? config.asr.indicModels : undefined,
        llm: { provider: config.llm.provider, model: await resolveModel().catch(() => config.llm.model), url: llmBaseUrl() },
        kbTerms: loadKb().terms.length,
        approved: loadApproved().length,
      });

    // Doctor approves a (possibly edited) prescription → few-shot example now, fine-tuning data later
    if (req.method === "POST" && req.url === "/api/approve") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const b = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      if (!b.transcript?.trim() || !b.prescription) return send(res, 400, { error: "transcript and prescription are required" });
      const ids = new Set<string>();
      const walk = (v: any) => {
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) k === "kb_id" && typeof x === "string" && x ? ids.add(x) : walk(x);
      };
      walk(b.prescription);
      const ex = saveApproved({ language: b.language || "", transcript: b.transcript, english: b.english || undefined, prescription: b.prescription, termIds: [...ids], doctor: b.doctor || undefined });
      return send(res, 200, { id: ex.id, approved: loadApproved().length });
    }

    // General (any topic) transcription accuracy — ASR → Qwen3 review → WER/CER vs an optional reference
    if (req.method === "GET" && (req.url === "/general" || req.url === "/general.html")) return send(res, 200, generalPage(), "text/html; charset=utf-8");
    if (req.method === "POST" && req.url === "/api/general") {
      const form = await readForm(req);
      const audio = await saveUpload(form.get("audio"));
      const transcript = (await fieldText(form.get("transcript"))).trim();
      try {
        if (!audio && !transcript) return send(res, 400, { error: "Upload audio or paste a transcript" });
        const lang = (await fieldText(form.get("language"))) || undefined;
        const opts = {
          name: (form.get("audio") as File | null)?.name || "pasted transcript",
          language: lang === "auto" ? undefined : lang,
          reference: (await fieldText(form.get("reference"))).trim() || undefined,
          context: (await fieldText(form.get("context"))).trim() || undefined,
          useLlm: (await fieldText(form.get("useLlm"))) !== "false",
        };
        const r = audio ? await evaluateAudio(audio, opts) : await evaluateTranscript(transcript, opts);
        const md = renderGeneral(r);
        const dir = path.join(ROOT, "evaluation", "general", "web");
        fs.mkdirSync(dir, { recursive: true });
        const stem = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${opts.name.replace(/[^\w.-]+/g, "_").replace(/\.[^.]+$/, "")}`);
        fs.writeFileSync(`${stem}.json`, JSON.stringify(r, null, 2));
        fs.writeFileSync(`${stem}.md`, md);
        return send(res, 200, { ...r, markdown: md, savedAs: path.relative(ROOT, stem) });
      } finally {
        if (audio) fs.rmSync(audio, { force: true });
      }
    }

    if (req.method === "POST" && req.url === "/api/match") {
      const form = await readForm(req);
      const m = findMatches(await fieldText(form.get("transcript")), loadKb());
      return send(res, 200, m.map((x) => ({ id: x.term.id, name: x.term.name, category: x.term.category, heardAs: x.heardAs, score: x.score })));
    }

    // Stages 1–3 without the LLM: accuracy → general keywords → medical terms
    if (req.method === "POST" && req.url === "/api/analyze") {
      const form = await readForm(req);
      const transcript = await fieldText(form.get("transcript"));
      const language = (await fieldText(form.get("language"))) || undefined;
      const { matches: _m, ...a } = analyzeTranscript(transcript, {
        english: (await fieldText(form.get("english"))).trim() || undefined,
        language: language === "auto" ? undefined : language,
        asr: await asrField(form.get("asr")),
        reference: (await fieldText(form.get("reference"))).trim() || undefined,
      });
      return send(res, 200, a);
    }

    if (req.method === "POST" && req.url === "/api/transcribe") {
      const form = await readForm(req);
      const audio = await saveUpload(form.get("audio"));
      if (!audio) return send(res, 400, { error: "no audio" });
      try {
        const t = await transcribe(audio, { language: await fieldText(form.get("language")) });
        const signals = asrSignals(t);
        const { matches: _m, ...analysis } = analyzeTranscript(t.text, {
          english: t.english,
          language: t.language,
          asr: signals,
          reference: (await fieldText(form.get("reference"))).trim() || undefined,
        });
        const { words: _w, ...rest } = t;
        return send(res, 200, { ...rest, signals, analysis });
      } finally {
        fs.rmSync(audio, { force: true });
      }
    }

    if (req.method === "POST" && req.url === "/api/process") {
      const form = await readForm(req);
      const transcript = (await fieldText(form.get("transcript"))).trim();
      const audio = await saveUpload(form.get("audio"));
      try {
        if (!audio && !transcript) return send(res, 400, { error: "Provide audio and/or transcript" });
        const language = (await fieldText(form.get("language"))) || undefined;
        const english = (await fieldText(form.get("english"))).trim() || undefined;
        const reference = (await fieldText(form.get("reference"))).trim() || undefined;
        const force = (await fieldText(form.get("force"))) === "true";
        const r =
          audio && !transcript
            ? await runFromAudio(audio, undefined, language, { reference, force })
            : await extractFromTranscript(transcript, {
                english,
                language: language === "auto" ? undefined : language,
                asr: await asrField(form.get("asr")),
                reference,
                force,
              });
        fs.mkdirSync(config.paths.outDir, { recursive: true });
        const stem = path.join(config.paths.outDir, `web-${new Date().toISOString().replace(/[:.]/g, "-")}`);
        const md = renderMarkdown(r);
        fs.writeFileSync(`${stem}.rx.json`, JSON.stringify(r, null, 2));
        fs.writeFileSync(`${stem}.rx.md`, md);
        return send(res, 200, { ...r, markdown: md });
      } finally {
        if (audio) fs.rmSync(audio, { force: true });
      }
    }
    send(res, 404, { error: "not found" });
  } catch (e: any) {
    console.error(e);
    send(res, 500, { error: e.message });
  }
});

server.listen(config.server.port, () => {
  console.log(`▶ http://localhost:${config.server.port}  ·  general accuracy: http://localhost:${config.server.port}/general   (ASR: ${config.asr.backend}, LLM: ${config.llm.provider}/${config.llm.model})`);
});
