// Sample content for recording the demo video, removed again afterwards:
//   node video/demo-data.mjs create   → sample players, a group, a tournament, scores and player feedback
//   node video/demo-data.mjs cleanup  → deletes everything create made and restores what it changed
// Run from the repository root with the server's AWS environment (TABLE, BUCKET, AWS credentials).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import * as s from "../aws/lib/store.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname), STATE = path.join(HERE, "out/tmp/demo-data.json");
const GAME = "d91b2502", GROUP_GAME = "a4604c88"; // NEON FARE (boards, feedback) · Penguin Pizza Panic (group game)
const PLAYERS = [["Priya", "IN"], ["Arjun", "IN"], ["Mei", "SG"], ["Sam", "US"], ["Lukas", "DE"], ["Ana", "BR"]];

async function create() {
  if (fs.existsSync(STATE)) throw new Error("demo data already exists — run cleanup first");
  const host = await s.getUser((await s.getGame(GAME)).owner);
  const st = { users: [], scores: [], feedback: [], group: null, tour: null, groupGamePrev: null };
  const users = [];
  for (const [name, country] of PLAYERS) {
    const sub = `demo-${name.toLowerCase()}-${crypto.randomBytes(2).toString("hex")}`;
    await s.putItem({ pk: `USER#${sub}`, sk: "PROFILE", sub, email: `${name.toLowerCase()}@demo.invalid`, name, createdAt: new Date().toISOString() });
    users.push({ sub, name, email: `${name.toLowerCase()}@demo.invalid`, country }); st.users.push(sub);
  }
  // Leaderboard on NEON FARE: this week, worldwide and by country.
  const pts = [1520, 1180, 1390, 1210, 940, 870];
  for (const [i, u] of users.entries()) {
    const at = new Date(Date.now() - (i + 1) * 3600e3);
    const ts = await s.addScore(GAME, { name: u.name, score: pts[i], progress: Math.min(1, pts[i] / 1600), won: pts[i] > 1300 ? 1 : 0, time: 90 + i * 7, country: u.country }, at);
    st.scores.push(ts);
  }
  // Player feedback waiting for approval.
  for (const [text, name, kind] of [["The taxi clips through the bus at the start of stage 2.", "Priya", "bug"], ["Add a rainy night stage with slippery roads and neon reflections.", "Sam", "idea"]]) st.feedback.push((await s.addFeedback(GAME, text, name, kind)).sk);
  await s.updateGame(GAME, { pendingFeedback: 2 });
  // A group with members and a members-only game.
  const g = await s.createGroup(host, "Neon Night Racers", "Friday night taxi races — share your best runs and challenge the crew.");
  for (const u of users.slice(0, 5)) await s.joinGroup(g, u);
  st.groupGamePrev = (await s.getGame(GROUP_GAME)).visibility || "public";
  await s.setVisibility(GROUP_GAME, "group", g.gid);
  st.group = { gid: g.gid, code: g.code };
  // A live tournament with a prize and standings.
  const t = await s.createTournament(host, {
    name: "Diwali Night Cab Cup", about: "One week, one city, fastest fares win. Best score counts.", game: { id: "example-runner", title: "Neon Cab Rush" },
    startsAt: new Date(Date.now() - 2 * 3600e3).toISOString(), endsAt: new Date(Date.now() + 6 * 864e5).toISOString(),
    prize: { amount: 5000, currency: "INR", split: "50-30-20", note: "Paid by UPI within two days of the final whistle." }, access: "link", groupId: null,
  });
  const runs = [1840, 1610, 1320, 1475, 990, 760];
  for (const [i, u] of users.entries()) { await s.enterTournament(t, u); await s.recordTournamentRun(t.tid, u.sub, { score: runs[i], progress: Math.min(1, runs[i] / 1900), won: runs[i] > 1500 ? 1 : 0, time: 95 + i * 6 }); }
  st.tour = { tid: t.tid, code: t.code };
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(st, null, 2));
  console.log(`demo data ready: group /studio/groups/${g.gid} (join /g/${g.code}) · tournament /t/${t.code}`);
}

async function cleanup() {
  if (!fs.existsSync(STATE)) return console.log("no demo data to clean up");
  const st = JSON.parse(fs.readFileSync(STATE, "utf8"));
  let n = 0;
  const del = async (pk, sk) => { await s.deleteItem(pk, sk); n++; };
  // Scores: every board row of the seeded runs (identified by their timestamps).
  const seeded = new Set(st.scores.map(String));
  for (const it of await s.listPrefix(`GAME#${GAME}`, "LB#")) if (seeded.has(it.sk.split("#").pop())) await del(it.pk, it.sk);
  for (const sk of st.feedback) await del(`GAME#${GAME}`, sk);
  const pending = (await s.feedback(GAME)).filter((f) => f.status === "pending").length;
  await s.updateGame(GAME, { pendingFeedback: pending });
  if (st.group) {
    await s.setVisibility(GROUP_GAME, st.groupGamePrev || "public");
    for (const sub of [...st.users, (await s.getGame(GAME)).owner]) { await s.deleteItem(`USER#${sub}`, `GROUP#${st.group.gid}`); }
    for (const sk of ["META"]) await del(`GROUP#${st.group.gid}`, sk);
    for (const m of await s.groupMembers(st.group.gid)) await del(m.pk, m.sk);
    await del(`JOIN#${st.group.code}`, "GROUP");
  }
  if (st.tour) {
    const { ranked, waiting } = await s.tournamentStandings(st.tour.tid);
    for (const e of [...ranked, ...waiting]) await del(e.pk, e.sk);
    for (const sub of [...st.users, (await s.getGame(GAME)).owner]) await s.deleteItem(`USER#${sub}`, `TOUR#${st.tour.tid}`);
    await del(`TOUR#${st.tour.tid}`, "META"); await del(`TJOIN#${st.tour.code}`, "TOUR");
  }
  for (const sub of st.users) await del(`USER#${sub}`, "PROFILE");
  fs.renameSync(STATE, STATE.replace(".json", `.cleaned-${Date.now()}.json`));
  console.log(`demo data removed (${n} rows); ${GROUP_GAME} is ${st.groupGamePrev} again`);
}

await ({ create, cleanup }[process.argv[2]] || (() => console.log("usage: create | cleanup")))();
