import { RobloxError } from "../control/roblox.js";
import { cloudRequest, nameArg, quoted, universeArg, universeLabel, universeUrl } from "./live-http.js";
import type { CloudOp } from "./ops.js";

/**
 * A message to every live server of a game through MessagingService (the servers that subscribed
 * to the topic with SubscribeAsync act on it). Limits are MessagingService's own: a topic of 80
 * characters, a message of 1,024, shared with the game's own publishes.
 */

const publishArgs = (args: Record<string, any>) => {
  const universeId = universeArg(args);
  // The topic goes in the body, never the path: "." is a topic like any other
  const topic = nameArg(args.topic, "topic", 80, false);
  if (typeof args.message !== "string") throw new RobloxError("message is required (text; a table goes as its JSON)");
  // MessagingService's 1 KiB counts bytes: an accented or emoji message is longer than its length
  const bytes = Buffer.byteLength(args.message, "utf8");
  if (bytes > 1024) throw new RobloxError(`message is at most 1,024 bytes (this one has ${bytes})`);
  return { universeId, topic, message: args.message as string };
};

export const MESSAGING_OPS: Record<string, CloudOp> = {
  messagePublish: {
    write: true,
    describe: async (args, ctx) => {
      const p = publishArgs(args);
      const label = await universeLabel(ctx, p.universeId);
      return {
        title: `Quack: send a message to the servers of ${label.short}`,
        text: [
          `Publish on the MessagingService topic ${quoted(p.topic, 80)} of ${label.long}, to every live server:`,
          `  ${quoted(p.message, 300)}`,
          "",
          "Each server that subscribed to this topic runs its own code on it (an announcement, a shutdown, a reward: whatever the game does with it). It cannot be taken back.",
          "",
          "Allow it?",
        ].join("\n"),
      };
    },
    run: async (ctx, args) => {
      const p = publishArgs(args);
      await cloudRequest(ctx.env, {
        method: "POST", url: `${universeUrl(p.universeId)}:publishMessage`, body: { topic: p.topic, message: p.message },
        permission: "universe-messaging-service:publish", what: `the message on topic ${p.topic} of experience ${p.universeId}`,
        limitNote: "MessagingService's limits count the game's own publishes too: a topic takes 40 + 80 x servers messages a minute",
      });
      return { universeId: p.universeId, topic: p.topic, published: true, characters: p.message.length };
    },
  },
};
