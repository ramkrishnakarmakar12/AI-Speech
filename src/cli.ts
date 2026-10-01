#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { config, llmBaseUrl, ROOT, type AsrBackend } from "./config.js";
import { buildAndSave, loadKb } from "./kb/build-kb.js";
import { findMatches } from "./match/matcher.js";
import { transcribe } from "./asr/index.js";
import { analyzeTranscript, asrSignals, extractFromTranscript, runFromAudio, type Analysis, type ExtractionResult } from "./pipeline.js";
import { renderMarkdown, renderQuality } from "./render.js";
import { listModels, resolveModel } from "./llm/client.js";
import { evaluateAudio, evaluateTranscript, describeSetup, type GeneralResult } from "./general/run.js";
import { csvHeader, csvRow, renderBatch, renderGeneral } from "./general/render.js";
import { exportTraining } from "./domain/training.js";

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

const AUDIO_EXT = /\.(wav|mp3|m4a|aac|ogg|opus|webm|flac|mp4|mov|caf|amr)$/i;
const readOpt = (f?: string) => (f && f !== "true" ? fs.readFileSync(f, "utf8") : undefined);

function printAnalysis(a: Analysis) {
  console.log(renderQuality(a));
  console.table(
    a.detectedTerms.map((x) => ({ id: x.id, category: x.category, term: x.name.slice(0, 40), heard: x.heardAs.slice(0, 36), kind: x.kind, score: x.score, unsure: x.uncertain ? "⚠" : "" })),
  );
}

const usage = `
Usage:
  npm run build-kb                               Convert the xlsx into data/kb.json + data/hotwords.txt
  npm run check                                  Check KB, LLM server/model and ASR backend
  npm run analyze -- <transcript.txt | audio> [--lang en|hi|bn] [--english en.txt] [--reference script.txt]
                                                 Stages 1–3 without the LLM: transcription accuracy → general keywords → medical terms
  npm run match -- <transcript.txt>              Show KB terms detected (no LLM)
  npm run transcribe -- <audio> [--lang auto|en|hi|bn] [--backend whisper-cli|whisper-server|openai|qwen3-mlx]
  npm run extract -- <transcript.txt> [--lang hi] [--english translation.txt] [--reference script.txt] [--force] [--model qwen3:8b] [--provider ollama|lmstudio]
  npm run run -- <audio> [--lang auto|en|hi|bn] [--transcript file.txt] [--reference script.txt] [--force]   Audio (+ optional transcript) → prescription draft
      --reference  known script of the recording → measured WER/CER instead of the estimate
      --force      generate a prescription even when the transcript is rated "unusable"
  npm run general -- <audio | transcript.txt | folder> [--lang bn|hi|en] [--ref reference.txt] [--context "topic"] [--no-llm]
                                                 General (any topic) transcription accuracy: ASR → Qwen3 review → WER/CER vs reference.
                                                 Folder: every audio file; its reference is <same name>.txt or <same name>.ref.txt
  npm run export-training                        Doctor-approved prescriptions → data/training/*.jsonl (LoRA fine-tuning)
  npm run serve                                  Web UI on http://localhost:${config.server.port}  (general accuracy page: /general)
`;

async function main() {
  switch (cmd) {
    case "build-kb": {
      const kb = await buildAndSave();
      console.log(`✔ ${kb.terms.length} terms, ${kb.scenarios.length} scenarios →`, path.relative(ROOT, config.paths.kb));
      console.table(kb.counts);
      return;
    }
    case "analyze": {
      if (!args[0]) throw new Error("Give a transcript file or an audio file");
      let text: string;
      let english = readOpt(flags.english);
      let language: string | undefined = flags.lang;
      let asr;
      if (AUDIO_EXT.test(args[0])) {
        const t = await transcribe(args[0], { language: flags.lang });
        console.log(t.text + (t.english ? "\n\n--- English translation ---\n" + t.english : "") + "\n");
        text = t.text;
        english = t.english;
        language = t.language ?? undefined;
        asr = asrSignals(t);
      } else text = fs.readFileSync(args[0], "utf8");
      const a = analyzeTranscript(text, { english, language, asr, reference: readOpt(flags.reference) });
      printAnalysis(a);
      fs.mkdirSync(config.paths.outDir, { recursive: true });
      const out = path.join(config.paths.outDir, path.basename(args[0]).replace(/\.[^.]+$/, "") + ".analysis.json");
      const { matches: _m, ...json } = a;
      fs.writeFileSync(out, JSON.stringify({ transcript: text, english, ...json }, null, 2));
      console.log(`\n✔ saved ${path.relative(ROOT, out)}`);
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
      const a = analyzeTranscript(t.text, { english: t.english, language: t.language, asr: asrSignals(t), reference: readOpt(flags.reference) });
      console.log("\n" + renderQuality(a));
      return;
    }
    case "extract": {
      if (!args[0]) throw new Error("Give a transcript file");
      const en = flags.english ? fs.readFileSync(flags.english, "utf8") : undefined;
      save(args[0], await extractFromTranscript(fs.readFileSync(args[0], "utf8"), { english: en, language: flags.lang, reference: readOpt(flags.reference), force: flags.force === "true" }));
      return;
    }
    case "run": {
      if (!args[0]) throw new Error("Give an audio file");
      const tr = flags.transcript ? fs.readFileSync(flags.transcript, "utf8") : undefined;
      save(args[0], await runFromAudio(args[0], tr, flags.lang, { reference: readOpt(flags.reference), force: flags.force === "true" }));
      return;
    }
    case "general": {
      const target = args[0];
      if (!target) throw new Error("npm run general -- <audio | transcript.txt | folder> [--lang bn] [--ref reference.txt]");
      const lang = flags.lang && flags.lang !== "true" ? flags.lang : undefined;
      const common = { language: lang, context: flags.context !== "true" ? flags.context : undefined, useLlm: flags["no-llm"] !== "true" };
      const outDir = path.join(ROOT, "evaluation", "general", new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-"));
      fs.mkdirSync(outDir, { recursive: true });
      const findRef = (file: string) => {
        const stem = file.replace(/\.[^.]+$/, "");
        for (const c of [`${stem}.ref.txt`, `${stem}.txt`]) if (c !== file && fs.existsSync(c)) return fs.readFileSync(c, "utf8");
        return undefined;
      };
      const one = async (file: string, reference?: string): Promise<GeneralResult> => {
        const name = path.basename(file);
        console.error(`\n▶ ${name}${reference ? "  (reference found)" : "  (no reference — estimate only)"}`);
        const r = AUDIO_EXT.test(file)
          ? await evaluateAudio(file, { ...common, name, reference })
          : await evaluateTranscript(fs.readFileSync(file, "utf8"), { ...common, name, reference });
        const md = renderGeneral(r);
        const stem = path.join(outDir, name.replace(/\.[^.]+$/, ""));
        fs.writeFileSync(`${stem}.md`, md);
        fs.writeFileSync(`${stem}.json`, JSON.stringify(r, null, 2));
        const m = r.measured?.raw;
        console.error(`  accuracy ${(r.accuracy.value * 100).toFixed(1)}% (${r.accuracy.source})` +
          (m ? ` · WER ${(m.wer * 100).toFixed(1)}% · CER ${(m.cer * 100).toFixed(1)}%` : "") +
          (r.llm ? ` · LLM estimate ${r.llm.estimatedAccuracy}%` : ""));
        return r;
      };
      const results: GeneralResult[] = [];
      if (fs.statSync(target).isDirectory()) {
        const files = fs.readdirSync(target).filter((f) => AUDIO_EXT.test(f)).sort().map((f) => path.join(target, f));
        if (!files.length) throw new Error(`No audio files in ${target}`);
        for (const f of files) {
          try {
            results.push(await one(f, findRef(f)));
          } catch (e: any) {
            console.error(`  ✘ ${path.basename(f)}: ${e.message}`);
          }
        }
      } else {
        results.push(await one(target, readOpt(flags.ref) ?? (AUDIO_EXT.test(target) ? findRef(target) : undefined)));
      }
      fs.writeFileSync(path.join(outDir, "results.csv"), [csvHeader(), ...results.map(csvRow)].join("\n") + "\n");
      fs.writeFileSync(path.join(outDir, "report.md"), results.length === 1 ? renderGeneral(results[0]) : renderBatch(results, describeSetup()));
      console.log(results.length === 1 ? renderGeneral(results[0]) : renderBatch(results, describeSetup()));
      console.error(`\n✔ saved ${path.relative(ROOT, outDir)}/ (report.md, results.csv, one .md + .json per file)`);
      break;
    }
    case "export-training": {
      const r = exportTraining();
      console.log(`✔ ${r.train} training + ${r.valid} validation examples → ${path.relative(ROOT, r.dir)}/train.jsonl, valid.jsonl`);
      console.log("  Fine-tune on the Mac: see scripts/finetune-mlx.md");
      return;
    }
    case "check": {
      console.log(`▶ MODEL_ENV=${config.modelEnv}  (ASR ${config.asr.backend} · LLM ${config.llm.provider} / ${config.llm.model})`);
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
      } else if (b === "remote") {
        console.log(config.asr.remoteUrl ? `✔ ASR remote endpoint ${config.asr.remoteUrl}${config.asr.remoteToken ? " (token set)" : " (no token)"}` : "✘ ASR_BACKEND=remote but ASR_REMOTE_URL is empty");
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
