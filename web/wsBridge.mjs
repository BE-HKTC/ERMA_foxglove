import path from 'path';
import { promises as fs } from 'fs';
import FoxgloveClient from '@foxglove/ws-protocol/dist/cjs/src/FoxgloveClient.js';
import FoxgloveServer from '@foxglove/ws-protocol/dist/cjs/src/FoxgloveServer.js';
import WebSocket from 'ws';

// Lazy import MCAP writer to avoid breaking dev server if absent
let McapWriter;
async function ensureMcap() {
  if (!McapWriter) {
    const mod = await import('@mcap/core');
    McapWriter = mod.McapWriter;
  }
}

class FileWritable {
  constructor(fd) {
    this.fd = fd;
    this._pos = 0n;
  }
  async write(buffer) {
    await this.fd.write(Buffer.from(buffer));
    this._pos += BigInt(buffer.byteLength);
  }
  position() {
    return this._pos;
  }
}

function slugify(target) {
  return target.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
}

function parseLookback(text, defaultMs) {
  if (!text) return defaultMs;
  const m = /^([0-9]+)([smhdw])$/.exec(text.trim());
  if (!m) return defaultMs;
  const n = parseInt(m[1], 10);
  const unit = m[2];
  const mult = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : unit === 'd' ? 86_400_000 : 604_800_000;
  return n * mult;
}

export class TargetRegistry {
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.targets = new Map(); // slug -> { target, retention }
    this.managers = new Map(); // slug -> TargetManager
  }

  async syncFromIndex(index) {
    const enabled = new Map();
    for (const entry of index) {
      if (entry.target && entry.retention) {
        const slug = slugify(entry.target);
        enabled.set(slug, entry.target);
        const topics = Array.isArray(entry.topics) ? entry.topics : undefined;
        if (!this.managers.has(slug)) {
          const manager = new TargetManager({ slug, target: entry.target, dataDir: this.dataDir, topics });
          this.managers.set(slug, manager);
          await manager.start();
        } else {
          // Update whitelist on existing manager
          const mgr = this.managers.get(slug);
          if (mgr) {
            mgr.setTopicsWhitelist(topics);
          }
        }
      }
    }
    // stop managers for targets that are no longer enabled
    for (const [slug, mgr] of this.managers) {
      if (!enabled.has(slug)) {
        await mgr.stop();
        this.managers.delete(slug);
      }
    }
  }

  async getOrCreate(slug) {
    const mgr = this.managers.get(slug);
    if (mgr) return mgr;
    // Unknown slug; we cannot start without target URL. Throw.
    throw new Error(`Unknown target slug: ${slug}`);
  }
}

export class TargetManager {
  constructor({ slug, target, dataDir, topics }) {
    this.slug = slug;
    this.target = target;
    this.dataDir = dataDir;
    this.client = undefined;
    this.started = false;
    this.channels = new Map(); // upstreamId -> channel
    this.ring = new Map(); // topic -> array of { t: bigint, p: Uint8Array }
    this.maxRingMs = parseLookback(process.env.HISTORY_LOOKBACK || '15m', 15 * 60_000);
    this.retentionDays = parseInt(process.env.RETENTION_DAYS || '7', 10);
    this.writer = undefined;
    this.currentSegment = undefined; // file path
    this.currentSegmentKey = '';
    this.mcapSchemaIds = new Map(); // key: schemaName|encoding -> id
    this.mcapChannelIds = new Map(); // upstreamId -> channelId
    this.channelSeq = new Map(); // channelId -> sequence
    this.topicsWhitelist = Array.isArray(topics) && topics.length > 0 ? new Set(topics) : undefined;
  }

  async #ensureDirs() {
    const dir = path.join(this.dataDir, this.slug);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  async start() {
    if (this.started) return;
    this.started = true;
    const dir = await this.#ensureDirs();
    // Rotate segments hourly
    const now = new Date();
    const segKey = this.#segmentKey(now);
    const segName = `${segKey}.mcap`;
    this.currentSegment = path.join(dir, segName);
    this.currentSegmentKey = segKey;
    await this.#openWriter(this.currentSegment);
    this.#connectUpstream();
    // Periodic retention cleanup
    this.retentionTimer = setInterval(() => { this.#cleanupRetention().catch(() => {}); }, 6 * 60_000);
  }

  async stop() {
    this.started = false;
    try { this.client?.close(); } catch {}
    clearInterval(this.retentionTimer);
    await this.#closeWriter();
  }

  setTopicsWhitelist(topics) {
    this.topicsWhitelist = Array.isArray(topics) && topics.length > 0 ? new Set(topics) : undefined;
  }

  async #openWriter(filePath) {
    try {
      await ensureMcap();
      const fd = await fs.open(filePath, 'w');
      const writable = new FileWritable(fd);
      this.writer = new McapWriter({ writable, useChunks: true, useMessageIndex: true, useSummaryOffsets: true });
      await this.writer.start({ profile: 'ros', library: 'ERMA-foxglove-bridge' });
      // reset maps for this segment; will re-register schemas/channels on demand
      this.mcapSchemaIds.clear();
      this.mcapChannelIds.clear();
      this.channelSeq.clear();
    } catch (err) {
      console.warn('MCAP writer init failed:', err);
      this.writer = undefined;
    }
  }

  async #closeWriter() {
    if (!this.writer) return;
    try { await this.writer.end(); } catch {}
    this.writer = undefined;
  }

  async #cleanupRetention() {
    const dir = await this.#ensureDirs();
    const entries = await fs.readdir(dir);
    const cutoff = Date.now() - this.retentionDays * 86400_000;
    await Promise.all(entries.map(async (f) => {
      if (!f.endsWith('.mcap')) return;
      const full = path.join(dir, f);
      const stat = await fs.stat(full);
      if (stat.mtimeMs < cutoff) {
        await fs.unlink(full).catch(() => {});
      }
    }));
  }

  #connectUpstream() {
    try {
      this.client = new FoxgloveClient({ ws: new WebSocket(this.target, [FoxgloveClient.SUPPORTED_SUBPROTOCOL]) });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Failed to connect upstream', this.target, err);
      setTimeout(() => this.#connectUpstream(), 5000);
      return;
    }

    this.client.on('open', () => {
      // eslint-disable-next-line no-console
      console.log(`[${this.slug}] upstream connected`);
    });
    this.client.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error(`[${this.slug}] upstream error`, err);
    });
    this.client.on('close', () => {
      // eslint-disable-next-line no-console
      console.warn(`[${this.slug}] upstream closed, retrying...`);
      setTimeout(() => this.#connectUpstream(), 2000);
    });
    this.client.on('advertise', (channels) => {
      for (const ch of channels) {
        // If whitelist is set, ignore channels not in whitelist
        if (this.topicsWhitelist && !this.topicsWhitelist.has(ch.topic)) {
          continue;
        }
        this.channels.set(ch.id, ch);
        // Pre-register in MCAP for current segment
        this.#ensureMcapChannel(ch.id, ch).catch(() => {});
      }
    });
    this.client.on('unadvertise', (removed) => {
      for (const id of removed) {
        this.channels.delete(id);
      }
    });
    this.client.on('message', (msg) => {
      const ch = this.channels.get(msg.channelId);
      if (!ch) return;
      if (this.topicsWhitelist && !this.topicsWhitelist.has(ch.topic)) return;
      this.#storeRing(ch.topic, msg.timestamp, msg.data);

      // Rotate segment if hour boundary crossed
      const now = new Date();
      const key = this.#segmentKey(now);
      if (key !== this.currentSegmentKey) {
        this.#rotateSegment(now).catch(() => {});
      }

      // Write to MCAP
      this.#writeMcapMessage(msg.channelId, ch, msg.timestamp, new Uint8Array(msg.data.buffer, msg.data.byteOffset, msg.data.byteLength)).catch(() => {});
    });
  }

  #segmentKey(date) {
    return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}_${String(date.getUTCHours()).padStart(2, '0')}`;
  }

  async #rotateSegment(now) {
    try {
      await this.#closeWriter();
    } catch {}
    const dir = await this.#ensureDirs();
    const segKey = this.#segmentKey(now);
    const segName = `${segKey}.mcap`;
    this.currentSegment = path.join(dir, segName);
    this.currentSegmentKey = segKey;
    await this.#openWriter(this.currentSegment);
    // After reopening, re-register known channels
    for (const [upId, ch] of this.channels) {
      await this.#ensureMcapChannel(upId, ch);
    }
  }

  #guessSchemaEncoding(ch) {
    if (ch.schemaEncoding) return ch.schemaEncoding;
    // Heuristics based on message encoding
    if (ch.encoding === 'json') return 'jsonschema';
    if (ch.encoding === 'ros1') return 'ros1msg';
    if (ch.encoding === 'cdr') return 'ros2msg';
    return 'text';
  }

  async #ensureMcapChannel(upstreamId, ch) {
    if (!this.writer) return;
    if (this.mcapChannelIds.has(upstreamId)) return;
    // Schema
    const schemaKey = `${ch.schemaName}|${this.#guessSchemaEncoding(ch)}`;
    let schemaId = this.mcapSchemaIds.get(schemaKey);
    if (schemaId == null) {
      const schemaData = new TextEncoder().encode(ch.schema || '');
      schemaId = await this.writer.registerSchema({
        name: ch.schemaName || 'unknown',
        encoding: this.#guessSchemaEncoding(ch),
        data: schemaData,
      });
      this.mcapSchemaIds.set(schemaKey, schemaId);
    }
    // Channel
    const channelId = await this.writer.registerChannel({
      schemaId,
      topic: ch.topic,
      messageEncoding: ch.encoding || 'json',
      metadata: new Map(),
    });
    this.mcapChannelIds.set(upstreamId, channelId);
    this.channelSeq.set(channelId, 0);
  }

  async #writeMcapMessage(upstreamId, ch, timestampBigInt, payload) {
    if (!this.writer) return;
    await this.#ensureMcapChannel(upstreamId, ch);
    const channelId = this.mcapChannelIds.get(upstreamId);
    if (channelId == null) return;
    const seq = (this.channelSeq.get(channelId) || 0) + 1;
    this.channelSeq.set(channelId, seq);
    const t = BigInt(timestampBigInt);
    await this.writer.addMessage({
      channelId,
      sequence: seq,
      logTime: t,
      publishTime: t,
      data: payload,
    });
  }

  #storeRing(topic, timestamp, payload) {
    const arr = this.ring.get(topic) || [];
    arr.push({ t: BigInt(timestamp), p: new Uint8Array(payload) });
    const cutoff = BigInt(Date.now() - this.maxRingMs) * 1_000_000n; // ns
    while (arr.length > 0 && arr[0].t < cutoff) {
      arr.shift();
    }
    this.ring.set(topic, arr);
  }

  async attachClientServer(fgServer, { lookback }) {
    // Advertise current channels to this server instance and build mapping
    const map = new Map(); // upstreamId -> { serverChanId, topic }
    for (const [upId, ch] of this.channels) {
      const serverId = fgServer.addChannel({
        topic: ch.topic,
        encoding: ch.encoding,
        schemaName: ch.schemaName,
        schema: ch.schema,
      });
      map.set(upId, { serverChanId: serverId, topic: ch.topic });
    }
    const lookbackMs = parseLookback(lookback, this.maxRingMs);
    const earliest = BigInt(Date.now() - lookbackMs) * 1_000_000n;

    // On subscribe send backlog for that channel to this single-client server
    fgServer.on('subscribe', (serverChanId) => {
      // find topic for this serverChanId
      const entry = Array.from(map.values()).find((v) => v.serverChanId === serverChanId);
      if (!entry) return;
      const arr = this.ring.get(entry.topic);
      if (!arr || arr.length === 0) return;
      for (const { t, p } of arr) {
        if (t >= earliest) {
          fgServer.sendMessage(serverChanId, t, p);
        }
      }
    });

    // Live forwarding: attach a transient listener to upstream client and forward to this server
    const forward = (msg) => {
      const entry = map.get(msg.channelId);
      if (!entry) return;
      const { serverChanId, topic } = entry;
      const t = BigInt(msg.timestamp);
      const p = new Uint8Array(msg.data);
      this.#storeRing(topic, t, p);
      fgServer.sendMessage(serverChanId, t, p);
    };
    this.client?.on('message', forward);

    // Cleanup when client disconnects (ws close handled by FoxgloveServer internally)
    const detach = () => {
      this.client?.off('message', forward);
    };
    // There is no hook emitted on fgServer close; rely on GC and upstream disconnection by ws close
    return { detach };
  }
}
