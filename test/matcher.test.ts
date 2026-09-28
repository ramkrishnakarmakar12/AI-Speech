import { test } from "node:test";
import assert from "node:assert/strict";
import { splitAliases, nameVariants } from "../src/kb/build-kb.js";
import { loadKb } from "../src/kb/build-kb.js";
import { findMatches, normalize } from "../src/match/matcher.js";

const kb = loadKb();
const ids = (t: string) => findMatches(t, kb).map((m) => m.term.id);

test("alias splitting", () => {
  assert.deepEqual(splitAliases("Motiyabind (H) / Chokhe chhani (B)"), ["Motiyabind", "Chokhe chhani"]);
  assert.ok(splitAliases("RE / OD (oculus dexter)").includes("oculus dexter"));
  assert.ok(splitAliases("k/c/o").includes("k/c/o"));
  assert.ok(nameVariants("Diminution of vision (DOV)").includes("DOV"));
  assert.ok(!nameVariants("Visual acuity (distance)").includes("distance"));
});

test("normalize keeps notation", () => {
  assert.equal(normalize("VA 6/36, IOP 16.5 mmHg; C:D 0.7"), "va 6/36 iop 16.5 mmhg c:d 0.7");
});

test("exact, brand, colloquial, fuzzy", () => {
  assert.ok(ids("start latanoprost at night").includes("MED-036") || ids("start latanoprost at night").some((i) => i.startsWith("MED")));
  const brand = findMatches("put Moxicip drops", kb).find((m) => m.term.category === "medicine");
  assert.equal(brand?.term.name, "Moxifloxacin");
  assert.ok(ids("aankh mein motiyabind hai").includes("DIS-001"));
  const fz = findMatches("nepafinac drops three times", kb).find((m) => m.term.category === "medicine");
  assert.equal(fz?.term.name, "Nepafenac");
  const split = findMatches("moxi flox acin", kb);
  assert.equal(split[0].term.name, "Moxifloxacin");
  assert.ok(!split.some((m) => m.term.name === "Ofloxacin"), "substring hit suppressed");
});

test("short abbreviations need exact case", () => {
  assert.ok(ids("known case of DM and HTN").includes("ABR-005"));
  assert.ok(!ids("we will re check and at home").some((i) => i === "OPT-001"));
});

test("Hindi (Devanagari) and Bengali script are matched", async () => {
  const { transliterate } = await import("../src/match/translit.js");
  assert.equal(transliterate("मोतियाबिंद"), "motiyabind");
  assert.equal(transliterate("धुंधला दिखता"), "dhundhla dikhta");
  assert.equal(transliterate("চোখ চুলকায়"), "chokh chulkay");
  assert.equal(transliterate("অ্যালার্জিক"), "alarjik");
  const hi = ids("मोक्सीफ्लॉक्सासिन ड्रॉप दिन में चार बार, मोतियाबिंद");
  assert.ok(hi.includes("MED-001") && hi.includes("DIS-001"));
  const bn = ids("অলোপাটাডিন ড্রপ, অ্যালার্জিক কনজাংটিভাইটিস, ফ্লুরোমেথোলোন");
  assert.ok(bn.includes("MED-071") && bn.includes("DIS-039") && bn.includes("MED-026"));
});

test("runaway-generation guards", async () => {
  const { isLooping, repairJson } = await import("../src/llm/client.js");
  const item = '{"heard":"x","kb_id":"DIS-001"},';
  assert.ok(isLooping('{"terms":[' + item.repeat(80)));
  assert.ok(!isLooping(JSON.stringify({ a: Array.from({ length: 60 }, (_, i) => ({ id: i, name: "term " + i * 7 })) })));
  const cut = '{"patient":{"name":"A"},"medications":[{"generic_name":"Timolol","eye":"LE"},{"generic_name":"Lata';
  assert.deepEqual(repairJson(cut), { patient: { name: "A" }, medications: [{ generic_name: "Timolol", eye: "LE" }] });
});
