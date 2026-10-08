# X thread (build in public)

Post from the project account (`TODO-HUMAN: handle`). Every number links to its evidence. Each post is under 280
characters with X's URL weighting (23 per link); the count is in brackets. Attach the image named under a post if you
have it. Swap the `[pending]` post in once Saturday's rescue lands.

---

**1/8** [277]

Coinbase's tokenized stocks trade on Base all weekend. Their price feeds don't.

Over 2–4 Oct all ten Chainlink stock feeds printed nothing for 52 hours. The lending markets for these stocks read that frozen price, and can liquidate at any hour.

We built the fix: Boundline 🧵

*(image: the Observatory's feed table on a Saturday, every feed held)*

**2/8** [255]

When the feeds reopened on Sunday at 20:00 ET, the first prints came 23–53 seconds after the bell, with gaps from −7.5 to +282 bps.

The DEX already knew: NVDAc's Aerodrome TWAP sat 46 bps above the frozen feed before the reopen.

https://github.com/TODO-HUMAN/boundline/blob/main/docs/evidence/reopen-2026-10-04.md

**3/8** [270]

Base's docs say "never settle or liquidate against a frozen feed". Nothing enforced it.

SessionGuard is a Morpho oracle that refuses a frozen price: borrow, withdraw and liquidate stop on the weekend; repay and add-collateral never do. Live on Base Sepolia since 3 Oct.

**4/8** [267]

Saturday is when a position can still be saved.

ShadowGuard prices it at the 24/7 DEX TWAP less a haircut. Inside a narrow band, Morpho's audited pre-liquidation lets our Protector sell a small slice and repay the debt, at the live price, paid for by the collateral.

**5/8** [276]

Each keeper action is a Cobalt validity transaction with a predicate on the feed's storage slot: Base includes it only if the feed still shows the round the keeper decided on. On Saturday: only while it is frozen.

Our keeper did this on its own twice:
https://sepolia.basescan.org/tx/0x982c7327efa9f0460b92501a4322ec5dc730e5faaca3ce1d87dc80f708dfb695

**6/8** [234]

We replay real Aave V4 and Morpho positions (two of them pushed closer to their limit) on a mainnet fork through −3%, −8% and −15% weekend gaps.

Raw venues: 3 liquidations at the reopen. With Boundline: 0.

https://boundline-observatory.papermind-ai.workers.dev/v1/assurance

**7/8** [218]

Public goods, MIT, live now:
- an Observatory over every Coinbase stock feed and real position on Base
- an onchain NYSE calendar
- SessionGuard and ShadowGuard, drop-in oracles for any curator

https://boundline-observatory.papermind-ai.workers.dev

**8/8** [239]

Borrow against your stocks on Base. Paid in your currency. Never liquidated while Wall Street is closed.

Try it on Base Sepolia: https://boundline-app.papermind-ai.workers.dev
Code: https://github.com/TODO-HUMAN/boundline

Built for Colosseum's Crypto World's Fair, Base track.

---

**[pending] Saturday post, to send on Sat 10 Oct after the rescue lands**

It's Saturday. The feeds are frozen. The DEX moved.

Our keeper just protected a position at the live price, in a transaction Base would only include while the feed was still frozen:
https://sepolia.basescan.org/tx/`<hash>`

A plain liquidation on the same market: refused.

**[pending] Monday post, after the Sun 20:00 ET reopen (Mon 12 Oct 05:30 IST)**

The feeds reopened at 20:00 ET: first prints `<n>`–`<n>` s after the bell, gaps `<a>` to `<b>` bps (captured live by
the Observatory, run `1791763200`). `<one line on the protected position>`.
