// Minimal Matroska (MKV/WebM) subtitle extractor, written for this
// player. Chrome/WebView does not expose embedded MKV subtitle
// tracks through video.textTracks, and Android's MediaExtractor does
// not reliably expose them either, so this scans the file itself
// over HTTP Range requests: it reads only element headers and
// subtitle blocks, and seeks over video/audio blocks, so it does
// not have to download the whole video a second time.
//
// Only text subtitle tracks are handled (S_TEXT/UTF8, S_TEXT/ASS,
// S_TEXT/SSA, S_TEXT/WEBVTT). Image subtitles (PGS/VobSub) cannot
// be rendered as text and are skipped.

export interface MkvCue {
  start: number; // seconds
  end: number; // seconds
  text: string;
}

type TrackInfo = {
  number: number;
  type: number;
  codec: string;
  language: string;
};

const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_SEEKHEAD = 0x114d9b74;
const ID_INFO = 0x1549a966;
const ID_TIMECODESCALE = 0x2ad7b1;
const ID_TRACKS = 0x1654ae6b;
const ID_TRACKENTRY = 0xae;
const ID_TRACKNUMBER = 0xd7;
const ID_TRACKTYPE = 0x83;
const ID_CODECID = 0x86;
const ID_LANGUAGE = 0x22b59c;
const ID_LANGUAGE_IETF = 0x22b59d;
const ID_CLUSTER = 0x1f43b675;
const ID_TIMESTAMP = 0xe7;
const ID_SIMPLEBLOCK = 0xa3;
const ID_BLOCKGROUP = 0xa0;
const ID_BLOCK = 0xa1;
const ID_BLOCKDURATION = 0x9b;

function vintLength(first: number): number {
  if (first & 0x80) return 1;
  if (first & 0x40) return 2;
  if (first & 0x20) return 3;
  if (first & 0x10) return 4;
  if (first & 0x08) return 5;
  if (first & 0x04) return 6;
  if (first & 0x02) return 7;
  if (first & 0x01) return 8;
  return 0;
}

class Reader {
  private buf = new Uint8Array(0);
  private bufStart = 0;
  private chunkSize = 256 * 1024;
  private fileSize = 0;
  constructor(
    private url: string,
    private signal: AbortSignal,
    private fetchFn: typeof fetch = fetch
  ) {}

  async fileSizeBytes(): Promise<number> {
    if (this.fileSize) return this.fileSize;
    try {
      const res = await this.fetchFn(this.url, { method: 'HEAD', signal: this.signal });
      const len = res.headers.get('content-length');
      if (len) this.fileSize = parseInt(len, 10);
    } catch {
      // fall through to Range probe
    }
    if (!this.fileSize) {
      try {
        const res = await this.fetchFn(this.url, {
          headers: { Range: 'bytes=0-0' },
          signal: this.signal,
        });
        const cr = res.headers.get('content-range');
        const m = cr && cr.match(/\/(\d+)$/);
        if (m) this.fileSize = parseInt(m[1], 10);
      } catch {
        // unknown size: scanning stops at EOF errors
      }
    }
    return this.fileSize;
  }

  private async fetchChunk(start: number): Promise<boolean> {
    const end = start + this.chunkSize - 1;
    const res = await this.fetchFn(this.url, {
      headers: { Range: `bytes=${start}-${end}` },
      signal: this.signal,
    });
    if (res.status === 200) {
      // Server ignored Range: it sent the whole file from 0.
      // Only usable if the requested start is 0.
      if (start !== 0) return false;
      const data = new Uint8Array(await res.arrayBuffer());
      this.buf = data;
      this.bufStart = 0;
      this.fileSize = data.length;
      return true;
    }
    if (res.status !== 206) return false;
    const data = new Uint8Array(await res.arrayBuffer());
    if (!data.length) return false;
    this.buf = data;
    this.bufStart = start;
    const cr = res.headers.get('content-range');
    const m = cr && cr.match(/\/(\d+)$/);
    if (m) this.fileSize = parseInt(m[1], 10);
    return true;
  }

  async byteAt(pos: number): Promise<number> {
    if (pos < this.bufStart || pos >= this.bufStart + this.buf.length) {
      const ok = await this.fetchChunk(pos);
      if (!ok) throw new Error('range fetch failed');
    }
    return this.buf[pos - this.bufStart];
  }

  async bytesAt(pos: number, len: number): Promise<Uint8Array> {
    if (
      pos >= this.bufStart &&
      pos + len <= this.bufStart + this.buf.length
    ) {
      return this.buf.slice(pos - this.bufStart, pos - this.bufStart + len);
    }
    // Spans a chunk boundary: fetch a chunk starting at pos and
    // retry (chunks are large enough for any header we read).
    const ok = await this.fetchChunk(pos);
    if (!ok) throw new Error('range fetch failed');
    if (pos + len > this.bufStart + this.buf.length) {
      throw new Error('element spans chunk');
    }
    return this.buf.slice(pos - this.bufStart, pos - this.bufStart + len);
  }

  async readId(pos: number): Promise<{ value: number; len: number }> {
    const first = await this.byteAt(pos);
    const len = vintLength(first);
    if (!len) throw new Error('bad EBML id');
    const bytes = await this.bytesAt(pos, len);
    let value = 0;
    for (const b of bytes) value = value * 256 + b;
    return { value, len };
  }

  async readSize(pos: number): Promise<{ value: number; len: number; unknown: boolean }> {
    const first = await this.byteAt(pos);
    const len = vintLength(first);
    if (!len) throw new Error('bad EBML size');
    const bytes = await this.bytesAt(pos, len);
    let value = 0;
    for (let i = 0; i < bytes.length; i++) {
      const b = i === 0 ? bytes[i] & (0xff >> len) : bytes[i];
      value = value * 256 + b;
    }
    const allOnes = value === Math.pow(2, 7 * len) - 1;
    return { value: allOnes ? -1 : value, len, unknown: allOnes };
  }

  async readHeader(
    pos: number
  ): Promise<{ id: number; dataStart: number; dataEnd: number; totalLen: number }> {
    const id = await this.readId(pos);
    const size = await this.readSize(pos + id.len);
    const dataStart = pos + id.len + size.len;
    const dataEnd = size.unknown ? Infinity : dataStart + size.value;
    return { id: id.value, dataStart, dataEnd, totalLen: id.len + size.len };
  }

  async readUint(pos: number, len: number): Promise<number> {
    const bytes = await this.bytesAt(pos, len);
    let v = 0;
    for (const b of bytes) v = v * 256 + b;
    return v;
  }

  async readString(pos: number, len: number): Promise<string> {
    const bytes = await this.bytesAt(pos, len);
    return new TextDecoder('utf-8').decode(bytes).replace(/\0+$/, '');
  }
}

function cleanBlockText(raw: string, codec: string): string {
  let t = raw.trim();
  if (/ASS|SSA/i.test(codec)) {
    if (/^Dialogue:/i.test(t)) {
      const parts = t.slice('Dialogue:'.length).split(',');
      if (parts.length >= 10) t = parts.slice(9).join(',');
    } else {
      // MKV ASS blocks omit the "Dialogue:" prefix and start with
      // ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text
      const parts = t.split(',');
      if (parts.length >= 9 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1])) {
        t = parts.slice(8).join(',');
      }
    }
  }
  return t
    .replace(/\{[^}]*\}/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\\N/g, '\n')
    .trim();
}

export async function extractMkvSubtitles(
  url: string,
  onBatch: (cues: MkvCue[]) => void,
  signal: AbortSignal,
  fetchFn: typeof fetch = fetch
): Promise<MkvCue[]> {
  const reader = new Reader(url, signal, fetchFn);
  const fileSize = await reader.fileSizeBytes();
  const segmentEnd = fileSize || Infinity;

  // EBML header
  let pos = 0;
  const ebml = await reader.readHeader(pos);
  if (ebml.id !== ID_EBML) throw new Error('not an EBML file');
  pos = ebml.dataEnd;

  const seg = await reader.readHeader(pos);
  if (seg.id !== ID_SEGMENT) throw new Error('no Segment element');
  const segStart = seg.dataStart;
  const segEnd = seg.dataEnd === Infinity ? segmentEnd : seg.dataEnd;

  let timecodeScale = 1000000;
  let tracks: TrackInfo[] = [];
  pos = segStart;

  const allCues: MkvCue[] = [];
  const emit = (cues: MkvCue[]) => {
    if (!cues.length) return;
    allCues.push(...cues);
    onBatch(cues);
  };

  // First pass over top-level elements until the first Cluster,
  // to learn timecode scale and tracks. Clusters are then parsed
  // in order; Tracks/Info can only appear before the first Cluster
  // in practice, and if they appear later we still handle them
  // because the loop below re-enters this switch.
  while (pos < segEnd) {
    signal.throwIfAborted();
    const header = await reader.readHeader(pos);
    if (header.id === ID_CLUSTER) {
      // Parse this cluster, then continue with the next element.
      pos = await parseCluster(reader, header, tracks, timecodeScale, signal, emit);
      // After the first cluster, tracks are known; keep scanning
      // further clusters in the same loop.
      continue;
    }
    if (header.id === ID_INFO) {
      let p = header.dataStart;
      while (p < header.dataEnd) {
        const h = await reader.readHeader(p);
        if (h.id === ID_TIMECODESCALE) {
          timecodeScale = await reader.readUint(h.dataStart, h.dataEnd - h.dataStart);
        }
        p = h.dataEnd;
      }
      pos = header.dataEnd;
      continue;
    }
    if (header.id === ID_TRACKS) {
      tracks = await parseTracks(reader, header);
      pos = header.dataEnd;
      continue;
    }
    if (header.id === ID_SEEKHEAD) {
      pos = header.dataEnd;
      continue;
    }
    // Cues, Chapters, Tags, Attachments, Void, CRC-32, etc.: skip.
    if (!isFinite(header.dataEnd)) break;
    pos = header.dataEnd;
  }

  // Fill in missing end times from the next cue.
  allCues.sort((a, b) => a.start - b.start);
  for (let i = 0; i < allCues.length; i++) {
    if (!allCues[i].end || allCues[i].end <= allCues[i].start) {
      const next = allCues[i + 1];
      allCues[i].end =
        next && next.start > allCues[i].start && next.start - allCues[i].start < 15
          ? next.start
          : allCues[i].start + 3;
    }
  }
  return allCues;
}

async function parseTracks(reader: Reader, header: { dataStart: number; dataEnd: number }): Promise<TrackInfo[]> {
  const tracks: TrackInfo[] = [];
  let p = header.dataStart;
  while (p < header.dataEnd) {
    const h = await reader.readHeader(p);
    if (h.id === ID_TRACKENTRY) {
      const track: TrackInfo = { number: 0, type: 0, codec: '', language: '' };
      let q = h.dataStart;
      while (q < h.dataEnd) {
        const e = await reader.readHeader(q);
        const len = e.dataEnd - e.dataStart;
        if (e.id === ID_TRACKNUMBER) track.number = await reader.readUint(e.dataStart, len);
        else if (e.id === ID_TRACKTYPE) track.type = await reader.readUint(e.dataStart, len);
        else if (e.id === ID_CODECID) track.codec = await reader.readString(e.dataStart, len);
        else if (e.id === ID_LANGUAGE || e.id === ID_LANGUAGE_IETF)
          track.language = await reader.readString(e.dataStart, len);
        q = e.dataEnd;
      }
      if (track.number) tracks.push(track);
    }
    p = h.dataEnd;
  }
  return tracks;
}

async function parseCluster(
  reader: Reader,
  header: { dataStart: number; dataEnd: number },
  tracks: TrackInfo[],
  timecodeScale: number,
  signal: AbortSignal,
  emit: (cues: MkvCue[]) => void
): Promise<number> {
  const subTracks = tracks.filter((t) => t.type === 17);
  // If tracks are not known yet, we cannot identify subtitle
  // blocks; the caller will have parsed Tracks before clusters in
  // normal files, so this is only a safety net.
  if (!subTracks.length) {
    return isFinite(header.dataEnd) ? header.dataEnd : Infinity;
  }
  const byNumber = new Map(subTracks.map((t) => [t.number, t]));
  const pickSubTrack = (): TrackInfo => {
    const fa = subTracks.find((t) => /^(fa|fas|per|persian)$/i.test(t.language || ''));
    return fa || subTracks[0];
  };
  const chosen = pickSubTrack();
  const isTextCodec = (codec: string) =>
    /S_TEXT|WEBVTT|UTF8/i.test(codec) || /ASS|SSA/i.test(codec);
  if (!isTextCodec(chosen.codec)) return isFinite(header.dataEnd) ? header.dataEnd : Infinity;

  let pos = header.dataStart;
  const clusterEnd = header.dataEnd;
  let clusterTime = 0;
  const batch: MkvCue[] = [];
  while (pos < clusterEnd) {
    signal.throwIfAborted();
    const h = await reader.readHeader(pos);
    // Unknown-size cluster: a new Cluster header ends this one.
    if (h.id === ID_CLUSTER) break;
    if (h.id === ID_TIMESTAMP) {
      clusterTime = await reader.readUint(h.dataStart, h.dataEnd - h.dataStart);
      pos = h.dataEnd;
      continue;
    }
    if (h.id === ID_SIMPLEBLOCK || h.id === ID_BLOCKGROUP) {
      const cue = await parseBlockElement(reader, h, clusterTime, timecodeScale, byNumber, chosen);
      if (cue) batch.push(cue);
      if (batch.length >= 100) {
        emit(batch.splice(0, batch.length));
      }
      pos = h.dataEnd;
      continue;
    }
    if (!isFinite(h.dataEnd)) break;
    pos = h.dataEnd;
  }
  emit(batch);
  return pos;
}

async function parseBlockElement(
  reader: Reader,
  header: { dataStart: number; dataEnd: number },
  clusterTime: number,
  timecodeScale: number,
  byNumber: Map<number, TrackInfo>,
  chosen: TrackInfo
): Promise<MkvCue | null> {
  let blockStart = header.dataStart;
  let blockEnd = header.dataEnd;
  let blockDurationMs: number | null = null;
  if (header.id === ID_BLOCKGROUP) {
    // Find the Block and optional BlockDuration inside.
    let p = header.dataStart;
    let found = false;
    while (p < header.dataEnd) {
      const e = await reader.readHeader(p);
      if (e.id === ID_BLOCK) {
        blockStart = e.dataStart;
        blockEnd = e.dataEnd;
        found = true;
      } else if (e.id === ID_BLOCKDURATION) {
        blockDurationMs = await reader.readUint(e.dataStart, e.dataEnd - e.dataStart);
      }
      p = e.dataEnd;
    }
    if (!found) return null;
  }
  // Block header: track number (vint), int16 timecode, flags.
  const first = await reader.byteAt(blockStart);
  const len = vintLength(first);
  if (!len) return null;
  const trackBytes = await reader.bytesAt(blockStart, len);
  let trackNumber = 0;
  for (let i = 0; i < trackBytes.length; i++) {
    const b = i === 0 ? trackBytes[i] & (0xff >> len) : trackBytes[i];
    trackNumber = trackNumber * 256 + b;
  }
  if (trackNumber !== chosen.number) return null;
  // The block belongs to a subtitle track, but not the chosen one
  // (e.g. a second language) — ignore it.
  const timeBytes = await reader.bytesAt(blockStart + len, 2);
  let rel = (timeBytes[0] << 8) | timeBytes[1];
  if (rel & 0x8000) rel -= 0x10000;
  const flags = await reader.byteAt(blockStart + len + 2);
  const laceType = (flags >> 1) & 0x3;
  if (laceType !== 0) return null; // laced subtitle blocks are rare; skip
  const dataStart = blockStart + len + 3;
  if (dataStart >= blockEnd) return null;
  const data = await reader.bytesAt(dataStart, blockEnd - dataStart);
  const text = cleanBlockText(new TextDecoder('utf-8').decode(data), chosen.codec);
  if (!text) return null;
  const start = ((clusterTime + rel) * timecodeScale) / 1000000000;
  const end = blockDurationMs != null ? start + (blockDurationMs * timecodeScale) / 1000000000 : 0;
  return { start, end, text };
}
