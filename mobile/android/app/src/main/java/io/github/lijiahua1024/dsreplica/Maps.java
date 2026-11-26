package io.github.lijiahua1024.dsreplica;

import java.util.Collections;
import java.util.HashMap;
import java.util.Map;

/**
 * Java 9 collection factories like Map.of are native only from Android 11 (API 30).
 * Android 9 and 10 devices throw NoSuchMethodError, so these maps are built plainly.
 */
final class Maps {
    private Maps() {
    }

    static <K, V> Map<K, V> of() {
        return Collections.emptyMap();
    }

    static <K, V> Map<K, V> of(K key, V value) {
        return Collections.singletonMap(key, value);
    }

    static <K, V> Map<K, V> of(K key1, V value1, K key2, V value2) {
        Map<K, V> map = new HashMap<>();
        map.put(key1, value1);
        map.put(key2, value2);
        return Collections.unmodifiableMap(map);
    }

    static <K, V> Map<K, V> of(K key1, V value1, K key2, V value2, K key3, V value3) {
        Map<K, V> map = new HashMap<>();
        map.put(key1, value1);
        map.put(key2, value2);
        map.put(key3, value3);
        return Collections.unmodifiableMap(map);
    }

    static <K, V> Map<K, V> copyOf(Map<K, V> source) {
        return Collections.unmodifiableMap(new HashMap<>(source));
    }
}
