#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { config, llmBaseUrl, ROOT, type AsrBackend } from "./config.js";
import { buildAndSave, loadKb } from "./kb/build-kb.js";
import { findMatches } from "./match/matcher.js";
import { transcribe } from "./asr/index.js";
import { extractFromTranscript, runFromAudio, type ExtractionResult } from "./pipeline.js";
import { renderMarkdown } from "./render.js";
import { listModels, resolveModel } from "./llm/client.js";

const [cmd, ...rest] = process.argv.slice(2);
const flags: Record<string, string> = {};
const args: string[] = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith("--")) flags[rest[i].slice(2)] = rest[i + 1]?.startsWith("--") || rest[i + 1] === undefined ? "true" : rest[++i];
  else args.push(rest[i]);
}
if (flags.backend) config.asr.backend = flags.backend as AsrBackend;
if (flags.model) config.llm.model = flags.model;
if (flags.provider) config.llm.provider = flags.provider as any;

function save(base: string, r: ExtractionResult) {
  fs.mkdirSync(config.paths.outDir, { recursive: true });
  const stem = path.join(config.paths.outDir, path.basename(base).replace(/\.[^.]+$/, ""));
  fs.writeFileSync(`${stem}.rx.json`, JSON.stringify(r, null, 2));
  const md = renderMarkdown(r);
  fs.writeFileSync(`${stem}.rx.md`, md);
  console.log(md);
  console.log(`\n✔ saved ${path.relative(ROOT, stem)}.rx.json and .rx.md`);
}

const usage = `
Usage:
  npm run build-kb                               Convert the xlsx into data/kb.json + data/hotwords.txt
  npm run check                                  Check KB, LLM server/model and ASR backend
  npm run match -- <transcript.txt>              Show KB terms detected (no LLM)
  npm run transcribe -- <audio> [--lang auto|en|hi|bn] [--backend whisper-cli|whisper-server|openai|qwen3-mlx]
  npm run extract -- <transcript.txt> [--lang hi] [--english translation.txt] [--model qwen3:8b] [--provider ollama|lmstudio]
  npm run run -- <audio> [--lang auto|en|hi|bn] [--transcript file.txt]   Audio (+ optional transcript) → prescription draft
  npm run serve                                  Web UI on http://localhost:${config.server.port}
`;

async function main() {
  switch (cmd) {
    case "build-kb": {
      const kb = await buildAndSave();
      console.log(`✔ ${kb.terms.length} terms, ${kb.scenarios.length} scenarios →`, path.relative(ROOT, config.paths.kb));
      console.table(kb.counts);
      return;
    }
    case "match": {
      if (!args[0]) throw new Error("Give a transcript file");
      const m = findMatches(fs.readFileSync(args[0], "utf8"), loadKb());
      console.table(m.map((x) => ({ id: x.term.id, category: x.term.category, term: x.term.name.slice(0, 45), heard: x.heardAs.slice(0, 40), kind: x.kind, score: +x.score.toFixed(2) })));
      return;
    }
    case "transcribe": {
      if (!args[0]) throw new Error("Give an audio file");
      const t = await transcribe(args[0], { language: flags.lang });
      fs.mkdirSync(config.paths.outDir, { recursive: true });
      const out = path.join(config.paths.outDir, path.basename(args[0]).replace(/\.[^.]+$/, "") + ".transcript.txt");
      fs.writeFileSync(out, t.text);
      console.log(t.text);
      if (t.english) {
        fs.writeFileSync(out.replace(/\.transcript\.txt$/, ".english.txt"), t.english);
        console.log("\n--- English translation ---\n" + t.english);
      }
      console.log(`\n✔ ${t.backend} (${t.language ?? "?"}) in ${(t.ms / 1000).toFixed(1)} s → ${path.relative(ROOT, out)}`);
      return;
    }
    case "extract": {
      if (!args[0]) throw new Error("Give a transcript file");
      const en = flags.english ? fs.readFileSync(flags.english, "utf8") : undefined;
      save(args[0], await extractFromTranscript(fs.readFileSync(args[0], "utf8"), { english: en, language: flags.lang }));
      return;
    }
    case "run": {
      if (!args[0]) throw new Error("Give an audio file");
      const tr = flags.transcript ? fs.readFileSync(flags.transcript, "utf8") : undefined;
      save(args[0], await runFromAudio(args[0], tr, flags.lang));
      return;
    }
    case "check": {
      try {
        const kb = loadKb();
        console.log(`✔ KB: ${kb.terms.length} terms (built ${kb.builtAt})`);
      } catch (e: any) {
        console.log(`✘ KB: ${e.message}`);
      }
      try {
        const models = await listModels();
        console.log(`✔ LLM server ${config.llm.provider} @ ${llmBaseUrl()} — ${models.length} models`);
        for (const m of models) console.log(`    · ${m}`);
        if (config.llm.provider !== "ollama" && (!config.llm.model || config.llm.model === "auto")) {
          console.log(`✔ LLM_MODEL=auto → will use "${await resolveModel()}"`);
        } else {
          const has = models.some((m) => m === config.llm.model || m.startsWith(config.llm.model));
          console.log(has ? `✔ model "${config.llm.model}" available` : `✘ model "${config.llm.model}" not found — pick one from the list above (or LLM_MODEL=auto for LM Studio)`);
        }
      } catch (e: any) {
        console.log(`✘ LLM server ${config.llm.provider} @ ${llmBaseUrl()} not reachable (${e?.cause?.code ?? e.message})`);
      }
      const b = config.asr.backend;
      const which = (c: string) => spawnSync(process.platform === "win32" ? "where" : "which", [c]).status === 0;
      if (b === "indic") {
        const py = (mod: string) => spawnSync(config.asr.python, ["-c", `import ${mod}`]).status === 0;
        const needConformer = Object.values(config.asr.indicModels).some((m) => /conformer/i.test(m));
        const miss = ["transformers", "torch", "numpy", ...(needConformer ? ["onnxruntime", "torchaudio"] : [])].filter((m) => !py(m));
        console.log(miss.length ? `✘ ASR indic: missing Python packages: ${miss.join(", ")} → ${config.asr.python} -m pip install -U ${miss.join(" ")}` : "✔ ASR indic: Python packages installed");
        for (const [l, m] of Object.entries(config.asr.indicModels)) console.log(`    · ${l} → ${m}${/conformer/i.test(m) ? " (gated: accept terms on Hugging Face + `hf auth login`)" : ""}`);
        console.log(fs.existsSync(config.asr.whisperModel) ? `✔ Whisper model (English + auto-detect + translation)` : `⚠ Whisper model missing: English audio, auto-detect and the English translation won't work`);
      } else if (b === "qwen3-mlx") {
        const ok = spawnSync(config.asr.python, ["-c", "import mlx_qwen3_asr"]).status === 0;
        console.log(ok ? `✔ ASR qwen3-mlx (${config.asr.qwen3Model})` : `✘ ASR qwen3-mlx: run  ${config.asr.python} -m pip install -U mlx-qwen3-asr`);
      } else if (b === "whisper-cli") {
        console.log(which(config.asr.whisperCli) ? `✔ ${config.asr.whisperCli} found` : `✘ ${config.asr.whisperCli} not found (brew install whisper-cpp)`);
        console.log(fs.existsSync(config.asr.whisperModel) ? `✔ model ${config.asr.whisperModel}` : `✘ model missing: ${config.asr.whisperModel}`);
      } else if (b === "whisper-server" || b === "openai") {
        const url = b === "openai" ? config.asr.openaiBaseUrl : config.asr.whisperServerUrl;
        const ok = await fetch(url).then(() => true, () => false);
        console.log(ok ? `✔ ASR server reachable ${url}` : `✘ ASR server not reachable ${url}`);
      }
      console.log(which(config.asr.ffmpeg) ? "✔ ffmpeg found" : "✘ ffmpeg not found (brew install ffmpeg) — needed for whisper-cli and non-WAV audio");
      return;
    }
    default:
      console.log(usage);
  }
}

main().catch((e) => {
  console.error("✘", e.message);
  process.exit(1);
});
