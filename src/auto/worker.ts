// The hub's analysis thread (service.ts): parsing a big place takes a second or more, and the hub
// relays every Studio's sync, so the analysis never runs on its thread. Bundled alone as
// analysis-worker.mjs next to hub.mjs.
import { parentPort } from "node:worker_threads";
import { ResidentAnalysis, type ResidentRequest } from "./resident.js";

const resident = new ResidentAnalysis();
let chain: Promise<unknown> = Promise.resolve();

type Message = { id: number; request?: ResidentRequest; drop?: string | true; reach?: { root: string; files: string[]; placeFolders: string[] } };

parentPort?.on("message", (message: Message) => {
  // one run at a time: two runs of one project would share its cache mid-run. Every message is
  // answered, an error included, so the chain never stops on one
  chain = chain.then(async () => {
    try {
      if (message.drop) {
        resident.drop(message.drop === true ? undefined : message.drop);
        parentPort!.postMessage({ id: message.id, ok: true });
        return;
      }
      // Quack Test: the specs an edit reaches, with the project's kept parses
      const answer = message.reach ? await resident.reach(message.reach) : await resident.run(message.request!);
      parentPort!.postMessage({ id: message.id, ok: true, answer });
    } catch (error) {
      parentPort!.postMessage({ id: message.id, ok: false, error: (error as Error).message });
    }
  });
});
