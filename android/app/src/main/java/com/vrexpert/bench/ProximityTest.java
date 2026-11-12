package com.vrexpert.bench;

import android.content.Context;
import android.hardware.Sensor;
import android.hardware.SensorManager;

import java.util.Locale;

/** Checks that the "headset is being worn" sensor is registered. Accuracy needs a manual test. */
final class ProximityTest {
    static Result run(Context c) {
        Result r = new Result("proximity", "Proximity sensor");
        SensorManager sm = (SensorManager) c.getSystemService(Context.SENSOR_SERVICE);
        Sensor p = sm.getDefaultSensor(Sensor.TYPE_PROXIMITY);
        if (p == null) {
            return r.set("na", "Not exposed", "Android does not list a proximity sensor for regular apps. This firmware may keep it private, so it is not a fault.");
        }
        r.metric("max_range", p.getMaximumRange());
        return r.set("ok", "Listed", String.format(Locale.US, "%s, range %.1f.", p.getName(), p.getMaximumRange()));
    }
}
