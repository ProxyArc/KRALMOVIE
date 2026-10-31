import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  ChevronLeft,
  Copy,
  Film,
  Palette,
  Play,
  PlusCircle,
  Search,
  Sparkles,
  UserCheck,
  X,
} from 'lucide-react';
import {
  asArray,
  brandFix,
  copyText,
  dedupeMovies,
  extractLinks,
  extractSubtitleUrls,
  faError,
  fetchHistory,
  fetchHome,
  fetchLikes,
  fetchMoreCatalog,
  fetchMovieDetails,
  fetchMovieLinks,
  fetchSectionAll,
  fetchStarMovies,
  getGuestToken,
  movieId,
  movieTitle,
  normalizeVideoUrl,
  openInExternalApp,
  resolveImageUrl,
  scoreVideoUrl,
  searchByCountry,
  searchByGenre,
  searchRemote,
  sortByQuality,
  VideoSource,
} from './utils/api';
import {
  addToLocalHistory,
  getLocalHistory,
  getLocalLikes,
  getStoredTheme,
  getWatchedData,
  isItemLiked,
  markEpisodeQualityWatched,
  markMovieQualityWatched,
  setStoredTheme,
  ThemeMode,
  toggleEpisodeWatchedManual,
  toggleLocalLike,
  WatchedMap,
} from './utils/storage';
import { SplashLoader, VpnWarningCard } from './components/SplashAndVpnAlert';
import { MovieCard, SkeletonGrid } from './components/MovieCard';
import { DetailsView } from './components/DetailsView';
import { PlayerView } from './components/PlayerView';

type NavRoute =
  | { type: 'home' }
  | {
      type: 'list';
      kind: 'section' | 'genre' | 'country' | 'star' | 'search' | 'all-stars';
      id?: string | number;
      sectionIdx?: number;
      title: string;
      q?: string;
    }
  | { type: 'details'; id: string }
  | { type: 'player' };

interface ToastItem {
  id: number;
  message: string;
  type: 'success' | 'error';
}

const THEMES: { id: ThemeMode; label: string; emoji: string; color: string }[] = [
  { id: 'dark', label: 'شب بنفش (پیش‌فرض)', emoji: '🌙', color: '#7B68EE' },
  { id: 'amoled', label: 'مشکی خالص (AMOLED)', emoji: '🖤', color: '#8B5CF6' },
  { id: 'gold', label: 'طلایی سلطنتی', emoji: '👑', color: '#F5C542' },
  { id: 'light', label: 'روز روشن', emoji: '☀️', color: '#5B4FE9' },
];

export default function App() {
  // Splash & Initial Connection State
  const [splashVisible, setSplashVisible] = useState(true);
  const [splashStatus, setSplashStatus] = useState('در حال اتصال به سرور…');
  const [splashError, setSplashError] = useState<string | null>(null);
  const [isRetryingInit, setIsRetryingInit] = useState(false);

  // Theme State
  const [theme, setTheme] = useState<ThemeMode>(() => getStoredTheme());
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);

  // Home & Catalog Data
  const [sections, setSections] = useState<any[]>([]);
  const [countries, setCountries] = useState<any[]>([]);
  const [genres, setGenres] = useState<any[]>([]);
  const [stars, setStars] = useState<any[]>([]);
  const [homeLoading, setHomeLoading] = useState(false);
  const [homeError, setHomeError] = useState<string | null>(null);
  const allItemsRef = useRef<Map<string, any>>(new Map());

  // Navigation & Tabs
  const [currentTab, setCurrentTab] = useState<
    'home' | 'movies' | 'series' | 'history' | 'likes'
  >('home');
  const [navStack, setNavStack] = useState<NavRoute[]>([{ type: 'home' }]);
  const currentRoute = navStack[navStack.length - 1] || { type: 'home' };

  // Global Header Search
  const [searchQuery, setSearchQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const searchTimerRef = useRef<any>(null);

  // Artist / Star Search (on Home & in Stars Directory)
  const [starSearchQuery, setStarSearchQuery] = useState('');

  // Sub-page / List View State
  const [listItems, setListItems] = useState<any[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [catalogStep, setCatalogStep] = useState(0);

  // Tab Lists (Movies, Series, History, Likes)
  const [tabItems, setTabItems] = useState<any[]>([]);
  const [tabLoading, setTabLoading] = useState(false);
  const [tabMoreStep, setTabMoreStep] = useState(0);

  // Details & Player State
  const [currentMovie, setCurrentMovie] = useState<any>(null);
  const [currentSources, setCurrentSources] = useState<VideoSource[]>([]);
  const [activeSourceIndex, setActiveSourceIndex] = useState<number>(-1);
  const [playerAutoUrl, setPlayerAutoUrl] = useState<string | null>(null);
  const [playerAutoQuality, setPlayerAutoQuality] = useState<string | null>(null);
  const [subtitleUrls, setSubtitleUrls] = useState<string[]>([]);

  // External Player Selection Modal
  const [externalModalData, setExternalModalData] = useState<{
    url: string;
    movieId: string;
    quality: string;
    sIdx?: number;
    eIdx?: number;
  } | null>(null);

  // Persistent Watched & Likes State
  const [watchedData, setWatchedData] = useState<WatchedMap>(() => getWatchedData());
  const [likedVersion, setLikedVersion] = useState(0);

  // Toasts
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const showToast = useCallback((message: string, type: 'success' | 'error' = 'error') => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3400);
  }, []);

  // Apply Theme
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    setStoredTheme(theme);
  }, [theme]);

  function handleSelectTheme(next: ThemeMode) {
    setTheme(next);
    setThemeMenuOpen(false);
    const found = THEMES.find((t) => t.id === next);
    if (found) {
      showToast(`${found.emoji} تم «${found.label}» فعال شد`, 'success');
    }
  }

  // Browser Back Button Integration
  useEffect(() => {
    const onPopState = (e: PopStateEvent) => {
      const idx =
        e.state && typeof e.state.navIndex === 'number' ? Math.max(0, e.state.navIndex) : 0;
      setNavStack((prev) => {
        const sliced = prev.slice(0, idx + 1);
        return sliced.length ? sliced : [{ type: 'home' }];
      });
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  function pushRoute(route: NavRoute) {
    setNavStack((prev) => {
      const next = [...prev, route];
      try {
        window.history.pushState({ navIndex: next.length - 1 }, '');
      } catch {
        // ignore
      }
      return next;
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function replaceRoute(route: NavRoute) {
    setNavStack((prev) => {
      const next = [...prev.slice(0, -1), route];
      try {
        window.history.replaceState({ navIndex: next.length - 1 }, '');
      } catch {
        // ignore
      }
      return next;
    });
  }

  function goBack() {
    if (navStack.length > 1) {
      setNavStack((prev) => prev.slice(0, -1));
      try {
        window.history.back();
      } catch {
        // ignore
      }
    } else {
      goHome();
    }
  }

  function goHome() {
    setNavStack([{ type: 'home' }]);
    setCurrentTab('home');
    setSearchQuery('');
    try {
      window.history.replaceState({ navIndex: 0 }, '');
    } catch {
      // ignore
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // Initialize App & Load Home Data
  const initializeApp = useCallback(async () => {
    setSplashError(null);
    setHomeError(null);
    setIsRetryingInit(true);

    // VPN gate on entry (Android only): the API only answers Iranian
    // IPs, so if a VPN tunnel is active, warn immediately instead of
    // letting the API calls time out first. The splash card below
    // already has the "رفرش و تلاش مجدد" button, which re-runs this
    // function, so turning the VPN off + Refresh loads the app.
    // In a plain browser there is no Android bridge, so this is a
    // no-op and the old API-failure warning still applies.
    try {
      const vpnOn = (window as any).AndroidPlayer?.isVpnActive?.();
      if (vpnOn) {
        const msg =
          'VPN (فیلترشکن) فعال است. سرور برنامه فقط با آی‌پی ایران کار می‌کند؛ لطفاً VPN را خاموش کنید و رفرش بزنید.';
        setSplashError(msg);
        setHomeError(msg);
        setIsRetryingInit(false);
        return;
      }
    } catch {
      // ignore: continue with the normal API flow
    }

    setSplashStatus('دریافت توکن امنیتی مهمان…');

    try {
      await getGuestToken();
      setSplashStatus('در حال دریافت لیست فیلم و سریال‌ها…');
      const data = await fetchHome();

      if (!data) {
        throw new Error('پاسخی از سرور دریافت نشد (لطفاً VPN را خاموش کنید)');
      }

      const slides = data.slides || data;
      const loadedSections = Array.isArray(slides.movies) ? slides.movies : [];
      const loadedCountries = Array.isArray(slides.countries) ? slides.countries : [];
      const loadedGenres = Array.isArray(slides.genres) ? slides.genres : [];
      const loadedStars = Array.isArray(slides.stars) ? slides.stars : [];

      if (loadedSections.length === 0 && loadedGenres.length === 0) {
        throw new Error('لیست فیلم‌ها خالی برگشت. لطفاً VPN را خاموش کنید.');
      }

      allItemsRef.current.clear();
      loadedSections.forEach((s: any) => {
        (s.items || []).forEach((i: any) => {
          if (i && i.id) allItemsRef.current.set(String(i.id), i);
        });
      });

      setSections(loadedSections);
      setCountries(loadedCountries);
      setGenres(loadedGenres);
      setStars(loadedStars);
      setIsRetryingInit(false);

      setTimeout(() => {
        setSplashVisible(false);
      }, 300);
    } catch (err: any) {
      setIsRetryingInit(false);
      const msg = faError(err);
      setSplashError(msg);
      setHomeError(msg);
    }
  }, []);

  useEffect(() => {
    initializeApp();
  }, [initializeApp]);

  // Load Tab Content when switching tabs (Movies, Series, History, Likes)
  useEffect(() => {
    if (currentRoute.type !== 'home') return;
    if (currentTab === 'home') return;

    let cancelled = false;
    async function loadTab() {
      setTabLoading(true);
      setTabMoreStep(0);
      try {
        if (currentTab === 'movies' || currentTab === 'series') {
          const targetType = currentTab === 'series' ? 'series' : 'movie';
          const initialPool: any[] = [];
          sections.forEach((s) => {
            (s.items || []).forEach((i: any) => {
              if (i && i.type === targetType) initialPool.push(i);
            });
          });
          const extra = await fetchMoreCatalog(targetType, 0);
          if (cancelled) return;
          const combined = dedupeMovies([...initialPool, ...extra]);
          combined.sort((a, b) => (parseInt(b.year) || 0) - (parseInt(a.year) || 0));
          combined.forEach((m) => {
            if (m?.id) allItemsRef.current.set(String(m.id), m);
          });
          setTabItems(combined);
        } else if (currentTab === 'history') {
          const localHist = getLocalHistory();
          const remoteHist = await fetchHistory(1);
          if (cancelled) return;
          setTabItems(dedupeMovies([...localHist, ...remoteHist]));
        } else if (currentTab === 'likes') {
          const localLikes = getLocalLikes();
          const remoteLikes = await fetchLikes(1);
          if (cancelled) return;
          setTabItems(dedupeMovies([...localLikes, ...remoteLikes]));
        }
      } finally {
        if (!cancelled) setTabLoading(false);
      }
    }

    loadTab();
    return () => {
      cancelled = true;
    };
  }, [currentTab, currentRoute.type, sections, likedVersion]);

  // Load More in Movies / Series Tabs
  async function handleLoadMoreTab() {
    if (loadingMore) return;
    setLoadingMore(true);
    const nextStep = tabMoreStep + 1;
    setTabMoreStep(nextStep);
    try {
      const targetType = currentTab === 'series' ? 'series' : 'movie';
      const extra = await fetchMoreCatalog(targetType, nextStep);
      extra.forEach((m) => {
        if (m?.id) allItemsRef.current.set(String(m.id), m);
      });
      setTabItems((prev) => dedupeMovies([...prev, ...extra]));
    } finally {
      setLoadingMore(false);
    }
  }

  // Load List Route Content (See All, Genre, Country, Star, Search)
  useEffect(() => {
    if (currentRoute.type !== 'list') return;
    if (currentRoute.kind === 'all-stars') return;

    let cancelled = false;
    async function loadListRoute() {
      setListLoading(true);
      setCatalogStep(0);
      try {
        let items: any[] = [];
        if (currentRoute.kind === 'country' && currentRoute.id != null) {
          items = await searchByCountry(currentRoute.id);
        } else if (currentRoute.kind === 'genre' && currentRoute.id != null) {
          items = await searchByGenre(currentRoute.id);
        } else if (currentRoute.kind === 'star') {
          items = await fetchStarMovies(currentRoute.id || '', currentRoute.title);
        } else if (currentRoute.kind === 'section' && currentRoute.sectionIdx != null) {
          const sec = sections[currentRoute.sectionIdx];
          if (sec) {
            items = await fetchSectionAll(
              sec,
              genres,
              countries,
              Array.from(allItemsRef.current.values())
            );
          }
        } else if (currentRoute.kind === 'search' && currentRoute.q) {
          const qLower = currentRoute.q.toLowerCase();
          const localFound = Array.from(allItemsRef.current.values()).filter((m) =>
            String(movieTitle(m)).toLowerCase().includes(qLower)
          );
          const apiFound = await searchRemote(currentRoute.q);
          items = dedupeMovies([...localFound, ...apiFound]);
        }

        if (cancelled) return;
        items.forEach((m) => {
          if (m?.id) allItemsRef.current.set(String(m.id), m);
        });
        setListItems(items);
      } finally {
        if (!cancelled) setListLoading(false);
      }
    }

    loadListRoute();
    return () => {
      cancelled = true;
    };
  }, [currentRoute, sections, genres, countries]);

  // Load More in "See All" (نمایش همه) List Route
  async function handleLoadMoreList() {
    if (loadingMore) return;
    setLoadingMore(true);
    const nextStep = catalogStep + 1;
    setCatalogStep(nextStep);
    try {
      const extra = await fetchMoreCatalog(null, nextStep);
      extra.forEach((m) => {
        if (m?.id) allItemsRef.current.set(String(m.id), m);
      });
      setListItems((prev) => dedupeMovies([...prev, ...extra]));
    } finally {
      setLoadingMore(false);
    }
  }

  // Handle Opening Movie/Series Details
  async function handleOpenDetails(id: string, initialMovie?: any) {
    const cached = initialMovie || allItemsRef.current.get(String(id)) || { id };
    setCurrentMovie(cached);
    setCurrentSources([]);
    pushRoute({ type: 'details', id: String(id) });

    const fetched = await fetchMovieDetails(id);
    if (fetched && Object.keys(fetched).length > 0) {
      const merged = { ...cached, ...fetched };
      allItemsRef.current.set(String(id), merged);
      setCurrentMovie((prev: any) =>
        prev && String(movieId(prev)) === String(id) ? merged : prev
      );
      // Extract any stars from movie details to enrich our Stars directory!
      if (Array.isArray(merged.stars || merged.actors || merged.casts)) {
        const extraStars = merged.stars || merged.actors || merged.casts;
        setStars((prev) => {
          const seen = new Set(prev.map((s) => String(s.id || s.name || s.title)));
          const added = [...prev];
          extraStars.forEach((st: any) => {
            const key = String(st?.id || st?.name || st?.title || '');
            if (key && !seen.has(key)) {
              seen.add(key);
              added.push(st);
            }
          });
          return added;
        });
      }
    }
  }

  // Open Movie Player & Quality Selector
  async function handleOpenMoviePlayer() {
    if (!currentMovie) return;
    const id = movieId(currentMovie);
    if (!id) {
      showToast('شناسه فیلم موجود نیست', 'error');
      return;
    }

    const [linksData, fullDetails] = await Promise.all([
      fetchMovieLinks(id),
      fetchMovieDetails(id),
    ]);

    const fromLinks = extractLinks(linksData);
    const fromDetails =
      fullDetails && Array.isArray(fullDetails.sources)
        ? extractLinks(
            fullDetails.sources.filter((s: any) => !String(s.quality || '').includes('تیزر'))
          )
        : [];
    const fromCurrent =
      currentMovie && Array.isArray(currentMovie.sources)
        ? extractLinks(
            currentMovie.sources.filter((s: any) => !String(s.quality || '').includes('تیزر'))
          )
        : [];

    const seen = new Set<string>();
    const mergedAll: VideoSource[] = [];
    [...fromLinks, ...fromDetails, ...fromCurrent].forEach((s) => {
      if (!s || !s.url || seen.has(s.url)) return;
      seen.add(s.url);
      mergedAll.push(s);
    });

    const sorted = sortByQuality(mergedAll);
    if (!sorted.length) {
      showToast('لینکی برای پخش این فیلم یافت نشد', 'error');
      return;
    }

    setCurrentSources(sorted);
    setActiveSourceIndex(-1);
    setPlayerAutoUrl(null);
    setPlayerAutoQuality(null);
    // Separate subtitle files, if the API provides any. Embedded
    // MKV tracks are handled inside PlayerView itself.
    setSubtitleUrls([
      ...extractSubtitleUrls(linksData),
      ...extractSubtitleUrls(fullDetails),
      ...extractSubtitleUrls(currentMovie),
    ]);
    pushRoute({ type: 'player' });
  }

  // Episode Source Selected -> Open External Player Choice Modal & Mark Watched
  function handleSelectEpisodeSource(
    url: string,
    quality: string,
    sIdx: number,
    eIdx: number,
    allEpSources: VideoSource[]
  ) {
    if (!currentMovie) return;
    const id = movieId(currentMovie);
    setCurrentSources(allEpSources);
    // Episodes carry no separate subtitle list here; embedded
    // tracks inside the episode file are used instead.
    setSubtitleUrls([]);
    const idx = allEpSources.findIndex((s) => s.url === url);
    setActiveSourceIndex(idx >= 0 ? idx : 0);

    // Mark episode & specific quality as watched immediately so user sees the checkmark!
    const updated = markEpisodeQualityWatched(id, sIdx, eIdx, quality);
    setWatchedData({ ...updated });
    addToLocalHistory(currentMovie, `قسمت ${eIdx + 1} (${quality})`);

    setExternalModalData({
      url: normalizeVideoUrl(url),
      movieId: id,
      quality,
      sIdx,
      eIdx,
    });
  }

  // Movie Quality Option Selected in PlayerView -> Open External Player Choice Modal & Mark Watched
  function handleSelectMovieQualityOption(idx: number, source: VideoSource) {
    if (!currentMovie) return;
    const id = movieId(currentMovie);
    setActiveSourceIndex(idx);

    const updated = markMovieQualityWatched(id, source.quality);
    setWatchedData({ ...updated });
    addToLocalHistory(currentMovie, source.quality);

    setExternalModalData({
      url: normalizeVideoUrl(source.url),
      movieId: id,
      quality: source.quality,
    });
  }

  // Join the Telegram channel directly in the Telegram app
  // (tg://, not via the web), with a web fallback in a browser.
  function openTelegramChannel() {
    try {
      const bridge = (window as any).AndroidPlayer;
      if (bridge?.openTelegram) {
        bridge.openTelegram();
        return;
      }
    } catch {
      // fall through to the link below
    }
    window.open('tg://resolve?domain=ProxyArc', '_blank');
    setTimeout(() => {
      // If Telegram did not open (no app installed), the tg://
      // link does nothing in a browser, so fall back to the web.
      // In the APK this path is not used: the bridge above
      // already handled it with its own web fallback.
      if (document.visibilityState === 'visible') {
        window.open('https://t.me/ProxyArc', '_blank');
      }
    }, 900);
  }

  // Launch chosen player from External Modal
  async function handleLaunchPlayerChoice(choice: 'app' | 'mx' | 'vlc' | 'copy') {
    if (!externalModalData) return;
    const { url, quality } = externalModalData;

    if (choice === 'copy') {
      const ok = await copyText(url);
      showToast(ok ? '✅ لینک با موفقیت کپی شد' : '❌ خطا در کپی لینک', ok ? 'success' : 'error');
      if (ok) setExternalModalData(null);
      return;
    }

    if (choice === 'app') {
      setExternalModalData(null);
      // Strong native player (ExoPlayer) in the APK: it demuxes
      // MKV itself and renders embedded subtitles, unlike the
      // WebView <video> element. Fall back to the WebView player
      // in a plain browser where there is no Android bridge.
      try {
        const bridge = (window as any).AndroidPlayer;
        if (bridge?.playNative) {
          const title = currentMovie ? movieTitle(currentMovie) : '';
          bridge.playNative(url, title);
          return;
        }
      } catch {
        // fall through to the WebView player
      }
      setPlayerAutoUrl(url);
      setPlayerAutoQuality(quality);
      if (currentRoute.type !== 'player') {
        pushRoute({ type: 'player' });
      }
      return;
    }

    if (choice === 'mx') {
      openInExternalApp(url, 'com.mxtech.videoplayer.ad');
      setExternalModalData(null);
      return;
    }

    if (choice === 'vlc') {
      openInExternalApp(url, 'org.videolan.vlc');
      setExternalModalData(null);
      return;
    }
  }

  // Global Header Search Input Handler
  function handleSearchChange(val: string) {
    setSearchQuery(val);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);

    const trimmed = val.trim();
    if (!trimmed) {
      if (currentRoute.type === 'list' && currentRoute.kind === 'search') {
        replaceRoute({ type: 'home' });
      }
      return;
    }

    searchTimerRef.current = setTimeout(() => {
      const route: NavRoute = {
        type: 'list',
        kind: 'search',
        q: trimmed,
        title: `نتایج جستجو: ${trimmed}`,
      };
      if (currentRoute.type === 'list' && currentRoute.kind === 'search') {
        replaceRoute(route);
      } else {
        pushRoute(route);
      }
    }, 380);
  }

  // Filtered Stars for Home & Stars Explorer
  const filteredStars = useMemo(() => {
    const q = starSearchQuery.trim().toLowerCase();
    if (!q) return stars;
    return stars.filter((s) =>
      String(s.name || s.title || '')
        .toLowerCase()
        .includes(q)
    );
  }, [stars, starSearchQuery]);

  // Helper to check if a movie/series card has been watched
  function getMovieWatchedStatus(m: any): { isWatched: boolean; label?: string } {
    const id = movieId(m);
    if (!id) return { isWatched: false };
    const movieW = watchedData.movies[`${id}::movie`];
    if (movieW) {
      return { isWatched: true, label: `دیده شده (${movieW.quality})` };
    }
    // Check if any episode of this series is watched
    const epKeys = Object.keys(watchedData.episodes).filter((k) => k.startsWith(`${id}::ep::`));
    if (epKeys.length > 0) {
      return { isWatched: true, label: `${epKeys.length} قسمت دیده شده` };
    }
    return { isWatched: false };
  }

  return (
    <div className="min-h-screen flex flex-col">
      {/* 1. SPLASH SCREEN & VPN ALERT */}
      {splashVisible && (
        <SplashLoader
          status={splashStatus}
          error={splashError}
          onRetry={initializeApp}
          isRetrying={isRetryingInit}
        />
      )}

      {/* 2. TOP HEADER */}
      <header
        className="fixed top-0 left-0 right-0 z-40 border-b backdrop-blur-2xl"
        style={{
          background: 'var(--header-bg)',
          borderColor: 'var(--border)',
        }}
      >
        <div className="max-w-7xl mx-auto px-3.5 h-16 flex items-center justify-between gap-3">
          {/* Brand Logo */}
          <div
            onClick={goHome}
            className="flex flex-col items-center leading-none cursor-pointer select-none shrink-0"
          >
            <span
              style={{
                fontFamily: 'var(--font-serif)',
                background: 'linear-gradient(180deg, #E8E0FF 0%, var(--primary) 60%, #4F46E5 100%)',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                filter: 'drop-shadow(0 0 10px rgba(123, 104, 238, 0.45))',
              }}
              className="font-black text-2xl tracking-widest"
            >
              KRAL
            </span>
            <span
              style={{ fontFamily: 'var(--font-serif)', color: 'var(--secondary)' }}
              className="font-bold text-[10px] tracking-[0.38em] -mt-0.5"
            >
              MOVIE
            </span>
          </div>

          {/* Search Input */}
          <div
            className={`relative flex-1 transition-all duration-300 ${
              searchFocused ? 'max-w-xl' : 'max-w-[230px] sm:max-w-xs'
            }`}
          >
            <input
              type="text"
              value={searchQuery}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setSearchFocused(false)}
              onChange={(e) => handleSearchChange(e.target.value)}
              placeholder="جستجو فیلم، سریال یا هنرمند..."
              className="w-full py-2 pr-9 pl-8 rounded-full text-xs sm:text-sm outline-none transition-all"
              style={{
                background: 'var(--surface-2)',
                border: searchFocused
                  ? '1px solid var(--primary)'
                  : '1px solid var(--border)',
                color: 'var(--text)',
              }}
            />
            <Search
              className="w-4 h-4 absolute top-1/2 right-3 -translate-y-1/2 pointer-events-none"
              style={{ color: 'var(--tertiary)' }}
            />
            {searchQuery && (
              <button
                onClick={() => handleSearchChange('')}
                className="w-5 h-5 rounded-full absolute top-1/2 left-2 -translate-y-1/2 flex items-center justify-center text-xs cursor-pointer"
                style={{
                  background: 'var(--surface-solid)',
                  color: 'var(--secondary)',
                }}
              >
                ✕
              </button>
            )}
          </div>

          {/* Theme Selector Button & Dropdown */}
          <div className="relative shrink-0">
            <button
              onClick={() => setThemeMenuOpen((p) => !p)}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-full text-xs font-extrabold transition-transform active:scale-95 cursor-pointer"
              style={{
                background: 'var(--surface-2)',
                border: '1px solid var(--border-strong)',
                color: 'var(--text)',
              }}
              title="تغییر تم برنامه"
            >
              <Palette className="w-4 h-4" style={{ color: 'var(--primary-bright)' }} />
              <span className="hidden sm:inline">تم</span>
            </button>

            {themeMenuOpen && (
              <>
                <div
                  onClick={() => setThemeMenuOpen(false)}
                  className="fixed inset-0 z-40"
                />
                <div
                  className="absolute left-0 mt-2 w-52 rounded-2xl p-2 z-50 shadow-2xl border backdrop-blur-2xl flex flex-col gap-1"
                  style={{
                    background: 'var(--surface-solid)',
                    borderColor: 'var(--border-strong)',
                  }}
                >
                  <div
                    className="px-3 py-1.5 text-[11px] font-extrabold border-b mb-1"
                    style={{ color: 'var(--secondary)', borderColor: 'var(--border)' }}
                  >
                    انتخاب تم ظاهری برنامه
                  </div>
                  {THEMES.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => handleSelectTheme(t.id)}
                      className="flex items-center justify-between px-3 py-2 rounded-xl text-xs font-bold transition-colors cursor-pointer"
                      style={{
                        background:
                          theme === t.id ? 'rgba(123, 104, 238, 0.18)' : 'transparent',
                        color: theme === t.id ? 'var(--primary-bright)' : 'var(--text)',
                      }}
                    >
                      <span className="flex items-center gap-2">
                        <span>{t.emoji}</span>
                        <span>{t.label}</span>
                      </span>
                      <span
                        className="w-3 h-3 rounded-full"
                        style={{ background: t.color }}
                      />
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      {/* 3. MAIN CONTENT AREA */}
      <main className="max-w-7xl w-full mx-auto grow pt-20 pb-10 px-3 sm:px-4">
        {/* VIEW: HOME */}
        {currentRoute.type === 'home' && (
          <div>
            {/* Sticky Navigation Tabs */}
            <div
              className="sticky top-16 z-30 py-2.5 -mx-3 px-3 sm:-mx-4 sm:px-4 mb-4 border-b backdrop-blur-2xl overflow-x-auto no-scrollbar"
              style={{
                background: 'var(--header-bg)',
                borderColor: 'var(--border)',
              }}
            >
              <div className="flex items-center gap-2">
                {[
                  { id: 'home', label: '🏠 خانه' },
                  { id: 'movies', label: '🎬 فیلم‌ها' },
                  { id: 'series', label: '📺 سریال‌ها' },
                  { id: 'history', label: '🕐 تاریخچه' },
                  { id: 'likes', label: '❤️ علاقه‌مندی' },
                ].map((t) => {
                  const active = currentTab === t.id;
                  return (
                    <button
                      key={t.id}
                      onClick={() => setCurrentTab(t.id as any)}
                      className="whitespace-nowrap shrink-0 px-4 py-2 rounded-2xl text-xs sm:text-sm font-extrabold transition-all cursor-pointer active:scale-95"
                      style={{
                        background: active
                          ? 'linear-gradient(135deg, var(--primary), var(--accent))'
                          : 'var(--surface-2)',
                        color: active ? '#FFFFFF' : 'var(--secondary)',
                        border: active ? '1px solid transparent' : '1px solid var(--border)',
                        boxShadow: active ? '0 4px 16px rgba(123, 104, 238, 0.38)' : 'none',
                      }}
                    >
                      {t.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* TAB: HOME */}
            {currentTab === 'home' && (
              <div>
                {homeLoading ? (
                  <SkeletonGrid count={10} />
                ) : homeError && sections.length === 0 ? (
                  <VpnWarningCard
                    message={homeError}
                    onRetry={initializeApp}
                    isRetrying={isRetryingInit}
                  />
                ) : (
                  <div className="flex flex-col gap-7">
                    {/* Telegram channel banner */}
                    <section
                      className="rounded-3xl p-4 border flex items-center gap-3 cursor-pointer active:scale-[0.98] transition-transform"
                      style={{
                        background: 'linear-gradient(135deg, #229ED9, #1B7AB3)',
                        borderColor: 'transparent',
                      }}
                      onClick={openTelegramChannel}
                    >
                      <span className="w-11 h-11 rounded-full bg-white/20 flex items-center justify-center text-2xl shrink-0">
                        ✈️
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="text-white font-extrabold text-sm sm:text-base">
                          عضویت در کانال تلگرام
                        </div>
                        <div className="text-white/80 text-xs font-bold truncate" dir="ltr">
                          @ProxyArc
                        </div>
                      </div>
                      <span className="shrink-0 px-4 py-2 rounded-full bg-white text-[#1B7AB3] text-xs sm:text-sm font-extrabold">
                        عضویت
                      </span>
                    </section>

                    {/* Countries Row */}
                    {countries.length > 0 && (
                      <section>
                        <div className="flex items-center justify-between mb-3">
                          <h2
                            className="text-base sm:text-lg font-extrabold flex items-center gap-2"
                            style={{ color: 'var(--text)' }}
                          >
                            <span
                              className="w-1 h-5 rounded-full inline-block"
                              style={{
                                background:
                                  'linear-gradient(135deg, var(--primary), var(--accent))',
                              }}
                            />
                            <span>کشورها</span>
                          </h2>
                        </div>
                        <div className="flex gap-3 overflow-x-auto no-scrollbar py-1">
                          {countries.slice(0, 30).map((c, idx) => (
                            <div
                              key={`country-${c.id ?? idx}-${idx}`}
                              onClick={() =>
                                pushRoute({
                                  type: 'list',
                                  kind: 'country',
                                  id: c.id,
                                  title: `فیلم و سریال‌های ${brandFix(c.title || 'کشور')}`,
                                })
                              }
                              className="flex flex-col items-center gap-1.5 shrink-0 w-16 cursor-pointer group active:scale-95 transition-transform"
                            >
                              <div
                                className="w-14 h-14 rounded-full overflow-hidden border-2 transition-all group-hover:scale-105 flex items-center justify-center"
                                style={{
                                  borderColor: 'var(--border-strong)',
                                  background: 'var(--surface-solid)',
                                }}
                              >
                                {c.image ? (
                                  <img
                                    src={resolveImageUrl(c.image)}
                                    alt={c.title || ''}
                                    loading="lazy"
                                    referrerPolicy="no-referrer"
                                    className="w-full h-full object-cover"
                                  />
                                ) : (
                                  <span className="text-xl">🌍</span>
                                )}
                              </div>
                              <span
                                className="text-[11px] font-bold truncate max-w-full"
                                style={{ color: 'var(--secondary)' }}
                              >
                                {brandFix(c.title || '')}
                              </span>
                            </div>
                          ))}
                        </div>
                      </section>
                    )}

                    {/* Genres Row */}
                    {genres.length > 0 && (
                      <section>
                        <div className="flex items-center justify-between mb-3">
                          <h2
                            className="text-base sm:text-lg font-extrabold flex items-center gap-2"
                            style={{ color: 'var(--text)' }}
                          >
                            <span
                              className="w-1 h-5 rounded-full inline-block"
                              style={{
                                background:
                                  'linear-gradient(135deg, var(--primary), var(--accent))',
                              }}
                            />
                            <span>دسته‌بندی‌ها</span>
                          </h2>
                        </div>
                        <div className="flex gap-2 overflow-x-auto no-scrollbar py-1">
                          {genres.slice(0, 35).map((g, idx) => (
                            <button
                              key={`genre-${g.id ?? idx}-${idx}`}
                              onClick={() =>
                                pushRoute({
                                  type: 'list',
                                  kind: 'genre',
                                  id: g.id,
                                  title: `ژانر ${brandFix(g.title || '')}`,
                                })
                              }
                              className="px-4 py-2 rounded-full text-xs font-extrabold whitespace-nowrap shrink-0 transition-all active:scale-95 cursor-pointer"
                              style={{
                                background: 'var(--surface-2)',
                                border: '1px solid var(--border)',
                                color: 'var(--text)',
                              }}
                            >
                              {brandFix(g.title || '')}
                            </button>
                          ))}
                        </div>
                      </section>
                    )}

                    {/* Stars / Artists Row WITH Dedicated Search Box */}
                    {stars.length > 0 && (
                      <section
                        className="rounded-3xl p-4 border"
                        style={{
                          background: 'var(--surface)',
                          borderColor: 'var(--border)',
                        }}
                      >
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3.5">
                          <div className="flex items-center justify-between gap-2">
                            <h2
                              className="text-base sm:text-lg font-extrabold flex items-center gap-2"
                              style={{ color: 'var(--text)' }}
                            >
                              <span
                                className="w-1 h-5 rounded-full inline-block"
                                style={{
                                  background:
                                    'linear-gradient(135deg, var(--primary), var(--accent))',
                                }}
                              />
                              <span>هنرمندان و بازیگران</span>
                            </h2>

                            <button
                              onClick={() =>
                                pushRoute({
                                  type: 'list',
                                  kind: 'all-stars',
                                  title: 'جستجو و مشاهده همه هنرمندان',
                                })
                              }
                              className="sm:hidden inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-extrabold cursor-pointer"
                              style={{
                                background: 'var(--surface-2)',
                                border: '1px solid var(--border)',
                                color: 'var(--primary-bright)',
                              }}
                            >
                              <span>نمایش همه</span>
                              <ChevronLeft className="w-3.5 h-3.5" />
                            </button>
                          </div>

                          {/* Artist Search Input + See All Stars */}
                          <div className="flex items-center gap-2 flex-1 max-w-md">
                            <div className="relative flex-1">
                              <input
                                type="text"
                                value={starSearchQuery}
                                onChange={(e) => setStarSearchQuery(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' && starSearchQuery.trim()) {
                                    pushRoute({
                                      type: 'list',
                                      kind: 'star',
                                      id: '',
                                      title: starSearchQuery.trim(),
                                    });
                                  }
                                }}
                                placeholder="جستجوی نام بازیگر یا کارگردان..."
                                className="w-full py-2 pr-8 pl-7 rounded-full text-xs font-bold outline-none"
                                style={{
                                  background: 'var(--surface-solid)',
                                  border: '1px solid var(--border-strong)',
                                  color: 'var(--text)',
                                }}
                              />
                              <Search
                                className="w-3.5 h-3.5 absolute top-1/2 right-2.5 -translate-y-1/2 pointer-events-none"
                                style={{ color: 'var(--primary-bright)' }}
                              />
                              {starSearchQuery && (
                                <button
                                  onClick={() => setStarSearchQuery('')}
                                  className="w-4 h-4 rounded-full absolute top-1/2 left-2 -translate-y-1/2 flex items-center justify-center text-[10px]"
                                  style={{ color: 'var(--secondary)' }}
                                >
                                  ✕
                                </button>
                              )}
                            </div>

                            {starSearchQuery.trim() && (
                              <button
                                onClick={() =>
                                  pushRoute({
                                    type: 'list',
                                    kind: 'star',
                                    id: '',
                                    title: starSearchQuery.trim(),
                                  })
                                }
                                className="shrink-0 px-3 py-2 rounded-full text-xs font-extrabold text-white cursor-pointer active:scale-95 transition-transform"
                                style={{
                                  background:
                                    'linear-gradient(135deg, var(--primary), var(--accent))',
                                }}
                              >
                                جستجوی آثار
                              </button>
                            )}

                            <button
                              onClick={() =>
                                pushRoute({
                                  type: 'list',
                                  kind: 'all-stars',
                                  title: 'جستجو و مشاهده همه هنرمندان',
                                })
                              }
                              className="hidden sm:inline-flex items-center gap-1 px-3.5 py-2 rounded-full text-xs font-extrabold shrink-0 cursor-pointer"
                              style={{
                                background: 'var(--surface-2)',
                                border: '1px solid var(--border)',
                                color: 'var(--primary-bright)',
                              }}
                            >
                              <span>همه هنرمندان</span>
                              <ChevronLeft className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>

                        {/* Filtered Stars Horizontal Row */}
                        {filteredStars.length > 0 ? (
                          <div className="flex gap-3.5 overflow-x-auto no-scrollbar py-1">
                            {filteredStars.map((s, idx) => {
                              const sName = brandFix(s.name || s.title || 'هنرمند');
                              return (
                                <div
                                  key={`star-${s.id ?? idx}-${idx}`}
                                  onClick={() =>
                                    pushRoute({
                                      type: 'list',
                                      kind: 'star',
                                      id: s.id,
                                      title: sName,
                                    })
                                  }
                                  className="flex flex-col items-center gap-1.5 shrink-0 w-18 cursor-pointer group active:scale-95 transition-transform"
                                >
                                  <div
                                    className="w-15 h-15 rounded-full overflow-hidden border-2 transition-all group-hover:scale-105 flex items-center justify-center shadow-md"
                                    style={{
                                      borderColor: 'var(--primary)',
                                      background: 'var(--surface-solid)',
                                    }}
                                  >
                                    {s.image ? (
                                      <img
                                        src={resolveImageUrl(s.image)}
                                        alt={sName}
                                        loading="lazy"
                                        referrerPolicy="no-referrer"
                                        className="w-full h-full object-cover"
                                      />
                                    ) : (
                                      <span className="text-xl">⭐</span>
                                    )}
                                  </div>
                                  <span
                                    className="text-[11px] font-bold text-center truncate max-w-full"
                                    style={{ color: 'var(--text-2)' }}
                                  >
                                    {sName}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 py-3 px-4 rounded-2xl" style={{ background: 'var(--surface-2)' }}>
                            <span className="text-xs font-bold" style={{ color: 'var(--secondary)' }}>
                              هنرمندی با نام «{starSearchQuery}» در لیست اولیه نبود. می‌خواهید کل آرشیو را برای آثار او بگردیم؟
                            </span>
                            <button
                              onClick={() =>
                                pushRoute({
                                  type: 'list',
                                  kind: 'star',
                                  id: '',
                                  title: starSearchQuery.trim(),
                                })
                              }
                              className="px-4 py-2 rounded-full text-xs font-extrabold text-white cursor-pointer"
                              style={{
                                background:
                                  'linear-gradient(135deg, var(--primary), var(--accent))',
                              }}
                            >
                              🔍 نمایش فیلم و سریال‌های {starSearchQuery}
                            </button>
                          </div>
                        )}
                      </section>
                    )}

                    {/* Movie & Series Sections */}
                    {sections.map((sec, sIdx) => {
                      const items = Array.isArray(sec.items) ? sec.items : [];
                      if (!items.length) return null;
                      const secTitle = brandFix(sec.name || 'بخش');

                      return (
                        <section key={`sec-${sec.id ?? sIdx}-${sIdx}`}>
                          <div className="flex items-center justify-between gap-3 mb-3">
                            <h2
                              className="text-base sm:text-lg font-extrabold flex items-center gap-2 truncate"
                              style={{ color: 'var(--text)' }}
                            >
                              <span
                                className="w-1 h-5 rounded-full inline-block shrink-0"
                                style={{
                                  background:
                                    'linear-gradient(135deg, var(--primary), var(--accent))',
                                }}
                              />
                              <span className="truncate">{secTitle}</span>
                            </h2>

                            <button
                              onClick={() =>
                                pushRoute({
                                  type: 'list',
                                  kind: 'section',
                                  sectionIdx: sIdx,
                                  title: secTitle,
                                })
                              }
                              className="shrink-0 inline-flex items-center gap-1 px-3.5 py-1.5 rounded-full text-xs font-extrabold transition-transform active:scale-95 cursor-pointer"
                              style={{
                                background: 'var(--surface-2)',
                                border: '1px solid var(--border)',
                                color: 'var(--primary-bright)',
                              }}
                            >
                              <span>نمایش همه</span>
                              <ChevronLeft className="w-3.5 h-3.5" />
                            </button>
                          </div>

                          <div className="flex gap-3 overflow-x-auto no-scrollbar pb-2 pt-0.5">
                            {items.map((item: any, itemIdx: number) => {
                              const w = getMovieWatchedStatus(item);
                              return (
                                <MovieCard
                                  key={`sec-${sIdx}-movie-${movieId(item)}-${itemIdx}`}
                                  movie={item}
                                  onSelect={handleOpenDetails}
                                  isWatched={w.isWatched}
                                  watchedLabel={w.label}
                                  compact
                                />
                              );
                            })}
                          </div>
                        </section>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* TABS: MOVIES / SERIES / HISTORY / LIKES */}
            {currentTab !== 'home' && (
              <div>
                <div className="flex items-center justify-between mb-4 mt-2">
                  <h2
                    className="text-base sm:text-lg font-extrabold flex items-center gap-2"
                    style={{ color: 'var(--text)' }}
                  >
                    <span
                      className="w-1 h-5 rounded-full inline-block"
                      style={{
                        background: 'linear-gradient(135deg, var(--primary), var(--accent))',
                      }}
                    />
                    <span>
                      {currentTab === 'movies' && `همه فیلم‌ها (${tabItems.length})`}
                      {currentTab === 'series' && `همه سریال‌ها (${tabItems.length})`}
                      {currentTab === 'history' && `تاریخچه تماشا (${tabItems.length})`}
                      {currentTab === 'likes' && `لیست علاقه‌مندی‌ها (${tabItems.length})`}
                    </span>
                  </h2>
                </div>

                {tabLoading ? (
                  <SkeletonGrid count={10} />
                ) : tabItems.length === 0 ? (
                  <div
                    className="text-center py-14 px-6 rounded-3xl border"
                    style={{
                      background: 'var(--surface)',
                      borderColor: 'var(--border)',
                    }}
                  >
                    <div className="text-4xl mb-3 opacity-60">
                      {currentTab === 'history' ? '🕐' : currentTab === 'likes' ? '❤️' : '🎬'}
                    </div>
                    <h3 className="text-base font-extrabold mb-1" style={{ color: 'var(--text)' }}>
                      {currentTab === 'history'
                        ? 'تاریخچه تماشای شما خالی است'
                        : currentTab === 'likes'
                        ? 'هنوز فیلم یا سریالی به علاقه‌مندی‌ها اضافه نکرده‌اید'
                        : 'محتوایی یافت نشد'}
                    </h3>
                    <p className="text-xs" style={{ color: 'var(--secondary)' }}>
                      {currentTab === 'history'
                        ? 'با تماشای هر فیلم یا قسمت سریال، به صورت خودکار اینجا ذخیره می‌شود.'
                        : currentTab === 'likes'
                        ? 'در صفحه جزئیات هر فیلم یا سریال می‌توانید روی دکمه افزودن به علاقه‌مندی بزنید.'
                        : 'لطفاً اتصال اینترنت و خاموش بودن VPN را بررسی کنید.'}
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 sm:gap-4">
                      {tabItems.map((item, itemIdx) => {
                        const w = getMovieWatchedStatus(item);
                        return (
                          <MovieCard
                            key={`tab-${currentTab}-${movieId(item)}-${itemIdx}`}
                            movie={item}
                            onSelect={handleOpenDetails}
                            isWatched={w.isWatched}
                            watchedLabel={item._watchedQuality || w.label}
                          />
                        );
                      })}
                    </div>

                    {(currentTab === 'movies' || currentTab === 'series') && (
                      <div className="flex justify-center mt-8">
                        <button
                          onClick={handleLoadMoreTab}
                          disabled={loadingMore}
                          className="inline-flex items-center gap-2 px-7 py-3.5 rounded-full font-extrabold text-sm text-white shadow-xl active:scale-95 transition-transform cursor-pointer disabled:opacity-60"
                          style={{
                            background: 'linear-gradient(135deg, var(--primary), var(--accent))',
                            boxShadow: '0 10px 28px rgba(123, 104, 238, 0.4)',
                          }}
                        >
                          <PlusCircle className={`w-4 h-4 ${loadingMore ? 'animate-spin' : ''}`} />
                          <span>
                            {loadingMore
                              ? 'در حال دریافت موارد بیشتر…'
                              : 'نمایش فیلم و سریال‌های بیشتر'}
                          </span>
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {/* VIEW: SUB-PAGE LIST (See All, Genre, Country, Star, Search, All Stars Directory) */}
        {currentRoute.type === 'list' && (
          <div>
            {/* Sub-page Header */}
            <div
              className="flex items-center justify-between gap-3 mb-5 p-3 rounded-2xl border backdrop-blur-xl"
              style={{
                background:
                  'linear-gradient(90deg, rgba(123,104,238,0.16), rgba(168,139,250,0.05))',
                borderColor: 'var(--border)',
              }}
            >
              <button
                onClick={goBack}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full text-xs sm:text-sm font-extrabold shrink-0 cursor-pointer active:scale-95 transition-transform"
                style={{
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border)',
                  color: 'var(--text)',
                }}
              >
                <ArrowRight className="w-4 h-4" />
                <span>بازگشت</span>
              </button>

              <h2
                className="text-sm sm:text-base font-extrabold truncate flex-1"
                style={{ color: 'var(--text)' }}
              >
                {brandFix(currentRoute.title)}
              </h2>

              {currentRoute.kind !== 'all-stars' && !listLoading && (
                <span
                  className="text-xs font-extrabold px-3 py-1 rounded-full shrink-0 tabular-nums"
                  style={{
                    background: 'rgba(123,104,238,0.16)',
                    border: '1px solid rgba(123,104,238,0.32)',
                    color: 'var(--primary-bright)',
                  }}
                >
                  {listItems.length} اثر
                </span>
              )}
            </div>

            {/* ALL STARS DIRECTORY & SEARCH */}
            {currentRoute.kind === 'all-stars' ? (
              <div className="flex flex-col gap-5">
                <div
                  className="p-4 rounded-3xl border flex flex-col sm:flex-row items-center gap-3"
                  style={{
                    background: 'var(--surface)',
                    borderColor: 'var(--border)',
                  }}
                >
                  <div className="relative flex-1 w-full">
                    <input
                      type="text"
                      value={starSearchQuery}
                      onChange={(e) => setStarSearchQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && starSearchQuery.trim()) {
                          pushRoute({
                            type: 'list',
                            kind: 'star',
                            id: '',
                            title: starSearchQuery.trim(),
                          });
                        }
                      }}
                      placeholder="نام هنرمند، بازیگر یا کارگردان را وارد کنید..."
                      className="w-full py-3 pr-10 pl-4 rounded-2xl text-sm font-bold outline-none"
                      style={{
                        background: 'var(--surface-solid)',
                        border: '1px solid var(--border-strong)',
                        color: 'var(--text)',
                      }}
                    />
                    <Search
                      className="w-4 h-4 absolute top-1/2 right-3.5 -translate-y-1/2"
                      style={{ color: 'var(--primary-bright)' }}
                    />
                  </div>
                  {starSearchQuery.trim() && (
                    <button
                      onClick={() =>
                        pushRoute({
                          type: 'list',
                          kind: 'star',
                          id: '',
                          title: starSearchQuery.trim(),
                        })
                      }
                      className="w-full sm:w-auto px-6 py-3 rounded-2xl text-xs sm:text-sm font-extrabold text-white cursor-pointer shrink-0"
                      style={{
                        background: 'linear-gradient(135deg, var(--primary), var(--accent))',
                      }}
                    >
                      🔍 جستجوی آثار «{starSearchQuery}» در کل سرور
                    </button>
                  )}
                </div>

                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-4">
                  {filteredStars.map((s, idx) => {
                    const sName = brandFix(s.name || s.title || 'هنرمند');
                    return (
                      <div
                        key={`allstar-${s.id ?? idx}-${idx}`}
                        onClick={() =>
                          pushRoute({
                            type: 'list',
                            kind: 'star',
                            id: s.id,
                            title: sName,
                          })
                        }
                        className="p-3 rounded-2xl border flex flex-col items-center gap-2 cursor-pointer transition-transform hover:-translate-y-1 active:scale-95"
                        style={{
                          background: 'var(--surface)',
                          borderColor: 'var(--border)',
                        }}
                      >
                        <div
                          className="w-16 h-16 sm:w-20 sm:h-20 rounded-full overflow-hidden border-2 flex items-center justify-center"
                          style={{
                            borderColor: 'var(--primary)',
                            background: 'var(--surface-solid)',
                          }}
                        >
                          {s.image ? (
                            <img
                              src={resolveImageUrl(s.image)}
                              alt={sName}
                              loading="lazy"
                              referrerPolicy="no-referrer"
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <UserCheck className="w-7 h-7" style={{ color: 'var(--primary)' }} />
                          )}
                        </div>
                        <span
                          className="text-xs font-extrabold text-center line-clamp-2"
                          style={{ color: 'var(--text)' }}
                        >
                          {sName}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : listLoading ? (
              <SkeletonGrid count={10} />
            ) : listItems.length === 0 ? (
              <div
                className="text-center py-14 px-6 rounded-3xl border"
                style={{
                  background: 'var(--surface)',
                  borderColor: 'var(--border)',
                }}
              >
                <div className="text-4xl mb-3 opacity-60">🔍</div>
                <h3 className="text-base font-extrabold mb-1" style={{ color: 'var(--text)' }}>
                  نتیجه‌ای در این بخش یافت نشد
                </h3>
                <p className="text-xs" style={{ color: 'var(--secondary)' }}>
                  عبارت دیگری را امتحان کنید یا از خاموش بودن VPN مطمئن شوید.
                </p>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 sm:gap-4">
                  {listItems.map((item, itemIdx) => {
                    const w = getMovieWatchedStatus(item);
                    return (
                      <MovieCard
                        key={`list-${movieId(item)}-${itemIdx}`}
                        movie={item}
                        onSelect={handleOpenDetails}
                        isWatched={w.isWatched}
                        watchedLabel={w.label}
                      />
                    );
                  })}
                </div>

                {/* Load More Movies/Series in See All */}
                {currentRoute.kind === 'section' && (
                  <div className="flex justify-center mt-8">
                    <button
                      onClick={handleLoadMoreList}
                      disabled={loadingMore}
                      className="inline-flex items-center gap-2 px-7 py-3.5 rounded-full font-extrabold text-sm text-white shadow-xl active:scale-95 transition-transform cursor-pointer disabled:opacity-60"
                      style={{
                        background: 'linear-gradient(135deg, var(--primary), var(--accent))',
                        boxShadow: '0 10px 28px rgba(123, 104, 238, 0.4)',
                      }}
                    >
                      <PlusCircle className={`w-4 h-4 ${loadingMore ? 'animate-spin' : ''}`} />
                      <span>
                        {loadingMore
                          ? 'در حال بارگذاری موارد بیشتر…'
                          : 'نمایش فیلم و سریال‌های بیشتر'}
                      </span>
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* VIEW: DETAILS */}
        {currentRoute.type === 'details' && currentMovie && (
          <DetailsView
            movie={currentMovie}
            onBack={goBack}
            onOpenMoviePlayer={handleOpenMoviePlayer}
            onSelectEpisodeSource={handleSelectEpisodeSource}
            watchedData={watchedData}
            onToggleEpisodeManual={(sIdx, eIdx) => {
              const id = movieId(currentMovie);
              const updated = toggleEpisodeWatchedManual(id, sIdx, eIdx);
              setWatchedData({ ...updated });
            }}
            isLiked={isItemLiked(movieId(currentMovie))}
            onToggleLike={() => {
              const res = toggleLocalLike(currentMovie);
              setLikedVersion((v) => v + 1);
              showToast(
                res.liked
                  ? '❤️ به لیست علاقه‌مندی‌ها اضافه شد'
                  : 'از لیست علاقه‌مندی‌ها حذف شد',
                'success'
              );
            }}
            showToast={showToast}
          />
        )}
      </main>

      {/* 4. VIEW: PLAYER */}
      {currentRoute.type === 'player' && currentMovie && (
        <PlayerView
          movieTitle={brandFix(movieTitle(currentMovie))}
          movieId={movieId(currentMovie)}
          sources={currentSources}
          activeSourceIndex={activeSourceIndex}
          onSelectQualityOption={handleSelectMovieQualityOption}
          onSwitchInlineQuality={(idx, src) => {
            setActiveSourceIndex(idx);
            const updated = markMovieQualityWatched(movieId(currentMovie), src.quality);
            setWatchedData({ ...updated });
          }}
          onExit={goBack}
          watchedData={watchedData}
          showToast={showToast}
          autoPlayUrl={playerAutoUrl}
          autoPlayQuality={playerAutoQuality}
          subtitleUrls={subtitleUrls}
        />
      )}

      {/* 5. EXTERNAL PLAYER SELECTION MODAL */}
      {externalModalData && (
        <div
          onClick={() => setExternalModalData(null)}
          className="fixed inset-0 z-[99999] bg-black/85 backdrop-blur-xl flex items-center justify-center p-4"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm rounded-3xl p-6 text-center border shadow-2xl"
            style={{
              background: 'var(--surface-solid)',
              borderColor: 'var(--border-strong)',
            }}
          >
            <div
              className="w-16 h-16 mx-auto mb-3 rounded-full flex items-center justify-center border"
              style={{
                background:
                  'linear-gradient(135deg, rgba(123,104,238,0.25), rgba(168,139,250,0.15))',
                borderColor: 'rgba(123,104,238,0.35)',
              }}
            >
              <Film className="w-8 h-8" style={{ color: 'var(--primary-bright)' }} />
            </div>

            <h3 className="text-lg font-extrabold mb-1" style={{ color: 'var(--text)' }}>
              انتخاب پلیر ({externalModalData.quality})
            </h3>
            <p className="text-xs mb-4" style={{ color: 'var(--secondary)' }}>
              تیک تماشا برای این کیفیت ثبت شد ✓ با کدام پلیر تماشا می‌کنید؟
            </p>

            <div className="flex flex-col gap-2.5">
              <button
                onClick={() => handleLaunchPlayerChoice('app')}
                className="w-full py-3.5 px-4 rounded-2xl font-extrabold text-sm flex items-center justify-center gap-2.5 cursor-pointer active:scale-95 transition-transform"
                style={{
                  background: 'rgba(123, 104, 238, 0.16)',
                  color: 'var(--primary-bright)',
                  border: '1px solid rgba(123, 104, 238, 0.38)',
                }}
              >
                <Play className="w-4 h-4 fill-current" />
                <span>پخش در همین برنامه</span>
              </button>

              <button
                onClick={() => handleLaunchPlayerChoice('mx')}
                className="w-full py-3.5 px-4 rounded-2xl font-extrabold text-sm flex items-center justify-center gap-2.5 cursor-pointer active:scale-95 transition-transform"
                style={{
                  background: 'rgba(0, 168, 255, 0.12)',
                  color: '#38BDF8',
                  border: '1px solid rgba(0, 168, 255, 0.3)',
                }}
              >
                <Play className="w-4 h-4" />
                <span>پخش در MX Player</span>
              </button>

              <button
                onClick={() => handleLaunchPlayerChoice('vlc')}
                className="w-full py-3.5 px-4 rounded-2xl font-extrabold text-sm flex items-center justify-center gap-2.5 cursor-pointer active:scale-95 transition-transform"
                style={{
                  background: 'rgba(255, 159, 10, 0.12)',
                  color: '#FFB84D',
                  border: '1px solid rgba(255, 159, 10, 0.3)',
                }}
              >
                <Play className="w-4 h-4" />
                <span>پخش در VLC Player</span>
              </button>

              <button
                onClick={() => handleLaunchPlayerChoice('copy')}
                className="w-full py-3.5 px-4 rounded-2xl font-extrabold text-sm flex items-center justify-center gap-2.5 cursor-pointer active:scale-95 transition-transform"
                style={{
                  background: 'rgba(50, 215, 75, 0.12)',
                  color: '#32D74B',
                  border: '1px solid rgba(50, 215, 75, 0.3)',
                }}
              >
                <Copy className="w-4 h-4" />
                <span>کپی لینک مستقیم</span>
              </button>
            </div>

            <button
              onClick={() => setExternalModalData(null)}
              className="w-full py-2.5 mt-3 rounded-xl text-xs font-bold cursor-pointer"
              style={{ color: 'var(--tertiary)' }}
            >
              انصراف
            </button>
          </div>
        </div>
      )}

      {/* 6. TOAST CONTAINER */}
      <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[100000] flex flex-col gap-2 pointer-events-none w-max max-w-[92vw]">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="px-4 py-3 rounded-2xl font-bold text-xs sm:text-sm shadow-2xl flex items-center gap-2.5 pointer-events-auto border backdrop-blur-2xl"
            style={{
              background: 'var(--surface-solid)',
              color: 'var(--text)',
              borderColor:
                t.type === 'error' ? 'rgba(255, 69, 58, 0.5)' : 'rgba(50, 215, 75, 0.5)',
            }}
          >
            <span
              className="w-2.5 h-2.5 rounded-full shrink-0"
              style={{
                background: t.type === 'error' ? '#FF453A' : '#32D74B',
              }}
            />
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
