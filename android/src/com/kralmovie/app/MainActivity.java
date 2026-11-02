package com.kralmovie.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import java.net.NetworkInterface;
import java.nio.ByteBuffer;
import java.util.Collections;
import org.json.JSONArray;
import org.json.JSONObject;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.app.DownloadManager;
import android.content.ContentValues;
import android.content.SharedPreferences;
import android.provider.MediaStore;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import android.database.Cursor;
import android.os.Environment;
import android.widget.FrameLayout;

public class MainActivity extends Activity {
    private WebView webView;
    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;
    private FrameLayout fullscreenContainer;
    private boolean isPlayerFullscreen = false;

    // ---------- Direct in-app downloader (v1.28) ----------
    // The user is right: the system DownloadManager / browser
    // download does NOT work against this CDN — it stalls at 0%.
    // The in-app VLC player DOES work, because it sends the
    // WebView User-Agent. So downloads now use the exact same
    // request as playback: HttpURLConnection with the WebView UA,
    // writing straight to Downloads/KRALMOVIE, with live progress
    // in memory. No browser, no system DownloadManager for new
    // downloads. Old system downloads are still listed / deletable
    // for backward compatibility, but new enqueues never use them.
    private static class DirectState {
        long id;
        String url, title, type, label, quality, fileName, folder, fileUri;
        volatile long downloaded, total;
        volatile String status; // downloading, successful, failed
        volatile int reason;
        volatile boolean cancelled;
        volatile Thread thread;
        long lastUpdate;
        int segCount;
        long[] segDownloaded;
        // v1.40: chunk queue — segCount/segDownloaded now mean
        // chunkCount/chunkDownloaded (small 1-2 MB chunks).
        // segClaimed is transient (not saved): which chunks a
        // worker is currently downloading.
        boolean[] segClaimed;
        volatile boolean stopWorkers;
    }
    private final ConcurrentHashMap<Long, DirectState> directMap = new ConcurrentHashMap<>();
    private final AtomicLong directIdSeq = new AtomicLong(2000000000L);

    private String directMimeFor(String fileName) {
        String lower = fileName == null ? "" : fileName.toLowerCase();
        if (lower.endsWith(".mkv")) return "video/x-matroska";
        if (lower.endsWith(".webm")) return "video/webm";
        if (lower.endsWith(".mov")) return "video/quicktime";
        return "video/mp4";
    }

    private void directSavePrefs(DirectState st) {
        try {
            JSONObject meta = new JSONObject();
            meta.put("title", st.title == null ? "" : st.title);
            meta.put("type", st.type == null ? "movie" : st.type);
            meta.put("label", st.label == null ? "" : st.label);
            meta.put("quality", st.quality == null ? "" : st.quality);
            meta.put("fileName", st.fileName == null ? "" : st.fileName);
            meta.put("folder", st.folder == null ? "" : st.folder);
            meta.put("fileUri", st.fileUri == null ? "" : st.fileUri);
            meta.put("url", st.url == null ? "" : st.url);
            meta.put("lastUpdate", System.currentTimeMillis());
            meta.put("status", st.status == null ? "downloading" : st.status);
            meta.put("downloaded", st.downloaded);
            meta.put("total", st.total);
            meta.put("reason", st.reason);
            meta.put("segCount", st.segCount);
            if (st.segDownloaded != null) {
                org.json.JSONArray segArr = new org.json.JSONArray();
                for (long v : st.segDownloaded) segArr.put(v);
                meta.put("segments", segArr);
            }
            getSharedPreferences("kral_downloads", MODE_PRIVATE).edit().putString("direct_" + st.id, meta.toString()).apply();
        } catch (Throwable ignored) {
        }
    }

    private DirectState directFromPrefs(long id) {
        try {
            String s = getSharedPreferences("kral_downloads", MODE_PRIVATE).getString("direct_" + id, null);
            if (s == null) return null;
            JSONObject meta = new JSONObject(s);
            DirectState st = new DirectState();
            st.id = id;
            st.title = meta.optString("title", "");
            st.type = meta.optString("type", "movie");
            st.label = meta.optString("label", "");
            st.quality = meta.optString("quality", "");
            st.fileName = meta.optString("fileName", "");
            st.folder = meta.optString("folder", "");
            st.fileUri = meta.optString("fileUri", "");
            st.url = meta.optString("url", "");
            st.lastUpdate = meta.optLong("lastUpdate", 0);
            st.status = meta.optString("status", "failed");
            st.downloaded = meta.optLong("downloaded", 0);
            st.total = meta.optLong("total", 0);
            st.reason = meta.optInt("reason", 0);
            st.segCount = meta.optInt("segCount", 0);
            try {
                org.json.JSONArray segArr = meta.optJSONArray("segments");
                if (segArr != null && segArr.length() > 0) {
                    st.segDownloaded = new long[segArr.length()];
                    for (int i = 0; i < segArr.length(); i++) st.segDownloaded[i] = segArr.optLong(i, 0);
                    if (st.segCount <= 0) st.segCount = segArr.length();
                }
            } catch (Throwable ignored) {}
            return st;
        } catch (Throwable ignored) {
            return null;
        }
    }

    // ---------- Download notifications (v1.38) ----------
    // Posted by the download thread itself, so progress keeps
    // updating even after the Activity is destroyed, as long as
    // the keep-alive foreground service holds the process.
    private void createDownloadChannel() {
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                android.app.NotificationChannel ch = new android.app.NotificationChannel(
                        DownloadService.CHANNEL_ID, "دانلودهای کرال‌مووی",
                        android.app.NotificationManager.IMPORTANCE_LOW);
                ch.setDescription("پیشرفت دانلود فیلم‌ها و سریال‌ها");
                android.app.NotificationManager nm = (android.app.NotificationManager) getSystemService(NOTIFICATION_SERVICE);
                if (nm != null) nm.createNotificationChannel(ch);
            }
        } catch (Throwable ignored) {
        }
    }

    private static String formatDownloadBytes(long n) {
        if (n <= 0) return "—";
        if (n < 1024) return n + " بایت";
        if (n < 1024 * 1024) return String.format("%.1f کیلوبایت", n / 1024.0);
        if (n < 1024 * 1024 * 1024) return String.format("%.1f مگابایت", n / (1024.0 * 1024.0));
        return String.format("%.2f گیگابایت", n / (1024.0 * 1024.0 * 1024.0));
    }

    // v1.40: suppress notifications while the user is
    // already watching progress in Download Manager AND the
    // app is in the foreground. When the app goes to the
    // background (onPause), activityForeground becomes false
    // and notifications resume, so progress is still visible
    // in the shade while the user does other things.
    private volatile boolean downloadManagerVisible = false;
    private volatile boolean activityForeground = false;

    private void postDownloadProgress(DirectState st) {
        if (downloadManagerVisible && activityForeground) return;
        try {
            createDownloadChannel();
            int pct = st.total > 0 ? (int) Math.min(100, st.downloaded * 100 / st.total) : 0;
            String text = pct + "٪ · " + formatDownloadBytes(st.downloaded) + " از " + formatDownloadBytes(st.total);
            androidx.core.app.NotificationCompat.Builder b = new androidx.core.app.NotificationCompat.Builder(this, DownloadService.CHANNEL_ID)
                    .setSmallIcon(android.R.drawable.stat_sys_download)
                    .setContentTitle(st.title == null || st.title.isEmpty() ? "در حال دانلود" : st.title)
                    .setContentText(text)
                    .setOngoing(true)
                    .setOnlyAlertOnce(true)
                    .setProgress(100, pct, false);
            android.app.NotificationManager nm = (android.app.NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm != null) nm.notify((int) st.id, b.build());
        } catch (Throwable ignored) {
        }
    }

    private void postDownloadDone(DirectState st, boolean success) {
        if (downloadManagerVisible && activityForeground) {
            // UI already shows the final state; a notification
            // here would only duplicate it.
            return;
        }
        try {
            createDownloadChannel();
            String text = success ? "دانلود کامل شد" : "دانلود ناموفق بود — از دانلود منیجر تلاش مجدد بزنید";
            androidx.core.app.NotificationCompat.Builder b = new androidx.core.app.NotificationCompat.Builder(this, DownloadService.CHANNEL_ID)
                    .setSmallIcon(success ? android.R.drawable.stat_sys_download_done : android.R.drawable.stat_sys_download)
                    .setContentTitle(st.title == null || st.title.isEmpty() ? "دانلود" : st.title)
                    .setContentText(text)
                    .setOngoing(false)
                    .setAutoCancel(true);
            android.app.NotificationManager nm = (android.app.NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm != null) nm.notify((int) st.id, b.build());
        } catch (Throwable ignored) {
        }
    }

    private void cancelDownloadNotification(long dmId) {
        try {
            android.app.NotificationManager nm = (android.app.NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm != null) nm.cancel((int) dmId);
        } catch (Throwable ignored) {
        }
    }

    private long directFileSize(DirectState st) {
        try {
            if (st.fileUri == null || st.fileUri.isEmpty()) return 0;
            if (Build.VERSION.SDK_INT >= 29) {
                android.content.res.AssetFileDescriptor fd =
                        getContentResolver().openAssetFileDescriptor(Uri.parse(st.fileUri), "r");
                if (fd == null) return 0;
                long len = fd.getLength();
                try { fd.close(); } catch (Throwable ignored) {}
                return len > 0 ? len : 0;
            } else {
                File f = new File(Uri.parse(st.fileUri).getPath());
                return f.exists() ? f.length() : 0;
            }
        } catch (Throwable ignored) {
            return 0;
        }
    }

    private void stopKeepAliveIfIdle() {
        try {
            boolean anyRunning = false;
            for (DirectState s : directMap.values()) {
                if ("downloading".equals(s.status)) { anyRunning = true; break; }
            }
            if (!anyRunning) {
                try {
                    Intent stop = new Intent(MainActivity.this, DownloadService.class);
                    stop.setAction(DownloadService.ACTION_CANCEL);
                    stop.putExtra("id", -1L);
                    startService(stop);
                } catch (Throwable ignored) {}
                // The service stops itself when its alive map is
                // empty; the cancel-all intent above is a best-effort
                // nudge, the per-download cancel already removes it.
                try { stopService(new Intent(MainActivity.this, DownloadService.class)); } catch (Throwable ignored) {}
            }
        } catch (Throwable ignored) {
        }
    }

    private void runDirectDownload(final DirectState st, final String ua) {
        // v1.39: ADM-style multi-part download + battery resilience.
        // - Files are split into 4-8 parallel segments (Range),
        //   each with its own retry, so one slow/stalling
        //   connection no longer drags the whole download down.
        // - A partial WakeLock is held while downloading, so the
        //   CPU does not sleep mid-download when the screen is off.
        // - The download itself is NOT VLC: it is direct HTTP,
        //   the same request as playback, now multi-connection
        //   like ADM. VLC is only the player.
        android.os.PowerManager.WakeLock wl = null;
        try {
            try {
                android.os.PowerManager pm = (android.os.PowerManager) getSystemService(POWER_SERVICE);
                if (pm != null) {
                    wl = pm.newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK, "KRALMOVIE:download");
                    wl.acquire();
                }
            } catch (Throwable ignored) {
            }
            // Resume: convert any saved per-segment progress
            // (v1.39) or per-chunk progress (v1.40+) to the current
            // chunk system. Conversion is identity when the data
            // is already chunked, because chunk boundaries are
            // deterministic from total alone.
            if (st.total > 0 && st.segCount > 1 && st.segDownloaded != null
                    && st.segDownloaded.length == st.segCount) {
                int cSize = chunkSizeFor(st.total);
                int cCount = (int) ((st.total + cSize - 1) / cSize);
                if (cCount != st.segCount) {
                    long[] oldSeg = st.segDownloaded;
                    int oldCount = st.segCount;
                    long[] newChunks = new long[cCount];
                    for (int j = 0; j < cCount; j++) {
                        long cs = chunkStart(st.total, cSize, j);
                        long ce = chunkEnd(st.total, cSize, j);
                        long clen = ce - cs + 1;
                        int segIdx = (int) (cs * oldCount / st.total);
                        if (segIdx < 0) segIdx = 0;
                        if (segIdx >= oldCount) segIdx = oldCount - 1;
                        long segS = st.total * segIdx / oldCount;
                        long v = oldSeg[segIdx] - (cs - segS);
                        if (v < 0) v = 0;
                        if (v > clen) v = clen;
                        newChunks[j] = v;
                    }
                    st.segDownloaded = newChunks;
                    st.segCount = cCount;
                    long sum = 0;
                    for (long v : newChunks) sum += v;
                    st.downloaded = sum;
                }
                runChunkDownload(st, ua);
                return;
            }
            // Fresh download, or single-thread resume: probe size.
            long total = st.total;
            boolean rangeOk = false;
            if (total <= 0) {
                long[] probe = probeTotal(st.url, ua);
                if (probe != null) {
                    total = probe[0];
                    rangeOk = probe[1] == 1;
                    st.total = total;
                }
            } else {
                rangeOk = true; // resume case: total known, Range was used before
            }
            if (total > 0 && rangeOk) {
                if (total >= 10L * 1024 * 1024) {
                    int cSize = chunkSizeFor(total);
                    int cCount = (int) ((total + cSize - 1) / cSize);
                    st.segCount = cCount;
                    st.segDownloaded = new long[cCount];
                    // If this is a resume of a single-thread file,
                    // its bytes are sequential from 0, so they fill
                    // the first chunks in order.
                    long remaining = st.downloaded;
                    for (int i = 0; i < cCount && remaining > 0; i++) {
                        long clen = chunkEnd(total, cSize, i) - chunkStart(total, cSize, i) + 1;
                        long take = Math.min(clen, remaining);
                        st.segDownloaded[i] = take;
                        remaining -= take;
                    }
                    runChunkDownload(st, ua);
                    return;
                }
            }
            // Single-thread fallback (small file, unknown size, or
            // server without Range support): proven v1.38 path.
            long startByte = st.downloaded > 0 ? st.downloaded : directFileSize(st);
            runSingleDownload(st, ua, startByte);
        } finally {
            try { if (wl != null && wl.isHeld()) wl.release(); } catch (Throwable ignored) {}
        }
    }

    /** Probe total size + Range support with a 0-0 Range request.
     *  Returns {total, 1 if Range supported else 0}, or null. */
    private long[] probeTotal(String urlStr, String ua) {
        String cur0 = urlStr;
        for (int attempt = 0; attempt < 2; attempt++) {
            HttpURLConnection conn = null;
            try {
                String cur = cur0;
                for (int redir = 0; redir < 5; redir++) {
                    URL u = new URL(cur);
                    conn = (HttpURLConnection) u.openConnection();
                    conn.setRequestProperty("User-Agent", ua);
                    conn.setRequestProperty("Accept", "*/*");
                    conn.setRequestProperty("Range", "bytes=0-0");
                    conn.setConnectTimeout(15000);
                    conn.setReadTimeout(15000);
                    conn.setInstanceFollowRedirects(false);
                    int code = conn.getResponseCode();
                    if (code == 301 || code == 302 || code == 303 || code == 307 || code == 308) {
                        String loc = conn.getHeaderField("Location");
                        conn.disconnect();
                        conn = null;
                        if (loc == null || loc.isEmpty()) return null;
                        cur = new URL(u, loc).toString();
                        continue;
                    }
                    break;
                }
                if (conn == null) return null;
                int code = conn.getResponseCode();
                if (code == 206) {
                    String cr = conn.getHeaderField("Content-Range");
                    if (cr != null && cr.contains("/")) {
                        try {
                            long total = Long.parseLong(cr.substring(cr.lastIndexOf('/') + 1).trim());
                            if (total > 0) return new long[]{total, 1};
                        } catch (Throwable ignored) {
                        }
                    }
                    long len = conn.getContentLengthLong();
                    if (len > 0) return new long[]{len + 1, 1};
                    return null;
                }
                if (code == 200) {
                    long len = conn.getContentLengthLong();
                    if (len > 0) return new long[]{len, 0};
                    return null;
                }
                if (code >= 400) return null;
                return null;
            } catch (javax.net.ssl.SSLException sslEx) {
                if (attempt == 0 && cur0.startsWith("https://")) {
                    cur0 = cur0.replaceFirst("^https://", "http://");
                    continue;
                }
                return null;
            } catch (Throwable ignored) {
                return null;
            } finally {
                try { if (conn != null) conn.disconnect(); } catch (Throwable ignored) {}
            }
        }
        return null;
    }

    // v1.40 chunk queue: the file is split into small 1-2 MB
    // chunks, and N workers pick unfinished chunks dynamically.
    // Fixed segments had a tail problem: near the end, most
    // workers finished and only one slow segment was left, so
    // total speed collapsed to that one connection. With small
    // chunks, workers stay busy until the last few megabytes,
    // so the tail is at most one chunk per worker, not one
    // 16 MB segment.
    private static int chunkSizeFor(long total) {
        return total < 50L * 1024 * 1024 ? 1024 * 1024 : 2 * 1024 * 1024;
    }

    private static long chunkStart(long total, int chunkSize, int i) {
        return (long) i * chunkSize;
    }

    private static long chunkEnd(long total, int chunkSize, int i) {
        long e = (long) (i + 1) * chunkSize - 1;
        return e >= total ? total - 1 : e;
    }

    private int claimChunk(final DirectState st, long total, int chunkSize, int chunkCount) {
        synchronized (st) {
            if (st.segClaimed == null || st.segClaimed.length != chunkCount) {
                st.segClaimed = new boolean[chunkCount];
            }
            for (int i = 0; i < chunkCount; i++) {
                long len = chunkEnd(total, chunkSize, i) - chunkStart(total, chunkSize, i) + 1;
                if (!st.segClaimed[i] && st.segDownloaded[i] < len) {
                    st.segClaimed[i] = true;
                    return i;
                }
            }
            return -1;
        }
    }

    /** Download one chunk (with retries). Returns true on success. */
    private boolean downloadChunk(final DirectState st, final String ua,
                                  long total, int chunkSize, int idx, int[] reasonOut) {
        long cS = chunkStart(total, chunkSize, idx);
        long cE = chunkEnd(total, chunkSize, idx);
        String urlStr = st.url;
        for (int attempt = 0; attempt < 3; attempt++) {
            if (st.cancelled) return false;
            long done;
            synchronized (st) { done = st.segDownloaded[idx]; }
            long cLen = cE - cS + 1;
            if (done >= cLen) return true;
            HttpURLConnection conn = null;
            InputStream in = null;
            java.nio.channels.FileChannel channel = null;
            android.os.ParcelFileDescriptor pfd = null;
            java.io.RandomAccessFile raf = null;
            try {
                String cur = urlStr;
                for (int redir = 0; redir < 5; redir++) {
                    URL u = new URL(cur);
                    conn = (HttpURLConnection) u.openConnection();
                    conn.setRequestProperty("User-Agent", ua);
                    conn.setRequestProperty("Accept", "*/*");
                    conn.setRequestProperty("Range", "bytes=" + (cS + done) + "-" + cE);
                    conn.setConnectTimeout(15000);
                    conn.setReadTimeout(30000);
                    conn.setInstanceFollowRedirects(false);
                    int code = conn.getResponseCode();
                    if (code == 301 || code == 302 || code == 303 || code == 307 || code == 308) {
                        String loc = conn.getHeaderField("Location");
                        conn.disconnect();
                        conn = null;
                        if (loc == null || loc.isEmpty()) throw new Exception("redirect without location");
                        cur = new URL(u, loc).toString();
                        continue;
                    }
                    break;
                }
                if (conn == null) throw new Exception("no connection");
                int code = conn.getResponseCode();
                if (code >= 400) {
                    reasonOut[0] = code;
                    throw new Exception("http " + code);
                }
                if (code != 206) throw new Exception("no range support");
                String ctype = conn.getContentType();
                if (ctype != null && ctype.toLowerCase().contains("text/html")) {
                    reasonOut[0] = 1002;
                    throw new Exception("html response");
                }
                in = conn.getInputStream();
                if (Build.VERSION.SDK_INT >= 29) {
                    pfd = getContentResolver().openFileDescriptor(Uri.parse(st.fileUri), "rw");
                    if (pfd == null) throw new Exception("cannot open file");
                    channel = new java.io.FileOutputStream(pfd.getFileDescriptor()).getChannel();
                } else {
                    raf = new java.io.RandomAccessFile(new File(Uri.parse(st.fileUri).getPath()), "rw");
                    channel = raf.getChannel();
                }
                byte[] buf = new byte[131072];
                int n;
                java.nio.ByteBuffer bb = java.nio.ByteBuffer.allocate(131072);
                while ((n = in.read(buf)) != -1) {
                    if (st.cancelled) return false;
                    bb.clear();
                    bb.put(buf, 0, n);
                    bb.flip();
                    long pos = cS + done;
                    while (bb.hasRemaining()) {
                        int w = channel.write(bb, pos);
                        if (w <= 0) break;
                        pos += w;
                    }
                    synchronized (st) {
                        st.segDownloaded[idx] += n;
                        st.downloaded += n;
                    }
                    done += n;
                }
                return true;
            } catch (javax.net.ssl.SSLException sslEx) {
                if (attempt == 0 && urlStr.startsWith("https://")) {
                    urlStr = urlStr.replaceFirst("^https://", "http://");
                    continue;
                }
                reasonOut[0] = -1;
                try { Thread.sleep(1000L * (attempt + 1)); } catch (Throwable ignored) {}
            } catch (Throwable ex) {
                if (st.cancelled) return false;
                if (reasonOut[0] == 0) reasonOut[0] = -1;
                try { Thread.sleep(1000L * (attempt + 1)); } catch (Throwable ignored) {}
            } finally {
                try { if (channel != null) channel.close(); } catch (Throwable ignored) {}
                try { if (pfd != null) pfd.close(); } catch (Throwable ignored) {}
                try { if (raf != null) raf.close(); } catch (Throwable ignored) {}
                try { if (in != null) in.close(); } catch (Throwable ignored) {}
                try { if (conn != null) conn.disconnect(); } catch (Throwable ignored) {}
            }
        }
        return false;
    }

    private void runChunkDownload(final DirectState st, final String ua) {
        final long total = st.total;
        final int chunkSize = chunkSizeFor(total);
        final int chunkCount = (int) ((total + chunkSize - 1) / chunkSize);
        if (st.segDownloaded == null || st.segDownloaded.length != chunkCount) {
            // Should have been set by runDirectDownload; guard anyway.
            long[] nd = new long[chunkCount];
            if (st.segDownloaded != null) {
                System.arraycopy(st.segDownloaded, 0, nd, 0, Math.min(st.segDownloaded.length, chunkCount));
            }
            st.segDownloaded = nd;
            st.segCount = chunkCount;
        }
        st.segClaimed = new boolean[chunkCount];
        st.stopWorkers = false;
        final int workersN = total < 50L * 1024 * 1024 ? 4 : 8;
        final boolean[] chunkFailed = new boolean[1];
        final int[] failReason = new int[]{0};
        Thread[] workers = new Thread[workersN];
        for (int w = 0; w < workersN; w++) {
            Thread th = new Thread(() -> {
                while (true) {
                    if (st.cancelled || st.stopWorkers) return;
                    int idx = claimChunk(st, total, chunkSize, chunkCount);
                    if (idx < 0) return;
                    int[] reasonOut = new int[]{0};
                    boolean ok = downloadChunk(st, ua, total, chunkSize, idx, reasonOut);
                    if (!ok && !st.cancelled) {
                        // Chunk failed after its own retries: fail
                        // the whole download (progress is saved, so
                        // Retry resumes per-chunk). Keep the chunk
                        // claimed so no other worker picks it up
                        // while the coordinator is stopping.
                        long cLen = chunkEnd(total, chunkSize, idx) - chunkStart(total, chunkSize, idx) + 1;
                        long done;
                        synchronized (st) { done = st.segDownloaded[idx]; }
                        if (done < cLen) {
                            chunkFailed[0] = true;
                            if (reasonOut[0] != 0) failReason[0] = reasonOut[0];
                            return;
                        }
                    }
                }
            });
            workers[w] = th;
            th.start();
        }
        try {
            boolean anyAlive = true;
            while (anyAlive) {
                if (st.cancelled) {
                    for (Thread th : workers) { try { th.interrupt(); } catch (Throwable ignored) {} }
                    return;
                }
                anyAlive = false;
                for (Thread th : workers) { if (th.isAlive()) { anyAlive = true; break; } }
                if (chunkFailed[0]) {
                    st.stopWorkers = true;
                    break;
                }
                directSavePrefs(st);
                postDownloadProgress(st);
                if (anyAlive) { try { Thread.sleep(1000); } catch (Throwable ignored) {} }
            }
            for (Thread th : workers) { try { th.join(); } catch (Throwable ignored) {} }
        } catch (Throwable ignored) {
        }
        if (st.cancelled) return;
        if (chunkFailed[0]) {
            st.status = "failed";
            st.reason = failReason[0] != 0 ? failReason[0] : -1;
            directSavePrefs(st);
            postDownloadDone(st, false);
            stopKeepAliveIfIdle();
            return;
        }
        st.downloaded = total;
        st.status = "successful";
        try {
            if (Build.VERSION.SDK_INT >= 29 && st.fileUri != null && !st.fileUri.isEmpty()) {
                ContentValues v = new ContentValues();
                v.put(MediaStore.MediaColumns.IS_PENDING, 0);
                getContentResolver().update(Uri.parse(st.fileUri), v, null, null);
            }
        } catch (Throwable ignored) {
        }
        directSavePrefs(st);
        postDownloadDone(st, true);
        stopKeepAliveIfIdle();
    }

    private void runSingleDownload(final DirectState st, final String ua, long startByte0) {
        String urlStr = st.url;
        long startByte = startByte0;
        for (int attempt = 0; attempt < 2; attempt++) {
            if (st.cancelled) return;
            HttpURLConnection conn = null;
            InputStream in = null;
            OutputStream out = null;
            try {
                String cur = urlStr;
                for (int redir = 0; redir < 5; redir++) {
                    URL u = new URL(cur);
                    conn = (HttpURLConnection) u.openConnection();
                    conn.setRequestProperty("User-Agent", ua);
                    conn.setRequestProperty("Accept", "*/*");
                    if (startByte > 0) conn.setRequestProperty("Range", "bytes=" + startByte + "-");
                    conn.setConnectTimeout(15000);
                    conn.setReadTimeout(30000);
                    conn.setInstanceFollowRedirects(false);
                    int code = conn.getResponseCode();
                    if (code == 301 || code == 302 || code == 303 || code == 307 || code == 308) {
                        String loc = conn.getHeaderField("Location");
                        conn.disconnect();
                        conn = null;
                        if (loc == null || loc.isEmpty()) throw new Exception("redirect without location");
                        cur = new URL(u, loc).toString();
                        continue;
                    }
                    break;
                }
                if (conn == null) throw new Exception("no connection");
                int code = conn.getResponseCode();
                if (code >= 400) {
                    st.status = "failed";
                    st.reason = code;
                    directSavePrefs(st);
                    postDownloadDone(st, false);
                    stopKeepAliveIfIdle();
                    return;
                }
                if (code == 416) {
                    if (st.total > 0 && startByte >= st.total) {
                        st.downloaded = st.total;
                        st.status = "successful";
                        try {
                            if (Build.VERSION.SDK_INT >= 29 && st.fileUri != null && !st.fileUri.isEmpty()) {
                                ContentValues v = new ContentValues();
                                v.put(MediaStore.MediaColumns.IS_PENDING, 0);
                                getContentResolver().update(Uri.parse(st.fileUri), v, null, null);
                            }
                        } catch (Throwable ignored) {
                        }
                        directSavePrefs(st);
                        postDownloadDone(st, true);
                        stopKeepAliveIfIdle();
                        return;
                    }
                    startByte = 0;
                    st.downloaded = 0;
                    if (attempt == 0) continue;
                    st.status = "failed";
                    st.reason = 416;
                    directSavePrefs(st);
                    postDownloadDone(st, false);
                    stopKeepAliveIfIdle();
                    return;
                }
                String ctype = conn.getContentType();
                if (ctype != null && ctype.toLowerCase().contains("text/html")) {
                    st.status = "failed";
                    st.reason = 1002;
                    directSavePrefs(st);
                    postDownloadDone(st, false);
                    stopKeepAliveIfIdle();
                    return;
                }
                long remaining = conn.getContentLengthLong();
                if (code == 206 && startByte > 0) {
                    st.total = remaining > 0 ? startByte + remaining : st.total;
                    st.downloaded = startByte;
                } else {
                    if (startByte > 0) {
                        startByte = 0;
                        st.downloaded = 0;
                    }
                    st.total = remaining > 0 ? remaining : st.total;
                }
                in = conn.getInputStream();
                if (Build.VERSION.SDK_INT >= 29) {
                    String mode = (code == 206 && startByte > 0) ? "wa" : "w";
                    out = getContentResolver().openOutputStream(Uri.parse(st.fileUri), mode);
                } else {
                    out = new FileOutputStream(new File(Uri.parse(st.fileUri).getPath()), code == 206 && startByte > 0);
                }
                if (out == null) throw new Exception("cannot open output");
                directSavePrefs(st);
                postDownloadProgress(st);
                byte[] buf = new byte[131072];
                int n;
                long lastSave = System.currentTimeMillis();
                while ((n = in.read(buf)) != -1) {
                    if (st.cancelled) return;
                    out.write(buf, 0, n);
                    st.downloaded += n;
                    long now = System.currentTimeMillis();
                    if (now - lastSave >= 1000) {
                        lastSave = now;
                        directSavePrefs(st);
                        postDownloadProgress(st);
                    }
                }
                out.flush();
                st.status = "successful";
                try {
                    if (Build.VERSION.SDK_INT >= 29 && st.fileUri != null && !st.fileUri.isEmpty()) {
                        ContentValues v = new ContentValues();
                        v.put(MediaStore.MediaColumns.IS_PENDING, 0);
                        getContentResolver().update(Uri.parse(st.fileUri), v, null, null);
                    }
                } catch (Throwable ignored) {
                }
                directSavePrefs(st);
                postDownloadDone(st, true);
                stopKeepAliveIfIdle();
                return;
            } catch (javax.net.ssl.SSLException sslEx) {
                if (attempt == 0 && urlStr.startsWith("https://")) {
                    urlStr = urlStr.replaceFirst("^https://", "http://");
                    continue;
                }
                if (st.cancelled) return;
                st.status = "failed";
                st.reason = -1;
                directSavePrefs(st);
                postDownloadDone(st, false);
                stopKeepAliveIfIdle();
                return;
            } catch (Throwable ex) {
                if (st.cancelled) return;
                st.status = "failed";
                st.reason = -1;
                directSavePrefs(st);
                postDownloadDone(st, false);
                stopKeepAliveIfIdle();
                return;
            } finally {
                try { if (out != null) out.close(); } catch (Throwable ignored) {}
                try { if (in != null) in.close(); } catch (Throwable ignored) {}
                try { if (conn != null) conn.disconnect(); } catch (Throwable ignored) {}
            }
        }
    }

    /** Called from the web app (window.AndroidPlayer.*). */
    public class PlayerBridge {
        @JavascriptInterface
        public void setFullscreen(boolean enter) {
            runOnUiThread(() -> {
                if (enter) {
                    enterPlayerFullscreen();
                } else {
                    exitPlayerFullscreen();
                }
            });
        }

        /** Launch the in-app libVLC player activity for in-app
         *  playback, with embedded MKV subtitles. */
        @JavascriptInterface
        public void openTelegram() {
            runOnUiThread(() -> {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW,
                            Uri.parse("tg://resolve?domain=ProxyArc")));
                } catch (ActivityNotFoundException e) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW,
                                Uri.parse("https://t.me/ProxyArc")));
                    } catch (Exception ignored) {
                    }
                } catch (Exception ignored) {
                }
            });
        }

        // v1.31: debounce — a double-tap on "play in app" used to
        // start two PlayerActivities (two LibVLC instances) at the
        // same time, which can crash natively. Ignore a second
        // launch within 1.5 seconds.
        private long lastPlayNativeMs = 0;

        @JavascriptInterface
        public void playNative(String url, String title) {
            runOnUiThread(() -> {
                try {
                    long now = System.currentTimeMillis();
                    if (now - lastPlayNativeMs < 1500) return;
                    lastPlayNativeMs = now;
                    Intent intent = new Intent(MainActivity.this, PlayerActivity.class);
                    intent.putExtra("url", url);
                    intent.putExtra("title", title != null ? title : "");
                    // Browser User-Agent: the CDN accepts the WebView
                    // player, so the native players should present
                    // the same UA instead of their library default.
                    try {
                        if (webView != null) {
                            String ua = webView.getSettings().getUserAgentString();
                            if (ua != null) intent.putExtra("ua", ua);
                        }
                    } catch (Throwable ignored) {
                    }
                    startActivity(intent);
                } catch (Throwable ignored) {
                    // Catch Errors too (e.g. missing class at load
                    // time), so a player failure never force-closes
                    // the whole app; the user stays on the quality
                    // list and can try VLC/MX instead.
                }
            });
        }

        /** Direct ACTION_VIEW intent to an external player (VLC/MX/...).
         *  Bypasses the WebView intent:// route, which can lose the URL
         *  in fullscreen/custom-view mode and fall back to a browser. */
        @JavascriptInterface
        public void openExternal(String url, String pkg) {
            runOnUiThread(() -> {
                try {
                    Intent intent = new Intent(Intent.ACTION_VIEW);
                    intent.setDataAndType(Uri.parse(url), "video/*");
                    if (pkg != null && !pkg.isEmpty()) intent.setPackage(pkg);
                    startActivity(intent);
                } catch (ActivityNotFoundException e) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                    } catch (Exception ignored) {
                    }
                } catch (Exception ignored) {
                }
            });
        }

        /** Extract embedded subtitle cues from an MKV/MP4 file with
         *  Android's own MediaExtractor and send them back to the web
         *  player in batches. Why this exists: Chrome/WebView does
         *  NOT expose embedded MKV subtitle tracks through
         *  video.textTracks (verified with a test MKV in Chrome:
         *  textTracks stayed empty), which is exactly why the in-app
         *  player showed no subtitles while VLC/MX did. The web
         *  player renders these cues itself, synced to currentTime.
         *  Cues are sent as they are found, so early subtitles do
         *  not have to wait for the whole file to be scanned. */
        @JavascriptInterface
        public void extractSubtitles(String url) {
            if (url == null || url.isEmpty()) return;
            new Thread(() -> {
                MediaExtractor extractor = new MediaExtractor();
                try {
                    extractor.setDataSource(MainActivity.this, Uri.parse(url), null);
                    int trackCount = extractor.getTrackCount();
                    int subTrack = -1;
                    int fallbackTrack = -1;
                    for (int i = 0; i < trackCount; i++) {
                        MediaFormat format = extractor.getTrackFormat(i);
                        String mime = "";
                        try {
                            mime = format.getString(MediaFormat.KEY_MIME);
                        } catch (Exception ignored) {
                        }
                        if (mime == null) mime = "";
                        String lower = mime.toLowerCase();
                        boolean isSub = lower.startsWith("text/")
                                || lower.contains("subrip")
                                || lower.contains("ass")
                                || lower.contains("ssa")
                                || lower.contains("vtt")
                                || lower.contains("utf8")
                                || lower.contains("subtitle");
                        if (!isSub) continue;
                        if (fallbackTrack < 0) fallbackTrack = i;
                        String lang = "";
                        try {
                            lang = format.getString(MediaFormat.KEY_LANGUAGE);
                        } catch (Exception ignored) {
                        }
                        if (lang != null) {
                            String l = lang.toLowerCase();
                            if (l.equals("fa") || l.equals("fas") || l.equals("per")
                                    || l.equals("persian")) {
                                subTrack = i;
                                break;
                            }
                        }
                    }
                    if (subTrack < 0) subTrack = fallbackTrack;
                    if (subTrack < 0) {
                        sendSubtitleBatch("[]", true);
                        return;
                    }
                    extractor.selectTrack(subTrack);
                    JSONArray batch = new JSONArray();
                    long prevStartUs = -1;
                    String prevText = null;
                    while (true) {
                        long sampleTimeUs = extractor.getSampleTime();
                        if (sampleTimeUs < 0) break;
                        ByteBuffer buffer = ByteBuffer.allocate(65536);
                        int size = extractor.readSampleData(buffer, 0);
                        String text = "";
                        if (size > 0) {
                            byte[] bytes = new byte[size];
                            buffer.get(bytes);
                            text = new String(bytes, "UTF-8").trim();
                        }
                        if (prevText != null && !prevText.isEmpty() && prevStartUs >= 0) {
                            JSONObject cue = new JSONObject();
                            cue.put("start", prevStartUs / 1000000.0);
                            cue.put("end", sampleTimeUs / 1000000.0);
                            cue.put("text", prevText);
                            batch.put(cue);
                        }
                        prevStartUs = sampleTimeUs;
                        prevText = text;
                        extractor.advance();
                        if (batch.length() >= 200) {
                            sendSubtitleBatch(batch.toString(), false);
                            batch = new JSONArray();
                        }
                    }
                    if (prevText != null && !prevText.isEmpty() && prevStartUs >= 0) {
                        JSONObject cue = new JSONObject();
                        cue.put("start", prevStartUs / 1000000.0);
                        cue.put("end", prevStartUs / 1000000.0 + 3.0);
                        cue.put("text", prevText);
                        batch.put(cue);
                    }
                    sendSubtitleBatch(batch.toString(), true);
                } catch (Exception ignored) {
                    sendSubtitleBatch("[]", true);
                } finally {
                    try {
                        extractor.release();
                    } catch (Exception ignored) {
                    }
                }
            }).start();
        }

        private void sendSubtitleBatch(String json, boolean isFinal) {
            runOnUiThread(() -> {
                if (webView == null) return;
                String script = "window.__onNativeSubtitles && window.__onNativeSubtitles("
                        + JSONObject.quote(json) + "," + (isFinal ? "true" : "false") + ")";
                webView.evaluateJavascript(script, null);
            });
        }


        // ---------- Download Manager (v1.18) ----------
        // Files go to the phone's public Downloads folder, inside
        // KRALMOVIE/Movies or KRALMOVIE/Series, via the system
        // DownloadManager, so downloads survive the app being
        // backgrounded and the files are visible in a file manager.
        // Metadata (title/type/label) is kept in SharedPreferences
        // because DownloadManager itself only stores the URL/file.
        private SharedPreferences downloadPrefs() {
            return MainActivity.this.getSharedPreferences("kral_downloads", MODE_PRIVATE);
        }

        private String sanitizeFileName(String name) {
            if (name == null || name.isEmpty()) return "kralmovie-video";
            String out = name.replaceAll("[\\\\/:*?\"<>|]", "_").trim();
            if (out.isEmpty()) out = "kralmovie-video";
            if (out.length() > 120) out = out.substring(0, 120);
            return out;
        }

        @JavascriptInterface
        public long startDownload(String json) {
            // v1.28: direct in-app download first (same request as
            // VLC playback). System DownloadManager is only a
            // fallback if the direct file cannot be created.
            try {
                JSONObject o = new JSONObject(json);
                String url = o.optString("url", "");
                String title = o.optString("title", "");
                String type = o.optString("type", "movie");
                String label = o.optString("label", "");
                String quality = o.optString("quality", "");
                String fileName = sanitizeFileName(o.optString("fileName", ""));
                if (url.isEmpty() || fileName.isEmpty()) return -1;
                String folder = "series".equals(type) ? "KRALMOVIE/Series" : "KRALMOVIE/Movies";
                String ua = null;
                try {
                    if (webView != null) ua = webView.getSettings().getUserAgentString();
                } catch (Throwable ignored) {
                }
                if (ua == null || ua.isEmpty()) {
                    ua = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";
                }
                // Create the destination file first.
                String fileUri = null;
                try {
                    if (Build.VERSION.SDK_INT >= 29) {
                        ContentValues values = new ContentValues();
                        values.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName);
                        values.put(MediaStore.MediaColumns.MIME_TYPE, directMimeFor(fileName));
                        values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/" + folder);
                        values.put(MediaStore.MediaColumns.IS_PENDING, 1);
                        Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                        if (uri != null) fileUri = uri.toString();
                    } else {
                        File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), folder);
                        if (!dir.exists()) dir.mkdirs();
                        File f = new File(dir, fileName);
                        if (!f.exists()) f.createNewFile();
                        fileUri = Uri.fromFile(f).toString();
                    }
                } catch (Throwable ignored) {
                    fileUri = null;
                }
                if (fileUri == null) {
                    // Direct file creation failed: fall back to the
                    // old system DownloadManager path below.
                    return systemStartDownload(o, url, title, type, label, quality, fileName, folder);
                }
                // v1.38: download runs on the proven MainActivity
                // thread again (v1.37's service download broke it),
                // and DownloadService is only a keep-alive foreground
                // service so the thread survives closing the app.
                // If the service fails to start, the download still
                // works while the app is open.
                requestNotificationPermission();
                maybePromptBatteryExemptionOnce();
                final DirectState st = new DirectState();
                st.id = directIdSeq.incrementAndGet();
                st.url = url;
                st.title = title;
                st.type = type;
                st.label = label;
                st.quality = quality;
                st.fileName = fileName;
                st.folder = folder;
                st.fileUri = fileUri;
                st.downloaded = 0;
                st.total = 0;
                st.status = "downloading";
                st.reason = 0;
                st.cancelled = false;
                directMap.put(st.id, st);
                directSavePrefs(st);
                startDownloadService(DownloadService.ACTION_KEEP_ALIVE, st, ua);
                final String finalUa = ua;
                Thread th = new Thread(() -> runDirectDownload(st, finalUa));
                st.thread = th;
                th.start();
                return st.id;
            } catch (Exception e) {
                return -1;
            }
        }

        private void startDownloadService(String action, DirectState st, String ua) {
            try {
                Intent intent = new Intent(MainActivity.this, DownloadService.class);
                intent.setAction(action);
                intent.putExtra("id", st.id);
                intent.putExtra("url", st.url == null ? "" : st.url);
                intent.putExtra("title", st.title == null ? "" : st.title);
                intent.putExtra("type", st.type == null ? "movie" : st.type);
                intent.putExtra("label", st.label == null ? "" : st.label);
                intent.putExtra("quality", st.quality == null ? "" : st.quality);
                intent.putExtra("fileName", st.fileName == null ? "" : st.fileName);
                intent.putExtra("folder", st.folder == null ? "" : st.folder);
                intent.putExtra("fileUri", st.fileUri == null ? "" : st.fileUri);
                intent.putExtra("ua", ua == null ? "" : ua);
                intent.putExtra("total", st.total);
                if (Build.VERSION.SDK_INT >= 26) {
                    startForegroundService(intent);
                } else {
                    startService(intent);
                }
            } catch (Throwable ignored) {
            }
        }

        // v1.37: ask for POST_NOTIFICATIONS (Android 13+) so the
        // download progress notification can be shown. The download
        // still starts even if the user declines; the notification
        // just will not appear until permission is granted.
        private void requestNotificationPermission() {
            try {
                if (Build.VERSION.SDK_INT >= 33) {
                    if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                            != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                        requestPermissions(
                                new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, 1001);
                    }
                }
            } catch (Throwable ignored) {
            }
        }

        @JavascriptInterface
        public boolean requestNotificationPermissionJs() {
            try {
                if (Build.VERSION.SDK_INT >= 33) {
                    if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                            == android.content.pm.PackageManager.PERMISSION_GRANTED) {
                        return true;
                    }
                    requestNotificationPermission();
                    return false;
                }
                return true;
            } catch (Throwable ignored) {
                return false;
            }
        }

        // v1.39: battery optimization is the usual reason a
        // download stops when the app is closed: Android (and
        // Samsung's own power management on top of it) kills
        // background processes. Exempting the app lets the
        // foreground service + download thread keep running, like
        // ADM does. This opens the system dialog; the user must
        // tap Allow. Samsung additionally needs "Never sleeping
        // apps" (see the Download Manager note), which Android's
        // exemption alone does not cover.
        @JavascriptInterface
        public boolean isBatteryOptimizationExempt() {
            try {
                android.os.PowerManager pm = (android.os.PowerManager) getSystemService(POWER_SERVICE);
                if (pm == null) return false;
                return pm.isIgnoringBatteryOptimizations(getPackageName());
            } catch (Throwable ignored) {
                return false;
            }
        }

        @JavascriptInterface
        public boolean requestBatteryOptimizationExemption() {
            try {
                android.os.PowerManager pm = (android.os.PowerManager) getSystemService(POWER_SERVICE);
                if (pm != null && pm.isIgnoringBatteryOptimizations(getPackageName())) return true;
                runOnUiThread(() -> {
                    try {
                        Intent intent = new Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                        intent.setData(Uri.parse("package:" + getPackageName()));
                        startActivity(intent);
                    } catch (Throwable e1) {
                        try {
                            startActivity(new Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
                        } catch (Throwable ignored) {
                        }
                    }
                });
                return false;
            } catch (Throwable ignored) {
                return false;
            }
        }

        private void maybePromptBatteryExemptionOnce() {
            try {
                android.content.SharedPreferences sp = getSharedPreferences("kral_downloads", MODE_PRIVATE);
                if (sp.getBoolean("battery_prompt_shown", false)) return;
                sp.edit().putBoolean("battery_prompt_shown", true).apply();
                android.os.PowerManager pm = (android.os.PowerManager) getSystemService(POWER_SERVICE);
                if (pm != null && pm.isIgnoringBatteryOptimizations(getPackageName())) return;
                requestBatteryOptimizationExemption();
            } catch (Throwable ignored) {
            }
        }

        @JavascriptInterface
        public void setDownloadManagerVisible(boolean visible) {
            downloadManagerVisible = visible;
        }

        @JavascriptInterface
        public boolean resumeDownload(long dmId) {
            // v1.37: continue from the bytes already on disk (HTTP
            // Range in DownloadService), not from zero. Old
            // downloads started before v1.37 did not store their
            // stream URL in prefs, so they cannot be resumed and
            // must be started again once.
            try {
                if (dmId < 2000000000L) return false;
                DirectState st = directMap.get(dmId);
                if (st == null) st = directFromPrefs(dmId);
                if (st == null || st.url == null || st.url.isEmpty()
                        || st.fileUri == null || st.fileUri.isEmpty()) return false;
                if ("successful".equals(st.status)) return false;
                String ua = null;
                try {
                    if (webView != null) ua = webView.getSettings().getUserAgentString();
                } catch (Throwable ignored) {
                }
                if (ua == null || ua.isEmpty()) {
                    ua = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";
                }
                st.status = "downloading";
                st.reason = 0;
                st.cancelled = false;
                directMap.put(dmId, st);
                directSavePrefs(st);
                startDownloadService(DownloadService.ACTION_KEEP_ALIVE, st, ua);
                final DirectState rst = st;
                final String rua = ua;
                Thread rth = new Thread(() -> runDirectDownload(rst, rua));
                rst.thread = rth;
                rth.start();
                return true;
            } catch (Throwable ignored) {
                return false;
            }
        }

        private long systemStartDownload(JSONObject o, String url, String title, String type, String label, String quality, String fileName, String folder) {
            try {
                DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
                if (dm == null) return -1;
                DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
                req.setTitle(title.isEmpty() ? fileName : title);
                req.setDescription(label);
                req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE);
                req.setAllowedOverMetered(true);
                req.setAllowedOverRoaming(true);
                req.setAllowedNetworkTypes(DownloadManager.Request.NETWORK_WIFI | DownloadManager.Request.NETWORK_MOBILE);
                req.setRequiresCharging(false);
                req.setRequiresDeviceIdle(false);
                try {
                    if (webView != null) {
                        String ua = webView.getSettings().getUserAgentString();
                        if (ua != null && !ua.isEmpty()) req.addRequestHeader("User-Agent", ua);
                    }
                } catch (Throwable ignored) {
                }
                req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, folder + "/" + fileName);
                long dmId = dm.enqueue(req);
                JSONObject meta = new JSONObject();
                meta.put("title", title);
                meta.put("type", type);
                meta.put("label", label);
                meta.put("quality", quality);
                meta.put("fileName", fileName);
                meta.put("folder", folder);
                downloadPrefs().edit().putString(String.valueOf(dmId), meta.toString()).apply();
                return dmId;
            } catch (Exception e) {
                return -1;
            }
        }

        @JavascriptInterface
        public String getDownloadStatus(long dmId) {
            // Direct downloads first.
            if (dmId >= 2000000000L) {
                try {
                    try {
                        Intent cancel = new Intent(MainActivity.this, DownloadService.class);
                        cancel.setAction(DownloadService.ACTION_CANCEL);
                        cancel.putExtra("id", dmId);
                        startService(cancel);
                    } catch (Throwable ignored) {}
                    DirectState st = directMap.get(dmId);
                    if (st == null) st = directFromPrefs(dmId);
                    if (st == null) return "{}";
                    // v1.37: a "downloading" entry whose prefs have
                    // not been updated for 15 seconds has no live
                    // service thread behind it (app was closed, or
                    // the service died). Report it as paused so the
                    // UI can offer Retry, instead of a frozen
                    // progress bar that can only be deleted.
                    String shownStatus = st.status;
                    boolean resumable = st.url != null && !st.url.isEmpty()
                            && st.downloaded > 0 && st.total > 0 && st.downloaded < st.total;
                    if ("downloading".equals(st.status) && directMap.get(dmId) == null) {
                        long last = st.lastUpdate;
                        if (last <= 0 || System.currentTimeMillis() - last > 15000) {
                            shownStatus = "paused";
                        }
                    }
                    int pct = st.total > 0 ? (int) Math.min(100, st.downloaded * 100 / st.total) : 0;
                    JSONObject out = new JSONObject();
                    out.put("dmId", dmId);
                    out.put("resumable", resumable);
                    out.put("status", shownStatus);
                    out.put("downloaded", st.downloaded);
                    out.put("total", st.total);
                    out.put("percent", pct);
                    out.put("reason", st.reason);
                    out.put("title", st.title == null ? "" : st.title);
                    out.put("type", st.type == null ? "movie" : st.type);
                    out.put("label", st.label == null ? "" : st.label);
                    out.put("quality", st.quality == null ? "" : st.quality);
                    out.put("fileName", st.fileName == null ? "" : st.fileName);
                    out.put("folder", st.folder == null ? "" : st.folder);
                    return out.toString();
                } catch (Exception e) {
                    return "{}";
                }
            }
            try {
                DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
                if (dm == null) return "{}";
                DownloadManager.Query q = new DownloadManager.Query();
                q.setFilterById(dmId);
                Cursor c = dm.query(q);
                if (c == null) return "{}";
                try {
                    if (!c.moveToFirst()) return "{}";
                    int statusIdx = c.getColumnIndex(DownloadManager.COLUMN_STATUS);
                    int bytesIdx = c.getColumnIndex(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR);
                    int totalIdx = c.getColumnIndex(DownloadManager.COLUMN_TOTAL_SIZE_BYTES);
                    int reasonIdx = c.getColumnIndex(DownloadManager.COLUMN_REASON);
                    int status = statusIdx >= 0 ? c.getInt(statusIdx) : 0;
                    long downloaded = bytesIdx >= 0 ? c.getLong(bytesIdx) : 0;
                    long total = totalIdx >= 0 ? c.getLong(totalIdx) : 0;
                    // v1.26: reason tells WHY a download is pending /
                    // paused / failed (waiting for network, HTTP 403,
                    // no space, ...). Without it, every stuck download
                    // just looked like "0%" with no explanation.
                    int reason = reasonIdx >= 0 ? c.getInt(reasonIdx) : 0;
                    String statusStr = "pending";
                    if (status == DownloadManager.STATUS_RUNNING) statusStr = "downloading";
                    else if (status == DownloadManager.STATUS_PAUSED) statusStr = "paused";
                    else if (status == DownloadManager.STATUS_SUCCESSFUL) statusStr = "successful";
                    else if (status == DownloadManager.STATUS_FAILED) statusStr = "failed";
                    int pct = total > 0 ? (int) Math.min(100, downloaded * 100 / total) : 0;
                    JSONObject out = new JSONObject();
                    out.put("dmId", dmId);
                    out.put("status", statusStr);
                    out.put("downloaded", downloaded);
                    out.put("total", total);
                    out.put("percent", pct);
                    out.put("reason", reason);
                    String metaStr = downloadPrefs().getString(String.valueOf(dmId), null);
                    if (metaStr != null) {
                        JSONObject meta = new JSONObject(metaStr);
                        out.put("title", meta.optString("title", ""));
                        out.put("type", meta.optString("type", "movie"));
                        out.put("label", meta.optString("label", ""));
                        out.put("quality", meta.optString("quality", ""));
                        out.put("fileName", meta.optString("fileName", ""));
                        out.put("folder", meta.optString("folder", ""));
                    }
                    return out.toString();
                } finally {
                    c.close();
                }
            } catch (Exception e) {
                return "{}";
            }
        }

        @JavascriptInterface
        public String listDownloads() {
            try {
                JSONArray arr = new JSONArray();
                // Direct downloads (v1.28): from prefs keys.
                try {
                    java.util.Map<String, ?> allPrefs = downloadPrefs().getAll();
                    for (String key : allPrefs.keySet()) {
                        if (!key.startsWith("direct_")) continue;
                        long did;
                        try { did = Long.parseLong(key.substring(7)); } catch (Exception e) { continue; }
                        String sj = getDownloadStatus(did);
                        if (sj == null || sj.equals("{}")) continue;
                        arr.put(new JSONObject(sj));
                    }
                } catch (Throwable ignored) {
                }
                java.util.Map<String, ?> all = downloadPrefs().getAll();
                for (String key : all.keySet()) {
                    long dmId;
                    try { dmId = Long.parseLong(key); } catch (Exception e) { continue; }
                    String statusJson = getDownloadStatus(dmId);
                    if (statusJson == null || statusJson.equals("{}")) continue;
                    arr.put(new JSONObject(statusJson));
                }
                return arr.toString();
            } catch (Exception e) {
                return "[]";
            }
        }

        @JavascriptInterface
        public boolean deleteDownload(long dmId) {
            if (dmId >= 2000000000L) {
                try {
                    DirectState st = directMap.get(dmId);
                    if (st == null) st = directFromPrefs(dmId);
                    if (st != null) {
                        st.cancelled = true;
                        try { if (st.thread != null) st.thread.interrupt(); } catch (Throwable ignored) {}
                        try {
                            if (st.fileUri != null && !st.fileUri.isEmpty()) {
                                if (Build.VERSION.SDK_INT >= 29) {
                                    getContentResolver().delete(Uri.parse(st.fileUri), null, null);
                                } else {
                                    new File(Uri.parse(st.fileUri).getPath()).delete();
                                }
                            }
                        } catch (Throwable ignored) {}
                    }
                    directMap.remove(dmId);
                    downloadPrefs().edit().remove("direct_" + dmId).apply();
                    cancelDownloadNotification(dmId);
                    return true;
                } catch (Exception e) {
                    return false;
                }
            }
            try {
                DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
                if (dm != null) dm.remove(dmId);
                downloadPrefs().edit().remove(String.valueOf(dmId)).apply();
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public boolean playDownloaded(long dmId) {
            if (dmId >= 2000000000L) {
                try {
                    DirectState st = directMap.get(dmId);
                    if (st == null) st = directFromPrefs(dmId);
                    if (st == null || st.fileUri == null || st.fileUri.isEmpty()) return false;
                    if (!"successful".equals(st.status)) return false;
                    Intent intent = new Intent(MainActivity.this, PlayerActivity.class);
                    intent.putExtra("url", st.fileUri);
                    intent.putExtra("title", st.title == null ? "" : st.title);
                    try {
                        if (webView != null) {
                            String ua = webView.getSettings().getUserAgentString();
                            if (ua != null) intent.putExtra("ua", ua);
                        }
                    } catch (Throwable ignored) {
                    }
                    startActivity(intent);
                    return true;
                } catch (Exception e) {
                    return false;
                }
            }
            try {
                DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
                if (dm == null) return false;
                Uri uri = dm.getUriForDownloadedFile(dmId);
                if (uri == null) return false;
                String metaStr = downloadPrefs().getString(String.valueOf(dmId), null);
                String title = "";
                if (metaStr != null) title = new JSONObject(metaStr).optString("title", "");
                Intent intent = new Intent(MainActivity.this, PlayerActivity.class);
                intent.putExtra("url", uri.toString());
                intent.putExtra("title", title);
                try {
                    if (webView != null) {
                        String ua = webView.getSettings().getUserAgentString();
                        if (ua != null) intent.putExtra("ua", ua);
                    }
                } catch (Throwable ignored) {
                }
                startActivity(intent);
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        /** True when a VPN tunnel is the active network (or a tun/ppp
         *  interface is up). Used for the "turn off VPN" warning on
         *  entry, since the API only answers Iranian IPs. */
        @JavascriptInterface
        public boolean isVpnActive() {
            try {
                ConnectivityManager cm =
                        (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
                if (cm != null) {
                    Network net = cm.getActiveNetwork();
                    if (net != null) {
                        NetworkCapabilities caps = cm.getNetworkCapabilities(net);
                        if (caps != null
                                && caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) {
                            return true;
                        }
                    }
                }
            } catch (Exception ignored) {
            }
            try {
                for (NetworkInterface ni :
                        Collections.list(NetworkInterface.getNetworkInterfaces())) {
                    if (!ni.isUp() || ni.isLoopback()) continue;
                    String name = ni.getName().toLowerCase();
                    if (name.startsWith("tun") || name.startsWith("ppp")
                            || name.contains("vpn")) {
                        return true;
                    }
                }
            } catch (Exception ignored) {
            }
            return false;
        }
    }

    private void enterPlayerFullscreen() {
        isPlayerFullscreen = true;
        // The old code only stretched the player inside a portrait
        // activity, so the video stayed vertical. Rotating the whole
        // activity is what actually makes it landscape.
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
        hideSystemBars();
    }

    private void exitPlayerFullscreen() {
        isPlayerFullscreen = false;
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
        showSystemBars();
    }

    private void hideSystemBars() {
        // Hide status bar AND navigation buttons (Back/Home/Recents).
        // They reappear briefly on swipe from the edge, then hide again.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            getWindow().setDecorFitsSystemWindows(false);
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            View decor = getWindow().getDecorView();
            decor.setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
    }

    private void showSystemBars() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            getWindow().setDecorFitsSystemWindows(true);
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                c.show(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
        }
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
    }

    private void notifyPlayerFullscreenExit() {
        if (webView != null) {
            webView.evaluateJavascript(
                    "window.dispatchEvent(new Event('androidFullscreenExit'))", null);
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        webView = findViewById(R.id.webview);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        // Fix for the white screen: Vite ships the app as an ES module
        // loaded from a local file. Without these two flags, Android's WebView
        // blocks module scripts from file:// URLs for CORS reasons, so React
        // never starts and the page stays blank. These flags only apply to
        // files bundled inside this APK, not to remote pages.
        s.setAllowFileAccessFromFileURLs(true);
        s.setAllowUniversalAccessFromFileURLs(true);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        // Smooth scrolling: keep the WebView on the hardware layer
        // (manifest already sets hardwareAccelerated) and let images
        // cache, so scrolling a long poster list does not re-decode
        // on every frame.
        try {
            webView.setLayerType(android.view.View.LAYER_TYPE_HARDWARE, null);
            webView.setOverScrollMode(android.view.View.OVER_SCROLL_IF_CONTENT_SCROLLS);
        } catch (Throwable ignored) {
        }

        webView.addJavascriptInterface(new PlayerBridge(), "AndroidPlayer");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return handleUrl(request.getUrl().toString());
            }

            @Override
            @SuppressWarnings("deprecation")
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handleUrl(url);
            }

            private boolean handleUrl(String url) {
                if (url == null) return false;
                if (url.startsWith("file:///android_asset/")) return false;
                if (url.startsWith("tg://")) {
                    // Telegram deep link: open directly in the Telegram
                    // app, never via the web. Fall back to t.me only
                    // if no app handles tg:// (Telegram not installed).
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                    } catch (ActivityNotFoundException e) {
                        try {
                            startActivity(new Intent(Intent.ACTION_VIEW,
                                    Uri.parse("https://t.me/ProxyArc")));
                        } catch (Exception ignored) {
                        }
                    } catch (Exception ignored) {
                    }
                    return true;
                }
                if (url.startsWith("intent://")) {
                    try {
                        Intent intent = Intent.parseUri(url, Intent.URI_INTENT_SCHEME);
                        startActivity(intent);
                    } catch (ActivityNotFoundException e) {
                        try {
                            Intent intent = Intent.parseUri(url, Intent.URI_INTENT_SCHEME);
                            String fallback = intent.getStringExtra("browser_fallback_url");
                            if (fallback != null) {
                                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(fallback)));
                            }
                        } catch (Exception ignored) {
                        }
                    } catch (Exception ignored) {
                    }
                    return true;
                }
                if (url.startsWith("http://") || url.startsWith("https://")) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                    } catch (Exception ignored) {
                    }
                    return true;
                }
                return false;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (customView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                customView = view;
                customViewCallback = callback;
                FrameLayout decor = (FrameLayout) getWindow().getDecorView();
                fullscreenContainer = new FrameLayout(MainActivity.this);
                fullscreenContainer.addView(view, new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                decor.addView(fullscreenContainer, new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                // A native fullscreen element must also be landscape and
                // immersive, otherwise its controls end up under the nav bar.
                setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
                hideSystemBars();
                webView.setVisibility(View.GONE);
            }

            @Override
            public void onHideCustomView() {
                if (customView == null) return;
                FrameLayout decor = (FrameLayout) getWindow().getDecorView();
                if (fullscreenContainer != null) {
                    decor.removeView(fullscreenContainer);
                    fullscreenContainer = null;
                }
                customView = null;
                if (customViewCallback != null) customViewCallback.onCustomViewHidden();
                customViewCallback = null;
                webView.setVisibility(View.VISIBLE);
                // Keep React in sync and restore portrait + system bars,
                // unless the player bridge already did it (idempotent).
                isPlayerFullscreen = false;
                setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
                showSystemBars();
                notifyPlayerFullscreenExit();
            }
        });

        if (savedInstanceState == null) {
            webView.loadUrl("file:///android_asset/index.html");
        }
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        // Manual rotation: in landscape the nav bar used to overlap the
        // player controls. Keep it hidden in landscape; in portrait,
        // restore it unless the player is fullscreen.
        if (newConfig.orientation == Configuration.ORIENTATION_LANDSCAPE) {
            hideSystemBars();
        } else if (!isPlayerFullscreen) {
            showSystemBars();
        }
    }

    @Override
    public void onBackPressed() {
        if (customView != null) {
            webView.getWebChromeClient().onHideCustomView();
            return;
        }
        if (isPlayerFullscreen) {
            // Exit player fullscreen first, don't close the app.
            exitPlayerFullscreen();
            notifyPlayerFullscreenExit();
            return;
        }
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onPause() {
        activityForeground = false;
        super.onPause();
        try {
            if (webView != null) webView.onPause();
        } catch (Throwable ignored) {
        }
    }

    @Override
    protected void onResume() {
        activityForeground = true;
        super.onResume();
        try {
            if (webView != null) webView.onResume();
        } catch (Throwable ignored) {}
        if (isPlayerFullscreen) hideSystemBars();
    }

    @Override
    protected void onDestroy() {
        try {
            if (webView != null) {
                webView.destroy();
                webView = null;
            }
        } catch (Throwable ignored) {}
        super.onDestroy();
    }
}
