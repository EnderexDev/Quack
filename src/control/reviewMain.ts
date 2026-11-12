#!/usr/bin/env node
// Quack's review after an AI's edit (see review.ts), as a client hook:
//   review.mjs --port <hub port> --client claude|codex|cursor --quack-review <server name>
// The tool call on stdin, the findings (or nothing) on stdout. Bundled alone as review.mjs.
import { reviewAnswer, type ReviewClient } from "./review.js";

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const port = Number(option("--port"));
const client = (["claude", "codex", "cursor"].includes(option("--client") ?? "") ? option("--client") : "claude") as ReviewClient;

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
const out = Number.isInteger(port) && port > 0 ? await reviewAnswer(Buffer.concat(chunks).toString("utf8"), { client, port }) : client === "cursor" ? "{}" : "";
if (out) process.stdout.write(out);
