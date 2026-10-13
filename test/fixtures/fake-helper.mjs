// Stands in for the native helper: answers the protocol with canned events.
import readline from "node:readline";

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const version = Number(process.env.FAKE_PROTOCOL_VERSION ?? 1);

emit({ type: "loading", model: "parakeet-ultra", fraction: 0.5 });
emit({ type: "ready", protocolVersion: version, streaming: true });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const { type } = JSON.parse(line);
  if (type === "start") emit({ type: "listening" });
  if (type === "stop") emit({ type: "final", text: "hello", audioMs: 1000, transcribeMs: 5 });
  if (type === "quit") process.exit(0);
  if (type === "crash") {
    process.stderr.write("something broke\n");
    process.exit(3);
  }
});
