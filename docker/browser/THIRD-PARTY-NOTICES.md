# Third-party notices: browser sidecar image

The browser sidecar image (`ghcr.io/pineflight/secret-desk-browser`, built from this folder) contains software from the
Debian `bookworm` distribution. secret-desk's own files in the image (`entrypoint.sh`) are MIT licensed like the rest of
the project. The packages below are separate programs started side by side; secret-desk does not link to them.

| Component | Debian package | What it does in the image | License |
|---|---|---|---|
| Debian base system | `debian:bookworm-slim` | Operating system | Various free licenses, see `/usr/share/doc/*/copyright` |
| Chromium | `chromium` | The browser secret-desk drives | BSD-3-Clause and further licenses of bundled components |
| Xvfb (X.Org) | `xvfb` | Virtual display for the headed browser | MIT/X11 |
| x11vnc | `x11vnc` | VNC server on the virtual display (loopback only) | GPL-2.0-or-later |
| noVNC | `novnc` | VNC client in a normal web browser | MPL-2.0 (some files under other free licenses) |
| websockify | `websockify` | WebSocket bridge between noVNC and the VNC server | LGPL-3.0 |
| socat | `socat` | Forwards the DevTools port into the compose network | GPL-2.0 |
| Openbox | `openbox` | Window manager, gives the browser window the keyboard focus | GPL-2.0-or-later |
| dumb-init | `dumb-init` | Init process (signals, child reaping) | MIT |
| curl | `curl` | Health check | curl license (MIT-like) |
| CA certificates | `ca-certificates` | TLS trust store | MPL-2.0 / GPL-2.0-or-later |
| Fonts | `fonts-liberation`, `fonts-noto-color-emoji` | Page rendering | SIL Open Font License 1.1 |

**Exact versions and full license texts** are in the image itself: every Debian package installs its copyright file under
`/usr/share/doc/<package>/copyright`, and `dpkg -l` lists the installed versions:

```bash
docker run --rm --entrypoint sh ghcr.io/pineflight/secret-desk-browser -c 'dpkg -l chromium x11vnc novnc websockify socat'
docker run --rm --entrypoint cat ghcr.io/pineflight/secret-desk-browser /usr/share/doc/x11vnc/copyright
```

**Source code** of the GPL and LGPL components (x11vnc, socat, websockify) and of every other package is available from
Debian for the exact version in the image: `apt-get source <package>=<version>` on a Debian system, or
[snapshot.debian.org](https://snapshot.debian.org/) by package name and version. On request, Pineflight provides the
corresponding source for any image it published; ask through [SUPPORT.md](../../SUPPORT.md).

The list is maintained by hand. When the `apt-get install` line in the [Dockerfile](Dockerfile) changes, update this
table in the same pull request.
