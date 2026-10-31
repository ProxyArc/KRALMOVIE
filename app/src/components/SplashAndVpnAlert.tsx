import React from 'react';
import { RefreshCw, ShieldAlert, WifiOff, Film } from 'lucide-react';

interface SplashProps {
  status: string;
  error: string | null;
  onRetry: () => void;
  isRetrying?: boolean;
}

export const SplashLoader: React.FC<SplashProps> = ({
  status,
  error,
  onRetry,
  isRetrying = false,
}) => {
  return (
    <div
      className="fixed inset-0 z-[9999] flex flex-col items-center justify-center p-6 select-none overflow-hidden"
      style={{
        background:
          'radial-gradient(ellipse 100% 65% at 50% 38%, #171528 0%, #09090F 72%)',
      }}
    >
      {/* Ambient cinematic background glow */}
      <div
        className="pointer-events-none absolute w-[360px] h-[360px] rounded-full opacity-25 blur-[90px]"
        style={{
          background: 'radial-gradient(circle, var(--primary) 0%, transparent 70%)',
        }}
      />

      {/* Animated KRAL 3D Emblem with Orbiting Rings */}
      <div className="relative flex items-center justify-center w-36 h-36 mb-6">
        {/* Outer counter-rotating ring */}
        <div
          className="orbit-ring-2 absolute inset-0 rounded-full border border-dashed"
          style={{ borderColor: 'rgba(167, 139, 250, 0.35)' }}
        />
        {/* Middle rotating ring with glowing node */}
        <div
          className="orbit-ring-1 absolute inset-2.5 rounded-full border-2 border-transparent"
          style={{
            borderTopColor: 'var(--primary-bright)',
            borderRightColor: 'rgba(123, 104, 238, 0.25)',
            filter: 'drop-shadow(0 0 12px rgba(123, 104, 238, 0.6))',
          }}
        />
        {/* Inner subtle pulse ring */}
        <div
          className="absolute inset-5 rounded-3xl opacity-40 blur-md"
          style={{
            background: 'linear-gradient(135deg, var(--primary), var(--accent))',
          }}
        />
        {/* Core K Logo */}
        <div
          className="float-logo relative z-10 w-24 h-24 rounded-[26px] flex flex-col items-center justify-center text-white shadow-2xl"
          style={{
            background: 'linear-gradient(135deg, var(--primary), #4F46E5)',
            boxShadow: '0 20px 55px -10px rgba(123, 104, 238, 0.7)',
            border: '1px solid rgba(255,255,255,0.22)',
          }}
        >
          <span
            style={{
              fontFamily: 'var(--font-serif)',
              fontSize: '2.65rem',
              fontWeight: 900,
              lineHeight: 1,
            }}
          >
            K
          </span>
          <span className="text-[9px] tracking-[0.28em] font-bold opacity-80 mt-0.5">
            MOVIE
          </span>
        </div>
      </div>

      {/* Brand Title */}
      <h1
        className="text-3xl font-black tracking-[0.18em] mb-1 text-center"
        style={{
          fontFamily: 'var(--font-serif)',
          background: 'linear-gradient(180deg, #FFFFFF 0%, #C4B5FD 55%, #7B68EE 100%)',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
        }}
      >
        KRALMOVIE
      </h1>
      <p className="text-xs font-bold tracking-wide mb-6" style={{ color: 'var(--secondary)' }}>
        پادشاه فیلم و سریال
      </p>

      {!error ? (
        <div className="flex flex-col items-center gap-4 w-full max-w-xs">
          {/* Animated Equalizer / Cinema Wave Bars */}
          <div className="flex items-end justify-center gap-1.5 h-7">
            <span
              className="eq-bar-1 w-1.5 h-6 rounded-full"
              style={{ background: 'var(--primary-bright)' }}
            />
            <span
              className="eq-bar-2 w-1.5 h-7 rounded-full"
              style={{ background: 'var(--accent)' }}
            />
            <span
              className="eq-bar-3 w-1.5 h-5 rounded-full"
              style={{ background: '#C084FC' }}
            />
            <span
              className="eq-bar-4 w-1.5 h-7 rounded-full"
              style={{ background: 'var(--primary)' }}
            />
            <span
              className="eq-bar-5 w-1.5 h-6 rounded-full"
              style={{ background: 'var(--primary-bright)' }}
            />
          </div>

          {/* Status Text */}
          <div className="flex items-center gap-2 text-sm font-bold text-purple-200">
            <Film className="w-4 h-4 animate-spin text-purple-400" />
            <span>{status || 'در حال اتصال به سرور…'}</span>
          </div>

          {/* Shimmer Progress Bar */}
          <div className="w-60 h-1.5 bg-white/10 rounded-full overflow-hidden relative">
            <div
              className="h-full w-1/2 rounded-full"
              style={{
                background: 'linear-gradient(90deg, var(--primary), var(--accent), #F0ABFC)',
                animation: 'shimmerBar 1.35s ease-in-out infinite',
              }}
            />
          </div>
        </div>
      ) : (
        /* VPN & Connection Alert Card */
        <div
          className="w-full max-w-md rounded-3xl p-6 text-center border shadow-2xl transition-all"
          style={{
            background: 'rgba(24, 24, 34, 0.92)',
            borderColor: 'rgba(255, 69, 58, 0.38)',
            boxShadow: '0 24px 60px rgba(0, 0, 0, 0.75)',
          }}
        >
          <div className="w-16 h-16 rounded-2xl mx-auto mb-4 flex items-center justify-center bg-red-500/15 border border-red-500/30 text-red-400">
            <ShieldAlert className="w-9 h-9" />
          </div>

          <h2 className="text-lg font-black text-white mb-2">
            لطفاً VPN (فیلترشکن) خود را خاموش کنید!
          </h2>

          <p className="text-sm leading-7 text-gray-300 mb-4">
            سرور برنامه فقط با <span className="text-amber-400 font-extrabold">آی‌پی ایران (IP Iran)</span> به
            درخواست‌ها پاسخ می‌دهد. اگر فیلترشکن یا پراکسی شما روشن است، لطفاً آن را خاموش کرده و
            دکمه رفرش را بزنید.
          </p>

          <div className="text-xs font-mono py-2 px-3 rounded-xl bg-black/40 text-red-300 border border-white/5 mb-5">
            {error}
          </div>

          <button
            onClick={onRetry}
            disabled={isRetrying}
            className="w-full py-3.5 px-6 rounded-2xl font-extrabold text-sm text-white flex items-center justify-center gap-2.5 shadow-lg active:scale-95 transition-transform cursor-pointer disabled:opacity-60"
            style={{
              background: 'linear-gradient(135deg, var(--primary), var(--accent))',
              boxShadow: '0 10px 30px rgba(123, 104, 238, 0.45)',
            }}
          >
            <RefreshCw className={`w-4 h-4 ${isRetrying ? 'animate-spin' : ''}`} />
            <span>{isRetrying ? 'در حال بررسی مجدد اتصال…' : 'رفرش و تلاش مجدد'}</span>
          </button>
        </div>
      )}
    </div>
  );
};

export const VpnWarningCard: React.FC<{
  message?: string;
  onRetry: () => void;
  isRetrying?: boolean;
}> = ({ message, onRetry, isRetrying = false }) => {
  return (
    <div
      className="my-6 mx-auto max-w-lg rounded-3xl p-6 text-center border shadow-xl"
      style={{
        background: 'var(--surface)',
        borderColor: 'rgba(255, 159, 10, 0.4)',
      }}
    >
      <div className="w-14 h-14 rounded-2xl mx-auto mb-3 flex items-center justify-center bg-amber-500/15 border border-amber-500/30 text-amber-400">
        <WifiOff className="w-7 h-7" />
      </div>
      <h3 className="text-base font-black mb-2" style={{ color: 'var(--text)' }}>
        عدم دریافت لیست فیلم‌ها از سرور
      </h3>
      <p className="text-xs sm:text-sm leading-7 mb-4" style={{ color: 'var(--secondary)' }}>
        لطفاً <strong className="text-amber-400">VPN (فیلترشکن)</strong> خود را خاموش کنید! API برنامه
        فقط با <strong className="text-amber-400">آی‌پی ایران</strong> به درخواست‌ها جواب می‌دهد.
      </p>
      {message && (
        <div
          className="text-xs py-1.5 px-3 rounded-xl mb-4 inline-block"
          style={{ background: 'var(--surface-2)', color: 'var(--tertiary)' }}
        >
          {message}
        </div>
      )}
      <div>
        <button
          onClick={onRetry}
          disabled={isRetrying}
          className="inline-flex items-center justify-center gap-2 py-3 px-7 rounded-full font-extrabold text-sm text-white shadow-lg active:scale-95 transition-transform cursor-pointer"
          style={{
            background: 'linear-gradient(135deg, var(--primary), var(--accent))',
            boxShadow: '0 8px 24px rgba(123, 104, 238, 0.4)',
          }}
        >
          <RefreshCw className={`w-4 h-4 ${isRetrying ? 'animate-spin' : ''}`} />
          <span>رفرش و تلاش مجدد</span>
        </button>
      </div>
    </div>
  );
};
