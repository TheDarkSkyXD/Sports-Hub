import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import * as ResEdit from 'resedit';

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const iconPath = path.join(root, 'desktop', 'icons', 'sunday-room.ico');
const preparerVersion = 3;
const branding = {
  FileDescription: 'Sunday Room',
  ProductName: 'Sunday Room',
  InternalName: 'Sunday Room',
  OriginalFilename: 'electron.exe',
};

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function resources(bytes) {
  const executable = ResEdit.NtExecutable.from(bytes, { ignoreCert: true });
  return { executable, resource: ResEdit.NtExecutableResource.from(executable) };
}

function iconPayloads(iconFile) {
  return iconFile.icons.map(({ data }) => Buffer.from(data.isRaw() ? data.bin : data.generate()));
}

function isBranded(bytes, sourceGroups, sourceVersions, expectedIcons) {
  try {
    const { resource } = resources(bytes);
    const groups = ResEdit.Resource.IconGroupEntry.fromEntries(resource.entries);
    if (groups.length !== sourceGroups.length) return false;
    for (const sourceGroup of sourceGroups) {
      const group = groups.find(({ id, lang }) => id === sourceGroup.id && lang === sourceGroup.lang);
      if (!group || group.icons.length !== expectedIcons.length) return false;
      const actual = group.icons.map(({ iconID }) => {
        const entry = resource.entries.find(({ type, id, lang }) => type === 3 && id === iconID && lang === group.lang);
        return entry && Buffer.from(entry.bin);
      });
      if (actual.some((entry, index) => !entry?.equals(expectedIcons[index]))) return false;
    }
    const versions = ResEdit.Resource.VersionInfo.fromEntries(resource.entries);
    if (versions.length !== sourceVersions.length) return false;
    return versions.every((version, index) => {
      const original = sourceVersions[index];
      if (version.fixedInfo.fileVersionMS !== original.fixedInfo.fileVersionMS ||
          version.fixedInfo.fileVersionLS !== original.fixedInfo.fileVersionLS ||
          version.fixedInfo.productVersionMS !== original.fixedInfo.productVersionMS ||
          version.fixedInfo.productVersionLS !== original.fixedInfo.productVersionLS) return false;
      const languages = version.getAllLanguagesForStringValues();
      if (!languages.length || languages.length !== original.getAllLanguagesForStringValues().length) return false;
      return languages.every(language => {
        const values = version.getStringValues(language);
        const sourceValues = original.getStringValues(language);
        return Object.entries(branding).every(([key, value]) => values[key] === value) &&
          values.FileVersion === sourceValues.FileVersion && values.ProductVersion === sourceValues.ProductVersion;
      });
    });
  } catch {
    return false;
  }
}

async function syncDistribution(sourceDir, runtimeDir, relative = '') {
  await mkdir(path.join(runtimeDir, relative), { recursive: true });
  for (const entry of await readdir(path.join(sourceDir, relative), { withFileTypes: true })) {
    if (!relative && (entry.name === 'electron.exe' || entry.name === 'Sunday Room.exe' || entry.name.startsWith('Sunday Room.exe.'))) continue;
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      await syncDistribution(sourceDir, runtimeDir, child);
      continue;
    }
    const source = await readFile(path.join(sourceDir, child));
    const destination = path.join(runtimeDir, child);
    const current = await readFile(destination).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (current?.equals(source)) continue;
    const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await writeFile(temporary, source);
      try {
        await rename(temporary, destination);
      } catch (error) {
        const installed = await readFile(destination).catch(() => null);
        if (!installed?.equals(source)) throw error;
      }
    } catch (error) {
      if (['EACCES', 'EPERM', 'EBUSY'].includes(error.code)) {
        throw new Error('Close the running Sunday Room development app, then try again so its Electron files can be refreshed.', { cause: error });
      }
      throw error;
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

export async function prepareDevelopmentElectron() {
  const executablePath = path.resolve(require('electron'));
  if (process.platform !== 'win32') return executablePath;

  const sourceDir = path.dirname(executablePath);
  const runtimeDir = path.join(root, '.desktop-runtime', 'electron');
  const brandedPath = path.join(runtimeDir, 'electron.exe');
  const stampPath = `${brandedPath}.branding.json`;
  await execFileAsync(process.execPath, [path.join(root, 'desktop', 'icons', 'generate.mjs')], { cwd: root });
  const [sourceBytes, iconBytes] = await Promise.all([readFile(executablePath), readFile(iconPath)]);
  const fingerprint = {
    preparerVersion,
    electronSha256: hash(sourceBytes),
    iconSha256: hash(iconBytes),
  };
  const { executable, resource } = resources(sourceBytes);
  const sourceGroups = ResEdit.Resource.IconGroupEntry.fromEntries(resource.entries);
  const sourceVersions = ResEdit.Resource.VersionInfo.fromEntries(resource.entries);
  if (!sourceGroups.length || !sourceVersions.length) throw new Error('The Electron executable has no icon or version resources to brand.');
  const icons = iconPayloads(ResEdit.Data.IconFile.from(iconBytes));
  if (!icons.length) throw new Error('The Sunday Room icon has no images.');

  try {
    const [stamp, brandedBytes] = await Promise.all([
      readFile(stampPath, 'utf8').then(JSON.parse),
      readFile(brandedPath),
    ]);
    if (stamp && Object.entries(fingerprint).every(([key, value]) => stamp[key] === value) &&
        stamp.outputSha256 === hash(brandedBytes) &&
        isBranded(brandedBytes, sourceGroups, sourceVersions, icons)) {
      await syncDistribution(sourceDir, runtimeDir);
      return brandedPath;
    }
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }

  const iconFile = ResEdit.Data.IconFile.from(iconBytes);
  for (const { id, lang } of sourceGroups) {
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(resource.entries, id, lang, iconFile.icons.map(item => item.data));
  }
  for (const version of sourceVersions) {
    for (const language of version.getAllLanguagesForStringValues()) version.setStringValues(language, branding);
    version.outputToResourceEntries(resource.entries);
  }
  resource.outputResource(executable);
  const output = Buffer.from(executable.generate());
  if (!isBranded(output, sourceGroups, sourceVersions, icons)) throw new Error('The branded Electron executable failed resource verification.');

  const temporaryPath = `${brandedPath}.tmp-${process.pid}-${randomUUID()}`;
  const temporaryStamp = `${stampPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(temporaryPath, output);
    try {
      await rename(temporaryPath, brandedPath);
    } catch (error) {
      const installed = await readFile(brandedPath).catch(() => null);
      if (!installed?.equals(output)) {
        if (['EACCES', 'EPERM', 'EBUSY'].includes(error.code)) {
          throw new Error('Close the running Sunday Room development app, then try again so its executable can be refreshed.', { cause: error });
        }
        throw error;
      }
    }
    await syncDistribution(sourceDir, runtimeDir);
    await writeFile(temporaryStamp, JSON.stringify({ ...fingerprint, outputSha256: hash(output) }));
    await rename(temporaryStamp, stampPath);
  } finally {
    await Promise.all([rm(temporaryPath, { force: true }), rm(temporaryStamp, { force: true })]);
  }
  return brandedPath;
}
