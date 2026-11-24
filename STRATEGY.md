# Snapback Sniper — strategy notes

Paper-trading bot for the pump.fun bonding-curve replay (`agent-fun/replay/v2`).
Capital 10 SOL, at most 5 open positions, no shorts, no leverage.

## Entry

A curve becomes a buy when, inside a 20-slot window:

- it is 60–900 slots old (past the bundled-launch dump window, still young),
- real SOL reserves are 2–50 SOL,
- net inflow is at least +1.0 SOL, with at least 4 buys from at least 5 distinct
  wallets, and no single wallet supplying more than 60% of the buy SOL,
- price is up 12–200% from the window start, within 5% of the window high, and
  the newer half of the window bought harder than the older half (acceleration
  ≥ 1.2x).

First buy is 0.02 SOL; the position is then added to (0.03 SOL per add, up to
0.1 SOL total) only while the price is above the last add, the position is not
underwater, and net inflow over the window is still positive.

## Exits (first trigger wins, whole position)

- Take-profit +15% vs cost, stop-loss −10% vs cost.
- Trailing stop: once value reaches +5% over cost, exit if it falls 10% from peak.
- Flow fade: net SOL over the last 10 slots below −0.5 SOL.
- Any single recorded sell of 5+ SOL.
- Hold limit 300 slots, unless the position is up at least 10%.

A curve that completes is closed by the replay itself. After an exit the same
curve cools down for 100 slots and may be entered at most twice per run.

## Guardrail probes

The competition requires a ≥ 0.01 SOL round trip on at least 20 coins. To keep
that bar safe on any window, the bot paces tiny 0.011 SOL probe round trips
across the 24 h window (one in flight at a time, sold as soon as the buy lands),
toward 25 coins / 220 fills. A probe costs roughly 0.0005 SOL in fees.

## Costs

Every leg pays the 95 bps protocol + 30 bps creator curve fee plus a 105,000
lamport transaction fee; buys are sized under the 1%-of-real-reserve cap and
the 16-orders-per-batch cap. The bot is fully deterministic: no clock, no
environment, no randomness — the same window always produces the same actions.
