import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEvent, serializeCommand } from "../src/protocol.ts";

test("parses every event the helper emits", () => {
  const lines = [
    '{"fraction":0.5,"model":"parakeet-ultra","type":"loading"}',
    '{"protocolVersion":1,"streaming":true,"type":"ready"}',
    '{"type":"listening"}',
    '{"level":0.42,"type":"level"}',
    '{"text":"hello there","type":"partial"}',
    '{"audioMs":9350,"text":"Hello there.","transcribeMs":169,"type":"final"}',
    '{"type":"cancelled"}',
    '{"code":"microphone_denied","fatal":false,"message":"denied","type":"error"}',
  ];
  for (const line of lines) assert.deepEqual(parseEvent(line), JSON.parse(line));
});

test("rejects malformed lines", () => {
  for (const line of ["", "not json", "42", "null", "[]", '{"type":"bogus"}', '{"type":"partial"}', '{"type":"level","level":"loud"}']) {
    assert.equal(parseEvent(line), undefined, line);
  }
});

test("serializes commands as single lines", () => {
  assert.equal(serializeCommand({ type: "start" }), '{"type":"start"}\n');
});
