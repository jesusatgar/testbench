package com.vrexpert.bench;

import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.BatteryManager;
import android.os.Build;
import android.os.PowerManager;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.Locale;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/** Loads every CPU core while logging temperature, thermal status and throughput. */
final class StressTest {
    // Tunable thresholds. Battery temperature in tenths of a degree.
    static final int TEMP_WARN = 450;
    static final int TEMP_FAIL = 550;
    static final int TEMP_ABORT = 600;       // the test stops early for safety
    static final double THROTTLE_WARN = 0.5; // throughput lost between start and end
    static final int WINDOW_SECONDS = 5;

    private static volatile double sink;

    static Result run(Context c, int seconds) throws InterruptedException {
        Result r = new Result("stress", "CPU stress and throttling");
        Intent b0 = battery(c);
        int temp0 = b0.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0);
        int level0 = b0.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
        boolean plugged = b0.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) != 0;
        if (level0 >= 0 && level0 < 20 && !plugged) {
            return r.set("na", "", "Battery is below 20% and not charging. Charge it before the stress test.");
        }
        if (temp0 >= TEMP_WARN) {
            return r.set("na", "", String.format(Locale.US, "Battery is already at %.1f °C. Let it cool down first.", temp0 / 10.0));
        }

        final AtomicBoolean stop = new AtomicBoolean(false);
        int cores = Runtime.getRuntime().availableProcessors();
        final AtomicLong[] counters = new AtomicLong[cores];
        Thread[] workers = new Thread[cores];
        for (int i = 0; i < cores; i++) {
            final AtomicLong counter = new AtomicLong();
            counters[i] = counter;
            workers[i] = new Thread(() -> {
                double x = 0.5;
                while (!stop.get()) {
                    for (int k = 0; k < 20000; k++) x = Math.sin(x) * Math.cos(x) + Math.sqrt(x * x + 1.0);
                    sink = x;
                    counter.incrementAndGet();
                }
            }, "vre-stress-" + i);
            workers[i].start();
        }

        JSONArray samples = new JSONArray();
        PowerManager pm = (PowerManager) c.getSystemService(Context.POWER_SERVICE);
        long prev = 0;
        int maxTemp = temp0, maxThermal = 0, levelEnd = level0;
        boolean aborted = false;
        double[] perf = new double[Math.max(1, seconds / WINDOW_SECONDS)];
        int windows = 0;
        try {
            for (int w = 0; w < perf.length; w++) {
                Thread.sleep(WINDOW_SECONDS * 1000L);
                long total = 0;
                for (AtomicLong ct : counters) total += ct.get();
                perf[w] = (total - prev) / (double) WINDOW_SECONDS;
                prev = total;
                windows = w + 1;

                Intent b = battery(c);
                int temp = b.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0);
                levelEnd = b.getIntExtra(BatteryManager.EXTRA_LEVEL, levelEnd);
                int thermal = Build.VERSION.SDK_INT >= 29 ? pm.getCurrentThermalStatus() : 0;
                maxTemp = Math.max(maxTemp, temp);
                maxThermal = Math.max(maxThermal, thermal);
                try {
                    JSONObject s = new JSONObject();
                    s.put("t", (w + 1) * WINDOW_SECONDS);
                    s.put("perf", Math.round(perf[w]));
                    s.put("temp_c", temp / 10.0);
                    s.put("thermal", thermal);
                    samples.put(s);
                } catch (JSONException ignored) {
                }
                if (temp >= TEMP_ABORT) {
                    aborted = true;
                    break;
                }
            }
        } finally {
            stop.set(true);
            for (Thread t : workers) t.join(2000);
        }

        double first = windows >= 4 ? (perf[0] + perf[1]) / 2 : perf[0];
        double last = windows >= 4 ? (perf[windows - 1] + perf[windows - 2]) / 2 : perf[windows - 1];
        double drop = first > 0 ? 1 - last / first : 0;
        r.metric("duration_s", windows * WINDOW_SECONDS).metric("cores", cores)
                .metric("max_battery_temp_c", maxTemp / 10.0).metric("temp_rise_c", (maxTemp - temp0) / 10.0)
                .metric("max_thermal_status", maxThermal).metric("throughput_drop", drop)
                .metric("battery_start", level0).metric("battery_end", levelEnd)
                .metric("plugged", plugged ? 1 : 0);
        try {
            r.metrics.put("samples", samples);
        } catch (JSONException ignored) {
        }

        String value = String.format(Locale.US, "max %.1f °C, throughput −%.0f%%", maxTemp / 10.0, Math.max(0, drop) * 100);
        if (aborted) {
            return r.set("fail", value, String.format(Locale.US, "Stopped early: battery reached %.1f °C.", maxTemp / 10.0));
        }
        if (maxTemp >= TEMP_FAIL || maxThermal >= 3) {
            return r.set("fail", value, "Severe heating or thermal throttling under load.");
        }
        if (maxTemp >= TEMP_WARN || maxThermal >= 2 || drop > THROTTLE_WARN) {
            String why = drop > THROTTLE_WARN ? "Performance dropped sharply under load, which suggests thermal throttling."
                    : "The headset runs hot under load.";
            return r.set("warn", value, why);
        }
        return r.set("ok", value, String.format(Locale.US, "Held steady for %d s on %d cores.", windows * WINDOW_SECONDS, cores));
    }

    private static Intent battery(Context c) {
        return c.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
    }
}
