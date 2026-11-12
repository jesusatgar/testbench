package com.vrexpert.bench;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.AudioTrack;
import android.media.MediaRecorder;

import java.util.Locale;

/**
 * Loopback test: plays a 1 kHz tone on the left, then the right speaker, while the microphone
 * records. Results depend on speaker and microphone placement, so problems are reported as warnings.
 */
final class AudioTest {
    static final int SAMPLE_RATE = 44100;
    static final double TONE_HZ = 1000;
    static final double MIN_SNR_DB = 6;       // tone must stand this far above the noise floor
    static final double CHANNEL_GAP_DB = 12;  // left/right difference that suggests a weak speaker

    static Result run(Context c) throws InterruptedException {
        Result r = new Result("audio", "Speakers and microphone");
        if (c.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            return r.set("na", "", "Microphone permission not granted. Install with pm install -g or run pm grant.");
        }
        int minBuf = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        AudioRecord rec = new AudioRecord(MediaRecorder.AudioSource.MIC, SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(minBuf, SAMPLE_RATE));
        if (rec.getState() != AudioRecord.STATE_INITIALIZED) {
            rec.release();
            return r.set("na", "", "The microphone could not be opened.");
        }

        AudioManager am = (AudioManager) c.getSystemService(Context.AUDIO_SERVICE);
        int oldVol = am.getStreamVolume(AudioManager.STREAM_MUSIC);
        am.setStreamVolume(AudioManager.STREAM_MUSIC, Math.round(am.getStreamMaxVolume(AudioManager.STREAM_MUSIC) * 0.6f), 0);
        try {
            double noise = record(rec, null, 1.0);
            double left = record(rec, tone(true), 1.5);
            double right = record(rec, tone(false), 1.5);
            r.metric("noise_dbfs", noise).metric("left_dbfs", left).metric("right_dbfs", right);

            if (Double.isInfinite(noise) && Double.isInfinite(left) && Double.isInfinite(right)) {
                return r.set("fail", "No signal", "The microphone returned only silence.");
            }
            double snrL = left - noise, snrR = right - noise;
            String value = String.format(Locale.US, "left +%.0f dB, right +%.0f dB over noise", snrL, snrR);
            if (snrL < MIN_SNR_DB && snrR < MIN_SNR_DB) {
                return r.set("warn", value, "Neither speaker tone was picked up. Check speakers and microphone, and that the room is quiet.");
            }
            if (snrL < MIN_SNR_DB || snrR < MIN_SNR_DB) {
                return r.set("warn", value, (snrL < MIN_SNR_DB ? "Left" : "Right") + " speaker tone was not picked up.");
            }
            if (Math.abs(snrL - snrR) > CHANNEL_GAP_DB) {
                return r.set("warn", value, (snrL < snrR ? "Left" : "Right") + " speaker is much weaker than the other.");
            }
            return r.set("ok", value, "Both speakers and the microphone responded.");
        } finally {
            am.setStreamVolume(AudioManager.STREAM_MUSIC, oldVol, 0);
            rec.release();
        }
    }

    /** Records for the given time, optionally playing a tone, and returns the level in dBFS. */
    private static double record(AudioRecord rec, short[] stereoTone, double seconds) throws InterruptedException {
        AudioTrack track = null;
        if (stereoTone != null) {
            track = new AudioTrack.Builder()
                    .setAudioAttributes(new AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_MEDIA)
                            .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
                    .setAudioFormat(new AudioFormat.Builder()
                            .setSampleRate(SAMPLE_RATE)
                            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                            .setChannelMask(AudioFormat.CHANNEL_OUT_STEREO).build())
                    .setBufferSizeInBytes(stereoTone.length * 2)
                    .setTransferMode(AudioTrack.MODE_STATIC).build();
            track.write(stereoTone, 0, stereoTone.length);
        }
        int total = (int) (SAMPLE_RATE * seconds);
        int skip = (int) (SAMPLE_RATE * 0.3);
        short[] buf = new short[2048];
        rec.startRecording();
        if (track != null) track.play();
        double sumSq = 0;
        long counted = 0;
        int read = 0;
        while (read < total) {
            int n = rec.read(buf, 0, buf.length);
            if (n <= 0) break;
            for (int i = 0; i < n; i++) {
                if (read + i >= skip) {
                    sumSq += (double) buf[i] * buf[i];
                    counted++;
                }
            }
            read += n;
        }
        rec.stop();
        if (track != null) {
            track.stop();
            track.release();
        }
        Thread.sleep(200);
        if (counted == 0 || sumSq == 0) return Double.NEGATIVE_INFINITY;
        return 20 * Math.log10(Math.sqrt(sumSq / counted) / 32768.0);
    }

    private static short[] tone(boolean left) {
        int frames = (int) (SAMPLE_RATE * 1.5);
        short[] out = new short[frames * 2];
        for (int i = 0; i < frames; i++) {
            short v = (short) (Math.sin(2 * Math.PI * TONE_HZ * i / SAMPLE_RATE) * 20000);
            out[i * 2] = left ? v : 0;
            out[i * 2 + 1] = left ? 0 : v;
        }
        return out;
    }
}
