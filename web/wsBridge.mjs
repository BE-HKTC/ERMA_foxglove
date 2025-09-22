import path from 'path';
import { promises as fs } from 'fs';
import wsProtocol from '@foxglove/ws-protocol';
const { FoxgloveClient, FoxgloveServer } = wsProtocol;
import WebSocket from 'ws';

// Lazy import MCAP writer to avoid breaking dev server if absent
let McapWriter;
async function ensureMcap() {
  if (!McapWriter) {
    const mod = await import('@mcap/core');
    McapWriter = mod.McapWriter;
  }
}

let McapIndexedReader;
async function ensureMcapReader() {
  if (!McapIndexedReader) {
    const mod = await import('@mcap/core');
    McapIndexedReader = mod.McapIndexedReader;
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
    this.#loggedDir = false;
    this.#loggedChannels = undefined;
    this.subscriptionByChannel = new Map();
    this.subscriptionInfo = new Map();
  }

  #loggedDir;
  #loggedChannels;
  subscriptionByChannel;
  subscriptionInfo;

  async #ensureDirs() {
    const dir = path.join(this.dataDir, this.slug);
    await fs.mkdir(dir, { recursive: true });
    if (!this.#loggedDir) {
      // eslint-disable-next-line no-console
      console.log(`[${this.slug}] data dir ${dir}`);
      this.#loggedDir = true;
    }
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
    this.subscriptionByChannel.clear();
    this.subscriptionInfo.clear();
  }

  setTopicsWhitelist(topics) {
    this.topicsWhitelist = Array.isArray(topics) && topics.length > 0 ? new Set(topics) : undefined;
    if (!this.client) {
      return;
    }
    for (const [id, ch] of this.channels) {
      if (this.topicsWhitelist && !this.topicsWhitelist.has(ch.topic)) {
        this.#ensureUnsubscribed(id);
      } else {
        this.#ensureSubscribed(id, ch.topic);
      }
    }
  }

  #ensureSubscribed(channelId, topic) {
    if (!this.client || this.subscriptionByChannel.has(channelId)) {
      return;
    }
    try {
      const subId = this.client.subscribe(channelId);
      this.subscriptionByChannel.set(channelId, subId);
      this.subscriptionInfo.set(subId, { channelId, topic });
      // eslint-disable-next-line no-console
      console.log(`[${this.slug}] subscribed to channel ${channelId} (${topic})`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[${this.slug}] subscribe failed`, err);
    }
  }

  #ensureUnsubscribed(channelId) {
    const subId = this.subscriptionByChannel.get(channelId);
    if (!this.client || subId == undefined) {
      this.subscriptionByChannel.delete(channelId);
      if (subId != undefined) {
        this.subscriptionInfo.delete(subId);
      }
      return;
    }
    try {
      this.client.unsubscribe(subId);
      // eslint-disable-next-line no-console
      console.log(`[${this.slug}] unsubscribed channel ${channelId}`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[${this.slug}] unsubscribe failed`, err);
    }
    this.subscriptionByChannel.delete(channelId);
    this.subscriptionInfo.delete(subId);
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

  async #loadPersistentHistory(earliestNs, topicsSet, ringEarliestByTopic) {
    if (!topicsSet || topicsSet.size === 0) {
      return new Map();
    }

    await ensureMcapReader();

    let dir;
    try {
      dir = await this.#ensureDirs();
    } catch {
      return new Map();
    }

    let files;
    try {
      files = await fs.readdir(dir);
    } catch {
      return new Map();
    }

    const history = new Map();
    const regex = /^(\d{4})(\d{2})(\d{2})_(\d{2})\.mcap$/;
    const earliestMs = Number(earliestNs / 1_000_000n);
    const candidates = files
      .map((file) => {
        const match = regex.exec(file);
        if (!match) {
          return undefined;
        }
        const [, y, m, d, h] = match;
        const startMs = Date.UTC(Number(y), Number(m) - 1, Number(d), Number(h));
        return { file, startMs };
      })
      .filter((value) => value && value.startMs + 3_600_000 >= earliestMs)
      .sort((a, b) => a.startMs - b.startMs);

    for (const entry of candidates) {
      if (this.currentSegment && this.currentSegment.endsWith(entry.file)) {
        continue;
      }
      const filePath = path.join(dir, entry.file);
      let handle;
      try {
        handle = await fs.open(filePath, 'r');
      } catch {
        continue;
      }

      try {
        const stat = await handle.stat();
        if (stat.size < 80) {
          continue;
        }
        const readable = {
          size: async () => BigInt(stat.size),
          read: async (offset, length) => {
            const total = Number(length);
            const buffer = Buffer.alloc(total);
            let filled = 0;
            let position = Number(offset);
            while (filled < total) {
              const { bytesRead } = await handle.read(buffer, filled, total - filled, position);
              if (bytesRead === 0) {
                break;
              }
              filled += bytesRead;
              position += bytesRead;
            }
            if (filled < total) {
              throw new Error(`Short read (${filled}/${total}) from ${entry.file}`);
            }
            return buffer;
          },
        };

        const reader = await McapIndexedReader.Initialize({ readable });
        const topicsArray = Array.from(topicsSet);
        const messageIterator = reader.readMessages({
          startTime: earliestNs,
          topics: topicsArray.length > 0 ? topicsArray : undefined,
        });

        for await (const msg of messageIterator) {
          const channel = reader.channelsById.get(msg.channelId);
          if (!channel) {
            continue;
          }
          if (topicsSet && !topicsSet.has(channel.topic)) {
            continue;
          }
          const ringCutoff = ringEarliestByTopic.get(channel.topic);
          if (ringCutoff != undefined && msg.logTime >= ringCutoff) {
            continue;
          }
          if (msg.logTime < earliestNs) {
            continue;
          }
          let arr = history.get(channel.topic);
          if (!arr) {
            arr = [];
            history.set(channel.topic, arr);
          }
          arr.push({ t: msg.logTime, p: new Uint8Array(msg.data) });
        }
      } catch (err) {
        console.warn(`[${this.slug}] failed to read history from ${entry.file}:`, err);
      } finally {
        try { await handle.close(); } catch {}
      }
    }

    for (const arr of history.values()) {
      arr.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
    }

    if (history.size > 0) {
      // eslint-disable-next-line no-console
      console.log(`[${this.slug}] loaded history for ${history.size} topics from disk`);
    } else {
      // eslint-disable-next-line no-console
      console.log(`[${this.slug}] no disk history for requested window`);
    }

    return history;
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
      this.subscriptionByChannel.clear();
      this.subscriptionInfo.clear();
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
        this.#ensureSubscribed(ch.id, ch.topic);
      }
    });
    this.client.on('unadvertise', (removed) => {
      for (const id of removed) {
        this.channels.delete(id);
        this.#ensureUnsubscribed(id);
      }
    });
    this.client.on('message', (msg) => {
      const subInfo = this.subscriptionInfo.get(msg.subscriptionId);
      if (!subInfo) {
        // eslint-disable-next-line no-console
        console.warn(`[${this.slug}] received message for unknown subscription ${msg.subscriptionId}`);
        return;
      }
      const ch = this.channels.get(subInfo.channelId);
      if (!ch) {
        // eslint-disable-next-line no-console
        console.warn(`[${this.slug}] received message for unknown channel ${subInfo.channelId}`);
        return;
      }
      const payload = new Uint8Array(msg.data.buffer, msg.data.byteOffset, msg.data.byteLength);
      // eslint-disable-next-line no-console
      console.log(`[${this.slug}] received message channel ${subInfo.channelId} (${ch.topic}) len ${payload.byteLength}`);
      if (this.topicsWhitelist && !this.topicsWhitelist.has(ch.topic)) return;
      this.#storeRing(ch.topic, msg.timestamp, payload);

      // Rotate segment if hour boundary crossed
      const now = new Date();
      const key = this.#segmentKey(now);
      if (key !== this.currentSegmentKey) {
        this.#rotateSegment(now).catch(() => {});
      }

      // Write to MCAP
      this.#writeMcapMessage(subInfo.channelId, ch, msg.timestamp, payload).catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`[${this.slug}] write MCAP failed for ${ch.topic}`, err);
      });
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
    if (!this.writer) {
      // eslint-disable-next-line no-console
      console.warn(`[${this.slug}] writer missing, dropping message for ${ch.topic}`);
      return;
    }
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
    if (!this.#loggedChannels?.has(ch.topic)) {
      this.#loggedChannels ??= new Set();
      this.#loggedChannels.add(ch.topic);
      // eslint-disable-next-line no-console
      console.log(`[${this.slug}] writing MCAP for ${ch.topic}`);
    }
  }

  #storeRing(topic, timestamp, payload) {
    const arr = this.ring.get(topic) || [];
    const firstForTopic = arr.length === 0;
    arr.push({ t: BigInt(timestamp), p: new Uint8Array(payload) });
    const cutoff = BigInt(Date.now() - this.maxRingMs) * 1_000_000n; // ns
    while (arr.length > 0 && arr[0].t < cutoff) {
      arr.shift();
    }
    this.ring.set(topic, arr);
    if (firstForTopic) {
      // eslint-disable-next-line no-console
      console.log(`[${this.slug}] ring storing topic ${topic}`);
    }
  }

  async attachClientServer(fgServer, { lookback }) {
    // Advertise current channels to this server instance and build mapping
    const map = new Map(); // upstreamId -> { serverChanId, topic }
    const serverChannelToTopic = new Map(); // serverChanId -> topic
    for (const [upId, ch] of this.channels) {
      const serverId = fgServer.addChannel({
        topic: ch.topic,
        encoding: ch.encoding,
        schemaName: ch.schemaName,
        schema: ch.schema,
      });
      map.set(upId, { serverChanId: serverId, topic: ch.topic });
      serverChannelToTopic.set(serverId, ch.topic);
    }
    const lookbackMs = parseLookback(lookback, this.maxRingMs);
    const earliest = BigInt(Date.now() - lookbackMs) * 1_000_000n;

    const topicsSet = new Set(serverChannelToTopic.values());

    const ringEarliestByTopic = new Map();
    for (const [topic, arr] of this.ring) {
      if (arr.length > 0) {
        ringEarliestByTopic.set(topic, arr[0].t);
      }
    }

    let persistedHistory = new Map();
    try {
      persistedHistory = await this.#loadPersistentHistory(earliest, topicsSet, ringEarliestByTopic);
    } catch (err) {
      console.warn(`[${this.slug}] failed to load persisted history:`, err);
    }

    // On subscribe send backlog for that channel to this single-client server
    fgServer.on('subscribe', (serverChanId) => {
      // find topic for this serverChanId
      const topic = serverChannelToTopic.get(serverChanId);
      if (!topic) return;
      const diskMessages = persistedHistory.get(topic);
      if (diskMessages && diskMessages.length > 0) {
        // eslint-disable-next-line no-console
        console.log(`[${this.slug}] replaying ${diskMessages.length} disk messages for ${topic}`);
        for (const { t, p } of diskMessages) {
          if (t >= earliest) {
            fgServer.sendMessage(serverChanId, t, p);
          }
        }
      }
      const arr = this.ring.get(topic);
      if (!arr || arr.length === 0) return;
      // eslint-disable-next-line no-console
      console.log(`[${this.slug}] replaying ${arr.length} ring messages for ${topic}`);
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
