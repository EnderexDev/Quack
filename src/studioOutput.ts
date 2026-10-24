import fs from "node:fs";
import path from "node:path";
import type { StudioOutputMessage } from "./ipc/messages.js";
import { timestamp } from "./util/log.js";

interface SourcemapNode {
  name: string;
  filePaths?: string[];
  children?: SourcemapNode[];
}

interface SourcemapRoot {
  children?: SourcemapNode[];
}

const colors = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  blue: "\x1b[34m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
};

/** Checks the shape of a relayed playtest output message from either Studio route. */
export function isStudioOutputMessage(
  value: unknown,
): value is StudioOutputMessage {
  const message = value as Partial<StudioOutputMessage> | null;
  return (
    typeof message === "object" &&
    message !== null &&
    message.type === "studioOutput" &&
    typeof message.message === "string" &&
    typeof message.messageType === "string" &&
    typeof message.timestamp === "number" &&
    (message.source === "server" || message.source === "client")
  );
}

/** Stands for a line break inside one playtest message; the app turns it back into one. */
export const LINE_BREAK = "\u2028";

/** Warnings Roblox's own core UI logs in every playtest, never the game's. */
function isRobloxCoreNoise(message: string): boolean {
  return message.startsWith("[Roblox][CorePackages.");
}

export class StudioOutputFormatter {
  private sourcemapPath: string;
  private sourcemapModifiedAt = -1;
  private filePathsByInstancePath = new Map<string, string>();

  constructor(sourcemapPath: string) {
    this.sourcemapPath = path.resolve(sourcemapPath);
  }

  /**
   * Format a playtest message like Studio's Output window:
   * `  00:16:28.796  message  -  Server`, with the timestamp and source dimmed.
   * Always one log line: the app splits the log by line, so a message's own line breaks
   * (a callstack) become LINE_BREAK. Null for Roblox's own core UI noise.
   */
  public format(output: StudioOutputMessage): string | null {
    if (isRobloxCoreNoise(output.message)) return null;
    const time = timestamp(new Date(output.timestamp));
    const source = output.source === "server" ? "Server" : "Client";
    // Strip control characters so relayed text can't inject terminal escapes
    const message = this.rewriteSourceLocations(
      output.message
        .replace(/\r?\n/g, LINE_BREAK)
        .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ""),
    );
    const color = this.getColor(output.messageType);
    const body = color ? `${color}${message}${colors.reset}` : message;
    return `${colors.dim}  ${time}${colors.reset}  ${body}  ${colors.dim}-  ${source}${colors.reset}`;
  }

  private rewriteSourceLocations(message: string): string {
    this.reloadSourcemapIfChanged();

    return message.replace(
      /Script '((?:game\.)?[^']+)', Line (\d+)/g,
      (match, instancePath: string, line: string) => {
        const normalizedInstancePath = instancePath.startsWith("game.")
          ? instancePath
          : `game.${instancePath}`;
        const filePath = this.filePathsByInstancePath.get(
          normalizedInstancePath,
        );
        return filePath ? `Script ${filePath}:${line}` : match;
      },
    );
  }

  private reloadSourcemapIfChanged(): void {
    let modifiedAt: number;
    try {
      modifiedAt = fs.statSync(this.sourcemapPath).mtimeMs;
    } catch {
      return;
    }

    if (modifiedAt === this.sourcemapModifiedAt) {
      return;
    }

    try {
      const sourcemap = JSON.parse(
        fs.readFileSync(this.sourcemapPath, "utf8"),
      ) as SourcemapRoot;
      const filePathsByInstancePath = new Map<string, string>();

      const visit = (node: SourcemapNode, parentPath: string[]): void => {
        const instancePath = [...parentPath, node.name];
        const filePath = node.filePaths?.[0];
        if (filePath) {
          filePathsByInstancePath.set(
            ["game", ...instancePath].join("."),
            filePath.replace(/\\/g, "/"),
          );
        }

        for (const child of node.children ?? []) {
          visit(child, instancePath);
        }
      };

      for (const child of sourcemap.children ?? []) {
        visit(child, []);
      }

      this.filePathsByInstancePath = filePathsByInstancePath;
      this.sourcemapModifiedAt = modifiedAt;
    } catch {
      return;
    }
  }

  private getColor(messageType: string): string | null {
    switch (messageType) {
      case "MessageInfo":
        return colors.blue;
      case "MessageWarning":
        return colors.yellow;
      case "MessageError":
        return colors.red;
      default:
        return null;
    }
  }
}
