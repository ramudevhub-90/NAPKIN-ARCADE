// Data layer: one DynamoDB table (single-table design) + S3 for game payloads.
//   USER#<sub>      PROFILE                 email, name, build/revision counters
//   USER#<sub>      CIRCLE#<email>          someone the creator shares circle-only games with
//   MEMBER#<email>  OWNER#<sub>             reverse link: whose circles this email is in
//   GROUP#<gid>     META                    name, about, owner, code (join link), members count
//   GROUP#<gid>     MEMBER#<sub>            name, email, role (owner | member)
//   GROUP#<gid>     GAME#<id>               a game shared with the group
//   USER#<sub>      GROUP#<gid>             the groups a person belongs to
//   JOIN#<code>     GROUP                   join-link lookup
//   TOUR#<tid>      META                    name, host, game, startsAt/endsAt, prize, access (link | group), code
//   TOUR#<tid>      ENTRY#<sub>             an entrant and their best run
//   USER#<sub>      TOUR#<tid>              tournaments a person hosts or entered
//   TJOIN#<code>    TOUR                    tournament link lookup
//   USER#<sub>      CONNECT#google|apple    sealed store credentials (Play service account / App Store Connect key)
//   GAME#<id>       STOREAPP                Play package name and iOS bundle id
//   GAME#<id>       KEYSTORE                sealed Android upload key (made on the first release)
//   GAME#<id>       RELEASE#<rid>           a store release: platform, version, state, timeline
//   RELEASE#<rid>   PTR                     release → game lookup for the build runner
//   GAME#<id>       META                    owner, title, version, status, visibility, changelog… (GSI1: OWNER#<sub>, GSI2: GALLERY when public)
//   GAME#<id>       VERSION#0001            summary, score, at (payload in S3: games/<id>/v1.json)
//   GAME#<id>       CHAT#<ts>#<rand>        role, text, version…
//   GAME#<id>       FEEDBACK#<id>           text, name, kind (bug|idea), status, reports
//   GAME#<id>       LB#<period>#<country>#<inverted>#<ts>   leaderboard entry; period ALL | W2026-44 | M2026-10,
//                                           country ALL or ISO code (each score is written to every board it counts on)
//   GAME#<id>       TASK#<taskId>           browser task result (TTL)
//   SPEND           TOTAL                   AI spend counter (hard cap)
import crypto from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

const TABLE = process.env.TABLE, BUCKET = process.env.BUCKET;
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const s3 = new S3Client({});
const today = () => new Date().toISOString().slice(0, 10);
export const newId = (n = 4) => crypto.randomBytes(n).toString("hex");
const pad = (v) => String(v).padStart(4, "0");

export const getItem = async (pk, sk) => (await db.send(new GetCommand({ TableName: TABLE, Key: { pk, sk } }))).Item || null;
export const putItem = (item) => db.send(new PutCommand({ TableName: TABLE, Item: item }));
export const deleteItem = (pk, sk) => db.send(new DeleteCommand({ TableName: TABLE, Key: { pk, sk } }));
async function queryPrefix(pk, prefix, { limit, forward = true } = {}) {
  const out = await db.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: "pk = :p AND begins_with(sk, :s)", ExpressionAttributeValues: { ":p": pk, ":s": prefix }, ScanIndexForward: forward, Limit: limit }));
  return out.Items || [];
}

// ---- users ----
export async function getUser(sub) { return getItem(`USER#${sub}`, "PROFILE"); }
export async function ensureUser(sub, email, name) {
  const u = await getUser(sub);
  if (u) return u;
  const item = { pk: `USER#${sub}`, sk: "PROFILE", sub, email, name: name || email.split("@")[0], createdAt: new Date().toISOString() };
  await putItem(item);
  return item;
}
// Atomic daily counter with a limit (builds or revisions).
export async function charge(sub, kind, limit) {
  const day = today();
  try {
    await db.send(new UpdateCommand({
      TableName: TABLE, Key: { pk: `USER#${sub}`, sk: "PROFILE" },
      UpdateExpression: `SET #d = :day, #n = if_not_exists(#n, :z) + :one`,
      ConditionExpression: `attribute_not_exists(#d) OR #d <> :day OR #n < :lim`,
      ExpressionAttributeNames: { "#d": `${kind}Day`, "#n": `${kind}Count` },
      ExpressionAttributeValues: { ":day": day, ":z": 0, ":one": 1, ":lim": limit },
    }));
  } catch (e) {
    if (e.name === "ConditionalCheckFailedException") {
      // New day: reset the counter.
      const u = await getUser(sub);
      if (u && u[`${kind}Day`] !== day) { await db.send(new UpdateCommand({ TableName: TABLE, Key: { pk: `USER#${sub}`, sk: "PROFILE" }, UpdateExpression: `SET #d = :day, #n = :one`, ExpressionAttributeNames: { "#d": `${kind}Day`, "#n": `${kind}Count` }, ExpressionAttributeValues: { ":day": day, ":one": 1 } })); return; }
      throw Object.assign(new Error(kind === "build" ? `You've used today's ${limit} game builds. Come back tomorrow!` : "You've used today's game changes. Come back tomorrow!"), { status: 429 });
    }
    throw e;
  }
}
export const countToday = (u, kind) => (u?.[`${kind}Day`] === today() ? u[`${kind}Count`] || 0 : 0);

// ---- games ----
export const getGame = (id) => getItem(`GAME#${id}`, "META");
export async function putGameMeta(meta) {
  const item = { ...meta, pk: `GAME#${meta.id}`, sk: "META", GSI1PK: `OWNER#${meta.owner}`, GSI1SK: meta.createdAt };
  if (meta.status === "ready" && !meta.hidden && (meta.visibility || "public") === "public") { item.GSI2PK = "GALLERY"; item.GSI2SK = meta.createdAt; }
  await putItem(item);
  return item;
}
export async function updateGame(id, fields) {
  const names = {}, values = {}, sets = [];
  for (const [k, v] of Object.entries(fields)) { names[`#${k}`] = k; values[`:${k}`] = v; sets.push(`#${k} = :${k}`); }
  await db.send(new UpdateCommand({ TableName: TABLE, Key: { pk: `GAME#${id}`, sk: "META" }, UpdateExpression: `SET ${sets.join(", ")}`, ExpressionAttributeNames: names, ExpressionAttributeValues: values }));
}
// Who can play: "public" (everyone, listed in the gallery), "circle" (the creator's circle only)
// or "group" (members of one group).
export async function setVisibility(id, visibility, groupId = null) {
  const { pk, sk, GSI1PK, GSI1SK, GSI2PK, GSI2SK, ...meta } = await getGame(id);
  if (meta.groupId && meta.groupId !== groupId) await deleteItem(`GROUP#${meta.groupId}`, `GAME#${id}`);
  if (visibility === "group") await putItem({ pk: `GROUP#${groupId}`, sk: `GAME#${id}`, id, owner: meta.owner, at: new Date().toISOString() });
  const { groupId: _, ...rest } = meta;
  await putGameMeta({ ...rest, visibility, ...(visibility === "group" ? { groupId } : {}) });
}
export async function myGames(sub) {
  const out = await db.send(new QueryCommand({ TableName: TABLE, IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :p", ExpressionAttributeValues: { ":p": `OWNER#${sub}` }, ScanIndexForward: false, Limit: 50 }));
  return out.Items || [];
}
export async function gallery(limit = 24) {
  const out = await db.send(new QueryCommand({ TableName: TABLE, IndexName: "GSI2", KeyConditionExpression: "GSI2PK = :p", ExpressionAttributeValues: { ":p": "GALLERY" }, ScanIndexForward: false, Limit: limit }));
  return out.Items || [];
}

// Game payloads (code, models, tuning) live in S3: every version privately, and the published
// (live) one also under public/ — players only ever load the live version.
const putJson = (Key, obj, extra = {}) => s3.send(new PutObjectCommand({ Bucket: BUCKET, Key, Body: Buffer.from(JSON.stringify(obj), "utf8"), ContentType: "application/json", ...extra }));
export const putVersionPayload = (id, v, payload) => putJson(`games/${id}/v${v}.json`, payload);
export const putLivePayload = (id, payload) => putJson(`public/games/${id}.json`, payload, { CacheControl: "no-cache" });
export async function getPayload(id, v) {
  const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: v ? `games/${id}/v${v}.json` : `public/games/${id}.json` }));
  return JSON.parse(await r.Body.transformToString());
}
export async function putDrawing(id, dataUrl) {
  const m = /^data:(image\/[a-z+]+);base64,(.*)$/.exec(dataUrl || "");
  if (!m) return false;
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: `drawings/${id}`, Body: Buffer.from(m[2], "base64"), ContentType: m[1] }));
  return true;
}
export async function getDrawing(id) {
  const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: `drawings/${id}` }));
  return `data:${r.ContentType};base64,${Buffer.from(await r.Body.transformToByteArray()).toString("base64")}`;
}

// ---- circles: the people a creator shares circle-only games with ----
export const circle = (sub) => queryPrefix(`USER#${sub}`, "CIRCLE#");
export const inCircle = async (ownerSub, email) => !!email && !!(await getItem(`USER#${ownerSub}`, `CIRCLE#${email.toLowerCase()}`));
export async function addToCircle(owner, email) {
  const at = new Date().toISOString();
  await putItem({ pk: `USER#${owner.sub}`, sk: `CIRCLE#${email}`, email, at });
  await putItem({ pk: `MEMBER#${email}`, sk: `OWNER#${owner.sub}`, ownerSub: owner.sub, ownerName: owner.name, at });
}
export async function removeFromCircle(ownerSub, email) {
  await deleteItem(`USER#${ownerSub}`, `CIRCLE#${email}`);
  await deleteItem(`MEMBER#${email}`, `OWNER#${ownerSub}`);
}
// Circle-only games from every creator who added this email to their circle.
export async function sharedWithMe(email) {
  const links = await queryPrefix(`MEMBER#${email.toLowerCase()}`, "OWNER#");
  const lists = await Promise.all(links.map(async (l) => (await myGames(l.ownerSub)).filter((m) => m.status === "ready" && m.visibility === "circle").map((m) => ({ ...m, ownerName: m.ownerName || l.ownerName }))));
  return lists.flat();
}

// ---- groups: sub-communities people join with a link ----
const joinCode = () => crypto.randomBytes(6).toString("base64url").replace(/[-_]/g, "x").slice(0, 8);
export const getGroup = (gid) => getItem(`GROUP#${gid}`, "META");
export const groupMember = (gid, sub) => (sub ? getItem(`GROUP#${gid}`, `MEMBER#${sub}`) : null);
export const groupMembers = (gid) => queryPrefix(`GROUP#${gid}`, "MEMBER#");
export const myGroups = (sub) => queryPrefix(`USER#${sub}`, "GROUP#");
export async function groupByCode(code) {
  const link = /^[A-Za-z0-9]{8}$/.test(code || "") && (await getItem(`JOIN#${code}`, "GROUP"));
  const g = link && (await getGroup(link.gid));
  return g && g.code === code ? g : null; // a reset link stops working
}
export async function createGroup(owner, name, about) {
  const gid = newId(5), code = joinCode(), at = new Date().toISOString();
  const g = { pk: `GROUP#${gid}`, sk: "META", gid, name, about, owner: owner.sub, ownerName: owner.name, code, members: 0, createdAt: at };
  await putItem(g);
  await putItem({ pk: `JOIN#${code}`, sk: "GROUP", gid });
  await joinGroup(g, owner, "owner");
  return { ...g, members: 1 };
}
export async function joinGroup(g, user, role = "member") {
  if (await groupMember(g.gid, user.sub)) return false;
  const at = new Date().toISOString();
  await putItem({ pk: `GROUP#${g.gid}`, sk: `MEMBER#${user.sub}`, sub: user.sub, name: user.name, email: user.email, role, at });
  await putItem({ pk: `USER#${user.sub}`, sk: `GROUP#${g.gid}`, gid: g.gid, name: g.name, role, at });
  await db.send(new UpdateCommand({ TableName: TABLE, Key: { pk: `GROUP#${g.gid}`, sk: "META" }, UpdateExpression: "ADD members :one", ExpressionAttributeValues: { ":one": 1 } }));
  return true;
}
export async function leaveGroup(gid, sub) {
  if (!(await groupMember(gid, sub))) return;
  await deleteItem(`GROUP#${gid}`, `MEMBER#${sub}`);
  await deleteItem(`USER#${sub}`, `GROUP#${gid}`);
  await db.send(new UpdateCommand({ TableName: TABLE, Key: { pk: `GROUP#${gid}`, sk: "META" }, UpdateExpression: "ADD members :m", ExpressionAttributeValues: { ":m": -1 } }));
  // Their games leave the group with them (back to their circle, still private).
  for (const link of await queryPrefix(`GROUP#${gid}`, "GAME#")) if (link.owner === sub) await setVisibility(link.id, "circle");
}
export async function resetGroupLink(g) {
  const code = joinCode();
  await putItem({ pk: `JOIN#${code}`, sk: "GROUP", gid: g.gid });
  await deleteItem(`JOIN#${g.code}`, "GROUP");
  await db.send(new UpdateCommand({ TableName: TABLE, Key: { pk: `GROUP#${g.gid}`, sk: "META" }, UpdateExpression: "SET code = :c", ExpressionAttributeValues: { ":c": code } }));
  return code;
}
export async function groupGames(gid) {
  const metas = await Promise.all((await queryPrefix(`GROUP#${gid}`, "GAME#")).map((l) => getGame(l.id)));
  return metas.filter((m) => m && m.status === "ready" && m.visibility === "group" && m.groupId === gid);
}

// ---- tournaments: a game, a time window, a prize and their own leaderboard ----
export const getTournament = (tid) => getItem(`TOUR#${tid}`, "META");
export async function tournamentByCode(code) {
  const link = /^[A-Za-z0-9]{8}$/.test(code || "") && (await getItem(`TJOIN#${code}`, "TOUR"));
  return link ? getTournament(link.tid) : null;
}
export async function createTournament(host, t) {
  const tid = newId(5), code = joinCode(), at = new Date().toISOString();
  const item = { pk: `TOUR#${tid}`, sk: "META", tid, code, host: host.sub, hostName: host.name, entrants: 0, createdAt: at, ...t };
  await putItem(item);
  await putItem({ pk: `TJOIN#${code}`, sk: "TOUR", tid });
  await putItem({ pk: `USER#${host.sub}`, sk: `TOUR#${tid}`, tid, role: "host", at });
  return item;
}
export const tournamentEntry = (tid, sub) => (sub ? getItem(`TOUR#${tid}`, `ENTRY#${sub}`) : null);
export async function enterTournament(t, user) {
  if (await tournamentEntry(t.tid, user.sub)) return false;
  const at = new Date().toISOString();
  await putItem({ pk: `TOUR#${t.tid}`, sk: `ENTRY#${user.sub}`, sub: user.sub, name: user.name, best: null, runs: 0, at });
  await putItem({ pk: `USER#${user.sub}`, sk: `TOUR#${t.tid}`, tid: t.tid, role: "player", at });
  await db.send(new UpdateCommand({ TableName: TABLE, Key: { pk: `TOUR#${t.tid}`, sk: "META" }, UpdateExpression: "ADD entrants :one", ExpressionAttributeValues: { ":one": 1 } }));
  return true;
}
// Keep each player's best run (higher score; ties go to the faster run). Returns true when it improved.
export async function recordTournamentRun(tid, sub, run) {
  const now = new Date().toISOString();
  try {
    await db.send(new UpdateCommand({
      TableName: TABLE, Key: { pk: `TOUR#${tid}`, sk: `ENTRY#${sub}` },
      UpdateExpression: "SET best = :b, bestAt = :t ADD runs :one",
      ConditionExpression: "attribute_exists(sk) AND (attribute_not_exists(best) OR best = :null OR best.score < :s OR (best.score = :s AND best.#time > :tm))",
      ExpressionAttributeNames: { "#time": "time" },
      ExpressionAttributeValues: { ":b": run, ":t": now, ":one": 1, ":null": null, ":s": run.score, ":tm": run.time },
    }));
    return true;
  } catch (e) {
    if (e.name !== "ConditionalCheckFailedException") throw e;
    await db.send(new UpdateCommand({ TableName: TABLE, Key: { pk: `TOUR#${tid}`, sk: `ENTRY#${sub}` }, UpdateExpression: "ADD runs :one", ConditionExpression: "attribute_exists(sk)", ExpressionAttributeValues: { ":one": 1 } })).catch(() => {});
    return false;
  }
}
// Standings: everyone who has a run, best first (score, then time, then who got there first).
export async function tournamentStandings(tid) {
  const entries = await queryPrefix(`TOUR#${tid}`, "ENTRY#");
  const ranked = entries.filter((e) => e.best).sort((a, b) => b.best.score - a.best.score || a.best.time - b.best.time || (a.bestAt < b.bestAt ? -1 : 1));
  return { ranked, waiting: entries.filter((e) => !e.best) };
}
export const myTournaments = (sub) => queryPrefix(`USER#${sub}`, "TOUR#");
export async function endTournamentNow(tid) {
  await db.send(new UpdateCommand({ TableName: TABLE, Key: { pk: `TOUR#${tid}`, sk: "META" }, UpdateExpression: "SET endsAt = :n", ExpressionAttributeValues: { ":n": new Date().toISOString() } }));
}

// ---- app store connections and releases ----
export const getConnection = (sub, storeName) => getItem(`USER#${sub}`, `CONNECT#${storeName}`);
export const putConnection = (sub, storeName, fields) => putItem({ pk: `USER#${sub}`, sk: `CONNECT#${storeName}`, store: storeName, at: new Date().toISOString(), ...fields });
export const deleteConnection = (sub, storeName) => deleteItem(`USER#${sub}`, `CONNECT#${storeName}`);
export const getStoreApp = (id) => getItem(`GAME#${id}`, "STOREAPP");
export const putStoreApp = (id, fields) => putItem({ pk: `GAME#${id}`, sk: "STOREAPP", ...fields, at: new Date().toISOString() });
export const getKeystore = (id) => getItem(`GAME#${id}`, "KEYSTORE");
export const putKeystore = (id, sealed) => putItem({ pk: `GAME#${id}`, sk: "KEYSTORE", sealed, at: new Date().toISOString() });
export const releases = (id) => queryPrefix(`GAME#${id}`, "RELEASE#", { forward: false, limit: 30 });
export async function createRelease(id, r) {
  const at = new Date().toISOString();
  const item = { pk: `GAME#${id}`, sk: `RELEASE#${r.rid}`, gameId: id, state: "queued", steps: [{ at, state: "queued", text: r.firstStep || "Queued for a cloud build." }], createdAt: at, ...r };
  delete item.firstStep;
  await putItem(item);
  await putItem({ pk: `RELEASE#${r.rid}`, sk: "PTR", gameId: id, ttl: Math.floor(Date.now() / 1000) + 30 * 864e5 });
  return item;
}
export async function getRelease(rid) {
  const ptr = await getItem(`RELEASE#${rid}`, "PTR");
  return ptr ? getItem(`GAME#${ptr.gameId}`, `RELEASE#${rid}`) : null;
}
// Append a timeline step and set the state (plus any extra fields).
export async function releaseStep(r, state, text, fields = {}) {
  const names = { "#s": "state", "#st": "steps", "#u": "updatedAt" }, values = { ":s": state, ":st": [{ at: new Date().toISOString(), state, text }], ":u": new Date().toISOString() };
  const sets = ["#s = :s", "#st = list_append(#st, :st)", "#u = :u"];
  for (const [k, v] of Object.entries(fields)) { names[`#f_${k}`] = k; values[`:f_${k}`] = v; sets.push(`#f_${k} = :f_${k}`); }
  await db.send(new UpdateCommand({ TableName: TABLE, Key: { pk: r.pk, sk: r.sk }, UpdateExpression: `SET ${sets.join(", ")}`, ExpressionAttributeNames: names, ExpressionAttributeValues: values }));
}

// ---- versions / chat / feedback ----
// Save a new version. Drafts stay private until published; the first version is published directly.
export async function saveVersion(id, payload, summary, score, { publish = false } = {}) {
  const meta = await getGame(id);
  const v = (meta?.version || 0) + 1;
  await putVersionPayload(id, v, payload);
  await putItem({ pk: `GAME#${id}`, sk: `VERSION#${pad(v)}`, v, summary, score: score ?? null, at: new Date().toISOString() });
  const changelog = [...(meta?.changelog || []), summary].slice(-40);
  // Games made before drafts existed have no liveVersion yet: pin the one players have now.
  const pin = meta && meta.liveVersion == null && meta.version ? { liveVersion: meta.version } : {};
  await updateGame(id, { version: v, changelog, updatedAt: new Date().toISOString(), ...pin });
  if (publish) await publishVersion(id, v, payload, score);
  return v;
}
// Make a version live for every player (also how rollback works: publish an older version).
export async function publishVersion(id, v, payload, score) {
  payload ||= await getPayload(id, v);
  if (score === undefined) score = (await getItem(`GAME#${id}`, `VERSION#${pad(v)}`))?.score ?? null;
  await putLivePayload(id, payload);
  await updateGame(id, { liveVersion: v, score: score ?? null, publishedAt: new Date().toISOString() });
}
export const liveVersionOf = (meta) => meta?.liveVersion ?? meta?.version ?? 0;
export const versions = (id) => queryPrefix(`GAME#${id}`, "VERSION#");
export async function addChat(id, msg) {
  const at = new Date().toISOString();
  const item = { pk: `GAME#${id}`, sk: `CHAT#${at}#${newId(2)}`, gameId: id, id: newId(4), at, ...msg };
  await putItem(item);
  return item;
}
export const chat = (id) => queryPrefix(`GAME#${id}`, "CHAT#", { limit: 200, forward: false }).then((x) => x.reverse());
export async function addFeedback(id, text, name, kind = "idea", extra = {}) {
  const item = { pk: `GAME#${id}`, sk: `FEEDBACK#${newId(4)}`, gameId: id, text, name, kind, status: "pending", reports: 1, at: new Date().toISOString(), ...extra };
  item.id = item.sk.slice(9);
  await putItem(item);
  return item;
}
// The same crash seen again: count it on the open report instead of filing a new one.
export async function bumpFeedback(id, fid) {
  await db.send(new UpdateCommand({ TableName: TABLE, Key: { pk: `GAME#${id}`, sk: `FEEDBACK#${fid}` }, UpdateExpression: "ADD reports :one SET lastAt = :t", ExpressionAttributeValues: { ":one": 1, ":t": new Date().toISOString() } }));
}
export const feedback = (id) => queryPrefix(`GAME#${id}`, "FEEDBACK#");
export async function setFeedback(id, fid, status) {
  await db.send(new UpdateCommand({ TableName: TABLE, Key: { pk: `GAME#${id}`, sk: `FEEDBACK#${fid}` }, UpdateExpression: "SET #s = :s", ExpressionAttributeNames: { "#s": "status" }, ExpressionAttributeValues: { ":s": status } }));
}

// ---- leaderboards: this week, this month and all time; worldwide or per country ----
// ISO week in UTC, e.g. "2026-44" (weeks start on Monday).
export function isoWeek(d = new Date()) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const y = t.getUTCFullYear(), w = Math.ceil(((t - Date.UTC(y, 0, 1)) / 864e5 + 1) / 7);
  return `${y}-${String(w).padStart(2, "0")}`;
}
export const boardKey = (period, d = new Date()) => (period === "week" ? `W${isoWeek(d)}` : period === "month" ? `M${d.toISOString().slice(0, 7)}` : "ALL");
// Weekly and monthly entries expire on their own once their board is over.
const BOARDS = [["all", 0], ["week", 21 * 864e5], ["month", 92 * 864e5]];
export async function addScore(gameId, e, at = new Date()) {
  const inv = String(1e7 - Math.min(1e7 - 1, Math.max(0, Math.round(e.score)))).padStart(8, "0"), ts = at.getTime();
  const items = [];
  for (const [period, keep] of BOARDS) for (const c of e.country ? ["ALL", e.country] : ["ALL"]) {
    items.push({ pk: `GAME#${gameId}`, sk: `LB#${boardKey(period, at)}#${c}#${inv}#${ts}`, ...e, at: at.toISOString(), ...(keep ? { ttl: Math.floor((ts + keep) / 1000) } : {}) });
  }
  await db.send(new BatchWriteCommand({ RequestItems: { [TABLE]: items.map((Item) => ({ PutRequest: { Item } })) } }));
  return ts;
}
export const topScores = async (gameId, n = 10, { period = "all", country = "ALL" } = {}) =>
  (await queryPrefix(`GAME#${gameId}`, `LB#${boardKey(period)}#${country}#`, { limit: n })).map(({ sk, name, score, progress, won, time, at, country: c }) => ({ name, score, progress, won, time, at, country: c || null, ts: +sk.split("#").pop() }));

// ---- browser task results (the worker waits for these) ----
export const putTaskResult = (gameId, taskId, result) => putItem({ pk: `GAME#${gameId}`, sk: `TASK#${taskId}`, result: JSON.stringify(result ?? null), ttl: Math.floor(Date.now() / 1000) + 3600 });
export async function takeTaskResult(gameId, taskId) {
  const it = await getItem(`GAME#${gameId}`, `TASK#${taskId}`);
  if (!it) return undefined;
  await deleteItem(`GAME#${gameId}`, `TASK#${taskId}`);
  return JSON.parse(it.result);
}

// ---- AI spend (hard cap across all runs) ----
export async function addSpend(usd) {
  const r = await db.send(new UpdateCommand({ TableName: TABLE, Key: { pk: "SPEND", sk: "TOTAL" }, UpdateExpression: "ADD usd :u", ExpressionAttributeValues: { ":u": usd }, ReturnValues: "UPDATED_NEW" }));
  return r.Attributes.usd;
}
export async function totalSpend() { return (await getItem("SPEND", "TOTAL"))?.usd || 0; }

// Games migrated from the old server are owned by "EMAIL#<email>" until that person signs in.
export async function claimGames(email, sub) {
  const out = await db.send(new QueryCommand({ TableName: TABLE, IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :p", ExpressionAttributeValues: { ":p": `OWNER#EMAIL#${email}` } }));
  for (const g of out.Items || []) { const { pk, sk, GSI1PK, GSI1SK, GSI2PK, GSI2SK, ...meta } = g; await putGameMeta({ ...meta, owner: sub }); }
  return (out.Items || []).length;
}
