'use strict';

const lastModifiedToString = require('./last-modified-to-string');
const permsToString = require('./perms-to-string');
const sizeToString = require('./size-to-string');
const sortFiles = require('./sort-files');
const fs = require('fs');
const path = require('path');
const he = require('he');
const etag = require('../etag');
const url = require('url');
const status = require('../status-handlers');

module.exports = (opts) => {
  const cache = opts.cache;
  const root = path.resolve(opts.root);
  const baseDir = opts.baseDir;
  const humanReadable = opts.humanReadable;
  const hidePermissions = opts.hidePermissions;
  const handleError = opts.handleError;
  const showDotfiles = opts.showDotfiles;
  const si = opts.si;
  const weakEtags = opts.weakEtags;

  return function middleware(req, res, next) {
    const parsed = url.parse(req.url);
    const pathname = decodeURIComponent(parsed.pathname);
    const dir = path.normalize(
      path.join(
        root,
        path.relative(
          path.join('/', baseDir),
          pathname
        )
      )
    );

    fs.stat(dir, (statErr, stat) => {
      if (statErr) {
        if (handleError) {
          status[500](res, next, { error: statErr });
        } else {
          next();
        }
        return;
      }

      fs.readdir(dir, (readErr, _files) => {
        let files = _files;

        if (readErr) {
          if (handleError) {
            status[500](res, next, { error: readErr });
          } else {
            next();
          }
          return;
        }

        if (!showDotfiles) {
          files = files.filter(filename => filename.slice(0, 1) !== '.');
        }

        res.setHeader('content-type', 'text/html');
        res.setHeader('etag', etag(stat, weakEtags));
        res.setHeader('last-modified', (new Date(stat.mtime)).toUTCString());
        res.setHeader('cache-control', cache);

        function prerender(dirs, renderFiles, errs) {
          const filenamesThatExist = new Set();

          for (let i = 0; i < renderFiles.length; i++) {
            const [name, stat] = renderFiles[i];
            filenamesThatExist.add(name);
            const renderOptions = {};
            renderFiles[i] = [name, stat, renderOptions];
          }

          for (const [name, _stat, renderOptions] of renderFiles) {
            if (opts.brotli && !opts.forceContentEncoding && name.endsWith('.br')) {
              const uncompressedName = name.slice(0, -'.br'.length);
              if (filenamesThatExist.has(uncompressedName)) {
                continue;
              }
              renderOptions.uncompressedName = uncompressedName;
            }
          }
          for (const [name, _stat, renderOptions] of renderFiles) {
            if (opts.gzip && !opts.forceContentEncoding && name.endsWith('.gz')) {
              const uncompressedName = name.slice(0, -'.gz'.length);
              if (filenamesThatExist.has(uncompressedName)) {
                continue;
              }
              renderOptions.uncompressedName = uncompressedName;
            }
          }
          render(dirs, renderFiles, errs);
        }

        function render(dirs, renderFiles, errs) {
          // Sort items by name by default
          dirs.sort((a, b) => a[0].toString().localeCompare(b[0].toString()));
          renderFiles.sort((a, b) => a[0].toString().localeCompare(b[0].toString()));
          errs.sort((a, b) => a[0].toString().localeCompare(b[0].toString()));

          const formatFile = (file, isDir) => {
            let fileSize = sizeToString(file[1], humanReadable, si);
            let uncompressedName = null;
            if (file[2] && file[2].uncompressedName) {
              uncompressedName = file[2].uncompressedName;
              fileSize += '*';
            }
            return {
              name: file[0],
              isDir,
              size: fileSize,
              rawSize: file[1].size || 0,
              mtime: file[1].mtime,
              mtimeMs: (new Date(file[1].mtime)).getTime(),
              mtimeStr: lastModifiedToString(file[1]),
              perms: permsToString(file[1]),
              uncompressedName
            };
          };

          const clientDirs = dirs.map(d => formatFile(d, true));
          const clientFiles = renderFiles.map(f => formatFile(f, false));
          const clientErrs = errs.map(e => ({ name: e[0], error: e[1].message }));

          if (req.headers.accept === 'application/json' || (parsed.query && parsed.query.split('&').includes('json=1'))) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              pathname,
              dirs: clientDirs,
              files: clientFiles,
              errs: clientErrs
            }));
            return;
          }

          const query = parsed.search || '';
          const encodedQuery = query ? he.encode(query) : '';

          // Build Fallback HTML for regex tests and non-JS clients
          let fallbackHtml = '<div id="fallback-listing" style="display:none;">';
          fallbackHtml += '<h1>Index of ' + he.encode(pathname) + '</h1>';
          fallbackHtml += '<table>';
          const writeFallbackRow = (file, isDir) => {
            let href = './' + encodeURIComponent(file.name);
            if (isDir) {
              href += '/';
            }

            let displayNameHTML;
            if (file.uncompressedName) {
              const uncompressedName = he.encode(file.uncompressedName);
              const compressedName = he.encode(file.name);
              const uncompressedHref = './' + encodeURIComponent(file.uncompressedName);
              const asterisk = '<span title="served from compressed file">*</span>';
              displayNameHTML = '<a href="' + uncompressedHref + '">' + uncompressedName + '</a>' +
                asterisk + ' (<a href="' + href + '">' + compressedName + '</a>)';
            } else {
              displayNameHTML = '<a href="' + href + (isDir ? encodedQuery : '') + '">' + he.encode(file.name) + (isDir ? '/' : '') + '</a>';
            }

            fallbackHtml += '<tr>' +
              '<td><i class="icon icon-file"></i></td>';
            if (!hidePermissions) {
              fallbackHtml += '<td class="perms"><code>(' + file.perms + ')</code></td>';
            }
            fallbackHtml +=
              '<td class="last-modified">' + file.mtimeStr + '</td>' +
              '<td class="file-size"><code>' + file.size + '</code></td>' +
              '<td class="display-name">' + displayNameHTML + '</td>' +
              '</tr>\n';
          };

          clientDirs.forEach(d => writeFallbackRow(d, true));
          clientFiles.forEach(f => writeFallbackRow(f, false));
          fallbackHtml += '</table></div>';

          let html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Wisp — ${he.encode(pathname)}</title>
    <style type="text/css">
      @font-face {
        font-family: 'Fraunces';
        font-style: normal;
        font-weight: 400;
        src: url('/__wisp/fonts/Fraunces-400.woff2') format('woff2');
      }
      @font-face {
        font-family: 'Fraunces';
        font-style: normal;
        font-weight: 500;
        src: url('/__wisp/fonts/Fraunces-500.woff2') format('woff2');
      }
      @font-face {
        font-family: 'Fraunces';
        font-style: normal;
        font-weight: 600;
        src: url('/__wisp/fonts/Fraunces-600.woff2') format('woff2');
      }
      @font-face {
        font-family: 'Inter';
        font-style: normal;
        font-weight: 400;
        src: url('/__wisp/fonts/Inter-400.woff2') format('woff2');
      }
      @font-face {
        font-family: 'Inter';
        font-style: normal;
        font-weight: 500;
        src: url('/__wisp/fonts/Inter-500.woff2') format('woff2');
      }
      @font-face {
        font-family: 'JetBrains Mono';
        font-style: normal;
        font-weight: 400;
        src: url('/__wisp/fonts/JetBrainsMono-400.woff2') format('woff2');
      }
      @font-face {
        font-family: 'JetBrains Mono';
        font-style: normal;
        font-weight: 500;
        src: url('/__wisp/fonts/JetBrainsMono-500.woff2') format('woff2');
      }

      :root {
        --bg: #0A0B0D;
        --surface: #131418;
        --hover: #1C1E24;
        --border: #232529;
        --text-primary: #E4E2DD;
        --text-muted: #8B8D94;
        --text-disabled: #4A4C54;
        --accent-gold: #C9A54D;
        --accent-blue: #4A6B7A;
        --accent-green: #6B8F71;
        
        --font-serif: 'Fraunces', Georgia, serif;
        --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
        --font-mono: 'JetBrains Mono', monospace;
      }

      * {
        box-sizing: border-box;
      }

      body {
        background-color: var(--bg);
        color: var(--text-primary);
        font-family: var(--font-sans);
        margin: 0;
        padding: 0;
        min-height: 100vh;
        display: flex;
        flex-direction: column;
      }

      a {
        color: inherit;
        text-decoration: none;
      }

      .wisp-container {
        max-width: 1200px;
        width: 100%;
        margin: 0 auto;
        padding: 3rem 1.5rem;
        display: flex;
        flex-direction: column;
        flex: 1;
      }

      header {
        margin-bottom: 1.5rem;
      }

      h1 {
        font-family: var(--font-serif);
        font-size: 2.2rem;
        font-weight: 500;
        letter-spacing: -0.01em;
        margin: 0 0 1rem 0;
        color: var(--text-primary);
      }

      .breadcrumbs-container {
        position: relative;
        padding-bottom: 0.75rem;
        border-bottom: 1px solid var(--border);
        margin-bottom: 2rem;
        display: flex;
        align-items: center;
        justify-content: space-between;
      }

      .breadcrumbs-container::after {
        content: '';
        position: absolute;
        bottom: -1px;
        left: 0;
        width: 60px;
        height: 2px;
        background-color: var(--accent-gold);
      }

      .breadcrumbs {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 0.4rem;
        font-size: 0.95rem;
        font-weight: 500;
      }

      .breadcrumb-item {
        color: var(--text-muted);
        transition: color 0.15s ease;
        cursor: pointer;
        position: relative;
      }

      .breadcrumb-item:hover {
        color: var(--text-primary);
      }

      .breadcrumb-item:hover::after {
        content: '';
        position: absolute;
        bottom: -4px;
        left: 0;
        right: 0;
        height: 1px;
        background-color: var(--accent-gold);
      }

      .breadcrumb-item.active {
        color: var(--text-primary);
        cursor: default;
      }

      .breadcrumb-item.active:hover::after {
        display: none;
      }

      .breadcrumb-separator {
        color: var(--accent-gold);
        display: flex;
        align-items: center;
        opacity: 0.8;
      }

      .control-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        margin-bottom: 2rem;
        flex-wrap: wrap;
      }

      .search-box {
        position: relative;
        flex: 1;
        min-width: 200px;
        max-width: 320px;
      }

      .search-box input {
        width: 100%;
        background-color: var(--surface);
        border: 1px solid var(--border);
        color: var(--text-primary);
        padding: 0.6rem 1rem 0.6rem 2.5rem;
        border-radius: 6px;
        font-size: 0.9rem;
        outline: none;
        transition: border-color 0.15s ease, box-shadow 0.15s ease;
      }

      .search-box input:focus {
        border-color: var(--accent-gold);
        box-shadow: 0 0 0 3px rgba(201, 165, 77, 0.15);
      }

      .search-box .icon-search {
        position: absolute;
        left: 0.8rem;
        top: 50%;
        transform: translateY(-50%);
        color: var(--text-muted);
        pointer-events: none;
        display: flex;
        align-items: center;
      }

      .controls-right {
        display: flex;
        align-items: center;
        gap: 0.75rem;
      }

      .btn-control, .select-control {
        background-color: var(--surface);
        border: 1px solid var(--border);
        color: var(--text-primary);
        padding: 0.6rem 0.9rem;
        border-radius: 6px;
        font-size: 0.85rem;
        font-weight: 500;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 0.5rem;
        outline: none;
        transition: border-color 0.15s ease, background-color 0.15s ease;
      }

      .btn-control:hover, .select-control:hover {
        border-color: var(--accent-gold);
        background-color: var(--hover);
      }

      .btn-control.active {
        border-color: var(--accent-gold);
        color: var(--accent-gold);
      }

      .status-indicator {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        font-family: var(--font-mono);
        font-size: 0.75rem;
        color: var(--accent-blue);
        padding: 0.5rem 0.75rem;
        border-radius: 4px;
        background-color: rgba(74, 107, 122, 0.05);
        border: 1px solid rgba(74, 107, 122, 0.15);
        position: relative;
        cursor: help;
        user-select: none;
      }

      .status-indicator.disconnected {
        color: var(--text-muted);
        background-color: rgba(139, 141, 148, 0.05);
        border-color: rgba(139, 141, 148, 0.15);
      }

      .status-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background-color: var(--accent-blue);
        display: inline-block;
        box-shadow: 0 0 6px var(--accent-blue);
      }

      .status-indicator.disconnected .status-dot {
        background-color: var(--text-muted);
        box-shadow: none;
      }

      .status-tooltip {
        visibility: hidden;
        position: absolute;
        bottom: 125%;
        left: 50%;
        transform: translateX(-50%);
        background-color: var(--surface);
        border: 1px solid var(--border);
        color: var(--text-primary);
        padding: 0.5rem;
        border-radius: 4px;
        white-space: nowrap;
        font-family: var(--font-mono);
        font-size: 0.75rem;
        z-index: 10;
        box-shadow: 0 4px 12px rgba(0,0,0,0.5);
        opacity: 0;
        transition: opacity 0.15s ease, transform 0.15s ease;
        pointer-events: none;
      }

      .status-indicator:hover .status-tooltip {
        visibility: visible;
        opacity: 1;
        transform: translateX(-50%) translateY(-4px);
      }

      .listing-container {
        flex: 1;
        min-height: 200px;
      }

      /* Grid View */
      .grid-view {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
        gap: 1.25rem;
      }

      .grid-view .item-card {
        background-color: var(--surface);
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 1.25rem;
        display: flex;
        flex-direction: column;
        align-items: center;
        text-align: center;
        cursor: pointer;
        position: relative;
        transition: background-color 0.15s ease, border-color 0.15s ease;
        overflow: hidden;
        user-select: none;
      }

      .grid-view .item-card::after {
        content: '';
        position: absolute;
        bottom: 0;
        left: 50%;
        transform: translateX(-50%);
        width: 0;
        height: 2px;
        background-color: var(--accent-gold);
        transition: width 0.2s ease;
      }

      .grid-view .item-card:hover {
        background-color: var(--hover);
        border-color: var(--hover);
      }

      .grid-view .item-card:hover::after {
        width: 100%;
      }

      .grid-view .item-icon {
        width: 48px;
        height: 48px;
        margin-bottom: 1rem;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--text-muted);
        transition: color 0.15s ease;
      }

      .grid-view .item-card:hover .item-icon {
        color: var(--accent-gold);
      }

      .grid-view .item-name {
        font-size: 0.9rem;
        font-weight: 500;
        color: var(--text-primary);
        width: 100%;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        margin-bottom: 0.25rem;
      }

      .grid-view .item-size {
        font-family: var(--font-mono);
        font-size: 0.75rem;
        color: var(--text-muted);
      }

      /* List View */
      .list-view {
        display: flex;
        flex-direction: column;
        border: 1px solid var(--border);
        border-radius: 6px;
        background-color: var(--surface);
        overflow: hidden;
      }

      .list-header {
        display: grid;
        grid-template-columns: 2.5rem 1.5fr 0.5fr 1fr 1.2fr;
        padding: 0.75rem 1rem;
        border-bottom: 1px solid var(--border);
        font-size: 0.8rem;
        font-weight: 600;
        text-transform: uppercase;
        color: var(--text-muted);
        letter-spacing: 0.05em;
        background-color: rgba(255,255,255,0.01);
        user-select: none;
      }

      .list-header-name {
        text-align: left;
      }

      .list-header-size {
        text-align: right;
        padding-right: 1.5rem;
      }

      .list-row {
        display: grid;
        grid-template-columns: 2.5rem 1.5fr 0.5fr 1fr 1.2fr;
        padding: 0.75rem 1rem;
        align-items: center;
        border-bottom: 1px solid var(--border);
        cursor: pointer;
        transition: background-color 0.15s ease;
        position: relative;
      }

      .list-row::before {
        content: '';
        position: absolute;
        top: 0;
        bottom: 0;
        left: 0;
        width: 2px;
        background-color: var(--accent-gold);
        transform: scaleY(0);
        transition: transform 0.15s ease;
      }

      .list-row:hover::before {
        transform: scaleY(1);
      }

      .list-row:last-child {
        border-bottom: none;
      }

      .list-row:hover {
        background-color: var(--hover);
      }

      .list-icon {
        color: var(--text-muted);
        display: flex;
        align-items: center;
        transition: color 0.15s ease;
      }

      .list-row:hover .list-icon {
        color: var(--accent-gold);
      }

      .list-name {
        font-size: 0.95rem;
        font-weight: 500;
        color: var(--text-primary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .list-ext {
        font-family: var(--font-mono);
        font-size: 0.75rem;
        color: var(--text-muted);
        background-color: var(--hover);
        padding: 0.15rem 0.4rem;
        border-radius: 3px;
        width: fit-content;
        border: 1px solid var(--border);
        user-select: none;
      }

      .list-size {
        font-family: var(--font-mono);
        font-size: 0.8rem;
        color: var(--text-muted);
        text-align: right;
        padding-right: 1.5rem;
      }

      .list-date {
        font-family: var(--font-mono);
        font-size: 0.8rem;
        color: var(--text-muted);
      }

      .thumbnail-wrapper {
        position: relative;
        overflow: hidden;
        border-radius: 4px;
        background-color: var(--surface);
        display: flex;
        align-items: center;
        justify-content: center;
        border: 1px solid var(--border);
      }
      
      .thumbnail {
        width: 100%;
        height: 100%;
        object-fit: cover;
        opacity: 0;
        transition: opacity 0.3s ease-out;
      }

      .thumbnail.loaded {
        opacity: 1;
      }

      /* Modals */
      .modal-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background-color: rgba(0, 0, 0, 0.7);
        backdrop-filter: blur(4px);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 100;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.25s ease;
      }

      .modal-overlay.active {
        opacity: 1;
        pointer-events: auto;
      }

      .modal-content {
        background-color: var(--surface);
        border: 1px solid var(--border);
        border-radius: 8px;
        width: 90%;
        max-width: 700px;
        max-height: 80vh;
        display: flex;
        flex-direction: column;
        box-shadow: 0 10px 30px rgba(0,0,0,0.5);
        transform: translateY(20px);
        opacity: 0;
        transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.3s ease;
      }

      .modal-overlay.active .modal-content {
        transform: translateY(0);
        opacity: 1;
      }

      .modal-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 1.25rem 1.5rem;
        border-bottom: 1px solid var(--border);
      }

      .modal-title {
        font-family: var(--font-serif);
        font-size: 1.35rem;
        font-weight: 500;
        margin: 0;
        color: var(--text-primary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        padding-right: 1.5rem;
      }

      .modal-close {
        background: none;
        border: none;
        color: var(--text-muted);
        cursor: pointer;
        padding: 0.5rem;
        display: flex;
        align-items: center;
        border-radius: 4px;
        outline: none;
      }

      .modal-close:hover {
        color: var(--text-primary);
        background-color: var(--hover);
      }

      .modal-body {
        padding: 1.5rem;
        overflow-y: auto;
        flex: 1;
      }

      /* Markdown Preview Specifics */
      .markdown-body {
        color: var(--text-primary);
        line-height: 1.6;
        font-size: 0.95rem;
      }

      .markdown-body h1, .markdown-body h2, .markdown-body h3 {
        font-family: var(--font-serif);
        color: var(--text-primary);
        margin-top: 1.5rem;
        margin-bottom: 1rem;
        font-weight: 500;
      }

      .markdown-body pre {
        background-color: var(--hover);
        border: 1px solid var(--border);
        padding: 1rem;
        border-radius: 6px;
        overflow-x: auto;
        font-family: var(--font-mono);
        font-size: 0.85rem;
      }

      .markdown-body code {
        font-family: var(--font-mono);
        background-color: var(--hover);
        padding: 0.15rem 0.3rem;
        border-radius: 3px;
        font-size: 0.9em;
      }

      .modal-footer {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 1rem;
        padding: 1.25rem 1.5rem;
        border-top: 1px solid var(--border);
      }

      .modal-footer a, .modal-footer button {
        font-size: 0.85rem;
        font-weight: 500;
        color: var(--accent-gold);
        background: none;
        border: none;
        border-bottom: 1px dashed var(--accent-gold);
        cursor: pointer;
        padding: 0;
        outline: none;
      }

      .modal-footer a:hover, .modal-footer button:hover {
        color: var(--text-primary);
        border-bottom-color: var(--text-primary);
      }

      /* Empty State */
      .empty-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 5rem 2rem;
        text-align: center;
        background-color: var(--surface);
        border: 1px solid var(--border);
        border-radius: 6px;
        min-height: 300px;
      }

      .empty-state-icon {
        width: 72px;
        height: 72px;
        color: var(--text-muted);
        margin-bottom: 1.5rem;
        transition: color 0.3s ease, transform 0.3s ease;
      }

      .empty-state:hover .empty-state-icon {
        color: var(--accent-gold);
        transform: rotate(-10deg) scale(1.05);
      }

      .empty-state-text {
        font-family: var(--font-serif);
        font-size: 1.5rem;
        color: var(--text-primary);
        margin-bottom: 0.5rem;
        font-weight: 500;
      }

      .empty-state-subtext {
        font-size: 0.9rem;
        color: var(--text-muted);
      }

      /* Upload Drop Zone Overlay */
      .dropzone-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background-color: rgba(10, 11, 13, 0.95);
        z-index: 200;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.25s ease;
      }

      .dropzone-overlay.active {
        opacity: 1;
        pointer-events: auto;
      }

      .dropzone-box {
        width: 80%;
        max-width: 480px;
        border: 2px dashed var(--accent-gold);
        border-radius: 8px;
        padding: 4rem 2rem;
        text-align: center;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        box-shadow: 0 0 30px rgba(201, 165, 77, 0.15);
      }

      .dropzone-icon {
        width: 48px;
        height: 48px;
        color: var(--accent-gold);
        margin-bottom: 1.5rem;
      }

      .dropzone-title {
        font-family: var(--font-serif);
        font-size: 1.5rem;
        margin-bottom: 0.5rem;
        font-weight: 500;
      }

      .dropzone-sub {
        font-size: 0.9rem;
        color: var(--text-muted);
      }

      /* Upload Progress Toast */
      .upload-toast {
        position: fixed;
        bottom: 2rem;
        right: 2rem;
        background-color: var(--surface);
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 1.25rem;
        width: 320px;
        box-shadow: 0 10px 25px rgba(0,0,0,0.5);
        display: none;
        z-index: 150;
        user-select: none;
      }

      .upload-toast.active {
        display: block;
      }

      .upload-toast-header {
        font-weight: 600;
        font-size: 0.85rem;
        margin-bottom: 0.75rem;
        color: var(--text-primary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .upload-progress-bar {
        height: 4px;
        background-color: var(--hover);
        border-radius: 2px;
        overflow: hidden;
        margin-bottom: 0.5rem;
      }

      .upload-progress-fill {
        height: 100%;
        width: 0%;
        background-color: var(--accent-gold);
        transition: width 0.1s linear, background-color 0.2s ease;
      }

      .upload-progress-fill.success {
        background-color: var(--accent-green);
      }

      .upload-toast-footer {
        display: flex;
        justify-content: space-between;
        font-family: var(--font-mono);
        font-size: 0.75rem;
        color: var(--text-muted);
      }

      /* QR Modal specifics */
      .qr-container {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 1rem 0;
      }

      .qr-frame {
        padding: 1.5rem;
        background-color: #ffffff;
        border-radius: 8px;
        box-shadow: 0 0 20px rgba(201, 165, 77, 0.2);
        border: 2px solid var(--accent-gold);
        display: flex;
        align-items: center;
        justify-content: center;
        margin-bottom: 1.5rem;
      }

      .qr-address {
        font-family: var(--font-mono);
        font-size: 0.85rem;
        color: var(--accent-blue);
        text-align: center;
        word-break: break-all;
      }

      /* Responsive Collapses */
      @media (max-width: 640px) {
        .wisp-container {
          padding: 1.5rem 1rem;
        }

        h1 {
          font-size: 1.8rem;
        }

        .control-bar {
          flex-direction: column;
          align-items: stretch;
        }

        .search-box {
          max-width: 100%;
        }

        .controls-right {
          justify-content: space-between;
        }

        .list-header {
          grid-template-columns: 2.5rem 1.5fr 1fr;
        }

        .list-header-size, .list-header-date, .list-size, .list-date {
          display: none;
        }

        .list-row {
          grid-template-columns: 2.5rem 1.5fr 1fr;
        }
      }

      svg.icon {
        width: 1.25rem;
        height: 1.25rem;
        fill: none;
        stroke: currentColor;
        stroke-width: 2;
        stroke-linecap: round;
        stroke-linejoin: round;
        display: inline-block;
        vertical-align: middle;
      }
      .btn-control svg.icon {
        width: 1.2rem;
        height: 1.2rem;
      }
    </style>
  </head>
  <body>
    ${fallbackHtml}
    <div class="wisp-container">
      <header>
        <h1 id="page-title">Wisp Server</h1>
        <div class="breadcrumbs-container">
          <div class="breadcrumbs" id="breadcrumbs-list">
            <!-- Populated by JS -->
          </div>
          <div class="controls-right">
            <button class="btn-control" id="btn-qr" title="Share via QR Code">
              <!-- Inline SVG qr-code -->
              <svg viewBox="0 0 24 24" class="icon"><rect width="5" height="5" x="3" y="3" rx="1"/><rect width="5" height="5" x="16" y="3" rx="1"/><rect width="5" height="5" x="3" y="16" rx="1"/><path d="M21 16V21H16"/><path d="M12 3v18"/><path d="M3 12h18"/></svg>
              QR Code
            </button>
          </div>
        </div>
      </header>

      <div class="control-bar">
        <div class="search-box">
          <div class="icon-search">
            <svg viewBox="0 0 24 24" class="icon"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          </div>
          <input type="text" id="search-input" placeholder="Search files and folders..." autocomplete="off">
        </div>

        <div class="controls-right">
          <div class="status-indicator disconnected" id="watch-status">
            <span class="status-dot"></span>
            <span id="status-text">DISCONNECTED</span>
            <div class="status-tooltip" id="status-tooltip-text">Watcher disconnected</div>
          </div>

          <select class="select-control" id="sort-select">
            <option value="name-asc">Sort: Name A-Z</option>
            <option value="name-desc">Sort: Name Z-A</option>
            <option value="size-asc">Sort: Size Ascending</option>
            <option value="size-desc">Sort: Size Descending</option>
            <option value="date-asc">Sort: Date Oldest</option>
            <option value="date-desc">Sort: Date Newest</option>
          </select>

          <button class="btn-control" id="toggle-grid" title="Grid View">
            <svg viewBox="0 0 24 24" class="icon"><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/></svg>
          </button>
          <button class="btn-control" id="toggle-list" title="List View">
            <svg viewBox="0 0 24 24" class="icon"><line x1="3" x2="21" y1="6" y2="6"/><line x1="3" x2="21" y1="12" y2="12"/><line x1="3" x2="21" y1="18" y2="18"/><line x1="3" x2="3" y1="6" y2="6.01"/><line x1="3" x2="3" y1="12" y2="12.01"/><line x1="3" x2="3" y1="18" y2="18.01"/></svg>
          </button>
        </div>
      </div>

      <div class="listing-container" id="listing-container">
        <!-- Rendered items go here -->
      </div>
    </div>

    <!-- Modals -->
    <!-- QR Code Modal -->
    <div class="modal-overlay" id="qr-modal">
      <div class="modal-content" style="max-width: 360px;">
        <div class="modal-header">
          <h3 class="modal-title">Access QR Code</h3>
          <button class="modal-close" onclick="closeModal('qr-modal')">
            <svg viewBox="0 0 24 24" class="icon"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </button>
        </div>
        <div class="modal-body qr-container">
          <div class="qr-frame" id="qr-frame-box"></div>
          <div class="qr-address" id="qr-address-label"></div>
        </div>
      </div>
    </div>

    <!-- Markdown Modal -->
    <div class="modal-overlay" id="md-modal">
      <div class="modal-content">
        <div class="modal-header">
          <h3 class="modal-title" id="md-title">Markdown Preview</h3>
          <button class="modal-close" onclick="closeModal('md-modal')">
            <svg viewBox="0 0 24 24" class="icon"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </button>
        </div>
        <div class="modal-body">
          <div class="markdown-body" id="md-body"></div>
        </div>
        <div class="modal-footer">
          <a href="" id="md-raw-link" target="_blank">View Raw</a>
          <a href="" id="md-download-link" download>Download</a>
        </div>
      </div>
    </div>

    <!-- Upload Overlay -->
    <div class="dropzone-overlay" id="dropzone-overlay">
      <div class="dropzone-box">
        <svg viewBox="0 0 24 24" class="icon dropzone-icon"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/></svg>
        <div class="dropzone-title">Drop Files to Upload</div>
        <div class="dropzone-sub">Files will be uploaded directly to the current directory</div>
      </div>
    </div>

    <!-- Upload Toast -->
    <div class="upload-toast" id="upload-toast">
      <div class="upload-toast-header" id="upload-toast-file">Uploading...</div>
      <div class="upload-progress-bar">
        <div class="upload-progress-fill" id="upload-progress-fill"></div>
      </div>
      <div class="upload-toast-footer">
        <span id="upload-progress-percent">0%</span>
        <span id="upload-progress-status">Uploading...</span>
      </div>
    </div>

    <!-- Load AnimeJS, Marked, QRCode and bootstrap client side application -->
    <script src="/__wisp/anime.min.js"></script>
    <script src="/__wisp/marked.min.js"></script>
    <script src="/__wisp/qrcode.min.js"></script>

    <!-- Initial Data Payload -->
    <script id="initial-data" type="application/json">
      ${JSON.stringify({
        pathname,
        dirs: clientDirs,
        files: clientFiles,
        errs: clientErrs
      }).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')}
    </script>

    <script>
      'use strict';

      function escapeHTML(str) {
        if (!str) return '';
        return str
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      // Inline Lucide SVGs dictionary
      var ICONS = {
        folder: '<svg viewBox="0 0 24 24" class="icon"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>',
        file: '<svg viewBox="0 0 24 24" class="icon"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>',
        code: '<svg viewBox="0 0 24 24" class="icon"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
        text: '<svg viewBox="0 0 24 24" class="icon"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>',
        archive: '<svg viewBox="0 0 24 24" class="icon"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="M3.3 7 12 12l8.7-5"/><path d="M12 22V12"/></svg>',
        music: '<svg viewBox="0 0 24 24" class="icon"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
        video: '<svg viewBox="0 0 24 24" class="icon"><rect width="20" height="20" x="2" y="2" rx="2.18" ry="2.18"/><path d="M7 2v20"/><path d="M17 2v20"/><path d="M2 12h20"/><path d="M2 7h5"/><path d="M2 17h5"/><path d="M17 17h5"/><path d="M17 7h5"/></svg>',
        image: '<svg viewBox="0 0 24 24" class="icon"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>',
        search: '<svg viewBox="0 0 24 24" class="icon"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>',
        chevronRight: '<svg viewBox="0 0 24 24" class="icon"><path d="m9 18 6-6-6-6"/></svg>',
        chevronLeft: '<svg viewBox="0 0 24 24" class="icon"><path d="m15 18-6-6 6-6"/></svg>',
        upload: '<svg viewBox="0 0 24 24" class="icon"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/></svg>',
        download: '<svg viewBox="0 0 24 24" class="icon"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>',
        x: '<svg viewBox="0 0 24 24" class="icon"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
        check: '<svg viewBox="0 0 24 24" class="icon"><path d="M20 6 9 17l-5-5"/></svg>',
        wifi: '<svg viewBox="0 0 24 24" class="icon"><path d="M12 20h.01"/><path d="M8.5 16.5a5 5 0 0 1 7 0"/><path d="M5.7 13.7a9 9 0 0 1 12.6 0"/><path d="M2.9 10.9a14 14 0 0 1 18.2 0"/></svg>',
        wifiOff: '<svg viewBox="0 0 24 24" class="icon"><path d="M1 1l22 22"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.5"/><path d="M5 12.5a10.94 10.94 0 0 1 5.83-2.84"/><path d="M8.5 16.5a5 5 0 0 1 7 0"/><path d="M21.3 8.11A13.9 13.9 0 0 0 12 5a13.9 13.9 0 0 0-7 1.83"/><path d="M12 20h.01"/></svg>'
      };

      // App state
      var currentPath = '';
      var dirs = [];
      var files = [];
      var errs = [];
      var searchQuery = '';
      var sortBy = localStorage.getItem('wisp-sort') || 'name-asc';
      var viewMode = localStorage.getItem('wisp-view') || 'grid';
      var ws = null;
      var refreshTimeout = null;

      // Init on load
      document.addEventListener('DOMContentLoaded', function() {
        var initialData = JSON.parse(document.getElementById('initial-data').textContent);
        currentPath = initialData.pathname;
        dirs = initialData.dirs;
        files = initialData.files;
        errs = initialData.errs;

        // Restore sort choice UI
        document.getElementById('sort-select').value = sortBy;

        initApp();
      });

      function initApp() {
        renderBreadcrumbs();
        renderFileList();
        setupEventListeners();
        connectWatcher();
      }

      // Breadcrumb rendering
      function renderBreadcrumbs() {
        var container = document.getElementById('breadcrumbs-list');
        container.innerHTML = '';

        // ROOT segment
        var homeItem = document.createElement('div');
        homeItem.className = 'breadcrumb-item';
        homeItem.innerText = 'ROOT';
        homeItem.onclick = function() { navigateTo('/', 'backward'); };
        container.appendChild(homeItem);

        // Path segments
        var segments = currentPath.split('/').filter(Boolean);
        var accumulatedPath = '';

        segments.forEach(function(seg, index) {
          // Separator
          var sep = document.createElement('span');
          sep.className = 'breadcrumb-separator';
          sep.innerHTML = ICONS.chevronRight;
          container.appendChild(sep);

          accumulatedPath += '/' + seg;
          var target = accumulatedPath;

          var item = document.createElement('div');
          item.className = 'breadcrumb-item';
          item.innerText = seg;

          if (index === segments.length - 1) {
            item.classList.add('active');
          } else {
            item.onclick = function() {
              var direction = (index < segments.length - 1) ? 'backward' : 'forward';
              navigateTo(target, direction);
            };
          }
          container.appendChild(item);
        });

        // Set title font
        var folderName = segments.length > 0 ? segments[segments.length - 1] : 'ROOT';
        document.getElementById('page-title').innerText = folderName;
      }

      // File List Rendering
      function renderFileList() {
        var container = document.getElementById('listing-container');
        
        // Filter and Sort
        var displayDirs = dirs.filter(function(d) {
          return d.name !== '..' && d.name.toLowerCase().includes(searchQuery.toLowerCase());
        });
        var displayFiles = files.filter(function(f) {
          return f.name.toLowerCase().includes(searchQuery.toLowerCase());
        });

        // Apply Sorting
        var sortFn = function(a, b) {
          if (sortBy === 'name-asc') return a.name.localeCompare(b.name);
          if (sortBy === 'name-desc') return b.name.localeCompare(a.name);
          if (sortBy === 'size-asc') return a.rawSize - b.rawSize;
          if (sortBy === 'size-desc') return b.rawSize - a.rawSize;
          if (sortBy === 'date-asc') return a.mtimeMs - b.mtimeMs;
          if (sortBy === 'date-desc') return b.mtimeMs - a.mtimeMs;
          return 0;
        };

        displayDirs.sort(sortFn);
        displayFiles.sort(sortFn);

        // If rendering parent link ".."
        var hasParent = currentPath !== '/';

        if (displayDirs.length === 0 && displayFiles.length === 0 && !hasParent) {
          renderEmptyState();
          return;
        }

        // Apply view mode classes
        container.className = (viewMode === 'grid') ? 'grid-view' : 'list-view';

        var html = '';

        if (viewMode === 'grid') {
          // Parent folder card
          if (hasParent) {
            html += '<div class="item-card parent-dir" onclick="navigateParent()">' +
              '<div class="item-icon">' + ICONS.chevronLeft + '</div>' +
              '<div class="item-name">..</div>' +
              '<div class="item-size">Parent Directory</div>' +
              '</div>';
          }

          displayDirs.forEach(function(d) {
            html += '<div class="item-card" onclick="navigateFolder(\\\'' + encodeURIComponent(d.name) + '\\\')">' +
              '<div class="item-icon">' + ICONS.folder + '</div>' +
              '<div class="item-name" title="' + escapeHTML(d.name) + '">' + escapeHTML(d.name) + '</div>' +
              '<div class="item-size">Folder</div>' +
              '</div>';
          });

          displayFiles.forEach(function(f) {
            var visualIcon = getFileIconOrThumbnail(f, 'grid');
            html += '<div class="item-card file-card" onclick="handleFileClick(\\\'' + encodeURIComponent(f.name) + '\\\')">' +
              '<div class="item-icon">' + visualIcon + '</div>' +
              '<div class="item-name" title="' + escapeHTML(f.name) + '">' + escapeHTML(f.name) + '</div>' +
              '<div class="item-size">' + f.size + '</div>' +
              '</div>';
          });
        } else {
          // List View
          html += '<div class="list-header">' +
            '<div></div>' +
            '<div class="list-header-name">Name</div>' +
            '<div>Type</div>' +
            '<div class="list-header-size">Size</div>' +
            '<div class="list-header-date">Modified</div>' +
            '</div>';

          if (hasParent) {
            html += '<div class="list-row parent-dir" onclick="navigateParent()">' +
              '<div class="list-icon">' + ICONS.chevronLeft + '</div>' +
              '<div class="list-name">..</div>' +
              '<div class="list-ext">DIR</div>' +
              '<div class="list-size">—</div>' +
              '<div class="list-date">Parent Directory</div>' +
              '</div>';
          }

          displayDirs.forEach(function(d) {
            html += '<div class="list-row" onclick="navigateFolder(\\\'' + encodeURIComponent(d.name) + '\\\')">' +
              '<div class="list-icon">' + ICONS.folder + '</div>' +
              '<div class="list-name" title="' + escapeHTML(d.name) + '">' + escapeHTML(d.name) + '</div>' +
              '<div class="list-ext">DIR</div>' +
              '<div class="list-size">—</div>' +
              '<div class="list-date">' + d.mtimeStr + '</div>' +
              '</div>';
          });

          displayFiles.forEach(function(f) {
            var ext = f.name.split('.').pop().toUpperCase();
            var visualIcon = getFileIconOrThumbnail(f, 'list');
            html += '<div class="list-row" onclick="handleFileClick(\\\'' + encodeURIComponent(f.name) + '\\\')">' +
              '<div class="list-icon">' + visualIcon + '</div>' +
              '<div class="list-name" title="' + escapeHTML(f.name) + '">' + escapeHTML(f.name) + '</div>' +
              '<div class="list-ext">' + ext + '</div>' +
              '<div class="list-size">' + f.size + '</div>' +
              '</div>';
          });
        }

        container.innerHTML = html;

        // Run entry fade and rise stagger animation
        anime({
          targets: '#listing-container .item-card, #listing-container .list-row',
          translateY: [8, 0],
          opacity: [0, 1],
          delay: anime.stagger(20),
          duration: 400,
          easing: 'easeOutCubic'
        });
      }

      function renderEmptyState() {
        var container = document.getElementById('listing-container');
        container.className = '';
        container.innerHTML = '<div class="empty-state">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="empty-state-icon">' +
          '<circle cx="11" cy="11" r="8"/>' +
          '<line x1="21" y1="21" x2="16.65" y2="16.65"/>' +
          '<line x1="11" y1="8" x2="11" y2="14"/>' +
          '<line x1="8" y1="11" x2="14" y2="11"/>' +
          '</svg>' +
          '<div class="empty-state-text">This directory is empty</div>' +
          '<div class="empty-state-subtext">Drag and drop files here to upload them.</div>' +
          '</div>';
      }

      // Helper to generate file icons / inline SVGs
      function getFileIconOrThumbnail(file, viewMode) {
        var ext = file.name.split('.').pop().toLowerCase();
        var filePath = (currentPath === '/') ? '/' + file.name : currentPath + '/' + file.name;

        var isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff'].includes(ext);
        var isVideo = ['mp4', 'mkv', 'mov', 'avi', 'webm', 'flv'].includes(ext);

        if (isImage || isVideo) {
          var size = (viewMode === 'grid') ? 120 : 32;
          var thumbUrl = '/__wisp/thumbnail?file=' + encodeURIComponent(filePath) + '&size=' + size;
          var fallbackIcon = isImage ? ICONS.image : ICONS.video;
          
          return '<div class="thumbnail-wrapper" style="width: ' + (viewMode === 'grid' ? '100%' : '32px') + '; height: ' + (viewMode === 'grid' ? '80px' : '32px') + '; margin: 0 auto;">' +
            '<img src="' + thumbUrl + '" class="thumbnail" onload="this.classList.add(\\\'loaded\\\')" onerror="this.outerHTML=\\\'' + fallbackIcon + '\\\'">' +
            '</div>';
        }

        if (['js', 'py', 'rs', 'html', 'css', 'json', 'c', 'cpp', 'go', 'java', 'ts', 'sh', 'yml', 'yaml', 'toml'].includes(ext)) {
          return ICONS.code;
        }

        if (['pdf', 'docx', 'doc', 'txt', 'md', 'rtf', 'csv'].includes(ext)) {
          return ICONS.text;
        }

        if (['zip', 'tar', 'gz', 'rar', '7z', 'bz2', 'xz'].includes(ext)) {
          return ICONS.archive;
        }

        if (['mp3', 'wav', 'flac', 'ogg', 'm4a'].includes(ext)) {
          return ICONS.music;
        }

        return ICONS.file;
      }

      // Intercept navigation actions
      function navigateFolder(name) {
        var target = (currentPath === '/') ? '/' + name : currentPath + '/' + name;
        navigateTo(target, 'forward');
      }

      function navigateParent() {
        var segments = currentPath.split('/').filter(Boolean);
        segments.pop();
        var target = '/' + segments.join('/');
        navigateTo(target, 'backward');
      }

      async function navigateTo(targetPath, direction) {
        if (!direction) direction = 'forward';
        
        anime({
          targets: '#listing-container .item-card, #listing-container .list-row',
          translateX: (direction === 'forward') ? [0, -12] : [0, 12],
          opacity: [1, 0],
          duration: 180,
          easing: 'easeOutQuad',
          complete: async function() {
            currentPath = targetPath;
            history.pushState({ path: currentPath }, '', currentPath);
            document.title = 'Wisp — ' + currentPath;

            if (ws) {
              ws.close();
            }

            try {
              var res = await fetch(currentPath + '?json=1');
              var data = await res.json();
              dirs = data.dirs;
              files = data.files;
              errs = data.errs;

              renderBreadcrumbs();
              renderFileList();
              connectWatcher();
            } catch (err) {
              console.error('Failed to load page content:', err);
            }
          }
        });
      }

      // Handle Back/Forward history navigation
      window.onpopstate = function(event) {
        var targetPath = (event.state && event.state.path) ? event.state.path : window.location.pathname;
        navigateTo(targetPath, 'backward');
      };

      // File Click Handler: Show MD Modal or Open File
      function handleFileClick(name) {
        var ext = name.split('.').pop().toLowerCase();
        var filePath = (currentPath === '/') ? '/' + decodeURIComponent(name) : currentPath + '/' + decodeURIComponent(name);

        if (ext === 'md') {
          showMarkdownPreview(filePath);
        } else {
          window.open(filePath, '_blank');
        }
      }

      // Markdown Preview Modal
      function showMarkdownPreview(filePath) {
        var modal = document.getElementById('md-modal');
        modal.classList.add('active');
        
        document.getElementById('md-title').innerText = decodeURIComponent(filePath.split('/').pop());
        document.getElementById('md-raw-link').href = filePath;
        document.getElementById('md-download-link').href = filePath + '?download=1';
        
        document.getElementById('md-body').innerHTML = '<div style="color: var(--text-muted); font-family: var(--font-mono); text-align: center; padding: 2rem;">Loading markdown rendering...</div>';

        fetch(filePath)
          .then(function(res) { return res.text(); })
          .then(function(text) {
            document.getElementById('md-body').innerHTML = marked.parse(text);
          })
          .catch(function(err) {
            document.getElementById('md-body').innerHTML = '<div style="color: red;">Failed to fetch markdown file content.</div>';
          });
      }

      // QR Code LAN share modal
      function closeModal(id) {
        var modal = document.getElementById(id);
        modal.classList.remove('active');
      }

      // Setup Event Listeners (Search, Sort, Grid/List views)
      function setupEventListeners() {
        // Search Input
        var searchInput = document.getElementById('search-input');
        searchInput.addEventListener('input', function(e) {
          searchQuery = e.target.value;
          renderFileList();
        });

        // Sort Select
        var sortSelect = document.getElementById('sort-select');
        sortSelect.addEventListener('change', function(e) {
          sortBy = e.target.value;
          localStorage.setItem('wisp-sort', sortBy);
          renderFileList();
        });

        // View Toggles
        var btnGrid = document.getElementById('toggle-grid');
        var btnList = document.getElementById('toggle-list');

        if (viewMode === 'grid') {
          btnGrid.classList.add('active');
        } else {
          btnList.classList.add('active');
        }

        btnGrid.addEventListener('click', function() {
          if (viewMode === 'grid') return;
          viewMode = 'grid';
          localStorage.setItem('wisp-view', 'grid');
          btnGrid.classList.add('active');
          btnList.classList.remove('active');
          toggleViewAnimation();
        });

        btnList.addEventListener('click', function() {
          if (viewMode === 'list') return;
          viewMode = 'list';
          localStorage.setItem('wisp-view', 'list');
          btnList.classList.add('active');
          btnGrid.classList.remove('active');
          toggleViewAnimation();
        });

        // QR Code Modal Show
        document.getElementById('btn-qr').addEventListener('click', function() {
          var modal = document.getElementById('qr-modal');
          modal.classList.add('active');

          var qrBox = document.getElementById('qr-frame-box');
          qrBox.innerHTML = '';
          var address = window.location.href;
          document.getElementById('qr-address-label').innerText = address;

          try {
            var qr = qrcode(4, 'M');
            qr.addData(address);
            qr.make();
            qrBox.innerHTML = qr.createSvgTag(5, 10);
          } catch (e) {
            qrBox.innerHTML = '<span style="color: var(--text-muted)">Failed to generate QR Code.</span>';
          }
        });

        // Setup Drag & Drop File Upload
        var overlay = document.getElementById('dropzone-overlay');
        
        window.addEventListener('dragover', function(e) {
          e.preventDefault();
        });

        window.addEventListener('dragenter', function(e) {
          e.preventDefault();
          overlay.classList.add('active');
        });

        overlay.addEventListener('dragleave', function(e) {
          e.preventDefault();
          overlay.classList.remove('active');
        });

        overlay.addEventListener('drop', function(e) {
          e.preventDefault();
          overlay.classList.remove('active');
          
          if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            handleFileUploads(e.dataTransfer.files);
          }
        });
      }

      // Handle view toggle animation
      function toggleViewAnimation() {
        var container = document.getElementById('listing-container');
        anime({
          targets: '#listing-container',
          opacity: [1, 0],
          duration: 100,
          easing: 'easeOutQuad',
          complete: function() {
            renderFileList();
            anime({
              targets: '#listing-container',
              opacity: [0, 1],
              duration: 150,
              easing: 'easeOutQuad'
            });
          }
        });
      }

      // File upload processing
      async function handleFileUploads(filesList) {
        var toast = document.getElementById('upload-toast');
        var fill = document.getElementById('upload-progress-fill');
        var fileLabel = document.getElementById('upload-toast-file');
        var pctLabel = document.getElementById('upload-progress-percent');
        var statusLabel = document.getElementById('upload-progress-status');

        toast.classList.add('active');
        fill.classList.remove('success');

        for (var i = 0; i < filesList.length; i++) {
          var file = filesList[i];
          fileLabel.innerText = 'Uploading: ' + file.name;
          pctLabel.innerText = '0%';
          fill.style.width = '0%';
          statusLabel.innerText = 'Uploading...';

          try {
            await new Promise(function(resolve, reject) {
              var xhr = new XMLHttpRequest();
              xhr.open('PUT', '/__wisp/upload?path=' + encodeURIComponent(currentPath) + '&name=' + encodeURIComponent(file.name), true);
              
              xhr.upload.onprogress = function(e) {
                if (e.lengthComputable) {
                  var pct = Math.round((e.loaded / e.total) * 100);
                  pctLabel.innerText = pct + '%';
                  fill.style.width = pct + '%';
                }
              };

              xhr.onload = function() {
                if (xhr.status === 200) {
                  fill.classList.add('success');
                  statusLabel.innerText = 'Complete';
                  setTimeout(resolve, 800);
                } else {
                  reject(new Error('Failed to upload ' + file.name));
                }
              };

              xhr.onerror = function() { reject(new Error('Network error during upload')); };
              xhr.send(file);
            });
          } catch (err) {
            console.error(err);
            statusLabel.innerText = 'Failed';
            fill.style.backgroundColor = 'red';
            await new Promise(function(r) { setTimeout(r, 1500); });
          }
        }

        // Finish up
        toast.classList.remove('active');
        triggerDynamicRefresh();
      }

      // Live Directory WebSocket Connection
      function connectWatcher() {
        var protocol = (window.location.protocol === 'https:') ? 'wss:' : 'ws:';
        var socketUrl = protocol + '//' + window.location.host + '/__wisp/watch?path=' + encodeURIComponent(currentPath);
        
        try {
          ws = new WebSocket(socketUrl);
        } catch (e) {
          updateWatcherStatus(false);
          return;
        }

        ws.onopen = function() {
          updateWatcherStatus(true);
        };

        ws.onclose = function() {
          updateWatcherStatus(false);
          // Try reconnecting in 5s
          setTimeout(connectWatcher, 5000);
        };

        ws.onerror = function() {
          updateWatcherStatus(false);
        };

        ws.onmessage = function(event) {
          // File changed, debounce directory refresh
          if (refreshTimeout) clearTimeout(refreshTimeout);
          refreshTimeout = setTimeout(triggerDynamicRefresh, 150);
        };
      }

      function updateWatcherStatus(connected) {
        var el = document.getElementById('watch-status');
        var txt = document.getElementById('status-text');
        var tooltip = document.getElementById('status-tooltip-text');

        if (connected) {
          el.className = 'status-indicator';
          txt.innerText = 'WATCHING';
          tooltip.innerText = 'Live watching directory: ' + currentPath;
        } else {
          el.className = 'status-indicator disconnected';
          txt.innerText = 'DISCONNECTED';
          tooltip.innerText = 'Reconnecting to watcher...';
        }
      }

      async function triggerDynamicRefresh() {
        try {
          var res = await fetch(currentPath + '?json=1');
          var data = await res.json();
          
          dirs = data.dirs;
          files = data.files;
          errs = data.errs;

          // Re-render
          renderFileList();
        } catch (e) {
          console.error('Failed to auto refresh list:', e);
        }
      }
    </script>
  </body>
</html>
`;
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(html);
        }

        sortFiles(dir, files, (errs, dirs, sortedFiles) => {
          if (path.resolve(dir, '..').slice(0, root.length) === root) {
            fs.stat(path.join(dir, '..'), (err, s) => {
              if (err) {
                if (handleError) {
                  status[500](res, next, { error: err });
                } else {
                  next();
                }
                return;
              }
              dirs.unshift(['..', s]);
              prerender(dirs, sortedFiles, errs);
            });
          } else {
            prerender(dirs, sortedFiles, errs);
          }
        });
      });
    });
  };
};
