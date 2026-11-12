package com.vrexpert.bench;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.IBinder;
import android.os.PowerManager;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Runs the suite in the foreground so it keeps going if the headset screen turns off.
 * Start from adb with:
 *   am start-foreground-service -n com.vrexpert.bench/.BenchService --es suite all --ei stress 120
 */
public class BenchService extends Service {
    private static volatile boolean running;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (running) return START_NOT_STICKY;
        running = true;

        String suite = intent != null && intent.getStringExtra("suite") != null ? intent.getStringExtra("suite") : "all";
        final int stress = intent != null ? intent.getIntExtra("stress", 120) : 120;
        final int imu = intent != null ? intent.getIntExtra("imu", 10) : 10;
        final List<String> ids = "all".equals(suite) ? new ArrayList<>(Suite.ALL) : new ArrayList<>(Arrays.asList(suite.split(",")));

        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        nm.createNotificationChannel(new NotificationChannel("bench", "Diagnostics", NotificationManager.IMPORTANCE_LOW));
        Notification n = new Notification.Builder(this, "bench")
                .setContentTitle("VR Expert Bench")
                .setContentText("Running device tests")
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .build();
        startForeground(1, n);

        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        final PowerManager.WakeLock lock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "vrexpert:bench");
        lock.acquire((stress + 600) * 1000L);

        final Context ctx = getApplicationContext();
        new Thread(() -> {
            try {
                Suite.run(ctx, ids, stress, imu);
            } finally {
                if (lock.isHeld()) lock.release();
                running = false;
                stopForeground(true);
                stopSelf();
            }
        }, "vre-suite").start();
        return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
