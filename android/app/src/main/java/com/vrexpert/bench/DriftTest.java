package com.vrexpert.bench;

import android.content.Context;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.Handler;
import android.os.HandlerThread;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Measures how fast the fused orientation turns while the headset lies still.
 * Pico OS hides the raw gyroscope from apps but still exposes the fused rotation vector, and a
 * gyroscope bias shows up there as a steady turn, which is the "headset keeps rotating" symptom.
 */
final class DriftTest {
    // Tunable thresholds in degrees per second.
    static final double DRIFT_WARN = 0.5;
    static final double DRIFT_FAIL = 2.0;
    static final int MIN_SAMPLES = 20;

    static Result run(Context c, int seconds) throws InterruptedException {
        Result r = new Result("drift", "Orientation drift at rest");
        SensorManager sm = (SensorManager) c.getSystemService(Context.SENSOR_SERVICE);
        Sensor s = sm.getDefaultSensor(Sensor.TYPE_GAME_ROTATION_VECTOR);
        String kind = "game rotation vector";
        if (s == null) {
            s = sm.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR);
            kind = "rotation vector";
        }
        if (s == null) {
            return r.set("na", "Not exposed", "Android does not offer a fused orientation sensor to apps on this firmware.");
        }

        final List<double[]> q = new ArrayList<>(); // {time s, x, y, z, w}
        SensorEventListener l = new SensorEventListener() {
            @Override
            public void onSensorChanged(SensorEvent e) {
                double x = e.values[0], y = e.values[1], z = e.values[2];
                double w = e.values.length > 3 ? e.values[3] : Math.sqrt(Math.max(0, 1 - x * x - y * y - z * z));
                double n = Math.sqrt(x * x + y * y + z * z + w * w);
                if (n == 0) return;
                synchronized (q) { q.add(new double[]{e.timestamp / 1e9, x / n, y / n, z / n, w / n}); }
            }

            @Override
            public void onAccuracyChanged(Sensor sensor, int accuracy) {
            }
        };
        HandlerThread ht = new HandlerThread("vre-drift");
        ht.start();
        sm.registerListener(l, s, SensorManager.SENSOR_DELAY_GAME, new Handler(ht.getLooper()));
        Thread.sleep(seconds * 1000L);
        sm.unregisterListener(l);
        ht.quitSafely();

        List<double[]> all;
        synchronized (q) { all = new ArrayList<>(q); }
        // The first second lets the fusion settle.
        double t0 = all.isEmpty() ? 0 : all.get(0)[0];
        List<double[]> d = new ArrayList<>();
        for (double[] v : all) if (v[0] - t0 >= 1.0) d.add(v);
        if (d.size() < MIN_SAMPLES) {
            return r.set("fail", "No data", "The " + kind + " sensor is listed but produced almost no samples.");
        }

        int k = Math.max(3, d.size() / 10);
        double[] first = mean(d.subList(0, k));
        double[] last = mean(d.subList(d.size() - k, d.size()));
        double dt = timeOf(d.subList(d.size() - k, d.size())) - timeOf(d.subList(0, k));
        double net = angle(first, last);
        double path = 0;
        for (int i = 1; i < d.size(); i++) path += angle(d.get(i - 1), d.get(i));
        double drift = dt > 0 ? net / dt : 0;

        r.metric("drift_deg_s", drift).metric("net_deg", net).metric("path_deg", path)
                .metric("samples", d.size()).metric("duration_s", dt);
        String value = String.format(Locale.US, "%.2f °/s", drift);

        // Hand movement wanders back and forth, so the path is much longer than the net turn.
        if (path > Math.max(5.0, 3 * net)) {
            return r.set("na", "Moved", "The headset was moved during the test. Repeat on a still surface.");
        }
        if (drift > DRIFT_FAIL) {
            return r.set("fail", value, "The view turns steadily while the headset is still. This is a gyroscope bias or calibration fault (" + kind + ").");
        }
        if (drift > DRIFT_WARN) {
            return r.set("warn", value, "The view drifts slowly while the headset is still (" + kind + ").");
        }
        return r.set("ok", value, "The orientation stayed steady for " + Math.round(dt) + " s (" + kind + ").");
    }

    private static double timeOf(List<double[]> v) {
        double t = 0;
        for (double[] x : v) t += x[0];
        return t / v.size();
    }

    /** Component-wise mean of quaternions, aligned to the first one's sign and normalised. */
    private static double[] mean(List<double[]> v) {
        double[] ref = v.get(0);
        double[] m = new double[5];
        for (double[] x : v) {
            double sign = dot(ref, x) < 0 ? -1 : 1;
            for (int i = 1; i <= 4; i++) m[i] += sign * x[i];
        }
        double n = Math.sqrt(m[1] * m[1] + m[2] * m[2] + m[3] * m[3] + m[4] * m[4]);
        for (int i = 1; i <= 4; i++) m[i] /= n == 0 ? 1 : n;
        return m;
    }

    private static double dot(double[] a, double[] b) {
        return a[1] * b[1] + a[2] * b[2] + a[3] * b[3] + a[4] * b[4];
    }

    /** Angle in degrees between two orientations. */
    private static double angle(double[] a, double[] b) {
        double d = Math.min(1.0, Math.abs(dot(a, b)));
        return Math.toDegrees(2 * Math.acos(d));
    }
}
