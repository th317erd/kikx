'use strict';

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_SCRIPT_ENTRY = 'index.mjs';
const DEFAULT_PACKAGE_JSON = {
  name: 'kikx-script',
  private: true,
  type: 'module',
};
const NPM_LOCKFILES = new Set([ 'package-lock.json', 'npm-shrinkwrap.json' ]);

export async function prepareScriptWorkspace(params = {}) {
  let script = normalizeScriptSource(params.script);
  let files = normalizeFiles(params.files);
  let packageInput = resolvePackageInput(params, files);
  let packageData = parsePackageJson(packageInput.value, packageInput.source);
  let entry = normalizeEntryPath(params.entry || packageMain(packageData) || DEFAULT_SCRIPT_ENTRY);

  if (files.has(entry))
    throw new Error(`files cannot also contain the entry script: ${entry}`);

  let packageFile = packageInput.value == null
    ? { content: `${JSON.stringify(DEFAULT_PACKAGE_JSON, null, 2)}\n`, encoding: 'utf8' }
    : packageInput.source === 'file'
      ? files.get('package.json')
      : {
        content: typeof packageInput.value === 'string'
          ? packageInput.value
          : `${JSON.stringify(packageData, null, 2)}\n`,
        encoding: 'utf8',
      };

  files.set('package.json', packageFile);
  files.set(entry, { content: script, encoding: 'utf8' });

  let dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kikx-script-'));
  try {
    for (let [ relativePath, file ] of files)
      await writeWorkspaceFile(dir, relativePath, file);

    let install = params.install;
    if (install != null && typeof install !== 'boolean')
      throw new TypeError('install must be a boolean when provided');

    let installCommand = install === false
      ? null
      : (install === true || needsDependencyInstall(packageData, files))
        ? resolveInstallCommand(files)
        : null;

    return {
      dir,
      entry,
      files: [ ...files.keys() ],
      installCommand,
      keepTempDir: params.keepTempDir === true,
      packageData,
    };
  } catch (error) {
    await removeScriptWorkspace(dir);
    throw error;
  }
}

export function buildScriptShellCommand({ dir, entry, args = [], installCommand = null, keepTempDir = false } = {}) {
  let lines = [ 'set -e' ];

  if (!keepTempDir) {
    lines.push(
      'cleanup() {',
      '  status=$?',
      '  trap - EXIT',
      '  cd /',
      `  rm -rf -- ${shellQuote(dir)}`,
      '  exit "$status"',
      '}',
      'trap cleanup EXIT',
    );
  }

  lines.push(`cd ${shellQuote(dir)}`);
  if (installCommand)
    lines.push(installCommand);
  lines.push([ shellQuote(process.execPath), shellQuote(entry), ...normalizeArgs(args).map(shellQuote) ].join(' '));
  return lines.join('\n');
}

export async function removeScriptWorkspace(dir) {
  if (!dir)
    return;

  await fsp.rm(dir, { recursive: true, force: true });
}

export function normalizeScriptPath(value, fieldName = 'path') {
  if (typeof value !== 'string' || value.trim() === '')
    throw new TypeError(`${fieldName} must be a non-empty string`);

  let text = value.trim().replace(/\\/g, '/');
  if (text.includes('\0'))
    throw new Error(`${fieldName} must not contain NUL bytes`);
  if (/^[A-Za-z]:\//.test(text) || text.startsWith('/'))
    throw new Error(`${fieldName} must be relative: ${value}`);

  let normalized = path.posix.normalize(text);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../'))
    throw new Error(`${fieldName} must stay inside the temporary script workspace: ${value}`);

  return normalized;
}

function normalizeScriptSource(value) {
  if (typeof value !== 'string' || value.trim() === '')
    throw new TypeError('script must be a non-empty string');
  return value;
}

function normalizeFiles(value) {
  let files = new Map();
  if (value == null)
    return files;
  if (!Array.isArray(value))
    throw new TypeError('files must be an array when provided');

  for (let index = 0; index < value.length; index++) {
    let file = value[index];
    if (!file || typeof file !== 'object' || Array.isArray(file))
      throw new TypeError(`files[${index}] must be an object`);

    let relativePath = normalizeScriptPath(file.path, `files[${index}].path`);
    if (files.has(relativePath))
      throw new Error(`files contains a duplicate path: ${relativePath}`);

    let encoding = file.encoding || 'utf8';
    if (encoding !== 'utf8' && encoding !== 'base64')
      throw new TypeError(`files[${index}].encoding must be utf8 or base64`);
    if (typeof file.content !== 'string')
      throw new TypeError(`files[${index}].content must be a string`);

    files.set(relativePath, { content: file.content, encoding });
  }

  return files;
}

function resolvePackageInput(params, files) {
  if (params.packageJson != null) {
    if (files.has('package.json'))
      throw new Error('files cannot contain package.json when packageJson is also provided');
    return { value: params.packageJson, source: 'argument' };
  }

  if (files.has('package.json'))
    return { value: fileText(files.get('package.json')), source: 'file' };

  return { value: null, source: 'default' };
}

function parsePackageJson(value, source) {
  if (value == null)
    return { ...DEFAULT_PACKAGE_JSON };

  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      throw new Error(`packageJson is not valid JSON: ${error.message}`);
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new TypeError(`packageJson from ${source} must be a JSON object`);

  return parsed;
}

function packageMain(packageData) {
  return typeof packageData?.main === 'string' && packageData.main.trim() !== ''
    ? packageData.main
    : '';
}

function normalizeEntryPath(value) {
  return normalizeScriptPath(value, 'entry');
}

function normalizeArgs(value) {
  if (value == null)
    return [];
  if (!Array.isArray(value))
    throw new TypeError('args must be an array of strings when provided');

  return value.map((arg, index) => {
    if (typeof arg !== 'string')
      throw new TypeError(`args[${index}] must be a string`);
    if (arg.includes('\0'))
      throw new Error(`args[${index}] must not contain NUL bytes`);
    return arg;
  });
}

function needsDependencyInstall(packageData, files) {
  for (let field of [ 'dependencies', 'devDependencies', 'optionalDependencies' ]) {
    let dependencies = packageData?.[field];
    if (dependencies && typeof dependencies === 'object' && Object.keys(dependencies).length > 0)
      return true;
  }

  for (let lockfile of NPM_LOCKFILES) {
    if (files.has(lockfile))
      return true;
  }

  return false;
}

function resolveInstallCommand(files) {
  if (files.has('package-lock.json') || files.has('npm-shrinkwrap.json'))
    return 'npm ci --no-audit --no-fund --loglevel=error';
  return 'npm install --no-audit --no-fund --loglevel=error';
}

async function writeWorkspaceFile(root, relativePath, file) {
  let target = path.join(root, ...relativePath.split('/'));
  await fsp.mkdir(path.dirname(target), { recursive: true });
  if (file.encoding === 'base64')
    await fsp.writeFile(target, Buffer.from(file.content, 'base64'));
  else
    await fsp.writeFile(target, file.content, 'utf8');
}

function fileText(file) {
  return file.encoding === 'base64'
    ? Buffer.from(file.content, 'base64').toString('utf8')
    : file.content;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, '\'\\\'\'')}'`;
}
