#!/bin/bash -eu

setup_progress "configuring web server"

# Stop and disable nginx/fcgiwrap if present from a previous install
systemctl disable --now nginx.service fcgiwrap.service &> /dev/null || true

# Remove nginx tmpfs fstab entries from any previous install
sed -i "/.*\/nginx tmpfs.*/d" /etc/fstab

# Build cttseraser: FUSE layer that strips CTTS atoms so Chrome can seek
# Tesla's recordings. Express serves from the FUSE mount at /mnt/TeslaCam.
apt-get -y --force-yes install fuse libfuse-dev g++ net-tools wireless-tools ethtool
g++ -o /root/cttseraser -D_FILE_OFFSET_BITS=64 "$SOURCE_DIR/teslausb-www/cttseraser.cpp" -lstdc++ -lfuse

cat > /sbin/mount.ctts << 'EOF'
#!/bin/bash -eu
/root/cttseraser "$@" -o allow_other
EOF
chmod +x /sbin/mount.ctts

sed -i 's/#user_allow_other/user_allow_other/' /etc/fuse.conf

mkdir -p /mnt/TeslaCam
mkdir -p /mutable/TeslaCam

# FUSE mount: /mutable/TeslaCam through cttseraser -> /mnt/TeslaCam
sed -i '/mount.ctts/d' /etc/fstab
echo "mount.ctts#/mutable/TeslaCam /mnt/TeslaCam fuse defaults,nofail,x-systemd.requires=/mutable 0 0" >> /etc/fstab

# Static SPA directory served by Express
mkdir -p /root/teslausb-node/html
find /root/teslausb-node/html -mindepth 1 -maxdepth 1 -exec rm -rf {} +
cp -r "$SOURCE_DIR/teslausb-www/html/." /root/teslausb-node/html/
setup_progress "web static assets deployed from repository sources"

# Write web auth credentials into the config file so ConfigLoader picks them up.
# Existing WEB_USERNAME/WEB_PASSWORD entries are replaced.
config_file=/root/teslausb_setup_variables.conf
touch "$config_file"
sed -i '/^export WEB_USERNAME=/d' "$config_file"
sed -i '/^export WEB_PASSWORD=/d' "$config_file"
if [ -n "${WEB_USERNAME:-}" ] && [ -n "${WEB_PASSWORD:-}" ]
then
  echo "export WEB_USERNAME=\"$WEB_USERNAME\"" >> "$config_file"
  echo "export WEB_PASSWORD=\"$WEB_PASSWORD\"" >> "$config_file"
  setup_progress "web auth configured for user: $WEB_USERNAME"
fi

setup_progress "done configuring web server"
