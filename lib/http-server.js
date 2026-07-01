'use strict';

var fs = require('fs'),
  union = require('union'),
  httpServerCore = require('./core'),
  auth = require('basic-auth'),
  httpProxy = require('http-proxy'),
  corser = require('corser'),
  secureCompare = require('secure-compare');
var { minimatch } = require('minimatch');
var url = require('url');

//
// Remark: backwards compatibility for previous
// case convention of HTTP
//
exports.HttpServer = exports.HTTPServer = HttpServer;

/**
 * Returns a new instance of HttpServer with the
 * specified `options`.
 */
exports.createServer = function (options) {
  return new HttpServer(options);
};

/**
 * Constructor function for the HttpServer object
 * which is responsible for serving static files along
 * with other HTTP-related features.
 */
function HttpServer(options) {
  options = options || {};
  var proxyAll = options.proxyAll === true || options.proxyAll === 'true';

  if (proxyAll && typeof options.proxy !== 'string') {
    throw new Error('proxyAll option requires "proxy" to be configured');
  }

  if (options.root) {
    this.root = options.root;
  } else {
    try {
      // eslint-disable-next-line no-sync
      fs.lstatSync('./public');
      this.root = './public';
    } catch (err) {
      this.root = './';
    }
  }

  // CRLF injection prevention
  for ( const [key, value] of Object.entries(options.headers || {}) ) {
    if (typeof key !== 'string' || typeof value !== 'string') {
      throw new Error('Header is not a string or contains CRLF');
    }
    if (key.includes('\r') || key.includes('\n') || value.includes('\r') || value.includes('\n')) {
      throw new Error('Header is not a string or contains CRLF');
    }
  }

  this.headers = options.headers || {};
  this.headers['Accept-Ranges'] = 'bytes';

  this.cache = (
    // eslint-disable-next-line no-nested-ternary
    options.cache === undefined ? 3600 :
    // -1 is a special case to turn off caching.
    // https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Cache-Control#Preventing_caching
      options.cache === -1 ? 'no-cache, no-store, must-revalidate' :
        options.cache // in seconds.
  );
  this.showDir = options.showDir !== 'false';
  this.dirOverrides404 = options.dirOverrides404;
  this.autoIndex = options.autoIndex !== 'false';
  this.showDotfiles = options.showDotfiles;
  this.hidePermissions = options.hidePermissions;
  this.gzip = options.gzip === true;
  this.brotli = options.brotli === true;
  this.forceContentEncoding = options.forceContentEncoding === true;
  if (options.ext) {
    this.ext = options.ext === true
      ? 'html'
      : options.ext;
  }
  this.contentType = options.contentType ||
    (this.ext === 'html' ? 'text/html' : 'application/octet-stream');

  var before = options.before ? options.before.slice() : [];

  if (options.logFn) {
    before.push(function (req, res) {
      options.logFn(req, res);
      res.emit('next');
    });
  }

  if (options.username || options.password) {
    if (!options.username || !options.password) {
      throw new Error('Basic authentication requires both username and password to be specified');
    }

    before.push(function (req, res) {
      var credentials = auth(req);

      // We perform these outside the if to avoid short-circuiting and giving
      // an attacker knowledge of whether the username is correct via a timing
      // attack.
      if (credentials) {
        // if credentials is defined, name and pass are guaranteed to be string
        // type
        var usernameEqual = secureCompare(options.username.toString(), credentials.name);
        var passwordEqual = secureCompare(options.password.toString(), credentials.pass);
        if (usernameEqual && passwordEqual) {
          return res.emit('next');
        }
      }

      res.statusCode = 401;
      res.setHeader('WWW-Authenticate', 'Basic realm=""');
      res.end('Access denied');
    });
  }

  if (options.allowedHosts) {
    before.push(function (req, res) {
      let host = req.headers && req.headers.host;
      if (host) {
        // don't include port number in host check
        host = host.split(':')[0];
      }

      if (!host || !options.allowedHosts.includes(host)) {
        res.statusCode = 403;
        res.end('Access denied');
        return;
      }

      return res.emit('next');
    });
  }

  if (options.coop) {
    this.headers['Cross-Origin-Opener-Policy'] = options.coopHeader || 'same-origin';
    this.headers['Cross-Origin-Embedder-Policy'] = 'require-corp';
  }

  // CORS configuration:
  // --cors enables CORS by setting Access-Control-Allow-Origin to '*'
  // --cors=header1,header2 also adds custom headers to Access-Control-Allow-Headers
  if (options.cors) {
    this.headers['Access-Control-Allow-Origin'] = '*';
    this.headers['Access-Control-Allow-Headers'] = 'Origin, X-Requested-With, Content-Type, Accept, Range';
    if (options.corsHeaders) {
      options.corsHeaders.split(/\s*,\s*/)
        .forEach(function (h) { this.headers['Access-Control-Allow-Headers'] += ', ' + h; }, this);
    }
    before.push(corser.create(options.corsHeaders ? {
      requestHeaders: this.headers['Access-Control-Allow-Headers'].split(/\s*,\s*/)
    } : null));
  }

  if (options.privateNetworkAccess) {
    this.headers['Access-Control-Allow-Private-Network'] = true;
  }

  if (options.robots) {
    before.push(function (req, res) {
      if (req.url === '/robots.txt') {
        res.setHeader('Content-Type', 'text/plain');
        var robots = options.robots === true
          ? 'User-agent: *\nDisallow: /'
          : options.robots.replace(/\\n/, '\n');

        return res.end(robots);
      }

      res.emit('next');
    });
  }

  if (typeof options.proxyConfig === 'object') {
    var proxy = httpProxy.createProxyServer();
    before.push(function (req, res, next) {
      for (var key of Object.keys(options.proxyConfig)) {
        if (!minimatch(req.url, key)) continue;
        req.proxy ??= {};
        var matchConfig = options.proxyConfig[key];
        
        if (matchConfig.pathRewrite) {
          Object.entries(matchConfig.pathRewrite).forEach(rewrite => {
            req.url = req.url.replace(new RegExp(rewrite[0]), rewrite[1]);
          });
        }
        
        var configEntries = Object.entries(matchConfig).filter(entry => entry[0] !== "pathRewrite");
        configEntries.forEach(entry => req.proxy[entry[0]] = entry[1]);
        break;
      }

      if (req.proxy) {
        if (options.logFn) {
          options.logFn(req, res);
        }
        proxy.web(req, res, req.proxy, function (err, req, res) {
          if (options.logFn) {
            options.logFn(req, res, {
              message: err.message,
              status: res.statusCode });
          }
          res.emit('next');
        });
      } else {
        next();
      }
    });
  }

  if (!proxyAll) {
    before.push(httpServerCore({
      root: this.root,
      baseDir: options.baseDir,
      cache: this.cache,
      showDir: this.showDir,
      showDotfiles: this.showDotfiles,
      hidePermissions: this.hidePermissions,
      autoIndex: this.autoIndex,
      defaultExt: this.ext,
      dirOverrides404: this.dirOverrides404,
      gzip: this.gzip,
      brotli: this.brotli,
      forceContentEncoding: this.forceContentEncoding,
      contentType: this.contentType,
      mimetypes: options.mimetypes,
      handleError: typeof options.proxy !== 'string'
    }));
  }

  if (typeof options.proxy === 'string') {
    var proxyOptions = options.proxyOptions || {};

    if (proxyOptions.changeOrigin == null) {
        proxyOptions.changeOrigin = true;
    }

    var proxy = httpProxy.createProxyServer({
      ...proxyOptions,
      target: options.proxy,
    });
    before.push(function (req, res) {
      proxy.web(req, res, {}, function (err, req, res) {
        if (options.logFn) {
          options.logFn(req, res, {
            message: err.message,
            status: res.statusCode });
        }
        res.emit('next');
      });
    });
  }

  var serverOptions = {
    before: before,
    headers: this.headers,
    onError: function (err, req, res) {
      if (options.logFn) {
        options.logFn(req, res, err);
      }

      res.end();
    }
  };

  if (options.https) {
    serverOptions.https = options.https;
  }

  this.server = serverOptions.https && serverOptions.https.passphrase
    // if passphrase is set, shim must be used as union does not support
    ? require('./shims/https-server-shim')(serverOptions)
    : union.createServer(serverOptions);

  // Setup WebSocket Server for Live Directory Watching
  const WebSocket = require('ws');
  const path = require('path');
  const wss = new WebSocket.Server({ noServer: true });

  const wispUpgradeListener = function wispUpgrade(request, socket, head) {
    const reqUrl = request ? (request.url || '') : '';
    const parsedUrl = url.parse(reqUrl, true);
    if (parsedUrl.pathname === '/__wisp/watch') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
  };

  const originalOn = this.server.on;
  const originalAddListener = this.server.addListener;

  const wrapUpgradeListener = function (listener) {
    const wrapped = function wispUpgradeWrapper(request, socket, head) {
      const reqUrl = request ? (request.url || '') : '';
      const parsedUrl = url.parse(reqUrl);
      if (parsedUrl.pathname === '/__wisp/watch') {
        return;
      }
      return listener.apply(this, arguments);
    };
    wrapped.originalListener = listener;
    return wrapped;
  };

  this.server.on = this.server.addListener = function (event, listener) {
    if (event === 'upgrade' && listener !== wispUpgradeListener) {
      return originalAddListener.call(this, event, wrapUpgradeListener(listener));
    }
    return originalAddListener.apply(this, arguments);
  };

  // Add the watcher upgrade listener
  originalOn.call(this.server, 'upgrade', wispUpgradeListener);

  // Override listeners/rawListeners to hide our wisp upgrade listener and unwrap others
  const originalListeners = this.server.listeners;
  this.server.listeners = function (event) {
    const list = originalListeners.apply(this, arguments);
    if (event === 'upgrade') {
      return list
        .map(l => l.originalListener || l)
        .filter(l => l !== wispUpgradeListener && l.name !== 'wispUpgrade');
    }
    return list;
  };

  if (this.server.rawListeners) {
    const originalRawListeners = this.server.rawListeners;
    this.server.rawListeners = function (event) {
      const list = originalRawListeners.apply(this, arguments);
      if (event === 'upgrade') {
        return list.map(l => {
          if (l.listener) {
            const unwrapped = l.listener.originalListener || l.listener;
            if (unwrapped === wispUpgradeListener || unwrapped.name === 'wispUpgrade') return null;
            return Object.assign({}, l, { listener: unwrapped });
          }
          const unwrapped = l.originalListener || l;
          if (unwrapped === wispUpgradeListener || unwrapped.name === 'wispUpgrade') return null;
          return unwrapped;
        }).filter(Boolean);
      }
      return list;
    };
  }

  // Cleanup watchers and websocket server on close to allow processes/ports to exit immediately
  this.server.on('close', () => {
    if (wss.clients) {
      wss.clients.forEach(client => {
        client.terminate();
      });
    }
    wss.close();
  });

  const selfRoot = this.root || options.root || './';
  wss.on('connection', (ws, request) => {
    const parsedUrl = url.parse(request.url, true);
    const targetPath = parsedUrl.query.path || '/';
    const rootDir = path.resolve(selfRoot);
    const dirPath = path.normalize(path.join(rootDir, path.relative('/', decodeURIComponent(targetPath))));

    if (!dirPath.startsWith(rootDir)) {
      ws.close(1008, 'Access Denied');
      return;
    }

    fs.stat(dirPath, (err, stat) => {
      if (err || !stat.isDirectory()) {
        ws.close(1011, 'Invalid Directory');
        return;
      }

      let watcher;
      try {
        watcher = fs.watch(dirPath, (eventType, filename) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ event: eventType, filename }));
          }
        });
      } catch (watchErr) {
        console.error('Failed to watch directory:', watchErr);
        ws.close(1011, 'Watcher Creation Failed');
        return;
      }

      ws.on('close', () => {
        if (watcher) {
          watcher.close();
        }
      });
    });
  });

  if (isNaN(options.timeout) || isNaN(parseFloat(options.timeout))) {
    this.server.setTimeout(120);
  } else {
    // set custom timeout only if options.timeout is a numeric string
    this.server.setTimeout(Math.max(0, Number(options.timeout)));
  }

  if (typeof options.proxy === 'string' && options.websocket) {
    this.server.on('upgrade', function (request, socket, head) {
      try {
        proxy.ws(request, socket, head, {
          target: options.proxy,
          changeOrigin: true
        }, function (err, req, res) {
          if (options.logFn) {
            options.logFn(req, res, {
              message: err?.message,
              status: res?.statusCode });
          }
          if (res && typeof res.emit === 'function') {
            res.emit('next');
          }
        });
      } catch (proxyErr) {
        if (options.logFn) {
          options.logFn(request, null, {
            message: proxyErr.message
          });
        }
        socket.destroy();
      }
    });
  }
}

HttpServer.prototype.listen = function () {
  this.server.listen.apply(this.server, arguments);
};

HttpServer.prototype.close = function () {
  return this.server.close();
};

HttpServer.prototype.address = function () {
  return this.server.address();
};
