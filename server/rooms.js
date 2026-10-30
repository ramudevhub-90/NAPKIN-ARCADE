// Multiplayer rooms over WebSocket. Everyone in a room plays the same game with the same
// world seed; positions stream 10x/second so each player sees live rivals and a leaderboard.
import crypto from "node:crypto";
import { WebSocketServer } from "ws";

const COLORS = ["#ff2fa0", "#3ef0ff", "#ffd23f", "#39ff88", "#b46bff", "#ff8a3d", "#5fa8ff", "#ff5a5a"];
const rooms = new Map(); // code -> room
const wss = new WebSocketServer({ noServer: true });

export function createRoom(gameId) {
  let code;
  do code = crypto.randomBytes(3).toString("hex").toUpperCase(); while (rooms.has(code));
  rooms.set(code, { code, gameId, players: new Map(), hostId: null, status: "lobby", seed: 0, results: [], created: Date.now() });
  return code;
}

const send = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };
const broadcast = (room, msg) => { for (const p of room.players.values()) send(p.ws, msg); };
function roster(room) {
  return { t: "room", code: room.code, status: room.status, host: room.hostId, players: [...room.players.values()].map((p) => ({ id: p.id, name: p.name, color: p.color })) };
}

export function handleUpgrade(req, socket, head, userName) {
  const url = new URL(req.url, "http://x");
  const code = String(url.searchParams.get("room") || "").toUpperCase(), gameId = url.searchParams.get("game") || "";
  let room = rooms.get(code);
  if (!room && /^[A-F0-9]{6}$/.test(code)) { rooms.set(code, { code, gameId, players: new Map(), hostId: null, status: "lobby", seed: 0, results: [], created: Date.now() }); room = rooms.get(code); }
  if (!room || room.gameId !== gameId || room.players.size >= 8) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => join(room, ws, userName || url.searchParams.get("name")));
}

function join(room, ws, rawName) {
  const id = crypto.randomBytes(4).toString("hex");
  const used = new Set([...room.players.values()].map((p) => p.color));
  const p = { id, ws, name: String(rawName || "Player").replace(/[<>]/g, "").slice(0, 18) || "Player", color: COLORS.find((c) => !used.has(c)) || COLORS[0], state: null };
  room.players.set(id, p);
  if (!room.hostId) room.hostId = id;
  send(ws, { t: "welcome", you: id, color: p.color });
  broadcast(room, roster(room));
  if (room.status === "playing") send(ws, { t: "spectate" });

  ws.on("message", (buf) => {
    let m; try { m = JSON.parse(buf); } catch { return; }
    if (m.t === "name") { p.name = String(m.name || "").replace(/[<>]/g, "").slice(0, 18) || p.name; broadcast(room, roster(room)); }
    if (m.t === "start" && id === room.hostId && room.status !== "playing") {
      room.status = "playing"; room.seed = crypto.randomInt(1, 1e9); room.results = [];
      for (const q of room.players.values()) q.state = null;
      broadcast(room, { t: "start", seed: room.seed, countdown: 3 });
      broadcast(room, roster(room));
    }
    if (m.t === "state" && room.status === "playing" && m.s) p.state = { ...m.s, at: Date.now() };
    if (m.t === "end" && room.status === "playing" && !room.results.find((r) => r.id === id)) {
      room.results.push({ id, name: p.name, color: p.color, ...m.result });
      if (room.results.length >= [...room.players.values()].filter((q) => q.state).length) finish(room);
    }
    if (m.t === "lobby" && id === room.hostId) { room.status = "lobby"; broadcast(room, roster(room)); }
  });
  ws.on("close", () => {
    room.players.delete(id);
    if (room.hostId === id) room.hostId = room.players.keys().next().value || null;
    if (!room.players.size) rooms.delete(room.code);
    else { broadcast(room, roster(room)); if (room.status === "playing" && room.results.length >= room.players.size) finish(room); }
  });
}

function finish(room) {
  room.status = "done";
  const ranking = [...room.results].sort((a, b) => (b.won - a.won) || (b.progress - a.progress) || (b.score - a.score) || (a.time - b.time));
  broadcast(room, { t: "results", ranking });
  broadcast(room, roster(room));
}

// Stream everyone's latest state to everyone, 10 times a second.
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.status !== "playing") continue;
    const states = [...room.players.values()].filter((p) => p.state).map((p) => ({ id: p.id, name: p.name, color: p.color, s: p.state }));
    broadcast(room, { t: "states", states });
  }
  for (const [code, room] of rooms) if (!room.players.size && Date.now() - room.created > 3600e3) rooms.delete(code);
}, 100);
