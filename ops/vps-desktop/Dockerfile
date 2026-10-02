ARG BASE_IMAGE
FROM ${BASE_IMAGE}
USER root
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    tigervnc-standalone-server tigervnc-tools xfce4-session xfce4-panel xfce4-settings \
    xfdesktop4 xfwm4 dbus-daemon dbus-x11 xterm fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*
COPY chromium-desktop /usr/local/bin/vc-cloud-browser
COPY chromium.desktop /etc/xdg/autostart/vc-cloud-browser.desktop
RUN chmod 755 /usr/local/bin/vc-cloud-browser
USER node
