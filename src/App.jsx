// src/App.jsx
import { useCallback, useEffect, useRef, useState } from "react";

/* ============================== Brand Colors =============================== */
// One place to change RedStone red everywhere:
const RS_RED = "#B60D1D";           // <- your brand hex
const RS_RED_LIGHT = "#E03544";
const RS_RED_DARK  = "#8E0A15";

/* build shiny look (used by legacy red preview in header if needed) */
const RED_SHINE = `linear-gradient(180deg, ${RS_RED_LIGHT} 0%, ${RS_RED} 58%, ${RS_RED_DARK} 100%)`;
const RED_GLOSS = `conic-gradient(from 210deg at 30% 25%, rgba(255,255,255,0.28) 0 35%, transparent 42% 100%)`;

/* ============================== Config ==================================== */
// Flow
const COUNTDOWN_MS        = 3_000;       // 3-2-1 overlay

// Gameplay (endless)
const LANES               = 5;           // exactly five fixed lanes
const PKT_SIZE_DESKTOP    = 66;
const PKT_SIZE_MOBILE     = 58;

const VALID_CHANCE        = 0.40;        // 40% logo (valid), 60% corrupted (invalid)
const SCORE_PER_HIT       = 10;          // +10 per verified valid logo
const SCORE_GREEN_MISS    = -5;          // -5 if a valid packet touches the floor

// Difficulty ramp
const BASE_SPEED_PX_S     = 260;         // starting fall speed (px/sec)
const SPEED_RAMP_PER_MIN  = 0.55;        // +55% speed every minute
const SPAWN_BASE_MS       = 520;         // initial spawn interval
const SPAWN_MIN_MS        = 120;         // minimum (fastest) spawn interval
const SPAWN_ACCEL_PER_MIN = 300;         // reduce interval by this / minute

/* Backend URL that works on both phone & PC in the same LAN */
const HOST     = typeof window !== "undefined" ? window.location.hostname : "localhost";
const BACKEND  = (import.meta.env.VITE_API || `http://${HOST}:8787`).replace(/\/+$/, "");

/* ============================== Helpers =================================== */
const now   = () => performance.now();
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const isMob = () => window.innerWidth < 640;

/* ======= Image sources (served from public/img for Vercel stability) ====== */
const PRELOAD_SRC = [
  "/img/logo1.png",
  "/img/logo2.png",
  "/img/logo3.png",
  "/img/logo4.png",
  "/img/stoney1.png",
  "/img/stoney2.png",
  "/img/stoney3.png",
];

/* ======= Color themes for CORRUPTED packets (now four colors) ======= */
const CORRUPT_THEMES = [
  { name: "blue",   light: "#60A5FA", base: "#3B82F6", dark: "#1D4ED8" },
  { name: "green",  light: "#34D399", base: "#22C55E", dark: "#15803D" },
  { name: "purple", light: "#C084FC", base: "#A855F7", dark: "#6D28D9" },
  // brand red theme added
  { name: "red",    light: RS_RED_LIGHT, base: RS_RED, dark: RS_RED_DARK },
];

function shinyGradient(theme) {
  return `linear-gradient(180deg, ${theme.light} 0%, ${theme.base} 58%, ${theme.dark} 100%)`;
}
function glossLayer() {
  return `conic-gradient(from 210deg at 30% 25%, rgba(255,255,255,0.28) 0 35%, transparent 42% 100%)`;
}

/* ============================== App ======================================= */
export default function App() {
  const [view, setView] = useState("name");   // name | countdown | game | gameover | leaderboard
  const [player, setPlayer] = useState("");
  const [score, setScore] = useState(0);
  const scoreRef = useRef(0);

  /* -------- Leaderboard -------- */
  const [leaderboard, setLeaderboard] = useState([]);
  const fetchBoard = useCallback(async () => {
    try {
      const r = await fetch(`${BACKEND}/scores?limit=10`, { cache: "no-store" });
      const j = await r.json();
      setLeaderboard(Array.isArray(j?.scores) ? j.scores : []);
    } catch {
      setLeaderboard([]);
    }
  }, []);
  useEffect(() => { fetchBoard(); }, [fetchBoard]);

  /* -------- Fit hero + board + HUD on first screen -------- */
  const headerRef = useRef(null);
  const hudRef    = useRef(null);
  const [boardHeight, setBoardHeight] = useState(560);

  const fitBoardToViewport = useCallback(() => {
    const vh = window.innerHeight || 800;
    const headerH = headerRef.current?.offsetHeight ?? 0;
    const hudH    = hudRef.current?.offsetHeight ?? 0;
    const margins = 32 + 20 + 16;
    const available = vh - headerH - hudH - margins;
    setBoardHeight(clamp(available, 360, 640));
  }, []);

  useEffect(() => {
    fitBoardToViewport();
    window.addEventListener("resize", fitBoardToViewport, { passive: true });
    return () => window.removeEventListener("resize", fitBoardToViewport);
  }, [fitBoardToViewport]);

  /* -------- Preload images to eliminate flicker -------- */
  const [imagesReady, setImagesReady] = useState(false);
  useEffect(() => {
    let alive = true;
    const imgs = PRELOAD_SRC.map((src) => {
      const im = new Image();
      im.decoding = "async";
      im.loading = "eager";
      im.src = src;
      return im;
    });
    Promise.all(
      imgs.map(
        (im) =>
          new Promise((res) => {
            if (im.complete) res();
            else im.onload = im.onerror = () => res();
          })
      )
    ).then(() => alive && setImagesReady(true));
    return () => { alive = false; };
  }, []);

  /* -------- Board sizing & lanes -------- */
  const boardRef = useRef(null);
  const [boardSize, setBoardSize] = useState({ w: 0, h: 0, lanesX: [] });
  const pktSize = isMob() ? PKT_SIZE_MOBILE : PKT_SIZE_DESKTOP;

  const computeLanes = useCallback((w) => {
    const PAD = 14;
    const usable = Math.max(1, w - PAD * 2 - pktSize);
    const step = usable / (LANES - 1);
    return Array.from({ length: LANES }, (_, i) => PAD + i * step);
  }, [pktSize]);

  const measureBoard = useCallback(() => {
    const el = boardRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setBoardSize({ w: r.width, h: r.height, lanesX: computeLanes(r.width) });
  }, [computeLanes]);

  useEffect(() => {
    measureBoard();
    const ro = new ResizeObserver(measureBoard);
    boardRef.current && ro.observe(boardRef.current);
    window.addEventListener("resize", measureBoard, { passive: true });
    return () => { ro.disconnect(); window.removeEventListener("resize", measureBoard); };
  }, [measureBoard, boardHeight]);

  /* -------- Packets + loop state -------- */
  const [packets, setPackets] = useState([]);
  const stateRef = useRef({ packets: [], startedAt: 0 });
  const rafRef = useRef(0);
  const runningRef = useRef(false);
  const lastSpawnRef = useRef(0);

  const resetRound = useCallback(() => {
    setScore(0); scoreRef.current = 0;
    stateRef.current.packets = [];
    setPackets([]);
  }, []);

  const currentSpeed = useCallback(() => {
    const minutes = Math.max(0, (now() - stateRef.current.startedAt) / 60_000);
    const mult = 1 + SPEED_RAMP_PER_MIN * minutes;
    return BASE_SPEED_PX_S * mult; // px / s
  }, []);

  const currentSpawnInterval = useCallback(() => {
    const minutes = Math.max(0, (now() - stateRef.current.startedAt) / 60_000);
    const interval = SPAWN_BASE_MS - SPAWN_ACCEL_PER_MIN * minutes;
    return clamp(interval, SPAWN_MIN_MS, SPAWN_BASE_MS);
  }, []);

  // keep a ring of recent lanes to reduce overlap visually
  const recentLanesRef = useRef([]);
  const pushRecentLane = (lane) => {
    const arr = recentLanesRef.current;
    arr.push(lane);
    if (arr.length > 6) arr.shift();
  };

  const spawnPacket = useCallback(() => {
    const { h, lanesX } = boardSize;
    if (lanesX.length === 0 || h <= 0) return;

    // prefer lanes not used in the last few spawns (reduces stacking)
    let lane = Math.floor(Math.random() * lanesX.length);
    const recents = new Set(recentLanesRef.current.slice(-3));
    for (let tries = 0; tries < 3; tries++) {
      if (!recents.has(lane)) break;
      lane = Math.floor(Math.random() * lanesX.length);
    }
    const x = lanesX[lane];
    const y = 10; // spawn inside container
    const vy = currentSpeed() / 60;
    const valid = Math.random() < VALID_CHANCE;

    // Avoid spawning directly on another packet in same lane
    const minGap = pktSize * 1.1;
    for (const other of stateRef.current.packets) {
      if (Math.abs(other.x - x) < 1) {
        if (other.y < y + minGap && y < other.y + minGap) return;
      }
    }

    const theme = valid ? null : CORRUPT_THEMES[Math.floor(Math.random() * CORRUPT_THEMES.length)];

    stateRef.current.packets.push({
      id: Math.random().toString(36).slice(2),
      x, y, size: pktSize, vy,
      valid,
      img: valid ? PRELOAD_SRC[Math.floor(Math.random() * PRELOAD_SRC.length)] : null,
      theme, // only for corrupted
    });

    pushRecentLane(lane);
  }, [boardSize, pktSize, currentSpeed]);

  const endGame = useCallback(async (reason = "clicked_red") => {
    runningRef.current = false;
    cancelAnimationFrame(rafRef.current);
    try {
      if (player.trim()) {
        await fetch(`${BACKEND}/scores`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: player.trim().slice(0, 20), score: scoreRef.current, reason }),
        });
      }
      await fetchBoard();
    } catch {}
    setView("gameover");
  }, [player, fetchBoard]);

  /* -------- Main loop (endless) -------- */
  const tick = useCallback(() => {
    if (!runningRef.current) return;
    const t = now();

    // dynamic spawn rate
    const needInterval = currentSpawnInterval();
    if (t - lastSpawnRef.current >= needInterval) {
      spawnPacket();
      lastSpawnRef.current = t;
    }

    // integrate & enforce no-cross on red line
    const floorY = boardSize.h - 8;          // top of red line
    const arr = stateRef.current.packets;

    for (let i = arr.length - 1; i >= 0; i--) {
      const p = arr[i];
      p.y = Math.min(p.y + p.vy, floorY - p.size); // clamp so it never crosses

      // remove as soon as it touches the line
      if (p.y + p.size >= floorY) {
        if (p.valid) {
          scoreRef.current += SCORE_GREEN_MISS;
          setScore((s) => s + SCORE_GREEN_MISS);
        }
        arr.splice(i, 1);
      }
    }
    setPackets([...arr]);

    rafRef.current = requestAnimationFrame(tick);
  }, [boardSize.h, spawnPacket, currentSpawnInterval]);

  const startGame = useCallback(() => {
    resetRound();
    stateRef.current.startedAt = now();
    lastSpawnRef.current = 0;
    recentLanesRef.current = [];
    runningRef.current = true;
    setView("game");
    for (let i = 0; i < 4; i++) spawnPacket();
    rafRef.current = requestAnimationFrame(tick);
  }, [resetRound, spawnPacket, tick]);

  /* -------- Name flow -------- */
  const [nameInput, setNameInput] = useState("");
  const onNameSubmit = (e) => {
    e.preventDefault();
    const n = nameInput.trim();
    if (!n) return;
    setPlayer(n.slice(0, 20));
    setView("countdown");
    setTimeout(startGame, COUNTDOWN_MS);
  };

  /* -------- Pointer hit test (mouse + touch) -------- */
  const onFieldPointerDown = (ev) => {
    if (!runningRef.current) return;
    const rect = boardRef.current.getBoundingClientRect();
    const clientX = ev.clientX ?? ev.touches?.[0]?.clientX;
    const clientY = ev.clientY ?? ev.touches?.[0]?.clientY;
    const cx = clientX - rect.left;
    const cy = clientY - rect.top;

    const arr = stateRef.current.packets;
    for (let i = arr.length - 1; i >= 0; i--) {
      const p = arr[i];
      if (cx >= p.x && cx <= p.x + p.size && cy >= p.y && cy <= p.y + p.size) {
        if (p.valid) {
          scoreRef.current += SCORE_PER_HIT;
          setScore((s) => s + SCORE_PER_HIT);
          arr.splice(i, 1);
          setPackets([...arr]);
        } else {
          endGame("clicked_red");
        }
        return;
      }
    }
  };

  /* ============================== UI ====================================== */
  return (
    <div className="min-h-screen w-full flex flex-col items-center">
      {/* Header (centered) */}
      <div ref={headerRef} className="w-full max-w-5xl mx-auto px-4 pt-6 text-center">
        <h1 className="text-3xl sm:text-4xl md:text-5xl font-extrabold tracking-tight">
          <span style={{ color: RS_RED }}>RedStone:</span>{" "}
          <span className="text-white">Data Defender</span>
        </h1>

        <p className="mt-2 text-sm sm:text-base text-zinc-300 max-w-2xl mx-auto">
          Click valid packets <span className="font-semibold text-white/90">(logos)</span>, avoid corrupted ones;{" "}
          <br />{/* legend chips for FOUR colors */}
          <span
            className="inline-block align-[-2px] mx-1 rounded-sm"
            title="corrupted (blue)"
            style={{ width: 14, height: 14, background: shinyGradient(CORRUPT_THEMES[0]) }}
          />
          <span
            className="inline-block align-[-2px] mx-1 rounded-sm"
            title="corrupted (green)"
            style={{ width: 14, height: 14, background: shinyGradient(CORRUPT_THEMES[1]) }}
          />
          <span
            className="inline-block align-[-2px] mx-1 rounded-sm"
            title="corrupted (purple)"
            style={{ width: 14, height: 14, background: shinyGradient(CORRUPT_THEMES[2]) }}
          />
          <span
            className="inline-block align-[-2px] mx-1 rounded-sm"
            title="corrupted (red)"
            style={{ width: 14, height: 14, background: shinyGradient(CORRUPT_THEMES[3]) }}
          />
          .<br />Verify fast. Keep the stream clean.
        </p>
      </div>

      {/* Play area */}
      <div className="w-full max-w-3xl px-4 mt-3">
        <div
          ref={boardRef}
          onPointerDown={onFieldPointerDown}
          className="relative mx-auto rounded-2xl border border-white/10 select-none touch-pan-y shadow-[0_10px_40px_rgba(0,0,0,0.35)]"
          style={{
            width: "min(94vw, 620px)",
            height: `${boardHeight}px`,
            overflow: "hidden",
            background:
              "radial-gradient(120% 120% at 50% 0%, rgba(182,13,29,0.08) 0%, rgba(255,255,255,0.04) 60%, rgba(0,0,0,0.15) 100%)",
          }}
        >
          {/* Soft inner frame */}
          <div className="absolute inset-0 rounded-2xl pointer-events-none ring-1 ring-white/10" />

          {/* Ground (top edge is the collision line) */}
          <div
            className="absolute left-3 right-3 bottom-3 h-2 rounded-full"
            style={{ backgroundColor: RS_RED }}
          />

          {/* Packets */}
          {imagesReady &&
            packets.map((p) =>
              p.valid ? (
                <div
                  key={p.id}
                  className="absolute rounded-xl border shadow-[0_10px_24px_rgba(0,0,0,0.35)]"
                  style={{
                    width: p.size,
                    height: p.size,
                    transform: `translate3d(${p.x}px, ${p.y}px, 0)`,
                    willChange: "transform",
                    borderColor: "rgba(234,179,8,0.7)", // gold rim
                    background: `url(${p.img}) center/contain no-repeat, radial-gradient(120% 120% at 10% 10%, rgba(255,255,255,0.22), transparent 40%)`,
                  }}
                />
              ) : (
                <div
                  key={p.id}
                  className="absolute rounded-xl border shadow-[0_12px_24px_rgba(0,0,0,0.45)]"
                  style={{
                    width: p.size,
                    height: p.size,
                    transform: `translate3d(${p.x}px, ${p.y}px, 0)`,
                    willChange: "transform",
                    borderColor: "rgba(255,255,255,0.35)",
                    background: `${shinyGradient(p.theme)} , ${glossLayer()}`,
                    backgroundBlendMode: "screen, normal",
                  }}
                />
              )
            )}

          {/* Name modal */}
          {view === "name" && (
            <Modal>
              <div className="w-full max-w-md">
                <h2 className="text-lg font-semibold mb-3 text-center">Enter player name</h2>
                <form onSubmit={onNameSubmit} className="space-y-3">
                  <input
                    className="w-full px-3 py-2 rounded-md bg-zinc-800 border border-white/10 outline-none focus:ring-2"
                    style={{ boxShadow: `0 0 0 2px transparent`, outline: "none" }}
                    placeholder="e.g., Zilobyte"
                    value={nameInput}
                    onChange={(e) => setNameInput(e.target.value)}
                    maxLength={20}
                    autoFocus
                  />
                  <button
                    type="submit"
                    className="w-full py-2 rounded-md text-white font-semibold"
                    style={{ backgroundColor: RS_RED }}
                  >
                    Start
                  </button>
                </form>
              </div>
            </Modal>
          )}

          {/* Countdown */}
          {view === "countdown" && (
            <div className="absolute inset-0 grid place-items-center bg-black/60 rounded-2xl">
              <div className="text-center">
                <div className="text-white font-extrabold" style={{ fontSize: isMob() ? "64px" : "86px" }}>
                  <Countdown />
                </div>
                <div className="mt-1 text-zinc-200 text-base sm:text-lg font-semibold">Get ready…</div>
              </div>
            </div>
          )}

          {/* Game over */}
          {view === "gameover" && (
            <Modal>
              <div className="w-full max-w-sm">
                <h2 className="text-xl font-bold mb-1 text-center">Game Over!</h2>
                <p className="text-sm text-zinc-300 mb-4 text-center">
                  You clicked a corrupted packet. Your score: <b>{score}</b>
                </p>
                <div className="flex gap-3 justify-center">
                  <button
                    className="px-4 py-2 rounded-md text-white font-semibold"
                    style={{ backgroundColor: RS_RED }}
                    onClick={() => { setView("countdown"); setTimeout(startGame, COUNTDOWN_MS); }}
                  >
                    Play again
                  </button>
                  <button
                    className="px-4 py-2 rounded-md bg-zinc-800 border border-white/10 text-zinc-200"
                    onClick={() => setView("leaderboard")}
                  >
                    View leaderboard
                  </button>
                </div>
              </div>
            </Modal>
          )}

       {/* Leaderboard — always fully visible inside the board */}
{view === "leaderboard" && (
  <div
    className="absolute inset-0 rounded-2xl"
    style={{
      // use a grid to center, and lock overlay height to the board height
      display: "grid",
      placeItems: "center",
      background: "rgba(0,0,0,0.55)",
    }}
  >
    {(() => {
      // vertical layout math (all values in px)
      const PAD_V     = 10;   // card vertical padding
      const HEADER_H  = 34;   // "Leaderboard" + close
      const BTN_H     = 38;   // Play again button height
      const GAP_ROW   = 6;    // gap between rows
      const GAP_TOP   = 6;    // header -> rows gap
      const GAP_BTN   = 10;   // rows -> button gap

      // total vertical gaps aside from rows themselves
      const staticUsed =
        PAD_V * 2 + HEADER_H + GAP_TOP + GAP_BTN + BTN_H + GAP_ROW * (10 - 1);

      // how much height is left for the 10 rows
      const availForRows = Math.max(120, (boardHeight ?? 560) - staticUsed);

      // compute per-row height so everything fits (clamped for readability)
      const rowHeight = Math.max(24, Math.min(40, Math.floor(availForRows / 10)));

      // Always show top 10 (pad if fewer)
      const top10 = leaderboard && leaderboard.length ? leaderboard.slice(0, 10) : [];
      while (top10.length < 10) top10.push({ name: "—", score: 0 });

      return (
        <div
          className="rounded-xl bg-zinc-900/95 border border-white/10 shadow-[0_6px_28px_rgba(0,0,0,0.5)] w-[90%] max-w-[560px]"
          style={{
            // lock card height to fit entirely in the board
            maxHeight: (boardHeight ?? 560) - 16,
            padding: `${PAD_V}px 12px`,
            fontSize: rowHeight <= 26 ? "0.82rem" : "0.9rem",
          }}
        >
          {/* Header */}
          <div className="flex items-center justify-between" style={{ height: HEADER_H, marginBottom: GAP_TOP }}>
            <h2 className="text-white font-bold text-base sm:text-lg">Leaderboard</h2>
            <button
              className="text-zinc-400 hover:text-white text-sm"
              onClick={() => setView("name")}
            >
              ✕
            </button>
          </div>

          {/* Rows */}
          <ol style={{ display: "grid", rowGap: GAP_ROW }}>
            {top10.map((r, i) => (
              <li
                key={`${r.name}-${r.ts ?? r.at ?? i}`}
                className="flex items-center justify-between bg-zinc-800/70 rounded-md px-2"
                style={{ height: rowHeight }}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="w-6 text-zinc-400 font-mono text-[11px] sm:text-xs">
                    {String(i + 1).padStart(2, "0")}.
                  </span>
                  <span
                    className="font-medium text-white truncate"
                    style={{ maxWidth: "min(46vw, 260px)" }}
                    title={r.name}
                  >
                    {r.name}
                  </span>
                </div>
                <span className="font-semibold text-white/90 tabular-nums text-sm">
                  {r.score}
                </span>
              </li>
            ))}
          </ol>

          {/* Play again */}
          <div className="flex justify-center" style={{ marginTop: GAP_BTN, height: BTN_H }}>
            <button
              className="px-5 rounded-md text-white font-semibold text-sm"
              style={{ backgroundColor: RS_RED, height: BTN_H - 6 }}
              onClick={() => {
                setView("countdown");
                setTimeout(startGame, COUNTDOWN_MS);
              }}
            >
              Play again
            </button>
          </div>
        </div>
      );
    })()}
  </div>
)}
        </div>

        {/* HUD */}
        <div ref={hudRef} className="mt-2 flex items-center justify-between">
          <div className="text-sm">Score: <b>{score}</b></div>
          <div className="text-sm text-zinc-300">Player: <span className="font-medium">{player || "—"}</span></div>
        </div>
      </div>

      {/* How it works – below the fold */}
      <section className="w-full max-w-5xl mx-auto px-4 mt-10 mb-20">
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 md:p-6">
          <h2 className="text-lg md:text-xl font-bold text-white text-center">
            How the game works
          </h2>

          <div className="mt-3 grid md:grid-cols-2 gap-4 text-sm text-zinc-300/95">
            <ul className="space-y-2 leading-relaxed">
              <li>
                <span className="font-semibold text-white">Goal:</span> Defend data integrity like a RedStone gateway node.
              </li>
              <li>
                <span className="font-semibold text-white">Packets:</span> Logos are valid (click to verify). Corrupted squares appear in blue, green, purple, or red; avoid them.
              </li>
              <li>
                <span className="font-semibold text-white">Scoring:</span> +10 per verified logo; missing a logo is −5. Clicking a corrupted square ends the run.
              </li>
            </ul>

            <ul className="space-y-2 leading-relaxed">
              <li>
                <span className="font-semibold text-white">Pacing:</span> The stream speeds up continuously.
              </li>
              <li>
                <span className="font-semibold text-white">Leaderboard:</span> Global top 10 updates after each run.
              </li>
              <li>
                <span className="font-semibold text-white">Tip:</span> Focus on the logos, ignore colored squares even if they reach the floor.
              </li>
            </ul>
          </div>
        </div>
      </section>
    </div>
  );
}

/* ====================== Small UI components ======================= */
function Modal({ children }) {
  return (
    <div className="absolute inset-0 bg-black/60 rounded-2xl grid place-items-center p-4">
      <div className="rounded-xl bg-zinc-900 border border-white/10 p-5 shadow-[0_10px_30px_rgba(0,0,0,0.45)]">
        {children}
      </div>
    </div>
  );
}

function Countdown() {
  const [v, setV] = useState(3);
  useEffect(() => {
    setV(3);
    const id = setInterval(() => setV((n) => (n > 1 ? n - 1 : 1)), 1000);
    return () => clearInterval(id);
  }, []);
  return <span>{v}</span>;
}