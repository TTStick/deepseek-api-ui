package io.github.lijiahua1024.dsreplica;

import android.util.Base64;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;
import org.json.JSONException;
import org.json.JSONObject;

/** Streams the configured provider directly to the bundled page. */
final class CustomChatTransport {
    private final Map<String, Exchange> exchanges = new ConcurrentHashMap<>();
    private final ExecutorService workers = Executors.newCachedThreadPool();

    String begin(String savedConfig, String endpoint, String format, String body, Consumer<String> emit) {
        if (savedConfig == null || endpoint == null || format == null || body == null) return null;
        try {
            JSONObject config = new JSONObject(savedConfig);
            if (!endpoint.equals(config.getString("endpoint"))
                    || !format.equals(config.getString("format"))) return null;
            URI target = URI.create(endpoint);
            if ((!"https".equals(target.getScheme()) && !"http".equals(target.getScheme()))
                    || target.getHost() == null
                    || target.getUserInfo() != null || target.getFragment() != null) return null;
            if (!format.equals("messages") && !format.equals("chat") && !format.equals("responses")) {
                return null;
            }
            String id = UUID.randomUUID().toString();
            Exchange exchange = new Exchange(target, config.optString("apiKey"), format);
            exchanges.put(id, exchange);
            workers.execute(() -> stream(id, exchange, body, emit));
            return id;
        } catch (JSONException | IllegalArgumentException ignored) {
            return null;
        }
    }

    private void stream(String id, Exchange exchange, String body, Consumer<String> emit) {
        try {
            HttpURLConnection connection = (HttpURLConnection) exchange.target.toURL().openConnection();
            exchange.connection = connection;
            if (exchange.cancelled) throw new IOException();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(20_000);
            connection.setReadTimeout(180_000);
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setRequestProperty("Accept", "text/event-stream");
            connection.setRequestProperty("Content-Type", "application/json");
            if (exchange.format.equals("messages")) {
                connection.setRequestProperty("anthropic-version", "2023-06-01");
                if (!exchange.key.isEmpty()) connection.setRequestProperty("x-api-key", exchange.key);
            } else if (!exchange.key.isEmpty()) {
                connection.setRequestProperty("Authorization", "Bearer " + exchange.key);
            }
            byte[] data = body.getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(data.length);
            try (var output = connection.getOutputStream()) {
                output.write(data);
            }
            int status = connection.getResponseCode();
            if (status < 200 || status > 599 || (status >= 300 && status < 400)) {
                throw new IOException("Unexpected status " + status);
            }
            String type = connection.getContentType();
            String mime = type != null && type.toLowerCase(Locale.ROOT).contains("text/event-stream")
                ? "text/event-stream" : "text/plain";
            emit.accept(event(id, "headers", Maps.of("status", status, "mime", mime)));
            try (InputStream input = status >= 400 ? connection.getErrorStream() : connection.getInputStream()) {
                if (input != null) {
                    byte[] buffer = new byte[8192];
                    int count;
                    while (!exchange.cancelled && (count = input.read(buffer)) != -1) {
                        emit.accept(event(id, "data",
                            Maps.of("bytes", Base64.encodeToString(buffer, 0, count, Base64.NO_WRAP))));
                    }
                }
            }
            if (!exchange.cancelled) emit.accept(event(id, "end", Maps.of()));
        } catch (IOException | RuntimeException ignored) {
            if (!exchange.cancelled) emit.accept(event(id, "error", Maps.of()));
        } finally {
            cancel(id);
        }
    }

    void cancel(String id) {
        Exchange exchange = exchanges.remove(id);
        if (exchange == null) return;
        exchange.cancelled = true;
        HttpURLConnection connection = exchange.connection;
        if (connection != null) connection.disconnect();
    }

    void close() {
        workers.shutdownNow();
        exchanges.keySet().forEach(this::cancel);
    }

    private static String event(String id, String type, Map<String, Object> fields) {
        Map<String, Object> data = new java.util.HashMap<>(fields);
        data.put("id", id);
        data.put("type", type);
        return new JSONObject(data).toString();
    }

    private static final class Exchange {
        final URI target;
        final String key;
        final String format;
        volatile boolean cancelled;
        volatile HttpURLConnection connection;

        Exchange(URI target, String key, String format) {
            this.target = target;
            this.key = key;
            this.format = format;
        }
    }
}
