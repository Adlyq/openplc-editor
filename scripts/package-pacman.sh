#!/usr/bin/env bash
#
# Build the OpenPLC Editor as an Arch Linux pacman package.
#
# Pipeline:
#   1. npm run package            -> AppImage in release/build/
#   2. wrap AppImage + icon + .desktop into a local source tarball
#   3. makepkg                    -> openplc-editor-<version>-1-x86_64.pkg.tar.zst
#
# Usage:  bash scripts/package-pacman.sh
# Requires: node/npm deps installed, and `makepkg` (Arch) available.

set -euo pipefail

cd "$(dirname "$0")/.."

ROOT="$(pwd)"
VERSION=$(node -e "console.log(require('./package.json').version)")
APPIMAGE_IN="$(ls release/build/OpenPLC*Editor*.AppImage 2>/dev/null | head -1 || true)"

if [ -z "${APPIMAGE_IN}" ] || [ ! -f "${APPIMAGE_IN}" ]; then
	echo "[1/3] Building the editor AppImage (this takes a while) ..."
	npm run package
	APPIMAGE_IN="$(ls release/build/OpenPLC*Editor*.AppImage | head -1)"
fi

echo "AppImage: ${APPIMAGE_IN}"
STAGE="$(mktemp -d)"
trap 'rm -rf "${STAGE}"' EXIT

echo "[2/3] Staging pacman package ..."
APPDIR="${STAGE}/openplc-editor-appimage-${VERSION}"
mkdir -p "${APPDIR}"
cp "${APPIMAGE_IN}" "${APPDIR}/openplc-editor.AppImage"
chmod +x "${APPDIR}/openplc-editor.AppImage"
cp assets/icon.png "${APPDIR}/openplc-editor.png"

cat >"${APPDIR}/openplc-editor.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=OpenPLC Editor
Comment=OpenPLC Editor
Exec=/opt/openplc-editor/openplc-editor.AppImage %F
Icon=/usr/share/pixmaps/openplc-editor.png
Terminal=false
Categories=Development;IDE;
StartupWMClass=OpenPLC Editor
EOF

tar -czf "${STAGE}/openplc-editor-appimage-${VERSION}.tar.gz" -C "${APPDIR}" .
cp "${APPDIR}/openplc-editor.desktop" "${STAGE}/openplc-editor.desktop"

cat >"${STAGE}/PKGBUILD" <<'PKGEOF'
# Maintainer: OpenPLC Editor build
pkgname=openplc-editor
pkgver=__VERSION__
pkgrel=1
pkgdesc="OpenPLC Editor - IEC 61131-3 IDE"
arch=('x86_64')
url="https://openplcproject.com"
license=('GPL3')
depends=('nss' 'libxss' 'libxtst' 'libsecret' 'gtk3' 'alsa-lib' 'fuse2')
options=(!strip)
source=("openplc-editor-appimage-__VERSION__.tar.gz")
sha256sums=('SKIP')

package() {
    install -d "${pkgdir}/opt/openplc-editor"
    cp -a "${srcdir}/openplc-editor.AppImage" "${pkgdir}/opt/openplc-editor/"
    chmod 755 "${pkgdir}/opt/openplc-editor/openplc-editor.AppImage"

    install -Dm644 "${srcdir}/openplc-editor.png" "${pkgdir}/usr/share/pixmaps/openplc-editor.png"
    install -Dm644 "${srcdir}/openplc-editor.desktop" "${pkgdir}/usr/share/applications/openplc-editor.desktop"
}
PKGEOF
sed -i "s/__VERSION__/${VERSION}/g" "${STAGE}/PKGBUILD"

echo "[3/3] Building pacman package (makepkg) ..."
cd "${STAGE}"
makepkg -f --noconfirm --nodeps 2>&1 | tail -n 20
cp ./*.pkg.tar.zst "${ROOT}/release/build/" 2>/dev/null || true
ls -lh "${ROOT}/release/build/"*.pkg.tar.zst
echo "Done. Install with: sudo pacman -U ${ROOT}/release/build/openplc-editor-${VERSION}-1-x86_64.pkg.tar.zst"
