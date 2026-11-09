/**
 * Types for communication protocol between Studio and Daemon
 */

import type { LogLevel } from "../util/log.js";

export type InstanceClassName =
  | "Script"
  | "LocalScript"
  | "ModuleScript"
  | "Folder"
  | "Model"
  | "Part"
  | "MeshPart"
  | "Tool"
  | "Configuration"
  | string; // Allow any Roblox class

/**
 * Represents a single instance in the DataModel
 */
export interface InstanceData {
  guid: string;
  className: InstanceClassName;
  name: string;
  path: string[]; // ["ReplicatedStorage", "Modules", "Foo"]
  parentGuid?: string | null; // parent instance GUID
  source?: string; // Only present for Script/LocalScript/ModuleScript
  properties?: Record<string, unknown>;
  attributes?: Record<string, unknown>;
  tags?: string[];
}

export interface SnapshotRequestOptions {
  includeProperties?: boolean;
  scriptsAndDescendantsOnly?: boolean;
  /**
   * Quack: send no `path` per instance; the daemon rebuilds each from the parent's
   * (fs/snapshotPaths.ts). Asked only by daemons that can do that; an older plugin ignores it
   * and sends paths, which still work.
   */
  omitPaths?: boolean;
}

/**
 * Messages from Studio → Daemon
 */
export type StudioPayloadMessage =
  | FullSnapshotMessage
  | InstanceUpdatedMessage
  | ScriptChangedMessage
  | DeletedMessage
  | StudioOutputMessage
  | PingMessage
  | ClientDisconnect
  | PushConfigMessage
  | HandshakeMessageStudio
  | PlayOverlayResultMessage
  | PlayVerifyMessage
  | ToolResultMessage
  | DaemonLogOptionsMessage;

export interface BatchMessage {
  type: "batch";
  messages: StudioPayloadMessage[];
}

export type StudioMessage = StudioPayloadMessage | BatchMessage;

export interface FullSnapshotMessage {
  type: "fullSnapshot";
  data: InstanceData[];
  placeId?: number;
}

export interface InstanceUpdatedMessage {
  type: "instanceUpdated";
  data: InstanceData;
}

export interface ScriptChangedMessage {
  type: "scriptChanged";
  data: {
    guid: string;
    path: string[];
    className: InstanceClassName;
    source: string;
    /** Quack plugin: the last text Studio and the daemon agreed on before this edit */
    base?: string;
  };
}

export interface DeletedMessage {
  type: "deleted";
  data: {
    guid: string;
  };
}

/** Playtest output relayed from a Solo server or client DataModel */
export interface StudioOutputMessage {
  type: "studioOutput";
  message: string;
  messageType: string;
  source: "server" | "client";
  /** Unix time in milliseconds when the message was logged */
  timestamp: number;
}

export interface PingMessage {
  type: "ping";
}

export interface ClientDisconnect {
  type: "clientDisconnect";
}

export interface PushConfigMessage {
  type: "pushConfig";
  config: PushConfig;
}

export interface HandshakeAckMessage {
  type: "handshakeAck";
  version: string;
  /** The daemon has this session's tree: no snapshot follows, the plugin sends what it queued */
  resumed?: boolean;
  /** This daemon can send its log to Studio's Output (`daemonLog`); older ones never say so */
  daemonLog?: boolean;
}

export interface HandshakeMessageStudio {
  type: "handshakeStudio";
  version?: string; // absent on plugins older than 2.0.0
  /** Quack plugin: the open place, so the hub can route this Studio to its folder */
  placeId?: number;
  placeName?: string;
  /** Per plugin load: tells this Studio apart from another one of the same place */
  session?: string;
  /** The plugin follows a `redirect` from the hub to its daemon (Quack 1.0.10 on) */
  redirect?: boolean;
  /**
   * The plugin kept tracking through a dropped connection and holds what changed meanwhile: a
   * daemon that already has this session's tree can skip the full snapshot (Quack 1.0.11 on)
   */
  resume?: boolean;
  /** "Quack log in Output" is on: the daemon sends its log lines (`daemonLog`) */
  daemonLog?: boolean;
}

/** The plugin's "Quack log in Output" switch changed while connected (sent only to a daemon whose ack said `daemonLog`) */
export interface DaemonLogOptionsMessage {
  type: "daemonLogOptions";
  enabled: boolean;
}

/** One line of the daemon's log, as Studio's Output shows it */
export interface DaemonLogLine {
  level: LogLevel;
  text: string;
}

/** The daemon's log lines since the last one of these; sent only to a Studio that asked */
export interface DaemonLogMessage {
  type: "daemonLog";
  lines: DaemonLogLine[];
  /** Lines left out of this message (a burst past the cap); the app's log has them */
  dropped?: number;
}

/**
 * Messages from Daemon → Studio
 */
export type DaemonMessage =
  | PatchScriptMessage
  | RequestSnapshotMessage
  | PongMessage
  | DaemonDisconnectMessage
  | DaemonBusyMessage
  | ErrorMessage
  | BuildSnapshotMessage
  | RequestPushConfigMessage
  | PushSnapshotMessage
  | HandshakeAckMessage
  | CreateInstanceMessage
  | DeleteInstanceMessage
  | MoveInstanceMessage
  | PlayOverlayMessage
  | ToolRequestMessage
  | DaemonLogMessage;

export interface PatchScriptMessage {
  type: "patchScript";
  guid: string;
  source: string;
}

export interface RequestSnapshotMessage {
  type: "requestSnapshot";
  options?: SnapshotRequestOptions;
}

export interface PongMessage {
  type: "pong";
}

export interface CreateInstanceMessage {
  type: "createInstance";
  className: InstanceClassName;
  name: string;
  parentPath: string[];
  source?: string;
}

export interface DeleteInstanceMessage {
  type: "deleteInstance";
  guid?: string;
  path?: string[];
}

/**
 * Move/rename an existing instance (by GUID) to a new parent path and name.
 * className/source are only set when a filesystem rename implies a class
 * change (e.g. Foo.luau -> Foo.server.luau); Roblox can't change ClassName in
 * place, so the plugin recreates the instance as the new class instead of a
 * plain reparent.
 */
export interface MoveInstanceMessage {
  type: "moveInstance";
  guid: string;
  parentPath: string[];
  name: string;
  className?: InstanceClassName;
  source?: string;
}

export interface DaemonDisconnectMessage {
  type: "daemonDisconnect";
}

/** Sent to a Studio client rejected because another session already uses the daemon. */
export interface DaemonBusyMessage {
  type: "daemonBusy";
  /** Why, shown by the plugin (another Studio took the place over) */
  message?: string;
}

export interface ErrorMessage {
  type: "error";
  message: string;
}

export interface BuildSnapshotMessage {
  type: "buildSnapshot";
  data: InstanceData[];
  destructive?: boolean;
}

export interface RequestPushConfigMessage {
  type: "requestPushConfig";
}

export interface PushSnapshotMessage {
  type: "pushSnapshot";
  mappings: PushSnapshotMapping[];
}

export interface PushSnapshotMapping {
  destination: string[];
  destructive?: boolean;
  instances: InstanceData[];
}

export interface PushConfig {
  mappings: PushConfigMapping[];
  port?: number;
  debugMode?: boolean;
  deleteOrphansOnConnect?: boolean;
}

export interface PushConfigMapping {
  source: string;
  destination: string[];
  destructive?: boolean;
  rojoMode?: boolean;
  fromSourcemap?: string;
}

/**
 * Quack: `quackdev play`. The plugin swaps these into the place in edit mode, starts a playtest,
 * and restores them once Studio has copied the place; `checks` go to the play session as test
 * arguments, where the plugin confirms the copy got the branch.
 */
export interface PlayOverlayMessage {
  type: "playOverlay";
  id: string;
  patches: { guid: string; source: string }[];
  creates: { className: string; name: string; parentPath: string[]; source: string }[];
  disables: { guid: string }[];
  checks: PlayCheck[];
}

/** One thing the play session must hold: a script by path with this text hash, or turned off */
export interface PlayCheck {
  path: string[];
  hash?: string;
  disabled?: boolean;
}

/** Sent by the edit-mode plugin once the swap is restored */
export interface PlayOverlayResultMessage {
  type: "playOverlayResult";
  id: string;
  ok: boolean;
  error?: string;
  /** How long the place in edit mode held the branch's scripts */
  windowMs?: number;
  applied?: number;
  failed?: string[];
  /** The edit DataModel's stalls the restore rule saw, for the log */
  stalls?: string[];
  /** Tabs of swapped scripts the plugin closed first (an edited open tab beats the swap) */
  closedTabs?: string[];
}

/** Sent from the play session's server through the output relay */
export interface PlayVerifyMessage {
  type: "playVerify";
  id: string;
  ok: boolean;
  passed: number;
  failed: string[];
  /** Swapped scripts the game removed before the check ran: nothing to check */
  unverified?: string[];
}

/**
 * Quack: one Studio tool call (an eval, a key press, a screenshot...), sent to the edit
 * DataModel on its sync socket or to a play peer on its /studio-output socket
 */
export interface ToolRequestMessage {
  type: "toolRequest";
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

/** The answer to a toolRequest; `error` is Studio's own reason when ok is false */
export interface ToolResultMessage {
  type: "toolResult";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/**
 * The first message of a play peer's /studio-output socket (plugins from 08/11/26 on): which
 * peer it is and whether its output goes to the daemon log too. A socket that never sends it
 * is an older plugin, which answers no tool.
 */
export interface PeerHelloMessage {
  type: "peerHello";
  source: "server" | "client";
  /** The user turned on "stream solo output": the daemon log shows the play's output */
  log: boolean;
}
