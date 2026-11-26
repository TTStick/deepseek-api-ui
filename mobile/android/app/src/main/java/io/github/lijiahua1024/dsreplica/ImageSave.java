package io.github.lijiahua1024.dsreplica;

import android.annotation.TargetApi;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.MimeTypeMap;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.Locale;

/** An image becomes visible in the system gallery only after its original bytes are saved. */
final class ImageSave {
    private final Context context;
    private final ContentResolver resolver;
    private final FileExport writer;
    private Uri pending;
    private File pendingTemp;
    private File pendingDirectory;
    private String pendingName;
    private String pendingMime;
    private OutputStream legacyOutput;

    ImageSave(Context context) {
        this.context = context.getApplicationContext();
        this.resolver = this.context.getContentResolver();
        writer = new FileExport(resolver);
    }

    synchronized boolean begin(String name, String mime) {
        if (pending != null || pendingTemp != null) return false;
        name = name.replace('/', '_').replace('\\', '_').trim();
        if (name.isEmpty() || ".".equals(name) || "..".equals(name)) return false;
        if (!mime.startsWith("image/")) {
            int dot = name.lastIndexOf('.');
            if (dot < 0) return false;
            mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(
                name.substring(dot + 1).toLowerCase(Locale.ROOT));
            if (mime == null || !mime.startsWith("image/")) return false;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            return beginMediaStore(name, mime);
        }
        return beginLegacy(name, mime);
    }

    @TargetApi(Build.VERSION_CODES.Q)
    private boolean beginMediaStore(String name, String mime) {
        ContentValues values = new ContentValues();
        values.put(MediaStore.Images.Media.DISPLAY_NAME, name);
        values.put(MediaStore.Images.Media.MIME_TYPE, mime);
        values.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES);
        values.put(MediaStore.Images.Media.IS_PENDING, 1);
        try {
            Uri collection = MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
            pending = resolver.insert(collection, values);
            if (pending != null && writer.open(pending)) return true;
        } catch (RuntimeException ignored) {
            // A device without writable media storage cannot save the image.
        }
        finish(false);
        return false;
    }

    @SuppressWarnings("deprecation") // Android 9 writes directly to the public Pictures directory.
    private boolean beginLegacy(String name, String mime) {
        if (name.startsWith(".")) name = "image" + name;
        File pictures = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES);
        if (!pictures.isDirectory() && !pictures.mkdirs() && !pictures.isDirectory()) return false;
        try {
            pendingTemp = File.createTempFile(".pending-", ".tmp", pictures);
            pendingDirectory = pictures;
            pendingName = name;
            pendingMime = mime;
            legacyOutput = new BufferedOutputStream(new FileOutputStream(pendingTemp));
            return true;
        } catch (IOException | SecurityException ignored) {
            finish(false);
            return false;
        }
    }

    synchronized boolean append(String bytes) {
        if (pending != null) {
            return writer.append(bytes);
        }
        if (legacyOutput == null || bytes == null || bytes.length() > 65536) return false;
        try {
            legacyOutput.write(Base64.decode(bytes, Base64.NO_WRAP));
            return true;
        } catch (IOException | IllegalArgumentException ignored) {
            finish(false);
            return false;
        }
    }

    synchronized boolean finish(boolean keep) {
        if (pending != null) {
            return finishMediaStore(keep);
        }
        return finishLegacy(keep);
    }

    @TargetApi(Build.VERSION_CODES.Q)
    private boolean finishMediaStore(boolean keep) {
        Uri image = pending;
        if (image == null) return false;
        pending = null;
        boolean closed = writer.close();
        if (keep && closed) {
            ContentValues values = new ContentValues();
            values.put(MediaStore.Images.Media.IS_PENDING, 0);
            try {
                if (resolver.update(image, values, null, null) == 1) return true;
            } catch (RuntimeException ignored) {
                // Remove an unpublished image if the provider could not publish it.
            }
        }
        try {
            resolver.delete(image, null, null);
        } catch (RuntimeException ignored) {
            // Pending entries are hidden from the gallery and expire automatically.
        }
        return false;
    }

    private boolean finishLegacy(boolean keep) {
        File temp = pendingTemp;
        File directory = pendingDirectory;
        String name = pendingName;
        String mime = pendingMime;
        OutputStream output = legacyOutput;
        pendingTemp = null;
        pendingDirectory = null;
        pendingName = null;
        pendingMime = null;
        legacyOutput = null;
        if (temp == null) return false;

        boolean closed = false;
        if (output != null) {
            try {
                output.close();
                closed = true;
            } catch (IOException ignored) {
                closed = false;
            }
        }
        if (keep && closed && directory != null && name != null) {
            File target = uniqueFile(directory, name);
            if (target != null && temp.renameTo(target)) {
                MediaScannerConnection.scanFile(
                    context, new String[]{target.getAbsolutePath()}, new String[]{mime}, null);
                return true;
            }
        }
        temp.delete();
        return false;
    }

    private static File uniqueFile(File directory, String name) {
        File candidate = new File(directory, name);
        if (!candidate.exists()) return candidate;
        int dot = name.lastIndexOf('.');
        String stem = dot > 0 ? name.substring(0, dot) : name;
        String extension = dot > 0 ? name.substring(dot) : "";
        for (int index = 1; index < 10_000; index++) {
            candidate = new File(directory, stem + "-" + index + extension);
            if (!candidate.exists()) return candidate;
        }
        return null;
    }
}
