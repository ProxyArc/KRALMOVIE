# KRALMOVIE | پادشاه فیلم و سریال

سورس برنامه KRALMOVIE — اپلیکیشن فارسی (RTL) تماشای فیلم و سریال، ساخته‌شده با React 19 و Vite، به همراه پوسته اندروید (WebView) و پلیر بومی اندروید.

نسخه اندروید منتشرشده تا اینجا: **v1.12** — پلیر بومی با libVLC 3.6.0 (موتور اصلی) و Media3 ExoPlayer 1.4.1 (موتور جایگزین)، با زیرنویس فارسی داخل MKV، ژست‌های شبیه VLC (نور/صدا/سییک)، دکمه نسبت ابعاد، و دکمه عضویت در کانال تلگرام با پروتکل `tg://`.

## ساختار

```
app/        # سورس وب (React + Vite)
  src/      # App.tsx, components/PlayerView.tsx, DetailsView.tsx, ...
  public/
  index.html, package.json, vite.config.ts, tsconfig.json
android/    # پوسته اندروید (بیلد دستی، بدون Gradle)
  AndroidManifest.xml
  src/com/kralmovie/app/   # MainActivity.java (WebView + پل AndroidPlayer)
                           # PlayerActivity.java (پلیر بومی libVLC / ExoPlayer)
  res/                     # layout ها، آیکون‌های برداری پلیر، آیکون برنامه
  assets/www/index.html    # خروجی وب اینلاین‌شده که WebView بار می‌کند
  libs/                    # Media3 1.4.1، libvlc 3.6.0 و وابستگی‌ها (jar/aar)
tools/
  resolve_media3.py        # دانلود وابستگی‌های Media3 از Google Maven
```

## اجرای نسخه وب

```bash
cd app
npm install
npm run dev      # http://localhost:3000
npm run build    # خروجی در app/dist
```

## ساخت APK اندروید (بیلد دستی)

بیلد با JDK 17 و Android SDK (build-tools 34.0.0، platform android-34) و ابزارهای `aapt2` و `d8` انجام می‌شود؛ Gradle ندارد.

1. وب را با `npm run build -- --base=./` بسازید و تنها فایل JS و CSS خروجی را داخل `android/assets/www/index.html` اینلاین کنید (WebView اسکریپت‌های ES Module را از `file://` بار نمی‌کند).
2. فایل‌های بومی libVLC را از AAR رسمی `org.videolan.android:libvlc-all:3.6.0` استخراج کنید و در `android/lib/arm64-v8a/` و `android/lib/armeabi-v7a/` بگذارید (`libvlc.so`، `libvlcjni.so`، `libc++_shared.so`). این فایل‌های باینری در این ریپو نیستند.
3. منابع برنامه و منابع کتابخانه‌ها (core، media3-exoplayer، lifecycle-runtime) را با `aapt2 compile` و `aapt2 link --extra-packages androidx.media3.exoplayer --extra-packages androidx.lifecycle.runtime --extra-packages androidx.core` لینک کنید تا کلاس‌های `R` کتابخانه‌ها ساخته شوند (نبودنشان در نسخه‌های اولیه باعث کرش بود).
4. سورس‌های جاوا + فایل‌های `R.java` ساخته‌شده را با `javac -encoding UTF-8` کامپایل و با `d8 --min-api 24` به dex تبدیل کنید.
5. `classes.dex` و پوشه `lib/` را در APK بگذارید، با `zipalign` مرتب کنید و با keystore خودتان با `apksigner` امضا کنید.

نکته‌ها:

- Package: `com.kralmovie.app` — minSdk 24، targetSdk 34.
- پلیر بومی: libVLC اول امتحان می‌شود؛ اگر بار نشد یا خطا داد، ExoPlayer با همان رابط کاربری جایگزین می‌شود. هر دو مسیر در خطای منبع، یک بار https را به http برمی‌گردانند.
- صفحه انتخاب کیفیت در برنامه اندروید فقط کیفیت‌ها را نشان می‌دهد؛ پلیر HTML قدیمی فقط در مرورگر معمولی (بدون پل AndroidPlayer) به‌عنوان جایگزین باقی مانده است.

## چیزهایی که در این ریپو نیست (عمدی)

- **فایل امضا (keystore) و رمزهای آن** — برای ساخت نسخه قابل نصب روی نسخه‌های قبلی، باید keystore خودتان را بسازید و نگه دارید. هرگز keystore را در گیت‌هاب عمومی نگذارید.
- فایل‌های بیلد (`build/`، `dist/`)، `node_modules/`، فایل APK و کتابخانه‌های بومی `.so` (قابل دانلود از AAR رسمی libVLC).
- کلیدهای API واقعی — فایل `app/.env.example` فقط نمونه است.

## مجوزها و منابع

- پلیر VLC برای اندروید متن‌باز است: https://github.com/videolan/vlc-android — رابط کاربری پلیر این برنامه شبیه VLC طراحی شده، بدون نام و برند VLC.
- فیلم‌ها و لینک‌های پخش از API خارجی دریافت می‌شوند و در این ریپو نیستند.
