const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const LIMITS = {
  totalBytes: 128 * 1024 * 1024,
  roomBytes: 32 * 1024 * 1024,
  fileBytes: 2 * 1024 * 1024,
  reserveBytes: 1024 * 1024 * 1024,
};

function imageType(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  return null;
}

class ImageAssetStore {
  constructor({ root, totalBytes = LIMITS.totalBytes, roomBytes = LIMITS.roomBytes,
    fileBytes = LIMITS.fileBytes, reserveBytes = LIMITS.reserveBytes,
    statfs = (directory) => fs.statfs(directory) } = {}) {
    if (!root) throw new Error('asset root required');
    this.root = root;
    this.limits = { totalBytes, roomBytes, fileBytes, reserveBytes };
    this.statfs = statfs;
    this.assets = new Map();
    this.rooms = new Map();
    this.totalBytes = 0;
    this.queue = Promise.resolve();
  }

  _enqueue(action) {
    const result = this.queue.then(action);
    this.queue = result.catch(() => {});
    return result;
  }

  put(room, bytes, contentType) {
    return this._enqueue(async () => {
      if (typeof room !== 'string' || !room || room.length > 200 || !Buffer.isBuffer(bytes) ||
          imageType(bytes) !== contentType) throw new Error('invalid image');
      if (bytes.length > this.limits.fileBytes) throw new Error('too_large');
      const id = crypto.createHash('sha256').update(bytes).digest('hex');
      const owned = this.rooms.get(room) || new Set();
      if (owned.has(id)) return { id, url: `/board-assets/${id}`, size: bytes.length };

      const roomUsed = [...owned].reduce((sum, key) => sum + this.assets.get(key).size, 0);
      if (roomUsed + bytes.length > this.limits.roomBytes) throw new Error('quota: room');
      const existing = this.assets.get(id);
      if (!existing && this.totalBytes + bytes.length > this.limits.totalBytes) throw new Error('quota: total');
      await fs.mkdir(this.root, { recursive: true });
      if (!existing) {
        const disk = await this.statfs(this.root);
        if (Number(disk.bavail) * Number(disk.bsize) - bytes.length < this.limits.reserveBytes) {
          throw new Error('quota: disk reserve');
        }
        await fs.writeFile(path.join(this.root, id), bytes, { flag: 'wx' });
        this.assets.set(id, { size: bytes.length, contentType, refs: 0 });
        this.totalBytes += bytes.length;
      }
      this.assets.get(id).refs += 1;
      owned.add(id);
      this.rooms.set(room, owned);
      return { id, url: `/board-assets/${id}`, size: bytes.length };
    });
  }

  async get(room, id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error('invalid asset id');
    if (!this.rooms.get(room)?.has(id)) return null;
    return this.getById(id);
  }

  has(room, id) { return this.rooms.get(room)?.has(id) || false; }

  async getById(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error('invalid asset id');
    const entry = this.assets.get(id);
    if (!entry) return null;
    return { bytes: await fs.readFile(path.join(this.root, id)), contentType: entry.contentType };
  }

  releaseRoom(room) {
    return this._enqueue(async () => {
      const owned = this.rooms.get(room);
      if (!owned) return;
      this.rooms.delete(room);
      for (const id of owned) {
        const entry = this.assets.get(id);
        if (--entry.refs > 0) continue;
        await fs.unlink(path.join(this.root, id));
        this.assets.delete(id);
        this.totalBytes -= entry.size;
      }
    });
  }

  stats() { return { totalBytes: this.totalBytes, assetCount: this.assets.size }; }

  async close() {
    for (const room of [...this.rooms.keys()]) await this.releaseRoom(room);
  }
}

module.exports = { ImageAssetStore, LIMITS };
