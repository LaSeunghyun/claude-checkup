#!/bin/sh
# Claude 설정 점검 설치 스크립트 (macOS, Linux)
# 사용: curl -fsSL <이 파일 주소> | sh
set -eu

REPO="${CHECKUP_REPO:-LaSeunghyun/claude-checkup}"
BASE="${CHECKUP_BASE_URL:-https://github.com/$REPO/releases/latest/download}"

os=$(uname -s)
arch=$(uname -m)
# Rosetta 로 띄운 터미널은 x86_64 로 보이므로 실제 Apple 칩인지 한 번 더 본다
if [ "$os" = "Darwin" ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then
  arch=arm64
fi

case "$os-$arch" in
  Darwin-arm64) file=claude-checkup-mac ;;
  Darwin-x86_64) file=claude-checkup-mac-x64 ;;
  Linux-x86_64) file=claude-checkup-linux ;;
  *)
    echo "이 컴퓨터($os $arch)는 아직 지원하지 않아요." >&2
    exit 1
    ;;
esac

dir="$HOME/.claude-checkup/bin"
mkdir -p "$dir"
tmp="$dir/.download"

echo "Claude 설정 점검을 내려받고 있어요..."
if ! curl -fsSL "$BASE/$file" -o "$tmp"; then
  rm -f "$tmp"
  echo "내려받지 못했어요. 인터넷 연결을 확인하고 다시 시도해 주세요." >&2
  exit 1
fi
chmod +x "$tmp"
mv "$tmp" "$dir/claude-checkup"

echo "설치했어요. 다음부터는 터미널에서 아래 명령으로 실행하면 돼요."
echo "  ~/.claude-checkup/bin/claude-checkup"
echo ""
exec "$dir/claude-checkup"
