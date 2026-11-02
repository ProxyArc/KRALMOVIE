export interface WatchedMap {
  // key: `${movieId}::ep::${sIdx}::${eIdx}::${quality}` -> timestamp
  qualities: Record<string, number>;
  // key: `${movieId}::ep::${sIdx}::${eIdx}` -> { quality: string; timestamp: number }
  episodes: Record<string, { quality: string; timestamp: number }>;
  // key: `${movieId}::movie::${quality}` -> timestamp
  movies: Record<string, { quality: string; timestamp: number }>;
}

const WATCHED_KEY = 'kral-watched-v2';
const HISTORY_KEY = 'kral-history-v2';
const LIKES_KEY = 'kral-likes-v2';
export const THEME_KEY = 'kral-theme-v2';

export type ThemeMode = 'dark' | 'light' | 'amoled' | 'gold';

export function getStoredTheme(): ThemeMode {
  try {
    const val = localStorage.getItem(THEME_KEY) as ThemeMode;
    if (val === 'dark' || val === 'light' || val === 'amoled' || val === 'gold') {
      return val;
    }
    return 'dark';
  } catch {
    return 'dark';
  }
}

export function setStoredTheme(theme: ThemeMode): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // ignore
  }
}

export function getWatchedData(): WatchedMap {
  try {
    const raw = localStorage.getItem(WATCHED_KEY);
    if (!raw) return { qualities: {}, episodes: {}, movies: {} };
    const parsed = JSON.parse(raw);
    return {
      qualities: parsed.qualities || {},
      episodes: parsed.episodes || {},
      movies: parsed.movies || {},
    };
  } catch {
    return { qualities: {}, episodes: {}, movies: {} };
  }
}

function saveWatchedData(data: WatchedMap): void {
  try {
    localStorage.setItem(WATCHED_KEY, JSON.stringify(data));
  } catch {
    // ignore
  }
}

export function markEpisodeQualityWatched(
  movieId: string | number,
  sIdx: number,
  eIdx: number,
  quality: string
): WatchedMap {
  const data = getWatchedData();
  const qKey = `${movieId}::ep::${sIdx}::${eIdx}::${quality}`;
  const epKey = `${movieId}::ep::${sIdx}::${eIdx}`;
  const now = Date.now();
  data.qualities[qKey] = now;
  data.episodes[epKey] = { quality, timestamp: now };
  saveWatchedData(data);
  return data;
}

export function toggleEpisodeWatchedManual(
  movieId: string | number,
  sIdx: number,
  eIdx: number,
  defaultQuality = 'تماشا شده'
): WatchedMap {
  const data = getWatchedData();
  const epKey = `${movieId}::ep::${sIdx}::${eIdx}`;
  if (data.episodes[epKey]) {
    delete data.episodes[epKey];
    const prefix = `${movieId}::ep::${sIdx}::${eIdx}::`;
    Object.keys(data.qualities).forEach((k) => {
      if (k.startsWith(prefix)) delete data.qualities[k];
    });
  } else {
    data.episodes[epKey] = { quality: defaultQuality, timestamp: Date.now() };
  }
  saveWatchedData(data);
  return data;
}

export function markMovieQualityWatched(
  movieId: string | number,
  quality: string
): WatchedMap {
  const data = getWatchedData();
  const mKey = `${movieId}::movie::${quality}`;
  const now = Date.now();
  data.movies[mKey] = { quality, timestamp: now };
  data.movies[`${movieId}::movie`] = { quality, timestamp: now };
  saveWatchedData(data);
  return data;
}

export function getLocalHistory(): any[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function addToLocalHistory(item: any, watchedQuality?: string): any[] {
  if (!item || !item.id) return getLocalHistory();
  try {
    const list = getLocalHistory().filter((x) => String(x.id) !== String(item.id));
    const entry = {
      ...item,
      _watchedAt: Date.now(),
      _watchedQuality: watchedQuality || item._watchedQuality || '',
    };
    const updated = [entry, ...list].slice(0, 60);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(updated));
    return updated;
  } catch {
    return [];
  }
}

export function getLocalLikes(): any[] {
  try {
    const raw = localStorage.getItem(LIKES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function isItemLiked(id: string | number): boolean {
  const list = getLocalLikes();
  return list.some((x) => String(x.id) === String(id));
}

export function toggleLocalLike(item: any): { liked: boolean; list: any[] } {
  if (!item || !item.id) return { liked: false, list: getLocalLikes() };
  const list = getLocalLikes();
  const exists = list.some((x) => String(x.id) === String(item.id));
  let updated: any[];
  if (exists) {
    updated = list.filter((x) => String(x.id) !== String(item.id));
  } else {
    updated = [item, ...list];
  }
  try {
    localStorage.setItem(LIKES_KEY, JSON.stringify(updated));
  } catch {
    // ignore
  }
  return { liked: !exists, list: updated };
}

/* ── Download Manager: saved-for-download (v1.18) ── */
export interface SavedDownloadItem {
  id: string;
  title: string;
  poster: string;
  type: 'movie' | 'series';
  year: string;
  savedAt: number;
  movie?: any;
}
const SAVED_DL_KEY = 'kral-saved-downloads-v1';
export function getSavedDownloads(): SavedDownloadItem[] {
  try {
    const raw = localStorage.getItem(SAVED_DL_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}
export function isSavedForDownload(id: string | number): boolean {
  return getSavedDownloads().some((x) => String(x.id) === String(id));
}
export function toggleSavedDownload(item: any): { saved: boolean; list: SavedDownloadItem[] } {
  const list = getSavedDownloads();
  const id = String(item?.id || '');
  if (!id) return { saved: false, list };
  const exists = list.some((x) => String(x.id) === id);
  let updated: SavedDownloadItem[];
  if (exists) {
    updated = list.filter((x) => String(x.id) !== id);
  } else {
    updated = [
      {
        id,
        title: String(item.title || item.name || 'بدون عنوان'),
        poster: String(item.poster || item.poster_url || item.image || ''),
        type: item.type === 'series' ? 'series' : 'movie',
        year: String(item.year || ''),
        savedAt: Date.now(),
        movie: item,
      },
      ...list,
    ];
  }
  try {
    localStorage.setItem(SAVED_DL_KEY, JSON.stringify(updated));
  } catch {
    // ignore
  }
  return { saved: !exists, list: updated };
}

/* Download records created when a download is enqueued (v1.18).
 * The Android DownloadManager owns the file; this record only keeps
 * the title/type/label so the manager can show it after a restart. */
export interface DownloadRecord {
  dmId: number;
  url: string;
  title: string;
  label: string;
  quality: string;
  type: 'movie' | 'series';
  fileName: string;
  folder: string;
  createdAt: number;
}
const DL_RECORDS_KEY = 'kral-download-records-v1';
export function getDownloadRecords(): DownloadRecord[] {
  try {
    const raw = localStorage.getItem(DL_RECORDS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}
export function addDownloadRecord(rec: DownloadRecord): void {
  try {
    const list = getDownloadRecords().filter((x) => x.dmId !== rec.dmId);
    localStorage.setItem(DL_RECORDS_KEY, JSON.stringify([rec, ...list]));
  } catch {
    // ignore
  }
}
export function removeDownloadRecord(dmId: number): void {
  try {
    const list = getDownloadRecords().filter((x) => x.dmId !== dmId);
    localStorage.setItem(DL_RECORDS_KEY, JSON.stringify(list));
  } catch {
    // ignore
  }
}
