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

/** Accelerometer and gyroscope check. The headset must lie still. */
final class ImuTest {
    // Tunable thresholds.
    static final double MOVING_GYRO_STD = 0.03;   // rad/s: above this the headset was moved
    static final double MOVING_ACC_STD = 0.20;    // m/s^2
    static final double GRAVITY_TOLERANCE = 0.8;  // m/s^2 around 9.81
    static final double GYRO_BIAS_WARN = 0.05;    // rad/s (about 2.9 deg/s)
    static final double GYRO_BIAS_FAIL = 0.15;
    static final double MIN_RATE_HZ = 50;

    static Result run(Context c, int seconds) throws InterruptedException {
        Result r = new Result("imu", "Motion sensors (IMU)");
        SensorManager sm = (SensorManager) c.getSystemService(Context.SENSOR_SERVICE);
        Sensor acc = sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
        Sensor gyr = sm.getDefaultSensor(Sensor.TYPE_GYROSCOPE);
        if (acc == null || gyr == null) {
            String lost = acc == null && gyr == null ? "accelerometer and gyroscope"
                    : acc == null ? "accelerometer" : "gyroscope";
            return r.set("fail", "Missing", "The system does not list: " + lost + ".");
        }

        final List<float[]> a = new ArrayList<>();
        final List<float[]> g = new ArrayList<>();
        SensorEventListener l = new SensorEventListener() {
            @Override
            public void onSensorChanged(SensorEvent e) {
                float[] v = new float[]{e.values[0], e.values[1], e.values[2]};
                if (e.sensor.getType() == Sensor.TYPE_ACCELEROMETER) {
                    synchronized (a) { a.add(v); }
                } else {
                    synchronized (g) { g.add(v); }
                }
            }

            @Override
            public void onAccuracyChanged(Sensor s, int accuracy) {
            }
        };
        HandlerThread ht = new HandlerThread("vre-imu");
        ht.start();
        Handler h = new Handler(ht.getLooper());
        sm.registerListener(l, acc, SensorManager.SENSOR_DELAY_FASTEST, h);
        sm.registerListener(l, gyr, SensorManager.SENSOR_DELAY_FASTEST, h);
        Thread.sleep(seconds * 1000L);
        sm.unregisterListener(l);
        ht.quitSafely();

        double[] sa, sg;
        synchronized (a) { sa = stats(a); }
        synchronized (g) { sg = stats(g); }
        int na = a.size(), ng = g.size();
        double accRate = na / (double) seconds, gyrRate = ng / (double) seconds;
        double accMag = sa[3], accNoise = sa[4], gyrBias = sg[3], gyrNoise = sg[4];

        r.metric("accel_rate_hz", accRate).metric("gyro_rate_hz", gyrRate)
                .metric("accel_magnitude", accMag).metric("accel_noise", accNoise)
                .metric("gyro_bias_rad_s", gyrBias).metric("gyro_noise_rad_s", gyrNoise);

        if (na == 0 || ng == 0) {
            return r.set("fail", "No data", "A sensor is listed but produced no samples.");
        }
        if (gyrNoise > MOVING_GYRO_STD || accNoise > MOVING_ACC_STD) {
            return r.set("na", "Moved", "The headset was moving during the test. Repeat on a still surface.");
        }
        String value = String.format(Locale.US, "gravity %.2f m/s², gyro bias %.3f rad/s", accMag, gyrBias);
        if (gyrBias > GYRO_BIAS_FAIL) {
            return r.set("fail", value, "Gyroscope bias is very high at rest. The IMU is likely faulty.");
        }
        if (gyrBias > GYRO_BIAS_WARN) {
            return r.set("warn", value, "Gyroscope bias is high at rest. Expect view drift.");
        }
        if (Math.abs(accMag - 9.81) > GRAVITY_TOLERANCE) {
            return r.set("warn", value, "Accelerometer does not read 9.81 m/s² at rest. Calibration may be off.");
        }
        if (accRate < MIN_RATE_HZ || gyrRate < MIN_RATE_HZ) {
            return r.set("warn", value, String.format(Locale.US,
                    "Low sampling rate (accel %.0f Hz, gyro %.0f Hz).", accRate, gyrRate));
        }
        return r.set("ok", value, String.format(Locale.US,
                "Sampling at %.0f Hz (accel) and %.0f Hz (gyro), low noise at rest.", accRate, gyrRate));
    }

    /** Returns {meanX, meanY, meanZ, |mean|, noise} where noise is the combined standard deviation. */
    static double[] stats(List<float[]> s) {
        int n = s.size();
        if (n == 0) return new double[]{0, 0, 0, 0, 0};
        double mx = 0, my = 0, mz = 0;
        for (float[] v : s) { mx += v[0]; my += v[1]; mz += v[2]; }
        mx /= n; my /= n; mz /= n;
        double vx = 0, vy = 0, vz = 0;
        for (float[] v : s) {
            vx += (v[0] - mx) * (v[0] - mx);
            vy += (v[1] - my) * (v[1] - my);
            vz += (v[2] - mz) * (v[2] - mz);
        }
        double noise = Math.sqrt((vx + vy + vz) / n);
        return new double[]{mx, my, mz, Math.sqrt(mx * mx + my * my + mz * mz), noise};
    }
}
