import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile, readTextFile, readDir } from "@tauri-apps/plugin-fs";
import { basename, dirname, join } from "@tauri-apps/api/path";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { parseLrc, findActiveIndex, type LyricLine } from "./lib/lrc";

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}


function formatTrackName(name: string) {
  // Remove .mp3 extension (case-insensitive)
  let out = name.replace(/\.mp3$/i, "");

  // Add space after leading track number + dot (e.g. "1.Eminem" -> "1. Eminem")
  out = out.replace(/^(\d+)\.(\S)/, "$1. $2");

  return out;
}

type Track = { path: string; name: string };

type RepeatMode = "off" | "current" | "all";

function safeJsonParse<T>(s: string | null): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

export default function App() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const lineRefs = useRef<(HTMLDivElement | null)[]>([]);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const playlistBoxRef = useRef<HTMLDivElement | null>(null);
  const playlistItemRefs = useRef<Record<number, HTMLButtonElement | null>>({});

  const [playlistQuery, setPlaylistQuery] = useState<string>("");
  const scrollAnimRef = useRef<number>(0);
  const isSeekingRef = useRef<boolean>(false);
  const lastSeekStampRef = useRef<number>(0);
  const pendingSeekRef = useRef<{ path: string; timeSec: number } | null>(null);
  const lastPlaybackWriteRef = useRef<number>(0);
  const measureRef = useRef<HTMLDivElement | null>(null);

  const [status, setStatus] = useState<string>("Ready");

  const [lastFolder, setLastFolder] = useState<string | null>(
    localStorage.getItem("lastFolder")
  );
  const [recursive, setRecursive] = useState<boolean>(
    localStorage.getItem("scanRecursive") !== "false"
  );

  // Lyrics scroll center bias (persisted) — pixels added to centered target (positive moves it down)
    const [lyricCenterBiasPx] = useState<number>(() => {
    const n = Number(localStorage.getItem("lyricCenterBiasPx"));
    return Number.isFinite(n) ? clamp(n, -400, 400) : 60; // default ~2 lines down
  });

  // Playlist
  const [tracks, setTracks] = useState<Track[]>([]);
  const [trackIndex, setTrackIndex] = useState<number>(-1);

  const currentTrack = trackIndex >= 0 ? tracks[trackIndex] : null;

  useEffect(() => {
    if (!currentTrack) return;
    localStorage.setItem("lastTrackPath", currentTrack.path);
  }, [currentTrack?.path]);

  const playlistView = useMemo(() => {
  const withIdx = tracks.map((t, originalIndex) => ({ t, originalIndex }));
  // Default ordering: filename (keeps UI stable and predictable)
  withIdx.sort((a, b) => a.t.name.localeCompare(b.t.name));
  return withIdx;
}, [tracks]);

const filteredPlaylistView = useMemo(() => {
  const q = playlistQuery.trim().toLowerCase();
  if (!q) return playlistView;
  return playlistView.filter(({ t }) => formatTrackName(t.name).toLowerCase().includes(q));
}, [playlistView, playlistQuery]);

  const [audioUrl, setAudioUrl] = useState("");

  // Lyrics
  const [{ lines, lrcOffsetMs }, setLyrics] = useState<{
    lines: LyricLine[];
    lrcOffsetMs: number;
  }>({ lines: [], lrcOffsetMs: 0 });

  const [activeIdx, setActiveIdx] = useState(-1);
  const [follow, setFollow] = useState<boolean>(
    localStorage.getItem("followLyrics") !== "false"
  );

  // Offset (saved per track)
  const [userOffsetMs, setUserOffsetMs] = useState(0);

  const effectiveOffsetMs = useMemo(
    () => lrcOffsetMs + userOffsetMs,
    [lrcOffsetMs, userOffsetMs]
  );

  // Repeat mode (persisted)
  const [repeatMode, setRepeatMode] = useState<RepeatMode>(() => {
    const v = localStorage.getItem("repeatMode");
    return v === "all" || v === "current" || v === "off" ? v : "off";
  });

  // Persist preferences
  useEffect(() => {
    localStorage.setItem("scanRecursive", String(recursive));
  }, [recursive]);

  useEffect(() => {
    localStorage.setItem("followLyrics", String(follow));
  }, [follow]);

  useEffect(() => {
    localStorage.setItem("repeatMode", repeatMode);
  }, [repeatMode]);

  useEffect(() => {
    localStorage.setItem("lyricCenterBiasPx", String(lyricCenterBiasPx));
  }, [lyricCenterBiasPx]);

    // Disable page scrolling from mouse wheel / trackpad when the cursor is over
  // non-scrollable areas. Internal panes (lyrics, playlist) still scroll normally.
  useEffect(() => {
    const allowScrollClosestSelectors = [".lyricsPane", ".playlistBox"];

    const isInsideAllowedScroller = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      if (!el) return false;
      return allowScrollClosestSelectors.some((sel) => !!el.closest(sel));
    };

    const onWheel = (e: WheelEvent) => {
      // If the wheel is not over an allowed internal scroller, prevent the default
      // page scroll (which can make the whole UI drift).
      if (!isInsideAllowedScroller(e.target)) {
        e.preventDefault();
      }
    };

    window.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      window.removeEventListener("wheel", onWheel as any);
    };
  }, []);

// Disable right click everywhere
  useEffect(() => {
    const handler = (e: MouseEvent) => e.preventDefault();
    window.addEventListener("contextmenu", handler);
    return () => window.removeEventListener("contextmenu", handler);
  }, []);



  // Restore last folder on app start (if still accessible)
  useEffect(() => {
    if (!lastFolder) return;
    (async () => {
      try {
        setStatus("Restoring last folder…");
        const mp3Paths = await collectMp3PathsFromFolder(lastFolder, recursive);
        if (!mp3Paths.length) return;

        const list: Track[] = [];
        for (const p of mp3Paths) list.push({ path: p, name: await basename(p) });

        const savedTrackPath = localStorage.getItem("lastTrackPath");
        const startIndex = savedTrackPath
          ? list.findIndex((x) => x.path === savedTrackPath)
          : -1;
        const safeIndex = startIndex >= 0 ? startIndex : 0;

        setTracks(list);
        setTrackIndex(safeIndex);

        const startTrack = list[safeIndex] || list[0];
        await loadTrack(startTrack.path);
        await tryAutoLoadLrc(startTrack.path);

        setStatus(`Restored ${list.length} track(s) ✔`);
      } catch {
        // ignore (folder moved / permissions changed)
      }
    })();
    // run once on mount using stored values
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Revoke old blob url when replaced/unmount
  useEffect(() => {
    return () => {
      if (audioUrl.startsWith("blob:")) URL.revokeObjectURL(audioUrl);
    };
  }, [audioUrl]);

  // Apply audio loop when repeating current
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    a.loop = repeatMode === "current";
  }, [repeatMode]);

  // Persist last played track + time (throttled)
  useEffect(() => {
    const a = audioRef.current;
    if (!a || !currentTrack) return;

    const write = (force = false) => {
      const now = Date.now();
      if (!force && now - lastPlaybackWriteRef.current < 900) return;
      lastPlaybackWriteRef.current = now;

      const timeSec = Number.isFinite(a.currentTime) ? a.currentTime : 0;
      try {
        localStorage.setItem(
          "lastPlayback",
          JSON.stringify({ path: currentTrack.path, timeSec })
        );
      } catch {
        // ignore
      }
    };

    const onTimeUpdate = () => write(false);
    const onPause = () => write(true);
    const onSeeked = () => write(true);
    const onEndedEv = () => write(true);

    a.addEventListener("timeupdate", onTimeUpdate);
    a.addEventListener("pause", onPause);
    a.addEventListener("seeked", onSeeked);
    a.addEventListener("ended", onEndedEv);

    return () => {
      a.removeEventListener("timeupdate", onTimeUpdate);
      a.removeEventListener("pause", onPause);
      a.removeEventListener("seeked", onSeeked);
      a.removeEventListener("ended", onEndedEv);
    };
  }, [currentTrack?.path]);

  // Restore playback time after track loads (when metadata is ready)
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;

    const onLoadedMetadata = () => {
      const pending = pendingSeekRef.current;
      if (!pending || !currentTrack || pending.path !== currentTrack.path) return;

      const dur = Number.isFinite(a.duration) ? a.duration : 0;
      const safeTime = clamp(pending.timeSec, 0, Math.max(0, dur - 0.25));
      if (safeTime > 0.05) a.currentTime = safeTime;

      pendingSeekRef.current = null;
    };

    a.addEventListener("loadedmetadata", onLoadedMetadata);
    return () => a.removeEventListener("loadedmetadata", onLoadedMetadata);
  }, [audioUrl, currentTrack?.path]);

  // Load saved offset whenever track changes
  useEffect(() => {
    if (!currentTrack) return;
    const saved = safeJsonParse<{ userOffsetMs: number }>(
      localStorage.getItem(`offset:${currentTrack.path}`)
    );
    if (saved && typeof saved.userOffsetMs === "number") {
      setUserOffsetMs(clamp(saved.userOffsetMs, -5000, 5000));
    } else {
      setUserOffsetMs(0);
    }
  }, [currentTrack?.path]);

  // Persist offset (debounced) per track
  useEffect(() => {
    if (!currentTrack) return;
    const t = window.setTimeout(() => {
      localStorage.setItem(
        `offset:${currentTrack.path}`,
        JSON.stringify({ userOffsetMs })
      );
    }, 200);
    return () => window.clearTimeout(t);
  }, [currentTrack?.path, userOffsetMs]);

  async function collectMp3PathsFromFolder(
    folderPath: string,
    recurse: boolean = recursive
  ): Promise<string[]> {
    const out: string[] = [];
    const stack: string[] = [folderPath];

    while (stack.length) {
      const dir = stack.pop() as string;

      let entries: any[] = [];
      try {
        entries = await (readDir as any)(dir);
      } catch {
        entries = [];
      }

      for (const e of entries || []) {
        const name = (e.name ?? "") as string;
        const p: string =
          typeof e.path === "string" && e.path
            ? e.path
            : name
            ? await join(dir, name)
            : "";

        if (!p) continue;

        if (e.isDirectory) {
          if (recurse) stack.push(p);
        } else if (p.toLowerCase().endsWith(".mp3")) {
          out.push(p);
        }
      }
    }

    return Array.from(new Set(out)).sort((a, b) => a.localeCompare(b));
  }

  async function pickFolder() {
    setStatus("Opening folder dialog…");
    try {
      const dir = await open({
        directory: true,
        multiple: false,
      });

      if (!dir || Array.isArray(dir)) {
        setStatus("Folder selection cancelled");
        return;
      }

      localStorage.setItem("lastFolder", dir);
      setLastFolder(dir);
      setStatus("Scanning folder for MP3s…");
      const mp3Paths = await collectMp3PathsFromFolder(dir, recursive);

      if (!mp3Paths.length) {
        setTracks([]);
        setTrackIndex(-1);
        setStatus("No MP3 files found in that folder");
        return;
      }

      const list: Track[] = [];
      for (const p of mp3Paths) {
        list.push({ path: p, name: await basename(p) });
      }

      const savedTrackPath = localStorage.getItem("lastTrackPath");
      const startIndex = savedTrackPath
        ? list.findIndex((x) => x.path === savedTrackPath)
        : -1;
      const safeIndex = startIndex >= 0 ? startIndex : 0;

      setTracks(list);
      setTrackIndex(safeIndex);
      setStatus(`Loaded ${list.length} track(s) ✔`);

      const startTrack = list[safeIndex] || list[0];
      await loadTrack(startTrack.path);
      await tryAutoLoadLrc(startTrack.path);
    } catch (e) {
      console.error(e);
      setStatus(
        `Folder load failed ❌: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  async function resetWindowSize() {
    try {
      const win = getCurrentWindow();
      await win.setSize(new LogicalSize(1100, 720));
      await win.center();
      setStatus("Window size reset ✔");
    } catch (e) {
      console.error(e);
      setStatus(
        `Window reset failed: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  async function loadTrack(path: string) {
    setStatus("Reading MP3…");
    const bytes = await readFile(path);
    const blob = new Blob([bytes], { type: "audio/mpeg" });

    // If we have a saved playback position for this same track, stage it to apply
    // once the new <audio> src has loaded its metadata.
    const saved = safeJsonParse<{ path: string; timeSec: number }>(
      localStorage.getItem("lastPlayback")
    );
    if (saved && saved.path === path && typeof saved.timeSec === "number") {
      pendingSeekRef.current = { path, timeSec: saved.timeSec };
    } else {
      pendingSeekRef.current = null;
    }

    setAudioUrl((prev) => {
      if (prev.startsWith("blob:")) URL.revokeObjectURL(prev);
      return URL.createObjectURL(blob);
    });

    setActiveIdx(-1);
  }

  async function tryAutoLoadLrc(mp3Path: string) {
    try {
      const dir = await dirname(mp3Path);
      const base = await basename(mp3Path);
      const stem = base.toLowerCase().endsWith(".mp3") ? base.slice(0, -4) : base;
      const candidate = await join(dir, `${stem}.lrc`);

      setStatus("Looking for matching .lrc…");
      const text = await readTextFile(candidate);

      const parsed = parseLrc(text);
      setLyrics({ lines: parsed.lines, lrcOffsetMs: parsed.offsetMs });
      setActiveIdx(-1);
      setStatus("Auto-loaded matching .lrc ✔");
    } catch {
      setLyrics({ lines: [], lrcOffsetMs: 0 });
      setActiveIdx(-1);
      setStatus("No matching .lrc found (load manually if needed)");
    }
  }

  async function pickMp3() {
    setStatus("Opening MP3 dialog…");
    try {
      const result = await open({
        multiple: true,
        filters: [{ name: "Audio", extensions: ["mp3"] }],
      });

      if (!result) {
        setStatus("MP3 selection cancelled");
        return;
      }

      const paths = Array.isArray(result) ? result : [result];
      if (!paths.length) {
        setStatus("MP3 selection cancelled");
        return;
      }

      const list: Track[] = [];
      for (const p of paths) {
        list.push({ path: p, name: await basename(p) });
      }

      const savedTrackPath = localStorage.getItem("lastTrackPath");
      const startIndex = savedTrackPath
        ? list.findIndex((x) => x.path === savedTrackPath)
        : -1;
      const safeIndex = startIndex >= 0 ? startIndex : 0;

      setTracks(list);
      setTrackIndex(safeIndex);
      setStatus(`Loaded ${list.length} track(s) ✔`);

      const startTrack = list[safeIndex] || list[0];
      await loadTrack(startTrack.path);
      await tryAutoLoadLrc(startTrack.path);
    } catch (e) {
      console.error(e);
      setStatus(`MP3 load failed ❌: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function pickLrc() {
    setStatus("Opening LRC dialog…");
    try {
      const path = await open({
        multiple: false,
        filters: [{ name: "Lyrics", extensions: ["lrc", "txt"] }],
      });

      if (!path || Array.isArray(path)) {
        setStatus("LRC selection cancelled");
        return;
      }

      setStatus("Reading LRC…");
      const text = await readTextFile(path);
      const parsed = parseLrc(text);

      setLyrics({ lines: parsed.lines, lrcOffsetMs: parsed.offsetMs });
      setActiveIdx(-1);
      setStatus("LRC loaded ✔");
    } catch (e) {
      console.error(e);
      setStatus(`LRC load failed ❌: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function goToIndex(next: number) {
    if (tracks.length === 0) return;
    const idx = clamp(next, 0, tracks.length - 1);
    setTrackIndex(idx);
    const t = tracks[idx];
    setStatus(`Loading: ${formatTrackName(t.name)}`);
    try {
      await loadTrack(t.path);
      await tryAutoLoadLrc(t.path);

      // autoplay if audio element exists
      queueMicrotask(() => audioRef.current?.play().catch(() => {}));
    } catch (e) {
      console.error(e);
      setStatus(`Track load failed ❌: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function prevTrack() {
    if (tracks.length === 0) return;
    if (trackIndex <= 0) return goToIndex(0);
    void goToIndex(trackIndex - 1);
  }

  function nextTrack() {
    if (tracks.length === 0) return;
    if (trackIndex >= tracks.length - 1) return goToIndex(tracks.length - 1);
    void goToIndex(trackIndex + 1);
  }

function scrollPlaylistToIndex(originalIndex: number) {
  const box = playlistBoxRef.current;
  const btn = playlistItemRefs.current[originalIndex] || null;
  if (!box || !btn) return;

  const boxRect = box.getBoundingClientRect();
  const btnRect = btn.getBoundingClientRect();

  // Compute the button's top relative to the scroll container
  const topInBox = btnRect.top - boxRect.top + box.scrollTop;
  const target = topInBox - box.clientHeight / 2 + btnRect.height / 2;

  const maxTop = Math.max(0, box.scrollHeight - box.clientHeight);
  box.scrollTop = clamp(target, 0, maxTop);
}

function scrollToNowPlaying() {
  if (trackIndex < 0) return;
  scrollPlaylistToIndex(trackIndex);
}



  // When a track ends, apply repeat logic
  function onEnded() {
    if (repeatMode === "current") return; // audio.loop already handles it
    if (repeatMode === "all") {
      if (tracks.length <= 1) return;
      const next = trackIndex + 1;
      if (next < tracks.length) void goToIndex(next);
      else void goToIndex(0);
      return;
    }
    // repeatMode === "off"
  }

  // Custom smooth scroll (slightly slower + consistent easing across platforms)
  function smoothScrollTo(el: HTMLElement, top: number, durationMs = 520) {
    if (scrollAnimRef.current) cancelAnimationFrame(scrollAnimRef.current);

    const start = el.scrollTop;
    const delta = top - start;
    if (Math.abs(delta) < 0.5) {
      el.scrollTop = top;
      return;
    }

    const t0 = performance.now();
    const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

    const step = (now: number) => {
      const t = clamp((now - t0) / durationMs, 0, 1);
      const eased = easeOutCubic(t);
      el.scrollTop = start + delta * eased;
      if (t < 1) scrollAnimRef.current = requestAnimationFrame(step);
    };

    scrollAnimRef.current = requestAnimationFrame(step);
  }

  // Smooth scroll helper: keep active line centered (robust across layout/resize)
  function scrollActiveIntoView(idx: number) {
    const pane = paneRef.current;
    const el = lineRefs.current[idx];
    if (!pane || !el) return;

    const biasPx = lyricCenterBiasPx; // persisted; positive moves the active line lower

    // Use DOM rects rather than offsetTop so this works even if offsetParent changes
    // (e.g. fullscreen vs reset window, different positioning/stacking contexts).
    const paneRect = pane.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const elTopInPane = elRect.top - paneRect.top + pane.scrollTop;
    const elCenterInPane = elTopInPane + elRect.height / 2;

    const desiredCenterInPane = pane.clientHeight / 2 + biasPx;
    const rawTargetTop = elCenterInPane - desiredCenterInPane;

    const maxTop = Math.max(0, pane.scrollHeight - pane.clientHeight);
    const targetTop = clamp(rawTargetTop, 0, maxTop);

    smoothScrollTo(pane, targetTop);
  }

  function computeStableActiveIndex(tMs: number) {
    // Use floor to avoid boundary wobble on exact transitions
    let idx = findActiveIndex(lines, Math.floor(tMs));

    // If multiple consecutive lines share the exact same timestamp,
    // jump straight to the last one to avoid a visible "step".
    while (
      idx >= 0 &&
      idx + 1 < lines.length &&
      lines[idx + 1].tMs === lines[idx].tMs
    ) {
      idx++;
    }

    return idx;
  }


  // ✅ Stable centering padding: avoids scrollHeight/offset interactions on highlight changes.
  // This replaces the old "40vh" padding and prevents the "jump then recenter" effect.
  useLayoutEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;

    let raf = 0;

    const updatePad = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const measurer = measureRef.current;
        if (!measurer) return;

        // Measure a consistent single-line height so padding stays stable even when
        // the active lyric wraps to multiple lines.
        const baseLineH = measurer.getBoundingClientRect().height || 0;
        const pad = pane.clientHeight / 2 - baseLineH / 2;
        pane.style.setProperty("--lyrics-pad-y", `${Math.max(0, Math.floor(pad))}px`);
      });
    };

    updatePad();

    const ro = new ResizeObserver(() => updatePad());
    ro.observe(pane);

    window.addEventListener("resize", updatePad);

    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", updatePad);
    };
  }, [lines.length]);

  // Highlight + scroll loop (updates activeIdx only)
  useEffect(() => {
    let raf = 0;
    let lastIdx = -2;

    const tick = () => {
      const a = audioRef.current;

      if (isSeekingRef.current) {
        raf = requestAnimationFrame(tick);
        return;
      }

      if (a && lines.length > 0) {
        const tMs = a.currentTime * 1000 + effectiveOffsetMs;
        const idx = computeStableActiveIndex(tMs);

        if (idx !== lastIdx) {
          lastIdx = idx;
          setActiveIdx(idx);
        }
      }

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [lines, effectiveOffsetMs]);

  // When the user scrubs the timeline, lock updates until seek settles,
  // then commit exactly one activeIdx + snap scroll to center.
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;

    const onSeeking = () => {
      isSeekingRef.current = true;
      lastSeekStampRef.current = performance.now();
      if (scrollAnimRef.current) cancelAnimationFrame(scrollAnimRef.current);
    };

    const onSeeked = () => {
      isSeekingRef.current = false;
      lastSeekStampRef.current = performance.now();

      if (lines.length === 0) return;
      const tMs = a.currentTime * 1000 + effectiveOffsetMs;
      const idx = computeStableActiveIndex(tMs);
      setActiveIdx(idx);

      if (!follow || idx < 0) return;

      // Snap immediately so the highlight never appears to step a line.
      const pane = paneRef.current;
      const el = lineRefs.current[idx];
      if (!pane || !el) return;

      const paneRect = pane.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const elTopInPane = elRect.top - paneRect.top + pane.scrollTop;
      const elCenterInPane = elTopInPane + elRect.height / 2;
      const desiredCenterInPane = pane.clientHeight / 2 + lyricCenterBiasPx;
      const rawTargetTop = elCenterInPane - desiredCenterInPane;
      const maxTop = Math.max(0, pane.scrollHeight - pane.clientHeight);
      pane.scrollTop = clamp(rawTargetTop, 0, maxTop);
    };

    a.addEventListener("seeking", onSeeking);
    a.addEventListener("seeked", onSeeked);
    return () => {
      a.removeEventListener("seeking", onSeeking);
      a.removeEventListener("seeked", onSeeked);
    };
  }, [lines, effectiveOffsetMs, follow, lyricCenterBiasPx]);


  // Scroll after the active line has been rendered/highlighted (prevents "jump then correct")
  useLayoutEffect(() => {
    if (!follow) return;
    if (activeIdx < 0 || lines.length === 0) return;

    const id = requestAnimationFrame(() => scrollActiveIntoView(activeIdx));
    return () => cancelAnimationFrame(id);
  }, [activeIdx, follow, lines.length, lyricCenterBiasPx]);

  // Click lyric → seek
  function seekToLine(line: LyricLine, indexGuess?: number) {
    const a = audioRef.current;
    if (!a) return;

    const targetMs = line.tMs - effectiveOffsetMs;
    a.currentTime = Math.max(0, targetMs / 1000);

    if (follow) {
      const idx =
        typeof indexGuess === "number"
          ? indexGuess
          : lines.findIndex((x) => x.tMs === line.tMs && x.text === line.text);
      if (idx >= 0) setActiveIdx(idx);
    }
  }

  // Offset +/- buttons (1ms each click; Shift=10, Option/Alt=100)
  function nudgeOffset(direction: 1 | -1, e?: React.MouseEvent) {
    const mult = e?.altKey ? 100 : e?.shiftKey ? 10 : 1;
    setUserOffsetMs((v) => clamp(v + direction * mult, -5000, 5000));
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div className="title">
          <div className="appName">LyricFlow</div>
        </div>

        <div className="actions">
          <button onClick={pickMp3}>Load MP3</button>
          <button onClick={pickFolder} className="secondary">
            Load Folder
          </button>
          <label
            className="checkbox topbarToggle"
            title="When off, only scans the selected folder (no subfolders)"
          >
            <input
              type="checkbox"
              checked={recursive}
              onChange={(e) => setRecursive(e.target.checked)}
            />
            Recursive
          </label>

          <button onClick={pickLrc}>Load .LRC</button>
          <button onClick={resetWindowSize} className="secondary">
            Reset Window Size
          </button>
        </div>
      </header>

      <div style={{ padding: "6px 16px", fontSize: 12, opacity: 0.8 }}>
        {status}
      </div>

      <main className="main">
        <section className="left">
          <div className="card">
            <div className="cardTitle">Player</div>

            <audio
              ref={audioRef}
              controls
              src={audioUrl}
              style={{ width: "100%" }}
              onEnded={onEnded}
            />

            <div className="row">
              <button
                onClick={prevTrack}
                disabled={tracks.length === 0 || trackIndex <= 0}
              >
                ◀ Prev
              </button>
              <button
                onClick={nextTrack}
                disabled={
                  tracks.length === 0 || trackIndex >= tracks.length - 1
                }
              >
                Next ▶
              </button>
              <div className="repeatGroup">
                <button
                  className={repeatMode === "off" ? "active" : ""}
                  onClick={() => setRepeatMode("off")}
                  title="Repeat off"
                >
                  Off
                </button>
                <button
                  className={repeatMode === "current" ? "active" : ""}
                  onClick={() => setRepeatMode("current")}
                  title="Repeat current track"
                >
                  1
                </button>
                <button
                  className={repeatMode === "all" ? "active" : ""}
                  onClick={() => setRepeatMode("all")}
                  title="Repeat all"
                >
                  All
                </button>
              </div>
            </div>

            <div className="row">
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={follow}
                  onChange={(e) => setFollow(e.target.checked)}
                />
                Follow lyrics
              </label>
            </div>

            <div className="row">
              <div className="label">Offset</div>

              <button
                onClick={(e) => nudgeOffset(-1, e)}
                title="−1ms (Shift=10, Option=100)"
              >
                −
              </button>

              <input
                type="range"
                min={-5000}
                max={5000}
                step={1}
                value={userOffsetMs}
                onChange={(e) =>
                  setUserOffsetMs(clamp(Number(e.target.value), -5000, 5000))
                }
              />

              <button
                onClick={(e) => nudgeOffset(1, e)}
                title="+1ms (Shift=10, Option=100)"
              >
                +
              </button>

              <div className="mono">{userOffsetMs} ms</div>
            </div>
          </div>

          <div className="card">
            
<div className="cardTitle playlistTitleRow">
  <span>Playlist</span>
  <div className="playlistTools">
    <button
      className="playlistNowPlayingBtn"
      type="button"
      onClick={scrollToNowPlaying}
      disabled={trackIndex < 0}
      title="Scroll playlist to the currently playing song"
    >
      Now Playing
    </button>

    <input
      className="playlistSearch"
      type="search"
      value={playlistQuery}
      onChange={(e) => setPlaylistQuery(e.target.value)}
      placeholder="Search…"
      aria-label="Search playlist"
    />
  </div>
</div>

            {tracks.length === 0 ? (
              <div className="playlistEmpty">No tracks loaded</div>
            ) : (
              <div className="playlistScrollWrap">
              <div
                className="playlistBox"
                role="list"
                ref={playlistBoxRef}
              >
                
{filteredPlaylistView.length === 0 ? (
  <div className="playlistEmpty">No matches</div>
) : (
  filteredPlaylistView.map(({ t, originalIndex }, i) => (
    <button
      key={t.path}
      className={
        originalIndex === trackIndex
          ? "playlistItem active"
          : "playlistItem"
      }
      onClick={() => goToIndex(originalIndex)}
      ref={(el) => {
        playlistItemRefs.current[originalIndex] = el;
      }}
      type="button"
    >
      <span className="playingDot">
        {originalIndex === trackIndex ? "●" : ""}
      </span>
      <span className="playlistIndex">{i + 1}.</span>
      <span className="playlistName">{formatTrackName(t.name)}</span>
    </button>
  ))
)}</div>
  </div>
)}
          </div>
        </section>

        <section className="right">
          <div className="lyricsBox">
            <div className="lyricsHeader">
              <div className="lyricsTitle">Lyrics</div>
              {!lines.length && (
                <div className="lyricsEmpty">Load an .lrc file to start syncing.</div>
              )}
            </div>

            <div ref={measureRef} className="line lineMeasure">Hg</div>

            <div className="lyricsPane" ref={paneRef}>
              {lines.map((l, i) => (
                <div
                  key={`${l.tMs}:${i}`}
                                    ref={(el) => {
                                      lineRefs.current[i] = el;
                                    }}
                  className={i === activeIdx ? "line active" : "line"}
                  title={`${(l.tMs / 1000).toFixed(2)}s (click to seek)`}
                  onClick={() => seekToLine(l, i)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") seekToLine(l, i);
                  }}
                >
                  {l.text || "…"}
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
