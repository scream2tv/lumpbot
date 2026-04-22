import { EventEmitter } from 'events';
import axios from 'axios';
import WebSocket from 'ws';
import { CardanoStackConfig } from '../config/cardano';
import { logger } from '../utils/logger';

export interface ChainPoint {
  slot: number;
  id: string;
}

export interface OgmiosValue {
  lovelace: bigint;
  // key = `${policyHex}${assetNameHex}` (no dot)
  assets: Map<string, bigint>;
}

export interface OgmiosTxInput {
  txId: string;
  index: number;
}

export interface OgmiosTxOutput {
  address: string;
  value: OgmiosValue;
}

export interface OgmiosTransaction {
  id: string;
  inputs: OgmiosTxInput[];
  outputs: OgmiosTxOutput[];
  fee: bigint;
}

export interface OgmiosBlock {
  slot: number;
  id: string;
  height: number | null;
  era: string | null;
  transactions: OgmiosTransaction[];
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  method: string;
}

const PIPELINE_DEPTH = 4;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const MEMPOOL_IDLE_BACKOFF_MS = 500;
const MEMPOOL_SEEN_TTL_MS = 15 * 60 * 1000;

/**
 * Ogmios WebSocket client that streams blocks in real time via the
 * chain-synchronization mini-protocol. Starts at the current tip and
 * keeps itself reconnected across network blips.
 *
 * Emits:
 *   'block'    — (block: OgmiosBlock)         confirmed block
 *   'tx'       — (tx: OgmiosTransaction)      unconfirmed mempool tx (first sighting only)
 *   'rollback' — (point: ChainPoint)
 *   'connected' / 'disconnected' / 'error'
 */
export class OgmiosClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private pending = new Map<string | number, PendingRequest>();
  private nextId = 1;
  private stopped = false;
  private backoff = INITIAL_BACKOFF_MS;
  private currentPoint: ChainPoint | null = null;
  private syncing = false;
  private inFlightNextBlock = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private mempoolRunning = false;
  private mempoolSeen = new Map<string, number>();
  private awaitingCursorConfirm = false;

  constructor(private readonly cfg: CardanoStackConfig) {
    super();
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await axios.get(this.cfg.ogmiosHealthUrl, { timeout: 5_000 });
      const body = res.data as { connectionStatus?: string; network?: string } | undefined;
      const ok = res.status >= 200 && res.status < 300 && body?.connectionStatus !== 'disconnected';
      return { ok, detail: `HTTP ${res.status} ${body?.connectionStatus ?? ''}`.trim() };
    } catch (err: any) {
      return { ok: false, detail: err?.message ?? 'unknown error' };
    }
  }

  /** Opens the WS connection and begins streaming blocks from the current tip. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.connectAndSync();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  private async connectAndSync(): Promise<void> {
    try {
      logger.debug('Ogmios: opening socket');
      await this.openSocket();
      logger.debug('Ogmios: socket open, querying tip');
      const tip = this.currentPoint ?? (await this.queryTip());
      logger.debug('Ogmios: tip resolved, finding intersection', tip);
      await this.findIntersection([tip]);
      logger.debug('Ogmios: intersection found');
      this.currentPoint = tip;
      this.syncing = true;
      this.awaitingCursorConfirm = true;
      for (let i = 0; i < PIPELINE_DEPTH; i++) this.sendNextBlock();
      this.backoff = INITIAL_BACKOFF_MS;
      void this.runMempoolLoop();
      this.emit('connected', tip);
      logger.info('Ogmios chain-sync + mempool subscription started', { slot: tip.slot });
    } catch (err) {
      logger.warn('Ogmios connect failed', err);
      this.scheduleReconnect();
    }
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.cfg.ogmiosWsUrl);
      this.ws = ws;

      const onOpen = () => {
        ws.off('error', onErr);
        ws.on('message', (data) => this.handleMessage(data));
        ws.on('close', () => this.handleClose());
        ws.on('error', (err) => this.emit('error', err));
        resolve();
      };
      const onErr = (err: Error) => {
        ws.off('open', onOpen);
        reject(err);
      };
      ws.once('open', onOpen);
      ws.once('error', onErr);
    });
  }

  private handleClose(): void {
    this.syncing = false;
    this.mempoolRunning = false;
    this.inFlightNextBlock = 0;
    this.ws = null;
    for (const p of this.pending.values()) p.reject(new Error('socket closed'));
    this.pending.clear();
    this.emit('disconnected');
    if (!this.stopped) this.scheduleReconnect();
  }

  /**
   * Continuously drains the node's mempool. Acquire → iterate nextTransaction
   * until exhausted → release → acquire again. Ogmios blocks the response to
   * a fresh `acquireMempool` until a new snapshot is available, so this loop
   * is efficient (no busy-wait) in practice.
   */
  private async runMempoolLoop(): Promise<void> {
    if (this.mempoolRunning) return;
    this.mempoolRunning = true;
    try {
      while (
        this.mempoolRunning &&
        !this.stopped &&
        this.ws?.readyState === WebSocket.OPEN
      ) {
        try {
          await this.rpc('acquireMempool');
          let fresh = 0;
          while (true) {
            const res: any = await this.rpc('nextTransaction', { fields: 'all' });
            const raw = res?.transaction;
            if (!raw) break;
            const parsed = parseTx(raw);
            if (!parsed) continue;
            if (this.mempoolSeen.has(parsed.id)) continue;
            this.mempoolSeen.set(parsed.id, Date.now());
            fresh++;
            this.emit('tx', parsed);
          }
          await this.rpc('releaseMempool').catch(() => undefined);
          this.pruneMempoolSeen();
          if (fresh === 0) await sleep(MEMPOOL_IDLE_BACKOFF_MS);
        } catch (err) {
          logger.debug('Ogmios mempool iteration failed', err);
          await sleep(MEMPOOL_IDLE_BACKOFF_MS);
        }
      }
    } finally {
      this.mempoolRunning = false;
    }
  }

  private pruneMempoolSeen(): void {
    if (this.mempoolSeen.size < 2_000) return;
    const cutoff = Date.now() - MEMPOOL_SEEN_TTL_MS;
    for (const [id, ts] of this.mempoolSeen) {
      if (ts < cutoff) this.mempoolSeen.delete(id);
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    logger.info(`Ogmios reconnecting in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectAndSync();
    }, delay);
  }

  private handleMessage(raw: WebSocket.Data): void {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch (err) {
      logger.warn('Ogmios: invalid JSON', err);
      return;
    }
    const id = msg.id;
    const pending = id != null ? this.pending.get(id) : undefined;
    if (!pending) {
      logger.debug('Ogmios: unmatched message', {
        id, method: msg.method, hasResult: !!msg.result, hasError: !!msg.error,
        keys: Object.keys(msg),
      });
    }
    if (pending) {
      this.pending.delete(id);
      if (msg.error) {
        pending.reject(new Error(`${pending.method}: ${JSON.stringify(msg.error)}`));
      } else if (pending.method === 'nextBlock') {
        this.inFlightNextBlock = Math.max(0, this.inFlightNextBlock - 1);
        this.handleNextBlockResult(msg.result);
        if (this.syncing && !this.stopped) this.sendNextBlock();
        pending.resolve(msg.result);
      } else {
        pending.resolve(msg.result);
      }
    }
  }

  private handleNextBlockResult(result: any): void {
    if (!result) return;
    if (result.direction === 'forward' && result.block) {
      const parsed = parseBlock(result.block);
      if (parsed) {
        this.currentPoint = { slot: parsed.slot, id: parsed.id };
        this.emit('block', parsed);
      }
    } else if (result.direction === 'backward' && result.point) {
      const point: ChainPoint = { slot: result.point.slot ?? 0, id: result.point.id ?? '' };
      if (point.id) this.currentPoint = point;
      if (this.awaitingCursorConfirm) {
        // First backward after findIntersection is cursor confirmation, not a reorg.
        this.awaitingCursorConfirm = false;
        return;
      }
      this.emit('rollback', point);
    }
  }

  private sendNextBlock(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.inFlightNextBlock++;
    void this.rpc('nextBlock').catch(() => {
      /* errors surface via emit('error'); next connect retries */
    });
  }

  private async queryTip(): Promise<ChainPoint> {
    const result: any = await this.rpcWithTimeout('queryNetwork/tip', null, 10_000);
    if (!result?.slot || !result?.id) throw new Error(`Ogmios tip query returned no point: ${JSON.stringify(result)}`);
    return { slot: Number(result.slot), id: String(result.id) };
  }

  private async findIntersection(points: ChainPoint[]): Promise<ChainPoint> {
    const serialized = points.map((p) => ({ slot: p.slot, id: p.id }));
    const result: any = await this.rpcWithTimeout('findIntersection', { points: serialized }, 10_000);
    const intersection = result?.intersection;
    if (!intersection || intersection === 'origin') {
      return points[0];
    }
    return { slot: Number(intersection.slot), id: String(intersection.id) };
  }

  /**
   * Wraps rpc() with a timeout. Used for bootstrap calls (queryTip,
   * findIntersection) where a hang indicates the node isn't responding —
   * we want to fail fast and hit the reconnect backoff instead of blocking
   * the startup path forever. Streaming calls (nextBlock, acquireMempool)
   * legitimately block waiting for new data and don't use this.
   */
  private rpcWithTimeout(method: string, params: unknown, timeoutMs: number): Promise<any> {
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        try { this.ws?.close(); } catch { /* ignore */ }
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.rpc(method, params).then(
        (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v); },
        (e) => { if (done) return; done = true; clearTimeout(timer); reject(e); },
      );
    });
  }

  private rpc(method: string, params: unknown = null): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Ogmios: socket not open'));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject, method });
      const payload: Record<string, unknown> = { jsonrpc: '2.0', method, id };
      if (params != null) payload.params = params;
      this.ws.send(JSON.stringify(payload));
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseValue(raw: any): OgmiosValue {
  const out: OgmiosValue = { lovelace: 0n, assets: new Map() };
  if (!raw) return out;

  // v6 format: { ada: { lovelace }, <policyHex>: { <assetNameHex>: qty } }
  if (raw.ada?.lovelace != null) out.lovelace = BigInt(String(raw.ada.lovelace));
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'ada') continue;
    if (typeof v !== 'object' || v === null) continue;
    for (const [name, qty] of Object.entries(v as Record<string, unknown>)) {
      out.assets.set(`${k}${name}`, (out.assets.get(`${k}${name}`) ?? 0n) + BigInt(String(qty)));
    }
  }

  // v5 fallback: { coins, assets: { "<policy>.<asset>": qty } }
  if (out.lovelace === 0n && raw.coins != null) out.lovelace = BigInt(String(raw.coins));
  if (raw.assets && typeof raw.assets === 'object') {
    for (const [k, qty] of Object.entries(raw.assets as Record<string, unknown>)) {
      const unit = k.replace('.', '');
      out.assets.set(unit, (out.assets.get(unit) ?? 0n) + BigInt(String(qty)));
    }
  }
  return out;
}

function parseInput(raw: any): OgmiosTxInput | null {
  if (!raw) return null;
  const txId = raw.transaction?.id ?? raw.txId ?? raw.tx_id;
  const index = raw.index ?? raw.outputIndex;
  if (typeof txId !== 'string' || typeof index !== 'number') return null;
  return { txId, index };
}

function parseOutput(raw: any): OgmiosTxOutput | null {
  if (!raw) return null;
  const address = raw.address;
  if (typeof address !== 'string') return null;
  return { address, value: parseValue(raw.value) };
}

function parseTx(raw: any): OgmiosTransaction | null {
  if (!raw?.id) return null;
  const inputs: OgmiosTxInput[] = [];
  for (const i of raw.inputs ?? []) {
    const parsed = parseInput(i);
    if (parsed) inputs.push(parsed);
  }
  const outputs: OgmiosTxOutput[] = [];
  for (const o of raw.outputs ?? []) {
    const parsed = parseOutput(o);
    if (parsed) outputs.push(parsed);
  }
  const fee = BigInt(String(raw.fee?.ada?.lovelace ?? raw.fee?.lovelace ?? raw.fee ?? 0));
  return { id: raw.id, inputs, outputs, fee };
}

function parseBlock(raw: any): OgmiosBlock | null {
  if (!raw) return null;
  const id = raw.id ?? raw.hash;
  const slot = raw.slot ?? raw.header?.slot;
  if (typeof id !== 'string' || typeof slot !== 'number') return null;
  const txs = Array.isArray(raw.transactions) ? raw.transactions : [];
  return {
    id,
    slot,
    height: raw.height ?? null,
    era: raw.era ?? null,
    transactions: txs.map(parseTx).filter((t: OgmiosTransaction | null): t is OgmiosTransaction => t !== null),
  };
}
