# Snapback Sniper — Pump.fun Replay Sprint Paper Bot

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/musengbob/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/rank.svg)](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/musengbob/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/reward.svg)](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper-trading bot for the [Pump.fun Replay Sprint — Paper Bot, Real Ranking](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) bounty on [make.fun](https://make.fun). It trades 10 SOL of paper money on a 24 h replay of pump.fun bonding-curve activity. Nothing is traded for real.

## Strategy

Buy short bursts of genuine, spread-out buying on young curves (60–900 slots
old, 2–50 SOL real reserves): net inflow ≥ +1.0 SOL over 20 slots, ≥ 4 buys
from ≥ 5 distinct wallets, price up 12%+ and near its window high, with the
newer half of the window buying harder than the older half. First buy 0.02 SOL,
pyramid to 0.1 SOL only while the tape keeps confirming.

Exit fast — take-profit +15%, stop-loss −10%, a 10% trailing stop once up 5%,
a flow-fade exit, and a 300-slot hold limit. Tiny 0.011 SOL probe round trips,
paced across the window, keep the entry above the 20-coin / 0.01 SOL round-trip
bar. See [STRATEGY.md](STRATEGY.md) for the full notes.

## Run

The grader runs `node main.ts` (Node 22+, no dependencies, no install). The bot
speaks `agent-fun/replay/v2` on stdin/stdout via the vendored shim in
`vendor/makefun-bot.ts`. It is fully deterministic: no clock, no environment,
no randomness.

## License

MIT — see [LICENSE](LICENSE).
