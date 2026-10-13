# X thread (build in public)

Post from the project account (`TODO-HUMAN: handle`). Every number links to its evidence. Each post is under 280
characters with X's weighting (23 per link, 2 for a minus sign or an emoji); the count is in brackets. Attach the image
named under a post if you have it. Post 9 is the Monday feed-outage rescue: send it after the thread, or on its own.

---

**1/8** [264]

Coinbase's tokenized stocks trade on Base all weekend. Their price feeds don't.

Two weekends running, all ten Chainlink stock feeds printed nothing for 48 hours. Lending markets read that frozen price and can liquidate at any hour.

We built the fix: Boundline 🧵

*(image: the Observatory's weekend-gaps panel, 9–11 Oct)*

**2/8** [269]

Sun 11 Oct, 20:00 ET: the feeds reopened. The first prints came 21–53 seconds after the bell, MSTRc +201 bps, SNDKc +145 bps.

Our Observatory captured it live, and the chain agrees field for field, down to the transaction of every first print.

https://github.com/FarseenSh/boundline/blob/main/docs/evidence/reopen-2026-10-11.md

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

**6/8** [257]

We replay real Aave V4 and Morpho positions on a mainnet fork through −3%, −8% and −15% weekend gaps, two of them staged near their limit.

Raw venues: 3 liquidations at the reopen, all on the staged positions. With Boundline: 0.

https://observatory.boundline.xyz/v1/assurance

**7/8** [218]

Public goods, MIT, live now:
- an Observatory over every Coinbase stock feed and real position on Base
- an onchain NYSE calendar
- SessionGuard and ShadowGuard, drop-in oracles for any curator

https://observatory.boundline.xyz

**8/8** [239]

Borrow against your stocks on Base. Paid in your currency. Never liquidated while Wall Street is closed.

Try it on Base Sepolia: https://app.boundline.xyz
Code: https://github.com/FarseenSh/boundline

Built for Colosseum's Crypto World's Fair, Base track.

---

**9 (Monday, the feed-outage rescue)** [278]

Monday we froze the Apple feed on Sepolia mid-session (to our oracles an outage is a weekend) and dropped the test DEX.

Our keeper closed the position at the live price, in a tx Base includes only while the feed is frozen:
https://sepolia.basescan.org/tx/0x9774913eecd620da53019d701f10c8e90400cb6497030785a2e374360d280352

A plain liquidation: refused.
