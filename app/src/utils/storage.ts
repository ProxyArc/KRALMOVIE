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
