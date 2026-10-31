import React, { useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronRight,
  Copy,
  EyeOff,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  RefreshCw,
  Settings,
  X,
} from 'lucide-react';
import {
  copyText,
  getFileExt,
  normalizeVideoUrl,
  openInExternalApp,
  scoreVideoUrl,
  VideoSource,
} from '../utils/api';
import { WatchedMap } from '../utils/storage';
import { extractMkvSubtitles } from '../utils/mkvSubtitles';

interface PlayerViewProps {
  movieTitle: string;
  movieId: string;
  sources: VideoSource[];
  activeSourceIndex: number;
  onSelectQualityOption: (idx: number, source: VideoSource) => void;
  onSwitchInlineQuality: (idx: number, source: VideoSource) => void;
  onExit: () => void;
  watchedData: WatchedMap;
  showToast: (msg: string, type?: 'success' | 'error') => void;
  autoPlayUrl?: string | null;
  autoPlayQuality?: string | null;
  subtitleUrls?: string[];
}

function cleanCueText(t: string): string {
  let text = String(t || '');
  // ASS samples can arrive as "ReadOrder,Layer,Style,...,Text".
  if (!/^Dialogue:/i.test(text)) {
    const parts = text.split(',');
    if (parts.length >= 9 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1])) {
      text = parts.slice(8).join(',');
    }
  }
  return text
    .replace(/\{[^}]*\}/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\\N/g, '\n')
    .trim();
}

function parseSubtitleTime(t: string): number {
  const m = String(t || '')
    .trim()
    .match(/(?:(\d+):)?(\d+):(\d+)[,.](\d+)/);
  if (!m) return NaN;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  const min = parseInt(m[2], 10);
  const sec = parseInt(m[3], 10);
  const frac = parseInt((m[4] + '000').slice(0, 3), 10);
  return h * 3600 + min * 60 + sec + frac / 1000;
}

function formatVttTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec % 1) * 1000);
  const pad = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}

// Convert SRT / ASS / VTT text to WebVTT text. Browsers only load
// <track> files as WebVTT, so a separate .srt/.ass file from the API
// must be converted before it can be shown.
function subtitleTextToVtt(raw: string): string | null {
  const text = String(raw || '').replace(/^\uFEFF/, '');
  if (!text.trim()) return null;
  const cues: { start: number; end: number; body: string }[] = [];
  if (/^Dialogue:/m.test(text)) {
    // ASS / SSA
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('Dialogue:')) continue;
      const parts = line.slice('Dialogue:'.length).split(',');
      if (parts.length < 10) continue;
      const start = parseSubtitleTime(parts[1]);
      const end = parseSubtitleTime(parts[2]);
      const body = cleanCueText(parts.slice(9).join(','));
      if (!isNaN(start) && !isNaN(end) && body) cues.push({ start, end, body });
    }
  } else {
    // SRT / VTT: blocks separated by a blank line
    const blocks = text.replace(/^WEBVTT[^\n]*\n/, '').split(/\r?\n\r?\n/);
    for (const block of blocks) {
      const lines = block.split(/\r?\n/).filter((l) => l.trim() !== '');
      if (!lines.length) continue;
      const timeIdx = lines.findIndex((l) => l.includes('-->'));
      if (timeIdx < 0) continue;
      const [a, b] = lines[timeIdx].split('-->');
      const start = parseSubtitleTime(a);
      const end = parseSubtitleTime(b);
      const body = cleanCueText(lines.slice(timeIdx + 1).join('\n'));
      if (!isNaN(start) && !isNaN(end) && body) cues.push({ start, end, body });
    }
  }
  if (!cues.length) return null;
  cues.sort((x, y) => x.start - y.start);
  return (
    'WEBVTT\n\n' +
    cues.map((c) => `${formatVttTime(c.start)} --> ${formatVttTime(c.end)}\n${c.body}`).join('\n\n')
  );
}

const SPEED_STEPS = [1, 1.25, 1.5, 2, 0.5, 0.75];

function formatTime(s: number): string {
  if (!s || isNaN(s)) return '00:00';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

function faNum(n: number | string): string {
  return String(n).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
}

export const PlayerView: React.FC<PlayerViewProps> = ({
  movieTitle,
  movieId,
  sources,
  activeSourceIndex,
  onSelectQualityOption,
  onSwitchInlineQuality,
  onExit,
  watchedData,
  showToast,
  autoPlayUrl,
  autoPlayQuality,
  subtitleUrls = [],
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const seekBarRef = useRef<HTMLDivElement | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [showPrompt, setShowPrompt] = useState(!autoPlayUrl);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [isLandscape, setIsLandscape] = useState(false);
  const [speedIdx, setSpeedIdx] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bufferedPct, setBufferedPct] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [dragPct, setDragPct] = useState(0);
  const [tooltipPct, setTooltipPct] = useState<number | null>(null);

  const [fsQualityOpen, setFsQualityOpen] = useState(false);
  const [hideFlash, setHideFlash] = useState(false);
  // Subtitles: on by default. The in-app player previously never
  // enabled anything, so embedded MKV subtitle tracks (the ones
  // VLC/MX show) stayed hidden, and separate subtitle files from
  // the API were never loaded at all.
  const [subtitlesOn, setSubtitlesOn] = useState(true);
  const [subtitleTracks, setSubtitleTracks] = useState<
    { label: string; language: string }[]
  >([]);
  const [currentCueText, setCurrentCueText] = useState('');
  const subtitlesOnRef = useRef(true);
  const externalTrackElsRef = useRef<HTMLTrackElement[]>([]);
  const externalTracksReadyRef = useRef(false);
  // Cues extracted natively from the MKV by Android (see
  // MainActivity.extractSubtitles). Chrome does not expose MKV
  // subtitle tracks through video.textTracks at all, so without
  // this the in-app player can never show them.
  const nativeCuesRef = useRef<{ start: number; end: number; text: string }[]>([]);
  const nativeSubsReadyRef = useRef(false);
  const mkvJsStartedRef = useRef(false);
  const mkvAbortRef = useRef<AbortController | null>(null);
  const mkvFallbackTimerRef = useRef<any>(null);

  const [playbackError, setPlaybackError] = useState<{
    url: string;
    kind: 'timeout' | 'error';
  } | null>(null);

  const currentUrlRef = useRef<string>('');
  const intentionallyStoppedRef = useRef<boolean>(false);
  const watchdogRef = useRef<any>(null);
  const controlsTimerRef = useRef<any>(null);
  const tapTimerRef = useRef<any>(null);
  const tapCountRef = useRef<number>(0);
  const triedUrlsRef = useRef<Set<string>>(new Set());
  const fallbackCountRef = useRef<number>(0);

  // Start playback when autoPlayUrl changes
  useEffect(() => {
    if (autoPlayUrl) {
      triedUrlsRef.current.clear();
      fallbackCountRef.current = 0;
      beginPlayback(autoPlayUrl);
    } else {
      stopPlayback();
      setShowPrompt(true);
    }
    return () => {
      stopPlayback();
      exitFullscreenClean();
    };
  }, [autoPlayUrl]);

  // Tell the Android shell to rotate to landscape and hide the system
  // navigation buttons while the player is fullscreen, and back to
  // portrait with normal system bars when it exits. Without this, the
  // in-app fullscreen button only stretches the player inside a portrait
  // WebView, so the video stays vertical and its controls sit under the
  // phone's navigation bar.
  function notifyAndroidFullscreen(enter: boolean) {
    try {
      (window as any).AndroidPlayer?.setFullscreen?.(enter);
    } catch {
      // ignore: running in a plain browser, no Android bridge
    }
  }

  useEffect(() => {
    const onFsChange = () => {
      const inFs = !!document.fullscreenElement;
      setIsLandscape(inFs);
      document.body.classList.toggle('landscape-mode', inFs);
      if (!inFs) notifyAndroidFullscreen(false);
    };
    // Dispatched by the Android shell when it hides a native fullscreen
    // view (e.g. system Back), so React state stays in sync.
    const onAndroidExit = () => {
      setIsLandscape(false);
      document.body.classList.remove('landscape-mode');
    };
    document.addEventListener('fullscreenchange', onFsChange);
    window.addEventListener('androidFullscreenExit', onAndroidExit);
    return () => {
      document.removeEventListener('fullscreenchange', onFsChange);
      window.removeEventListener('androidFullscreenExit', onAndroidExit);
    };
  }, []);

  function attachCueListener(track: any) {
    try {
      track.oncuechange = () => {
        if (!subtitlesOnRef.current) {
          setCurrentCueText('');
          return;
        }
        const cues = track.activeCues;
        if (cues && cues.length) {
          const text = Array.from(cues as any)
            .map((c: any) => cleanCueText(c.text || ''))
            .filter(Boolean)
            .join('\n');
          setCurrentCueText(text);
        } else {
          setCurrentCueText('');
        }
      };
    } catch {
      // ignore
    }
  }

  function enableEmbeddedSubtitles() {
    const v = videoRef.current;
    if (!v || !subtitlesOnRef.current) return;
    // If a separate subtitle file was loaded, it wins over the
    // embedded track, so embedded tracks stay disabled.
    if (externalTracksReadyRef.current) return;
    const list: any = v.textTracks;
    if (!list || list.length === 0) return;
    const tracks = Array.from(list as any);
    const subTracks = tracks.filter(
      (t: any) => t.kind === 'subtitles' || t.kind === 'captions' || !t.kind
    );
    if (!subTracks.length) return;
    let preferred = subTracks.findIndex(
      (t: any) =>
        /fa|per|fas/i.test(t.language || '') ||
        /فارسی|persian/i.test(t.label || '')
    );
    if (preferred < 0) preferred = 0;
    tracks.forEach((t: any) => {
      try {
        // 'hidden' (not 'showing') is deliberate: cues are then
        // available through cuechange for our own overlay, instead
        // of being rendered twice (browser cue + our overlay) or
        // being covered by the custom control bar.
        t.mode = t === subTracks[preferred] ? 'hidden' : 'disabled';
      } catch {
        // ignore
      }
    });
    setSubtitleTracks(
      subTracks.map((t: any) => ({
        label: t.label || t.language || 'زیرنویس',
        language: t.language || '',
      }))
    );
    attachCueListener(subTracks[preferred]);
  }

  // Second, guaranteed subtitle path: scan the MKV file itself in
  // JS over HTTP Range requests. This runs only if the native
  // MediaExtractor path and embedded tracks have produced nothing,
  // because it is the only path that does not depend on Chrome or
  // Android exposing the subtitle track.
  function startMkvSubtitleScan(url: string) {
    const clean = url.split('?')[0].split('#')[0].toLowerCase();
    if (!clean.endsWith('.mkv') && !clean.endsWith('.webm')) return;
    if (mkvJsStartedRef.current) return;
    mkvJsStartedRef.current = true;
    try {
      mkvAbortRef.current?.abort();
    } catch {
      // ignore
    }
    const controller = new AbortController();
    mkvAbortRef.current = controller;
    extractMkvSubtitles(
      url,
      (batch) => {
        if (!batch.length) return;
        nativeCuesRef.current.push(...batch);
        nativeSubsReadyRef.current = true;
        try {
          const v = videoRef.current;
          if (v) {
            Array.from(v.textTracks as any).forEach((t: any) => {
              try {
                t.mode = 'disabled';
              } catch {
                // ignore
              }
            });
          }
        } catch {
          // ignore
        }
        setSubtitleTracks([{ label: 'زیرنویس فارسی', language: 'fa' }]);
      },
      controller.signal
    ).catch(() => {
      // No subtitle track, CORS, or Range not supported: the
      // external-player buttons remain the fallback.
    });
  }

  function toggleSubtitles() {
    const next = !subtitlesOnRef.current;
    subtitlesOnRef.current = next;
    setSubtitlesOn(next);
    const v = videoRef.current;
    if (!v) return;
    if (!next) {
      setCurrentCueText('');
      try {
        Array.from(v.textTracks as any).forEach((t: any) => {
          try {
            t.mode = 'disabled';
          } catch {
            // ignore
          }
        });
      } catch {
        // ignore
      }
      return;
    }
    // Turning subtitles back on with nothing found yet: try the
    // JS MKV scan immediately instead of waiting for the fallback.
    if (!nativeSubsReadyRef.current && !externalTracksReadyRef.current) {
      const url = currentUrlRef.current;
      if (url) startMkvSubtitleScan(url);
    }
    if (externalTracksReadyRef.current) {
      try {
        externalTrackElsRef.current.forEach((el) => {
          if (el.track) (el.track as any).mode = 'hidden';
          attachCueListener(el.track);
        });
      } catch {
        // ignore
      }
    } else {
      enableEmbeddedSubtitles();
    }
    const hasAnyTrack =
      externalTracksReadyRef.current ||
      (v.textTracks && v.textTracks.length > 0);
    if (!hasAnyTrack) {
      // Only reached when the file really has no usable track.
      showToast('زیرنویسی در این فایل یافت نشد', 'error');
    }
  }

  // Separate subtitle files from the API (e.g. .srt/.ass alongside
  // the video): fetch, convert to WebVTT, attach as <track>.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    // Remove previous external tracks.
    externalTrackElsRef.current.forEach((el) => {
      try {
        el.remove();
      } catch {
        // ignore
      }
    });
    externalTrackElsRef.current = [];
    externalTracksReadyRef.current = false;
    if (!subtitleUrls.length) return;
    let cancelled = false;
    (async () => {
      for (const rawUrl of subtitleUrls) {
        if (cancelled) break;
        try {
          const res = await fetch(rawUrl, { mode: 'cors' });
          if (!res.ok) continue;
          const text = await res.text();
          const vtt = subtitleTextToVtt(text);
          if (!vtt) continue;
          const blob = new Blob([vtt], { type: 'text/vtt' });
          const blobUrl = URL.createObjectURL(blob);
          const trackEl = document.createElement('track');
          trackEl.kind = 'subtitles';
          trackEl.label = 'زیرنویس فارسی';
          trackEl.srclang = 'fa';
          trackEl.src = blobUrl;
          trackEl.addEventListener('load', () => {
            if (cancelled) return;
            try {
              (trackEl.track as any).mode = subtitlesOnRef.current
                ? 'hidden'
                : 'disabled';
            } catch {
              // ignore
            }
            attachCueListener(trackEl.track);
          });
          v.appendChild(trackEl);
          externalTrackElsRef.current.push(trackEl);
          externalTracksReadyRef.current = true;
          setSubtitleTracks([{ label: 'زیرنویس فارسی', language: 'fa' }]);
          // Disable embedded tracks so the two don't overlap.
          try {
            Array.from(v.textTracks as any).forEach((t: any) => {
              if (t !== trackEl.track) {
                try {
                  t.mode = 'disabled';
                } catch {
                  // ignore
                }
              }
            });
          } catch {
            // ignore
          }
          break; // first usable subtitle file is enough
        } catch {
          // try the next subtitle URL
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [subtitleUrls.join('|')]);

  // Native MKV subtitle cues from Android, sent in batches.
  useEffect(() => {
    (window as any).__onNativeSubtitles = (jsonStr: string, _isFinal: boolean) => {
      // If the JS MKV scan is already delivering cues, ignore the
      // native batches so the same subtitles are not duplicated.
      if (mkvJsStartedRef.current) return;
      try {
        const batch = JSON.parse(jsonStr || '[]');
        if (!Array.isArray(batch)) return;
        const cleaned = batch
          .map((c: any) => {
            let text = String(c.text || '');
            // ASS samples can arrive as a full Dialogue line.
            if (/^Dialogue:/i.test(text)) {
              const parts = text.slice('Dialogue:'.length).split(',');
              text = parts.length >= 10 ? parts.slice(9).join(',') : text;
            }
            return {
              start: Number(c.start) || 0,
              end: Number(c.end) || 0,
              text: cleanCueText(text),
            };
          })
          .filter((c: any) => c.text && c.end > c.start);
        if (!cleaned.length) return;
        nativeCuesRef.current.push(...cleaned);
        nativeSubsReadyRef.current = true;
        // Native cues win: disable browser tracks so they can't
        // double-render on top of the native overlay.
        try {
          const v = videoRef.current;
          if (v) {
            Array.from(v.textTracks as any).forEach((t: any) => {
              try {
                t.mode = 'disabled';
              } catch {
                // ignore
              }
            });
          }
        } catch {
          // ignore
        }
        setSubtitleTracks([{ label: 'زیرنویس فارسی', language: 'fa' }]);
      } catch {
        // ignore malformed batches
      }
    };
    return () => {
      try {
        delete (window as any).__onNativeSubtitles;
      } catch {
        // ignore
      }
    };
  }, []);

  // Embedded tracks can appear after metadata loads.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const list: any = v.textTracks;
    if (!list) return;
    const onAdd = () => enableEmbeddedSubtitles();
    try {
      list.addEventListener('addtrack', onAdd);
    } catch {
      // ignore
    }
    return () => {
      try {
        list.removeEventListener('addtrack', onAdd);
      } catch {
        // ignore
      }
    };
  }, []);

  function resetControlsTimer(playing = isPlaying) {
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    if (playing) {
      controlsTimerRef.current = setTimeout(() => {
        setControlsVisible(false);
        setFsQualityOpen(false);
      }, 2800);
    }
  }

  function showControls(persistent = false) {
    setControlsVisible(true);
    if (persistent) {
      if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    } else {
      resetControlsTimer();
    }
  }

  function hideControls() {
    setControlsVisible(false);
    setFsQualityOpen(false);
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
  }

  function beginPlayback(rawUrl: string, keepTime?: number) {
    const url = normalizeVideoUrl(rawUrl);
    if (!url || !videoRef.current) return;

    currentUrlRef.current = url;
    triedUrlsRef.current.add(url);
    intentionallyStoppedRef.current = false;

    setPlaybackError(null);
    setShowPrompt(false);
    setIsLoading(true);
    setFsQualityOpen(false);
    setCurrentCueText('');
    // Start native MKV subtitle extraction for this file. It runs
    // in the background and sends cues back in batches, so the
    // player does not wait for it.
    nativeCuesRef.current = [];
    nativeSubsReadyRef.current = false;
    mkvJsStartedRef.current = false;
    try {
      mkvAbortRef.current?.abort();
    } catch {
      // ignore
    }
    if (mkvFallbackTimerRef.current) clearTimeout(mkvFallbackTimerRef.current);
    try {
      (window as any).AndroidPlayer?.extractSubtitles?.(url);
    } catch {
      // ignore: plain browser, no Android bridge
    }
    // Fallback: if neither the native extractor nor embedded
    // tracks have produced a subtitle cue after 8 seconds, scan
    // the MKV file directly in JS.
    mkvFallbackTimerRef.current = setTimeout(() => {
      if (!nativeSubsReadyRef.current && !externalTracksReadyRef.current) {
        startMkvSubtitleScan(url);
      }
    }, 8000);

    const v = videoRef.current;
    try {
      v.src = url;
      v.load();
    } catch {
      setIsLoading(false);
      setPlaybackError({ url, kind: 'error' });
      return;
    }

    if (watchdogRef.current) clearTimeout(watchdogRef.current);
    watchdogRef.current = setTimeout(() => {
      if (v && v.readyState === 0 && !intentionallyStoppedRef.current) {
        handleFailure(url, 'timeout');
      }
    }, 40000);

    v.oncanplay = () => {
      if (watchdogRef.current) clearTimeout(watchdogRef.current);
      setIsLoading(false);
      if (keepTime && keepTime > 0) {
        try {
          v.currentTime = keepTime;
        } catch {
          // ignore
        }
      }
      v.play().catch(() => {});
      showControls();
      v.oncanplay = null;
    };
  }

  function handleFailure(url: string, kind: 'timeout' | 'error') {
    if (watchdogRef.current) clearTimeout(watchdogRef.current);
    if (intentionallyStoppedRef.current) return;

    const alt = sources.find((s) => {
      if (!s.url || triedUrlsRef.current.has(s.url)) return false;
      const sc = typeof s.score === 'number' ? s.score : scoreVideoUrl(s.url);
      return sc >= 30;
    });

    if (alt && fallbackCountRef.current < 2) {
      fallbackCountRef.current += 1;
      const altIdx = sources.indexOf(alt);
      onSwitchInlineQuality(altIdx, alt);
      showToast('در حال تلاش خودکار با لینک جایگزین…', 'success');
      beginPlayback(alt.url);
      return;
    }

    setIsLoading(false);
    setPlaybackError({ url: url || currentUrlRef.current, kind });
  }

  function stopPlayback() {
    if (watchdogRef.current) clearTimeout(watchdogRef.current);
    if (mkvFallbackTimerRef.current) clearTimeout(mkvFallbackTimerRef.current);
    try {
      mkvAbortRef.current?.abort();
    } catch {
      // ignore
    }
    intentionallyStoppedRef.current = true;
    const v = videoRef.current;
    if (v) {
      v.pause();
      v.removeAttribute('src');
      v.load();
    }
    setIsPlaying(false);
    setIsLoading(false);
  }

  function handleTapZone() {
    tapCountRef.current += 1;
    if (tapTimerRef.current) clearTimeout(tapTimerRef.current);

    if (tapCountRef.current === 1) {
      tapTimerRef.current = setTimeout(() => {
        tapCountRef.current = 0;
        setFsQualityOpen(false);
        showControls();
      }, 260);
    } else {
      tapCountRef.current = 0;
      hideControls();
      setHideFlash(true);
      setTimeout(() => setHideFlash(false), 620);
    }
  }

  function togglePlayPause() {
    const v = videoRef.current;
    if (!v || !v.currentSrc) return;
    if (v.paused) {
      v.play().catch(() => {});
    } else {
      v.pause();
    }
    showControls();
  }

  function seekBy(delta: number, side: 'left' | 'right') {
    const v = videoRef.current;
    if (!v || !v.duration || isNaN(v.duration)) {
      showToast('ویدئو هنوز آماده نیست', 'error');
      return;
    }
    v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + delta));
    // No on-video seek toast on purpose: the user asked for the
    // "X seconds forward/back" popup to never be shown at all.
    showControls();
  }

  function cycleSpeed() {
    const nextIdx = (speedIdx + 1) % SPEED_STEPS.length;
    setSpeedIdx(nextIdx);
    const rate = SPEED_STEPS[nextIdx];
    if (videoRef.current) {
      try {
        videoRef.current.playbackRate = rate;
      } catch {
        // ignore
      }
    }
    showToast(`⚡ سرعت پخش: ${rate}x`, 'success');
    showControls();
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement && !isLandscape) {
      // Android bridge first: this rotates the whole activity to
      // landscape and hides the system bars. requestFullscreen alone
      // inside a WebView leaves the activity portrait, which is why
      // the video stayed vertical before.
      notifyAndroidFullscreen(true);
      try {
        wrapperRef.current?.requestFullscreen?.();
      } catch {
        // ignore
      }
      setIsLandscape(true);
      document.body.classList.add('landscape-mode');
      try {
        (screen.orientation as any)?.lock?.('landscape')?.catch(() => {});
      } catch {
        // ignore
      }
    } else {
      exitFullscreenClean();
    }
    showControls();
  }

  function exitFullscreenClean() {
    try {
      if (document.fullscreenElement) document.exitFullscreen?.();
    } catch {
      // ignore
    }
    notifyAndroidFullscreen(false);
    setIsLandscape(false);
    document.body.classList.remove('landscape-mode');
    try {
      (screen.orientation as any)?.unlock?.();
    } catch {
      // ignore
    }
  }

  function getClientPct(clientX: number): number {
    if (!seekBarRef.current) return 0;
    const rect = seekBarRef.current.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }

  const displayedPct = isDragging
    ? dragPct * 100
    : duration > 0
    ? (currentTime / duration) * 100
    : 0;

  async function handleCopyAllMovieLinks() {
    const urls = sources.map((s) => s.url).filter(Boolean);
    if (!urls.length) return;
    const ok = await copyText(urls.join('\n'));
    showToast(
      ok ? `✅ همه ${urls.length} لینک فیلم کپی شد` : '❌ خطا در کپی لینک‌ها',
      ok ? 'success' : 'error'
    );
  }

  // In the APK, the native player (libVLC/ExoPlayer) is the player,
  // so this screen is only a quality picker: the old HTML <video>
  // player section above the quality list is removed here, and
  // only a header with a back arrow + "کیفیت رو انتخاب کن" plus
  // the quality buttons below are shown. Qualities, watched
  // marks, copy-all-links and the player-choice modal are kept
  // exactly as before. In a plain browser (no Android bridge)
  // the old HTML player below is still used as a fallback.
  const isNativeApp =
    typeof window !== 'undefined' &&
    typeof (window as any).AndroidPlayer?.playNative === 'function';
  if (isNativeApp) {
    return (
      <div className="p-4 pb-8" style={{ background: 'var(--bg)' }}>
        <div className="max-w-4xl mx-auto">
          <div className="flex items-center gap-3 mb-5">
            <button
              onClick={onExit}
              className="w-11 h-11 rounded-full flex items-center justify-center shrink-0 cursor-pointer active:scale-95 transition-transform"
              style={{
                background: 'var(--surface-2)',
                border: '1px solid var(--border)',
                color: 'var(--text)',
              }}
              title="بازگشت"
            >
              <ChevronRight className="w-6 h-6" />
            </button>
            <h2
              className="text-lg sm:text-xl font-extrabold"
              style={{ color: 'var(--text)' }}
            >
              کیفیت رو انتخاب کن
            </h2>
          </div>

          <div className="flex items-center justify-between flex-wrap gap-2 pb-3 mb-3 border-b" style={{ borderColor: 'var(--border)' }}>
            <h3 className="text-base font-extrabold flex items-center gap-2" style={{ color: 'var(--text)' }}>
              <Settings className="w-5 h-5" style={{ color: 'var(--accent)' }} />
              <span>انتخاب کیفیت پخش {autoPlayQuality ? `(${autoPlayQuality})` : ''}</span>
            </h3>
            {sources.length > 1 && (
              <button
                onClick={handleCopyAllMovieLinks}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-extrabold cursor-pointer transition-transform active:scale-95"
                style={{
                  background: 'rgba(123, 104, 238, 0.16)',
                  border: '1px solid rgba(123, 104, 238, 0.35)',
                  color: 'var(--primary-bright)',
                }}
              >
                <Copy className="w-3.5 h-3.5" />
                <span>کپی همه لینک‌ها ({sources.length})</span>
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {sources.map((s, i) => {
              const ext = getFileExt(s.url);
              const isWatched = !!watchedData.movies[`${movieId}::movie::${s.quality}`];
              const isActive = i === activeSourceIndex;
              return (
                <button
                  key={i}
                  onClick={() => onSelectQualityOption(i, s)}
                  className="flex items-center gap-3 p-3.5 rounded-2xl text-right transition-all active:scale-98 cursor-pointer"
                  style={{
                    background: isActive
                      ? 'linear-gradient(135deg, rgba(123,104,238,0.20), rgba(168,139,250,0.08))'
                      : 'var(--surface)',
                    border: isActive
                      ? '1.5px solid var(--primary)'
                      : isWatched
                      ? '1.5px solid rgba(50, 215, 75, 0.45)'
                      : '1.5px solid var(--border)',
                  }}
                >
                  <div
                    className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
                    style={{
                      background: isActive
                        ? 'linear-gradient(135deg, var(--primary), var(--accent))'
                        : isWatched
                        ? 'rgba(50, 215, 75, 0.2)'
                        : 'var(--surface-2)',
                      color: isActive ? '#fff' : isWatched ? '#32D74B' : 'var(--secondary)',
                    }}
                  >
                    {isWatched ? (
                      <Check className="w-5 h-5 stroke-[3]" />
                    ) : (
                      <Play className="w-5 h-5 fill-current" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div
                      dir="ltr"
                      className="font-extrabold text-sm flex items-center gap-2 flex-wrap"
                      style={{ color: 'var(--text)' }}
                    >
                      <span>{s.quality}</span>
                      {ext && (
                        <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-gray-300 uppercase">
                          {ext}
                        </span>
                      )}
                      {isWatched && (
                        <span
                          dir="rtl"
                          className="text-[10px] font-extrabold text-emerald-400 bg-emerald-500/15 px-2 py-0.5 rounded-md"
                        >
                          ✓ دیده شده
                        </span>
                      )}
                    </div>
                    {s.size && (
                      <div
                        dir="ltr"
                        className="text-xs font-semibold text-left"
                        style={{ color: 'var(--secondary)' }}
                      >
                        {s.size}
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col select-none">
      {/* Top Bar (when not in landscape fullscreen) */}
      {!isLandscape && (
        <div
          className="w-full px-4 py-3 flex items-center justify-between gap-3 relative z-30"
          style={{
            background: 'linear-gradient(180deg, rgba(0,0,0,0.92), transparent)',
          }}
        >
          <button
            onClick={() => {
              stopPlayback();
              exitFullscreenClean();
              onExit();
            }}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-xs sm:text-sm font-extrabold text-white backdrop-blur-xl active:scale-95 transition-transform cursor-pointer shrink-0"
            style={{
              background: 'rgba(255, 69, 58, 0.28)',
              border: '1px solid rgba(255, 69, 58, 0.55)',
            }}
          >
            <X className="w-4 h-4" />
            <span>خروج</span>
          </button>

          <div
            dir="ltr"
            className="text-white font-bold text-xs sm:text-sm truncate flex-1 text-left"
          >
            {movieTitle}
          </div>

          <button
            onClick={toggleFullscreen}
            title="تمام‌صفحه و افقی"
            className="w-10 h-10 rounded-xl flex items-center justify-center text-white shadow-lg active:scale-90 transition-transform cursor-pointer shrink-0"
            style={{
              background: 'linear-gradient(135deg, var(--primary), var(--accent))',
            }}
          >
            <Maximize2 className="w-5 h-5" />
          </button>
        </div>
      )}

      {/* Video Wrapper */}
      <div
        ref={wrapperRef}
        className="relative w-full bg-black flex items-center justify-center overflow-hidden grow"
      >
        <video
          ref={videoRef}
          playsInline
          controlsList="nodownload"
          onContextMenu={(e) => e.preventDefault()}
          onPlay={() => {
            setIsPlaying(true);
            resetControlsTimer(true);
          }}
          onPause={() => {
            setIsPlaying(false);
            showControls(true);
          }}
          onWaiting={() => {
            if (!playbackError) setIsLoading(true);
          }}
          onPlaying={() => {
            if (watchdogRef.current) clearTimeout(watchdogRef.current);
            setIsLoading(false);
            enableEmbeddedSubtitles();
          }}
          onLoadedMetadata={(e) => {
            if (watchdogRef.current) clearTimeout(watchdogRef.current);
            setDuration((e.currentTarget as HTMLVideoElement).duration || 0);
            enableEmbeddedSubtitles();
            // Embedded tracks in MKV sometimes appear a moment
            // after metadata, so check again shortly after.
            setTimeout(() => enableEmbeddedSubtitles(), 800);
          }}
          onTimeUpdate={(e) => {
            const v = e.currentTarget as HTMLVideoElement;
            setCurrentTime(v.currentTime || 0);
            // Native MKV cues: render the cue covering currentTime.
            if (nativeSubsReadyRef.current && subtitlesOnRef.current) {
              const t = v.currentTime || 0;
              const cue = nativeCuesRef.current.find(
                (c) => t >= c.start && t < c.end
              );
              const text = cue ? cue.text : '';
              setCurrentCueText((prev) => (prev === text ? prev : text));
            }
            if (v.duration && v.buffered && v.buffered.length > 0) {
              const end = v.buffered.end(v.buffered.length - 1);
              setBufferedPct(Math.min(100, (end / v.duration) * 100));
            }
          }}
          onError={() => {
            if (intentionallyStoppedRef.current) return;
            const src = videoRef.current?.currentSrc || currentUrlRef.current;
            if (src) handleFailure(src, 'error');
          }}
          className="w-full h-full max-h-screen object-contain bg-black"
        />

        {/* Fullscreen Landscape Top Bar */}
        {isLandscape && (
          <div
            className={`absolute top-0 left-0 right-0 z-20 flex items-center justify-between gap-3 px-4 py-3 transition-all duration-300 ${
              controlsVisible
                ? 'opacity-100 translate-y-0'
                : 'opacity-0 -translate-y-4 pointer-events-none'
            }`}
            style={{
              background:
                'linear-gradient(to bottom, rgba(0,0,0,0.9), rgba(0,0,0,0.4) 60%, transparent)',
              paddingTop: 'calc(0.75rem + env(safe-area-inset-top, 0px))',
            }}
          >
            <button
              onClick={() => {
                stopPlayback();
                exitFullscreenClean();
                onExit();
              }}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-xs font-extrabold text-white"
              style={{
                background: 'rgba(255,69,58,0.32)',
                border: '1px solid rgba(255,69,58,0.55)',
              }}
            >
              <X className="w-4 h-4" />
              <span>خروج</span>
            </button>

            <div dir="ltr" className="text-white font-extrabold text-xs truncate flex-1 text-center">
              {movieTitle}
            </div>

            <button
              onClick={exitFullscreenClean}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full text-xs font-extrabold text-white"
              style={{
                background: 'linear-gradient(135deg, #FF9F0A, #FF7B00)',
              }}
            >
              <Minimize2 className="w-4 h-4" />
              <span>کوچک‌نمایی</span>
            </button>
          </div>
        )}

        {/* Touch Zones (1 tap = show controls, 2 taps = hide controls) */}
        <div onClick={handleTapZone} className="absolute inset-0 z-10 cursor-pointer" />

        {/* Center Big Play/Pause Button */}
        {!showPrompt && !playbackError && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              togglePlayPause();
            }}
            className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-20 w-20 h-20 rounded-full flex items-center justify-center text-white backdrop-blur-xl border border-white/20 shadow-2xl transition-all duration-300 cursor-pointer ${
              controlsVisible
                ? 'opacity-100 scale-100'
                : 'opacity-0 scale-50 pointer-events-none'
            }`}
            style={{
              background: 'rgba(12, 12, 18, 0.55)',
              boxShadow: '0 14px 44px rgba(0,0,0,0.6), 0 0 40px rgba(123,104,238,0.35)',
            }}
          >
            {isPlaying ? (
              <Pause className="w-9 h-9 fill-current" />
            ) : (
              <Play className="w-9 h-9 fill-current ml-1" />
            )}
          </button>
        )}

        {/* Subtitle Overlay (from embedded MKV tracks or a separate
            subtitle file). Rendered by us, not by the browser's ::cue,
            so it sits above the control bar instead of under it. */}
        {subtitlesOn && currentCueText && !showPrompt && !playbackError && (
          <div
            className="absolute left-0 right-0 z-20 pointer-events-none flex justify-center px-4"
            style={{ bottom: controlsVisible ? '9.5rem' : '2rem' }}
          >
            <div
              dir="rtl"
              className="text-center text-white font-extrabold leading-8 px-4 py-1.5 rounded-xl max-w-3xl"
              style={{
                background: 'rgba(0,0,0,0.65)',
                textShadow: '0 2px 8px rgba(0,0,0,0.9)',
                fontSize: '1.05rem',
              }}
            >
              {currentCueText.split('\n').map((line, i) => (
                <span key={i}>
                  {line}
                  <br />
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Double-Tap Hide Flash Indicator */}
        {hideFlash && (
          <div className="absolute inset-0 z-20 pointer-events-none flex items-center justify-center">
            <div className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-black/75 border border-white/15 text-white text-xs font-extrabold shadow-xl">
              <EyeOff className="w-4 h-4 text-purple-400" />
              <span>حالت سینمایی</span>
            </div>
          </div>
        )}

        {/* Initial Prompt when no quality is selected yet */}
        {showPrompt && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/85 backdrop-blur-md p-6 text-center gap-3">
            <div
              className="w-16 h-16 rounded-full flex items-center justify-center border"
              style={{
                background:
                  'linear-gradient(135deg, rgba(123,104,238,0.25), rgba(168,139,250,0.15))',
                borderColor: 'rgba(123,104,238,0.4)',
              }}
            >
              <Play className="w-8 h-8 text-purple-300 fill-current" />
            </div>
            <p className="text-base sm:text-lg font-extrabold text-white">
              ابتدا کیفیت مورد نظر را از پنل پایین انتخاب کنید
            </p>
          </div>
        )}

        {/* Cinematic Buffering Loader */}
        {isLoading && !playbackError && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/80 backdrop-blur-md gap-3">
            <div
              className="w-11 h-11 rounded-full border-3 border-transparent animate-spin"
              style={{
                borderTopColor: 'var(--accent)',
                borderBottomColor: 'var(--primary)',
              }}
            />
            <div className="text-xs font-extrabold tracking-widest text-purple-300">
              در حال بارگذاری ویدئو…
            </div>
          </div>
        )}

        {/* Playback Error Recovery Panel */}
        {playbackError && (
          <div className="absolute inset-0 z-30 bg-black/95 backdrop-blur-xl flex items-center justify-center p-4 overflow-y-auto">
            <div className="w-full max-w-md flex flex-col items-center text-center gap-3">
              <div className="w-16 h-16 rounded-full flex items-center justify-center text-2xl bg-purple-500/20 border border-purple-500/40">
                🎬
              </div>
              <h3 className="text-base font-black text-white">
                {playbackError.kind === 'timeout'
                  ? 'بارگذاری بیش از حد طول کشید'
                  : 'پخش مستقیم در مرورگر انجام نشد'}
              </h3>
              <p className="text-xs text-gray-300 leading-6">
                برخی فرمت‌های ویدئویی مانند <b>{(getFileExt(playbackError.url) || 'MKV').toUpperCase()}</b>{' '}
                بهترین کیفیت را در پلیرهای خارجی (MX Player یا VLC) دارند. می‌توانید تلاش مجدد
                بزنید یا مستقیماً در پلیر باز کنید:
              </p>

              <div className="grid grid-cols-2 gap-2 w-full mt-2">
                <button
                  onClick={() => beginPlayback(playbackError.url)}
                  className="col-span-2 py-3 px-4 rounded-xl font-extrabold text-sm text-white flex items-center justify-center gap-2 cursor-pointer"
                  style={{
                    background: 'linear-gradient(135deg, var(--primary), var(--accent))',
                  }}
                >
                  <RefreshCw className="w-4 h-4" />
                  <span>تلاش مجدد</span>
                </button>
                <button
                  onClick={async () => {
                    const ok = await copyText(playbackError.url);
                    showToast(ok ? '✅ لینک کپی شد' : '❌ خطا در کپی', ok ? 'success' : 'error');
                  }}
                  className="py-2.5 px-3 rounded-xl font-bold text-xs bg-white/10 text-white border border-white/10 cursor-pointer"
                >
                  کپی لینک
                </button>
                <button
                  onClick={() => openInExternalApp(playbackError.url, null)}
                  className="py-2.5 px-3 rounded-xl font-bold text-xs bg-white/10 text-white border border-white/10 cursor-pointer"
                >
                  باز کردن مستقیم
                </button>
                <button
                  onClick={() =>
                    openInExternalApp(playbackError.url, 'com.mxtech.videoplayer.ad')
                  }
                  className="py-2.5 px-3 rounded-xl font-bold text-xs bg-sky-500/20 text-sky-300 border border-sky-500/30 cursor-pointer"
                >
                  MX Player
                </button>
                <button
                  onClick={() => openInExternalApp(playbackError.url, 'org.videolan.vlc')}
                  className="py-2.5 px-3 rounded-xl font-bold text-xs bg-amber-500/20 text-amber-300 border border-amber-500/30 cursor-pointer"
                >
                  VLC Player
                </button>
              </div>
            </div>
          </div>
        )}

        {/* In-Player Quality Switch Drawer */}
        {fsQualityOpen && (
          <div
            onClick={(e) => e.stopPropagation()}
            className="absolute bottom-0 left-0 right-0 z-30 max-h-[65%] overflow-y-auto p-4 bg-black/95 backdrop-blur-2xl border-t border-purple-400/30 rounded-t-3xl"
          >
            <div className="flex items-center justify-between pb-3 mb-3 border-b border-white/10">
              <h4 className="text-sm font-black text-white flex items-center gap-2">
                <Settings className="w-4 h-4 text-purple-400" />
                <span>تغییر کیفیت پخش</span>
              </h4>
              <button
                onClick={() => setFsQualityOpen(false)}
                className="w-8 h-8 rounded-full bg-white/10 text-white flex items-center justify-center"
              >
                ✕
              </button>
            </div>
            <div className="flex flex-col gap-2">
              {sources.map((s, i) => (
                <button
                  key={i}
                  onClick={() => {
                    setFsQualityOpen(false);
                    if (i !== activeSourceIndex) {
                      const curT = videoRef.current?.currentTime || 0;
                      onSwitchInlineQuality(i, s);
                      beginPlayback(s.url, curT);
                      showToast(`✅ کیفیت تغییر کرد به: ${s.quality}`, 'success');
                    }
                  }}
                  className="flex items-center justify-between p-3 rounded-xl border text-white text-xs font-extrabold cursor-pointer"
                  style={{
                    background:
                      i === activeSourceIndex
                        ? 'rgba(123,104,238,0.28)'
                        : 'rgba(255,255,255,0.05)',
                    borderColor:
                      i === activeSourceIndex
                        ? 'var(--primary)'
                        : 'rgba(255,255,255,0.1)',
                  }}
                >
                  <span dir="ltr">{s.quality}</span>
                  <span>{s.size || ''}</span>
                  {i === activeSourceIndex && (
                    <span className="w-5 h-5 rounded-full bg-purple-500 text-white flex items-center justify-center">
                      ✓
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Bottom Controls Bar */}
        <div
          onClick={(e) => e.stopPropagation()}
          className={`absolute bottom-0 left-0 right-0 z-20 px-3 sm:px-5 pt-8 pb-3 transition-all duration-300 ${
            controlsVisible
              ? 'opacity-100 translate-y-0'
              : 'opacity-0 translate-y-5 pointer-events-none'
          }`}
          style={{
            background:
              'linear-gradient(to top, rgba(0,0,0,0.95) 0%, rgba(0,0,0,0.72) 50%, transparent 100%)',
            // Keep the controls clear of the phone's navigation bar /
            // gesture area when it is visible (e.g. manual rotation).
            paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom, 0px))',
            paddingLeft: 'max(0.75rem, env(safe-area-inset-left, 0px))',
            paddingRight: 'max(0.75rem, env(safe-area-inset-right, 0px))',
          }}
        >
          {/* Seek Bar: a tall touch target (py-3) with a thicker
              bar and a bigger thumb, so it is easy to grab and drag
              with a finger. Pointer events unify mouse and touch,
              and touchAction none stops the browser from scrolling
              or swiping while dragging. */}
          <div
            ref={seekBarRef}
            dir="ltr"
            style={{ touchAction: 'none' }}
            onPointerDown={(e) => {
              if (!duration) return;
              try {
                (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
              } catch {
                // ignore
              }
              setIsDragging(true);
              const pct = getClientPct(e.clientX);
              setDragPct(pct);
              setTooltipPct(pct);
            }}
            onPointerMove={(e) => {
              const pct = getClientPct(e.clientX);
              setTooltipPct(pct);
              if (isDragging) setDragPct(pct);
            }}
            onPointerUp={(e) => {
              if (!isDragging) return;
              const pct = getClientPct(e.clientX);
              setIsDragging(false);
              setTooltipPct(null);
              if (videoRef.current && duration) {
                videoRef.current.currentTime = pct * duration;
              }
            }}
            onPointerCancel={() => {
              setIsDragging(false);
              setTooltipPct(null);
            }}
            onPointerLeave={() => {
              if (!isDragging) setTooltipPct(null);
            }}
            className="relative py-3 cursor-pointer mb-1"
          >
            <div
              className={`relative rounded-full bg-white/20 transition-all ${
                isDragging ? 'h-3' : 'h-2.5'
              }`}
            >
              {/* Buffered */}
              <div
                className="absolute top-0 left-0 h-full bg-white/25 rounded-full pointer-events-none"
                style={{ width: `${bufferedPct}%` }}
              />
              {/* Progress */}
              <div
                className="absolute top-0 left-0 h-full rounded-full pointer-events-none"
                style={{
                  width: `${displayedPct}%`,
                  background: 'linear-gradient(90deg, #6D5AE0, #9370FF, #C084FC)',
                }}
              />
              {/* Thumb */}
              <div
                className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-full shadow-lg pointer-events-none border-2 border-purple-400 ${
                  isDragging ? 'w-6 h-6' : 'w-5 h-5'
                }`}
                style={{ left: `${displayedPct}%` }}
              />
            </div>
            {/* Tooltip while hovering, and a big time bubble while dragging */}
            {tooltipPct !== null && duration > 0 && (
              <div
                className={`absolute -translate-x-1/2 px-2.5 py-1 rounded-lg bg-black/90 border border-purple-400/40 text-white font-mono pointer-events-none whitespace-nowrap ${
                  isDragging ? 'bottom-10 text-sm font-bold' : 'bottom-8 text-[11px]'
                }`}
                style={{ left: `${tooltipPct * 100}%` }}
              >
                {formatTime(tooltipPct * duration)}
              </div>
            )}
          </div>

          {/* Controls Buttons Row: wraps on narrow phones instead
              of overflowing, which is what cut the fullscreen
              button in half after the CC button was added. */}
          <div dir="ltr" className="flex items-center justify-between gap-1.5 flex-wrap">
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                onClick={togglePlayPause}
                className="w-9 h-9 rounded-full flex items-center justify-center text-white shadow-lg cursor-pointer shrink-0"
                style={{
                  background: 'linear-gradient(135deg, var(--primary), var(--accent))',
                }}
              >
                {isPlaying ? (
                  <Pause className="w-4 h-4 fill-current" />
                ) : (
                  <Play className="w-4 h-4 fill-current ml-0.5" />
                )}
              </button>

              <button
                onClick={() => seekBy(-10, 'left')}
                className="w-8 h-8 rounded-full bg-white/10 border border-white/15 text-white text-[11px] font-bold flex items-center justify-center cursor-pointer shrink-0"
                title="۱۰ ثانیه عقب"
              >
                -10
              </button>

              <button
                onClick={() => seekBy(10, 'right')}
                className="w-8 h-8 rounded-full bg-white/10 border border-white/15 text-white text-[11px] font-bold flex items-center justify-center cursor-pointer shrink-0"
                title="۱۰ ثانیه جلو"
              >
                +10
              </button>

              <div className="px-2 py-1 rounded-lg bg-black/55 border border-white/10 text-white font-mono text-[11px] tabular-nums shrink-0">
                <span className="text-purple-300 font-bold">{formatTime(currentTime)}</span> /{' '}
                <span>{formatTime(duration)}</span>
              </div>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              <button
                onClick={cycleSpeed}
                className="px-2 h-8 rounded-full bg-white/10 border border-white/15 text-white font-mono text-xs font-extrabold cursor-pointer shrink-0"
              >
                {SPEED_STEPS[speedIdx]}x
              </button>

              <button
                onClick={toggleSubtitles}
                className="px-2 h-8 rounded-full border text-white font-mono text-xs font-extrabold cursor-pointer shrink-0"
                style={{
                  background: subtitlesOn
                    ? 'rgba(123,104,238,0.35)'
                    : 'rgba(255,255,255,0.10)',
                  borderColor: subtitlesOn
                    ? 'var(--primary)'
                    : 'rgba(255,255,255,0.15)',
                }}
                title={subtitlesOn ? 'خاموش کردن زیرنویس' : 'روشن کردن زیرنویس'}
              >
                CC
              </button>

              <button
                onClick={() => setFsQualityOpen((prev) => !prev)}
                className="w-8 h-8 rounded-full bg-white/10 border border-white/15 text-white flex items-center justify-center cursor-pointer shrink-0"
                title="تغییر کیفیت"
              >
                <Settings className="w-4 h-4" />
              </button>

              <button
                onClick={toggleFullscreen}
                className="w-9 h-9 rounded-full flex items-center justify-center text-white shadow-lg cursor-pointer shrink-0"
                style={{
                  background: 'linear-gradient(135deg, #FF9F0A, #FF7B00)',
                }}
                title="تمام‌صفحه"
              >
                <Maximize2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom Quality Selector Panel (visible when not in landscape fullscreen) */}
      {!isLandscape && (
        <div
          className="grow overflow-y-auto p-4 border-t"
          style={{
            background: 'var(--bg)',
            borderColor: 'var(--border)',
          }}
        >
          <div className="max-w-4xl mx-auto">
            <div className="flex items-center justify-between flex-wrap gap-2 pb-3 mb-3 border-b" style={{ borderColor: 'var(--border)' }}>
              <h3 className="text-base font-extrabold flex items-center gap-2" style={{ color: 'var(--text)' }}>
                <Settings className="w-5 h-5" style={{ color: 'var(--accent)' }} />
                <span>انتخاب کیفیت پخش {autoPlayQuality ? `(${autoPlayQuality})` : ''}</span>
              </h3>
              {sources.length > 1 && (
                <button
                  onClick={handleCopyAllMovieLinks}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-extrabold cursor-pointer transition-transform active:scale-95"
                  style={{
                    background: 'rgba(123, 104, 238, 0.16)',
                    border: '1px solid rgba(123, 104, 238, 0.35)',
                    color: 'var(--primary-bright)',
                  }}
                >
                  <Copy className="w-3.5 h-3.5" />
                  <span>کپی همه لینک‌ها ({sources.length})</span>
                </button>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {sources.map((s, i) => {
                const ext = getFileExt(s.url);
                const isWatched = !!watchedData.movies[`${movieId}::movie::${s.quality}`];
                const isActive = i === activeSourceIndex;

                return (
                  <button
                    key={i}
                    onClick={() => onSelectQualityOption(i, s)}
                    className="flex items-center gap-3 p-3.5 rounded-2xl text-right transition-all active:scale-98 cursor-pointer"
                    style={{
                      background: isActive
                        ? 'linear-gradient(135deg, rgba(123,104,238,0.20), rgba(168,139,250,0.08))'
                        : 'var(--surface)',
                      border: isActive
                        ? '1.5px solid var(--primary)'
                        : isWatched
                        ? '1.5px solid rgba(50, 215, 75, 0.45)'
                        : '1.5px solid var(--border)',
                    }}
                  >
                    <div
                      className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
                      style={{
                        background: isActive
                          ? 'linear-gradient(135deg, var(--primary), var(--accent))'
                          : isWatched
                          ? 'rgba(50, 215, 75, 0.2)'
                          : 'var(--surface-2)',
                        color: isActive ? '#fff' : isWatched ? '#32D74B' : 'var(--secondary)',
                      }}
                    >
                      {isWatched ? (
                        <Check className="w-5 h-5 stroke-[3]" />
                      ) : (
                        <Play className="w-5 h-5 fill-current" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div
                        dir="ltr"
                        className="font-extrabold text-sm flex items-center gap-2 flex-wrap"
                        style={{ color: 'var(--text)' }}
                      >
                        <span>{s.quality}</span>
                        {ext && (
                          <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-gray-300 uppercase">
                            {ext}
                          </span>
                        )}
                        {isWatched && (
                          <span
                            dir="rtl"
                            className="text-[10px] font-extrabold text-emerald-400 bg-emerald-500/15 px-2 py-0.5 rounded-md"
                          >
                            ✓ دیده شده
                          </span>
                        )}
                      </div>
                      {s.size && (
                        <div
                          dir="ltr"
                          className="text-xs font-semibold text-left"
                          style={{ color: 'var(--secondary)' }}
                        >
                          {s.size}
                        </div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
