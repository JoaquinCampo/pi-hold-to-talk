import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  findHelper,
  helperArguments,
  helperCandidates,
  type HelperNotice,
  HelperProcess,
  LoadProgress,
} from "../src/helper.ts";
import type { HelperCommand } from "../src/protocol.ts";

const FAKE = fileURLToPath(new URL("./fixtures/fake-helper.mjs", import.meta.url));

/** Runs the fake helper through a shell shim, as HelperProcess expects an executable. */
function fakeBinary(env = ""): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hold-to-talk-helper-"));
  const shim = path.join(dir, "helper");
  fs.writeFileSync(shim, `#!/bin/sh\n${env} exec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
  return shim;
}

function launch(binary: string) {
  const helper = new HelperProcess({ binary, language: "auto", livePreview: true, previewChunkMs: 560 });
  const notices: HelperNotice[] = [];
  helper.onNotice((notice) => notices.push(notice));
  const next = (type: HelperNotice["type"]) =>
    new Promise<HelperNotice>((resolve) => {
      const found = notices.find((n) => n.type === type);
      if (found) return resolve(found);
      const off = helper.onNotice((notice) => {
        if (notice.type === type) {
          off();
          resolve(notice);
        }
      });
    });
  return { helper, notices, next };
}

test("builds the serve arguments", () => {
  assert.deepEqual(helperArguments({ binary: "x", language: "es", livePreview: false, previewChunkMs: 1120 }), [
    "serve", "--language", "es", "--chunk-ms", "1120", "--no-streaming",
  ]);
});

test("prefers an override, then a local build, then the shipped binary", () => {
  assert.deepEqual(helperCandidates("/pkg", "/custom/helper"), ["/custom/helper"]);
  assert.deepEqual(helperCandidates("/pkg", null), [
    "/pkg/helper/.build/release/pi-hold-to-talk-helper",
    "/pkg/bin/pi-hold-to-talk-helper",
  ]);
  const shim = fakeBinary();
  assert.equal(findHelper(["/nope", shim]), shim);
  assert.equal(findHelper(["/nope"]), undefined);
});

test("combines per-model progress", () => {
  const progress = new LoadProgress();
  assert.equal(progress.update("a", 0.5), 50);
  assert.equal(progress.update("b", 0), 25);
  assert.equal(progress.update("b", 1.5), 75, "fractions are clamped");
});

test("talks to a helper process", async () => {
  const { helper, next } = launch(fakeBinary());
  await next("ready");
  assert.deepEqual(helper.status, { state: "ready", streaming: true });
  const commands: HelperCommand[] = [{ type: "start" }, { type: "stop" }];
  for (const command of commands) helper.send(command);
  assert.deepEqual(await next("final"), { type: "final", text: "hello", audioMs: 1000, transcribeMs: 5 });
  helper.dispose();
});

test("reports a crash with the helper's last words", async () => {
  const { helper, next } = launch(fakeBinary());
  await next("ready");
  helper.send({ type: "crash" } as unknown as HelperCommand);
  const exit = await next("exit");
  assert.deepEqual(exit, { type: "exit", message: "speech helper exited with code 3: something broke" });
  assert.equal(helper.status.state, "failed");
});

test("refuses a helper speaking another protocol version", async () => {
  const { helper, next } = launch(fakeBinary("FAKE_PROTOCOL_VERSION=99"));
  const exit = await next("exit");
  assert.match(exit.type === "exit" ? exit.message : "", /protocol 99, expected 1/);
  assert.equal(helper.status.state, "failed");
});

test("reports a binary that cannot start", async () => {
  const { helper, next } = launch("/definitely/not/here");
  const exit = await next("exit");
  assert.match(exit.type === "exit" ? exit.message : "", /could not start/);
  assert.equal(helper.status.state, "failed");
});
