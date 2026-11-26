package io.github.lijiahua1024.dsreplica;

import android.annotation.TargetApi;
import android.graphics.Color;
import android.os.Build;
import android.view.DisplayCutout;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;

final class SystemBars {
    static final class SafeInsets {
        final int left;
        final int top;
        final int right;
        final int bottom;

        SafeInsets(int left, int top, int right, int bottom) {
            this.left = left;
            this.top = top;
            this.right = right;
            this.bottom = bottom;
        }
    }

    interface InsetsListener {
        void update(SafeInsets safe, boolean keyboardVisible, int buttonNavigationBottom);
    }

    @SuppressWarnings("deprecation") // Android 9-14 require explicit edge-to-edge and transparent bars.
    static void applyInsets(Window window, View content, InsetsListener listener) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.VANILLA_ICE_CREAM) {
            window.clearFlags(WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS
                | WindowManager.LayoutParams.FLAG_TRANSLUCENT_NAVIGATION);
            window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
            window.setStatusBarColor(Color.TRANSPARENT);
            window.setNavigationBarColor(Color.TRANSPARENT);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.setStatusBarContrastEnforced(false);
            window.setNavigationBarContrastEnforced(false);
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            Api30.applyInsets(window, content, listener);
            return;
        }

        View decor = window.getDecorView();
        decor.setSystemUiVisibility(decor.getSystemUiVisibility() | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        content.setOnApplyWindowInsetsListener((view, insets) -> {
            int left = insets.getSystemWindowInsetLeft();
            int top = insets.getSystemWindowInsetTop();
            int right = insets.getSystemWindowInsetRight();
            int bottom = insets.getSystemWindowInsetBottom();
            WindowInsets rootInsets = view.getRootWindowInsets();
            int navigation = rootInsets == null ? insets.getStableInsetBottom()
                : rootInsets.getStableInsetBottom();
            boolean keyboardVisible = bottom > navigation;
            DisplayCutout cutout = insets.getDisplayCutout();
            if (cutout != null) {
                left = Math.max(left, cutout.getSafeInsetLeft());
                top = Math.max(top, cutout.getSafeInsetTop());
                right = Math.max(right, cutout.getSafeInsetRight());
                bottom = Math.max(bottom, cutout.getSafeInsetBottom());
            }
            int buttonNavigationBottom = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                ? (Api29.hasTappableBottom(insets) ? Math.min(bottom, navigation) : 0)
                : Math.min(bottom, navigation);
            listener.update(new SafeInsets(left, top, right, bottom), keyboardVisible,
                buttonNavigationBottom);
            return insets.consumeSystemWindowInsets().consumeStableInsets().consumeDisplayCutout();
        });
    }

    @SuppressWarnings("deprecation") // Android 9-10 control icon colors through system UI flags.
    static void setAppearance(Window window, boolean dark) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController controller = window.getInsetsController();
            if (controller != null) {
                int flags = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                    | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                controller.setSystemBarsAppearance(dark ? 0 : flags, flags);
            }
        } else {
            View decor = window.getDecorView();
            int flags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            int visibility = decor.getSystemUiVisibility();
            decor.setSystemUiVisibility(dark ? visibility & ~flags : visibility | flags);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.setStatusBarContrastEnforced(false);
            window.setNavigationBarContrastEnforced(false);
        }
    }

    @SuppressWarnings("deprecation") // Android 9-10 use immersive system UI flags.
    static void setFullscreen(Window window, boolean fullscreen) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController controller = window.getInsetsController();
            if (controller == null) return;
            if (fullscreen) {
                controller.setSystemBarsBehavior(
                    WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                controller.hide(WindowInsets.Type.systemBars());
            } else {
                controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_DEFAULT);
                controller.show(WindowInsets.Type.systemBars());
            }
        } else {
            View decor = window.getDecorView();
            int flags = View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY;
            int visibility = decor.getSystemUiVisibility();
            decor.setSystemUiVisibility(fullscreen ? visibility | flags : visibility & ~flags);
        }
    }

    @TargetApi(Build.VERSION_CODES.Q)
    private static final class Api29 {
        static boolean hasTappableBottom(WindowInsets insets) {
            return insets.getTappableElementInsets().bottom > 0;
        }
    }

    @TargetApi(Build.VERSION_CODES.R)
    private static final class Api30 {
        static void applyInsets(Window window, View content, InsetsListener listener) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.VANILLA_ICE_CREAM) {
                window.setDecorFitsSystemWindows(false);
            }
            content.setOnApplyWindowInsetsListener((view, insets) -> {
                android.graphics.Insets safe = insets.getInsets(WindowInsets.Type.systemBars()
                    | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                int buttonNavigationBottom = insets.getInsets(WindowInsets.Type.tappableElement()).bottom > 0
                    ? insets.getInsets(WindowInsets.Type.navigationBars()).bottom : 0;
                listener.update(new SafeInsets(safe.left, safe.top, safe.right, safe.bottom),
                    insets.isVisible(WindowInsets.Type.ime()), buttonNavigationBottom);
                return WindowInsets.CONSUMED;
            });
        }
    }

    private SystemBars() {}
}
