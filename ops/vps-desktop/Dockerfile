ARG BASE_IMAGE
FROM ${BASE_IMAGE}
USER root
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    tigervnc-standalone-server tigervnc-tools xfce4-session xfce4-panel xfce4-settings \
    xfdesktop4 xfwm4 dbus-daemon dbus-x11 xterm fonts-dejavu-core ca-certificates curl \
    && curl --fail --location --retry 3 https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o /tmp/google-chrome.deb \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends /tmp/google-chrome.deb \
    && rm /tmp/google-chrome.deb \
    && rm -rf /var/lib/apt/lists/*
COPY chromium-desktop /usr/local/bin/vc-cloud-browser
COPY chromium.desktop /etc/xdg/autostart/vc-cloud-browser.desktop
RUN chmod 755 /usr/local/bin/vc-cloud-browser \
    && sed -i 's|Exec=/usr/bin/google-chrome-stable|Exec=/usr/local/bin/vc-cloud-browser|g' /usr/share/applications/google-chrome.desktop \
    && printf '%s\n' '[Desktop Entry]' 'Version=1.0' 'Type=X-XFCE-Helper' 'Name=Cloud Google Chrome' 'Icon=google-chrome' 'X-XFCE-Category=WebBrowser' 'X-XFCE-Commands=/usr/local/bin/vc-cloud-browser;' 'X-XFCE-CommandsWithParameter=/usr/local/bin/vc-cloud-browser "%s";' > /usr/share/xfce4/helpers/vc-cloud-browser.desktop \
    && mkdir -p /home/node/.config \
    && ln -s /home/node/.openclaw/desktop/xfce4 /home/node/.config/xfce4 \
    && chown -R node:node /home/node/.config
USER node
