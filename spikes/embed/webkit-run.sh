#!/bin/sh
# Playwright's MiniBrowser wrappers reset LD_LIBRARY_PATH to the zip
# bundle only. Prepend compat libs required on Arch, and force Bookworm
# llvmpipe: host Mesa aborts WPE with "Could not create WPE EGL display".
set -e
SCRIPT_PATH="${PLAYWRIGHT_WEBKIT_PATH:-$HOME/.cache/ms-playwright/webkit_ubuntu20.04_arm64_special-2092}"
LIBS="$(cd "$(dirname "$0")" && pwd)/state/webkit-libs"
if echo " $* " | grep -q -- "--headless"; then
  MB="$SCRIPT_PATH/minibrowser-wpe"
  export WEBKIT_SKIA_ENABLE_CPU_RENDERING=1
else
  MB="$SCRIPT_PATH/minibrowser-gtk"
fi
export GIO_EXTRA_MODULES="${MB}/sys/lib/gio"
export GST_PLUGIN_PATH_1_0="${MB}/sys/lib/gst"
export GST_REGISTRY_1_0="${MB}/sys/lib/gst/gstreamer-1.0.registry"
export WEBKIT_EXEC_PATH="${MB}/bin"
export WEBKIT_INJECTED_BUNDLE_PATH="${MB}/lib"
export LD_LIBRARY_PATH="${LIBS}:${MB}/lib:${MB}/sys/lib"
export LIBGL_DRIVERS_PATH="${LIBS}/dri"
export LIBGL_ALWAYS_SOFTWARE=1
export GALLIUM_DRIVER=llvmpipe
export WEBKIT_FORCE_COMPLEX_TEXT=1
exec "${MB}/bin/MiniBrowser" "$@"
