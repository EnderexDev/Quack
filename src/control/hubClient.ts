import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Which Quack the command talks to. Each app installs its own command (`quack` for Official,
 * `quackdev` for Dev) that names its flavor, so one name always reaches one hub: there is no
 * flag to cross over, and a typo can never pause the Official hub from a Dev terminal.
 */
export type Flavor = "official" | "dev";

export interface FlavorInfo {
  flavor: Flavor;
  /** The command's own name, for help and messages */
  command: string;
  appName: string;
  /** Defaults, overridden by the app's settings.json when it has one */
  port: number;
  registry: string;
  /** The app's settings folder (Tauri's identifier) */
  identifier: string;
  /** The plugin file this flavor's app installs into Studio */
  plugin: string;
}

function appdata(): string {
  return process.platform === "win32"
    ? (process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"))
    : (process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"));
}

/** The same numbers as the `flavor` module in app/src-tauri/src/main.rs */
export function flavorInfo(flavor: Flavor): FlavorInfo {
  const official = flavor === "official";
  const info: FlavorInfo = {
    flavor,
    command: official ? "quack" : "quackdev",
    appName: official ? "Quack" : "Quack Dev",
    port: official ? 3825 : 3826,
    registry: path.join(appdata(), "quack", official ? "hub.json" : "hub-dev.json"),
    identifier: official ? "dev.enderex.quack" : "dev.enderex.quack.dev",
    plugin: official ? "Quack.rbxmx" : "QuackDev.rbxmx",
  };
  // The app may have been pointed at another port or registry: follow it
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(appdata(), info.identifier, "settings.json"), "utf8"));
    if (Number.isInteger(settings?.hubPort) && settings.hubPort > 0 && settings.hubPort < 65536) info.port = settings.hubPort;
    if (typeof settings?.registry === "string" && settings.registry.trim()) info.registry = settings.registry;
  } catch {
    // no app settings yet: the defaults
  }
  return info;
}

/** The hub did not answer at all (not running, or another program on the port) */
export class HubOffline extends Error {}

/** The hub answered with an error */
export class HubError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export class HubClient {
  constructor(readonly port: number, private readonly timeoutMs = 5000) {}

  private async call(method: "GET" | "POST", pathname: string, body?: unknown, timeoutMs = this.timeoutMs): Promise<any> {
    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${this.port}${pathname}`, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if ((error as Error).name === "TimeoutError") throw new HubError(504, `the hub took more than ${Math.round(timeoutMs / 1000)} s to answer ${pathname}`);
      throw new HubOffline(`no hub answers on port ${this.port} (${(error as Error).cause ?? (error as Error).message})`);
    }
    let parsed: any;
    try {
      parsed = await response.json();
    } catch {
      throw new HubError(response.status, `the hub answered ${response.status} without JSON`);
    }
    if (!response.ok) throw new HubError(response.status, parsed?.error ?? `the hub answered ${response.status}`);
    return parsed;
  }

  get(pathname: string, query: Record<string, string | number | undefined> = {}): Promise<any> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
    const search = params.toString();
    return this.call("GET", search ? `${pathname}?${search}` : pathname);
  }

  /** `timeoutMs`: for a call the hub answers only once the work is done (`play`) */
  post(pathname: string, body: Record<string, unknown> = {}, timeoutMs?: number): Promise<any> {
    return this.call("POST", pathname, body, timeoutMs);
  }

  /** True when something accepts a connection on the port, hub or not */
  async online(): Promise<boolean> {
    try {
      await this.get("/api/state");
      return true;
    } catch (error) {
      return !(error instanceof HubOffline);
    }
  }
}
