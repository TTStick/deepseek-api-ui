package io.github.lijiahua1024.dsreplica;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

/**
 * 前台服务：让内置 Tailscale 隧道在 App 退到后台后继续存活。
 *
 * Android 会在应用进入后台后冻结进程，userspace 隧道随之停摆；
 * 以 specialUse 类型的前台服务常驻，可保证后台仍能收发数据（长回复、Agent 任务等）。
 */
public final class TunnelService extends Service {
    static final String ACTION_START = "io.github.lijiahua1024.dsreplica.TUNNEL_START";
    static final String ACTION_STOP = "io.github.lijiahua1024.dsreplica.TUNNEL_STOP";
    private static final String EXTRA_TARGET = "target";
    private static final String EXTRA_HOSTNAME = "hostname";
    private static final int NOTIFICATION_ID = 0x7A11;
    private static final String CHANNEL_ID = "myagent_tunnel";
    private static final long TICK_MS = 3000;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            refreshNotification();
            handler.postDelayed(this, TICK_MS);
        }
    };

    static void start(Context context, String target, String hostname) {
        Intent intent = new Intent(context, TunnelService.class)
            .setAction(ACTION_START)
            .putExtra(EXTRA_TARGET, target)
            .putExtra(EXTRA_HOSTNAME, hostname);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent);
        } else {
            context.startService(intent);
        }
    }

    static void stop(Context context) {
        context.stopService(new Intent(context, TunnelService.class));
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        TsTunnel tunnel = TsTunnel.get(this);
        String target;
        String hostname;
        if (intent != null && ACTION_START.equals(intent.getAction())) {
            target = intent.getStringExtra(EXTRA_TARGET);
            hostname = intent.getStringExtra(EXTRA_HOSTNAME);
            tunnel.rememberTarget(target, hostname);
        } else {
            // 进程被回收后系统按 START_STICKY 重启服务：用上次保存的目标恢复
            target = tunnel.savedTarget();
            hostname = tunnel.savedHostname();
        }
        if (target == null || target.isEmpty()) {
            stopSelf();
            return START_NOT_STICKY;
        }
        tunnel.startCore(null, target, hostname);
        enterForeground();
        handler.removeCallbacks(tick);
        handler.post(tick);
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(tick);
        super.onDestroy();
    }

    private void enterForeground() {
        createChannel();
        Notification notification = buildNotification();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private void createChannel() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null || manager.getNotificationChannel(CHANNEL_ID) != null) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "内置 Tailscale",
            NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("保持 Tailscale 隧道在后台运行");
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);
    }

    private void refreshNotification() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.notify(NOTIFICATION_ID, buildNotification());
        }
    }

    private Notification buildNotification() {
        Intent open = new Intent(this, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pending = PendingIntent.getActivity(this, 0, open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.launcher_whale)
            .setContentTitle("内置 Tailscale")
            .setContentText(TsTunnel.get(this).summary())
            .setContentIntent(pending)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setCategory(Notification.CATEGORY_SERVICE)
            .build();
    }
}
