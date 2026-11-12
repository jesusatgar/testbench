package com.vrexpert.bench;

import org.json.JSONException;
import org.json.JSONObject;

/** Outcome of one test. status is one of: ok, warn, fail, na (could not run). */
final class Result {
    final String id;
    final String name;
    String status = "na";
    String value = "";
    String detail = "";
    final JSONObject metrics = new JSONObject();

    Result(String id, String name) {
        this.id = id;
        this.name = name;
    }

    Result set(String status, String value, String detail) {
        this.status = status;
        this.value = value;
        this.detail = detail;
        return this;
    }

    Result metric(String key, double v) {
        try {
            if (Double.isNaN(v) || Double.isInfinite(v)) metrics.put(key, JSONObject.NULL);
            else metrics.put(key, Math.round(v * 1000.0) / 1000.0);
        } catch (JSONException ignored) {
        }
        return this;
    }

    JSONObject json() {
        JSONObject o = new JSONObject();
        try {
            o.put("id", id);
            o.put("name", name);
            o.put("status", status);
            o.put("value", value);
            o.put("detail", detail);
            o.put("metrics", metrics);
        } catch (JSONException ignored) {
        }
        return o;
    }
}
