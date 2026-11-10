#!/usr/bin/env node
// Quack's guard as a Claude Code PreToolUse hook (see guard.ts): the tool call on stdin, the
// answer on stdout. Bundled alone as guard.mjs, so each tool call starts only this.
import { guardAnswer } from "./guard.js";

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
process.stdout.write(guardAnswer(Buffer.concat(chunks).toString("utf8")));
