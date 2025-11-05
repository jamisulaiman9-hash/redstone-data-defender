// src/App.jsx
import { useCallback, useEffect, useRef, useState } from "react";

/* ============================== Config =============================== */
// Flow
const COUNTDOWN_MS        = 3_000;       // 3-2-1 overlay

// Gameplay (endless)
const LANES               = 5;           // exactly five fixed lanes
const PKT_SIZE_DESKTOP    = 66;
const PKT_SIZE_MOBILE     = 58;

const VALID_CHANCE        = 0.40;        // 40% green, 60% red
const SCORE_PER_HIT       = 10;          // +10 per verified green
const SCORE_GREEN_MISS    = -5;          // -5 if a green touches the floor

// Difficulty ramp (speeds & spawn rate increase over time)
const BASE_SPEED_PX_S     = 260;         // starting fall speed (px/sec)
const SPEED_RAMP_PER_MIN  = 0.55;        // +55% speed every minute
const SPAWN_BASE_MS       = 520;         // initial spawn interval
const SPAWN_MIN_MS        = 120;         // minimum (fastest) spawn interval
const SPAWN_ACCEL_PER_MIN = 300;         // reduce interval by this / minute

/* Backend URL that works on both phone & PC in the same LAN */
const HOST     = typeof window !== "undefined" ? window.location.hostname : "localhost";
const BACKEND  = (import.meta.env.VITE_API || `http://${HOST}:8787`).replace(/\/+$/, "");

/* ============================== Helpers ============================== */
const now   = () => performance.now();
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const isMob = () => window.innerWidth < 640;

/* ============================== App ================================= */
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

    // breathable margins around sections
    const margins = 32 /* top */ + 20 /* between board & HUD */ + 16 /* bottom */;
    const available = vh - headerH - hudH - margins;

    // clamp for small phones up to comfy desktops
    setBoardHeight(clamp(available, 360, 640));
  }, []);

  useEffect(() => {
    fitBoardToViewport();
    window.addEventListener("resize", fitBoardToViewport, { passive: true });
    return () => window.removeEventListener("resize", fitBoardToViewport);
  }, [fitBoardToViewport]);

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

  const spawnPacket = useCallback(() => {
    const { h, lanesX } = boardSize;
    if (lanesX.length === 0 || h <= 0) return;

    const lane = Math.floor(Math.random() * lanesX.length);
    const x = lanesX[lane];
    const y = 10; // spawn inside container

    const vy = currentSpeed() / 60; // px / frame (~60fps)

    stateRef.current.packets.push({
      id: Math.random().toString(36).slice(2),
      x, y, size: pktSize, vy,
      valid: Math.random() < VALID_CHANCE, // green if true, red if false
    });
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
    setView("gameover");  // do not auto-open leaderboard
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

    // integrate
    const floorY = boardSize.h - 8;
    const arr = stateRef.current.packets;
    for (let i = arr.length - 1; i >= 0; i--) {
      const p = arr[i];
      p.y += p.vy;

      if (p.y + p.size >= floorY) {
        if (p.valid) {
          // green missed — deduct points, continue
          scoreRef.current += SCORE_GREEN_MISS;
          setScore(s => s + SCORE_GREEN_MISS);
        }
        // remove packet once it hits the floor (green OR red)
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
    runningRef.current = true;
    setView("game");

    // seed a few packets so it starts active
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
          setScore(s => s + SCORE_PER_HIT);
          arr.splice(i, 1);
          setPackets([...arr]);
        } else {
          endGame("clicked_red"); // end immediately on red click
        }
        return;
      }
    }
  };

  /* ============================== UI ================================= */
  return (
    <div className="min-h-screen w-full flex flex-col items-center">
      {/* Header (centered) */}
      <div ref={headerRef} className="w-full max-w-5xl mx-auto px-4 pt-6 text-center">
        <h1 className="text-3xl sm:text-4xl md:text-5xl font-extrabold tracking-tight">
          <span className="bg-gradient-to-r from-rose-400 to-rose-300 bg-clip-text text-transparent">
            RedStone:
          </span>{" "}
          <span className="text-white">Data Defender</span>{" "}
        </h1>

        <p className="mt-2 text-sm sm:text-base text-zinc-300 max-w-2xl mx-auto">
          Click valid packets <span className="text-green-400 font-semibold">🟩</span> avoid corrupted ones{" "}
          <span className="text-rose-400 font-semibold">🟥</span>.<br />Verify fast. Keep the stream clean.
        </p>
      </div>

      {/* Play area (fits first screen; everything visible) */}
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
              "radial-gradient(120% 120% at 50% 0%, rgba(244,63,94,0.06) 0%, rgba(255,255,255,0.04) 60%, rgba(0,0,0,0.15) 100%)",
          }}
        >
          {/* Soft inner frame */}
          <div className="absolute inset-0 rounded-2xl pointer-events-none ring-1 ring-white/10" />
          {/* Ground */}
          <div className="absolute left-3 right-3 bottom-3 h-2 rounded-full bg-rose-500/70" />

          {/* Packets */}
          {packets.map(p => (
            <div
              key={p.id}
              className={`absolute rounded-xl border shadow-[0_6px_18px_rgba(0,0,0,0.35)] ${
                p.valid ? "bg-green-400/90 border-green-200/50"
                        : "bg-rose-500/90 border-rose-200/50"
              }`}
              style={{
                width: p.size, height: p.size,
                transform: `translate3d(${p.x}px, ${p.y}px, 0)`,
                willChange: "transform",
              }}
            />
          ))}

          {/* Name modal */}
          {view === "name" && (
            <Modal>
              <div className="w-full max-w-md">
                <h2 className="text-lg font-semibold mb-3 text-center">Enter player name</h2>
                <form onSubmit={onNameSubmit} className="space-y-3">
                  <input
                    className="w-full px-3 py-2 rounded-md bg-zinc-800 border border-white/10 outline-none focus:ring-2 focus:ring-rose-400"
                    placeholder="e.g., Zilobyte"
                    value={nameInput}
                    onChange={(e) => setNameInput(e.target.value)}
                    maxLength={20}
                    autoFocus
                  />
                  <button type="submit" className="w-full py-2 rounded-md bg-rose-500 hover:bg-rose-400 text-white font-semibold">
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

          {/* Game over (manual leaderboard) */}
          {view === "gameover" && (
            <Modal>
              <div className="w-full max-w-sm">
                <h2 className="text-xl font-bold mb-1 text-center">Game Over!</h2>
                <p className="text-sm text-zinc-300 mb-4 text-center">
                  You clicked a corrupted packet. Your score: <b>{score}</b>
                </p>
                <div className="flex gap-3 justify-center">
                  <button
                    className="px-4 py-2 rounded-md bg-rose-500 hover:bg-rose-400 text-white font-semibold"
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

          {/* Leaderboard (open on demand) */}
          {view === "leaderboard" && (
            <Modal>
              <div className="w-full max-w-lg">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-xl font-bold">Leaderboard</h2>
                  <button className="text-zinc-400 hover:text-white" onClick={() => setView("name")}>✕</button>
                </div>
                <ol className="space-y-2 max-h-[50vh] overflow-auto pr-1">
                  {leaderboard.length === 0 && <li className="text-zinc-400 text-sm">No scores yet.</li>}
                  {leaderboard.slice(0, 10).map((r, i) => (
                    <li key={`${r.name}-${r.ts ?? r.at ?? i}`} className="flex items-center justify-between bg-zinc-800/50 rounded-lg px-3 py-2">
                      <div className="flex items-center gap-3">
                        <span className="w-8 text-zinc-400">{String(i + 1).padStart(2, "0")}.</span>
                        <span className="font-medium">{r.name}</span>
                      </div>
                      <span className="font-bold">{r.score}</span>
                    </li>
                  ))}
                </ol>
                <div className="mt-3">
                  <button
                    className="px-4 py-2 rounded-md bg-rose-500 hover:bg-rose-400 text-white font-semibold"
                    onClick={() => { setView("countdown"); setTimeout(startGame, COUNTDOWN_MS); }}
                  >
                    Play again
                  </button>
                </div>
              </div>
            </Modal>
          )}
        </div>

        {/* HUD – kept visible on first screen */}
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
                <span className="font-semibold text-white">Packets:</span> Green = valid (click to verify). Red = corrupted (avoid).
              </li>
              <li>
                <span className="font-semibold text-white">Scoring:</span> +10 per green; missing a green is −5. Reds don’t matter unless you click them.
              </li>
            </ul>

            <ul className="space-y-2 leading-relaxed">
              <li>
                <span className="font-semibold text-white">Leaderboard:</span> Global top 10 updates after each run.
              </li>
              <li>
                <span className="font-semibold text-white">Tip:</span> Focus greens, ignore reds even if they reach the floor.
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
    const id = setInterval(() => setV(n => (n > 1 ? n - 1 : 1)), 1000);
    return () => clearInterval(id);
  }, []);
  return <span>{v}</span>;
}