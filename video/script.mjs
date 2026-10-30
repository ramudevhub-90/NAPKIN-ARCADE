// Narration for the Napkin Arcade demo video (target under 3 minutes).
//   INTRO / OUTRO — explainer scenes (scene = index in explainer.html)
//   STUDIO        — a real studio run, sped up between milestones (from → to)
//   LIVE          — the live site, one beat per action in build.mjs
// Every line is read aloud (Amazon Polly) and shown as a caption.

export const VOICE = { name: "Ruth", polly: "generative", fallback: { name: "Joanna", polly: "neural" } };

export const INTRO = [
  { scene: 0, text: "Everyone has a game idea. Usually, it stays on a napkin. Napkin Arcade turns a sketch, or one sentence, into a real 3D game you can play with your friends." },
  { scene: 1, text: "Behind it is a game studio made of NVIDIA Nemotron agents, running on Nebius Token Factory. Ultra designs and codes. Super VL sees: it reads drawings, reviews the 3D art, and plays the game. Super and Nano support them." },
];

// Each beat covers the studio recording between two milestones, sped up to fit the line.
export const STUDIO = [
  { id: "idea", from: "start", to: "built", text: "Let's build one. I type an idea: a taxi racing through a crowded neon city at night." },
  { id: "design", from: "built", to: "art", text: "The creative director designs the game. The 3D artist builds the cab from primitives, and the art director looks at a render." },
  { id: "review", from: "art", to: "revised", hold: "art", text: "It scores the model and names exactly what's wrong, like floating parts, so the artist rebuilds it until it reads right." },
  { id: "code", from: "revised", to: "qa", text: "Then the developer writes the game code. A linter and fifteen bot players run the real code in a sandbox. Any crash goes straight back to the developer." },
  { id: "playtest", from: "qa", to: "tested", text: "AI playtesters, a seven-year-old and a grandpa, look at the actual screen and play it, move by move, and say what feels fun or boring." },
  { id: "lead", from: "tested", to: "final", text: "The studio lead reads the data, proposes three fixes, and the bots test every one. Only a measurable improvement ships." },
  { id: "ship", from: "final", to: "end", text: "A finished, tested game, with a link and a QR code, for about ten cents of AI." },
];

export const LIVE = [
  { id: "play", text: "And here it is, live. Every game gets stages, power-ups, combos, and a global leaderboard." },
  { id: "arcade", text: "There's a free arcade, too. Six polished games, no sign-in needed." },
  { id: "montage", text: "Swim a reef, carve a mountain, or survive a meteor storm." },
  { id: "multiplayer", text: "Press Play with friends, and share the link. Everyone lands in the same room and races in the same world, with live rivals and a leaderboard." },
];

export const OUTRO = [
  { scene: 2, text: "Napkin Arcade. Agents that write, run and test the code, and only ship what's fun. Try it at napkin arcade dot revenue rush dot in.", caption: "Napkin Arcade. Agents that write, run and test the code, and only ship what's fun. Try it at napkinarcade.revenuerush.in" },
];
