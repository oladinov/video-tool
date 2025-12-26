const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { execFile, spawn } = require('child_process');
const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const VIDEO_EXT = new Set(['.mp4', '.mkv', '.mov', '.avi']);
const SUB_EXT = new Set(['.srt', '.ass', '.ssa', '.vtt']);

const PORT = process.env.PORT || 4000;
const ROOTS = (process.env.ROOTS || '')
  .split(',')
  .map((p) => p.trim())
  .filter(Boolean)
  .map((p) => path.resolve(p));

function ensureRootsConfigured() {
  if (!ROOTS.length) {
    throw new Error('No hay rutas en ROOTS');
  }
}

function isInsideRoots(targetPath) {
  const normalized = path.resolve(targetPath);
  return ROOTS.some((root) => {
    const normalizedRoot = path.resolve(root);
    return normalized === normalizedRoot || normalized.startsWith(normalizedRoot + path.sep);
  });
}

function resolvePath(requestPath) {
  ensureRootsConfigured();
  const candidate = requestPath ? path.resolve(requestPath) : ROOTS[0];
  if (!isInsideRoots(candidate)) {
    throw new Error('Ruta fuera de las ROOTS permitidas');
  }
  return candidate;
}

async function listDir(targetPath) {
  const dirents = await fsp.readdir(targetPath, { withFileTypes: true });
  const entries = await Promise.all(
    dirents.map(async (dirent) => {
      const full = path.join(targetPath, dirent.name);
      const stats = await fsp.stat(full);
      return {
        name: dirent.name,
        path: full,
        isDirectory: dirent.isDirectory(),
        size: stats.size,
        modified: stats.mtimeMs,
        ext: dirent.isDirectory() ? null : path.extname(dirent.name).toLowerCase(),
        kind: dirent.isDirectory()
          ? 'dir'
          : VIDEO_EXT.has(path.extname(dirent.name).toLowerCase())
          ? 'video'
          : SUB_EXT.has(path.extname(dirent.name).toLowerCase())
          ? 'sub'
          : 'file',
      };
    })
  );
  return entries;
}

function runFfprobe(filePath) {
  return new Promise((resolve) => {
    const args = [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      filePath,
    ];
    execFile('ffprobe', args, { windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        resolve({ error: err.message, stderr: stderr?.toString() });
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (parseErr) {
        resolve({ error: parseErr.message });
      }
    });
  });
}

function getSubtitleStreams(meta) {
  return (meta?.streams || []).filter((s) => s.codec_type === 'subtitle');
}

function languageCodeFromTags(tags = {}) {
  const raw = String(tags.language || tags.LANGUAGE || '').trim().toLowerCase();
  if (!raw) return 'und';
  const match = raw.match(/[a-z]{2,3}(?:-[a-z0-9]+)?/i);
  return match ? match[0].toLowerCase() : 'und';
}

function subtitleExtFromCodec(codecName = '') {
  const c = codecName.toLowerCase();
  switch (c) {
    case 'subrip':
      return '.srt';
    case 'ass':
      return '.ass';
    case 'ssa':
      return '.ssa';
    case 'webvtt':
      return '.vtt';
    case 'mov_text':
      return '.srt';
    case 'dvd_subtitle':
      return '.sub';
    case 'hdmv_pgs_subtitle':
      return '.sup';
    default:
      return '.srt';
}
}

function escapeFilterPath(p) {
  // ffmpeg filter syntax on Windows needs forward slashes and escaped drive colon.
  return (p || '')
    .replace(/\\/g, '/')
    .replace(/:/g, '\\:')
    .replace(/,/g, '\\,')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/'/g, "\\'");
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = execFile('ffmpeg', args, { windowsHide: true }, (err, _stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
        return;
      }
      resolve(stderr);
    });
    proc.stdin?.end();
  });
}

function runFfmpegLogged(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { windowsHide: true });
    let log = '';
    proc.stderr.on('data', (chunk) => {
      log += chunk.toString();
    });
    proc.on('error', (err) => {
      reject(err);
    });
    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ log });
      } else {
        reject(new Error(log || `ffmpeg exited with code ${code}`));
      }
    });
    proc.stdin?.end();
  });
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, roots: ROOTS });
});

app.get('/browse', async (req, res) => {
  try {
    const target = resolvePath(req.query.path);
    const entries = await listDir(target);
    res.json({ path: target, entries });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/probe', async (req, res) => {
  try {
    const target = resolvePath(req.query.path);
    const stats = await fsp.stat(target);
    const meta = await runFfprobe(target);
    res.json({ path: target, size: stats.size, modified: stats.mtimeMs, meta });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/extract-subs', async (req, res) => {
  const { input, streamIndex = 0 } = req.body || {};
  try {
    const inputPath = resolvePath(input);
    const ext = path.extname(inputPath).toLowerCase();
    if (!VIDEO_EXT.has(ext)) {
      throw new Error('El archivo no es de video');
    }

    const meta = await runFfprobe(inputPath);
    const subtitleStreams = getSubtitleStreams(meta);
    if (!subtitleStreams.length) {
      throw new Error('El video no tiene subtitulos embebidos');
    }
    const requested = Number.isInteger(streamIndex) ? streamIndex : Number(streamIndex);
    const selected =
      Number.isInteger(requested) && requested >= 0 && requested < subtitleStreams.length
        ? subtitleStreams[requested]
        : subtitleStreams[0];
    const subtitleOrdinal = Math.max(0, subtitleStreams.indexOf(selected));
    const langCode = languageCodeFromTags(selected?.tags);
    const outExt = subtitleExtFromCodec(selected?.codec_name);
    const target = resolvePath(
      path.join(path.dirname(inputPath), `${path.parse(inputPath).name}.${langCode}${outExt}`)
    );

    const args = ['-y', '-i', inputPath, '-map', `0:s:${subtitleOrdinal}`, '-c', 'copy', target];
    await runFfmpeg(args);
    res.json({
      ok: true,
      output: target,
      stream: {
        codec: selected?.codec_name,
        language: langCode,
        ordinal: subtitleOrdinal,
      },
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/burn-subs', async (req, res) => {
  const { input, subtitles, output } = req.body || {};
  try {
    const inputPath = resolvePath(input);
    const subsPath = resolvePath(subtitles);
    const parsed = path.parse(inputPath);
    const target =
      output && output.trim()
        ? resolvePath(output)
        : path.join(parsed.dir, `${parsed.name}.burnin.mp4`);

    const isAss = path.extname(subsPath).toLowerCase() === '.ass';
    const safePath = escapeFilterPath(subsPath);
    const filter = isAss
      ? `ass=filename='${safePath}'`
      : `subtitles=filename='${safePath}'`;
    const args = ['-y', '-i', inputPath, '-vf', filter, '-c:a', 'copy', target];
    console.log('[burn-subs] start', { inputPath, subsPath, target, filter });
    console.log('[burn-subs] ffmpeg', args.join(' '));
    const { log } = await runFfmpegLogged(args);
    const logSnippet = log && log.length > 8000 ? log.slice(-8000) : log;
    console.log('[burn-subs] done', { output: target });
    res.json({ ok: true, output: target, log: logSnippet, logTruncated: log && log.length > 8000 });
  } catch (err) {
    console.error('[burn-subs] error', err);
    res.status(400).json({ error: err.message });
  }
});

app.post('/transcode-hevc', async (req, res) => {
  const { input, output, bitrate = '5M', preset = 'p5', gop = 48 } = req.body || {};
  try {
    const inputPath = resolvePath(input);
    const ext = path.extname(inputPath).toLowerCase();
    if (!VIDEO_EXT.has(ext)) {
      throw new Error('El archivo no es de video');
    }
    const meta = await runFfprobe(inputPath);
    const videoStream = meta?.streams?.find((s) => s.codec_type === 'video');
    const height = videoStream?.height;
    const suffix = height ? `-${height}p-HEVC` : '-HEVC';
    const defaultOut = path.join(path.dirname(inputPath), `${path.parse(inputPath).name}${suffix}${ext}`);
    const outPath = output && output.trim() ? resolvePath(output) : defaultOut;

    const args = [
      '-y',
      '-hwaccel',
      'cuda',
      '-i',
      inputPath,
      '-map',
      '0',
      '-c:v',
      'hevc_nvenc',
      '-preset',
      preset,
      '-rc:v',
      'vbr',
      '-cq',
      '19',
      '-b:v',
      bitrate,
      '-maxrate',
      bitrate,
      '-bufsize',
      '20M',
      '-g',
      String(gop),
      '-map_metadata',
      '0',
      '-map_chapters',
      '0',
      '-c:a',
      'copy',
      '-c:s',
      'copy',
      '-movflags',
      '+faststart',
      outPath,
    ];

    const { log } = await runFfmpegLogged(args);
    const logSnippet = log && log.length > 8000 ? log.slice(-8000) : log;
    res.json({ ok: true, output: outPath, log: logSnippet, logTruncated: log && log.length > 8000 });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/transcode-mp4', async (req, res) => {
  const {
    input,
    output,
    crf = 19,
    preset = 'medium',
    audioBitrate = '192k',
  } = req.body || {};
  try {
    const inputPath = resolvePath(input);
    const ext = path.extname(inputPath).toLowerCase();
    if (!VIDEO_EXT.has(ext)) {
      throw new Error('El archivo no es de video');
    }
    const meta = await runFfprobe(inputPath);
    const videoStream = meta?.streams?.find((s) => s.codec_type === 'video');
    const height = videoStream?.height;
    const suffix = height ? `-${height}p-MP4` : '-MP4';
    const defaultOut = path.join(
      path.dirname(inputPath),
      `${path.parse(inputPath).name}${suffix}.mp4`
    );
    const outPath = output && output.trim() ? resolvePath(output) : defaultOut;

    const args = [
      '-y',
      '-i',
      inputPath,
      '-map',
      '0:v:0?',
      '-map',
      '0:a?',
      '-map',
      '0:s?',
      '-c:v',
      'libx264',
      '-preset',
      preset,
      '-crf',
      String(crf),
      '-profile:v',
      'high',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      audioBitrate,
      '-c:s',
      'mov_text',
      '-movflags',
      '+faststart',
      '-map_metadata',
      '0',
      '-map_chapters',
      '0',
      outPath,
    ];

    const { log } = await runFfmpegLogged(args);
    const logSnippet = log && log.length > 8000 ? log.slice(-8000) : log;
    res.json({ ok: true, output: outPath, log: logSnippet, logTruncated: log && log.length > 8000 });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/file-op', async (req, res) => {
  const { action, source, target } = req.body || {};
  try {
    if (action === 'createDir') {
      const dir = resolvePath(target);
      await fsp.mkdir(dir, { recursive: true });
      res.json({ ok: true, created: dir });
      return;
    }

    const src = resolvePath(source);
    if (action === 'delete') {
      await fsp.rm(src, { recursive: false, force: true });
      res.json({ ok: true });
      return;
    }
    const dst = resolvePath(target);
    if (action === 'copy') {
      await fsp.copyFile(src, dst);
      res.json({ ok: true });
      return;
    }
    if (action === 'move' || action === 'rename') {
      await fsp.rename(src, dst);
      res.json({ ok: true });
      return;
    }
    throw new Error('Accion invalida');
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/translate-subs', async (req, res) => {
  const { input, batchSize = 100 } = req.body || {};
  try {
    const subsPath = resolvePath(input);
    const ext = path.extname(subsPath).toLowerCase();
    if (!SUB_EXT.has(ext)) {
      throw new Error('El archivo no es de subtitulos');
    }
    // Stub: translation to be implemented with LLM integration.
    res.json({
      ok: false,
      message: 'Pendiente integrar LLM. Este endpoint es un stub.',
      batchSize,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, '..', 'web')));

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.listen(PORT, () => {
  console.log(`Servidor en puerto ${PORT}`);
});
