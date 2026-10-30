# Devpost submission — Napkin Arcade

**Project name:** Napkin Arcade

**Elevator pitch (≤200 chars):**
Draw a game on a napkin. An AI studio of NVIDIA Nemotron agents builds it in 3D, playtests it with vision, fixes what isn't fun, and ships a link you can race your friends on.

**Track:** Coding & Agentic Engineering

**Links**
- Live app: https://napkinarcade.revenuerush.in
- Demo video: https://youtu.be/YbJqdClW9cE
- Code (MIT): https://github.com/ramudevhub-90/NAPKIN-ARCADE
- A game built in the video: https://napkinarcade.revenuerush.in/play/d91b2502

**Built with:** nvidia-nemotron, nebius-token-factory, javascript, node.js, three.js, webgl, websockets, playwright, acorn, aws-ec2, aws-route53, amazon-ses, aws-cloudformation, aws-systems-manager, amazon-polly, caddy

---

## Inspiration
Everyone has a game idea — usually scribbled on a napkin and forgotten, because turning it into a real game takes a whole studio: designers, 3D artists, programmers, QA and playtesters. We wanted to give everyone that studio, made of AI agents, and hold it to the standard real studios use: you don't ship until it's tested and fun.

## What it does
You snap a drawing or type one sentence. A studio of NVIDIA Nemotron agents running on Nebius Token Factory then:
- **designs** the game (Nemotron 3 Ultra): template, world, controls, three stages, a twist, win and lose rules;
- **builds the 3D art** (Ultra) from primitives with physically based materials — and the **art director (Nemotron 3.5 Super VL) reviews a render of every model with vision**, sending back concrete problems ("parts are floating") until it reads right;
- **writes the game code** (Ultra) as a JavaScript module for our 3D engine;
- **tests it**: a static linter and 15 headless bot players at three skill levels run the real code in a sandbox; crashes and gameplay bugs go straight back to the developer with the exact failing line;
- **playtests it with vision**: AI personas (a 7-year-old, a grandpa) look at real frames of the running game, choose every move with Super VL, and write their notes with Nemotron Nano;
- **fixes what isn't fun**: the studio lead (Ultra) proposes three fixes, a built-in auto-tuner adds a fourth, the bots measure every one, and only a measurable improvement ships.

In the demo video's live run, the studio took "NEON FARE" from fun score 82 → 90 → 96 and shipped it for $0.09 of AI.

Every game ships with a link and QR code, 3D worlds with real-time lighting, power-ups and combos, a global leaderboard, keyboard and touch controls, and **multiplayer rooms**: share a link, everyone lands in the lobby, and you race in the same world with live rivals. There's also a free arcade of six polished games — no sign-in needed.

## How we built it
- **Nemotron on Nebius Token Factory** through the OpenAI-compatible chat completions API: Ultra for design, 3D modeling, code and leadership; Super VL for drawing reading, art review and playing; Nano for playtester summaries. Over development: 397 model calls, $1.34 total.
- **A purpose-built 3D engine on three.js**: 12 world presets (neon city, space, underwater, volcano, synthwave…), procedural textures and instanced scenery, ACES tone mapping, soft shadows, reflections, bloom, particles, procedural sound, and a JSON model format the AI can write.
- **Agent tooling**: an acorn-based linter that quotes failing lines, telemetry-driven bots (lane planning and sampled safe moves), a fun score with partial credit, and an auto-tuner.
- **Safety**: AI-written code only ever runs in sandboxed, opaque-origin iframes in the browser — never on the server. Spending caps per game, per hour, per user and in total.
- **Platform**: email one-time-code sign-in, WebSocket multiplayer rooms, global leaderboards, deployed on AWS (EC2 + Caddy HTTPS, Route 53, SES, CloudFormation, Systems Manager).
- **The demo video** is generated from the real app: Playwright records it, Amazon Polly narrates it, ffmpeg edits it.

## Challenges we ran into
- **Thinking models spending the whole budget on reasoning.** Ultra and Super VL sometimes returned no content because reasoning used every token; `chat_template_kwargs: { enable_thinking: false }` fixed it (the `/no_think` tag didn't work for the VL model).
- **AI code with subtle bugs.** Without reasoning, Ultra sometimes used variables it never declared. A line-quoting linter plus crash and gameplay checks turned this into a self-healing loop.
- **"Everything scores zero."** Our first fun score bottomed out at 0 for games that were too hard, so no fix could prove progress. Partial credit for how far players get, plus an auto-tuner, let the studio climb out.
- **Bots that play like people.** Early bots lost as often as experts; lane planning and predictive dodging gave real skill differences, so difficulty targets mean something.
- **Making 3D look good from text.** We moved from 2D tiles to a full 3D engine and gave the artist hand-made reference models and a vision review loop.

## Accomplishments that we're proud of
- An agent loop that doesn't just generate code — it **runs, tests, playtests and measurably improves** it.
- **Vision in the loop twice:** the same Super VL model reviews 3D art and plays the finished game.
- Real games, real multiplayer, real leaderboards — live today, at about ten cents per game.

## What we learned
Agents get dramatically better when they're held accountable by measurements: a linter, bots and a fun score turn "generate and hope" into "generate, test, keep what's better". Fast, cheap open models on Token Factory make that loop affordable — Super VL makes a playtest decision in about a second.

## What's next
More genres (racing physics, puzzles, platformers), drawings becoming the actual textures of characters, longer games with saved progress, and letting players remix any game with a sentence.

---

## Feedback on Nebius Token Factory and NVIDIA Nemotron
1. **Reasoning controls deserve front-page docs.** Thinking models silently returning empty `content` after spending all `max_tokens` on reasoning was our biggest early bug. `chat_template_kwargs.enable_thinking` worked, but we found it by experiment; a documented per-request reasoning budget (e.g. `max_reasoning_tokens`) and a clear `finish_reason` when reasoning exhausts the budget would save every team hours.
2. **Consistent model IDs.** `nvidia/Nemotron-3-Ultra-550b-a55b`, `nvidia/nemotron-3-super-120b-a12b` and `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` use different casing and patterns, so we resolve names against `/v1/models` at startup. Stable aliases (`nemotron-3-ultra`, `nemotron-3-super`) would help.
3. **Spending limits in the console.** We built our own ledger, per-project caps and a hard stop because we were nervous about runaway agent loops. Account-level budgets and alerts — ideally per API key — would make teams far more comfortable letting agents run.
4. **Vision token accounting.** Image requests report small prompt-token counts, so it's hard to predict vision costs in advance; documenting how images are tokenized and priced would help capacity planning.
5. **What worked great:** the OpenAI-compatible API (zero client changes), low latency for Super VL (~1 s per playtest decision across 267 calls), and very low prices — our whole development cost $1.34 across 397 Nemotron calls. Ultra's quality for game design and code was the backbone of the studio.
