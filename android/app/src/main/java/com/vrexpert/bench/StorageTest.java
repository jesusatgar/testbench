package com.vrexpert.bench;

import android.content.Context;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.Locale;
import java.util.Random;
import java.util.zip.CRC32;

/** Writes and reads back a 64 MB file. Catches slow or corrupting flash storage. */
final class StorageTest {
    static final int SIZE_MB = 64;
    static final double WRITE_WARN_MB_S = 15;
    static final double WRITE_FAIL_MB_S = 5;

    static Result run(Context c) throws IOException {
        Result r = new Result("storage", "Storage speed and integrity");
        File dir = c.getCacheDir();
        if (dir.getUsableSpace() < (SIZE_MB + 100L) * 1024 * 1024) {
            return r.set("na", "", "Not enough free space for the storage test.");
        }
        File f = new File(dir, "vre-storage.bin");
        byte[] chunk = new byte[1024 * 1024];
        new Random(42).nextBytes(chunk);
        CRC32 wcrc = new CRC32();
        long t0 = System.nanoTime();
        try (FileOutputStream out = new FileOutputStream(f)) {
            for (int i = 0; i < SIZE_MB; i++) {
                out.write(chunk);
                wcrc.update(chunk, 0, chunk.length);
            }
            out.getFD().sync();
        }
        double writeS = (System.nanoTime() - t0) / 1e9;

        CRC32 rcrc = new CRC32();
        long t1 = System.nanoTime();
        try (FileInputStream in = new FileInputStream(f)) {
            int n;
            while ((n = in.read(chunk)) > 0) rcrc.update(chunk, 0, n);
        }
        double readS = (System.nanoTime() - t1) / 1e9;
        f.delete();

        double writeMbS = SIZE_MB / writeS, readMbS = SIZE_MB / readS;
        r.metric("write_mb_s", writeMbS).metric("read_mb_s", readMbS);
        String value = String.format(Locale.US, "write %.0f MB/s, read %.0f MB/s", writeMbS, readMbS);
        if (wcrc.getValue() != rcrc.getValue()) {
            return r.set("fail", value, "Data read back does not match what was written. The storage is failing.");
        }
        if (writeMbS < WRITE_FAIL_MB_S) return r.set("fail", value, "Write speed is extremely low.");
        if (writeMbS < WRITE_WARN_MB_S) return r.set("warn", value, "Write speed is low for flash storage.");
        return r.set("ok", value, SIZE_MB + " MB written and read back without errors.");
    }
}
