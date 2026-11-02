package com.kralmovie.app;

import android.app.Activity;
import android.content.Context;
import android.content.pm.ActivityInfo;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.RectF;
import android.graphics.drawable.BitmapDrawable;
import android.graphics.drawable.Drawable;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.DisplayMetrics;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.view.SurfaceView;
import android.widget.Button;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.SeekBar;
import android.widget.TextView;

import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.TrackGroup;
import androidx.media3.common.TrackSelectionOverride;
import androidx.media3.common.Tracks;
import androidx.media3.common.text.Cue;
import androidx.media3.common.text.CueGroup;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.exoplayer.trackselection.DefaultTrackSelector;

import org.videolan.libvlc.LibVLC;
import org.videolan.libvlc.Media;
import org.videolan.libvlc.MediaPlayer;

import java.util.ArrayList;
import java.util.List;

/**
 * In-app player, VLC-style UI.
 *
 * Primary engine: libVLC (the engine behind VLC for Android, open
 * source, github.com/videolan/vlc-android). It demuxes MKV itself
 * and renders embedded subtitles on the video surface, exactly
 * like the VLC app does.
 *
 * Fallback engine: ExoPlayer, with the same UI, if libVLC cannot
 * load on this device or fails on the stream. ExoPlayer gets the
 * browser User-Agent and, on a source error, one automatic retry
 * over plain http (the same downgrade that made the external VLC
 * app work against this CDN's certificate).
 */
public class PlayerActivity extends Activity {

    private SurfaceView surfaceView;
    private SurfaceView subtitleSurface;
    private TextView subtitleView;
    private TextView titleView;
    private TextView timeView;
    private TextView timeTotalView;
    private TextView errorView;
    private LinearLayout gestureBox;
    private ImageView gestureIcon;
    private TextView gestureText;
    private LinearLayout errorBox;
    private View loadingBox;
    private TextView loadingText;
    private int loadingDots = 0;
    private final Runnable loadingDotsRunnable = new Runnable() {
        @Override
        public void run() {
            if (loadingText != null && loadingBox != null
                    && loadingBox.getVisibility() == View.VISIBLE) {
                loadingDots = (loadingDots + 1) % 4;
                StringBuilder dots = new StringBuilder();
                for (int i = 0; i < loadingDots; i++) dots.append(".");
                loadingText.setText("در حال بارگذاری فیلم" + dots.toString());
                handler.postDelayed(this, 500);
            }
        }
    };
    private SeekBar seekBar;
    private ImageButton playPauseButton;
    private Button ccButton;
    private View topBar;
    private View controlsBar;

    // Gestures (VLC-style)
    private AudioManager audioManager;
    private float downX, downY;
    private int startVolume, maxVolume;
    private float startBrightness = -1f;
    private int gestureMode = 0; // 0 none, 1 volume, 2 brightness, 3 seek
    private boolean gestureLeftSide;
    private long gestureSeekTarget = -1;
    private long lastTapTime = 0;
    private float lastTapX = 0;
    private final Runnable hideGestureRunnable = () -> {
        if (gestureBox != null) gestureBox.setVisibility(View.GONE);
    };
    private int aspectIndex = 0;
    private int lastVideoW = 0;
    private int lastVideoH = 0;
    private int lastSarNum = 0;
    private int lastSarDen = 0;
    // Pinch zoom: 1.0 = the current aspect mode's size. Pinching
    // with two fingers scales the surface around its centre; the
    // parent FrameLayout clips the overflow, so zooming in crops
    // the edges instead of stretching the picture.
    private float zoomScale = 1f;
    private boolean pinching = false;
    private float pinchStartDist = 0f;
    private float pinchBaseZoom = 1f;
    // Bug fix for pinch-then-seek: Android does NOT send a new
    // ACTION_DOWN for the finger that stays down after the other
    // finger lifts (ACTION_POINTER_UP). Without this flag, that
    // finger's later movement is measured from the original
    // downX/downY and becomes a horizontal seek, so a pinch
    // would also jump the film forward/backward. While this is
    // set, all moves are swallowed until a fresh ACTION_DOWN.
    private boolean gestureSuppressed = false;
    // v1.35: scale resolved lazily, only when VLC is playing.
    private MediaPlayer.ScaleType vlcScaleFor(int index) {
        switch (index) {
            case 1: return MediaPlayer.ScaleType.SURFACE_FILL;
            case 2: return MediaPlayer.ScaleType.SURFACE_16_9;
            case 3: return MediaPlayer.ScaleType.SURFACE_4_3;
            case 4: return MediaPlayer.ScaleType.SURFACE_BEST_FIT;
            default: return MediaPlayer.ScaleType.SURFACE_BEST_FIT;
        }
    }

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable progressRunnable = new Runnable() {
        @Override
        public void run() {
            updateProgress();
            handler.postDelayed(this, 500);
        }
    };
    private final Runnable hideControlsRunnable = new Runnable() {
        @Override
        public void run() {
            setControlsVisible(false);
        }
    };

    private boolean controlsVisible = true;
    private boolean subtitlesOn = true;
    private boolean seeking = false;

    private String originalUrl;
    private String userAgent;

    // libVLC
    private LibVLC vlcLib;
    private MediaPlayer vlcPlayer;
    // v1.37: for a downloaded film (content:// from MediaStore),
    // VLC must be given a file descriptor, not the content Uri
    // string — libVLC cannot open content:// as a network location.
    // Kept open until releaseVlc() and closed there.
    private android.content.res.AssetFileDescriptor contentFd;
    private boolean useVlc = false;
    private boolean triedHttpVlc = false;

    // ExoPlayer fallback
    private ExoPlayer exoPlayer;
    private DefaultTrackSelector trackSelector;
    private boolean triedHttpExo = false;
    private boolean exoStarted = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        try {
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
        } catch (Throwable ignored) {
        }
        setContentView(R.layout.activity_player);
        try {
            hideSystemBars();
        } catch (Throwable ignored) {
        }

        originalUrl = getIntent().getStringExtra("url");
        String title = getIntent().getStringExtra("title");
        userAgent = getIntent().getStringExtra("ua");
        if (originalUrl == null || originalUrl.isEmpty()) {
            finish();
            return;
        }

        surfaceView = findViewById(R.id.player_surface);
        subtitleSurface = findViewById(R.id.player_subtitle_surface);
        subtitleView = findViewById(R.id.player_subtitle);
        titleView = findViewById(R.id.player_title);
        timeView = findViewById(R.id.player_time);
        timeTotalView = findViewById(R.id.player_time_total);
        errorView = findViewById(R.id.player_error);
        gestureBox = findViewById(R.id.player_gesture);
        gestureIcon = findViewById(R.id.player_gesture_icon);
        gestureText = findViewById(R.id.player_gesture_text);
        errorBox = findViewById(R.id.player_error_box);
        loadingBox = findViewById(R.id.player_loading);
        loadingText = findViewById(R.id.player_loading_text);
        seekBar = findViewById(R.id.player_seekbar);
        playPauseButton = findViewById(R.id.player_play_pause);
        ccButton = findViewById(R.id.player_cc);
        topBar = findViewById(R.id.player_topbar);
        controlsBar = findViewById(R.id.player_controls);
        try {
            subtitleSurface.getHolder().setFormat(PixelFormat.TRANSLUCENT);
            subtitleSurface.setZOrderMediaOverlay(true);
        } catch (Throwable ignored) {
        }
        try {
            audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
            if (audioManager != null) {
                maxVolume = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
            }
        } catch (Throwable ignored) {
        }

        if (title != null) titleView.setText(title);

        findViewById(R.id.player_root).setOnTouchListener((v, event) -> onPlayerTouch(event));
        findViewById(R.id.player_close).setOnClickListener(v -> finish());
        playPauseButton.setOnClickListener(v -> {
            togglePlayPause();
            resetHideTimer();
        });
        findViewById(R.id.player_back10).setOnClickListener(v -> seekBy(-10000));
        findViewById(R.id.player_forward10).setOnClickListener(v -> seekBy(10000));
        ccButton.setOnClickListener(v -> toggleSubtitles());
        findViewById(R.id.player_aspect).setOnClickListener(v -> cycleAspect());
        findViewById(R.id.player_retry).setOnClickListener(v -> retryPlayback());

        seekBar.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override
            public void onProgressChanged(SeekBar sb, int progress, boolean fromUser) {
                if (fromUser) {
                    long dur = getDuration();
                    if (dur > 0) {
                        long pos = progress * dur / 1000;
                        timeView.setText(formatTime(pos));
                        timeTotalView.setText(formatTime(dur));
                    }
                }
            }

            @Override
            public void onStartTrackingTouch(SeekBar sb) {
                seeking = true;
                handler.removeCallbacks(hideControlsRunnable);
            }

            @Override
            public void onStopTrackingTouch(SeekBar sb) {
                seeking = false;
                long dur = getDuration();
                if (dur > 0) seekTo(sb.getProgress() * dur / 1000);
                resetHideTimer();
            }
        });

        showLoading();
        startVlc(originalUrl);
    }

    // ---------- Loading animation ----------

    private void showLoading() {
        try {
            if (loadingBox != null) loadingBox.setVisibility(View.VISIBLE);
            loadingDots = 0;
            handler.removeCallbacks(loadingDotsRunnable);
            handler.post(loadingDotsRunnable);
        } catch (Throwable ignored) {
        }
    }

    private void hideLoading() {
        try {
            handler.removeCallbacks(loadingDotsRunnable);
            if (loadingBox != null) loadingBox.setVisibility(View.GONE);
        } catch (Throwable ignored) {
        }
    }

    // ---------- libVLC ----------

    private void startVlc(String url) {
        releaseExo();
        useVlc = true;
        showLoading();
        try {
            ArrayList<String> options = new ArrayList<>();
            options.add("--no-video-title-show");
            options.add("--network-caching=5000");
            options.add("--no-stats");
            if (userAgent != null && !userAgent.isEmpty()) {
                options.add("--http-user-agent=" + userAgent);
            }
            vlcLib = new LibVLC(this, options);
            vlcPlayer = new MediaPlayer(vlcLib);
            vlcPlayer.getVLCVout().setVideoView(surfaceView);
            try {
                vlcPlayer.getVLCVout().setSubtitlesView(subtitleSurface);
            } catch (Throwable ignored) {
            }
            vlcPlayer.getVLCVout().attachViews(
                    (vout, width, height, visibleWidth, visibleHeight, sarNum, sarDen) ->
                            runOnUiThread(() -> onNewVideoLayout(
                                    visibleWidth, visibleHeight, sarNum, sarDen)));
            vlcPlayer.setEventListener(event -> runOnUiThread(() -> onVlcEvent(event)));
            Media media = null;
            if (url != null && url.startsWith("content://")) {
                try {
                    contentFd = getContentResolver().openAssetFileDescriptor(Uri.parse(url), "r");
                    if (contentFd != null) {
                        media = new Media(vlcLib, contentFd.getFileDescriptor());
                    }
                } catch (Throwable ignored) {
                    media = null;
                }
            }
            if (media == null) {
                media = new Media(vlcLib, Uri.parse(url));
            }
            vlcPlayer.setMedia(media);
            media.release();
            vlcPlayer.play();
            subtitleView.setVisibility(View.GONE);
        } catch (Throwable t) {
            // libVLC unavailable on this device/ABI: fall back.
            startExo(originalUrl);
        }
    }

    private void onVlcEvent(MediaPlayer.Event event) {
        if (event == null) return;
        switch (event.type) {
            case MediaPlayer.Event.Opening:
                showLoading();
                break;
            case MediaPlayer.Event.Buffering:
                if (event.getBuffering() < 100f) showLoading();
                else hideLoading();
                break;
            case MediaPlayer.Event.Playing:
                hideLoading();
                hideError();
                handler.removeCallbacks(progressRunnable);
                handler.post(progressRunnable);
                resetHideTimer();
                if (subtitlesOn) selectVlcSubtitles();
                break;
            case MediaPlayer.Event.Paused:
            case MediaPlayer.Event.Stopped:
            case MediaPlayer.Event.EndReached:
                hideLoading();
                updatePlayButton();
                break;
            case MediaPlayer.Event.LengthChanged:
                updateProgress();
                break;
            case MediaPlayer.Event.EncounteredError:
                onVlcError();
                break;
            default:
                break;
        }
        updatePlayButton();
    }

    private void onVlcError() {
        if (!triedHttpVlc && originalUrl.startsWith("https://")) {
            triedHttpVlc = true;
            releaseVlc();
            startVlc(originalUrl.replaceFirst("^https://", "http://"));
            return;
        }
        // libVLC cannot play this stream: try ExoPlayer next.
        if (!exoStarted) {
            releaseVlc();
            startExo(originalUrl);
            return;
        }
        showError("پخش با VLC ناموفق بود. علت: خطای منبع (Source error)");
    }

    private void selectVlcSubtitles() {
        if (vlcPlayer == null) return;
        try {
            if (vlcPlayer.getSpuTrack() != -1) return;
            MediaPlayer.TrackDescription[] tracks = vlcPlayer.getSpuTracks();
            if (tracks == null) return;
            int chosen = -1;
            for (MediaPlayer.TrackDescription t : tracks) {
                if (t == null || t.id == -1) continue;
                if (chosen == -1) chosen = t.id;
                String n = t.name == null ? "" : t.name.toLowerCase();
                if (n.contains("fa") || n.contains("per") || n.contains("fas")
                        || n.contains("persian") || n.contains("فارسی")) {
                    chosen = t.id;
                    break;
                }
            }
            if (chosen != -1) vlcPlayer.setSpuTrack(chosen);
        } catch (Throwable ignored) {
        }
    }

    private void releaseVlc() {
        try {
            if (contentFd != null) contentFd.close();
        } catch (Throwable ignored) {
        }
        contentFd = null;
        try {
            if (vlcPlayer != null) {
                vlcPlayer.stop();
                vlcPlayer.getVLCVout().detachViews();
                vlcPlayer.release();
            }
        } catch (Throwable ignored) {
        }
        vlcPlayer = null;
        try {
            if (vlcLib != null) vlcLib.release();
        } catch (Throwable ignored) {
        }
        vlcLib = null;
        useVlc = false;
    }

    // ---------- ExoPlayer fallback ----------

    private void startExo(String url) {
        exoStarted = true;
        useVlc = false;
        showLoading();
        subtitleView.setVisibility(View.GONE);
        try {
            trackSelector = new DefaultTrackSelector(this);
            try {
                DefaultTrackSelector.Parameters params =
                        new DefaultTrackSelector.Parameters.Builder()
                                .setPreferredTextLanguage("fa")
                                .setSelectUndeterminedTextLanguage(true)
                                .build();
                trackSelector.setParameters(params);
            } catch (Throwable ignored) {
            }
            // v1.37: a downloaded film is content://, and the HTTP
            // data source cannot open it (MalformedURLException:
            // unknown protocol: content, code 2001). Use the default
            // data source for content://, which reads via the
            // ContentResolver; keep the HTTP factory (with the
            // browser UA) for http/https streams.
            androidx.media3.datasource.DataSource.Factory dataFactory;
            if (url != null && url.startsWith("content://")) {
                dataFactory = new androidx.media3.datasource.DefaultDataSource.Factory(this);
            } else {
                DefaultHttpDataSource.Factory httpFactory = new DefaultHttpDataSource.Factory()
                        .setAllowCrossProtocolRedirects(true)
                        .setConnectTimeoutMs(15000)
                        .setReadTimeoutMs(15000);
                if (userAgent != null && !userAgent.isEmpty()) {
                    httpFactory.setUserAgent(userAgent);
                }
                dataFactory = httpFactory;
            }
            exoPlayer = new ExoPlayer.Builder(this)
                    .setTrackSelector(trackSelector)
                    .setMediaSourceFactory(new DefaultMediaSourceFactory(dataFactory))
                    .build();
            exoPlayer.setVideoSurfaceView(surfaceView);
            exoPlayer.addListener(new Player.Listener() {
                @Override
                public void onCues(CueGroup cueGroup) {
                    if (cueGroup != null) showCues(cueGroup.cues);
                }

                @Override
                public void onCues(List<Cue> cues) {
                    showCues(cues);
                }

                @Override
                public void onPlaybackStateChanged(int state) {
                    updatePlayButton();
                    if (state == Player.STATE_BUFFERING) {
                        showLoading();
                    } else if (state == Player.STATE_READY) {
                        hideLoading();
                        hideError();
                        handler.post(progressRunnable);
                        resetHideTimer();
                    } else if (state == Player.STATE_IDLE || state == Player.STATE_ENDED) {
                        hideLoading();
                    }
                }

                @Override
                public void onIsPlayingChanged(boolean isPlaying) {
                    updatePlayButton();
                    if (isPlaying) resetHideTimer();
                }

                @Override
                public void onVideoSizeChanged(
                        androidx.media3.common.VideoSize videoSize) {
                    lastVideoW = videoSize.width;
                    lastVideoH = videoSize.height;
                    lastSarNum = 0;
                    lastSarDen = 0;
                    applyVideoLayout();
                }

                @Override
                public void onTracksChanged(Tracks tracks) {
                    if (subtitlesOn) selectExoSubtitles(tracks);
                }

                @Override
                public void onPlayerError(PlaybackException error) {
                    onExoError(error);
                }
            });
            exoPlayer.setMediaItem(MediaItem.fromUri(url));
            exoPlayer.prepare();
            exoPlayer.play();
        } catch (Throwable t) {
            showError("پلیر راه‌اندازی نشد: " + t.getClass().getSimpleName()
                    + " - " + t.getMessage());
        }
    }

    private void onExoError(PlaybackException error) {
        if (!triedHttpExo && originalUrl.startsWith("https://")) {
            triedHttpExo = true;
            releaseExo();
            startExo(originalUrl.replaceFirst("^https://", "http://"));
            return;
        }
        StringBuilder detail = new StringBuilder("خطا در پخش: ");
        detail.append(error.getMessage() == null ? "Source error" : error.getMessage());
        detail.append(" (کد ").append(error.errorCode).append(")");
        Throwable cause = error.getCause();
        int depth = 0;
        while (cause != null && depth < 3) {
            detail.append(" / ").append(cause.getClass().getSimpleName());
            if (cause.getMessage() != null) detail.append(": ").append(cause.getMessage());
            cause = cause.getCause();
            depth++;
        }
        showError(detail.toString());
    }

    private void selectExoSubtitles(Tracks tracks) {
        if (trackSelector == null) return;
        try {
            TrackGroup chosenGroup = null;
            int chosenIndex = 0;
            boolean alreadySelected = false;
            for (Tracks.Group group : tracks.getGroups()) {
                if (group.getType() != C.TRACK_TYPE_TEXT) continue;
                if (group.isSelected()) {
                    alreadySelected = true;
                    break;
                }
                TrackGroup mediaGroup = group.getMediaTrackGroup();
                if (chosenGroup == null) {
                    chosenGroup = mediaGroup;
                    chosenIndex = 0;
                }
                for (int i = 0; i < mediaGroup.length; i++) {
                    String lang = mediaGroup.getFormat(i).language;
                    if (lang != null && (lang.equals("fa") || lang.equals("fas")
                            || lang.equals("per") || lang.equals("persian"))) {
                        chosenGroup = mediaGroup;
                        chosenIndex = i;
                        break;
                    }
                }
            }
            if (alreadySelected || chosenGroup == null) return;
            DefaultTrackSelector.Parameters.Builder b =
                    trackSelector.getParameters().buildUpon();
            b.clearOverridesOfType(C.TRACK_TYPE_TEXT);
            b.setOverrideForType(new TrackSelectionOverride(chosenGroup, chosenIndex));
            trackSelector.setParameters(b.build());
        } catch (Throwable ignored) {
        }
    }

    private void releaseExo() {
        try {
            if (exoPlayer != null) exoPlayer.release();
        } catch (Throwable ignored) {
        }
        exoPlayer = null;
        trackSelector = null;
    }

    private void showCues(List<Cue> cues) {
        if (useVlc || !subtitlesOn || cues == null || cues.isEmpty()) {
            subtitleView.setVisibility(View.GONE);
            return;
        }
        StringBuilder sb = new StringBuilder();
        for (Cue cue : cues) {
            if (cue.text == null) continue;
            String text = cue.text.toString().replaceAll("\\{[^}]*\\}", "").trim();
            if (text.isEmpty()) continue;
            if (sb.length() > 0) sb.append("\n");
            sb.append(text);
        }
        if (sb.length() == 0) {
            subtitleView.setVisibility(View.GONE);
        } else {
            subtitleView.setText(sb.toString());
            subtitleView.setVisibility(View.VISIBLE);
        }
    }

    // ---------- Shared controls ----------

    private void retryPlayback() {
        hideError();
        if (useVlc || vlcPlayer != null) {
            // Retry the other engine / http variant next.
            if (!exoStarted) {
                releaseVlc();
                startExo(originalUrl);
            } else {
                releaseVlc();
                releaseExo();
                exoStarted = false;
                triedHttpVlc = false;
                triedHttpExo = false;
                startVlc(originalUrl);
            }
        } else {
            releaseExo();
            exoStarted = false;
            triedHttpExo = false;
            startExo(originalUrl);
        }
    }

    private void togglePlayPause() {
        if (useVlc && vlcPlayer != null) {
            if (vlcPlayer.isPlaying()) vlcPlayer.pause();
            else vlcPlayer.play();
        } else if (exoPlayer != null) {
            if (exoPlayer.isPlaying()) exoPlayer.pause();
            else exoPlayer.play();
        }
        updatePlayButton();
    }

    private void seekBy(long deltaMs) {
        long pos = getCurrentPosition();
        long dur = getDuration();
        long next = pos + deltaMs;
        if (next < 0) next = 0;
        if (dur > 0 && next > dur) next = dur;
        seekTo(next);
    }

    private void seekTo(long pos) {
        if (useVlc && vlcPlayer != null) vlcPlayer.setTime(pos);
        else if (exoPlayer != null) exoPlayer.seekTo(pos);
        updateProgress();
    }

    private long getCurrentPosition() {
        if (useVlc && vlcPlayer != null) return vlcPlayer.getTime();
        if (exoPlayer != null) return exoPlayer.getCurrentPosition();
        return 0;
    }

    private long getDuration() {
        if (useVlc && vlcPlayer != null) {
            long len = vlcPlayer.getLength();
            return len > 0 ? len : 0;
        }
        if (exoPlayer != null) {
            long dur = exoPlayer.getDuration();
            return dur > 0 ? dur : 0;
        }
        return 0;
    }

    private boolean isPlaying() {
        if (useVlc && vlcPlayer != null) return vlcPlayer.isPlaying();
        if (exoPlayer != null) return exoPlayer.isPlaying();
        return false;
    }

    private void toggleSubtitles() {
        subtitlesOn = !subtitlesOn;
        ccButton.setBackgroundResource(subtitlesOn
                ? R.drawable.player_btn_cc_on : R.drawable.player_btn_cc_off);
        if (useVlc && vlcPlayer != null) {
            try {
                if (!subtitlesOn) vlcPlayer.setSpuTrack(-1);
                else selectVlcSubtitles();
            } catch (Throwable ignored) {
            }
        } else if (exoPlayer != null && trackSelector != null) {
            try {
                DefaultTrackSelector.Parameters.Builder b =
                        trackSelector.getParameters().buildUpon();
                if (!subtitlesOn) {
                    b.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true);
                } else {
                    b.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false);
                    b.clearOverridesOfType(C.TRACK_TYPE_TEXT);
                }
                trackSelector.setParameters(b.build());
                if (subtitlesOn) selectExoSubtitles(exoPlayer.getCurrentTracks());
            } catch (Throwable ignored) {
            }
        }
        if (!subtitlesOn) subtitleView.setVisibility(View.GONE);
        resetHideTimer();
    }

    private void updatePlayButton() {
        playPauseButton.setImageResource(isPlaying()
                ? R.drawable.ic_pause : R.drawable.ic_play);
    }

    private void updateProgress() {
        long pos = getCurrentPosition();
        long dur = getDuration();
        timeView.setText(formatTime(pos));
        timeTotalView.setText(formatTime(dur));
        if (!seeking && dur > 0) {
            seekBar.setProgress((int) (pos * 1000 / dur));
        }
        updatePlayButton();
    }

    private void toggleControls() {
        setControlsVisible(!controlsVisible);
    }

    private void setControlsVisible(boolean visible) {
        controlsVisible = visible;
        topBar.setVisibility(visible ? View.VISIBLE : View.GONE);
        controlsBar.setVisibility(visible ? View.VISIBLE : View.GONE);
        int marginPx = dpToPx(visible ? 170 : 32);
        if (subtitleView.getVisibility() == View.VISIBLE) {
            FrameLayout.LayoutParams lp =
                    (FrameLayout.LayoutParams) subtitleView.getLayoutParams();
            lp.bottomMargin = marginPx;
            subtitleView.setLayoutParams(lp);
        }
        try {
            FrameLayout.LayoutParams slp =
                    (FrameLayout.LayoutParams) subtitleSurface.getLayoutParams();
            slp.bottomMargin = marginPx;
            subtitleSurface.setLayoutParams(slp);
        } catch (Throwable ignored) {
        }
        if (visible) resetHideTimer();
    }

    private int dpToPx(int dp) {
        return Math.round(dp * getResources().getDisplayMetrics().density);
    }

    // Centre the video with its true aspect ratio. Without this,
    // libVLC can leave the picture sitting low with a large black
    // area below it after the portrait -> landscape rotation.
    private void onNewVideoLayout(int visibleWidth, int visibleHeight,
                                  int sarNum, int sarDen) {
        lastVideoW = visibleWidth;
        lastVideoH = visibleHeight;
        lastSarNum = sarNum;
        lastSarDen = sarDen;
        applyVideoLayout();
    }

    // Apply the current aspect mode to the video surface. This is
    // what was missing before: cycleAspect only changed the libVLC
    // scale flag, while this listener kept resizing the surface
    // back to BestFit, so the picture never actually changed.
    private void applyVideoLayout() {
        try {
            DisplayMetrics dm = getResources().getDisplayMetrics();
            int screenW = dm.widthPixels;
            int screenH = dm.heightPixels;
            int w, h;
            if (aspectIndex == 1) {
                // Fill: whole screen, libVLC stretches to the surface.
                w = screenW;
                h = screenH;
            } else {
                double targetAspect;
                if (aspectIndex == 2) {
                    targetAspect = 16.0 / 9.0;
                } else if (aspectIndex == 3) {
                    targetAspect = 4.0 / 3.0;
                } else if (lastVideoW > 0 && lastVideoH > 0) {
                    targetAspect = (double) lastVideoW / lastVideoH;
                    if (lastSarNum > 0 && lastSarDen > 0) {
                        targetAspect = targetAspect * lastSarNum / lastSarDen;
                    }
                } else {
                    return;
                }
                double screenAspect = (double) screenW / screenH;
                if (aspectIndex == 4) {
                    // Fullscreen: cover the whole screen, no black
                    // bars. Scale up until both dimensions cover the
                    // screen, then centre-crop the overflow.
                    if (targetAspect > screenAspect) {
                        h = screenH;
                        w = (int) (screenH * targetAspect);
                    } else {
                        w = screenW;
                        h = (int) (screenW / targetAspect);
                    }
                } else if (targetAspect > screenAspect) {
                    w = screenW;
                    h = (int) (screenW / targetAspect);
                } else {
                    h = screenH;
                    w = (int) (screenH * targetAspect);
                }
            }
            // Pinch zoom: scale the fitted/cover size around the
            // centre. The FrameLayout clips the overflow, so this
            // crops rather than stretches. Zoom is kept when the
            // video layout changes (e.g. rotation).
            if (zoomScale > 1f) {
                w = (int) (w * zoomScale);
                h = (int) (h * zoomScale);
            }
            FrameLayout.LayoutParams lp =
                    (FrameLayout.LayoutParams) surfaceView.getLayoutParams();
            lp.width = w;
            lp.height = h;
            lp.gravity = android.view.Gravity.CENTER;
            surfaceView.setLayoutParams(lp);
        } catch (Throwable ignored) {
        }
    }

    // True when the current size leaves no black bars: the surface
    // covers the whole screen in both dimensions.
    private boolean isCoveringScreen() {
        try {
            DisplayMetrics dm = getResources().getDisplayMetrics();
            FrameLayout.LayoutParams lp =
                    (FrameLayout.LayoutParams) surfaceView.getLayoutParams();
            return lp.width >= dm.widthPixels && lp.height >= dm.heightPixels;
        } catch (Throwable ignored) {
            return false;
        }
    }

    private void applyAspect() {
        try {
            if (useVlc && vlcPlayer != null) {
                vlcPlayer.setVideoScale(vlcScaleFor(aspectIndex));
            }
        } catch (Throwable ignored) {
        }
        try {
            if (!useVlc && exoPlayer != null) {
                exoPlayer.setVideoScalingMode(aspectIndex == 1 || aspectIndex == 4
                        ? C.VIDEO_SCALING_MODE_SCALE_TO_FIT_WITH_CROPPING
                        : C.VIDEO_SCALING_MODE_SCALE_TO_FIT);
            }
        } catch (Throwable ignored) {
        }
        applyVideoLayout();
    }

    private void cycleAspect() {
        aspectIndex = (aspectIndex + 1) % 5;
        // A tapped aspect mode is exact: clear any manual pinch zoom.
        zoomScale = 1f;
        applyAspect();
        String[] names = {"متناسب", "پر کردن صفحه", "۱۶:۹", "۴:۳", "فول‌اسکرین"};
        showGesture(names[aspectIndex]);
        resetHideTimer();
    }

    private float pinchDistance(MotionEvent event) {
        if (event.getPointerCount() < 2) return 0f;
        float dx = event.getX(0) - event.getX(1);
        float dy = event.getY(0) - event.getY(1);
        return (float) Math.sqrt(dx * dx + dy * dy);
    }

    private void showGesture(int iconRes, String text) {
        gestureIcon.setImageResource(iconRes);
        gestureText.setText(text);
        gestureBox.setVisibility(View.VISIBLE);
        handler.removeCallbacks(hideGestureRunnable);
        handler.postDelayed(hideGestureRunnable, 1200);
    }

    private void showGesture(String text) {
        showGesture(R.drawable.ic_fullscreen, text);
    }

    private void showGestureDrawable(Drawable icon, String text) {
        gestureIcon.setImageDrawable(icon);
        gestureText.setText(text);
        gestureBox.setVisibility(View.VISIBLE);
        handler.removeCallbacks(hideGestureRunnable);
        handler.postDelayed(hideGestureRunnable, 1200);
    }

    // Sun drawn in code, not a static icon: first the whole sun in
    // grey, then the same sun in yellow clipped to the bottom
    // portion that matches the brightness. At 50% exactly the
    // bottom half is yellow and the top half stays grey; at low
    // brightness only a small yellow sliver at the bottom shows.
    private Drawable brightnessIcon(float brightness01) {
        int s = 256;
        Bitmap bmp = Bitmap.createBitmap(s, s, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(bmp);
        Paint grey = new Paint(Paint.ANTI_ALIAS_FLAG);
        grey.setColor(Color.parseColor("#AAAAAA"));
        grey.setStyle(Paint.Style.FILL);
        grey.setStrokeWidth(14);
        grey.setStrokeCap(Paint.Cap.ROUND);
        Paint yellow = new Paint(Paint.ANTI_ALIAS_FLAG);
        yellow.setColor(Color.parseColor("#FFC107"));
        yellow.setStyle(Paint.Style.FILL);
        yellow.setStrokeWidth(14);
        yellow.setStrokeCap(Paint.Cap.ROUND);
        drawSun(c, grey);
        if (brightness01 > 0) {
            c.save();
            float top = s * (1f - brightness01);
            c.clipRect(0, top, s, s);
            drawSun(c, yellow);
            c.restore();
        }
        return new BitmapDrawable(getResources(), bmp);
    }

    private void drawSun(Canvas c, Paint p) {
        float cx = 128, cy = 128;
        // Rays first (stroke), then the disc (fill).
        Paint stroke = new Paint(p);
        stroke.setStyle(Paint.Style.STROKE);
        for (int i = 0; i < 8; i++) {
            double a = Math.toRadians(i * 45);
            float x1 = (float) (cx + Math.cos(a) * 82);
            float y1 = (float) (cy + Math.sin(a) * 82);
            float x2 = (float) (cx + Math.cos(a) * 112);
            float y2 = (float) (cy + Math.sin(a) * 112);
            c.drawLine(x1, y1, x2, y2, stroke);
        }
        Paint fill = new Paint(p);
        fill.setStyle(Paint.Style.FILL);
        c.drawCircle(cx, cy, 58, fill);
    }

    // Speaker drawn in code: one, two or three parenthesis waves
    // for low / half / high volume. At 0% there are no waves at
    // all, just the speaker with a red slash across it.
    private Drawable volumeIcon(int percent) {
        int s = 256;
        Bitmap bmp = Bitmap.createBitmap(s, s, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(bmp);
        Paint white = new Paint(Paint.ANTI_ALIAS_FLAG);
        white.setColor(Color.WHITE);
        white.setStyle(Paint.Style.FILL);
        // Speaker body: small rectangle + triangle cone.
        Path speaker = new Path();
        speaker.moveTo(36, 104);
        speaker.lineTo(88, 104);
        speaker.lineTo(140, 62);
        speaker.lineTo(140, 194);
        speaker.lineTo(88, 152);
        speaker.lineTo(36, 152);
        speaker.close();
        c.drawPath(speaker, white);
        if (percent <= 0) {
            Paint red = new Paint(Paint.ANTI_ALIAS_FLAG);
            red.setColor(Color.parseColor("#FF3B30"));
            red.setStyle(Paint.Style.STROKE);
            red.setStrokeWidth(16);
            red.setStrokeCap(Paint.Cap.ROUND);
            c.drawLine(28, 28, 228, 228, red);
            return new BitmapDrawable(getResources(), bmp);
        }
        int waves = percent <= 33 ? 1 : (percent <= 66 ? 2 : 3);
        Paint wave = new Paint(Paint.ANTI_ALIAS_FLAG);
        wave.setColor(Color.WHITE);
        wave.setStyle(Paint.Style.STROKE);
        wave.setStrokeWidth(13);
        wave.setStrokeCap(Paint.Cap.ROUND);
        // Three parenthesis arcs, smallest first.
        RectF[] arcs = {
                new RectF(148, 88, 198, 168),
                new RectF(168, 68, 228, 188),
                new RectF(188, 48, 248, 208),
        };
        for (int i = 0; i < waves; i++) {
            c.drawArc(arcs[i], -55, 110, false, wave);
        }
        return new BitmapDrawable(getResources(), bmp);
    }

    // VLC-style gestures on the video area. Buttons and the seek
    // bar still receive their own touches; this listener is only
    // on the root frame, and child views consume their touches
    // first, so a tap on a button does not become a gesture.
    private boolean onPlayerTouch(MotionEvent event) {
        switch (event.getActionMasked()) {
            case MotionEvent.ACTION_POINTER_DOWN: {
                // Second finger: start a pinch zoom and cancel any
                // single-finger volume/brightness/seek gesture, so a
                // pinch never turns into a seek or volume change.
                if (event.getPointerCount() >= 2) {
                    float d = pinchDistance(event);
                    if (d > 0) {
                        pinching = true;
                        gestureSuppressed = false;
                        pinchStartDist = d;
                        pinchBaseZoom = zoomScale;
                        gestureMode = 0;
                        gestureSeekTarget = -1;
                    }
                }
                return true;
            }
            case MotionEvent.ACTION_POINTER_UP: {
                if (pinching) {
                    pinching = false;
                    gestureMode = 0;
                    gestureSeekTarget = -1;
                    // The remaining finger has no fresh ACTION_DOWN
                    // coming: swallow its moves until it lifts and
                    // touches again, so pinch never becomes a seek.
                    gestureSuppressed = true;
                }
                return true;
            }
            case MotionEvent.ACTION_DOWN:
                downX = event.getX();
                downY = event.getY();
                gestureMode = 0;
                gestureSuppressed = false;
                pinching = false;
                gestureSeekTarget = -1;
                gestureLeftSide = downX < getResources().getDisplayMetrics().widthPixels / 2f;
                try {
                    if (audioManager != null) {
                        startVolume = audioManager.getStreamVolume(AudioManager.STREAM_MUSIC);
                    }
                    WindowManager.LayoutParams lp = getWindow().getAttributes();
                    startBrightness = lp.screenBrightness;
                    if (startBrightness < 0) {
                        int sys = Settings.System.getInt(getContentResolver(),
                                Settings.System.SCREEN_BRIGHTNESS, 128);
                        startBrightness = sys / 255f;
                    }
                } catch (Throwable ignored) {
                }
                return true;
            case MotionEvent.ACTION_MOVE: {
                if (pinching) {
                    // Two-finger pinch: spread = zoom in, pinch in =
                    // zoom out. 1.0x to 3.0x, centred and cropped.
                    // When the zoomed picture covers the whole
                    // screen there are no black bars left, so that
                    // is reported as fullscreen.
                    if (event.getPointerCount() >= 2 && pinchStartDist > 0) {
                        float ratio = pinchDistance(event) / pinchStartDist;
                        float z = pinchBaseZoom * ratio;
                        if (z < 1f) z = 1f;
                        if (z > 3f) z = 3f;
                        zoomScale = z;
                        applyVideoLayout();
                        if (isCoveringScreen()) {
                            showGesture(R.drawable.ic_fullscreen, "فول‌اسکرین");
                        } else {
                            showGesture(R.drawable.ic_fullscreen,
                                    "زوم " + Math.round(zoomScale * 100) + "٪");
                        }
                    }
                    return true;
                }
                if (gestureSuppressed) {
                    // Finger left over from a finished pinch:
                    // only size may change during a pinch, never
                    // seek/volume/brightness after it.
                    return true;
                }
                float dx = event.getX() - downX;
                float dy = event.getY() - downY;
                int screenW = getResources().getDisplayMetrics().widthPixels;
                int screenH = getResources().getDisplayMetrics().heightPixels;
                if (gestureMode == 0) {
                    if (Math.abs(dy) > 30 && Math.abs(dy) > Math.abs(dx)) {
                        gestureMode = gestureLeftSide ? 2 : 1;
                    } else if (Math.abs(dx) > 30 && Math.abs(dx) > Math.abs(dy)) {
                        gestureMode = 3;
                    } else {
                        return true;
                    }
                }
                if (gestureMode == 1 && audioManager != null && maxVolume > 0) {
                    int vol = (int) (startVolume - dy / screenH * maxVolume);
                    if (vol < 0) vol = 0;
                    if (vol > maxVolume) vol = maxVolume;
                    audioManager.setStreamVolume(AudioManager.STREAM_MUSIC, vol, 0);
                    showGestureDrawable(volumeIcon(vol * 100 / maxVolume), (vol * 100 / maxVolume) + "٪");
                } else if (gestureMode == 2) {
                    float b = startBrightness - dy / screenH;
                    if (b < 0.05f) b = 0.05f;
                    if (b > 1f) b = 1f;
                    WindowManager.LayoutParams lp = getWindow().getAttributes();
                    lp.screenBrightness = b;
                    getWindow().setAttributes(lp);
                    showGestureDrawable(brightnessIcon(b), Math.round(b * 100) + "٪");
                } else if (gestureMode == 3) {
                    long dur = getDuration();
                    if (dur > 0) {
                        long target = getCurrentPosition() + (long) (dx / screenW * dur);
                        if (target < 0) target = 0;
                        if (target > dur) target = dur;
                        gestureSeekTarget = target;
                        showGesture(dx >= 0 ? R.drawable.ic_fast_forward : R.drawable.ic_rewind,
                                formatTime(target) + " / " + formatTime(dur));
                    }
                }
                return true;
            }
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_CANCEL: {
                if (pinching) {
                    // End of a pinch is not a tap: keep the zoom and
                    // do not toggle controls or seek.
                    pinching = false;
                    gestureMode = 0;
                    return true;
                }
                if (gestureSuppressed) {
                    // Lift of the finger left over from a pinch:
                    // not a tap, not a seek, just the end of it.
                    gestureSuppressed = false;
                    gestureMode = 0;
                    gestureSeekTarget = -1;
                    return true;
                }
                if (gestureMode == 3 && gestureSeekTarget >= 0) {
                    seekTo(gestureSeekTarget);
                } else if (gestureMode == 0) {
                    // Tap (or double-tap): single tap toggles
                    // controls, double-tap on a side seeks ±10s.
                    long now = System.currentTimeMillis();
                    if (now - lastTapTime < 350) {
                        if (lastTapX < getResources().getDisplayMetrics().widthPixels / 2f) {
                            seekBy(-10000);
                            showGesture(R.drawable.ic_rewind, "۱۰ ثانیه");
                        } else {
                            seekBy(10000);
                            showGesture(R.drawable.ic_fast_forward, "۱۰ ثانیه");
                        }
                        lastTapTime = 0;
                    } else {
                        toggleControls();
                        lastTapTime = now;
                        lastTapX = event.getX();
                    }
                }
                gestureMode = 0;
                return true;
            }
            default:
                return true;
        }
    }

    private void resetHideTimer() {
        handler.removeCallbacks(hideControlsRunnable);
        if (isPlaying()) handler.postDelayed(hideControlsRunnable, 3000);
    }

    private void showError(String msg) {
        hideLoading();
        errorView.setText(msg);
        errorBox.setVisibility(View.VISIBLE);
        setControlsVisible(true);
    }

    private void hideError() {
        errorBox.setVisibility(View.GONE);
    }

    private void hideSystemBars() {
        // Edge-to-edge, including the display cutout: without
        // SHORT_EDGES, Android keeps the video below / beside the
        // punch-hole selfie camera and leaves a black strip there,
        // even though the screen beside the camera is usable.
        // SHORT_EDGES lets the video draw into the cutout area on
        // the short edges (landscape left/right), so fullscreen
        // really is the whole panel, camera hole included.
        try {
            if (Build.VERSION.SDK_INT >= 28) {
                WindowManager.LayoutParams lp = getWindow().getAttributes();
                lp.layoutInDisplayCutoutMode =
                        WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
                getWindow().setAttributes(lp);
            }
        } catch (Throwable ignored) {
        }
        if (Build.VERSION.SDK_INT >= 30) {
            try {
                getWindow().setDecorFitsSystemWindows(false);
            } catch (Throwable ignored) {
            }
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                c.setSystemBarsBehavior(
                        WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                            | View.SYSTEM_UI_FLAG_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        }
    }

    private static String formatTime(long ms) {
        long total = ms / 1000;
        long h = total / 3600;
        long m = (total % 3600) / 60;
        long s = total % 60;
        if (h > 0) return String.format("%02d:%02d:%02d", h, m, s);
        return String.format("%02d:%02d", m, s);
    }

    @Override
    protected void onPause() {
        super.onPause();
        try {
            if (useVlc && vlcPlayer != null && vlcPlayer.isPlaying()) vlcPlayer.pause();
            else if (exoPlayer != null && exoPlayer.isPlaying()) exoPlayer.pause();
        } catch (Throwable ignored) {
        }
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        releaseVlc();
        releaseExo();
        super.onDestroy();
    }
}
