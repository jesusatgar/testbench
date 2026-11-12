package com.vrexpert.bench;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Typeface;
import android.os.Bundle;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;

/** Minimal screen for running the tests by hand. Normally the web tool starts the service over adb. */
public class MainActivity extends Activity {
    private TextView out;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        int pad = (int) (24 * getResources().getDisplayMetrics().density);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(pad, pad, pad, pad);

        TextView title = new TextView(this);
        title.setText("VR Expert Bench");
        title.setTextSize(22);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        root.addView(title);

        TextView hint = new TextView(this);
        hint.setText("Put the headset on a still surface, keep it above 30% or plugged in, then run the tests. "
                + "The results are read by the VR Expert Diagnostics web page.");
        root.addView(hint);

        Button run = new Button(this);
        run.setText("Run all tests");
        run.setOnClickListener(v -> {
            Intent i = new Intent(this, BenchService.class);
            i.putExtra("suite", "all");
            startForegroundService(i);
            out.setText("Started. Results are written to result.json.");
        });
        root.addView(run);

        Button show = new Button(this);
        show.setText("Show last result");
        show.setOnClickListener(v -> out.setText(readResult()));
        root.addView(show);

        out = new TextView(this);
        out.setTypeface(Typeface.MONOSPACE);
        out.setTextSize(12);
        ScrollView sv = new ScrollView(this);
        sv.addView(out, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        root.addView(sv);
        setContentView(root);
    }

    private String readResult() {
        File f = new File(Suite.outputDir(this), "result.json");
        if (!f.exists()) return "No result yet.";
        StringBuilder sb = new StringBuilder();
        try (BufferedReader r = new BufferedReader(new FileReader(f))) {
            String line;
            while ((line = r.readLine()) != null) sb.append(line).append('\n');
        } catch (Exception e) {
            return "Could not read result: " + e;
        }
        return sb.toString();
    }
}
