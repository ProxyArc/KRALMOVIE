import React, { memo } from 'react';
import { Check } from 'lucide-react';
import {
  brandFix,
  movieId,
  moviePoster,
  movieRating,
  movieTitle,
  movieType,
  movieYear,
} from '../utils/api';

const FALLBACK_POSTER =
  'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 450"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="%2327272A"/><stop offset="100%" stop-color="%2318181B"/></linearGradient></defs><rect fill="url(%23g)" width="300" height="450"/><text x="150" y="225" fill="%237B68EE" text-anchor="middle" font-family="sans-serif" font-size="20" font-weight="800">KRALMOVIE</text></svg>';

interface MovieCardProps {
  movie: any;
  onSelect: (id: string, movie: any) => void;
  isWatched?: boolean;
  watchedLabel?: string;
  compact?: boolean;
}

export const MovieCard: React.FC<MovieCardProps> = memo(
  ({ movie, onSelect, isWatched = false, watchedLabel, compact = false }) => {
    const id = movieId(movie);
    const title = brandFix(movieTitle(movie)) || 'بدون عنوان';
    const year = movieYear(movie);
    const rating = movieRating(movie);
    const poster = moviePoster(movie);
    const type = movieType(movie);
    const isDubbed = movie?.is_dubbed === true;
    const hasSub = movie?.sub_status === 'fa';

    return (
      <div
        onClick={() => id && onSelect(id, movie)}
        className={`group rounded-2xl overflow-hidden cursor-pointer flex flex-col h-full transition-transform duration-200 active:scale-95 hover:-translate-y-1 ${
          compact ? 'min-w-[148px] max-w-[148px] sm:min-w-[168px] sm:max-w-[168px] lg:min-w-[180px] lg:max-w-[180px] shrink-0' : ''
        }`}
        style={{
          background: 'var(--surface)',
          border: isWatched
            ? '1px solid rgba(50, 215, 75, 0.45)'
            : '1px solid var(--border)',
        }}
      >
        <div
          className="relative w-full aspect-[2/3] overflow-hidden"
          style={{ background: 'var(--surface-solid)' }}
        >
          <img
            src={poster || FALLBACK_POSTER}
            alt={title}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).src = FALLBACK_POSTER;
            }}
            className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
          />
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              background:
                'linear-gradient(180deg, rgba(0,0,0,0.2) 0%, transparent 40%, rgba(0,0,0,0.86) 100%)',
            }}
          />

          {/* Top Right: Type */}
          <div
            className="absolute top-2 right-2 px-2 py-0.5 rounded-md text-[10px] font-bold text-white backdrop-blur-md"
            style={{
              background: 'rgba(0, 0, 0, 0.62)',
              border: '1px solid rgba(255,255,255,0.14)',
            }}
          >
            {type === 'series' ? 'سریال' : 'فیلم'}
          </div>

          {/* Top Left: Watched Checkmark or Dubbed */}
          <div className="absolute top-2 left-2 flex flex-col gap-1 items-start">
            {isWatched && (
              <div
                className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-extrabold text-white shadow-md"
                style={{ background: 'rgba(50, 215, 75, 0.92)' }}
                title={watchedLabel || 'تماشا شده'}
              >
                <Check className="w-3 h-3 stroke-[3]" />
                <span>{watchedLabel || 'دیده شده'}</span>
              </div>
            )}
            {isDubbed && (
              <div
                className="px-2 py-0.5 rounded-md text-[10px] font-extrabold text-white"
                style={{ background: 'rgba(123, 104, 238, 0.9)' }}
              >
                دوبله
              </div>
            )}
          </div>

          {/* Bottom Left: IMDb Rating */}
          {rating && (
            <div
              className="absolute bottom-2 left-2 px-2 py-0.5 rounded-md text-[11px] font-extrabold text-white shadow-sm tabular-nums"
              style={{
                background: 'linear-gradient(135deg, #FF9F0A, #FF7B00)',
              }}
            >
              ★ {rating}
            </div>
          )}
        </div>

        <div className="p-2.5 flex flex-col justify-between gap-1.5 grow">
          <h3
            dir="ltr"
            className="text-xs font-bold leading-snug line-clamp-2 text-left"
            style={{ color: 'var(--text)' }}
          >
            {title}
          </h3>
          <div
            className="flex items-center justify-between text-[11px] font-semibold tabular-nums"
            style={{ color: 'var(--secondary)' }}
          >
            <span style={{ color: 'var(--primary-bright)' }}>{year || '----'}</span>
            {hasSub && <span>زیرنویس</span>}
          </div>
        </div>
      </div>
    );
  }
);

export const SkeletonGrid: React.FC<{ count?: number }> = ({ count = 10 }) => {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 sm:gap-4 mt-2">
      {Array.from({ length: count }).map((_, idx) => (
        <div
          key={idx}
          className="rounded-2xl overflow-hidden aspect-[2/3] skeleton-shimmer"
          style={{ border: '1px solid var(--border)' }}
        />
      ))}
    </div>
  );
};
