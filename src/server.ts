/** Tiny local web UI + JSON API.  npm run serve  →  http://localhost:5055 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config, llmBaseUrl, ROOT } from "./config.js";
import { loadKb } from "./kb/build-kb.js";
import { findMatches } from "./match/matcher.js";
import { extractFromTranscript, runFromAudio } from "./pipeline.js";
import { renderMarkdown } from "./render.js";
import { transcribe } from "./asr/index.js";
import { resolveModel } from "./llm/client.js";

const page = fs.readFileSync(path.join(ROOT, "src/web/index.html"), "utf8");

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
      return send(res, 200, { asr: config.asr.backend, llm: { provider: config.llm.provider, model: await resolveModel().catch(() => config.llm.model), url: llmBaseUrl() }, kbTerms: loadKb().terms.length });

    if (req.method === "POST" && req.url === "/api/match") {
      const form = await readForm(req);
      const m = findMatches(await fieldText(form.get("transcript")), loadKb());
      return send(res, 200, m.map((x) => ({ id: x.term.id, name: x.term.name, category: x.term.category, heardAs: x.heardAs, score: x.score })));
    }

    if (req.method === "POST" && req.url === "/api/transcribe") {
      const form = await readForm(req);
      const audio = await saveUpload(form.get("audio"));
      if (!audio) return send(res, 400, { error: "no audio" });
      try {
        return send(res, 200, await transcribe(audio, { language: await fieldText(form.get("language")) }));
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
        const r =
          audio && !transcript
            ? await runFromAudio(audio, undefined, language)
            : await extractFromTranscript(transcript, { english, language: language === "auto" ? undefined : language });
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
  console.log(`▶ http://localhost:${config.server.port}   (ASR: ${config.asr.backend}, LLM: ${config.llm.provider}/${config.llm.model})`);
});
