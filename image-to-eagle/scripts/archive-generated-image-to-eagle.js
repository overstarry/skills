#!/usr/bin/env node
'use strict';

/**
 * Archive AI-generated images into Eagle with the exact prompt kept in `annotation`.
 *
 * Transports, in order of preference:
 *   native — Eagle local API (default http://127.0.0.1:41595). Fast, no plugin dependency.
 *   mcp    — official Eagle Skill CLI (eagle-api-cli.js) -> Eagle MCP server (41596).
 *
 * `item_add` over MCP is known to hang in some environments, so `native` is tried first
 * and `mcp` is only used as a fallback. Everything runs over plain Node http/child_process,
 * so `allowed-tools: Bash(node *)` is enough.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const NATIVE_URL = process.env.EAGLE_API_URL || 'http://127.0.0.1:41595';
const MCP_URL = process.env.EAGLE_SERVER_URL || 'http://127.0.0.1:41596';
const NATIVE_TOKEN = process.env.EAGLE_API_TOKEN || '';
const DEFAULT_ROOT_FOLDER = process.env.EAGLE_IMAGE_ROOT_FOLDER || 'AI 生成图';
const DEFAULT_TAGS = ['AI生成', 'Prompt', 'Generated Image'];
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.bmp', '.tiff', '.svg']);
const DEFAULT_TIMEOUT_MS = Number(process.env.EAGLE_TIMEOUT_MS || 15000);
const LOCK_TIMEOUT_MS = Number(process.env.EAGLE_FOLDER_LOCK_TIMEOUT_MS || 15000);
const LOCK_POLL_MS = Number(process.env.EAGLE_FOLDER_LOCK_POLL_MS || 150);
const DATE_TZ = process.env.EAGLE_DATE_TZ || undefined; // undefined => system local time

const HELP = `Archive generated images into Eagle, keeping the exact prompt in annotation.

Usage:
  node archive-generated-image-to-eagle.js --path /abs/image.png --prompt "exact prompt" [options]
  node archive-generated-image-to-eagle.js --path a.png --path b.png --prompt-file prompt.txt
  node archive-generated-image-to-eagle.js --url https://host/img.png --prompt "..."
  node archive-generated-image-to-eagle.js --check-connection

Image source (at least one required):
  --path PATH            Local image file, or a directory (imports every image inside).
                         Repeatable.
  --url URL              Remote image URL. Repeatable.

Prompt (required unless --dry-run/--check-connection):
  --prompt TEXT          Exact prompt used for generation.
  --prompt-file PATH     Read the prompt from a file (best for long prompts).
  --prompt-stdin         Read the prompt from stdin.

Generation metadata (all optional, written into annotation):
  --model NAME           Model name, e.g. gemini-3-pro-image.
  --action generate|edit Defaults to generate.
  --aspect RATIO         e.g. 1:1, 16:9.
  --source-images LIST   Comma-separated reference/input images for edits.
  --source LABEL         Origin label, defaults to "AI image generation".

Destination:
  --root-folder NAME     Root folder name. Default: ${DEFAULT_ROOT_FOLDER}
  --root-folder-id ID    Use a known root folder ID, still creates date subfolders.
  --folder-id ID         Import straight into this folder, no date subfolder.
  --no-date-subfolders   Import into the root folder itself.
  --no-create-folder     Fail instead of creating a missing folder.
  --date YYYY-MM-DD      Override the date subfolder name.

Item:
  --name NAME            Item name. Multiple images get a -01, -02 ... suffix.
  --tag TAG              Add one extra tag. Repeatable.
  --tags a,b,c           Replace the default tag set (${DEFAULT_TAGS.join(', ')}).
  --skip-duplicate       Skip an image whose original_path is already archived
                         in the destination folder.

Behaviour:
  --transport auto|native|mcp   Default auto (native first, MCP fallback).
  --timeout MS           Per-request timeout. Default ${DEFAULT_TIMEOUT_MS}.
  --dry-run              Resolve folders and print the payload without writing.
  --check-connection     Report native API and MCP CLI reachability, then exit.
  -h, --help             Show this help.

Environment:
  EAGLE_API_URL, EAGLE_API_TOKEN, EAGLE_SERVER_URL, EAGLE_SKILL_CLI,
  EAGLE_IMAGE_ROOT_FOLDER, EAGLE_IMAGE_ROOT_FOLDER_ID, EAGLE_IMAGE_FOLDER_ID,
  EAGLE_DATE_TZ, EAGLE_TIMEOUT_MS
`;

// ---------------------------------------------------------------- arg parsing

const FLAGS = new Set([
  'help', 'h', 'dryRun', 'checkConnection', 'promptStdin',
  'noDateSubfolders', 'flatFolder', 'noCreateFolder', 'skipDuplicate',
]);
const REPEATABLE = new Set(['path', 'url', 'tag']);

function parseArgs(argv) {
  const args = { path: [], url: [], tag: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (raw === '-h') { args.help = true; continue; }
    if (!raw.startsWith('--')) throw new Error(`Unexpected argument: ${raw}`);
    const key = toCamel(raw.slice(2));
    if (FLAGS.has(key)) { args[key] = true; continue; }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${raw}`);
    i += 1;
    if (REPEATABLE.has(key)) args[key].push(value);
    else args[key] = value;
  }
  return args;
}

const toCamel = (v) => v.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

function readPrompt(args) {
  if (args.promptFile) return fs.readFileSync(expandHome(args.promptFile), 'utf8').trim();
  if (args.promptStdin) return fs.readFileSync(0, 'utf8').trim();
  if (typeof args.prompt === 'string') return args.prompt.trim();
  return '';
}

function resolveTags(args) {
  const base = args.tags
    ? args.tags.split(',').map((t) => t.trim()).filter(Boolean)
    : DEFAULT_TAGS.slice();
  return unique([...base, ...args.tag]);
}

// ------------------------------------------------------------ image selection

function collectImages(args) {
  const local = [];
  for (const entry of args.path) {
    const abs = path.resolve(expandHome(entry));
    if (!fs.existsSync(abs)) throw new Error(`Image path does not exist: ${abs}`);
    if (fs.statSync(abs).isDirectory()) {
      const inDir = fs.readdirSync(abs)
        .map((f) => path.join(abs, f))
        .filter((f) => fs.statSync(f).isFile() && isImage(f))
        .sort((a, b) => statMtime(a) - statMtime(b));
      if (inDir.length === 0) throw new Error(`No image files found in directory: ${abs}`);
      local.push(...inDir);
    } else {
      if (!isImage(abs)) throw new Error(`Not a supported image file: ${abs}`);
      local.push(abs);
    }
  }
  return { local: unique(local), remote: unique(args.url) };
}

const isImage = (p) => IMAGE_EXTS.has(path.extname(p).toLowerCase());
const statMtime = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } };

// ------------------------------------------------------------------ transport

function nativeRequest(endpoint, { method = 'GET', body, timeout } = {}) {
  const url = new URL(endpoint, NATIVE_URL);
  if (NATIVE_TOKEN) url.searchParams.set('token', NATIVE_TOKEN);
  const payload = body === undefined ? null : JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port || 80,
      path: `${url.pathname}${url.search}`,
      method,
      headers: payload
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        : {},
      timeout: timeout || DEFAULT_TIMEOUT_MS,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); }
        catch { return reject(new Error(`Eagle API returned non-JSON from ${endpoint}: ${data.slice(0, 200)}`)); }
        if (res.statusCode < 200 || res.statusCode >= 300 || parsed.status === 'error') {
          return reject(new Error(`Eagle API error (${res.statusCode}) on ${endpoint}: ${data.slice(0, 200)}`));
        }
        resolve(parsed);
      });
    });
    req.on('error', (err) => reject(new Error(`Eagle API unreachable at ${NATIVE_URL}: ${err.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error(`Eagle API timed out after ${timeout || DEFAULT_TIMEOUT_MS}ms on ${endpoint}`)); });
    if (payload) req.write(payload);
    req.end();
  });
}

function eagleSkillCliPath() {
  if (process.env.EAGLE_SKILL_CLI) return expandHome(process.env.EAGLE_SKILL_CLI);
  const rel = path.join('Eagle', 'Plugins', 'mcp-server', 'skills', 'eagle-skill', 'scripts', 'eagle-api-cli.js');
  const bases = [
    path.join(os.homedir(), 'Library', 'Application Support'),           // macOS
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), // Windows
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),    // Linux
  ];
  for (const base of bases) {
    const candidate = path.join(base, rel);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function mcpCall(tool, params, timeout) {
  const cli = eagleSkillCliPath();
  if (!cli) return Promise.reject(new Error('Eagle Skill CLI not found. Set EAGLE_SKILL_CLI to eagle-api-cli.js.'));

  return new Promise((resolve, reject) => {
    const child = spawn('node', [cli, 'call', tool, '--json', JSON.stringify(params)], {
      env: { ...process.env, EAGLE_SERVER_URL: MCP_URL },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Eagle MCP tool ${tool} timed out after ${timeout || DEFAULT_TIMEOUT_MS}ms`));
    }, timeout || DEFAULT_TIMEOUT_MS);

    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`Eagle MCP tool ${tool} failed: ${(err || out).slice(0, 300)}`));
      let parsed;
      try { parsed = JSON.parse(out); }
      catch { return reject(new Error(`Eagle MCP tool ${tool} returned non-JSON: ${out.slice(0, 200)}`)); }
      if (parsed.success === false) return reject(new Error(`Eagle MCP tool ${tool} error: ${JSON.stringify(parsed).slice(0, 300)}`));
      resolve(parsed);
    });
  });
}

// -------------------------------------------------------- folder resolution

function flattenFolders(list, parentId = null) {
  const out = [];
  for (const folder of list || []) {
    if (!folder || typeof folder !== 'object') continue;
    const derived = folder.parent ?? folder.parentId ?? parentId ?? null;
    out.push({
      id: folder.id,
      name: folder.name,
      parentId: derived || null,
      createdAt: Number(folder.createdAt || folder.modificationTime || 0),
    });
    if (Array.isArray(folder.children)) out.push(...flattenFolders(folder.children, folder.id || null));
  }
  return out;
}

async function listFolders(state) {
  if (state.transport !== 'mcp') {
    try {
      const res = await nativeRequest('/api/folder/list', { timeout: state.timeout });
      state.used.add('native');
      return flattenFolders(res.data || []);
    } catch (error) {
      if (state.transport === 'native') throw error;
      state.warnings.push(`native folder/list failed, falling back to MCP: ${error.message}`);
    }
  }
  const res = await mcpCall('folder_get', { getAllHierarchy: true, fullDetails: true }, state.timeout);
  state.used.add('mcp');
  return flattenFolders(res.data || []);
}

async function createFolder(state, name, parentId) {
  if (state.transport !== 'mcp') {
    try {
      await nativeRequest('/api/folder/create', {
        method: 'POST',
        timeout: state.timeout,
        body: parentId ? { folderName: name, parent: parentId } : { folderName: name },
      });
      state.used.add('native');
      return;
    } catch (error) {
      if (state.transport === 'native') throw error;
      state.warnings.push(`native folder/create failed, falling back to MCP: ${error.message}`);
    }
  }
  await mcpCall('folder_create', {
    parentId: parentId || undefined,
    folders: [{
      name,
      parentId: parentId || undefined,
      iconColor: parentId ? 'aqua' : 'purple',
      description: parentId
        ? `Generated images archived on ${name}.`
        : 'AI generated images archived with their prompts.',
    }],
  }, state.timeout);
  state.used.add('mcp');
}

/** Oldest match wins, so concurrent jobs converge on one folder instead of forking. */
function findFolder(folders, name, parentId) {
  return folders
    .filter((f) => f.name === name && (f.parentId || null) === (parentId || null))
    .sort((a, b) => a.createdAt - b.createdAt)[0] || null;
}

async function resolveFolderPath(state, names, startParentId = null) {
  return withLock(names.join('/') + '@' + (startParentId || 'root'), async () => {
    let folders = await listFolders(state);
    let parentId = startParentId;
    let current = null;
    const trail = [];

    for (const name of names) {
      const matches = folders.filter((f) => f.name === name && (f.parentId || null) === (parentId || null));
      if (matches.length > 1) {
        state.warnings.push(`Multiple folders named "${name}" under ${parentId || 'root'}; reusing the oldest one.`);
      }
      current = findFolder(folders, name, parentId);

      if (!current) {
        if (state.noCreateFolder) throw new Error(`Folder does not exist and --no-create-folder was set: ${name}`);
        await createFolder(state, name, parentId);
        folders = await listFolders(state);
        current = findFolder(folders, name, parentId);
        if (!current || !current.id) {
          throw new Error(`Created folder "${name}" but could not resolve it under ${parentId || 'root'}.`);
        }
        state.created.push(`${[...trail, name].join('/')}`);
      }

      trail.push(name);
      parentId = current.id;
    }

    return { id: current ? current.id : null, path: trail.join('/') };
  });
}

async function resolveDestination(state, args, dateName) {
  const fixedFolderId = args.folderId || process.env.EAGLE_IMAGE_FOLDER_ID;
  if (fixedFolderId) return { id: fixedFolderId, path: `(folder-id ${fixedFolderId})` };

  const rootFolderId = args.rootFolderId || process.env.EAGLE_IMAGE_ROOT_FOLDER_ID;
  const rootName = args.rootFolder || DEFAULT_ROOT_FOLDER;
  const useDate = !(args.noDateSubfolders || args.flatFolder);

  if (state.dryRun) {
    const label = rootFolderId
      ? `(root-id ${rootFolderId})${useDate ? `/${dateName}` : ''}`
      : `${rootName}${useDate ? `/${dateName}` : ''}`;
    return { id: `dry-run:${label}`, path: label };
  }

  if (rootFolderId) {
    if (!useDate) return { id: rootFolderId, path: `(root-id ${rootFolderId})` };
    const resolved = await resolveFolderPath(state, [dateName], rootFolderId);
    return { id: resolved.id, path: `(root-id ${rootFolderId})/${dateName}` };
  }

  return resolveFolderPath(state, useDate ? [rootName, dateName] : [rootName], null);
}

// ------------------------------------------------------------------- locking

async function withLock(key, fn) {
  const lockDir = path.join(os.tmpdir(), `image-to-eagle-${hashKey(key)}.lock`);
  const start = Date.now();
  for (;;) {
    try { fs.mkdirSync(lockDir); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // A crashed run can leave the directory behind; treat a stale lock as free.
      if (Date.now() - statMtime(lockDir) > LOCK_TIMEOUT_MS * 2) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - start > LOCK_TIMEOUT_MS) throw new Error(`Timed out waiting for the Eagle folder lock: ${key}`);
      await sleep(LOCK_POLL_MS);
    }
  }
  try { return await fn(); }
  finally { fs.rmSync(lockDir, { recursive: true, force: true }); }
}

const hashKey = (value) => {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
  return (hash >>> 0).toString(36);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -------------------------------------------------------------------- import

async function addLocalImage(state, item, folderId) {
  const body = {
    path: item.path,
    name: item.name,
    annotation: item.annotation,
    tags: state.tags,
    folderId,
  };
  if (state.transport !== 'mcp') {
    try {
      const res = await nativeRequest('/api/item/addFromPath', { method: 'POST', body, timeout: state.timeout });
      state.used.add('native');
      return { id: typeof res.data === 'string' ? res.data : (res.data && res.data.id) || null, via: 'native' };
    } catch (error) {
      if (state.transport === 'native') throw error;
      state.warnings.push(`native item/addFromPath failed for ${item.path}, falling back to MCP: ${error.message}`);
    }
  }
  return addViaMcp(state, item, folderId, { type: 'path', path: item.path });
}

async function addRemoteImage(state, item, folderId) {
  const body = {
    url: item.url,
    name: item.name,
    annotation: item.annotation,
    tags: state.tags,
    folderId,
  };
  if (state.transport !== 'mcp') {
    try {
      const res = await nativeRequest('/api/item/addFromURL', { method: 'POST', body, timeout: state.timeout });
      state.used.add('native');
      return { id: typeof res.data === 'string' ? res.data : (res.data && res.data.id) || null, via: 'native' };
    } catch (error) {
      if (state.transport === 'native') throw error;
      state.warnings.push(`native item/addFromURL failed for ${item.url}, falling back to MCP: ${error.message}`);
    }
  }
  return addViaMcp(state, item, folderId, { type: 'url', url: item.url });
}

async function addViaMcp(state, item, folderId, source) {
  const res = await mcpCall('item_add', {
    tags: state.tags,
    items: [{
      name: item.name,
      annotation: item.annotation,
      folders: folderId ? [folderId] : [],
      source,
    }],
  }, state.timeout);
  state.used.add('mcp');
  const entry = Array.isArray(res.data) ? res.data[0] : res.data;
  return { id: (entry && (entry.id || entry.itemId)) || null, via: 'mcp' };
}

async function archivedPathsInFolder(state, folderId) {
  if (!folderId || String(folderId).startsWith('dry-run:')) return new Set();
  try {
    const res = await nativeRequest(`/api/item/list?limit=500&folders=${encodeURIComponent(folderId)}`, { timeout: state.timeout });
    const paths = new Set();
    for (const item of res.data || []) {
      const match = /- original_path:\s*(.+)/.exec(item.annotation || '');
      if (match) paths.add(match[1].trim());
    }
    return paths;
  } catch (error) {
    state.warnings.push(`Duplicate check skipped: ${error.message}`);
    return new Set();
  }
}

// ----------------------------------------------------------------- formatting

function localDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: DATE_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function localIso(date = new Date()) {
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  const stamp = new Intl.DateTimeFormat('en-CA', {
    timeZone: DATE_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
  const hour = stamp.hour === '24' ? '00' : stamp.hour;
  return DATE_TZ
    ? `${stamp.year}-${stamp.month}-${stamp.day}T${hour}:${stamp.minute}:${stamp.second}`
    : `${stamp.year}-${stamp.month}-${stamp.day}T${hour}:${stamp.minute}:${stamp.second}${sign}${pad(offsetMin / 60)}:${pad(offsetMin % 60)}`;
}

function buildAnnotation(state, origin) {
  return [
    'Prompt:',
    state.prompt || '(no prompt supplied)',
    '',
    'Generation:',
    `- model: ${state.model || 'unknown'}`,
    `- action: ${state.action}`,
    `- aspect_ratio: ${state.aspect || 'unspecified'}`,
    `- source_images: ${state.sourceImages || 'none'}`,
    '',
    'Archive:',
    `- source: ${state.source}`,
    `- original_path: ${origin}`,
    `- archived_at: ${localIso()}`,
  ].join('\n');
}

function slugify(text) {
  const slug = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug || 'generated-image';
}

function buildName(state, origin, index, total) {
  const suffix = total > 1 ? `-${String(index + 1).padStart(2, '0')}` : '';
  if (state.name) return `${state.name}${suffix}`;
  const base = state.prompt
    ? `${slugify(state.prompt)}-${state.dateName}`
    : slugify(path.basename(origin, path.extname(origin)));
  return `${base}${suffix}`;
}

const unique = (list) => [...new Set(list)];
const expandHome = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
const writeJson = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

// ----------------------------------------------------------------------- main

async function checkConnection(timeout) {
  const report = { native: { url: NATIVE_URL }, mcp: { url: MCP_URL, cli: eagleSkillCliPath() } };
  try {
    const res = await nativeRequest('/api/application/info', { timeout });
    report.native.ok = true;
    report.native.version = res.data && res.data.version;
  } catch (error) {
    report.native.ok = false;
    report.native.error = error.message;
  }
  try {
    const res = await mcpCall('get_app_info', {}, timeout);
    report.mcp.ok = true;
    report.mcp.version = res.data && res.data.version;
    report.mcp.libraryPath = res.data && res.data.libraryPath;
  } catch (error) {
    report.mcp.ok = false;
    report.mcp.error = error.message;
  }
  report.usable = Boolean(report.native.ok || report.mcp.ok);
  if (!report.usable) {
    report.hint = 'Start Eagle. For the MCP path, also enable the Eagle MCP plugin.';
  }
  writeJson(report);
  if (!report.usable) process.exitCode = 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(HELP); return; }

  const timeout = Number(args.timeout || DEFAULT_TIMEOUT_MS);
  if (args.checkConnection) return checkConnection(timeout);

  const transport = args.transport || 'auto';
  if (!['auto', 'native', 'mcp'].includes(transport)) throw new Error(`Unknown --transport: ${transport}`);

  const { local, remote } = collectImages(args);
  if (local.length + remote.length === 0) throw new Error('No image supplied. Use --path and/or --url (see --help).');

  const prompt = readPrompt(args);
  if (!prompt && !args.dryRun) {
    throw new Error('No prompt supplied. Use --prompt, --prompt-file or --prompt-stdin; the prompt is the point of this archive.');
  }

  const state = {
    transport,
    timeout,
    dryRun: Boolean(args.dryRun),
    noCreateFolder: Boolean(args.noCreateFolder),
    prompt,
    model: args.model,
    action: args.action || 'generate',
    aspect: args.aspect,
    sourceImages: args.sourceImages,
    source: args.source || 'AI image generation',
    name: args.name,
    tags: resolveTags(args),
    dateName: args.date || localDate(),
    used: new Set(),
    warnings: [],
    created: [],
  };

  const folder = await resolveDestination(state, args, state.dateName);

  const origins = [...local.map((p) => ({ kind: 'path', origin: p })), ...remote.map((u) => ({ kind: 'url', origin: u }))];
  const total = origins.length;
  const planned = origins.map((entry, index) => ({
    kind: entry.kind,
    [entry.kind]: entry.origin,
    origin: entry.origin,
    name: buildName(state, entry.origin, index, total),
    annotation: buildAnnotation(state, entry.origin),
  }));

  if (state.dryRun) {
    writeJson({
      dryRun: true, transport, folder, tags: state.tags,
      items: planned, warnings: state.warnings,
    });
    return;
  }

  let skipSet = new Set();
  if (args.skipDuplicate) skipSet = await archivedPathsInFolder(state, folder.id);

  const results = [];
  for (const item of planned) {
    if (skipSet.has(item.origin)) {
      results.push({ name: item.name, origin: item.origin, skipped: 'already archived in this folder' });
      continue;
    }
    const added = item.kind === 'path'
      ? await addLocalImage(state, item, folder.id)
      : await addRemoteImage(state, item, folder.id);
    results.push({ id: added.id, name: item.name, origin: item.origin, via: added.via });
  }

  writeJson({
    success: true,
    transport: [...state.used].join('+') || transport,
    folder,
    createdFolders: state.created,
    tags: state.tags,
    items: results,
    warnings: state.warnings,
  });
}

main().catch((error) => {
  writeJson({ success: false, error: error.message });
  process.exit(1);
});
