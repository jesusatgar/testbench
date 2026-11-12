package com.vrexpert.bench;

import android.content.Context;
import android.os.Build;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/** Runs the selected tests one after another and keeps result.json up to date. */
final class Suite {
    static final String TAG = "VREBENCH";
    static final String VERSION = "0.1.0";
    // Stress goes last: it heats the headset and would skew the other tests.
    static final List<String> ALL = Arrays.asList("imu", "proximity", "audio", "storage", "stress");

    static File outputDir(Context c) {
        File d = c.getExternalFilesDir(null);
        return d != null ? d : c.getFilesDir();
    }

    static void run(Context c, List<String> requested, int stressSeconds, int imuSeconds) {
        File dir = outputDir(c);
        List<String> ids = new ArrayList<>();
        for (String id : ALL) if (requested.contains(id)) ids.add(id);

        JSONArray done = new JSONArray();
        long started = System.currentTimeMillis();
        for (int i = 0; i < ids.size(); i++) {
            String id = ids.get(i);
            write(dir, doc(started, "running", id, i, ids.size(), done));
            Log.i(TAG, "start " + id);
            Result r;
            try {
                switch (id) {
                    case "imu": r = ImuTest.run(c, imuSeconds); break;
                    case "proximity": r = ProximityTest.run(c); break;
                    case "audio": r = AudioTest.run(c); break;
                    case "storage": r = StorageTest.run(c); break;
                    default: r = StressTest.run(c, stressSeconds); break;
                }
            } catch (Throwable t) {
                Log.e(TAG, "test crashed: " + id, t);
                r = new Result(id, id).set("na", "", "The test crashed: " + t);
            }
            Log.i(TAG, "done " + id + " " + r.status + " " + r.value);
            done.put(r.json());
        }
        write(dir, doc(started, "done", "", ids.size(), ids.size(), done));
        Log.i(TAG, "all done");
    }

    private static JSONObject doc(long started, String state, String current, int index, int total, JSONArray tests) {
        JSONObject o = new JSONObject();
        try {
            o.put("schema", 1);
            o.put("app", VERSION);
            o.put("state", state);
            o.put("current", current);
            o.put("index", index);
            o.put("total", total);
            o.put("started", started);
            o.put("updated", System.currentTimeMillis());
            JSONObject dev = new JSONObject();
            dev.put("model", Build.MODEL);
            dev.put("manufacturer", Build.MANUFACTURER);
            dev.put("device", Build.DEVICE);
            dev.put("android", Build.VERSION.RELEASE);
            dev.put("sdk", Build.VERSION.SDK_INT);
            dev.put("fingerprint", Build.FINGERPRINT);
            o.put("device", dev);
            o.put("tests", tests);
        } catch (JSONException ignored) {
        }
        return o;
    }

    private static void write(File dir, JSONObject o) {
        File tmp = new File(dir, "result.json.tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(o.toString().getBytes("UTF-8"));
            out.getFD().sync();
        } catch (IOException e) {
            Log.e(TAG, "could not write result", e);
            return;
        }
        if (!tmp.renameTo(new File(dir, "result.json"))) Log.e(TAG, "rename failed");
    }
}
