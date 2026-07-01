# Wisp — A Modern, Animated, Cinematic Static HTTP Server 🌌

[![GitHub Workflow Status](https://img.shields.io/github/actions/workflow/status/MdSagorMunshi/http-server/node.js.yml?style=flat-square&branch=master)](https://github.com/MdSagorMunshi/http-server/actions)
[![npm](https://img.shields.io/npm/v/@ryanshelby/wisp.svg?style=flat-square)](https://www.npmjs.com/package/@ryanshelby/wisp)
[![npm downloads](https://img.shields.io/npm/dm/@ryanshelby/wisp?color=blue&label=npm%20downloads&style=flat-square)](https://www.npmjs.com/package/@ryanshelby/wisp)
[![license](https://img.shields.io/github/license/MdSagorMunshi/http-server.svg?style=flat-square)](https://github.com/MdSagorMunshi/http-server/blob/master/LICENSE)

`wisp` is a modern, beautifully designed reimagining of the classic developer utility `http-server`. It lets you instantly share any directory over HTTP while presenting visitors with a stunning, glassmorphic dark interface featuring live file-watching, drag-and-drop file uploads, image/video thumbnail previews, and instant LAN access via QR code.

---

## ✨ Features

- **Cinematic Dark UI**: Elegant serif headers, glassmorphic list/grid toggles, and smooth CSS micro-animations.
- **Drag & Drop Uploads**: Upload files directly to the current directory via a beautiful dropzone overlay.
- **Live Watcher**: Real-time directory watching using WebSockets to automatically refresh the directory listing on file additions, deletions, or changes.
- **Rich Media Previews**: Generates fast image/video thumbnail previews on-demand with local client caching.
- **LAN Access QR Code**: Scan a QR code from the command line or UI to easily connect mobile/external devices on the same local network.
- **Markdown Rendering**: Directly preview any Markdown file parsed beautifully inside a modern modal interface.

---

## 🚀 Installation

#### Run on-demand (without installing):

```bash
npx @ryanshelby/wisp [path] [options]
```

#### Install globally via `npm`:

```bash
npm install --global @ryanshelby/wisp
```

This will install the global `wisp` command on your system.

---

## 📖 Usage

```bash
wisp [path] [options]
```

`[path]` defaults to `./public` if that folder exists, and `./` otherwise.

*Now visit `http://localhost:8080` to view your server.*

**Note:** Caching is enabled by default. Add `-c-1` as an option to disable caching.

---

## 🛠️ Available Options

| Option | Description | Default |
| :--- | :--- | :--- |
| `-p` or `--port` | Port to use. Use `-p 0` to find an open port starting at 8080. Can also be read from `process.env.PORT`. | `8080` |
| `-a` | Address to bind to. | `0.0.0.0` |
| `--base-dir` | Base path to serve files from. | `/` |
| `-d` | Show directory listings. | `true` |
| `--dir-overrides-404` | Whether `-d` should override magic `404.html`. | `false` |
| `-i` | Display `autoIndex` files. | `true` |
| `-g` or `--gzip` | Serve `.gz` compressed files when possible. | `false` |
| `-b` or `--brotli` | Serve `.br` compressed files when possible. | `false` |
| `-e` or `--ext` | Default file extension if none is supplied. | `html` |
| `-s` or `--silent` | Suppress log output messages. | |
| `--cors` | Enable CORS via `Access-Control-Allow-Origin: *`. | |
| `-H` or `--header` | Add custom response headers (can be specified multiple times). | |
| `-o [path]` | Automatically open the browser window after server starts. | |
| `-c` | Cache-Control max-age header value (in seconds). Set to `-c-1` to disable caching. | `3600` |
| `-t` | Connection timeout (in seconds). Set to `-t0` to disable. | `120` |
| `-T` or `--title` | Custom console title suffix. | |
| `-U` or `--utc` | Use UTC time format in log messages. | |
| `--log-ip` | Log the client's IP address. | `false` |
| `-P` or `--proxy` | Proxy unresolved requests to a remote server. | |
| `--proxy-all` | Forward every single request to the proxy target. | `false` |
| `--user` or `--username`| Username for basic authentication. | |
| `--password` | Password for basic authentication. | |
| `-S` or `--tls` | Enable secure HTTPS serving. | `false` |
| `-C` or `--cert` | Path to your SSL certificate file. | `cert.pem` |
| `-K` or `--key` | Path to your SSL private key file. | `key.pem` |
| `-r` or `--robots` | Respond to `/robots.txt` automatically. | `false` |
| `--no-dotfiles` | Hide dotfiles from listings. | `false` |
| `--hide-permissions` | Hide file permission values. | `false` |
| `--mimetypes` | Path to a custom `.types` file for MIME mappings. | |

---

## 🔒 TLS/SSL (HTTPS)

You can generate local SSL keys using `openssl`:

```bash
openssl req -newkey rsa:2048 -new -nodes -x509 -days 3650 -keyout key.pem -out cert.pem
```

Then start the server specifying the certificate and key files:

```bash
wisp -S -C cert.pem -K key.pem
```

---

## 🤝 Development

Clone the repository and install dependencies:

```bash
git clone https://github.com/MdSagorMunshi/http-server.git
cd http-server
npm install
npm start
```

Visit `http://localhost:8080` to see the dev server. Run the test suite via:

```bash
npm test
```

---

## License

This project is licensed under the **MIT License**.
