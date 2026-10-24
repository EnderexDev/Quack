import { spawn } from "node:child_process";

/** Opens a file or a URI (roblox-studio:...) with whatever the system has for it */
export function openWithDefaultApp(target: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const currentPlatform = process.platform;

    const argsByPlatform: Record<string, string[]> = {
      win32: ["/c", "start", "", target],
      darwin: [target],
      linux: [target],
    };

    const commandByPlatform: Record<string, string> = {
      win32: "cmd",
      darwin: "open",
      linux: "xdg-open",
    };

    const commandName = commandByPlatform[currentPlatform];
    const commandArgs = argsByPlatform[currentPlatform];

    if (!commandName || !commandArgs) {
      rejectPromise(new Error(`Unsupported platform: ${currentPlatform}`));
      return;
    }

    const child = spawn(commandName, commandArgs, {
      detached: true,
      stdio: "ignore",
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (currentPlatform === "linux" && error.code === "ENOENT") {
        rejectPromise(
          new Error(
            "Could not open target because 'xdg-open' is not installed. Install it (i.e: 'sudo apt install xdg-utils' or 'sudo dnf install xdg-utils') and try again.",
          ),
        );
        return;
      }

      rejectPromise(error);
    });

    child.unref();
    resolvePromise();
  });
}
