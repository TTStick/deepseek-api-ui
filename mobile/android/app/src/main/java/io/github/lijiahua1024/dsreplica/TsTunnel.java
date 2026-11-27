package io.github.lijiahua1024.dsreplica;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;

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
    private static final String KEY_TARGET = "target";
    private static final String KEY_HOSTNAME = "hostname";

    private static TsTunnel instance;

    private final Context app;
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
        app = context;
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

    /** 启动隧道并拉起前台服务（保证后台存活） */
    synchronized void start(String authKey, String target, String hostname) {
        rememberTarget(target, hostname);
        startCore(authKey, target, hostname);
        TunnelService.start(app, target, hostname);
    }

    /** 仅启动 tsnet（前台服务恢复时调用，避免重复 startService） */
    synchronized void startCore(String authKey, String target, String hostname) {
        if (authKey != null && !authKey.isEmpty()) {
            setAuthKey(authKey);
        }
        startError = "";
        try {
            Tsproxy.start(stateDir,
                hostname == null || hostname.isEmpty() ? "wydeepseek" : hostname,
                authKey == null ? "" : authKey,
                target == null ? "" : target);
        } catch (Exception error) {
            startError = error.getMessage() == null ? error.toString() : error.getMessage();
        }
    }

    void rememberTarget(String target, String hostname) {
        if (target == null || target.isEmpty()) {
            return;
        }
        prefs.edit()
            .putString(KEY_TARGET, target)
            .putString(KEY_HOSTNAME, hostname == null || hostname.isEmpty() ? "wydeepseek" : hostname)
            .apply();
    }

    String savedTarget() {
        return prefs.getString(KEY_TARGET, "");
    }

    String savedHostname() {
        return prefs.getString(KEY_HOSTNAME, "wydeepseek");
    }

    /** 通知栏里的一行状态 */
    String summary() {
        String state = Tsproxy.state();
        if ("ready".equals(state)) {
            String ip = Tsproxy.selfIP();
            return ip == null || ip.isEmpty() ? "隧道已就绪" : "隧道已就绪 · " + ip;
        }
        if ("starting".equals(state)) {
            String login = Tsproxy.loginURL();
            return login == null || login.isEmpty() ? "正在连接 Tailscale…" : "等待浏览器登录…";
        }
        if ("error".equals(state)) {
            return "连接失败";
        }
        return "未连接";
    }

    /** 用系统浏览器打开交互登录页（与官方客户端一致） */
    boolean openLogin(Context context) {
        String url = Tsproxy.loginURL();
        if (url == null || url.isEmpty()) {
            return false;
        }
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
            return true;
        } catch (Exception ignored) {
            return false;
        }
    }

    void stop() {
        Tsproxy.stop();
        TunnelService.stop(app);
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
