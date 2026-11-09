/**
 * Simple logging utility with color support
 */

import { format } from "node:util";
import { config } from "../config.js";

const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",

  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
};

/** Local wall-clock time as `HH:MM:SS.mmm`, the clock playtest output uses too. */
export function timestamp(date = new Date()): string {
  const pad = (value: number, length = 2) => String(value).padStart(length, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

/** Prompt prefix, so Inquirer questions match the logger's output format. */
export function promptPrefix(): string {
  return `${colors.dim}[${timestamp()}]${colors.reset} ${colors.cyan}?${colors.reset}`;
}

/** How a line was logged: the method of `log` that wrote it */
export type LogLevel = "info" | "success" | "warn" | "error" | "debug" | "script" | "playtest";

/** Receives each line `log` writes, as plain text (no time, no colors) */
export type LogSink = (level: LogLevel, text: string) => void;

const sinks = new Set<LogSink>();
let emitting = false;

/**
 * Hands every line `log` writes to `sink` too, until the returned function is called. A sink
 * that logs while handling a line is not called again for that line (no loop through a sink
 * that sends, fails and logs the failure).
 */
export function addLogSink(sink: LogSink): () => void {
  sinks.add(sink);
  return () => {
    sinks.delete(sink);
  };
}

function emit(level: LogLevel, message: string, args: unknown[]): void {
  if (sinks.size === 0 || emitting) return;
  emitting = true;
  try {
    const text = args.length > 0 ? format(message, ...args) : message;
    for (const sink of sinks) {
      try {
        sink(level, text);
      } catch {
        // A sink never breaks the line that reached the console
      }
    }
  } finally {
    emitting = false;
  }
}

export const log = {
  info(message: string, ...args: any[]): void {
    emit("info", message, args);
    console.log(
      `${colors.dim}[${timestamp()}]${colors.reset} ${colors.blue}ℹ${
        colors.reset
      } ${message}`,
      ...args,
    );
  },

  success(message: string, ...args: any[]): void {
    emit("success", message, args);
    console.log(
      `${colors.dim}[${timestamp()}]${colors.reset} ${colors.green}✓${
        colors.reset
      } ${message}`,
      ...args,
    );
  },

  warn(message: string, ...args: any[]): void {
    emit("warn", message, args);
    console.log(
      `${colors.dim}[${timestamp()}]${colors.reset} ${colors.yellow}⚠ ${message}${colors.reset}`,
      ...args,
    );
  },

  error(message: string, ...args: any[]): void {
    emit("error", message, args);
    console.error(
      `${colors.dim}[${timestamp()}]${colors.reset} ${colors.red}✗ ${message}${colors.reset}`,
      ...args,
    );
  },

  debug(message: string, ...args: any[]): void {
    if (config.debugMode) {
      emit("debug", message, args);
      console.log(
        `${colors.dim}[${timestamp()}] 🔍 ${message}${colors.reset}`,
        ...args,
      );
    }
  },


  script(path: string, action: "created" | "updated" | "deleted"): void {
    const emoji = action === "created" ? "+" : action === "updated" ? "~" : "−";
    const color =
      action === "created"
        ? colors.green
        : action === "updated"
          ? colors.yellow
          : colors.red;
    emit("script", `${emoji} ${path}`, []);
    console.log(
      `${colors.dim}[${timestamp()}]${colors.reset} ${color}${emoji}${
        colors.reset
      } ${path}`,
    );
  },

  /** Marks where relayed playtest output starts and ends. */
  playtest(state: "started" | "ended"): void {
    const icon =
      state === "started"
        ? `${colors.green}▶${colors.reset}`
        : `${colors.dim}■${colors.reset}`;
    emit("playtest", `Playtest ${state}`, []);
    console.log(
      `${colors.dim}[${timestamp()}]${colors.reset} ${icon} Playtest ${state}`,
    );
  },
};
