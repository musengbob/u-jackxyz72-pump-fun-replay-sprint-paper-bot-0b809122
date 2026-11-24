// Snapback Sniper — a pump.fun bonding-curve replay bot (agent-fun/replay/v2).
//
// Idea: most new pump.fun curves are either bundled dumps or slow bleeders; the
// tradeable ones show a short burst of genuine, spread-out buying shortly after
// launch, while the price is still near its recent high. This bot buys that burst
// small, adds only while the tape keeps confirming it, and gets out fast — a fixed
// take-profit, a tight stop, a trailing stop once the trade works, and a flow-fade
// exit when the buyers leave. Nothing is held long: a position that has not paid
// within its hold window is closed.
//
// A second, deliberately boring mechanism keeps the entry above the competition's
// minimum bar (a >= 0.01 SOL round trip on at least 20 coins): tiny probe round
// trips on liquid curves, paced across the 24 h window, one at a time, sold as soon
// as the buy lands. Probes cost a few ten-thousandths of a SOL each and never take
// a slot a main position could use.
//
// Deterministic by construction: no clock, no environment, no Math.random; every
// decision comes from the batch stream, iterated in insertion order.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Entry lookback, in slots. */
  window: number;
  /** Net SOL (buys minus sells) over the window needed to enter. */
  minNetSol: number;
  /** Buy trades in the window. */
  minBuys: number;
  /** Distinct buying wallets in the window. */
  minBuyers: number;
  /** Price now vs price at the window start, minus 1. */
  minPriceUp: number;
  /** Upper bound on that rise: skip curves that already verticalled in one window. */
  maxPriceUp: number;
  /** Newer-half net inflow must be at least this multiple of the older half's. */
  accel: number;
  /** Price now must be at least this share of the window high. */
  nearHigh: number;
  /** Largest single buyer's share of the window's buy SOL (anti-bundle filter). */
  maxBuyerShare: number;
  /** Real SOL reserve bounds at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** Slots since CreateEvent before an entry is allowed, and after which it is too late. */
  minAge: number;
  maxAge: number;
  /** Total SOL committed to one position. */
  stakeSol: number;
  /** First buy of a position (SOL). */
  initialSol: number;
  /** Each add-on buy (SOL). */
  addSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys in bps; sells always go out at 10000 so exits actually fill. */
  buySlipBps: number;
  /** Exits, as fractions of cost / peak value. */
  stopLoss: number;
  takeProfit: number;
  trail: number;
  /** Trailing stop arms once value reaches cost * (1 + trailArm). */
  trailArm: number;
  /** Exit when net SOL over the fade window falls below -fadeNetSol. */
  fadeWindow: number;
  fadeNetSol: number;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Exit after this many slots held (unless the position is up). */
  maxHold: number;
  /** Fraction up at which the hold limit stops applying. */
  holdIfUp: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Most main positions open at once (the rest of the 5 slots is for probes). */
  maxMain: number;
  /** Most SOL at cost across all positions at once. */
  maxExposureSol: number;
  /** Guardrail pacing: probe round trips until this many coins / fills. */
  targetCoins: number;
  targetFills: number;
  /** Block-time seconds the pace is spread over (the 24 h final window). */
  paceSecs: number;
  /** SOL per probe buy (just over the 0.01 SOL round-trip bar). */
  probeSol: number;
  /** Most probe round trips in flight at once. */
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  window: 20,
  minNetSol: 1.0,
  minBuys: 4,
  minBuyers: 5,
  minPriceUp: 0.12,
  maxPriceUp: 2.0,
  accel: 1.2,
  nearHigh: 0.95,
  maxBuyerShare: 0.6,
  minRqSol: 2,
  maxRqSol: 50,
  minAge: 60,
  maxAge: 900,
  stakeSol: 0.1,
  initialSol: 0.02,
  addSol: 0.03,
  minBuySol: 0.01,
  buySlipBps: 1500,
  stopLoss: 0.1,
  takeProfit: 0.15,
  trail: 0.1,
  trailArm: 0.05,
  fadeWindow: 10,
  fadeNetSol: 0.5,
  bigSellSol: 5,
  maxHold: 300,
  holdIfUp: 0.1,
  cooldown: 100,
  maxEntries: 2,
  maxMain: 4,
  maxExposureSol: 1.0,
  targetCoins: 25,
  targetFills: 220,
  paceSecs: 86400,
  probeSol: 0.011,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
/** Protocol + creator curve fee on each leg (95 + 30 bps), from the competition's fee table. */
const CURVE_FEE = 0.0125;

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface CoinBook {
  created: number | null;
  trades: TapeTrade[];
  entries: number;
  lastExit: number;
}

interface OpenTrade {
  opened: number;
  peakValue: number;
  /** SOL spent on buys for this position, fees included. */
  invested: number;
  exiting: boolean;
  filled: boolean;
  lastAddPrice: number;
  lastValue: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const books = new Map<Pubkey, CoinBook>();
  const open = new Map<Pubkey, OpenTrade>();
  /** Probe round trips in flight, by mint. */
  const probes = new Set<Pubkey>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = p.window + 5;

  const bookOf = (mint: Pubkey): CoinBook => {
    let b = books.get(mint);
    if (b === undefined) {
      b = { created: null, trades: [], entries: 0, lastExit: -1e12 };
      books.set(mint, b);
    }
    return b;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots of a book. */
  const netFlow = (b: CoinBook, now: number, w: number): number => {
    let net = 0;
    for (let i = b.trades.length - 1; i >= 0; i--) {
      const tr = b.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** Entry signal on a coin's tape at slot `now`. */
  const entrySignal = (b: CoinBook, now: number, rqSol: number): boolean => {
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (b.created === null) return false;
    const age = now - b.created;
    if (age < p.minAge || age > p.maxAge) return false;
    const from = now - p.window;
    const mid = now - p.window / 2;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let netOld = 0;
    let netNew = 0;
    let startPrice = -1;
    let high = 0;
    let last = 0;
    const byUser = new Map<string, number>();
    for (const tr of b.trades) {
      if (tr.slot <= from) {
        startPrice = tr.price;
        continue;
      }
      if (startPrice < 0) startPrice = tr.price;
      const signed = tr.buy ? tr.sol : -tr.sol;
      if (tr.slot <= mid) netOld += signed;
      else netNew += signed;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
      } else {
        sellSol += tr.sol;
      }
      if (tr.price > high) high = tr.price;
      last = tr.price;
    }
    if (buys < p.minBuys || byUser.size < p.minBuyers) return false;
    if (buySol - sellSol < p.minNetSol) return false;
    if (startPrice <= 0) return false;
    const up = last / startPrice - 1;
    if (up < p.minPriceUp || up > p.maxPriceUp) return false;
    if (last < high * p.nearHigh) return false;
    if (netNew <= 0 || netNew < p.accel * netOld) return false;
    let top = 0;
    for (const v of byUser.values()) if (v > top) top = v;
    if (top > p.maxBuyerShare * buySol) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
      const traded = new Set<Pubkey>();

      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          bookOf(e.mint).created = e.slot;
        } else if (e.event === 'TradeEvent') {
          const b = bookOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          b.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          traded.add(e.mint);
          if (!e.is_buy && sol >= p.bigSellSol) bigSell.add(e.mint);
        }
      }
      // Drop tape older than the lookback so books stay small.
      for (const mint of traded) {
        const b = books.get(mint)!;
        let cut = 0;
        while (cut < b.trades.length && b.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) b.trades.splice(0, cut);
      }

      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const txSol = Number(state.txFeeLamports()) / LAMPORTS;

      /** Mark-to-market value of a position in SOL, curve fee and one tx fee deducted. */
      const markValue = (mint: Pubkey): number | null => {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined || curve === undefined) return null;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        return ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - txSol;
      };

      // --- Exits first: a position leaves on the first trigger that fires. ---
      for (const [mint, t] of open) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            open.delete(mint);
            const b = bookOf(mint);
            if (t.filled) b.lastExit = now;
            else b.entries--;
          }
          continue;
        }
        t.filled = true;
        if (curve === undefined || curve.complete) continue;
        const value = markValue(mint);
        if (value === null) continue;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > t.peakValue) t.peakValue = value;
        t.lastValue = value;
        const b = bookOf(mint);
        let exit = t.exiting;
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && t.peakValue >= cost * (1 + p.trailArm) && value < t.peakValue * (1 - p.trail)) exit = true;
        if (!exit && netFlow(b, now, p.fadeWindow) < -p.fadeNetSol) exit = true;
        if (!exit && bigSell.has(mint)) exit = true;
        if (!exit && now - t.opened > p.maxHold && value < cost * (1 + p.holdIfUp)) exit = true;
        if (!exit) continue;
        t.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) {
            if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          }
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10000 });
      }

      // --- Probes: sell the whole probe as soon as its buy has landed. ---
      for (const mint of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10000 });
      }

      // --- Entries and adds. ---
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - open.size;
      let exposure = 0;
      for (const [mint, t] of open) {
        exposure += Math.max(t.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      }
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const b = books.get(mint)!;
        const t = open.get(mint);
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        let want: number;
        if (t === undefined) {
          if (slotsLeft <= 0 || mainLeft <= 0) continue;
          if (b.entries >= p.maxEntries || now - b.lastExit < p.cooldown) continue;
          if (!entrySignal(b, now, rqSol)) continue;
          want = Math.min(p.initialSol, p.stakeSol);
        } else {
          // Add only into strength: price above the last add, position not underwater,
          // and the tape still shows net inflow.
          if (t.exiting || !t.filled || t.invested >= p.stakeSol - p.minBuySol) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (price <= t.lastAddPrice) continue;
          if (t.lastValue < (Number(pos.cost_lamports) / LAMPORTS) * 1.0) continue;
          if (netFlow(b, now, p.window) < 0.2) continue;
          if (rqSol > p.maxRqSol) continue;
          want = Math.min(p.addSol, p.stakeSol - t.invested);
        }
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, want, p.maxExposureSol - exposure);
        if (amount > free - txSol) amount = free - txSol;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + txSol;
        exposure += amount;
        if (t === undefined) {
          open.set(mint, {
            opened: now,
            peakValue: 0,
            invested: amount,
            exiting: false,
            filled: false,
            lastAddPrice: price,
            lastValue: 0,
          });
          b.entries++;
          slotsLeft--;
          mainLeft--;
        } else {
          t.invested += amount;
          t.lastAddPrice = price;
        }
      }

      // --- Guardrail pacing: open a probe when fills or coins lag the pace. ---
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * 10000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (open.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * txSol) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.add(mint);
            free -= p.probeSol + txSol;
          }
        }
      }
      return orders;
    },
  };
}
