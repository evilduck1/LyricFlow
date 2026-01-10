export type LyricLine = { tMs: number; text: string };

export function parseLrc(lrc: string): { lines: LyricLine[]; offsetMs: number } {
  const out: LyricLine[] = [];
  let offsetMs = 0;

  const offsetMatch = lrc.match(/^\[offset:([+-]?\d+)\]\s*$/mi);
  if (offsetMatch) offsetMs = Number(offsetMatch[1]) || 0;

  for (const raw of lrc.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    const tags = [...line.matchAll(/\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g)];
    if (tags.length === 0) continue;

    const text = line.replace(/\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g, "").trim();

    for (const m of tags) {
      const mm = Number(m[1]);
      const ss = Number(m[2]);
      const frac = m[3] ?? "0";
      const ms =
        frac.length === 3 ? Number(frac) :
        frac.length === 2 ? Number(frac) * 10 :
        Number(frac) * 100;

      out.push({ tMs: (mm * 60 + ss) * 1000 + ms, text });
    }
  }

  out.sort((a, b) => a.tMs - b.tMs);

  const dedup: LyricLine[] = [];
  for (const item of out) {
    const prev = dedup[dedup.length - 1];
    if (prev && prev.tMs === item.tMs) {
      if (item.text) prev.text = item.text;
    } else {
      dedup.push({ ...item });
    }
  }

  return { lines: dedup, offsetMs };
}

export function findActiveIndex(lines: LyricLine[], tMs: number): number {
  if (lines.length === 0) return -1;

  let lo = 0;
  let hi = lines.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].tMs <= tMs) lo = mid + 1;
    else hi = mid - 1;
  }

  return Math.max(0, Math.min(lines.length - 1, hi));
}
