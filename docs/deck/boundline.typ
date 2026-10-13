// Boundline: Colosseum Crypto World's Fair deck (Base track), October 2026.
// Build: `typst compile docs/deck/boundline.typ docs/deck/boundline.pdf` (typst 0.14).
// Palette = the apps' tokens (apps/app/src/styles.css). Fonts fall back to system faces when Geist / Instrument Serif
// are not installed. Every number has a source in docs/submission/SUBMISSION.md. Amber `TODO` boxes are for the team.

#let paper = rgb("#0e1116")
#let panel = rgb("#141921")
#let panel2 = rgb("#1a2029")
#let ln = rgb("#262d37")
#let ink = rgb("#e9ecef")
#let ink2 = rgb("#b4bcc7")
#let mute = rgb("#808a97")
#let coral = rgb("#ff6b57")
#let live = rgb("#5bc79a")
#let amber = rgb("#f0b65a")
#let focus = rgb("#9cc4ff")

#let sans = ("Geist", "Helvetica Neue", "Helvetica")
#let mono = ("Geist Mono", "Menlo")
#let serif = ("Instrument Serif", "New York", "Georgia")

#set page(width: 254mm, height: 142.9mm, margin: (x: 16mm, top: 11mm, bottom: 9mm), fill: paper)
#set text(font: sans, size: 12pt, fill: ink, lang: "en")
#set par(leading: 0.62em, justify: false)
#show link: it => text(fill: focus)[#it]
#show raw: set text(font: mono, size: 0.9em, fill: ink2)

#let ftr = context [
  #set text(font: mono, size: 7pt, fill: mute)
  #grid(columns: (1fr, auto), align(left)[Boundline · Colosseum Crypto World's Fair · Base track], align(right)[#counter(page).display()])
]
#let kick(k) = block[#grid(columns: (auto, auto), column-gutter: 8pt, align: horizon,
  rect(width: 3pt, height: 10pt, fill: coral, radius: 1pt),
  text(font: mono, size: 8pt, fill: coral, tracking: 1.6pt)[#upper(k)])]
#let head(k, t) = block[
  #kick(k) #v(4pt)
  #text(size: 21pt, weight: "bold", tracking: -0.4pt)[#t]
  #v(4pt) #line(length: 100%, stroke: 0.6pt + ln) #v(6pt)]
#let stat(c, n, l) = block(width: 100%)[
  #text(size: 24pt, weight: "bold", fill: c, tracking: -0.8pt)[#n]
  #linebreak() #v(-5pt) #text(size: 9pt, fill: ink2)[#l]]
#let note(body) = block(width: 100%, fill: panel, inset: 8pt, radius: 5pt, stroke: 0.5pt + ln)[#text(size: 9.5pt, fill: ink2)[#body]]
#let todo(body) = box(fill: rgb("#3a2b10"), inset: (x: 4pt, y: 2pt), radius: 3pt, stroke: 0.5pt + amber)[#text(font: mono, size: 8pt, fill: amber)[TODO: #body]]
#let pend(body) = box(fill: panel2, inset: (x: 4pt, y: 2pt), radius: 3pt, stroke: 0.5pt + focus)[#text(font: mono, size: 8pt, fill: focus)[pending: #body]]
#let hx(h) = text(font: mono, size: 8pt, fill: ink2)[#h]
// The brand mark and lockup from docs/brand (bl, with the weekend held): outlined SVGs, so no font is needed.
#let mark(s) = box(baseline: 15%, image("boundline-tile.svg", width: s))
#let lockup(h) = image("boundline-lockup-dark.svg", height: h)
#let tbl(cols, ..cells) = text(size: 8.6pt)[#table(columns: cols, inset: (x: 6pt, y: 3.6pt), stroke: 0.5pt + ln,
  fill: (x, y) => if y == 0 { panel2 } else { none }, ..cells)]

// ───────────────────────────────────────────── 1 · title
#v(26mm)
#lockup(54pt)
#v(14pt)
#text(size: 17pt)[Borrow against your stocks on Base. Paid in your currency.]
#linebreak()
#text(size: 17pt, fill: coral)[Never liquidated while Wall Street is closed.]
#v(8pt)
#box(width: 80%)[#text(size: 11.5pt, fill: ink2)[The session-aware credit layer for Coinbase's tokenized stocks on Base: an onchain market calendar, oracles that refuse a frozen price, protection that runs on weekends, and credit lines any wallet or broker can embed. Non-custodial.]]
#v(1fr)
#line(length: 100%, stroke: 0.6pt + ln)
#v(6pt)
#text(font: mono, size: 8.5pt, fill: mute)[Farseen Shaikh · #todo[second developer] · Colosseum Crypto World's Fair, Base track · October 2026]
#set page(footer: ftr)
#pagebreak()

// ───────────────────────────────────────────── 2 · the problem
#head[the problem][The stocks trade all weekend. Their price does not.]
#grid(columns: (1.55fr, 1fr), column-gutter: 16pt,
  tbl((auto, auto, auto, auto, auto, auto),
    [*Feed*], [*Held print*], [*Age at reopen*], [*Rounds while closed*], [*First print*], [*Gap*],
    [AAPLc], [336.84], [52.5 h], [0], [+51 s], [−5.8 bps],
    [AMZNc], [261.80], [52.7 h], [0], [+41 s], [+51.9 bps],
    [GOOGLc], [352.63], [54.7 h], [0], [+31 s], [+4.7 bps],
    [METAc], [719.92], [54.4 h], [0], [+53 s], [+14.7 bps],
    [MSFTc], [536.08], [53.3 h], [0], [+23 s], [−1.5 bps],
    [MSTRc], [154.61], [53.2 h], [0], [+21 s], [+201.0 bps],
    [NVDAc], [230.26], [56.7 h], [0], [+23 s], [+1.1 bps],
    [SNDKc], [1,581.77], [52.4 h], [0], [+21 s], [+144.7 bps],
    [SPCXc], [162.62], [52.1 h], [0], [+37 s], [+94.9 bps],
    [TSLAc], [383.97], [55.9 h], [0], [+23 s], [+16.5 bps],
  ),
  block[
    #text(size: 10.5pt)[
      - The Chainlink feeds for Coinbase's tokenized stocks publish *Sun 20:00 → Fri 20:00 ET* and hold Friday's close in between.
      - Aave V4's Equities Hub and Morpho's B20 markets read that held price with *no staleness, pause or market-hours check*. Liquidation is open at any hour.
      - At the reopen the weekend's move prints in *one block*. A position that gapped through its limit is gone before its owner can act.
    ]
    #v(4pt)
    #note[Base's docs: "never settle or liquidate against a frozen feed". Aave's risk provider calls session-aware handling "a future stage".]
  ],
)
#v(2pt)
#text(size: 8pt, fill: mute)[The 9–11 Oct 2026 weekend, all ten feeds: captured live by the Observatory and reconstructed from the Chainlink round history on Base mainnet, agreeing on every field (`docs/evidence/reopen-2026-10-11.md`). 2–4 Oct looked the same: zero rounds, first prints 23–53 s, MSTRc +282 bps.]
#pagebreak()

// ───────────────────────────────────────────── 3 · what boundline is
#head[what it is][A credit layer that knows when Wall Street is closed.]
#grid(columns: (1fr, 1fr, 1fr), column-gutter: 14pt,
  stat(coral)[Refuse][a frozen price at the venue: on Boundline's markets nobody can borrow or liquidate against it; repay and add-collateral always work.],
  stat(live)[Protect][on Saturday, at the price the market actually shows: a small sale paid for by the collateral, or a repay from a reserve.],
  stat(focus)[Embed][a line of credit any wallet or broker can offer, paid out in the user's own currency, with one record per loan.],
)
#v(10pt)
#text(size: 11pt)[
- *Who pays:* wallets, neobrokers and fintechs that list tokenized stocks (B2B2C); curators who want protected markets; issuers who need credit rails.
- *Non-custodial:* the user keeps their own Morpho or Aave position and authorises Boundline, or the venue's own audited contract, with one signature.
]
#pagebreak()

// ───────────────────────────────────────────── 4 · layers
#head[how it is built][From the clock to the partner: every layer is live.]
#tbl((auto, 1fr, auto),
  [*Layer*], [*What decides*], [*Proof*],
  [Time], [`MarketCalendar`: every NYSE session onchain (pre, regular, post, overnight, weekend, holiday, early closes, daylight saving)], [5,643 instants, 3 independent implementations, 0 disagreements],
  [Verdict], [`SessionGate`: per stock, is this price safe? Session, feed age, Coinbase OracleRegistry pause, issuer transfer pause; fails closed], [34 oracle tests],
  [Venue oracle], [`SessionGuard` (Morpho): reverts while the feed is held, so borrow, withdraw and liquidate stop; repay never reads it], [live since 3 Oct; mainnet fork],
  [Protection], [`ShadowGuard`: the 24/7 Aerodrome TWAP less a haircut. Morpho's audited pre-liquidation + Boundline's `Protector`; the `DeskProtectionVault` ladder and the `BoundlineReserve` (ERC-4626)], [keeper acted on its own, also under a frozen feed; Reserve advances settled],
  [Credit], [`CreditDesk` (Morpho), `AaveDesk` (Aave V4 via Taker/Giver): partner policy, decision hashes, local-money payout], [live lines; Aave on a mainnet fork],
  [Data], [Observatory, indexer with hash-chained daily roots, fork replay through weekend gaps], [live on mainnet reads],
  [Partners], [API (x402-metered), SDK, app, console, MCP agent surface], [eight Workers live],
)
#pagebreak()

// ───────────────────────────────────────────── 5 · one weekend
#head[one weekend, protected][Repay is always open. Sales wait for the session.]
#grid(columns: (1fr, 1fr, 1fr, 1fr), column-gutter: 10pt,
  note[#text(fill: ink, weight: "bold")[Fri 20:00 ET] \ The feed freezes. `SessionGuard` stops pricing it: no borrows, no liquidations on Boundline's markets. Repay and add-collateral stay open.],
  note[#text(fill: ink, weight: "bold")[Saturday] \ The token moves on Aerodrome. `ShadowGuard` prices the position at the TWAP less 2%. The keeper sizes the action *on chain*.],
  note[#text(fill: ink, weight: "bold")[Saturday, inside the band] \ A slice of collateral is sold inside Morpho's pre-liquidation callback and repays the debt; or the vault repays from the user's reserve, then a bounded Reserve advance.],
  note[#text(fill: ink, weight: "bold")[Sun 20:00 ET] \ The feed reopens. The position is already safe. Any advance is settled in session, at a fresh price, with its fee.],
)
#v(10pt)
#text(size: 10.5pt)[
*Why this order is forced:* Morpho's pre-liquidation refuses once a position is past its limit, so nothing can rescue a position that gaps through it at the reopen. Only an action taken *while the feed is frozen*, at the live price, prevents the liquidation. The venues cannot see the live price; Boundline does.
]
#pagebreak()

// ───────────────────────────────────────────── 6 · validity transactions
#head[cobalt validity transactions][Base itself holds the keeper's action until the feed state matches.]
#grid(columns: (1.1fr, 1fr), column-gutter: 16pt,
  block[
    #text(size: 10.5pt)[
      - Each protective action is signed with a *storage predicate* on the feed's `updatedAt` slot and a block bound, sent with `base_sendRawTransactionValidity`.
      - "*Only while held*" → a Saturday action can never land after the feed has printed a new price.
      - "*Only once it prints*" → the first-block action waits in the sequencer for the reopen.
      - The sequencer accepts a bound at most 32 blocks ahead, so the keeper re-arms every minute; every check also lives in the contract.
    ]
  ],
  block[
    #tbl((auto, 1fr),
      [*Predicate*], [*On Base Sepolia*],
      [`slot = held`], [#hx[0x6b17288f…49dd] · included next block],
      [`slot ≠ held`], [#hx[0xbbd84631…b2fb] · included after the round changed],
      [keeper, held], [#hx[0x982c7327…b695] · automatic protection],
      [keeper, held], [#hx[0x6d45ddc9…40d9] · automatic, 89 min later],
      [keeper, frozen], [#hx[0x9774913e…0352] · close-out, staged outage, 12 Oct],
      [vault, frozen], [#hx[0x47ac5279…1d24] · ladder repay, same predicate],
    )
    #v(4pt)
    #text(size: 8.5pt, fill: mute)[Measured: "not before", not "as soon as" (`docs/evidence/validity-transactions-sepolia.md`).]
  ],
)
#pagebreak()

// ───────────────────────────────────────────── 7 · what is live
#head[what is live][Base Sepolia, on real B20 test stocks mirrored from mainnet.]
#tbl((auto, 1fr, auto),
  [*What*], [*What happened*], [*Transaction*],
  [Weekend refusal], [Sat 3 Oct: collateral added; a borrow attempt reverts `MarketClosed(WEEKEND)`], [#hx[0x01191a77…760b]],
  [In-session draw], [Tue 6 Oct, PRE: 5 USDC through the CreditDesk at \$332.67, decision hash on chain], [#hx[0x661ebb1a…8bac]],
  [Automatic protection], [keeper pre-liquidated an in-band position at the live price: shadow LTV 60.12% → 58.00%], [#hx[0x982c7327…b695]],
  [Reserve advance], [protective repay on a live line: 0.5 USDC from the user's reserve + 0.2 USDC Reserve advance, settled with a 1% fee], [#hx[0x28c1ec44…08a4]],
  [Local money], [0.5 USDC → 0.46 EURCt inside the borrow flow, session-checked], [#hx[0x9090633c…5bd3]],
  [x402], [two keyless API calls paid \$0.01 test USDC each], [#hx[0x8816d08f…c6ff]],
  [Frozen feed], [Mon 12 Oct, a staged feed outage: the keeper closed out an in-band position at the live price as a validity transaction; a raw liquidation reverted `FeedStale`; the vault repaid a second line from the user's reserve + a Reserve advance], [#hx[0x9774913e…0352]],
  [Drills], [stale feed, registry pause, issuer pause, scheduled multiplier, blocked receiver, keeper hold: each refused by name, repays still land], [#hx[0x84064c22…8429]],
  [Webhooks], [a hold and a release on a live line reached the partner HMAC-signed, 84 s and 170 s after the block], [#hx[0x5dd9d8df…42b7]],
  [Dividend → loan], [a dividend multiplier step swept into a desk line's debt: flash loan, repay first, sell only the dividend collateral], [#hx[0xa44b7867…f680]],
)
#v(3pt)
#text(size: 8pt, fill: mute)[Every Sepolia contract verified on sepolia.basescan.org (`deployments/base-sepolia.json`). The same footprint is on Base mainnet since 13 Oct: 50 transactions, 16 contracts verified on basescan.org, 33 of 33 checks (`deployments/base-mainnet.json`); its market is unseeded and nobody has opted in yet.]
#pagebreak()

// ───────────────────────────────────────────── 8 · mainnet
#head[base mainnet][Deployed 13 Oct; read live every minute, proven on forks, replayed through weekend gaps.]
#grid(columns: (1fr, 1fr), column-gutter: 16pt,
  block[
    #grid(columns: (1fr, 1fr), column-gutter: 10pt, row-gutter: 10pt,
      stat(coral)[\$1.73M][USDC borrowed on Aave V4's MAG7 stock spoke against \$5.14M of tokenized-stock collateral (block 52,517,725, 12 Oct)],
      stat(amber)[14][Morpho B20 markets, 16,315.76 USDC borrowed (12 Oct)],
      stat(live)[10][Coinbase stock feeds, sessions and registry flags, every minute],
      stat(focus)[8][mainnet-fork suites: SessionGuard on the live Morpho, the Protector on a real Steakhouse borrower, Aave's Taker and Giver, the EURC pool, the replay, the Aave hub halt, a bad-debt probe, a real dividend],
    )
  ],
  block[
    #text(size: 10pt, weight: "bold")[Replay, 7 Oct (fork block 52,295,895)]
    #v(2pt)
    #tbl((auto, auto, auto),
      [*Gap at reopen*], [*Raw venue: liquidated*], [*Boundline: liquidated*],
      [−3%], [0 of 5], [0 of 5],
      [−8%], [1 of 5], [0 of 5],
      [−15%], [2 of 5], [0 of 5],
    )
    #v(4pt)
    #text(size: 8.5pt, fill: ink2)[Five positions: three as they stood, two real positions staged near their limit. Every raw liquidation was a staged position; the three as they stood stayed healthy even at −15%. Boundline acts on Saturday at the live price (pre-liquidation in the band, a repay above it). Evidence hash #hx[0xa626f099…3c45].]
  ],
)
#pagebreak()

// ───────────────────────────────────────────── 9 · partners and agents
#head[the partner surface][A wallet integrates in a day and keeps its brand.]
#grid(columns: (1fr, 1fr, 1fr), column-gutter: 12pt,
  note[#text(fill: ink, weight: "bold")[Partner API] \ Keys, quotes (capacity rounds down, charges round up, unknown data fails closed), obligations, decision timelines, policy versions, drills, evidence export. Public routes metered by *x402*. Route plans; HMAC-signed webhooks.],
  note[#text(fill: ink, weight: "bold")[SDK + app] \ One `wallet_sendCalls` batch: authorise, approve, add collateral, draw, swap to local money. Preconfirmation in 200 ms. The Boundline app is partner \#1.],
  note[#text(fill: ink, weight: "bold")[Console + agents] \ Obligations, timelines, policy editor, drills, reconciliation, evidence with the hash recomputed in the page. An *MCP* server: session, positions, shadow health, quote, protect, route.],
)
#v(10pt)
#text(size: 10.5pt, fill: ink2)[Live: #link("https://app.boundline.xyz")[app] · #link("https://console.boundline.xyz")[console] · #link("https://api.boundline.xyz/health")[API] · #link("https://agent.boundline.xyz/v1/tools")[agent]]
#pagebreak()

// ───────────────────────────────────────────── 10 · public goods
#head[public goods][MIT, deployed, usable by anyone without asking us.]
#tbl((auto, 1fr),
  [*Public good*], [*What anyone can do with it*],
  [B20 Credit Observatory], [read every Coinbase stock feed, session, registry flag, DEX gap and real Aave and Morpho position on Base, minute by minute, from an open JSON API],
  [`MarketCalendar` + `@boundline/calendar`], [ask onchain or in TypeScript which NYSE session any instant belongs to, holidays and early closes included],
  [`SessionGate`, `SessionGuard`, `ShadowGuard`], [list a Morpho market that refuses a frozen price; protect positions at a live price],
  [The weekend dataset], [two weekends recorded (9–11 Oct also captured live); rebuild any weekend's freeze and reopen from the chain (`scripts/reopen-evidence.py`, standard library only)],
  [The replay harness], [take real positions through weekend gaps on a fork and publish the result with a hash (first run 7 Oct; scheduled nightly in CI once the repository is public)],
)
#pagebreak()

// ───────────────────────────────────────────── 11 · business, team, ask
#head[business and ask][Fees on credit that already exists on Base.]
#grid(columns: (1fr, 1fr), column-gutter: 22pt,
  block[
    #text(font: mono, size: 8pt, fill: coral, tracking: 1.6pt)[MODEL]
    #v(3pt)
    #text(size: 10.5pt)[Platform fee per partner · 20–50 bps on originations · 10–25 bps a year on protected notional · x402-metered API · Reserve advance fees and the pre-liquidation incentive to capital providers.]
    #v(8pt)
    #text(font: mono, size: 8pt, fill: coral, tracking: 1.6pt)[TEAM]
    #v(3pt)
    #text(size: 10.5pt)[Farseen Shaikh, incoming MSc Data Science, TU Berlin · #todo[second developer, one line each]]
    #v(3pt)
    #text(size: 9.5pt, fill: ink2)[113 commits from 3 to 13 Oct, 264 Foundry + 898 TypeScript tests, eight mainnet-fork suites, eight services live, the footprint on Base mainnet.]
  ],
  block[
    #text(font: mono, size: 8pt, fill: coral, tracking: 1.6pt)[THE ASK]
    #v(3pt)
    #text(size: 15pt, weight: "bold")[\$1M seed, 12 months]
    #v(3pt)
    #text(size: 10.5pt)[40% engineering · 20% legal and structure · 15% security (two audits) · 15% capital and partnerships (seed the Reserve) · 10% go-to-market]
    #v(8pt)
    #text(font: mono, size: 8pt, fill: coral, tracking: 1.6pt)[MILESTONES]
    #v(3pt)
    #text(size: 10.5pt)[Three design partners live on mainnet · \$5M protected notional · the oracle adopted by a curator · a third venue]
    #v(8pt)
    #text(font: mono, size: 8pt, fill: coral, tracking: 1.6pt)[VALIDATION]
    #v(3pt)
    #text(size: 10.5pt)[\$1.73M of stock-backed debt on Aave V4's stock spoke alone sits on a feed that freezes every weekend. #todo[conversations, opt-ins]]
  ],
)
#pagebreak()

// ───────────────────────────────────────────── 12 · links
#v(14mm)
#lockup(40pt)
#v(10pt)
#text(size: 14pt, fill: ink2)[Never liquidated while Wall Street is closed.]
#v(12pt)
#tbl((auto, 1fr),
  [*Observatory*], [#link("https://observatory.boundline.xyz")],
  [*App*], [#link("https://app.boundline.xyz")],
  [*Console*], [#link("https://console.boundline.xyz")],
  [*Site*], [#link("https://boundline.xyz")],
  [*Code*], [#todo[public GitHub URL] · MIT],
  [*Every claim*], [`docs/submission/SUBMISSION.md` → evidence index; `deployments/base-sepolia.json`],
)
