import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  Bookmark,
  Download,
  Folder,
  Play,
  Trash2,
  X,
} from 'lucide-react';
import {
  brandFix,
  movieId,
  moviePoster,
  resolveImageUrl,
} from '../utils/api';
import {
  DownloadRecord,
  getDownloadRecords,
  getSavedDownloads,
  removeDownloadRecord,
  SavedDownloadItem,
} from '../utils/storage';

type Tab = 'saved' | 'downloaded' | 'downloading';
type SubTab = 'movie' | 'series' | 'all';

export interface BridgeDownload {
  dmId: number;
  status: string;
  downloaded: number;
  total: number;
  percent: number;
  reason?: number;
  resumable?: boolean;
  fileName: string;
  folder: string;
  title: string;
  label: string;
  quality: string;
  type: 'movie' | 'series';
}

function formatBytes(n: number): string {
  if (!n || n <= 0) return '—';
  if (n < 1024) return `${n} بایت`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} کیلوبایت`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} مگابایت`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} گیگابایت`;
}

function formatEta(seconds: number | null): string {
  if (seconds == null || !isFinite(seconds) || seconds < 0) return 'نامشخص';
  if (seconds < 60) return `${Math.ceil(seconds)} ثانیه مانده`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m} دقیقه و ${s} ثانیه مانده`;
}

interface Props {
  onBack: () => void;
  onOpenDetails: (movie: any) => void;
  onPlayDownloaded: (dmId: number, title: string) => void;
  showToast: (msg: string, type?: 'success' | 'error') => void;
  refreshSignal: number;
}

export const DownloadManager: React.FC<Props> = ({
  onBack,
  onOpenDetails,
  onPlayDownloaded,
  showToast,
  refreshSignal,
}) => {
  const [tab, setTab] = useState<Tab>('saved');
  const [subTab, setSubTab] = useState<SubTab>('all');
  const [saved, setSaved] = useState<SavedDownloadItem[]>(() => getSavedDownloads());
  const [records, setRecords] = useState<DownloadRecord[]>(() => getDownloadRecords());
  const [bridge, setBridge] = useState<BridgeDownload[]>([]);
  const prevBytesRef = useRef<Map<number, { bytes: number; at: number }>>(new Map());
  const etaRef = useRef<Map<number, number | null>>(new Map());
  const [, setTick] = useState(0);

  const bridgeObj = (): any => (window as any).AndroidPlayer || null;

  const refreshBridge = useCallback(() => {
    const b = bridgeObj();
    if (!b?.listDownloads) {
      setBridge([]);
      return;
    }
    try {
      const raw = b.listDownloads();
      const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const recMap = new Map(getDownloadRecords().map((r) => [r.dmId, r]));
      const merged: BridgeDownload[] = (Array.isArray(list) ? list : []).map((d: any) => {
        const rec = recMap.get(Number(d.dmId));
        return {
          dmId: Number(d.dmId),
          status: String(d.status || ''),
          downloaded: Number(d.downloaded || 0),
          total: Number(d.total || 0),
          percent: Number(d.percent || 0),
          reason: Number(d.reason || 0),
          fileName: String(d.fileName || rec?.fileName || ''),
          folder: String(d.folder || rec?.folder || ''),
          title: String(d.title || rec?.title || ''),
          label: String(d.label || rec?.label || ''),
          quality: String(d.quality || rec?.quality || ''),
          type: (d.type === 'series' ? 'series' : 'movie') as 'movie' | 'series',
        };
      });
      // ETA: speed from the previous poll, per download.
      const now = Date.now();
      merged.forEach((d) => {
        const prev = prevBytesRef.current.get(d.dmId);
        if (prev && d.downloaded > prev.bytes && now > prev.at) {
          const speed = (d.downloaded - prev.bytes) / ((now - prev.at) / 1000);
          if (speed > 0 && d.total > d.downloaded) {
            etaRef.current.set(d.dmId, (d.total - d.downloaded) / speed);
          } else {
            etaRef.current.set(d.dmId, null);
          }
        }
        prevBytesRef.current.set(d.dmId, { bytes: d.downloaded, at: now });
      });
      setBridge(merged);
      setRecords(getDownloadRecords());
    } catch {
      // ignore: bridge data is best-effort
    }
  }, []);

  // v1.40: tell native code when Download Manager is open, so
  // download notifications stop updating while the user is
  // already watching progress here. When the app goes to the
  // background, native code resumes notifications on its own.
  useEffect(() => {
    try {
      const b = bridgeObj();
      if (b?.setDownloadManagerVisible) b.setDownloadManagerVisible(true);
    } catch {
      // ignore
    }
    return () => {
      try {
        const b = bridgeObj();
        if (b?.setDownloadManagerVisible) b.setDownloadManagerVisible(false);
      } catch {
        // ignore
      }
    };
  }, []);

  useEffect(() => {
    setSaved(getSavedDownloads());
    setRecords(getDownloadRecords());
    refreshBridge();
  }, [refreshSignal, refreshBridge]);

  useEffect(() => {
    if (tab !== 'downloading') return;
    refreshBridge();
    const t = setInterval(refreshBridge, 1000);
    return () => clearInterval(t);
  }, [tab, refreshBridge]);

  // Poll once more when the manager opens, so the list is fresh.
  useEffect(() => {
    refreshBridge();
    const t = setInterval(() => setTick((v) => v + 1), 1000);
    return () => clearInterval(t);
  }, [refreshBridge]);

  // v1.26: failed downloads were invisible before (neither in
  // "downloading" nor in "downloaded"), so a rejected download
  // just vanished. Show failed here, with its reason, so the
  // user sees why it stopped instead of a mystery 0%.
  const downloading = bridge.filter((d) => d.status === 'downloading' || d.status === 'paused' || d.status === 'pending' || d.status === 'failed');
  function downloadReasonText(d: BridgeDownload): string {
    if (d.status === 'failed') {
      const r = d.reason || 0;
      if (r >= 400 && r < 600) return `دانلود ناموفق بود — خطای سرور ${r}؛ کیفیت دیگری را امتحان کنید.`;
      if (r === 1006) return 'دانلود ناموفق بود — حافظه گوشی کافی نیست.';
      if (r === 1009) return 'دانلود ناموفق بود — فایلی با همین نام از قبل وجود دارد.';
      if (r === 1008) return 'دانلود متوقف شده است — با دکمه تلاش مجدد، از همان‌جا ادامه پیدا می‌کند.';
      if (r === 1005) return 'دانلود ناموفق بود — تغییر مسیر بیش از حد سرور.';
      if (r === 1001) return 'دانلود ناموفق بود — خطای ذخیره فایل.';
      return 'دانلود ناموفق بود — حذف کنید و دوباره امتحان کنید.';
    }
    if (d.status === 'paused') {
      if (d.reason === 2) return 'در انتظار اتصال شبکه…';
      if (d.reason === 3) return 'در انتظار وای‌فای…';
      if (d.reason === 1) return 'در حال تلاش دوباره برای اتصال…';
      return 'دانلود متوقف شده است.';
    }
    if (d.status === 'pending') return 'در صف دانلود — در حال آماده‌سازی…';
    if (d.downloaded === 0) return 'در حال اتصال به سرور دانلود…';
    return '';
  }
  const downloaded = bridge.filter((d) => d.status === 'successful');
  const downloadedFiltered =
    subTab === 'all' ? downloaded : downloaded.filter((d) => d.type === subTab);
  const savedFiltered =
    subTab === 'all' ? saved : saved.filter((s) => s.type === subTab);

  function handleRetry(dmId: number) {
    const b = bridgeObj();
    try {
      const ok = b?.resumeDownload ? b.resumeDownload(dmId) : false;
      if (ok) {
        showToast('تلاش مجدد شروع شد — دانلود از همان‌جا ادامه پیدا می‌کند، نه از اول', 'success');
      } else {
        showToast('ادامه این دانلود ممکن نیست؛ لطفاً دوباره دانلود کنید', 'error');
      }
    } catch {
      showToast('ادامه این دانلود ممکن نیست؛ لطفاً دوباره دانلود کنید', 'error');
    }
    refreshBridge();
  }

  // v1.37: ask for the notification permission once when the
  // manager opens, so download progress can show in the
  // notification shade even when the app is closed.
  useEffect(() => {
    try {
      const b = bridgeObj();
      if (b?.requestNotificationPermissionJs) b.requestNotificationPermissionJs();
    } catch {
      // ignore
    }
  }, []);

  const [batteryExempt, setBatteryExempt] = useState<boolean | null>(null);

  const refreshBatteryStatus = useCallback(() => {
    try {
      const b = bridgeObj();
      if (b?.isBatteryOptimizationExempt) {
        setBatteryExempt(Boolean(b.isBatteryOptimizationExempt()));
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    refreshBatteryStatus();
  }, [refreshBatteryStatus]);

  function handleBatteryExemption() {
    const b = bridgeObj();
    try {
      if (b?.requestBatteryOptimizationExemption) b.requestBatteryOptimizationExemption();
      showToast('پنجره سیستم باز شد — روی «اجازه دادن» بزنید تا دانلود در پس‌زمینه قطع نشود', 'success');
    } catch {
      // ignore
    }
    setTimeout(refreshBatteryStatus, 2000);
  }

  function handleDelete(dmId: number) {
    const b = bridgeObj();
    try {
      if (b?.deleteDownload) b.deleteDownload(dmId);
    } catch {
      // ignore
    }
    removeDownloadRecord(dmId);
    setRecords(getDownloadRecords());
    refreshBridge();
    showToast('دانلود حذف شد', 'success');
  }

  function handleRemoveSaved(item: SavedDownloadItem) {
    try {
      const list = getSavedDownloads().filter((x) => String(x.id) !== String(item.id));
      localStorage.setItem('kral-saved-downloads-v1', JSON.stringify(list));
      setSaved(list);
    } catch {
      // ignore
    }
  }

  const isAndroid = !!bridgeObj()?.listDownloads;

  return (
    <div className="flex flex-col gap-4">
      <div
        className="flex items-center justify-between gap-3 p-3 rounded-2xl border"
        style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
      >
        <button
          onClick={onBack}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full text-xs font-extrabold cursor-pointer active:scale-95"
          style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text)' }}
        >
          <ArrowRight className="w-4 h-4" />
          <span>بازگشت</span>
        </button>
        <h2 className="text-sm sm:text-base font-extrabold flex items-center gap-2" style={{ color: 'var(--text)' }}>
          <Download className="w-5 h-5" style={{ color: 'var(--primary-bright)' }} />
          <span>دانلود منیجر</span>
        </h2>
        <span className="text-[11px] font-bold px-2.5 py-1 rounded-full" style={{ background: 'rgba(123,104,238,0.16)', color: 'var(--primary-bright)' }}>
          {downloaded.length} دانلود شده
        </span>
      </div>

      {!isAndroid && (
        <div className="p-4 rounded-2xl border text-xs font-bold leading-6" style={{ background: 'var(--surface-2)', borderColor: 'var(--border)', color: 'var(--secondary)' }}>
          دانلود فایل در نسخه اندروید برنامه انجام می‌شود. در مرورگر فقط بخش «ذخیره‌شده» کار می‌کند؛ برای دانلود، برنامه را روی گوشی باز کنید.
        </div>
      )}

      <div className="p-4 rounded-2xl border flex flex-col gap-2" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
        <div className="flex items-center gap-2 text-xs font-extrabold" style={{ color: 'var(--text)' }}>
          <Folder className="w-4 h-4" style={{ color: 'var(--primary-bright)' }} />
          <span>پوشه ذخیره‌سازی دانلودها</span>
        </div>
        <p className="text-xs font-bold leading-6" style={{ color: 'var(--secondary)' }} dir="ltr">
          Download / KRALMOVIE / Movies — فیلم‌ها
          <br />
          Download / KRALMOVIE / Series — سریال‌ها
        </p>
        <p className="text-xs font-bold" style={{ color: 'var(--secondary)' }}>
          فیلم‌ها داخل خود برنامه ذخیره نمی‌شوند؛ در پوشه دانلود گوشی، داخل پوشه KRALMOVIE هستند و از همین‌جا با پلیر VLC برنامه پخش می‌شوند.
        </p>
      </div>

      <div className="p-4 rounded-2xl border flex flex-col gap-2" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
        <div className="text-xs font-extrabold" style={{ color: 'var(--text)' }}>
          دانلود با خروج از برنامه قطع می‌شود؟
        </div>
        <p className="text-xs font-bold leading-6" style={{ color: 'var(--secondary)' }}>
          اندروید برای صرفه‌جویی در باتری، برنامه‌های پس‌زمینه را می‌بندد. برای اینکه دانلود مثل ADM ادامه پیدا کند، بهینه‌سازی باتری را برای کرال‌مووی خاموش کنید. در گوشی‌های سامسونگ علاوه بر این، به تنظیمات &gt; باتری &gt; محدودیت استفاده در پس‌زمینه &gt; برنامه‌های هرگز به خواب نمی‌روند بروید و کرال‌مووی را اضافه کنید.
        </p>
        {batteryExempt === true ? (
          <div className="text-xs font-extrabold" style={{ color: '#32D74B' }}>بهینه‌سازی باتری خاموش است — دانلود در پس‌زمینه ادامه پیدا می‌کند.</div>
        ) : (
          <button
            onClick={handleBatteryExemption}
            className="self-start px-4 py-2.5 rounded-full text-xs font-extrabold cursor-pointer active:scale-95"
            style={{ background: 'linear-gradient(135deg, var(--primary), var(--accent))', color: '#fff' }}
          >
            خاموش کردن بهینه‌سازی باتری برای کرال‌مووی
          </button>
        )}
      </div>

      <div className="flex gap-2 overflow-x-auto no-scrollbar">
        {([
          { id: 'saved', label: 'ذخیره‌شده' },
          { id: 'downloaded', label: 'دانلودشده' },
          { id: 'downloading', label: 'در حال دانلود' },
        ] as const).map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className="whitespace-nowrap px-4 py-2.5 rounded-full text-xs sm:text-sm font-extrabold cursor-pointer active:scale-95"
            style={{
              background: tab === t.id ? 'linear-gradient(135deg, var(--primary), var(--accent))' : 'var(--surface-2)',
              color: tab === t.id ? '#fff' : 'var(--secondary)',
              border: '1px solid var(--border)',
            }}
          >
            {t.label}
            {t.id === 'downloading' && downloading.length > 0 && ` (${downloading.length})`}
            {t.id === 'downloaded' && downloaded.length > 0 && ` (${downloaded.length})`}
            {t.id === 'saved' && saved.length > 0 && ` (${saved.length})`}
          </button>
        ))}
      </div>

      {(tab === 'downloaded' || tab === 'saved') && (
        <div className="flex gap-2">
          {([
            { id: 'all', label: 'همه' },
            { id: 'movie', label: 'فیلم‌ها' },
            { id: 'series', label: 'سریال‌ها' },
          ] as const).map((t) => (
            <button
              key={t.id}
              onClick={() => setSubTab(t.id)}
              className="px-4 py-2 rounded-full text-xs font-extrabold cursor-pointer active:scale-95"
              style={{
                background: subTab === t.id ? 'rgba(123,104,238,0.2)' : 'var(--surface-2)',
                color: subTab === t.id ? 'var(--primary-bright)' : 'var(--secondary)',
                border: '1px solid var(--border)',
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      {tab === 'saved' && (
        <div>
          {savedFiltered.length === 0 ? (
            <div className="text-center py-12 px-4 rounded-3xl border" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
              <Bookmark className="w-8 h-8 mx-auto mb-3" style={{ color: 'var(--primary-bright)' }} />
              <p className="text-sm font-extrabold" style={{ color: 'var(--text)' }}>هنوز چیزی برای دانلود ذخیره نکرده‌اید</p>
              <p className="text-xs font-bold mt-1" style={{ color: 'var(--secondary)' }}>در صفحه جزئیات هر فیلم یا سریال، روی دکمه ذخیره برای دانلود بزنید تا اینجا بیاید.</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {savedFiltered.map((s) => (
                <div key={s.id} className="rounded-2xl overflow-hidden border" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
                  <div className="relative cursor-pointer" onClick={() => s.movie && onOpenDetails(s.movie)}>
                    {s.poster ? (
                      <img src={resolveImageUrl(s.poster)} alt={brandFix(s.title)} loading="lazy" decoding="async" referrerPolicy="no-referrer" className="w-full aspect-[2/3] object-cover" />
                    ) : (
                      <div className="w-full aspect-[2/3] flex items-center justify-center text-xs font-bold" style={{ background: 'var(--surface-solid)', color: 'var(--secondary)' }}>{brandFix(s.title)}</div>
                    )}
                  </div>
                  <div className="p-3 flex flex-col gap-2">
                    <span className="text-xs font-extrabold truncate" style={{ color: 'var(--text)' }}>{brandFix(s.title)}</span>
                    <span className="text-[11px] font-bold" style={{ color: 'var(--secondary)' }}>{s.type === 'series' ? 'سریال' : 'فیلم'} {s.year ? `· ${s.year}` : ''}</span>
                    <div className="flex gap-2">
                      <button
                        onClick={() => s.movie && onOpenDetails(s.movie)}
                        className="flex-1 inline-flex items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-extrabold cursor-pointer active:scale-95"
                        style={{ background: 'linear-gradient(135deg, var(--primary), var(--accent))', color: '#fff' }}
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>دانلود</span>
                      </button>
                      <button
                        onClick={() => handleRemoveSaved(s)}
                        className="px-3 py-2 rounded-xl cursor-pointer active:scale-95"
                        style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', color: '#FF6961' }}
                        title="حذف از ذخیره‌شده"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'downloaded' && (
        <div>
          {downloadedFiltered.length === 0 ? (
            <div className="text-center py-12 px-4 rounded-3xl border" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
              <Download className="w-8 h-8 mx-auto mb-3" style={{ color: 'var(--primary-bright)' }} />
              <p className="text-sm font-extrabold" style={{ color: 'var(--text)' }}>هنوز دانلودی کامل نشده است</p>
              <p className="text-xs font-bold mt-1" style={{ color: 'var(--secondary)' }}>دانلودهای کامل‌شده اینجا، جدا در دو بخش فیلم‌ها و سریال‌ها نمایش داده می‌شوند.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {downloadedFiltered.map((d) => (
                <div key={d.dmId} className="p-3.5 rounded-2xl border flex items-center gap-3" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
                  <button
                    onClick={() => onPlayDownloaded(d.dmId, d.title)}
                    className="shrink-0 w-11 h-11 rounded-full flex items-center justify-center cursor-pointer active:scale-95"
                    style={{ background: 'linear-gradient(135deg, var(--primary), var(--accent))', color: '#fff' }}
                    title="پخش با VLC"
                  >
                    <Play className="w-5 h-5 fill-current" />
                  </button>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-extrabold truncate" style={{ color: 'var(--text)' }}>{brandFix(d.title)}</div>
                    <div className="text-[11px] font-bold truncate" style={{ color: 'var(--secondary)' }}>
                      {d.label} {d.quality ? `· ${d.quality}` : ''} · {d.type === 'series' ? 'سریال' : 'فیلم'}
                    </div>
                    <div className="text-[11px] font-bold truncate" style={{ color: 'var(--secondary)' }} dir="ltr">{d.folder}/{d.fileName}</div>
                    <div className="text-[11px] font-bold" style={{ color: '#32D74B' }}>دانلود کامل شد · {formatBytes(d.total)}</div>
                  </div>
                  <button
                    onClick={() => handleDelete(d.dmId)}
                    className="shrink-0 px-3 py-2 rounded-xl cursor-pointer active:scale-95 flex items-center gap-1.5 text-xs font-extrabold"
                    style={{ background: 'rgba(255,69,58,0.12)', border: '1px solid rgba(255,69,58,0.35)', color: '#FF6961' }}
                  >
                    <Trash2 className="w-4 h-4" />
                    <span className="hidden sm:inline">حذف</span>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'downloading' && (
        <div>
          {downloading.length === 0 ? (
            <div className="text-center py-12 px-4 rounded-3xl border" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
              <Download className="w-8 h-8 mx-auto mb-3" style={{ color: 'var(--primary-bright)' }} />
              <p className="text-sm font-extrabold" style={{ color: 'var(--text)' }}>در حال حاضر چیزی در حال دانلود نیست</p>
              <p className="text-xs font-bold mt-1" style={{ color: 'var(--secondary)' }}>از صفحه جزئیات فیلم یا سریال، روی دکمه دانلود هر کیفیت یا قسمت بزنید.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {downloading.map((d) => {
                const pct = d.total > 0 ? Math.min(100, Math.round((d.downloaded / d.total) * 100)) : d.percent;
                const eta = etaRef.current.get(d.dmId) ?? null;
                return (
                  <div key={d.dmId} className="p-3.5 rounded-2xl border flex flex-col gap-2.5" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-extrabold truncate" style={{ color: 'var(--text)' }}>{brandFix(d.title)}</div>
                        <div className="text-[11px] font-bold truncate" style={{ color: 'var(--secondary)' }}>{d.label} {d.quality ? `· ${d.quality}` : ''}</div>
                      </div>
                      {(d.status === 'failed' || d.status === 'paused') && (
                        <button
                          onClick={() => handleRetry(d.dmId)}
                          className="shrink-0 px-3 py-2 rounded-xl cursor-pointer active:scale-95 text-xs font-extrabold"
                          style={{ background: 'linear-gradient(135deg, var(--primary), var(--accent))', color: '#fff' }}
                        >
                          <span>تلاش مجدد</span>
                        </button>
                      )}
                      <button
                        onClick={() => handleDelete(d.dmId)}
                        className="shrink-0 px-3 py-2 rounded-xl cursor-pointer active:scale-95 flex items-center gap-1.5 text-xs font-extrabold"
                        style={{ background: 'rgba(255,69,58,0.12)', border: '1px solid rgba(255,69,58,0.35)', color: '#FF6961' }}
                      >
                        <Trash2 className="w-4 h-4" />
                        <span>لغو و حذف</span>
                      </button>
                    </div>
                    <div className="h-2.5 rounded-full overflow-hidden" style={{ background: 'var(--surface-2)' }}>
                      <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, background: 'linear-gradient(90deg, var(--primary), var(--accent))' }} />
                    </div>
                    <div className="flex items-center justify-between text-[11px] font-extrabold tabular-nums" style={{ color: 'var(--secondary)' }}>
                      <span>{pct}٪</span>
                      <span>{formatBytes(d.downloaded)} از {formatBytes(d.total)}</span>
                      <span>{formatEta(eta)}</span>
                    </div>
                    {downloadReasonText(d) && (
                      <div className="text-[11px] font-bold" style={{ color: d.status === 'failed' ? '#FF6961' : 'var(--secondary)' }}>{downloadReasonText(d)}</div>
                    )}
                    {(d.status === 'failed' || d.status === 'paused') && d.resumable && (
                      <div className="text-[11px] font-bold" style={{ color: 'var(--secondary)' }}>تلاش مجدد از همان‌جا که مانده ادامه می‌دهد؛ دانلود از اول شروع نمی‌شود.</div>
                    )}
                    {d.total > 0 && (
                      <div className="text-[11px] font-bold" style={{ color: 'var(--secondary)' }}>حجم فیلم: {formatBytes(d.total)}</div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
      <div style={{ display: 'none' }}>{records.length}</div>
    </div>
  );
};
