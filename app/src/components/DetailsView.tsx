import React, { useEffect, useState } from 'react';
import {
  ArrowRight,
  Check,
  ChevronDown,
  Copy,
  Heart,
  Layers,
  Play,
  CheckCircle2,
} from 'lucide-react';
import {
  brandFix,
  copyText,
  extractEpisodeNumber,
  extractLinks,
  fetchSeasons,
  getFileExt,
  movieBackdrop,
  movieDesc,
  movieId,
  moviePoster,
  movieRating,
  movieTitle,
  movieType,
  movieYear,
  normalizeQualityGroup,
  sortByQuality,
  VideoSource,
} from '../utils/api';
import { WatchedMap } from '../utils/storage';

const FALLBACK_POSTER =
  'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 450"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="%2327272A"/><stop offset="100%" stop-color="%2318181B"/></linearGradient></defs><rect fill="url(%23g)" width="300" height="450"/><text x="150" y="225" fill="%237B68EE" text-anchor="middle" font-family="sans-serif" font-size="20" font-weight="800">KRALMOVIE</text></svg>';

interface DetailsViewProps {
  movie: any;
  onBack: () => void;
  onOpenMoviePlayer: () => void;
  onSelectEpisodeSource: (
    url: string,
    quality: string,
    sIdx: number,
    eIdx: number,
    allEpSources: VideoSource[]
  ) => void;
  watchedData: WatchedMap;
  onToggleEpisodeManual: (sIdx: number, eIdx: number) => void;
  isLiked: boolean;
  onToggleLike: () => void;
  showToast: (msg: string, type?: 'success' | 'error') => void;
}

export const DetailsView: React.FC<DetailsViewProps> = ({
  movie,
  onBack,
  onOpenMoviePlayer,
  onSelectEpisodeSource,
  watchedData,
  onToggleEpisodeManual,
  isLiked,
  onToggleLike,
  showToast,
}) => {
  const id = movieId(movie);
  const title = brandFix(movieTitle(movie)) || 'بدون عنوان';
  const year = movieYear(movie);
  const rating = movieRating(movie);
  const poster = moviePoster(movie);
  const backdrop = movieBackdrop(movie) || poster;
  const desc = movieDesc(movie);
  const type = movieType(movie);
  const isDubbed = movie?.is_dubbed === true;
  const hasSub = movie?.sub_status === 'fa';

  const [seasons, setSeasons] = useState<any[]>([]);
  const [loadingSeasons, setLoadingSeasons] = useState(false);
  const [seasonsVisible, setSeasonsVisible] = useState(false);
  const [openSeasonMap, setOpenSeasonMap] = useState<Record<number, boolean>>({ 0: true });
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  useEffect(() => {
    setSeasons([]);
    setSeasonsVisible(false);
    setOpenSeasonMap({ 0: true });
    if (type === 'series' && id) {
      handleLoadSeasons(id);
    }
  }, [id, type]);

  async function handleLoadSeasons(targetId = id) {
    if (!targetId) return;
    setSeasonsVisible(true);
    setLoadingSeasons(true);
    try {
      const data = await fetchSeasons(targetId);
      let list: any[] = [];
      if (Array.isArray(data)) list = data;
      else if (data && Array.isArray(data.seasons)) list = data.seasons;
      else if (data && Array.isArray(data.items)) list = data.items;
      else if (data?.data && Array.isArray(data.data)) list = data.data;
      setSeasons(list);
      if (list.length > 0) {
        setOpenSeasonMap({ 0: true });
      }
    } finally {
      setLoadingSeasons(false);
    }
  }

  function toggleSeasonAccordion(sIdx: number) {
    setOpenSeasonMap((prev) => ({ ...prev, [sIdx]: !prev[sIdx] }));
  }

  async function handleCopyLinks(urls: string[], label: string, keyId: string) {
    if (!urls.length) {
      showToast('لینکی برای کپی یافت نشد', 'error');
      return;
    }
    const text = urls.join('\n');
    const ok = await copyText(text);
    if (ok) {
      setCopiedKey(keyId);
      setTimeout(() => setCopiedKey((prev) => (prev === keyId ? null : prev)), 2200);
      showToast(`✅ ${urls.length} لینک (${label}) در کلیپ‌بورد کپی شد!`, 'success');
    } else {
      showToast('❌ خطا در کپی لینک‌ها', 'error');
    }
  }

  const movieWatchedInfo = watchedData.movies[`${id}::movie`];

  const genresList: string[] = [];
  if (isDubbed) genresList.push('دوبله فارسی');
  if (hasSub) genresList.push('زیرنویس فارسی');
  if (Array.isArray(movie?.genres)) {
    movie.genres.forEach((g: any) => {
      const t = typeof g === 'string' ? g : g?.title || g?.name || '';
      if (t) genresList.push(brandFix(t));
    });
  }

  return (
    <div className="pb-10">
      {/* Top Action Bar */}
      <div className="flex items-center justify-between gap-3 mb-4">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-full text-sm font-bold backdrop-blur-xl transition-transform active:scale-95 cursor-pointer"
          style={{
            background: 'var(--surface-2)',
            border: '1px solid var(--border)',
            color: 'var(--text)',
          }}
        >
          <ArrowRight className="w-4 h-4" />
          <span>بازگشت</span>
        </button>

        <button
          onClick={onToggleLike}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-full text-sm font-bold backdrop-blur-xl transition-transform active:scale-95 cursor-pointer"
          style={{
            background: isLiked ? 'rgba(255, 69, 58, 0.16)' : 'var(--surface-2)',
            border: isLiked ? '1px solid rgba(255, 69, 58, 0.45)' : '1px solid var(--border)',
            color: isLiked ? '#FF6961' : 'var(--text)',
          }}
        >
          <Heart className={`w-4 h-4 ${isLiked ? 'fill-current' : ''}`} />
          <span>{isLiked ? 'در علاقه‌مندی‌ها' : 'افزودن به علاقه‌مندی'}</span>
        </button>
      </div>

      {/* Main Details Card */}
      <div
        className="relative rounded-[26px] overflow-hidden shadow-2xl"
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
        }}
      >
        {/* Ambient Blur */}
        {backdrop && (
          <div
            className="absolute inset-0 z-0 opacity-20 blur-[50px] scale-125 pointer-events-none bg-cover bg-center"
            style={{ backgroundImage: `url('${backdrop}')` }}
          />
        )}

        {/* Hero Backdrop */}
        <div
          className="relative z-10 w-full h-[280px] sm:h-[360px] lg:h-[400px] overflow-hidden"
          style={{ background: 'var(--surface-solid)' }}
        >
          {backdrop && (
            <img
              src={backdrop}
              alt={title}
              referrerPolicy="no-referrer"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.opacity = '0';
              }}
              className="w-full h-full object-cover object-center scale-105"
            />
          )}
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              background:
                'linear-gradient(180deg, rgba(10,10,15,0.08) 0%, rgba(10,10,15,0.35) 45%, var(--bg) 100%)',
            }}
          />

          <div
            className="absolute top-3.5 right-3.5 z-20 px-3.5 py-1.5 rounded-full text-xs font-extrabold text-white backdrop-blur-md flex items-center gap-1.5"
            style={{
              background: 'rgba(0,0,0,0.55)',
              border: '1px solid rgba(255,255,255,0.16)',
            }}
          >
            <span>{type === 'series' ? '📺 سریال' : '🎬 فیلم'}</span>
          </div>

          {rating && (
            <div
              className="absolute top-3.5 left-3.5 z-20 px-3 py-1.5 rounded-xl text-xs font-black text-white shadow-lg flex items-center gap-1 tabular-nums"
              style={{
                background: 'linear-gradient(135deg, #FF9F0A, #FF7B00)',
              }}
            >
              <span>★</span>
              <span>{rating}</span>
            </div>
          )}
        </div>

        {/* Details Body */}
        <div className="relative z-20 -mt-24 px-4 sm:px-6 pb-6 flex flex-col items-center gap-3.5">
          {/* Poster Frame */}
          <div
            className="relative w-44 sm:w-52 rounded-[20px] p-[5px] shadow-2xl"
            style={{
              background:
                'linear-gradient(160deg, var(--primary-bright), rgba(168,139,250,0.25) 45%, var(--primary))',
            }}
          >
            <img
              src={poster || FALLBACK_POSTER}
              alt={title}
              referrerPolicy="no-referrer"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).src = FALLBACK_POSTER;
              }}
              className="w-full aspect-[2/3] object-cover rounded-2xl block"
              style={{ background: 'var(--surface-solid)' }}
            />
          </div>

          {/* Title */}
          <h1
            dir="ltr"
            className="text-xl sm:text-2xl lg:text-3xl font-black text-center leading-tight max-w-2xl"
            style={{ color: 'var(--text)' }}
          >
            {title}
          </h1>

          {/* Metadata Line */}
          <div
            className="flex flex-wrap items-center justify-center gap-2 text-xs sm:text-sm font-bold"
            style={{ color: 'var(--secondary)' }}
          >
            <span style={{ color: 'var(--primary-bright)' }}>{year || '----'}</span>
            <span>·</span>
            <span>{type === 'series' ? 'سریال' : 'فیلم سینمایی'}</span>
            {rating && (
              <>
                <span>·</span>
                <span className="text-amber-400 tabular-nums">IMDb {rating}</span>
              </>
            )}
            {genresList.length > 0 && (
              <>
                <span>·</span>
                <span>{genresList.join(' ، ')}</span>
              </>
            )}
          </div>

          {/* Watched Movie Status if Movie */}
          {type === 'movie' && movieWatchedInfo && (
            <div
              className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full text-xs font-extrabold"
              style={{
                background: 'rgba(50, 215, 75, 0.14)',
                border: '1px solid rgba(50, 215, 75, 0.4)',
                color: '#32D74B',
              }}
            >
              <CheckCircle2 className="w-4 h-4" />
              <span>تماشا شده با کیفیت {movieWatchedInfo.quality}</span>
            </div>
          )}

          {/* Description */}
          <div
            className="w-full max-w-3xl rounded-2xl p-4 text-sm leading-8 text-right max-h-48 overflow-y-auto"
            style={{
              background: 'var(--surface-2)',
              border: '1px solid var(--border)',
              color: 'var(--text-2)',
            }}
          >
            {desc || 'توضیحاتی ثبت نشده است.'}
          </div>

          {/* Primary Actions */}
          <div className="flex flex-wrap items-center justify-center gap-3 w-full mt-1">
            {type === 'movie' ? (
              <button
                onClick={onOpenMoviePlayer}
                className="inline-flex items-center justify-center gap-2.5 py-3.5 px-9 rounded-full font-extrabold text-base text-white shadow-xl active:scale-95 transition-transform cursor-pointer"
                style={{
                  background: 'linear-gradient(135deg, var(--primary), var(--accent))',
                  boxShadow: '0 12px 30px rgba(123, 104, 238, 0.45)',
                }}
              >
                <Play className="w-5 h-5 fill-current" />
                <span>تماشا و انتخاب کیفیت</span>
              </button>
            ) : (
              <button
                onClick={() => handleLoadSeasons(id)}
                className="inline-flex items-center justify-center gap-2.5 py-3.5 px-8 rounded-full font-extrabold text-sm sm:text-base text-white shadow-xl active:scale-95 transition-transform cursor-pointer"
                style={{
                  background: 'linear-gradient(135deg, var(--primary), var(--accent))',
                  boxShadow: '0 12px 30px rgba(123, 104, 238, 0.45)',
                }}
              >
                <Layers className="w-5 h-5" />
                <span>فصل‌ها و قسمت‌ها</span>
              </button>
            )}
          </div>

          {/* SEASONS & EPISODES CONTAINER */}
          {seasonsVisible && (
            <div className="w-full max-w-4xl mt-3 flex flex-col gap-3.5">
              {loadingSeasons ? (
                <div className="flex flex-col items-center justify-center py-10 gap-3">
                  <div
                    className="w-10 h-10 rounded-full border-3 border-transparent animate-spin"
                    style={{
                      borderTopColor: 'var(--accent)',
                      borderBottomColor: 'var(--primary)',
                    }}
                  />
                  <span
                    className="text-xs font-extrabold tracking-widest"
                    style={{ color: 'var(--primary-bright)' }}
                  >
                    دریافت فصل‌ها…
                  </span>
                </div>
              ) : seasons.length === 0 ? (
                <div
                  className="text-center py-10 px-4 rounded-2xl"
                  style={{
                    background: 'var(--surface-2)',
                    border: '1px solid var(--border)',
                  }}
                >
                  <div className="text-3xl mb-2">📺</div>
                  <h3 className="text-sm font-extrabold" style={{ color: 'var(--secondary)' }}>
                    فصلی برای این سریال یافت نشد
                  </h3>
                </div>
              ) : (
                seasons.map((season, sIdx) => {
                  const rawEps = Array.isArray(season.episodes)
                    ? season.episodes
                    : Array.isArray(season.items)
                    ? season.items
                    : Array.isArray(season.episode)
                    ? season.episode
                    : [];
                  const seasonTitle = brandFix(
                    season.title || season.name || `فصل ${season.season || sIdx + 1}`
                  );
                  const validEps = rawEps.filter(
                    (e: any) => !String(e?.title || '').includes('تیزر')
                  );

                  // Parse episodes & collect links by quality for "کپی همه لینک‌ها"
                  const qualityLinksMap = new Map<string, string[]>();
                  const allSeasonUrls: string[] = [];

                  const parsedEpisodes = validEps
                    .map((ep: any, eIdx: number) => {
                      const epNumber = extractEpisodeNumber(ep.title || '', eIdx);
                      const rawSources = Array.isArray(ep.sources)
                        ? ep.sources
                        : ep.links || ep.files || [];
                      const extracted = extractLinks(rawSources).filter(
                        (l) => !String(l.quality).includes('تیزر')
                      );
                      const sorted = sortByQuality(extracted);

                      sorted.forEach((link) => {
                        const qGroup = normalizeQualityGroup(link.quality);
                        if (!qualityLinksMap.has(qGroup)) {
                          qualityLinksMap.set(qGroup, []);
                        }
                        const arr = qualityLinksMap.get(qGroup)!;
                        if (!arr.includes(link.url)) {
                          arr.push(link.url);
                        }
                        if (!allSeasonUrls.includes(link.url)) {
                          allSeasonUrls.push(link.url);
                        }
                      });

                      return {
                        ep,
                        eIdx,
                        epNumber,
                        sorted,
                      };
                    })
                    .filter((item: any) => item.sorted.length > 0);

                  if (parsedEpisodes.length === 0) return null;

                  const isOpen = !!openSeasonMap[sIdx];
                  const watchedCountInSeason = parsedEpisodes.filter(
                    (p: any) => !!watchedData.episodes[`${id}::ep::${sIdx}::${p.eIdx}`]
                  ).length;

                  const qualityEntries = Array.from(qualityLinksMap.entries());

                  return (
                    <div
                      key={sIdx}
                      className="rounded-2xl overflow-hidden"
                      style={{
                        background: 'var(--surface)',
                        border: '1px solid var(--border)',
                      }}
                    >
                      {/* Season Accordion Header */}
                      <div
                        onClick={() => toggleSeasonAccordion(sIdx)}
                        className="p-4 flex items-center justify-between gap-3 cursor-pointer select-none transition-colors"
                        style={{
                          background:
                            'linear-gradient(135deg, rgba(123,104,238,0.10), rgba(168,139,250,0.04))',
                          borderBottom: isOpen ? '1px solid var(--border)' : 'none',
                        }}
                      >
                        <div className="flex items-center gap-2.5 flex-wrap">
                          <span className="text-base font-black" style={{ color: 'var(--text)' }}>
                            📺 {seasonTitle}
                          </span>
                          <span
                            className="text-xs font-bold tabular-nums"
                            style={{ color: 'var(--secondary)' }}
                          >
                            ({parsedEpisodes.length} قسمت)
                          </span>
                          {watchedCountInSeason > 0 && (
                            <span
                              className="text-[11px] font-extrabold px-2.5 py-0.5 rounded-full flex items-center gap-1"
                              style={{
                                background: 'rgba(50, 215, 75, 0.15)',
                                color: '#32D74B',
                              }}
                            >
                              <Check className="w-3 h-3 stroke-[3]" />
                              <span>
                                {watchedCountInSeason} از {parsedEpisodes.length} دیده شده
                              </span>
                            </span>
                          )}
                        </div>
                        <ChevronDown
                          className={`w-5 h-5 transition-transform duration-300 ${
                            isOpen ? 'rotate-180' : ''
                          }`}
                          style={{ color: 'var(--primary-bright)' }}
                        />
                      </div>

                      {/* Season Bulk Copy All Links Toolbar (Per Quality) */}
                      {isOpen && qualityEntries.length > 0 && (
                        <div
                          className="p-3.5 border-b flex flex-col gap-2.5"
                          style={{
                            background: 'var(--surface-2)',
                            borderColor: 'var(--border)',
                          }}
                        >
                          <div className="flex items-center justify-between flex-wrap gap-2">
                            <span
                              className="text-xs font-extrabold flex items-center gap-1.5"
                              style={{ color: 'var(--text-2)' }}
                            >
                              <Copy className="w-3.5 h-3.5" style={{ color: 'var(--primary-bright)' }} />
                              <span>کپی همه لینک‌های {seasonTitle} به تفکیک کیفیت:</span>
                            </span>
                            {allSeasonUrls.length > 1 && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleCopyLinks(
                                    allSeasonUrls,
                                    `همه کیفیت‌های ${seasonTitle}`,
                                    `season-all-${sIdx}`
                                  );
                                }}
                                className="text-[11px] font-bold px-2.5 py-1 rounded-lg transition-transform active:scale-95 cursor-pointer flex items-center gap-1"
                                style={{
                                  background: 'rgba(123, 104, 238, 0.16)',
                                  border: '1px solid rgba(123, 104, 238, 0.35)',
                                  color: 'var(--primary-bright)',
                                }}
                              >
                                {copiedKey === `season-all-${sIdx}` ? (
                                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                                ) : (
                                  <Copy className="w-3 h-3" />
                                )}
                                <span>کپی کل لینک‌های فصل ({allSeasonUrls.length})</span>
                              </button>
                            )}
                          </div>

                          <div className="flex flex-wrap gap-2">
                            {qualityEntries.map(([qName, urls]) => {
                              const copyId = `s-${sIdx}-q-${qName}`;
                              const isCopied = copiedKey === copyId;
                              return (
                                <button
                                  key={qName}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleCopyLinks(urls, `${seasonTitle} - ${qName}`, copyId);
                                  }}
                                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-extrabold transition-all active:scale-95 cursor-pointer"
                                  style={{
                                    background: isCopied
                                      ? 'rgba(50, 215, 75, 0.2)'
                                      : 'var(--surface-solid)',
                                    border: isCopied
                                      ? '1px solid rgba(50, 215, 75, 0.55)'
                                      : '1px solid var(--border-strong)',
                                    color: isCopied ? '#32D74B' : 'var(--text)',
                                  }}
                                >
                                  {isCopied ? (
                                    <Check className="w-3.5 h-3.5 text-emerald-400 stroke-[3]" />
                                  ) : (
                                    <Copy
                                      className="w-3.5 h-3.5"
                                      style={{ color: 'var(--primary-bright)' }}
                                    />
                                  )}
                                  <span dir="ltr">کپی همه {qName}</span>
                                  <span
                                    className="text-[10px] opacity-75 tabular-nums"
                                    style={{ color: 'var(--secondary)' }}
                                  >
                                    ({urls.length} قسمت)
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {/* Episodes List */}
                      {isOpen && (
                        <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
                          {parsedEpisodes.map(({ ep, eIdx, epNumber, sorted }: any) => {
                            const epWatched = watchedData.episodes[`${id}::ep::${sIdx}::${eIdx}`];

                            return (
                              <div
                                key={eIdx}
                                className="p-3.5 sm:p-4 flex flex-col gap-2.5 transition-colors"
                                style={{
                                  background: epWatched
                                    ? 'rgba(50, 215, 75, 0.04)'
                                    : 'transparent',
                                }}
                              >
                                <div className="flex items-center justify-between gap-2.5">
                                  <div className="flex items-center gap-3 min-w-0 flex-1">
                                    <div
                                      className="shrink-0 min-w-[2.6rem] h-[2.6rem] rounded-xl flex items-center justify-center font-black text-sm text-white shadow-md tabular-nums px-2"
                                      style={{
                                        fontFamily: 'var(--font-mono)',
                                        background: epWatched
                                          ? 'linear-gradient(135deg, #28CD41, #199E2E)'
                                          : 'linear-gradient(135deg, var(--primary), var(--accent))',
                                      }}
                                    >
                                      {epWatched ? (
                                        <Check className="w-5 h-5 stroke-[3]" />
                                      ) : (
                                        epNumber
                                      )}
                                    </div>
                                    <div className="min-w-0 flex-1">
                                      <div className="flex items-center gap-2 flex-wrap">
                                        <span
                                          className="text-[11px] font-bold"
                                          style={{ color: 'var(--secondary)' }}
                                        >
                                          قسمت {epNumber}
                                        </span>
                                        {epWatched && (
                                          <span
                                            className="text-[10px] font-extrabold px-2 py-0.5 rounded-md flex items-center gap-1"
                                            style={{
                                              background: 'rgba(50, 215, 75, 0.16)',
                                              color: '#32D74B',
                                            }}
                                          >
                                            <Check className="w-3 h-3 stroke-[3]" />
                                            <span>دیده شده ({epWatched.quality})</span>
                                          </span>
                                        )}
                                      </div>
                                      <div
                                        dir="ltr"
                                        className="text-xs sm:text-sm font-bold truncate text-left"
                                        style={{ color: 'var(--text)' }}
                                      >
                                        {ep.title || `Episode ${epNumber}`}
                                      </div>
                                    </div>
                                  </div>

                                  {/* Manual Watched Toggle Button */}
                                  <button
                                    onClick={() => onToggleEpisodeManual(sIdx, eIdx)}
                                    title={
                                      epWatched
                                        ? 'حذف تیک تماشا شده'
                                        : 'علامت‌گذاری به عنوان تماشا شده'
                                    }
                                    className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-[11px] font-bold transition-transform active:scale-95 cursor-pointer"
                                    style={{
                                      background: epWatched
                                        ? 'rgba(50, 215, 75, 0.18)'
                                        : 'var(--surface-2)',
                                      border: epWatched
                                        ? '1px solid rgba(50, 215, 75, 0.5)'
                                        : '1px solid var(--border)',
                                      color: epWatched ? '#32D74B' : 'var(--secondary)',
                                    }}
                                  >
                                    <Check className="w-3.5 h-3.5 stroke-[2.5]" />
                                    <span className="hidden sm:inline">
                                      {epWatched ? 'دیده شده' : 'تیک تماشا'}
                                    </span>
                                  </button>
                                </div>

                                {/* Quality Badges for this Episode */}
                                <div className="flex flex-wrap gap-2 pr-0 sm:pr-12">
                                  {sorted.map((l: VideoSource, qIdx: number) => {
                                    const ext = getFileExt(l.url);
                                    const qKey = `${id}::ep::${sIdx}::${eIdx}::${l.quality}`;
                                    const isQWatched = !!watchedData.qualities[qKey];
                                    const is1080 = /1080/.test(l.quality);
                                    const is720 = /720/.test(l.quality);
                                    const is480 = /480/.test(l.quality);

                                    let bg = 'var(--surface-2)';
                                    let border = 'var(--border-strong)';
                                    let color = 'var(--text)';

                                    if (isQWatched) {
                                      bg = 'rgba(50, 215, 75, 0.20)';
                                      border = 'rgba(50, 215, 75, 0.65)';
                                      color = '#6EE7B7';
                                    } else if (is1080) {
                                      bg =
                                        'linear-gradient(135deg, rgba(168, 139, 250, 0.22), rgba(123, 104, 238, 0.15))';
                                      border = 'rgba(168, 139, 250, 0.45)';
                                      color = '#C4B5FD';
                                    } else if (is720) {
                                      bg =
                                        'linear-gradient(135deg, rgba(56, 189, 248, 0.22), rgba(123, 104, 238, 0.15))';
                                      border = 'rgba(56, 189, 248, 0.45)';
                                      color = '#7DD3FC';
                                    } else if (is480) {
                                      bg =
                                        'linear-gradient(135deg, rgba(50, 215, 75, 0.18), rgba(56, 189, 248, 0.12))';
                                      border = 'rgba(50, 215, 75, 0.4)';
                                      color = '#86EFAC';
                                    }

                                    return (
                                      <button
                                        key={qIdx}
                                        onClick={() =>
                                          onSelectEpisodeSource(
                                            l.url,
                                            l.quality,
                                            sIdx,
                                            eIdx,
                                            sorted
                                          )
                                        }
                                        className="relative inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-extrabold transition-transform active:scale-95 cursor-pointer"
                                        style={{
                                          fontFamily: 'var(--font-mono)',
                                          background: bg,
                                          border: `1px solid ${border}`,
                                          color,
                                        }}
                                      >
                                        {isQWatched ? (
                                          <span className="w-4 h-4 rounded-full bg-emerald-500 text-white flex items-center justify-center">
                                            <Check className="w-3 h-3 stroke-[3]" />
                                          </span>
                                        ) : (
                                          <span>▶</span>
                                        )}
                                        <span dir="ltr">{l.quality}</span>
                                        {ext && (
                                          <span className="text-[10px] opacity-75 px-1.5 py-0.2 rounded bg-black/30 uppercase">
                                            {ext}
                                          </span>
                                        )}
                                        {isQWatched && (
                                          <span
                                            style={{ fontFamily: 'var(--font-sans)' }}
                                            className="text-[10px] font-extrabold text-emerald-300 mr-0.5"
                                          >
                                            (دیده شده)
                                          </span>
                                        )}
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
