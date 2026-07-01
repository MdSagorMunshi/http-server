'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const CACHE_DIR = path.join('/home/rynex/Desktop/PROJECT_2026/wisp/http-server', '.wisp-cache');

// Ensure cache directory exists
try {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
} catch (e) {
  console.error('Failed to create cache directory:', e);
}

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff']);
const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.mov', '.avi', '.webm', '.flv']);

function getThumbnail(req, res, opts, parsedUrl) {
  const fileQuery = parsedUrl.query ? parsedUrl.query.split('&').find(p => p.startsWith('file=')) : null;
  const sizeQuery = parsedUrl.query ? parsedUrl.query.split('&').find(p => p.startsWith('size=')) : null;
  
  if (!fileQuery) {
    res.statusCode = 400;
    res.end('Missing file parameter');
    return;
  }
  
  const file = decodeURIComponent(fileQuery.split('=')[1]);
  const size = sizeQuery ? parseInt(sizeQuery.split('=')[1], 10) : 120;
  
  // Resolve path and prevent directory traversal
  const rootDir = path.resolve(opts.root);
  const filePath = path.normalize(path.join(rootDir, path.relative('/', file)));
  
  if (!filePath.startsWith(rootDir)) {
    res.statusCode = 403;
    res.end('Access Denied');
    return;
  }
  
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.statusCode = 404;
      res.end('File Not Found');
      return;
    }
    
    const ext = path.extname(filePath).toLowerCase();
    const isImage = IMAGE_EXTS.has(ext);
    const isVideo = VIDEO_EXTS.has(ext);
    
    if (!isImage && !isVideo) {
      res.statusCode = 400;
      res.end('Unsupported file type');
      return;
    }
    
    // Create cache key based on path, size, and modified time
    const key = crypto.createHash('md5').update(`${filePath}_${stat.mtimeMs}_${size}`).digest('hex') + '.jpg';
    const cachePath = path.join(CACHE_DIR, key);
    
    fs.stat(cachePath, (cacheErr, cacheStat) => {
      if (!cacheErr && cacheStat.isFile()) {
        // Serve from cache
        serveThumbnail(res, cachePath);
        return;
      }
      
      // Generate thumbnail
      if (isImage) {
        // ImageMagick convert: extract first frame [0], crop and scale to square
        execFile('convert', [
          `${filePath}[0]`,
          '-thumbnail', `${size}x${size}^`,
          '-gravity', 'center',
          '-extent', `${size}x${size}`,
          cachePath
        ], (execErr) => {
          if (execErr) {
            console.error('ImageMagick thumbnail failed:', execErr);
            res.statusCode = 500;
            res.end('Thumbnail Generation Failed');
            return;
          }
          serveThumbnail(res, cachePath);
        });
      } else if (isVideo) {
        // Video: extract frame and then crop it
        const tempPath = path.join(CACHE_DIR, `temp_${key}.jpg`);
        
        // Try extracting at 2 seconds
        execFile('ffmpeg', [
          '-y',
          '-ss', '00:00:02',
          '-i', filePath,
          '-vframes', '1',
          tempPath
        ], (ffmpegErr) => {
          if (ffmpegErr) {
            // Fall back to beginning of video
            execFile('ffmpeg', [
              '-y',
              '-i', filePath,
              '-vframes', '1',
              tempPath
            ], (ffmpegErr2) => {
              if (ffmpegErr2) {
                console.error('FFmpeg thumbnail failed:', ffmpegErr2);
                res.statusCode = 500;
                res.end('Frame Extraction Failed');
                return;
              }
              cropAndServe();
            });
          } else {
            cropAndServe();
          }
          
          function cropAndServe() {
            execFile('convert', [
              tempPath,
              '-thumbnail', `${size}x${size}^`,
              '-gravity', 'center',
              '-extent', `${size}x${size}`,
              cachePath
            ], (cropErr) => {
              // Delete temp frame
              fs.unlink(tempPath, () => {});
              
              if (cropErr) {
                console.error('Video thumbnail crop failed:', cropErr);
                res.statusCode = 500;
                res.end('Thumbnail Crop Failed');
                return;
              }
              serveThumbnail(res, cachePath);
            });
          }
        });
      }
    });
  });
}

function serveThumbnail(res, filePath) {
  res.writeHead(200, {
    'Content-Type': 'image/jpeg',
    'Cache-Control': 'max-age=31536000, immutable'
  });
  fs.createReadStream(filePath).pipe(res);
}

module.exports = getThumbnail;
