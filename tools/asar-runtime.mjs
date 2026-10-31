/**
 * Reads files out of an Electron `.asar` archive.
 *
 * The installed DeepSeek Harness keeps its runtime packages inside
 * `resources/app.asar`, so a test that needs the real `@deepseek-ai/cordis`
 * build has to read them from the archive rather than from a directory.
 */
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";

/**
 * Read an asar archive's header.
 *
 * @param {string} asarPath - the archive path.
 * @returns {{header: object, baseOffset: number}} the parsed header.
 */
function readHeader(asarPath) {
  const fd = openSync(asarPath, "r");
  try {
    const sizeBuf = Buffer.alloc(8);
    readSync(fd, sizeBuf, 0, 8, 0);
    const headerSize = sizeBuf.readUInt32LE(4);
    const headerBuf = Buffer.alloc(headerSize);
    readSync(fd, headerBuf, 0, headerSize, 8);
    const jsonLen = headerBuf.readUInt32LE(4);
    const header = JSON.parse(headerBuf.toString("utf8", 8, 8 + jsonLen));
    return { header, baseOffset: 8 + headerSize };
  } finally {
    closeSync(fd);
  }
}

/**
 * Find one file inside the archive header.
 *
 * @param {object} header - the archive header.
 * @param {string} innerPath - the path inside the archive, `/`-separated.
 * @returns {{offset: number, size: number, unpacked: boolean}|null} the entry.
 */
function findEntry(header, innerPath) {
  let node = header;
  for (const segment of innerPath.split("/")) {
    if (!node?.files?.[segment]) return null;
    node = node.files[segment];
  }
  if (!node || node.files) return null;
  return { offset: node.offset, size: node.size, unpacked: !!node.unpacked };
}

/**
 * List every file under a directory inside the archive.
 *
 * @param {object} header - the archive header.
 * @param {string} innerDir - the directory inside the archive.
 * @returns {string[]} the file paths, relative to `innerDir`.
 */
function listEntries(header, innerDir) {
  let node = header;
  for (const segment of innerDir.split("/")) {
    if (!node?.files?.[segment]) return [];
    node = node.files[segment];
  }
  const out = [];
  const walk = (current, prefix) => {
    for (const [name, child] of Object.entries(current.files ?? {})) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (child.files) walk(child, path);
      else out.push(path);
    }
  };
  walk(node, "");
  return out;
}

/**
 * Extract one file from an asar archive.
 *
 * @param {string} asarPath - the archive path.
 * @param {string} innerPath - the path inside the archive, `/`-separated.
 * @returns {Buffer|null} the file's bytes, or `null` when it is absent.
 */
export function readFromAsar(asarPath, innerPath) {
  const { header, baseOffset } = readHeader(asarPath);
  const entry = findEntry(header, innerPath);
  if (!entry) return null;
  if (entry.unpacked) {
    const unpacked = asarPath.replace(/\.asar$/, ".asar.unpacked") + "\\" + innerPath.replace(/\//g, "\\");
    try {
      return readFileSync(unpacked);
    } catch {
      return null;
    }
  }
  const fd = openSync(asarPath, "r");
  try {
    const buf = Buffer.alloc(entry.size);
    readSync(fd, buf, 0, entry.size, baseOffset + Number(entry.offset));
    return buf;
  } finally {
    closeSync(fd);
  }
}

/**
 * Locate the DSH runtime's packages.
 *
 * The runtime ships inside `resources/app.asar`, so its `node_modules` is
 * addressed as `dsh/node_modules/...` inside the archive.
 *
 * @returns {object} the location, with a `read` and a `list` function.
 */
export function findRuntimePackages() {
  const localAppData = process.env.LOCALAPPDATA ?? "";
  const resources = `${localAppData}\\Programs\\DeepSeek Harness\\resources`;

  // The unpacked mirror, when the app extracted it.
  const unpacked = `${resources}\\app.asar.unpacked\\dsh\\node_modules`;
  try {
    if (statSync(`${unpacked}\\@deepseek-ai\\cordis\\lib\\index.js`).isFile()) {
      return {
        kind: "dir",
        root: unpacked,
        read(relativePath) {
          try {
            return readFileSync(`${unpacked}\\${relativePath.replace(/\//g, "\\")}`);
          } catch {
            return null;
          }
        },
        list() {
          return [];
        }
      };
    }
  } catch { /* not unpacked */ }

  // The archive itself.
  const asarPath = `${resources}\\app.asar`;
  try {
    if (statSync(asarPath).isFile()) {
      const { header } = readHeader(asarPath);
      const prefix = "dsh/node_modules";
      if (findEntry(header, `${prefix}/@deepseek-ai/cordis/lib/index.js`)) {
        return {
          kind: "asar",
          root: prefix,
          asarPath,
          header,
          read(relativePath) {
            return readFromAsar(asarPath, `${prefix}/${relativePath}`);
          },
          list(relativePath) {
            return listEntries(header, `${prefix}/${relativePath}`);
          }
        };
      }
    }
  } catch { /* no app.asar */ }

  throw new Error(
    "could not find the DSH runtime's packages. Install the DeepSeek Harness desktop app, " +
    "or run this test from a checkout of the DSH monorepo."
  );
}
