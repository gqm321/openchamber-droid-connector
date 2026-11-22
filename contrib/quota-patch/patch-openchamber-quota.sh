#!/usr/bin/env bash
# Adds a "factory" quota provider to OpenChamber 1.24.x so the usage panel shows
# the Factory (Droid) 5h / weekly / monthly limits.
#
# Two modes:
#
#   web <path-to-@openchamber/web>
#       Patches an npm install of @openchamber/web in place (Linux and macOS).
#       Example: patch-openchamber-quota.sh web "$(npm root -g)/@openchamber/web"
#
#   appimage <OpenChamber-1.24.2-*.AppImage> [out-dir]
#       Linux only. Unpacks the AppImage, patches it and writes an unpacked
#       tree to out-dir (default: openchamber-patched/ next to the AppImage).
#       Run <out-dir>/AppRun instead of the AppImage. The AppImage itself is
#       not changed (beyond being made executable); delete out-dir to go back.
#       Needs: node >= 20, npm, python3 and about 2 GB of temporary space.
#
# Both modes are idempotent. Verified against OpenChamber 1.24.2 only; the
# patch asserts on the exact upstream text it edits and stops if it moved.

set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PROVIDER_SRC="$SCRIPT_DIR/factory.js"

usage() {
  sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//' >&2
  exit 2
}

[ -f "$PROVIDER_SRC" ] || { echo "missing $PROVIDER_SRC" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }

# patch_tree <quota-dir> <assets-dir>
#   quota-dir:  .../@openchamber/web/server/lib/quota
#   assets-dir: directory holding the built frontend chunks (…/assets)
patch_tree() {
  local quota_dir="$1" assets_dir="$2"
  [ -d "$quota_dir/providers" ] || { echo "not an OpenChamber quota dir: $quota_dir" >&2; exit 1; }
  [ -d "$assets_dir" ] || { echo "frontend assets not found: $assets_dir" >&2; exit 1; }

  echo "==> installing the factory provider"
  cp "$PROVIDER_SRC" "$quota_dir/providers/factory.js"

  echo "==> registering it in providers/index.js"
  python3 - "$quota_dir/providers/index.js" <<'PYEOF'
import re, sys
p = sys.argv[1]
s = open(p, encoding="utf8").read()
if "providers/factory.js" in s or "./factory.js" in s:
    print("    already registered")
    sys.exit(0)
anchor = "import * as xai from './xai.js';"
assert anchor in s, "index.js does not look like OpenChamber 1.24.x"
s = s.replace(anchor, "import * as factory from './factory.js';\n" + anchor)
entry = """  factory: {
    providerId: factory.providerId,
    providerName: factory.providerName,
    isConfigured: factory.isConfigured,
    fetchQuota: factory.fetchQuota
  }
"""
m = re.search(r"(  xai: \{[^}]*\}\n)\};", s)
assert m, "xai registry entry not found"
s = s.replace(m.group(0), m.group(1)[:-1] + ",\n" + entry + "};")
open(p, "w", encoding="utf8").write(s)
print("    registered")
PYEOF

  echo "==> adding the provider to the frontend catalogue"
  python3 - "$assets_dir" <<'PYEOF'
import glob, os, sys
old = '{id:"xai",name:"xAI"}]'
new = '{id:"xai",name:"xAI"},{id:"factory",name:"Factory (Droid)"}]'
hits = []
for f in glob.glob(os.path.join(sys.argv[1], "*.js")):
    s = open(f, encoding="utf8").read()
    if old in s:
        hits.append((f, s))
    elif new in s:
        print("    already patched:", os.path.basename(f))
        sys.exit(0)
assert hits, "provider list not found in frontend assets"
f, s = hits[0]
open(f, "w", encoding="utf8").write(s.replace(old, new, 1))
print("    patched:", os.path.basename(f))
PYEOF
}

patch_web() {
  local pkg="${1:-}"
  [ -n "$pkg" ] || usage
  pkg="$(CDPATH= cd -- "$pkg" && pwd)"
  patch_tree "$pkg/server/lib/quota" "$pkg/dist/assets"
  echo "done. Restart OpenChamber to pick the patch up."
}

patch_appimage() {
  local appimage="${1:-}" out_dir="${2:-}"
  [ -n "$appimage" ] || usage
  [ -f "$appimage" ] || { echo "AppImage not found: $appimage" >&2; exit 1; }
  appimage="$(CDPATH= cd -- "$(dirname -- "$appimage")" && pwd)/$(basename -- "$appimage")"
  [ -n "$out_dir" ] || out_dir="$(dirname -- "$appimage")/openchamber-patched"
  [ "$(uname -s)" = "Linux" ] || { echo "appimage mode is Linux only; use web mode" >&2; exit 1; }
  command -v npm >/dev/null || { echo "npm is required" >&2; exit 1; }

  # Global on purpose: the EXIT trap runs after this function has returned.
  work="$(mktemp -d "${TMPDIR:-/tmp}/oc-patch-XXXXXX")"
  trap 'rm -rf "$work"' EXIT

  echo "==> unpacking the AppImage"
  [ -x "$appimage" ] || chmod +x "$appimage"
  (cd "$work" && "$appimage" --appimage-extract > /dev/null 2>&1) || true
  [ -d "$work/squashfs-root" ] || { echo "--appimage-extract failed" >&2; exit 1; }

  echo "==> preparing the asar tool"
  mkdir -p "$work/tools"
  npm install --prefix "$work/tools" --no-audit --no-fund "@electron/asar@^3" > "$work/npm-install.log" 2>&1 \
    || { echo "npm install failed:" >&2; tail -5 "$work/npm-install.log" >&2; exit 1; }
  export ASAR_MODULE="$work/tools/node_modules/@electron/asar"

  echo "==> extracting app.asar"
  node -e '
    const asar = require(process.env.ASAR_MODULE);
    asar.extractAll(process.argv[1], process.argv[2]);
  ' "$work/squashfs-root/resources/app.asar" "$work/app"

  patch_tree "$work/app/node_modules/@openchamber/web/server/lib/quota" \
             "$work/squashfs-root/resources/web-dist/assets"

  echo "==> repacking app.asar"
  node - "$work" <<'NODEEOF'
const asar = require(process.env.ASAR_MODULE);
const wd = process.argv[2];

// The set of files kept outside the archive (native modules) must match the
// original, or the app fails to load them.
const unpackedSet = (file) => {
  const raw = asar.getRawHeader(file);
  const out = [];
  (function walk(node, prefix) {
    for (const [name, val] of Object.entries(node.files ?? {})) {
      const p = prefix ? `${prefix}/${name}` : name;
      if (val.files) walk(val, p);
      else if (val.unpacked) out.push(p);
    }
  })(raw.header ?? raw, "");
  return out.sort();
};

(async () => {
  await asar.createPackageWithOptions(`${wd}/app`, `${wd}/app.new.asar`, {
    unpackDir: "node_modules/{node-pty,bun-pty,sherpa-onnx-linux-*}",
    unpack: "**/built-in-extensions/registry.json",
  });
  const before = new Set(unpackedSet(`${wd}/squashfs-root/resources/app.asar`));
  const after = new Set(unpackedSet(`${wd}/app.new.asar`));
  const diff = [
    ...[...before].filter((p) => !after.has(p)).map((p) => `- ${p}`),
    ...[...after].filter((p) => !before.has(p)).map((p) => `+ ${p}`),
  ];
  if (diff.length > 0) {
    console.error("unpacked file set differs from the original, aborting:");
    console.error(diff.slice(0, 20).join("\n"));
    process.exit(1);
  }
  console.log("    ok");
})();
NODEEOF

  echo "==> installing to $out_dir"
  mv "$work/app.new.asar" "$work/squashfs-root/resources/app.asar"
  rm -rf "$out_dir"
  mv "$work/squashfs-root" "$out_dir"
  chmod +x "$out_dir/AppRun"
  echo "done. Run $out_dir/AppRun (it needs APPDIR=$out_dir if you start it from elsewhere)."
}

case "${1:-}" in
  web) shift; patch_web "$@" ;;
  appimage) shift; patch_appimage "$@" ;;
  *) usage ;;
esac
