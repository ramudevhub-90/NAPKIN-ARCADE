// Narration for the Napkin Arcade demo video — the NVIDIA × Nebius hackathon cut (about 3½ minutes).
//   INTRO / OUTRO — explainer scenes (scene = index in explainer.html)
//   STUDIO        — a real studio run, sped up between milestones (from → to)
//   LIVE          — the platform, one beat per clip in build.mjs
// Every line is read aloud (Amazon Polly) and shown as a caption.

export const VOICE = { name: "Ruth", polly: "generative", fallback: { name: "Joanna", polly: "neural" } };

export const INTRO = [
  { scene: 0, text: "Everyone has a game idea. Usually, it stays on a napkin. Napkin Arcade turns a sketch, or one sentence, into a real 3D game, and puts it on every screen your players have." },
  { scene: 1, text: "Behind it is a game studio of NVIDIA Nemotron agents, running on Nebius Token Factory. Nemotron 3 Ultra designs and codes. Super VL sees: it reads drawings, reviews the 3D art, and plays the game. Super and Nano keep it fast and cheap." },
  { scene: 2, text: "This is agentic engineering, not a single prompt. Every change runs through real tools and hard gates: a linter, fifteen bot players, vision playtesters, and a two-player race test. If a gate fails, the code goes back to the developer. Nothing ships until it passes." },
];

// Each beat covers the studio recording between two milestones, sped up to fit the line.
export const STUDIO = [
  { id: "idea", from: "start", to: "built", text: "Let's build one. I type an idea: a taxi racing through a crowded neon city at night." },
  { id: "design", from: "built", to: "art", text: "The creative director designs the game. The 3D artist builds the cab from primitives, and the art director looks at a render." },
  { id: "review", from: "art", to: "revised", hold: "art", text: "It scores the model and names exactly what's wrong, so the artist rebuilds it until it reads right." },
  { id: "code", from: "revised", to: "qa", text: "The developer writes the game. Fifteen bots run the real code in a sandbox, and a two-player race checks multiplayer. Any failure goes straight back." },
  { id: "playtest", from: "qa", to: "tested", text: "AI playtesters, a seven-year-old and a grandpa, watch the actual screen and play it, move by move." },
  { id: "lead", from: "tested", to: "final", text: "The studio lead proposes fixes, the bots test every one, and only a measurable improvement ships." },
  { id: "ship", from: "final", to: "end", text: "A finished, tested game, with a share link and a QR code, for about ten cents of AI." },
];

export const LIVE = [
  { id: "play", text: "Every game gets stages, power-ups and a pause menu, and plays with touch, keyboard, game controllers and TV remotes." },
  { id: "workshop", text: "And it keeps getting better. Each game has a workshop where you chat with the studio, and it remembers every change. Players' bug reports and ideas arrive for your approval." },
  { id: "draft", text: "Approve one, and the agents build it as a draft and test it again. Players keep the live version until you publish." },
  { id: "race", text: "Play with friends from one link. Everyone races the same world, each in their own lane, with live rivals." },
  { id: "boards", text: "Leaderboards run this week, this month and all time, worldwide or by country." },
  { id: "community", text: "Creators build communities: groups with a join link, and private games only members can play." },
  { id: "tournament", text: "Host a tournament on any game, set the prize in any currency, and the leaderboard and podium run themselves." },
  { id: "publish", text: "Then publish everywhere: an offline HTML5 game, playable ads for six ad networks, iOS, Android, Android TV, Samsung and LG TVs, and desktop." },
  { id: "ad", text: "This is the playable ad: thirty seconds of the real game, then a button to the store." },
  { id: "stores", text: "And the app store connector builds in the cloud and releases to TestFlight and Google Play." },
];

export const OUTRO = [
  { scene: 3, text: "Napkin Arcade. Nemotron agents that write, test and ship real games, and keep improving them. Try it at napkin arcade dot revenue rush dot in.", caption: "Napkin Arcade. Nemotron agents that write, test and ship real games — and keep improving them. Try it at napkinarcade.revenuerush.in" },
];
