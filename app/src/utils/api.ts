// NOTE (public source): the real API endpoints were removed from
// this public copy. Replace the placeholders below with your own
// API base URLs before building, otherwise the app has no data
// source and shows no movies.
export const CONFIG = {
  apiBase: 'https://YOUR_API_BASE/api/',
  apiBackup: 'https://YOUR_API_BACKUP/api/',
  mediaBase: 'https://YOUR_MEDIA_BASE/',
  timeout: 18000,
};

const SEP_CHARS = '\\s\\u200C\\u200D\\u200E\\u200F\\u00A0._\\-–—';
const BRAND_RE_FULL = new RegExp('نکست[' + SEP_CHARS + ']*م[و]{1,3}[یي]{1,2}', 'g');
const BRAND_RE_SHORT = new RegExp('نکست[' + SEP_CHARS + ']*م[و]{1,3}', 'g');

export function brandFix(str: any): string {
  if (str == null) return '';
  let s = String(str);
  s = s.replace(BRAND_RE_FULL, 'کرال مووی');
  s = s.replace(BRAND_RE_SHORT, 'کرال مووی');
  s = s.replace(new RegExp('Next[' + SEP_CHARS + ']*Movies?', 'gi'), 'Kral Movie');
  s = s.replace(/NextMovie/gi, 'KralMovie');
  s = s.replace(/\bNXM\b/gi, 'KRAL');
  s = s.replace(new RegExp('نکست', 'g'), 'کرال');
  return s;
}

export class ApiError extends Error {
  type: 'timeout' | 'network' | 'http' | 'json' | 'auth';
  status: number;
  path: string;
  constructor(
    type: 'timeout' | 'network' | 'http' | 'json' | 'auth',
    message: string,
    status = 0,
    path = ''
  ) {
    super(message);
    this.type = type;
    this.status = status;
    this.path = path;
  }
}

let currentToken: string | null = null;
let tokenPromise: Promise<string> | null = null;

const movieCache = new Map<string, any>();
const linksCache = new Map<string, any>();
const seasonsCache = new Map<string, any>();
const searchCache = new Map<string, any[]>();

async function requestWithBase(
  baseUrl: string,
  path: string,
  options: {
    method?: string;
    body?: any;
    auth?: boolean;
    timeout?: number;
  } = {}
): Promise<any> {
  const { method = 'GET', body = null, auth = false, timeout = CONFIG.timeout } = options;
  const url = baseUrl.replace(/\/$/, '') + '/' + String(path).replace(/^\//, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  if (auth && currentToken) headers['Authorization'] = 'Bearer ' + currentToken;

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
      signal: ctrl.signal,
      mode: 'cors',
      credentials: 'omit',
    });
  } catch (err: any) {
    clearTimeout(timer);
    const type = err?.name === 'AbortError' ? 'timeout' : 'network';
    throw new ApiError(type, err?.message || 'خطای شبکه', 0, path);
  }
  clearTimeout(timer);

  if ((res.status === 401 || res.status === 403) && auth && currentToken) {
    try {
      await getGuestToken();
      return requestWithBase(baseUrl, path, { ...options, auth: true });
    } catch {
      // ignore
    }
  }

  if (!res.ok) {
    throw new ApiError('http', 'خطای سرور (' + res.status + ')', res.status, path);
  }

  const text = await res.text();
  if (!text) return null;

  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ApiError('json', 'پاسخ JSON نامعتبر', res.status, path);
  }

  if (data && typeof data === 'object' && 'success' in data && 'data' in data) {
    if (data.success === false) {
      throw new ApiError('http', data.message || 'خطای سرور', res.status, path);
    }
    return data.data;
  }
  return data;
}

export async function apiRequest(
  path: string,
  options: {
    method?: string;
    body?: any;
    auth?: boolean;
    timeout?: number;
  } = {}
): Promise<any> {
  try {
    return await requestWithBase(CONFIG.apiBase, path, options);
  } catch (primaryErr) {
    try {
      return await requestWithBase(CONFIG.apiBackup, path, {
        ...options,
        timeout: Math.min(options.timeout || CONFIG.timeout, 10000),
      });
    } catch {
      throw primaryErr;
    }
  }
}

export async function getGuestToken(): Promise<string> {
  if (tokenPromise) return tokenPromise;
  tokenPromise = (async () => {
    try {
      const data = await apiRequest('auth/guest-token', {
        method: 'POST',
        body: {},
        auth: false,
      });
      const tk = data && (data.token || data.access_token);
      if (!tk || typeof tk !== 'string') {
        throw new ApiError('json', 'ساختار پاسخ توکن نامعتبر', 200, 'auth/guest-token');
      }
      currentToken = tk;
      return tk;
    } finally {
      tokenPromise = null;
    }
  })();
  return tokenPromise;
}

export function faError(err: any): string {
  if (!err) return 'خطای نامشخص در ارتباط با سرور';
  switch (err.type) {
    case 'timeout':
      return 'مهلت پاسخگویی سرور به پایان رسید (احتمالاً VPN روشن است).';
    case 'network':
      return 'ارتباط با سرور برقرار نشد (لطفاً VPN را خاموش کنید).';
    case 'auth':
      return 'دسترسی غیرمجاز.';
    case 'json':
      return 'پاسخ سرور قابل خواندن نبود.';
    case 'http':
      return err.message || 'خطای سرور';
    default:
      return err.message || 'خطا در دریافت اطلاعات';
  }
}

/* ═══════════════════════════════════════════════════════
   EXTRACTORS & HELPERS
   ═══════════════════════════════════════════════════════ */
export function movieId(m: any): string {
  return String((m && (m.id ?? m.movie_id ?? m.slug ?? '')) || '');
}
export function movieTitle(m: any): string {
  return (m && (m.title || m.name || m.original_title)) || '';
}
export function movieYear(m: any): string {
  if (!m) return '';
  return String(
    m.year || m.release_year || (m.release_date ? String(m.release_date).slice(0, 4) : '') || ''
  );
}
export function movieRating(m: any): string {
  if (!m) return '';
  const r = m.imdb_rating ?? m.rating ?? m.imdb ?? m.score;
  if (r == null) return '';
  const s = String(r);
  if (s === '0' || s === '0.0' || s === '0.00' || s === '0.000') return '';
  return s;
}
export function resolveImageUrl(raw: any): string {
  if (!raw || typeof raw !== 'string') return '';
  const t = raw.trim();
  if (!t) return '';
  if (/^https?:\/\//i.test(t)) return t;
  return CONFIG.mediaBase.replace(/\/$/, '') + '/' + t.replace(/^\/+/, '');
}
export function moviePoster(m: any): string {
  if (!m) return '';
  const raw = m.poster || m.poster_url || m.image || m.cover || m.thumbnail || '';
  return resolveImageUrl(raw);
}
export function movieBackdrop(m: any): string {
  if (!m) return '';
  const raw = m.backdrop || m.backdrop_url || m.cover || m.poster || m.image || '';
  return resolveImageUrl(raw);
}
export function movieDesc(m: any): string {
  if (!m) return '';
  return m.description || m.overview || m.summary || m.plot || m.story || '';
}
export function movieType(m: any): 'movie' | 'series' {
  return m && m.type === 'series' ? 'series' : 'movie';
}

export function normalizeVideoUrl(raw: any): string {
  if (!raw || typeof raw !== 'string') return raw || '';
  let u = raw.trim();
  u = u.replace(/[\u0000-\u001F\u007F]/g, '');
  u = u.replace(/&amp;/gi, '&').replace(/\\\//g, '/');
  u = u.replace(/ /g, '%20');
  return u;
}

export function encodeForIntent(url: string): string {
  let u = String(url || '');
  u = u.replace(/ /g, '%20');
  u = u.replace(/\|/g, '%7C').replace(/\^/g, '%5E').replace(/`/g, '%60');
  u = u.replace(/"/g, '%22').replace(/</g, '%3C').replace(/>/g, '%3E');
  return u;
}

export function getFileExt(url: string): string {
  if (!url) return '';
  let s = String(url).split('?')[0].split('#')[0];
  try {
    s = decodeURIComponent(s);
  } catch {
    // ignore
  }
  const m = s.match(/\.([a-z0-9]{2,5})$/i);
  return m ? m[1].toLowerCase() : '';
}

export function scoreVideoUrl(url: string): number {
  const u = String(url || '').toLowerCase();
  let score = 0;

  if (/\/server[_-][a-z0-9]+/.test(u)) score += 120;
  if (/\/domains\/servers\//.test(u)) score += 100;
  if (/\/contents\//.test(u)) score += 40;
  if (/\.(m3u8|mpd)(\?|#|$)/.test(u)) score += 90;

  if (/\.(mkv|mp4|webm|mov|m4v|ts|m2ts|avi)(\?|#|$)/.test(u)) score += 35;

  if (/\/up\/files\//.test(u)) score -= 120;
  if (/\/upload(s)?\//.test(u)) score -= 60;
  if (/(^|[/?&_.-])download([/?&_.-]|$)/.test(u)) score -= 90;
  if (/\?(dl|download)=/.test(u)) score -= 70;

  if (/\.(zip|rar|7z|srt|ass|sub|idx|vtt|jpg|jpeg|png|webp|gif|nfo|txt)(\?|#|$)/.test(u)) {
    score -= 1000;
  }

  return score;
}

const STREAM_URL_KEYS = [
  'stream_url',
  'play_url',
  'play',
  'stream',
  'media_url',
  'video_url',
  'url',
  'link',
  'file',
  'src',
  'source',
  'href',
  'download_url',
  'download_link',
  'dl_url',
  'dl_link',
  'download',
];
const DOWNLOAD_KEYS = ['download_url', 'download_link', 'dl_url', 'dl_link', 'download'];

export interface VideoSource {
  url: string;
  quality: string;
  size: string;
  score: number;
  raw?: any;
}

export function extractLinks(data: any): VideoSource[] {
  if (!data) return [];
  const out: VideoSource[] = [];
  const seen = new Set<string>();

  function pickBestUrl(node: any) {
    let bestUrl: string | null = null;
    let bestScore = -Infinity;
    for (const key of STREAM_URL_KEYS) {
      const v = node[key];
      if (!v || typeof v !== 'string') continue;
      if (!/^https?:\/\//i.test(v)) continue;
      const clean = normalizeVideoUrl(v);
      let sc = scoreVideoUrl(clean);
      if (DOWNLOAD_KEYS.includes(key)) sc -= 45;
      if (sc > bestScore) {
        bestScore = sc;
        bestUrl = clean;
      }
    }
    return bestUrl ? { url: bestUrl, score: bestScore } : null;
  }

  function walk(node: any, depth: number) {
    if (!node || depth > 7) return;
    if (Array.isArray(node)) {
      node.forEach((item) => walk(item, depth + 1));
      return;
    }
    if (typeof node !== 'object') return;

    const label = String(node.quality || node.label || node.title || '').toLowerCase();
    if (label.includes('تیزر') || label.includes('teaser') || label.includes('trailer')) return;

    const picked = pickBestUrl(node);
    if (picked && picked.score > -500 && !seen.has(picked.url)) {
      seen.add(picked.url);
      const quality = String(node.quality || node.label || node.resolution || node.title || 'لینک');
      const size = String(node.size || node.file_size || node.filesize || '');
      out.push({ url: picked.url, quality, size, score: picked.score, raw: node });
    }

    for (const key of Object.keys(node)) {
      const v = node[key];
      if (v && typeof v === 'object') walk(v, depth + 1);
    }
  }

  walk(data, 0);

  if (!out.length) {
    const seen2 = new Set<string>();
    (function walk2(node: any, depth: number) {
      if (!node || depth > 7) return;
      if (Array.isArray(node)) {
        node.forEach((i) => walk2(i, depth + 1));
        return;
      }
      if (typeof node !== 'object') return;
      for (const key of STREAM_URL_KEYS) {
        const v = node[key];
        if (v && typeof v === 'string' && /^https?:\/\//i.test(v)) {
          const clean = normalizeVideoUrl(v);
          if (!seen2.has(clean)) {
            seen2.add(clean);
            out.push({
              url: clean,
              quality: String(node.quality || node.label || 'لینک'),
              size: '',
              score: scoreVideoUrl(clean),
              raw: node,
            });
          }
        }
      }
      for (const key of Object.keys(node)) {
        const v = node[key];
        if (v && typeof v === 'object') walk2(v, depth + 1);
      }
    })(data, 0);
  }

  return out;
}

/** Separate subtitle files anywhere in an API payload (.srt/.vtt/
 *  .ass/.ssa), or any URL under a subtitle/sub key. Video links are
 *  handled by extractLinks; this is only for subtitle files, which
 *  extractLinks deliberately scores down and drops. */
export function extractSubtitleUrls(data: any): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  function walk(node: any, depth: number) {
    if (!node || depth > 7) return;
    if (typeof node === 'string') {
      const clean = normalizeVideoUrl(node);
      if (/\.(srt|vtt|ass|ssa)(\?|#|$)/i.test(clean) && !seen.has(clean)) {
        seen.add(clean);
        out.push(clean);
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((i) => walk(i, depth + 1));
      return;
    }
    if (typeof node === 'object') {
      for (const [key, v] of Object.entries(node)) {
        if (typeof v === 'string' && /subtit|subtitle/i.test(key)) {
          const clean = normalizeVideoUrl(v);
          if (/^https?:\/\//i.test(clean) && !seen.has(clean)) {
            seen.add(clean);
            out.push(clean);
          }
        }
        walk(v, depth + 1);
      }
    }
  }
  walk(data, 0);
  return out;
}

export function sortByQuality(links: VideoSource[]): VideoSource[] {
  const order: Record<string, number> = { '2160': 0, '1080': 1, '720': 2, '480': 3, '360': 4 };
  return [...links].sort((a, b) => {
    const sa = typeof a.score === 'number' ? a.score : scoreVideoUrl(a.url);
    const sb = typeof b.score === 'number' ? b.score : scoreVideoUrl(b.url);
    const ga = sa >= 30 ? 0 : 1;
    const gb = sb >= 30 ? 0 : 1;
    if (ga !== gb) return ga - gb;
    const qa = String(a.quality).match(/\d{3,4}/)?.[0] || '999';
    const qb = String(b.quality).match(/\d{3,4}/)?.[0] || '999';
    const d = (order[qa] ?? 99) - (order[qb] ?? 99);
    if (d !== 0) return d;
    return sb - sa;
  });
}

export function normalizeQualityGroup(q: string): string {
  const s = String(q || '').trim();
  const match = s.match(/(2160|1440|1080|720|480|360)p?/i);
  if (match) return `${match[1]}p`;
  return s || 'کیفیت پیش‌فرض';
}

export function qualityClass(q: string): string {
  const s = String(q);
  if (/1080/.test(s)) return 'q-1080';
  if (/720/.test(s)) return 'q-720';
  if (/480/.test(s)) return 'q-480';
  return 'q-other';
}

export function extractEpisodeNumber(title: string, index: number): string {
  if (title) {
    const patterns = [/قسمت\s*(\d+)/, /Episode\s*(\d+)/i, /Ep\s*(\d+)/i, /E\s*(\d+)/i];
    for (const p of patterns) {
      const m = title.match(p);
      if (m) return m[1];
    }
  }
  return String(index + 1);
}

export function buildIntentUrl(url: string, pkg?: string | null): string {
  const safe = encodeForIntent(url);
  const u = safe.replace(/^https?:\/\//i, '');
  const scheme = /^https:/i.test(safe) ? 'https' : 'http';
  let s =
    'intent://' +
    u +
    '#Intent;scheme=' +
    scheme +
    ';action=android.intent.action.VIEW;type=video/*;';
  if (pkg) s += 'package=' + pkg + ';';
  s += 'S.browser_fallback_url=' + encodeURIComponent(safe) + ';end';
  return s;
}

export function isAndroid(): boolean {
  return /android/i.test(navigator.userAgent);
}

export function openInExternalApp(url: string, pkg?: string | null): void {
  if (!url) return;
  if (isAndroid()) {
    // VLC fix: some video CDN hosts (e.g. some CDN hosts) present a
    // certificate VLC does not trust, so VLC stops with its "Insecure
    // site" dialog even though the same stream plays in the in-app
    // player. VLC does no TLS check at all over plain http, and these
    // CDN hosts serve the same file over http, so hand VLC the http
    // version. The in-app player and the API are untouched and stay
    // on https; only the link handed to VLC is downgraded.
    const externalUrl =
      pkg === 'org.videolan.vlc' ? url.replace(/^https:/i, 'http:') : url;
    // Prefer the native bridge: a direct ACTION_VIEW intent to the
    // player, instead of an intent:// URL parsed by the WebView.
    // The intent:// route can lose data in fullscreen/custom-view
    // mode and can fall back to opening the video in a browser.
    try {
      const bridge = (window as any).AndroidPlayer;
      if (bridge?.openExternal) {
        bridge.openExternal(externalUrl, pkg || '');
        return;
      }
    } catch {
      // fall through to the intent:// route
    }
    try {
      window.location.href = buildIntentUrl(externalUrl, pkg);
      return;
    } catch {
      // fallback
    }
  }
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-999999px;top:0;';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    document.body.removeChild(ta);
    return ok;
  }
}

export function asArray(x: any): any[] {
  if (!x) return [];
  if (Array.isArray(x)) return x;
  for (const k of ['items', 'data', 'results', 'list', 'movies', 'banners', 'links', 'stars']) {
    if (Array.isArray(x[k])) return x[k];
  }
  if (typeof x === 'object' && (x.id || x.title)) return [x];
  return [];
}

export function dedupeMovies(items: any[]): any[] {
  const seen = new Set<string>();
  const out: any[] = [];
  for (const item of items) {
    if (!item) continue;
    const id = movieId(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(item);
  }
  return out;
}

/* ═══════════════════════════════════════════════════════
   API ENDPOINTS
   ═══════════════════════════════════════════════════════ */
export async function fetchHome(): Promise<any> {
  return apiRequest('home', { auth: true });
}

export async function fetchMovieDetails(id: string | number): Promise<any> {
  const key = String(id);
  if (movieCache.has(key)) return movieCache.get(key);
  const merged: any = {};
  const [d1, d2] = await Promise.allSettled([
    apiRequest(`movie/${encodeURIComponent(key)}`, { auth: true }),
    apiRequest(`movie/${encodeURIComponent(key)}/details`, { auth: true }),
  ]);
  if (d1.status === 'fulfilled' && d1.value && typeof d1.value === 'object') {
    Object.assign(merged, d1.value);
  }
  if (d2.status === 'fulfilled' && d2.value && typeof d2.value === 'object') {
    Object.assign(merged, d2.value);
  }
  if (Object.keys(merged).length) movieCache.set(key, merged);
  return merged;
}

export async function fetchMovieLinks(id: string | number): Promise<any> {
  const key = String(id);
  if (linksCache.has(key)) return linksCache.get(key);
  try {
    const d = await apiRequest(`movie/${encodeURIComponent(key)}/links`, { auth: true });
    linksCache.set(key, d);
    return d;
  } catch {
    return null;
  }
}

export async function fetchSeasons(id: string | number): Promise<any> {
  const key = String(id);
  if (seasonsCache.has(key)) return seasonsCache.get(key);
  try {
    const d = await apiRequest(`movie/${encodeURIComponent(key)}/seasons`, { auth: true });
    seasonsCache.set(key, d);
    return d;
  } catch {
    return null;
  }
}

function buildSearchBody(filters: Record<string, any> = {}) {
  return {
    title: '',
    genre_ids: [],
    country_ids: [],
    start_year: null,
    end_year: null,
    imdb_rating_start: null,
    imdb_rating_end: null,
    type: null,
    sub_status: null,
    is_dubbed: null,
    sort_key: null,
    sort_order: null,
    ...filters,
  };
}

export async function searchV3(filters: Record<string, any> = {}): Promise<any[]> {
  const body = buildSearchBody(filters);
  try {
    const d = await apiRequest('v3/search', { method: 'POST', body, auth: true });
    const list = asArray(d);
    if (list.length) return list;
  } catch {
    // fallthrough
  }
  if (body.sort_key) {
    const retry = { ...body, sort_key: null, sort_order: null };
    try {
      const d = await apiRequest('v3/search', { method: 'POST', body: retry, auth: true });
      return asArray(d);
    } catch {
      // silent
    }
  }
  return [];
}

export async function searchRemote(q: string): Promise<any[]> {
  const key = q.trim().toLowerCase();
  if (searchCache.has(key)) return searchCache.get(key)!;
  const res = await searchV3({ title: q });
  if (res.length) {
    searchCache.set(key, res);
  }
  return res;
}

export async function searchByCountry(countryId: string | number): Promise<any[]> {
  const numId = Number(countryId) || countryId;
  const [byYear, byImdb] = await Promise.allSettled([
    searchV3({ country_ids: [numId], sort_key: 'year', sort_order: 'desc' }),
    searchV3({ country_ids: [numId], sort_key: 'imdb_rating', sort_order: 'desc' }),
  ]);
  const combined = [
    ...(byYear.status === 'fulfilled' ? byYear.value : []),
    ...(byImdb.status === 'fulfilled' ? byImdb.value : []),
  ];
  return dedupeMovies(combined);
}

export async function searchByGenre(genreId: string | number): Promise<any[]> {
  const numId = Number(genreId) || genreId;
  const [byYear, byImdb] = await Promise.allSettled([
    searchV3({ genre_ids: [numId], sort_key: 'year', sort_order: 'desc' }),
    searchV3({ genre_ids: [numId], sort_key: 'imdb_rating', sort_order: 'desc' }),
  ]);
  const combined = [
    ...(byYear.status === 'fulfilled' ? byYear.value : []),
    ...(byImdb.status === 'fulfilled' ? byImdb.value : []),
  ];
  return dedupeMovies(combined);
}

export async function fetchStarMovies(starId: string | number, starName?: string): Promise<any[]> {
  const results: any[] = [];
  if (starId) {
    const tries = [
      `star/${encodeURIComponent(starId)}`,
      `v3/star/${encodeURIComponent(starId)}`,
      `star/${encodeURIComponent(starId)}/movies`,
      `v3/star/${encodeURIComponent(starId)}/movies`,
      `movie/star/${encodeURIComponent(starId)}`,
      `stars/${encodeURIComponent(starId)}`,
    ];
    for (const p of tries) {
      try {
        const d = await apiRequest(p, { auth: true, timeout: 7000 });
        if (d && Array.isArray(d.movies) && d.movies.length) {
          results.push(...d.movies);
          break;
        }
        if (d && Array.isArray(d.items) && d.items.length) {
          results.push(...d.items);
          break;
        }
        const list = asArray(d);
        if (list.length) {
          results.push(...list);
          break;
        }
      } catch {
        // try next
      }
    }
  }
  if (starName) {
    try {
      const byName = await searchRemote(starName);
      if (byName.length) results.push(...byName);
    } catch {
      // silent
    }
  }
  return dedupeMovies(results);
}

/**
 * Enhanced "See All" (نمایش همه) fetcher:
 * Combines direct section endpoints + smart v3/search queries based on section name/type/genre/country
 * so that "نمایش همه" always displays a rich, large collection of movies & series!
 */
export async function fetchSectionAll(
  section: any,
  genres: any[] = [],
  countries: any[] = [],
  allCachedItems: any[] = []
): Promise<any[]> {
  const initialItems = Array.isArray(section?.items) ? section.items : [];
  const collected: any[] = [...initialItems];
  const id = section?.id ?? section?.section_id ?? section?.slide_id;
  const secName = String(section?.name || section?.title || '').trim();

  // 1. Try direct section endpoints (including page=1, page=2)
  if (id != null) {
    const tries = [
      `v3/section/${encodeURIComponent(id)}`,
      `section/${encodeURIComponent(id)}`,
      `v3/section/${encodeURIComponent(id)}?page=1`,
      `v3/section/${encodeURIComponent(id)}?page=2`,
      `v3/home/${encodeURIComponent(id)}`,
    ];
    const directResults = await Promise.allSettled(
      tries.map((p) => apiRequest(p, { auth: true, timeout: 6500 }))
    );
    for (const r of directResults) {
      if (r.status === 'fulfilled' && r.value) {
        const list = asArray(r.value);
        if (list.length) collected.push(...list);
      }
    }
  }

  // 2. Analyze section characteristics to fetch more relevant items via v3/search
  const isSeriesSection =
    secName.includes('سریال') ||
    (initialItems.length > 0 &&
      initialItems.filter((x: any) => x.type === 'series').length > initialItems.length * 0.6);
  const isMovieSection =
    secName.includes('فیلم') ||
    (initialItems.length > 0 &&
      initialItems.filter((x: any) => x.type === 'movie').length > initialItems.length * 0.6);
  const isDubbedSection = secName.includes('دوبله');
  const isSubbedSection = secName.includes('زیرنویس');
  const isTopImdb =
    secName.includes('برتر') || secName.includes('امتیاز') || /imdb/i.test(secName);

  // Match genre if section title mentions a genre name
  const matchedGenre = genres.find((g) => g.title && secName.includes(String(g.title).trim()));
  // Match country if section title mentions a country name
  const matchedCountry = countries.find((c) => c.title && secName.includes(String(c.title).trim()));

  const searchPromises: Promise<any[]>[] = [];

  if (matchedGenre?.id) {
    searchPromises.push(searchByGenre(matchedGenre.id));
  }
  if (matchedCountry?.id) {
    searchPromises.push(searchByCountry(matchedCountry.id));
  }
  if (isDubbedSection) {
    searchPromises.push(
      searchV3({
        is_dubbed: true,
        type: isSeriesSection ? 'series' : isMovieSection ? 'movie' : null,
        sort_key: 'year',
        sort_order: 'desc',
      }),
      searchV3({
        is_dubbed: true,
        sort_key: 'imdb_rating',
        sort_order: 'desc',
      })
    );
  } else if (isSubbedSection) {
    searchPromises.push(
      searchV3({
        sub_status: 'fa',
        type: isSeriesSection ? 'series' : isMovieSection ? 'movie' : null,
        sort_key: 'year',
        sort_order: 'desc',
      })
    );
  } else if (isSeriesSection) {
    searchPromises.push(
      searchV3({ type: 'series', sort_key: 'year', sort_order: 'desc' }),
      searchV3({ type: 'series', sort_key: 'imdb_rating', sort_order: 'desc' }),
      searchV3({ type: 'series', is_dubbed: true })
    );
  } else if (isTopImdb) {
    searchPromises.push(
      searchV3({ imdb_rating_start: 7, sort_key: 'imdb_rating', sort_order: 'desc' }),
      searchV3({ sort_key: 'imdb_rating', sort_order: 'desc' })
    );
  } else {
    // General or newly released movies/series
    searchPromises.push(
      searchV3({
        type: isMovieSection ? 'movie' : null,
        sort_key: 'year',
        sort_order: 'desc',
      }),
      searchV3({
        type: isMovieSection ? 'movie' : null,
        sort_key: 'imdb_rating',
        sort_order: 'desc',
      })
    );
  }

  const extraResults = await Promise.allSettled(searchPromises);
  for (const r of extraResults) {
    if (r.status === 'fulfilled' && Array.isArray(r.value)) {
      collected.push(...r.value);
    }
  }

  // Also include matching cached items from other sections
  if (allCachedItems.length) {
    const filteredCache = allCachedItems.filter((item) => {
      if (isSeriesSection && item.type !== 'series') return false;
      if (isMovieSection && !isSeriesSection && item.type !== 'movie') return false;
      if (isDubbedSection && !item.is_dubbed) return false;
      return true;
    });
    collected.push(...filteredCache);
  }

  return dedupeMovies(collected);
}

/**
 * Fetch extra movies/series for "فیلم‌ها" / "سریال‌ها" tabs and "Load More" pagination
 */
export async function fetchMoreCatalog(
  type: 'movie' | 'series' | null,
  step = 0
): Promise<any[]> {
  const queries: Record<string, any>[] = [];
  if (step === 0) {
    queries.push(
      { type, sort_key: 'year', sort_order: 'desc' },
      { type, sort_key: 'imdb_rating', sort_order: 'desc' },
      { type, is_dubbed: true, sort_key: 'year', sort_order: 'desc' }
    );
  } else if (step === 1) {
    queries.push(
      { type, start_year: 2024, end_year: 2026, sort_key: 'year', sort_order: 'desc' },
      { type, start_year: 2020, end_year: 2023, sort_key: 'imdb_rating', sort_order: 'desc' },
      { type, sub_status: 'fa' }
    );
  } else {
    const yearEnd = 2020 - (step - 2) * 4;
    const yearStart = yearEnd - 5;
    queries.push(
      { type, start_year: yearStart, end_year: yearEnd, sort_key: 'imdb_rating', sort_order: 'desc' },
      { type, imdb_rating_start: 6.5 }
    );
  }

  const settled = await Promise.allSettled(queries.map((q) => searchV3(q)));
  const out: any[] = [];
  for (const r of settled) {
    if (r.status === 'fulfilled' && Array.isArray(r.value)) {
      out.push(...r.value);
    }
  }
  return dedupeMovies(out);
}

export async function fetchHistory(page = 1): Promise<any[]> {
  try {
    const d = await apiRequest(`history?page=${page}`, { auth: true, timeout: 6000 });
    return asArray(d);
  } catch {
    return [];
  }
}

export async function fetchLikes(page = 1): Promise<any[]> {
  try {
    const d = await apiRequest(`likes?page=${page}`, { auth: true, timeout: 6000 });
    return asArray(d);
  } catch {
    return [];
  }
}
