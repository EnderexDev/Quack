import fs from "node:fs";

/**
 * fs.rmSync that waits out a folder Windows still holds: a killed daemon's sync folder stays
 * held for ~0.5 s after its backstop watch (measured 07/11/26: 2 ms without it, 450 to 550 ms
 * with it). Node 24's rmSync does not retry this EPERM despite maxRetries.
 */
export async function removeDir(dir: string, timeoutMs = 5000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (Date.now() > until || (code !== "EPERM" && code !== "EBUSY" && code !== "ENOTEMPTY")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
