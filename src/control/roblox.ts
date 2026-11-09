import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Quack: the Roblox web tools that need no Studio, run in the command's own process: the engine
 * reference (create.roblox.com's .md pages, cached on disk since each command is a new process),
 * the Creator Store search, an asset's details and thumbnail, and an Open Cloud upload that
 * never leaves a duplicate (a local log of every upload by its file's hash; chrrxs's
 * upload_asset aborted the POST at 30 s while Roblox kept processing, gave up polling at 60 s
 * and threw a 429's operation away, so the caller's retry made a second asset).
 */

export class RobloxError extends Error {
  /** Still running on Roblox's side: the command exits as a timeout */
  pending = false;
}

/** What the tools reach the world through; tests replace each part */
export interface RobloxEnv {
  fetch: typeof fetch;
  /** %APPDATA%\quack: the docs cache, thumbnails, open-cloud.env and the upload log */
  dataDir: string;
  env: Record<string, string | undefined>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export function robloxEnv(dataDir: string, overrides: Partial<RobloxEnv> = {}): RobloxEnv {
  return {
    fetch: (...args) => fetch(...args),
    dataDir,
    env: process.env,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
    ...overrides,
  };
}

const FETCH_TIMEOUT_MS = 15_000;

async function get(env: RobloxEnv, url: string, headers: Record<string, string> = {}, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  try {
    return await env.fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const e = error as Error;
    throw new RobloxError(`${new URL(url).host} did not answer: ${e.name === "TimeoutError" ? `no answer in ${timeoutMs / 1000} s` : (e.cause as Error)?.message ?? e.message}`);
  }
}

async function getJson(env: RobloxEnv, url: string, what: string): Promise<any> {
  const response = await get(env, url, { Accept: "application/json" });
  const body = await response.text();
  if (response.status === 404) throw new RobloxError(`${what}: not found (404)`);
  if (!response.ok) throw new RobloxError(`${what}: HTTP ${response.status} ${body.slice(0, 300)}`);
  try {
    return JSON.parse(body);
  } catch {
    throw new RobloxError(`${what}: the answer is not JSON`);
  }
}

/** Write through a temporary file: a reader never sees half a file */
function writeAtomic(file: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------
// The engine reference

export const DOC_TYPES = ["classes", "enums", "datatypes", "libraries", "globals"] as const;
export type DocType = (typeof DOC_TYPES)[number];
const DOCS_BASE = "https://create.roblox.com/docs/reference/engine";
const DOC_TTL_MS = 24 * 60 * 60 * 1000;
const DOC_MISSING_TTL_MS = 5 * 60 * 1000;
export const DOC_MAX_CHARS = 50_000;

const docUrl = (type: DocType, name: string) => `${DOCS_BASE}/${type}/${name}.md`;

/** Every page of the reference, from its index page (cached a day) */
async function docIndex(env: RobloxEnv): Promise<{ type: DocType; name: string }[]> {
  const file = path.join(env.dataDir, "cache", "docs", "_index.json");
  const cached = readJson(file);
  if (cached && Array.isArray(cached.pages) && env.now() - cached.fetchedAt < DOC_TTL_MS) return cached.pages;
  const response = await get(env, DOCS_BASE, { Accept: "text/html" });
  if (!response.ok) throw new RobloxError(`the reference's index: HTTP ${response.status}`);
  const html = await response.text();
  const seen = new Map<string, { type: DocType; name: string }>();
  for (const m of html.matchAll(/reference\/engine\/(classes|enums|datatypes|libraries|globals)\/([A-Za-z0-9_]+)/g)) {
    seen.set(`${m[1]}/${m[2]}`, { type: m[1] as DocType, name: m[2] });
  }
  const pages = [...seen.values()];
  if (!pages.length) throw new RobloxError("the reference's index lists no page");
  writeAtomic(file, JSON.stringify({ fetchedAt: env.now(), pages }));
  return pages;
}

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length];
}

/** The pages nearest a name (edit distance, a prefix or a part counting extra) */
export function nearestDocs(pages: { type: DocType; name: string }[], name: string, type: DocType | undefined, count = 5) {
  const wanted = normalize(name);
  return pages
    .map((page) => {
      const candidate = normalize(page.name);
      const ratio = 1 - editDistance(wanted, candidate) / Math.max(wanted.length, candidate.length, 1);
      const bonus = (wanted.startsWith(candidate) || candidate.startsWith(wanted) ? 0.15 : 0) + (wanted.includes(candidate) || candidate.includes(wanted) ? 0.05 : 0);
      return { page, score: (wanted === candidate ? 2 : ratio + bonus) + (page.type === type ? 0.08 : 0) };
    })
    .sort((a, b) => b.score - a.score || a.page.name.localeCompare(b.page.name))
    .slice(0, count)
    .map((s) => s.page);
}

/** One page's text, from the disk cache (a day; a 404 five minutes) or the site */
async function docPage(env: RobloxEnv, type: DocType, name: string): Promise<string | undefined> {
  const file = path.join(env.dataDir, "cache", "docs", `${type}__${name}.json`);
  const cached = readJson(file);
  if (cached && env.now() - cached.fetchedAt < (cached.missing ? DOC_MISSING_TTL_MS : DOC_TTL_MS)) return cached.missing ? undefined : cached.text;
  const response = await get(env, docUrl(type, name), { Accept: "text/markdown, text/plain" });
  if (response.status === 404) {
    writeAtomic(file, JSON.stringify({ fetchedAt: env.now(), missing: true }));
    return undefined;
  }
  if (!response.ok) throw new RobloxError(`${type}/${name}: HTTP ${response.status}`);
  const text = await response.text();
  writeAtomic(file, JSON.stringify({ fetchedAt: env.now(), text }));
  return text;
}

/** The `## ` headings of a page */
export function docSections(markdown: string): string[] {
  return [...markdown.matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => m[1]);
}

/** One `## ` section with its `###` blocks, by name (any case) */
export function docSection(markdown: string, section: string): string | undefined {
  const lines = markdown.split("\n");
  const wanted = section.trim().toLowerCase();
  const start = lines.findIndex((line) => /^##\s+/.test(line) && !/^###/.test(line) && line.replace(/^##\s+/, "").trim().toLowerCase() === wanted);
  if (start < 0) return undefined;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##?\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trimEnd();
}

export interface MemberSecurity {
  member: string;
  kind: string;
  read?: string;
  write?: string;
  security?: string;
}

/**
 * Each member's security level: a property's JSON block carries "security": {read, write}, a
 * method's, event's or callback's "*Security: X · Thread Safety: Y*" line. "None" is open to
 * any script; PluginSecurity needs a plugin (or the command bar); RobloxScriptSecurity and
 * above, Roblox's own scripts.
 */
export function docSecurity(markdown: string): MemberSecurity[] {
  const out: MemberSecurity[] = [];
  const lines = markdown.split("\n");
  let current: MemberSecurity | undefined;
  let inJson = false;
  let json = "";
  for (const line of lines) {
    const head = /^###\s+(Property|Method|Event|Callback|Function):\s+(.+?)\s*$/.exec(line);
    if (head) {
      current = { member: head[2], kind: head[1].toLowerCase() };
      out.push(current);
      inJson = false;
      continue;
    }
    if (/^##?#?\s/.test(line)) {
      current = undefined;
      continue;
    }
    if (!current) continue;
    if (current.kind === "property") {
      if (!inJson && /^```json\s*$/.test(line) && current.read === undefined) {
        inJson = true;
        json = "";
        continue;
      }
      if (inJson && /^```\s*$/.test(line)) {
        inJson = false;
        try {
          const security = JSON.parse(json).security;
          if (typeof security === "string") current.read = current.write = security;
          else if (security && typeof security === "object") {
            current.read = security.read;
            current.write = security.write;
          }
        } catch {
          // a block that is not the member's JSON
        }
        continue;
      }
      if (inJson) json += `${line}\n`;
      continue;
    }
    const level = /^\*Security:\s*([A-Za-z]+)/.exec(line);
    if (level && current.security === undefined) current.security = level[1];
  }
  return out.filter((m) => m.read !== undefined || m.security !== undefined);
}

function securityText(members: MemberSecurity[]): string {
  if (!members.length) return "";
  const guarded = members.filter((m) => (m.security ?? "None") !== "None" || (m.read ?? "None") !== "None" || (m.write ?? "None") !== "None");
  if (!guarded.length) return `Security: all ${members.length} members here are open to any script (None).`;
  const lines = guarded.map((m) =>
    m.kind === "property"
      ? `  ${m.member} (property): read ${m.read ?? "?"}, write ${m.write ?? "?"}`
      : `  ${m.member} (${m.kind}): ${m.security}`);
  return [`Security: ${guarded.length} of ${members.length} members need more than a game script (None is any script; PluginSecurity a plugin or the command bar; RobloxScriptSecurity and up, Roblox only):`, ...lines].join("\n");
}

export interface DocAnswer {
  type: DocType;
  name: string;
  url: string;
  text: string;
  sections: string[];
  truncated: boolean;
  security: MemberSecurity[];
  /** Not found: the nearest pages instead */
  suggestions?: { type: DocType; name: string }[];
}

/**
 * A page of the engine reference by its name (Instance, TweenService, Enum.KeyCode, Color3,
 * task): the type is found from the reference's index when not given. `section` keeps one
 * `## ` section. Long pages stop at 50,000 characters with the list of sections.
 */
export async function robloxDocs(env: RobloxEnv, args: { name: string; type?: string; section?: string }): Promise<DocAnswer> {
  let name = args.name.trim();
  let type = args.type as DocType | undefined;
  if (type !== undefined && !DOC_TYPES.includes(type)) throw new RobloxError(`type must be one of ${DOC_TYPES.join(", ")}`);
  const enumName = /^Enum\.([A-Za-z0-9_]+)$/.exec(name);
  if (enumName) {
    name = enumName[1];
    type ??= "enums";
  }
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new RobloxError("name must be one reference page's name, like TweenService, KeyCode, Color3 or task");
  let pages: { type: DocType; name: string }[] | undefined;
  if (!type) {
    try {
      pages = await docIndex(env);
    } catch {
      pages = undefined;
    }
    const order = (t: DocType) => DOC_TYPES.indexOf(t);
    const exact = pages?.filter((p) => p.name === name).sort((a, b) => order(a.type) - order(b.type))[0]
      ?? pages?.filter((p) => p.name.toLowerCase() === name.toLowerCase()).sort((a, b) => order(a.type) - order(b.type))[0];
    if (exact) {
      type = exact.type;
      name = exact.name;
    } else if (pages) {
      return { type: "classes", name, url: docUrl("classes", name), text: "", sections: [], truncated: false, security: [], suggestions: nearestDocs(pages, name, undefined) };
    } else type = "classes";
  }
  const markdown = await docPage(env, type, name);
  if (markdown === undefined) {
    pages ??= await docIndex(env).catch(() => []);
    return { type, name, url: docUrl(type, name), text: "", sections: [], truncated: false, security: [], suggestions: nearestDocs(pages, name, type) };
  }
  const sections = docSections(markdown);
  let text = markdown;
  if (args.section) {
    const one = docSection(markdown, args.section);
    if (one === undefined) throw new RobloxError(`${type}/${name} has no section "${args.section}"; its sections: ${sections.join(", ") || "(none)"}`);
    text = one;
  }
  const security = docSecurity(text);
  let truncated = false;
  if (text.length > DOC_MAX_CHARS) {
    text = `${text.slice(0, DOC_MAX_CHARS)}\n\n---\n[Cut at ${DOC_MAX_CHARS} of ${markdown.length} characters: ask for one section to read it whole. Sections: ${sections.join(", ")}]`;
    truncated = true;
  }
  return { type, name, url: docUrl(type, name), text, sections, truncated, security };
}

export function docsText(answer: DocAnswer): string {
  if (answer.suggestions) {
    const near = answer.suggestions.map((p) => `  ${p.name} (${p.type})`).join("\n");
    return `No reference page ${answer.type}/${answer.name}. Names are PascalCase, as in the engine (TweenService, KeyCode). Nearest:\n${near || "  (the reference's index could not be read)"}`;
  }
  const security = securityText(answer.security);
  return [`${answer.url}`, ...(security ? [security] : []), "", answer.text].join("\n");
}

// ---------------------------------------------------------------------------------------
// The Creator Store

const TOOLBOX = "https://apis.roblox.com/toolbox-service/v2";
export const SEARCH_TYPES = ["Model", "Decal", "Image", "Audio", "MeshPart", "Video", "Plugin", "FontFamily", "Particle", "VFX"] as const;
export const SEARCH_SORTS = ["Relevance", "Trending", "Top", "AudioDuration", "CreateTime", "UpdatedTime", "Ratings"] as const;

/** Image is searched as Decal; Particle and VFX as Models with the words that find them */
export function searchQuery(type: string, query: string | undefined): { category: string; query?: string } {
  const q = query?.trim() || undefined;
  if (type === "Image") return { category: "Decal", query: q };
  if (type === "Particle" || type === "VFX") {
    const suffix = type === "Particle" ? "particle effect" : "VFX";
    return { category: "Model", query: q ? (/\b(particle|vfx|effect)\b/i.test(q) ? q : `${q} ${suffix}`) : suffix };
  }
  return { category: type, query: q };
}

/** One store entry, short: what an AI needs to pick one (who made it, scripts, price, votes) */
function storeEntry(entry: any) {
  const asset = entry?.asset ?? {};
  const description = String(asset.description ?? "").replace(/\s+/g, " ").trim();
  const price = entry?.creatorStoreProduct?.purchasePrice?.quantity;
  const cost = price && typeof price.significand === "number" ? price.significand * 10 ** (price.exponent ?? 0) : 0;
  return {
    assetId: asset.id,
    name: asset.name,
    creator: entry?.creator?.name,
    ...(entry?.creator?.verified ? { verified: true } : {}),
    ...(cost > 0 ? { priceUsd: Math.round(cost * 100) / 100 } : {}),
    ...(typeof entry?.voting?.upVotePercent === "number" && entry.voting.voteCount ? { upVotePercent: entry.voting.upVotePercent, votes: entry.voting.voteCount } : {}),
    ...(asset.hasScripts ? { scripts: asset.scriptCount ?? true } : {}),
    ...(asset.objectMeshSummary?.triangles ? { triangles: asset.objectMeshSummary.triangles } : {}),
    ...(asset.textureId ? { imageId: asset.textureId } : {}),
    ...(typeof asset.durationSeconds === "number" ? { duration: asset.durationSeconds } : {}),
    description: description.length > 240 ? `${description.slice(0, 239).trimEnd()}…` : description,
  };
}

export async function searchAssets(env: RobloxEnv, args: { type?: string; query?: string; limit?: number; sort?: string; robloxOnly?: boolean }) {
  const type = args.type ?? "Model";
  if (!(SEARCH_TYPES as readonly string[]).includes(type)) throw new RobloxError(`type must be one of ${SEARCH_TYPES.join(", ")}`);
  if (args.sort !== undefined && !(SEARCH_SORTS as readonly string[]).includes(args.sort)) throw new RobloxError(`sort must be one of ${SEARCH_SORTS.join(", ")}`);
  const limit = args.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RobloxError("limit must be a whole number from 1 to 100");
  const { category, query } = searchQuery(type, args.query);
  const url = new URL(`${TOOLBOX}/assets:search`);
  url.searchParams.set("searchCategoryType", category);
  if (query) url.searchParams.set("query", query);
  url.searchParams.set("maxPageSize", String(limit));
  if (args.sort) url.searchParams.set("sortCategory", args.sort);
  if (args.robloxOnly) url.searchParams.set("userId", "1");
  const body = await getJson(env, url.toString(), "the Creator Store search");
  const results = (Array.isArray(body?.creatorStoreAssets) ? body.creatorStoreAssets : []).map(storeEntry).filter((r: any) => Number.isSafeInteger(r.assetId) && r.assetId > 0);
  return { type, query: query ?? "", ...(category !== type ? { searchedAs: category } : {}), total: body?.totalResults ?? results.length, results };
}

export function searchText(result: Awaited<ReturnType<typeof searchAssets>>): string {
  const lines = [`${result.results.length} of ${result.total} ${result.type} results for "${result.query}"${result.searchedAs ? ` (searched as ${result.searchedAs})` : ""}:`];
  for (const r of result.results as any[]) {
    const facts = [
      `by ${r.creator ?? "?"}${r.verified ? " (verified)" : ""}`,
      r.priceUsd ? `$${r.priceUsd}` : "free",
      r.upVotePercent !== undefined ? `${r.upVotePercent}% of ${r.votes} votes` : "",
      r.scripts ? `${r.scripts === true ? "has" : r.scripts} script(s)` : "",
      r.triangles ? `${r.triangles} triangles` : "",
      r.imageId ? `image ${r.imageId}` : "",
      r.duration !== undefined ? `${r.duration} s` : "",
    ].filter(Boolean).join(", ");
    lines.push(`${r.assetId}  ${r.name}  (${facts})${r.description ? `\n    ${r.description}` : ""}`);
  }
  return lines.join("\n");
}

const assetId = (raw: unknown): number => {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw new RobloxError("the asset id must be a whole number above 0");
  return id;
};

export async function assetDetails(env: RobloxEnv, id: unknown) {
  const n = assetId(id);
  const body = await getJson(env, `${TOOLBOX}/assets/${n}`, `asset ${n} on the Creator Store`);
  return { ...storeEntry(body), ...(body?.asset ? { raw: body } : {}) };
}

export function detailsText(d: any): string {
  const a = d.raw?.asset ?? {};
  const lines = [`${d.assetId}  ${d.name}  by ${d.creator ?? "?"}${d.verified ? " (verified)" : ""}, ${d.priceUsd ? `$${d.priceUsd}` : "free"}`];
  if (a.assetTypeId !== undefined) lines.push(`  asset type id ${a.assetTypeId}${a.categoryPath ? `, ${a.categoryPath}` : ""}`);
  if (d.upVotePercent !== undefined) lines.push(`  ${d.upVotePercent}% of ${d.votes} votes up`);
  if (a.hasScripts) lines.push(`  ${a.scriptCount ?? "some"} script(s): preview_asset lists them before an insert`);
  if (a.instanceCounts) lines.push(`  instances: ${Object.entries(a.instanceCounts).filter(([, n]) => Number(n) > 0).map(([k, n]) => `${k} ${n}`).join(", ") || "none counted"}`);
  if (a.objectMeshSummary) lines.push(`  mesh: ${a.objectMeshSummary.triangles} triangles, ${a.objectMeshSummary.vertices} vertices`);
  if (d.imageId) lines.push(`  image id ${d.imageId}`);
  if (a.createTime) lines.push(`  created ${a.createTime}, updated ${a.updateTime ?? "?"}`);
  if (d.description) lines.push(`  ${d.description}`);
  return lines.join("\n");
}

export const THUMBNAIL_SIZES = ["150x150", "420x420", "768x432"] as const;
const THUMBNAILS_KEPT = 50;

/** An asset's thumbnail as a PNG on disk; a Pending one is asked again a few times */
export async function assetThumbnail(env: RobloxEnv, args: { id: unknown; size?: string }) {
  const n = assetId(args.id);
  const size = args.size ?? "420x420";
  if (!(THUMBNAIL_SIZES as readonly string[]).includes(size)) throw new RobloxError(`size must be one of ${THUMBNAIL_SIZES.join(", ")}`);
  let entry: any;
  for (let attempt = 0; attempt < 6; attempt++) {
    const body = await getJson(env, `https://thumbnails.roblox.com/v1/assets?assetIds=${n}&size=${size}&format=Png`, `the thumbnail of ${n}`);
    entry = body?.data?.[0];
    if (entry?.state !== "Pending") break;
    await env.sleep(1500);
  }
  if (!entry) throw new RobloxError(`Roblox has no thumbnail of asset ${n}`);
  if (entry.state !== "Completed" || typeof entry.imageUrl !== "string") {
    throw new RobloxError(`the thumbnail of ${n} is ${entry.state ?? "not ready"}${entry.state === "Pending" ? " after 6 tries: try again in a moment" : entry.state === "Blocked" ? " (moderated)" : ""}`);
  }
  const image = await get(env, entry.imageUrl, { Accept: "image/png" });
  if (!image.ok) throw new RobloxError(`the thumbnail of ${n} could not be downloaded: HTTP ${image.status}`);
  const png = Buffer.from(await image.arrayBuffer());
  const dir = path.join(env.dataDir, "thumbnails");
  const file = path.join(dir, `asset-${n}-${size}.png`);
  writeAtomic(file, png);
  try {
    const kept = fs.readdirSync(dir).filter((f) => f.endsWith(".png")).map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const old of kept.slice(THUMBNAILS_KEPT)) fs.rmSync(path.join(dir, old.f), { force: true });
  } catch {
    // a folder someone else cleans is fine
  }
  return { assetId: n, size, file, bytes: png.length };
}

// ---------------------------------------------------------------------------------------
// Open Cloud upload

export const UPLOAD_TYPES: Record<string, Record<string, string>> = {
  Decal: { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", bmp: "image/bmp", tga: "image/tga" },
  Audio: { mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", flac: "audio/flac" },
  Model: { fbx: "model/fbx", gltf: "model/gltf+json", glb: "model/gltf-binary", rbxm: "model/x-rbxm", rbxmx: "model/x-rbxm" },
  Animation: { rbxm: "model/x-rbxm", rbxmx: "model/x-rbxm" },
  Video: { mp4: "video/mp4", mov: "video/mov" },
};

const CLOUD = "https://apis.roblox.com/assets/v1";
/** A POST is never cut short by us before Roblox answers: an abort is how duplicates were made */
const POST_TIMEOUT_MS = 180_000;
const POLL_DEADLINE_MS = 5 * 60_000;

/** KEY=value lines, # comments, optional quotes */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[m[1]] = value;
  }
  return out;
}

/** The key and the creator: the environment first, then open-cloud.env in the data folder */
export function cloudCredentials(env: RobloxEnv, given: { userId?: string; groupId?: string } = {}) {
  const fileName = path.join(env.dataDir, "open-cloud.env");
  let file: Record<string, string> = {};
  try {
    file = parseEnvFile(fs.readFileSync(fileName, "utf8"));
  } catch {
    // no file: the environment only
  }
  const pick = (key: string) => (env.env[key]?.trim() || file[key]?.trim() || undefined);
  const key = pick("ROBLOX_OPEN_CLOUD_API_KEY");
  const groupId = given.groupId ?? (given.userId ? undefined : pick("ROBLOX_CREATOR_GROUP_ID"));
  const userId = groupId ? undefined : (given.userId ?? pick("ROBLOX_CREATOR_USER_ID"));
  for (const [name, value] of [["user", userId], ["group", groupId]] as const) {
    if (value !== undefined && !/^\d+$/.test(value)) throw new RobloxError(`the creator ${name} id must be a number, not "${value}"`);
  }
  return { key, userId, groupId, fileName };
}

interface UploadEntry {
  state: "posting" | "pending" | "done" | "failed";
  at: string;
  file: string;
  assetType: string;
  displayName: string;
  creator: string;
  operationId?: string;
  assetId?: string;
  imageId?: string;
  error?: string;
}

const logFile = (env: RobloxEnv) => path.join(env.dataDir, "uploads.json");

function readLog(env: RobloxEnv): Record<string, UploadEntry> {
  const log = readJson(logFile(env));
  return log && typeof log.entries === "object" && log.entries ? log.entries : {};
}

/** One entry changed in the log, read again just before the write (another command may have written) */
function writeLog(env: RobloxEnv, key: string, entry: UploadEntry | undefined): void {
  const entries = readLog(env);
  if (entry) entries[key] = entry;
  else delete entries[key];
  writeAtomic(logFile(env), JSON.stringify({ version: 1, entries }, null, 2));
}

/** Fields changed on the entry the log holds now */
function patchLog(env: RobloxEnv, key: string, fields: Partial<UploadEntry>): void {
  const entry = readLog(env)[key];
  if (entry) writeLog(env, key, { ...entry, ...fields });
}

/** Remember the image id a decal resolved to, so the next run of the same upload has it too */
export function rememberImageId(env: RobloxEnv, key: string, imageId: string): void {
  patchLog(env, key, { imageId });
}

export interface UploadAnswer {
  assetId?: string;
  operationId?: string;
  assetType: string;
  displayName: string;
  creator: string;
  file: string;
  sha256: string;
  key: string;
  /** done: the same upload was made before; resumed: an earlier one was still processing */
  reused?: "done" | "resumed";
  imageId?: string;
  pending?: boolean;
}

/**
 * An asset uploaded through Open Cloud (POST /assets/v1/assets, then its operation polled). Every
 * upload is logged by the file's sha256, its type, name and creator: the same upload again
 * answers the asset it made, or resumes polling its operation, instead of posting a second
 * one. `force` posts anyway. A POST that got no answer (cut, 5xx) may still have made the asset:
 * it is not sent again without force.
 */
export async function uploadAsset(env: RobloxEnv, args: { file: string; assetType: string; displayName: string; description?: string; userId?: string; groupId?: string; force?: boolean }): Promise<UploadAnswer> {
  const mimes = UPLOAD_TYPES[args.assetType];
  if (!mimes) throw new RobloxError(`type must be one of ${Object.keys(UPLOAD_TYPES).join(", ")}`);
  const ext = path.extname(args.file).slice(1).toLowerCase();
  const mime = mimes[ext];
  if (!mime) throw new RobloxError(`${/^[AEIOU]/.test(args.assetType) ? "an" : "a"} ${args.assetType} is uploaded from ${Object.keys(mimes).map((e) => `.${e}`).join(", ")}, not .${ext || "(none)"}`);
  if (!args.displayName?.trim()) throw new RobloxError("name is required: the asset's display name on Roblox");
  if (args.displayName.length > 50) throw new RobloxError("the display name is at most 50 characters");
  let data: Buffer;
  try {
    data = fs.readFileSync(args.file);
  } catch (error) {
    throw new RobloxError(`cannot read ${args.file}: ${(error as Error).message}`);
  }
  const creds = cloudCredentials(env, { userId: args.userId, groupId: args.groupId });
  if (!creds.key) throw new RobloxError(`no Open Cloud key: set ROBLOX_OPEN_CLOUD_API_KEY (a key with asset:read and asset:write), or put ROBLOX_OPEN_CLOUD_API_KEY=... in ${creds.fileName}`);
  if (!creds.userId && !creds.groupId) throw new RobloxError(`no creator: set ROBLOX_CREATOR_USER_ID or ROBLOX_CREATOR_GROUP_ID (in the environment or ${creds.fileName}), or give a user or group id`);
  const apiKey = creds.key;
  const scrub = (text: string) => text.split(apiKey).join("***");
  const creator = creds.groupId ? `group ${creds.groupId}` : `user ${creds.userId}`;
  const sha256 = createHash("sha256").update(data).digest("hex");
  const key = `${sha256}|${args.assetType}|${args.displayName}|${creator}`;
  const base = { assetType: args.assetType, displayName: args.displayName, creator, file: args.file, sha256, key };
  const known = readLog(env)[key];
  const at = () => new Date(env.now()).toISOString();

  if (known && !args.force) {
    if (known.state === "done" && known.assetId) return { ...base, assetId: known.assetId, operationId: known.operationId, reused: "done", ...(known.imageId ? { imageId: known.imageId } : {}) };
    if (known.state === "pending" && known.operationId) return { ...(await poll(known.operationId)), reused: "resumed" };
    if (known.state === "posting") {
      throw new RobloxError(`this same upload was sent at ${known.at} and no answer was kept${known.error ? ` (${known.error})` : ""}: Roblox may have made the asset. Look in Creator Hub > Development Items before sending it again with force`);
    }
  }

  writeLog(env, key, { state: "posting", at: at(), file: args.file, assetType: args.assetType, displayName: args.displayName, creator });
  const request = {
    assetType: args.assetType,
    displayName: args.displayName,
    description: args.description ?? "",
    creationContext: { creator: creds.groupId ? { groupId: creds.groupId } : { userId: creds.userId } },
  };
  let operation: any;
  for (let attempt = 1; ; attempt++) {
    const form = new FormData();
    form.append("request", JSON.stringify(request));
    form.append("fileContent", new Blob([new Uint8Array(data)], { type: mime }), path.basename(args.file));
    let response: Response;
    try {
      response = await env.fetch(`${CLOUD}/assets`, { method: "POST", headers: { "x-api-key": apiKey }, body: form, signal: AbortSignal.timeout(POST_TIMEOUT_MS) });
    } catch (error) {
      const why = scrub((error as Error).name === "TimeoutError" ? `no answer in ${POST_TIMEOUT_MS / 1000} s` : ((error as Error).cause as Error)?.message ?? (error as Error).message);
      patchLog(env, key, { state: "posting", error: why });
      throw new RobloxError(`the upload was sent but Roblox did not answer (${why}): it may still make the asset. Look in Creator Hub > Development Items before sending it again with force`);
    }
    const text = scrub(await response.text().catch(() => ""));
    if (response.status === 429 && attempt < 5) {
      // Refused before anything was made: safe to send again after the wait Roblox asks for
      const after = Number(response.headers.get("retry-after"));
      await env.sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 60) * 1000 : 2000 * attempt);
      continue;
    }
    if (response.status >= 500) {
      patchLog(env, key, { state: "posting", error: `HTTP ${response.status}` });
      throw new RobloxError(`Roblox answered the upload with HTTP ${response.status} ${text.slice(0, 200)}: it may still make the asset. Look in Creator Hub > Development Items before sending it again with force`);
    }
    if (!response.ok) {
      // Refused: nothing was made; an earlier upload the log knew stays known
      writeLog(env, key, known);
      const hint = response.status === 401 ? " (the key is wrong or expired)" : response.status === 403 ? " (the key lacks asset:write, or this creator)" : "";
      throw new RobloxError(`Roblox refused the upload: HTTP ${response.status}${hint} ${text.slice(0, 400)}`);
    }
    try {
      operation = JSON.parse(text);
    } catch {
      operation = {};
    }
    break;
  }
  const operationId = String(operation.operationId ?? String(operation.path ?? "").split("/").pop() ?? "");
  if (operation.done && operation.response?.assetId) {
    writeLog(env, key, { state: "done", at: at(), file: args.file, assetType: args.assetType, displayName: args.displayName, creator, operationId, assetId: String(operation.response.assetId) });
    return { ...base, operationId, assetId: String(operation.response.assetId) };
  }
  if (!operationId) {
    patchLog(env, key, { state: "posting", error: "no operation id in the answer" });
    throw new RobloxError(`Roblox took the upload but its answer named no operation: ${JSON.stringify(operation).slice(0, 300)}`);
  }
  writeLog(env, key, { state: "pending", at: at(), file: args.file, assetType: args.assetType, displayName: args.displayName, creator, operationId });
  return poll(operationId);

  /** The operation until done, with backoff; a 429, a 5xx or a dropped connection is waited out */
  async function poll(operationId: string): Promise<UploadAnswer> {
    const deadline = env.now() + POLL_DEADLINE_MS;
    let wait = 1000;
    let last = "";
    for (;;) {
      let result: any;
      try {
        const response = await env.fetch(`${CLOUD}/operations/${encodeURIComponent(operationId)}`, { headers: { "x-api-key": apiKey }, signal: AbortSignal.timeout(30_000) });
        const text = scrub(await response.text().catch(() => ""));
        if (response.ok) result = JSON.parse(text);
        else if (response.status === 429 || response.status >= 500) last = `HTTP ${response.status}`;
        else throw new RobloxError(`Roblox answered the operation ${operationId} with HTTP ${response.status} ${text.slice(0, 300)}`);
      } catch (error) {
        if (error instanceof RobloxError) throw error;
        last = scrub((error as Error).message);
      }
      if (result?.done) {
        if (result.response?.assetId) {
          const assetId = String(result.response.assetId);
          patchLog(env, key, { state: "done", operationId, assetId, error: undefined });
          return { ...base, operationId, assetId };
        }
        const why = result.error?.message ?? JSON.stringify(result).slice(0, 300);
        patchLog(env, key, { state: "failed", operationId, error: why });
        throw new RobloxError(`Roblox did not make the asset: ${scrub(String(why))}`);
      }
      if (env.now() + wait > deadline) {
        const error = new RobloxError(`the upload is still processing on Roblox after ${POLL_DEADLINE_MS / 60_000} min (operation ${operationId}${last ? `, last poll: ${last}` : ""}): run the same upload again to keep waiting for it, without posting another`);
        error.pending = true;
        throw error;
      }
      await env.sleep(wait);
      wait = Math.min(Math.round(wait * 1.6), 10_000);
    }
  }
}

export const imageIdLua = (decalId: string) => `local InsertService = game:GetService("InsertService")
local ok, model = pcall(function() return InsertService:LoadAsset(${Number(decalId)}) end)
if not ok then return "error: " .. tostring(model) end
local decal = model:FindFirstChildWhichIsA("Decal", true)
local texture = if decal then decal.Texture else ""
model:Destroy()
return string.match(texture, "%d+") or "error: the asset holds no Decal"`;
