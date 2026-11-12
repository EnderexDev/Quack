// The hub's analysis thread (service.ts): parsing a big place takes a second or more, and the hub
// relays every Studio's sync, so the analysis never runs on its thread. Bundled alone as
// analysis-worker.mjs next to hub.mjs.
import { parentPort } from "node:worker_threads";
import { ResidentAnalysis, type ResidentRequest } from "./resident.js";

const resident = new ResidentAnalysis();
let chain: Promise<unknown> = Promise.resolve();

parentPort?.on("message", (message: { id: number; request?: ResidentRequest; drop?: string | true }) => {
  // one run at a time: two runs of one project would share its cache mid-run
  chain = chain.then(async () => {
    if (message.drop) {
      resident.drop(message.drop === true ? undefined : message.drop);
      parentPort!.postMessage({ id: message.id, ok: true });
      return;
    }
    try {
      const answer = await resident.run(message.request!);
      parentPort!.postMessage({ id: message.id, ok: true, answer });
    } catch (error) {
      parentPort!.postMessage({ id: message.id, ok: false, error: (error as Error).message });
    }
  });
});
