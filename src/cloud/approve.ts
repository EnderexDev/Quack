import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { RobloxError } from "../control/roblox.js";

/**
 * A write to Roblox (a DataStore entry, a published config, a product, a server restart) runs
 * only after the user says yes in Quack's app (Ender's call, 10/11/26: the PowerShell window
 * the hub opened before "looked like a virus"). The hub queues the question, the app shows it in
 * its own popup, and only the app can answer.
 *
 * The hub's HTTP API has no password: any local program can call it, so an answer must prove it
 * comes from the app. The app makes a random token (32 bytes) each time it starts a hub and
 * hands it over on the hub's stdin, never its command line, environment or a plain file; the
 * hub keeps it in memory, and POST /api/approvals/answer without it is refused. The list of
 * questions (GET /api/approvals) is open: it holds nothing the asker did not send.
 *
 * Everything the write changes is in the question's text (each op's `describe`), shown whole in
 * a scrolling read-only box. One at a time: a write asked while one waits is refused at once,
 * before any work for it. No answer in APPROVAL_TIMEOUT_MS is a No.
 *
 * What it does not stop: a program running as the same Windows user can still drive the app's
 * window (UI Automation, SendKeys), or decrypt the app's copy of the token (DPAPI protects it
 * from other users, not from this one). Ender's AI hook blocks commands that name Quack's
 * window or token file; real separation would need another Windows user.
 */

export interface Approver {
  (request: { title: string; text: string }): Promise<boolean>;
  /** A question waits now: a new write is refused before it reads Roblox or builds its question */
  busy?: () => boolean;
}

export const APPROVAL_TIMEOUT_MS = 5 * 60_000;
/** The app polls /api/state every second; this long without a poll means it is not running */
export const APP_SEEN_MS = 5000;
/** The header the app's answer carries its token in */
export const APPROVAL_TOKEN_HEADER = "x-quack-approval-token";
/** The header the app's own polls carry, so the hub knows an app is there to ask */
export const APP_HEADER = "x-quack-app";

/** No second launch of the app this soon after one, whatever happened to it */
export const APP_LAUNCH_EVERY_MS = 15_000;

/**
 * Characters that hide or reorder text: controls (but tab and line breaks), every format
 * character (\p{Cf}: bidi marks, zero width, soft hyphen, the Mongolian vowel separator, tag
 * characters U+E0000-E007F), the combining grapheme joiner, the Hangul fillers that draw as
 * blank, and variation selectors, the Mongolian ones too (an emoji's U+FE0F shows as \u{FE0F}:
 * honest, not pretty)
 */
const HIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Cf}͏ᅟᅠ᠋-᠏ㅤﾠ︀-️\u{e0100}-\u{e01ef}]/gu;

export function hasHiddenCharacters(text: string): boolean {
  HIDDEN.lastIndex = 0;
  return HIDDEN.test(text);
}

/** Every hidden character shown as \u{XXXX}: what the user reads is all there is */
export function revealHidden(text: string): string {
  return text.replace(HIDDEN, (c) => `\\u{${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}}`);
}

export class ApprovalBusy extends RobloxError {}
/** No app was running to ask: the hub started it, and the write asks again once it is up */
export class AppOpening extends RobloxError {}

export interface PendingApproval {
  id: string;
  title: string;
  text: string;
  createdAt: number;
  expiresAt: number;
}

export interface AppApprovalsOptions {
  timeoutMs?: number;
  /** The app's executable, started with --hidden when a write waits and no app polls the hub */
  appExe?: string;
  /** How the app is started (tests); default: launchApp */
  launch?: (exe: string) => void;
  now?: () => number;
  log?: (line: string) => void;
}

/**
 * Starts Quack's app in the background. Detached, so it outlives the hub. Never windowsHide: a
 * process started hidden has its first ShowWindow made hidden by Windows (measured 10/11/26 with
 * the old PowerShell window), and the app's first show is the one the popup needs.
 */
export function launchApp(exe: string, spawnFn: typeof spawn = spawn): void {
  const child = spawnFn(exe, ["--hidden"], { detached: true, stdio: "ignore", windowsHide: false });
  child.on("error", () => {});
  child.unref();
}

const digest = (text: string) => createHash("sha256").update(text, "utf8").digest();

/** The questions waiting for the user's answer in the app, and the token that answers them */
export class AppApprovals {
  private token: Buffer | undefined;
  private current: (PendingApproval & { resolve: (yes: boolean) => void; timer: NodeJS.Timeout }) | undefined;
  private appSeenAt = 0;
  /** When the app was last started, so a burst of writes (or one that keeps failing) starts it once */
  private launchedAt = 0;
  private readonly now: () => number;

  constructor(private readonly options: AppApprovalsOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  /** The app's token, from the hub's stdin: 64 hex characters, anything else is ignored */
  setToken(token: string): boolean {
    const clean = token.trim();
    if (!/^[0-9a-f]{64}$/i.test(clean)) return false;
    this.token = digest(clean.toLowerCase());
    return true;
  }

  hasToken(): boolean {
    return this.token !== undefined;
  }

  /** True only for the app's own token; compared as digests, in constant time */
  tokenMatches(given: string | string[] | undefined): boolean {
    if (!this.token || typeof given !== "string") return false;
    return timingSafeEqual(this.token, digest(given.trim().toLowerCase()));
  }

  /** The app polled /api/state */
  sawApp(): void {
    this.appSeenAt = this.now();
  }

  appRunning(): boolean {
    return this.appSeenAt > 0 && this.now() - this.appSeenAt < APP_SEEN_MS;
  }

  list(): PendingApproval[] {
    if (!this.current) return [];
    const { id, title, text, createdAt, expiresAt } = this.current;
    return [{ id, title, text, createdAt, expiresAt }];
  }

  /** The user's click, already checked to come from the app; false for a question no longer waiting */
  answer(id: string, approve: boolean): boolean {
    if (!this.current || this.current.id !== id) return false;
    // A late timer must not let an answer past the deadline through: that write is a No
    if (this.now() >= this.current.expiresAt) {
      this.current.resolve(false);
      return false;
    }
    this.current.resolve(approve);
    return true;
  }

  /** The hub stops: what waits is a No */
  close(): void {
    this.current?.resolve(false);
  }

  approver(): Approver {
    const approve: Approver = (request) => {
      if (this.current) return Promise.reject(new ApprovalBusy("another write is waiting for the user's answer in Quack's app: ask again once it is answered"));
      if (!this.appRunning()) {
        const exe = this.options.appExe;
        if (!exe) return Promise.reject(new RobloxError("Quack's app is not running to ask the user: open it, then ask again (nothing was changed)"));
        // One start at a time, failed or not: the writes asked meanwhile only hear it is opening
        if (this.launchedAt === 0 || this.now() - this.launchedAt >= APP_LAUNCH_EVERY_MS) {
          this.launchedAt = this.now();
          try {
            (this.options.launch ?? launchApp)(exe);
            this.options.log?.(`Approval: the app was not running, starting ${exe}`);
          } catch (error) {
            this.options.log?.(`Approval: could not start the app: ${(error as Error).message}`);
          }
        }
        return Promise.reject(new AppOpening("Quack is opening to ask the user: ask again in a moment (nothing was changed)"));
      }
      const timeoutMs = this.options.timeoutMs ?? APPROVAL_TIMEOUT_MS;
      const createdAt = this.now();
      return new Promise<boolean>((resolve) => {
        const finish = (yes: boolean) => {
          if (!this.current || this.current.id !== id) return;
          clearTimeout(this.current.timer);
          this.current = undefined;
          resolve(yes);
        };
        const id = randomBytes(8).toString("hex");
        this.current = {
          id,
          // One line for the title; every hidden character shown in both
          title: revealHidden(request.title).replace(/[\r\n]+/g, " ").slice(0, 200),
          text: revealHidden(request.text),
          createdAt,
          expiresAt: createdAt + timeoutMs,
          resolve: finish,
          timer: setTimeout(() => finish(false), timeoutMs),
        };
        // A hub that stops holds no process open for a question it can no longer answer
        this.current.timer.unref();
      });
    };
    approve.busy = () => this.current !== undefined;
    return approve;
  }
}
