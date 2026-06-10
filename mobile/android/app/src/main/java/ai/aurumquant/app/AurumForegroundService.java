package ai.aurumquant.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import androidx.core.app.NotificationCompat;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * True foreground service (Spotify-style). Shows a permanent, ongoing notification
 * with the LIVE price and the STRICT rule-engine decision. Survives in the
 * background far more reliably than WorkManager because of the ongoing notification.
 *
 * Notification content is intentionally minimal:
 *   Title : "BUY @ 4175.20"  |  "SELL @ 4175.20"  |  "HOLD @ 4175.20"
 *   Text  : "TP 4185.00  ·  SL 4168.00"  (or "No trade — waiting" for HOLD)
 */
public class AurumForegroundService extends Service {

    public static final String CHANNEL_ID = "aurum_monitor";
    public static final int NOTIF_ID = 4242;
    public static final String CHANNEL_ID_ALERTS = "aurum_alerts";

    private static final long INTERVAL_MS = 30_000L; // refresh every 30s

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private volatile boolean running = false;
    private String lastAction = "HOLD";

    @Override
    public void onCreate() {
        super.onCreate();
        createChannels();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (!running) {
            running = true;
            startForeground(NOTIF_ID, buildNotification("Aurum Quant AI", "Starting monitor…", false));
            loop.run();
        }
        return START_STICKY; // ask Android to restart us if killed
    }

    private final Runnable loop = new Runnable() {
        @Override
        public void run() {
            io.execute(() -> {
                final RuleEngine.Decision d = RuleEngine.evaluate(getApplicationContext());
                handler.post(() -> updateUi(d));
            });
            if (running) handler.postDelayed(this, INTERVAL_MS);
        }
    };

    private void updateUi(RuleEngine.Decision d) {
        String price = Double.isNaN(d.price) ? "—" : fmt(d.price);
        String title;
        String text;

        if (!d.dataOk) {
            title = "Aurum — no data";
            text = d.note;
        } else if ("BUY".equals(d.action) || "SELL".equals(d.action)) {
            title = d.action + " @ " + price;
            text = "TP " + fmt(d.tp) + "  ·  SL " + fmt(d.sl);
        } else {
            title = "HOLD @ " + price;
            text = "No trade — waiting for setup";
        }

        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(NOTIF_ID, buildNotification(title, text, false));

        // Fire a separate (dismissable, heads-up) alert ONLY when the decision
        // changes into an actionable BUY/SELL — so you get pinged on a new signal.
        if (("BUY".equals(d.action) || "SELL".equals(d.action)) && !d.action.equals(lastAction)) {
            if (nm != null) {
                nm.notify((int) (System.currentTimeMillis() % 100000),
                        buildAlert(d.action + " SIGNAL @ " + price, "TP " + fmt(d.tp) + "  ·  SL " + fmt(d.sl)));
            }
        }
        if (d.dataOk) lastAction = d.action;
    }

    private Notification buildNotification(String title, String text, boolean alertOnce) {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(
                this, 0, open,
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                        ? PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
                        : PendingIntent.FLAG_UPDATE_CURRENT);

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth) // placeholder system icon
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
                .setOngoing(true)            // permanent / non-dismissable
                .setOnlyAlertOnce(true)      // don't buzz on every 30s refresh
                .setContentIntent(pi)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .build();
    }

    private Notification buildAlert(String title, String text) {
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(
                this, 1, open,
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                        ? PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
                        : PendingIntent.FLAG_UPDATE_CURRENT);
        return new NotificationCompat.Builder(this, CHANNEL_ID_ALERTS)
                .setSmallIcon(android.R.drawable.stat_notify_chat)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
                .setAutoCancel(true)
                .setContentIntent(pi)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_RECOMMENDATION)
                .build();
    }

    private void createChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            NotificationChannel monitor = new NotificationChannel(
                    CHANNEL_ID, "Aurum Monitor", NotificationManager.IMPORTANCE_LOW);
            monitor.setDescription("Permanent live price + rule-engine decision");
            monitor.setShowBadge(false);
            nm.createNotificationChannel(monitor);

            NotificationChannel alerts = new NotificationChannel(
                    CHANNEL_ID_ALERTS, "Aurum Signals", NotificationManager.IMPORTANCE_HIGH);
            alerts.setDescription("New BUY/SELL signal alerts");
            nm.createNotificationChannel(alerts);
        }
    }

    private static String fmt(double v) {
        if (Double.isNaN(v)) return "—";
        return String.format(java.util.Locale.US, "%.2f", v);
    }

    @Override
    public void onDestroy() {
        running = false;
        handler.removeCallbacksAndMessages(null);
        io.shutdownNow();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
