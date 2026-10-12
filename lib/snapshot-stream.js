const { randomUUID } = require('node:crypto');

async function streamSnapshot(snapshot, send, maxChunkBytes = 256 * 1024) {
  const session = randomUUID();
  const data = JSON.stringify(snapshot);
  // JSON framing escapes quotes and backslashes a second time on the wire.
  const maxDataBytes = Math.floor((maxChunkBytes - 256) / 2);
  if (maxDataBytes < 8) throw Error('chunk_limit');
  const boundaries = [0];
  let start = 0;
  while (start < data.length) {
    let end = Math.min(data.length, start + maxDataBytes);
    while (end > start && Buffer.byteLength(data.slice(start, end), 'utf8') > maxDataBytes) end--;
    if (end === start) throw Error('chunk_limit');
    boundaries.push(end);
    start = end;
  }
  if (boundaries.length === 1) boundaries.push(0);
  try {
    for (let index = 0; index < boundaries.length - 1; index++) {
      const packet = { session, index, total: boundaries.length - 1, version: snapshot.version,
        data: data.slice(boundaries[index], boundaries[index + 1]) };
      if (await send(packet) !== true) throw Error('snapshot_interrupted');
    }
  } catch (error) {
    try { await send({ session, abort: true }); } catch { /* socket closed */ }
    throw error;
  }
}

function createSnapshotReceiver() {
  let session = null;
  let pieces = [];
  let completed = null;
  let finishedSession = null;
  const abandoned = new Set();
  const abandon = (id) => { if (id) { abandoned.add(id); if (abandoned.size > 16) abandoned.delete(abandoned.values().next().value); } };
  return {
    accept(packet) {
      if (!packet || typeof packet.session !== 'string') return false;
      if (packet.abort) {
        if (packet.session === session) { abandon(session); session = null; pieces = []; completed = null; }
        return true;
      }
      if (packet.session === finishedSession || abandoned.has(packet.session)) return false;
      if (packet.index === 0 && packet.session !== session) {
        abandon(session);
        session = packet.session;
        pieces = [];
        completed = null;
      }
      if (packet.session !== session || packet.index !== pieces.length ||
          !Number.isSafeInteger(packet.total) || packet.total <= 0 ||
          typeof packet.data !== 'string' || packet.total > 100000) return false;
      pieces.push(packet.data);
      if (pieces.length === packet.total) {
        try {
          const value = JSON.parse(pieces.join(''));
          if (value.version !== packet.version) throw Error('version');
          completed = value;
          abandon(finishedSession);
          finishedSession = session;
          session = null;
          pieces = [];
        } catch { abandon(session); session = null; pieces = []; return false; }
      }
      return true;
    },
    result() { return completed; },
    reset() { abandon(session); session = null; pieces = []; completed = null; },
  };
}

module.exports = { createSnapshotReceiver, streamSnapshot };
