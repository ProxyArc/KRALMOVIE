package com.kralmovie.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;

import java.util.concurrent.ConcurrentHashMap;

/**
 * v1.38: keep-alive foreground service ONLY.
 *
 * v1.37 moved the actual HTTP download into this service and
 * downloads stopped working (stuck at "connecting", then Retry).
 * The exact service-start failure could not be reproduced from
 * this VM, so v1.38 restores the proven v1.36 download path —
 * a plain thread in MainActivity — and uses this service only
 * for what a service is actually needed for: keeping the
 * process alive after the UI is closed, so that thread keeps
 * running in the background, plus holding the foreground
 * notification slot. If this service fails to start, the
 * download still works while the app is open (v1.36 behaviour);
 * only the background continuation is lost, instead of the
 * whole download. Progress notifications themselves are posted
 * by MainActivity's download thread, not by this service.
 */
public class DownloadService extends Service {

    public static final String ACTION_KEEP_ALIVE = "com.kralmovie.app.KEEP_ALIVE";
    public static final String ACTION_CANCEL = "com.kralmovie.app.CANCEL_DOWNLOAD";
    // Kept for compatibility with v1.37 callers; treated as keep-alive.
    public static final String ACTION_START = "com.kralmovie.app.START_DOWNLOAD";
    public static final String ACTION_RESUME = "com.kralmovie.app.RESUME_DOWNLOAD";

    public static final String CHANNEL_ID = "kral_downloads";

    private final ConcurrentHashMap<Long, String> alive = new ConcurrentHashMap<>();

    @Override
    public void onCreate() {
        super.onCreate();
        if (Build.VERSION.SDK_INT >= 26) {
            try {
                NotificationChannel ch = new NotificationChannel(
                        CHANNEL_ID, "دانلودهای کرال‌مووی",
                        NotificationManager.IMPORTANCE_LOW);
                ch.setDescription("پیشرفت دانلود فیلم‌ها و سریال‌ها");
                NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
                if (nm != null) nm.createNotificationChannel(ch);
            } catch (Throwable ignored) {
            }
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) return START_NOT_STICKY;
        String action = intent.getAction();
        long id = intent.getLongExtra("id", -1);
        if (ACTION_CANCEL.equals(action)) {
            if (id > 0) {
                alive.remove(id);
                try {
                    NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
                    if (nm != null) nm.cancel((int) id);
                } catch (Throwable ignored) {}
            }
            if (alive.isEmpty()) {
                try { stopForeground(true); } catch (Throwable ignored) {}
                stopSelf();
            }
            return START_NOT_STICKY;
        }
        if (id <= 0) return START_NOT_STICKY;
        String title = intent.getStringExtra("title");
        if (title == null || title.isEmpty()) title = "در حال دانلود";
        alive.put(id, title);
        try {
            Notification n = new NotificationCompat.Builder(this, CHANNEL_ID)
                    .setSmallIcon(android.R.drawable.stat_sys_download)
                    .setContentTitle(title)
                    .setContentText("در حال دانلود…")
                    .setOngoing(true)
                    .setOnlyAlertOnce(true)
                    .setProgress(100, 0, false)
                    .build();
            startForeground((int) id, n);
        } catch (Throwable ignored) {
            // Keep-alive failed: the MainActivity download thread
            // still runs while the app is open, so this is not
            // fatal for the download itself.
        }
        return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
