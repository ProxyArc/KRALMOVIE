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
import android.widget.FrameLayout;

public class MainActivity extends Activity {
    private WebView webView;
    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;
    private FrameLayout fullscreenContainer;
    private boolean isPlayerFullscreen = false;

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

        /** Launch the strong native ExoPlayer activity for in-app
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

        @JavascriptInterface
        public void playNative(String url, String title) {
            runOnUiThread(() -> {
                try {
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
        super.onPause();
        if (webView != null) webView.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
        if (isPlayerFullscreen) hideSystemBars();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
