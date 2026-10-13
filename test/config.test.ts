import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG, loadConfig, parseModelRef, resolveConfig } from "../src/config.ts";

test("defaults when there is no file", () => {
  const { config, problems } = loadConfig(path.join(os.tmpdir(), "does-not-exist", "hold-to-talk.json"));
  assert.deepEqual(config, DEFAULT_CONFIG);
  assert.deepEqual(problems, []);
});

test("applies valid settings and reports the rest", () => {
  const { config, problems } = resolveConfig({
    language: "es",
    polishModel: "openai-codex/gpt-5.6-luna",
    vocabulary: ["FluidAudio"],
    previewChunkMs: 1000,
    maxSeconds: -1,
    colour: "red",
  });
  assert.equal(config.language, "es");
  assert.equal(config.polishModel, "openai-codex/gpt-5.6-luna");
  assert.deepEqual(config.vocabulary, ["FluidAudio"]);
  assert.equal(config.previewChunkMs, DEFAULT_CONFIG.previewChunkMs);
  assert.equal(config.maxSeconds, DEFAULT_CONFIG.maxSeconds);
  assert.deepEqual(problems, [
    '"previewChunkMs" should be 560, 1120, 2240, 4480',
    '"maxSeconds" should be a number up to 600',
    'unknown setting "colour"',
  ]);
});

test("reports a file that is not JSON", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hold-to-talk-"));
  const file = path.join(dir, "hold-to-talk.json");
  fs.writeFileSync(file, "{ nope");
  const { config, problems } = loadConfig(file);
  assert.deepEqual(config, DEFAULT_CONFIG);
  assert.match(problems[0] ?? "", /is not valid JSON/);
  fs.rmSync(dir, { recursive: true });
});

test("rejects a non-object", () => {
  assert.deepEqual(resolveConfig([1]).problems, ["settings must be a JSON object"]);
});

test("model references split at the first slash", () => {
  assert.deepEqual(parseModelRef("openrouter/qwen/qwen3-coder"), { provider: "openrouter", id: "qwen/qwen3-coder" });
  assert.equal(parseModelRef("no-slash"), undefined);
  assert.equal(parseModelRef("/leading"), undefined);
  assert.equal(parseModelRef("trailing/"), undefined);
});
