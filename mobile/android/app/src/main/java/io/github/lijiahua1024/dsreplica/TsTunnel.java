package io.github.lijiahua1024.dsreplica;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONException;
import org.json.JSONObject;

import io.github.lijiahua1024.dsreplica.tsproxy.Tsproxy;

/**
 * 内置 Tailscale：在 App 进程内运行 userspace tsnet 节点（不建立系统 VPN），
 * 并在 127.0.0.1 上开一个本地回环代理，把发往服务器的 TCP 连接送进 tailnet。
 *
 * 节点身份与密钥状态保存在 filesDir/tailscale，Auth Key 只用于首次注册。
 */
final class TsTunnel {
    private static final String PREFS = "myagent_tailscale";
    private static final String KEY_AUTH = "authKey";

    private static TsTunnel instance;

    private final SharedPreferences prefs;
    private final String stateDir;
    private volatile String startError = "";

    static synchronized TsTunnel get(Context context) {
        if (instance == null) {
            instance = new TsTunnel(context.getApplicationContext());
        }
        return instance;
    }

    private TsTunnel(Context context) {
        prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        stateDir = context.getFilesDir() + "/tailscale";
    }

    String authKey() {
        return prefs.getString(KEY_AUTH, "");
    }

    boolean setAuthKey(String value) {
        return value == null || value.isEmpty()
            ? prefs.edit().remove(KEY_AUTH).commit()
            : prefs.edit().putString(KEY_AUTH, value).commit();
    }

    synchronized void start(String authKey, String target, String hostname) {
        if (authKey != null && !authKey.isEmpty()) {
            setAuthKey(authKey);
        }
        startError = "";
        try {
            Tsproxy.start(stateDir, hostname, authKey == null ? "" : authKey, target);
        } catch (Exception error) {
            startError = error.getMessage() == null ? error.toString() : error.getMessage();
        }
    }

    void stop() {
        Tsproxy.stop();
        startError = "";
    }

    /** JS 侧消费的状态 JSON：{state, addr, ip, error, loginUrl} */
    String status() {
        try {
            String state = Tsproxy.state();
            String error = Tsproxy.lastError();
            if ((error == null || error.isEmpty()) && !startError.isEmpty()) {
                error = startError;
                if ("stopped".equals(state)) {
                    state = "error";
                }
            }
            JSONObject json = new JSONObject();
            json.put("state", state == null || state.isEmpty() ? "stopped" : state);
            json.put("addr", nullToEmpty(Tsproxy.addr()));
            json.put("ip", nullToEmpty(Tsproxy.selfIP()));
            json.put("loginUrl", nullToEmpty(Tsproxy.loginURL()));
            json.put("error", nullToEmpty(error));
            return json.toString();
        } catch (JSONException error) {
            return "{\"state\":\"error\",\"addr\":\"\",\"ip\":\"\",\"loginUrl\":\"\",\"error\":\"status failed\"}";
        }
    }

    private static String nullToEmpty(String value) {
        return value == null ? "" : value;
    }
}
