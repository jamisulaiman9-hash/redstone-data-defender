// src/App.jsx
import { useCallback, useEffect, useRef, useState } from "react";

/* ======= Assets (green packet = logos) ======= */
import Logo1   from "./assets/img/logo1.png";
import Logo2   from "./assets/img/logo2.png";
import Logo3   from "./assets/img/logo3.png";
import Logo4   from "./assets/img/logo4.png";
import Stoney1 from "./assets/img/stoney1.png";
import Stoney2 from "./assets/img/stoney2.png";
import Stoney3 from "./assets/img/stoney3.png";

/* ============================== Config =============================== */
// Flow
const COUNTDOWN_MS        = 3_000;

// Gameplay (endless)
const LANES               = 5;
const PKT_SIZE_DESKTOP    = 66;
const PKT_SIZE_MOBILE     = 58;

const VALID_CHANCE        = 0.40;  // 40% logos, 60% red
const SCORE_PER_HIT       = 10;
const SCORE_GREEN_MISS    = -5;

// Difficulty ramp
const BASE_SPEED_PX_S     = 260;
const SPEED_RAMP_PER_MIN  = 0.55;
const SPAWN_BASE_MS       = 520;
const SPAWN_MIN_MS        = 120;
const SPAWN_ACCEL_PER_MIN = 300;

/* Floor geometry (must match Tailwind classes on the red line) */
const FLOOR_PAD_PX        = 12;   // bottom-3
const FLOOR_HEIGHT_PX     = 8;    // h-2

/* Backend URL */
const HOST     = typeof window !== "undefined" ? window.location.hostname : "localhost";
const BACKEND  = (import.meta.env.VITE_API || `http://${HOST}:8787`).replace(/\/+$/, "");

/* ============================== Helpers ============================== */
const now   = () => performance.now();
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const isMob = () => window.innerWidth < 640;

/* Green sprite set (logos) with per-sprite scale (Stoney slightly larger) */
const GREEN_SPRITES = [
  { src: Logo1,   scale: 1.00 },
  { src: Logo2,   scale: 1.00 },
  { src: Logo3,   scale: 1.00 },
  { src: Logo4,   scale: 1.00 },
  { src: Stoney1, scale: 1.22 },
  { src: Stoney2, scale: 1.22 },
  { src: Stoney3, scale: 1.22 },
];

/* Actual draw size of a packet (accounts for logo scale) */
const drawSize = (p) => (p.valid && p.img ? p.size * (p.scale ?? 1) : p.size);

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
    const margins = 32 + 20 + 16;
    const available = vh - headerH - hudH - margins;
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

  // Prevent stacking: require a minimum gap in the selected lane
  const laneSafeToSpawn = useCallback((laneIdx) => {
    const arr = stateRef.current.packets;
    const SPAWN_Y = 10;
    const MIN_GAP = pktSize * 1.25; // vertical safety
    let nearestY = Infinity;

    for (let i = 0; i < arr.length; i++) {
      const p = arr[i];
      if (p.lane !== laneIdx) continue;
      if (p.y < nearestY) nearestY = p.y;
    }
    if (nearestY === Infinity) return true;
    return nearestY >= (SPAWN_Y + pktSize + (MIN_GAP - pktSize));
  }, [pktSize]);

  const spawnPacket = useCallback(() => {
    const { h, lanesX } = boardSize;
    if (lanesX.length === 0 || h <= 0) return;

    const candidates = [];
    for (let i = 0; i < lanesX.length; i++) {
      if (laneSafeToSpawn(i)) candidates.push(i);
    }
    if (candidates.length === 0) return;

    const lane = candidates[Math.floor(Math.random() * candidates.length)];
    const x = lanesX[lane];
    const y = 10;

    const isValid = Math.random() < VALID_CHANCE;
    let img = null, scale = 1;
    if (isValid) {
      const pick = GREEN_SPRITES[Math.floor(Math.random() * GREEN_SPRITES.length)];
      img = pick.src;
      scale = pick.scale ?? 1;
    }

    stateRef.current.packets.push({
      id: Math.random().toString(36).slice(2),
      lane,
      x, y, size: pktSize,
      valid: isValid,
      img,
      scale,
    });
  }, [boardSize, pktSize, laneSafeToSpawn]);

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

    // Spawn pacing
    const needInterval = currentSpawnInterval();
    if (t - lastSpawnRef.current >= needInterval) {
      spawnPacket();
      lastSpawnRef.current = t;
    }

    // Move all by the same step (no catching-up)
    const step = currentSpeed() / 60;
    const floorTop = boardSize.h - FLOOR_PAD_PX - FLOOR_HEIGHT_PX; // top edge of red bar
    const arr = stateRef.current.packets;

    for (let i = arr.length - 1; i >= 0; i--) {
      const p = arr[i];
      const sizeH = drawSize(p);           // <-- real drawn height
      const nextY = p.y + step;
      const wouldBottom = nextY + sizeH;

      // Remove exactly when touching the top of the red line — no visual crossing
      if (wouldBottom >= floorTop) {
        if (p.valid) {
          scoreRef.current += SCORE_GREEN_MISS;
          setScore(s => s + SCORE_GREEN_MISS);
        }
        arr.splice(i, 1);
      } else {
        p.y = nextY;
      }
    }

    setPackets([...arr]);
    rafRef.current = requestAnimationFrame(tick);
  }, [boardSize.h, currentSpeed, currentSpawnInterval, spawnPacket]);

  const startGame = useCallback(() => {
    resetRound();
    stateRef.current.startedAt = now();
    lastSpawnRef.current = 0;
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
      const w = drawSize(p);     // <-- real clickable size
      const h = w;
      const px = p.valid && p.img ? p.x + (p.size - w) / 2 : p.x; // center logos
      if (cx >= px && cx <= px + w && cy >= p.y && cy <= p.y + h) {
        if (p.valid) {
          scoreRef.current += SCORE_PER_HIT;
          setScore(s => s + SCORE_PER_HIT);
          arr.splice(i, 1);
          setPackets([...arr]);
        } else {
          endGame("clicked_red");
        }
        return;
      }
    }
  };

  /* ============================== UI ================================= */
  return (
    <div className="min-h-screen w-full flex flex-col items-center">
      {/* Header */}
      <div ref={headerRef} className="w-full max-w-5xl mx-auto px-4 pt-6 text-center">
        <h1 className="text-3xl sm:text-4xl md:text-5xl font-extrabold tracking-tight">
          <span className="bg-gradient-to-r from-rose-400 to-rose-300 bg-clip-text text-transparent">
            RedStone:
          </span>{" "}
          <span className="text-white">Data Defender</span>
        </h1>
        <p className="mt-2 text-sm sm:text-base text-zinc-300 max-w-2xl mx-auto">
          Click valid packets <span className="font-semibold">(logos)</span>{" "}
          avoid corrupted ones <span className="text-rose-400 font-semibold">🟥</span>.<br />Verify fast. Keep the stream clean.
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
              "radial-gradient(120% 120% at 50% 0%, rgba(244,63,94,0.06) 0%, rgba(255,255,255,0.04) 60%, rgba(0,0,0,0.15) 100%)",
          }}
        >
          {/* inner frame */}
          <div className="absolute inset-0 rounded-2xl pointer-events-none ring-1 ring-white/10" />
          {/* Ground (red line) */}
          <div className="absolute left-3 right-3 bottom-3 h-2 rounded-full bg-rose-500/70" />

          {/* Packets */}
          {packets.map(p => {
            if (p.valid && p.img) {
              const w = drawSize(p);
              const offsetX = p.x + (p.size - w) / 2;
              return (
                <img
                  key={p.id}
                  src={p.img}
                  alt="valid-packet"
                  className="absolute rounded-xl select-none"
                  style={{
                    width: w,
                    height: w,
                    objectFit: "contain",
                    transform: `translate3d(${offsetX}px, ${p.y}px, 0)`,
                    willChange: "transform",
                    border: "2px solid rgba(255,255,255,0.7)",
                    boxShadow:
                      "0 10px 22px rgba(0,0,0,.35), 0 0 14px rgba(255,255,255,.35)",
                    background:
                      "radial-gradient(65% 65% at 50% 35%, rgba(255,255,255,.18) 0%, rgba(255,255,255,0) 60%)",
                    borderRadius: "14px",
                  }}
                  draggable={false}
                />
              );
            }
            return (
              <div
                key={p.id}
                className="absolute rounded-xl"
                style={{
                    width: p.size,
                    height: p.size,
                    transform: `translate3d(${p.x}px, ${p.y}px, 0)`,
                    willChange: "transform",
                    background:
                      "linear-gradient(145deg, rgba(244,63,94,0.98) 0%, rgba(225,29,72,0.98) 55%, rgba(190,18,60,0.96) 100%)",
                    boxShadow:
                      "inset 0 4px 8px rgba(255,255,255,.10), inset 0 -6px 10px rgba(0,0,0,.25), 0 10px 22px rgba(0,0,0,.35)",
                    border: "1px solid rgba(255,255,255,.10)",
                }}
              />
            );
          })}

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

          {/* Leaderboard */}
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

        {/* HUD */}
        <div ref={hudRef} className="mt-2 flex items-center justify-between">
          <div className="text-sm">Score: <b>{score}</b></div>
          <div className="text-sm text-zinc-300">Player: <span className="font-medium">{player || "—"}</span></div>
        </div>
      </div>

      {/* How it works */}
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
                <span className="font-semibold text-white">Packets:</span> Logos = valid (click to verify). Red squares = corrupted (avoid).
              </li>
              <li>
                <span className="font-semibold text-white">Scoring:</span> +10 per logo; missing a logo is −5. Reds don’t matter unless you click them.
              </li>
            </ul>

            <ul className="space-y-2 leading-relaxed">
              <li>
                <span className="font-semibold text-white">Leaderboard:</span> Global top 10 updates after each run.
              </li>
              <li>
                <span className="font-semibold text-white">Tip:</span> Focus logos, ignore reds even if they reach the floor.
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