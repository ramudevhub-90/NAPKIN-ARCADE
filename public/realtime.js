// Live studio events for one game: AWS AppSync real-time subscription (Cognito-authenticated,
// owner-only), or the server's SSE stream when AppSync isn't configured (local development).
import { config, idToken } from "/cognito.js";

const QUERY = "subscription S($gameId: ID!) { onStudioEvent(gameId: $gameId) { gameId owner payload } }";

export function subscribeStudio(gameId, onEvent) {
  let close = () => {};
  const sse = () => {
    const es = new EventSource(`/api/projects/${gameId}/events`);
    es.onmessage = (m) => onEvent(JSON.parse(m.data));
    close = () => es.close();
  };
  const ready = (async () => {
    const cfg = await config(), token = cfg.appsync && (await idToken());
    if (!cfg.appsync || !token) return sse();
    try { await appsync(cfg, token); }
    catch (e) {
      // Never leave the workshop stuck: fall back to the server's own event stream.
      console.warn("AppSync subscription failed, using the server stream instead:", e.message);
      close(); sse();
    }
  })();
  async function appsync(cfg, token) {
    const host = new URL(cfg.appsync.url).host;
    const header = btoa(JSON.stringify({ host, Authorization: token }));
    const ws = new WebSocket(`${cfg.appsync.realtime}?header=${encodeURIComponent(header)}&payload=e30=`, ["graphql-ws"]);
    setTimeout(() => ws.readyState !== 1 && ws.close(), 10000);
    close = () => { try { ws.send(JSON.stringify({ type: "stop", id: "s1" })); } catch {} ws.close(); };
    await new Promise((resolve, reject) => {
      ws.onopen = () => ws.send(JSON.stringify({ type: "connection_init" }));
      ws.onerror = () => reject(new Error("AppSync WebSocket error"));
      ws.onclose = (e) => reject(new Error(`AppSync closed the connection (${e.code}${e.reason ? ": " + e.reason : ""})`));
      setTimeout(() => reject(new Error("AppSync did not confirm the subscription in time")), 12000);
      ws.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        if (msg.type === "connection_ack") {
          ws.send(JSON.stringify({ id: "s1", type: "start", payload: { data: JSON.stringify({ query: QUERY, variables: { gameId } }), extensions: { authorization: { host, Authorization: token } } } }));
        } else if (msg.type === "start_ack") resolve();
        else if (msg.type === "data") {
          const p = msg.payload?.data?.onStudioEvent?.payload;
          if (p) onEvent(typeof p === "string" ? JSON.parse(p) : p);
        } else if (msg.type === "error" || msg.type === "connection_error") reject(new Error(`AppSync: ${JSON.stringify(msg.payload?.errors || msg.payload)}`));
      };
    });
  }
  return { ready, close: () => close() };
}
