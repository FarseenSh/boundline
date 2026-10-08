// topic0 of every event the indexer decodes, precomputed by scripts/gen-topics.ts (re-run it when an ABI changes;
// test/topics.test.ts fails until it is). A cold Workers isolate pays for every function it runs, and ~100 keccaks of
// event signatures at startup cost ~23 ms of interpreted CPU (node --jitless, 8 Oct 2026): this table makes them free.
import { toEventSelector, type AbiEvent, type AbiParameter, type Hex } from "viem";

function typeOf(p: AbiParameter): string {
  if (p.type.startsWith("tuple")) {
    const comps = ("components" in p ? p.components : undefined) ?? [];
    return `(${comps.map(typeOf).join(",")})${p.type.slice("tuple".length)}`;
  }
  return p.type;
}

/** The canonical signature, e.g. `CreateMarket(bytes32,(address,address,address,address,uint256))`. */
export function eventSignature(item: AbiEvent): string {
  return `${item.name}(${item.inputs.map(typeOf).join(",")})`;
}

/** topic0 of an event: from the table, else hashed (only a new ABI that was not regenerated pays this). */
export function topic0Of(item: AbiEvent): Hex {
  return TOPIC0[eventSignature(item)] ?? toEventSelector(item);
}

export const TOPIC0: Readonly<Record<string, Hex>> = {
  "AccrueInterest(bytes32,uint256,uint256,uint256)": "0x9d9bd501d0657d7dfe415f779a620a62b78bc508ddc0891fbbd8b7ac0f8fce87",
  "AdvanceSettled(uint256,address,uint256,uint256,uint256,bytes32)": "0xb0b97aed550b5208edf9a053f96af2bfe63b22319d190e8b426f503665439f0c",
  "AdvanceTermsSet(uint256,uint16)": "0x8ea1ef176b7eceb1de4eb691b5d8025674de088d75209eef0ed988d793ca3dc4",
  "AdvancesDefunded(address,uint256)": "0x5dda18b2b9de4d8db75d2c8820f92fcd0964723fb64c1105ece62ccb89d56c65",
  "AdvancesFunded(address,uint256)": "0x602dc1fa6c44a08f0d137bde805ab9ca3b9cee547679081c28948e80f9c2ae03",
  "Allocated(address,uint256,uint256)": "0x9af9811abc6f1b9cf2234f8ed76daa9a577d4ffbbe0af66ec4b748cde6f4c39f",
  "AllowlistUpdated(uint64,address,bool,address[])": "0x18c46532f90187ba11e436e21da087b684801d7f0787f2043f26f079c91e9ef0",
  "Announcement(address,string,string,string)": "0xccebf8218a62875909564adef86a6f4df81503cb617221e793357d62f8e813f7",
  "AnswerUpdated(int256,uint256,uint256)": "0x0559884fd3a460db3073b7fc896cc77986f16e378210ded43186175bf646fc5f",
  "Approval(address,address,uint256)": "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925",
  "BlocklistUpdated(uint64,address,bool,address[])": "0x2ff63c102b1b9fd7f5d39f83039c5d6aaf50a414a4f2def2704e41be2628f1e3",
  "Borrow(bytes32,address,address,address,uint256,uint256)": "0x570954540bed6b1304a87dfe815a5eda4a648f7097a16240dcd85c9b5fd42a43",
  "Borrow(uint256,address,address,uint256,uint256)": "0xef18174796a5d2f91d51dc5e907a4d7867bbd6e800f6225168e0453d581d0dcd",
  "ClosureAdded(uint256,string)": "0xad78d64a88c6e2a69efd31c40427b8a1e9511020dc52973fd364b4247bb178b7",
  "CollateralAdded(uint256,address,uint256,bytes32)": "0x97934fba69278b85e160e7972da2f8c9b2628fad6bfb34ff811d347c591d43f2",
  "CollateralRecovered(uint256,address,address,uint256,uint256,bytes32)": "0x239c9209882e42b985fc9969cce0e7860602ec20daf614afe05c94285b92099a",
  "CollateralReturned(uint256,address,address,uint256,bytes32)": "0x168a4de5451bb0123c03ad9d79bf96cf03995f853ab38586c169ce4e944857d5",
  "CollateralWithdrawn(uint256,uint256,uint256,uint8,bytes32)": "0xb7288a25e5c5e7cda16ae31008fcae9875c254d5bffb0ee4c9980643aa32c45d",
  "CompositePolicyUpdated(uint64,address,uint64[])": "0x4ff6adaab31b0df87aa7b8b7320c52b8b3b5eede3bf28a6baaaa8b8b7e1d6363",
  "CooldownSet(uint64)": "0xd3c86bd8150fcc5f376375097a2a9b313bf89addc501ee368c9eebe117328497",
  "CreateMarket(bytes32,(address,address,address,address,uint256))": "0xac4b2400f169220b0c0afdde7a0b32e775ba727ea1cb30b35f935cdaab8683ac",
  "Decision(uint256,bytes32,bytes32,uint256)": "0x91ac2792286f6bd866988ffddc5fe744570a2fd2c2d4ea57de4ddcbe39caa38c",
  "Decision(uint256,bytes32,bytes32,uint256,uint256)": "0xc861118a6b3d6aa48f5151a81f1d07284165718bc4602c0e9462def029120d7c",
  "Deposit(address,address,uint256,uint256)": "0xdcbc1c05240f31ff3ad067ef1ee35ce4997762752e3a095284754544f4c709d7",
  "Drawn(uint256,uint256,uint256,uint8,bytes32)": "0x4e4a0710eb9228966f1795aceffa7df2831a2d5f4dc8a59e61d8ead0c6652ba3",
  "EarlyCloseAdded(uint256,string)": "0x4b56e6966d2d98aa31c5495864fa5c1efe9d3cae583809a725c62c4812759d77",
  "EndAnnouncement(string)": "0x96d64dafe2c790596430196b982ad1da3221cb3b0f4e6e2df77f2e4f71a90037",
  "FeedLocked(address,address)": "0x1f80b506baa7c2044f149e0b34f6fa2925fd1f368f45d08546fb8a7f9907049f",
  "FeedSet(address,address,uint8,uint32,uint32)": "0x931554854b97c1ddb191b63ead0c7092702acd9c5d0d109355dbe6d7f88d41cf",
  "FeesCollected(address,uint256)": "0x9dc46f23cfb5ddcad0ae7ea2be38d47fec07bb9382ec7e564efc69e036dd66ce",
  "FunderSet(address)": "0x7d67440b21021db158c71eb4df92fbf247b3abe76f714559c1ac9878d50649f2",
  "Harvested(address,uint256)": "0x121c5042302bae5fc561fbc64368f297ca60a880878e1e3a7f7e9380377260bf",
  "KeeperSet(address)": "0xdc3dba1d64dd67c0dc8b12621edd0c6ca4303a9073c3a8fcac38115e73d67b6b",
  "LineClosed(uint256,bytes32)": "0xc16aaeddc17b3c9620633ec46a9fd4bf38f820ee447f382d4ce9577e21bf448e",
  "LineHeld(uint256,bytes32,bytes32)": "0xc3aa7e82141c9871dbd1115caee111b917aaac3dffbce31b64a8339685243056",
  "LineOpened(uint256,bytes32,address,bytes32,uint32,bytes32)": "0x59a15166a40db847bc9a66a58de6fab8058090cd409d87e523c8fd03cb9be067",
  "LineReleased(uint256,bytes32)": "0x7ed469e7e58620a8fa141a1e562c414b240f5e302ae0bbacc208aec38ac8ac58",
  "Liquidate(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)": "0xa4946ede45d0c6f06a0f5ce92c9ad3b4751452d2fe0e25010783bcab57a67e41",
  "LiquidationCall(uint256,uint256,address,address,bool,uint256,uint256,(int256,int256,uint256),uint256,uint256,uint256)": "0x2a1f12d996f530f89d8038aa293f9fde81cac44b6dfd6225e3358d09b78a4a37",
  "ManagerSet(address)": "0x60a0f5b9f9e81e98216071b85826681c796256fe3d1354ecb675580fba64fa69",
  "MarketEnabled(bytes32,bool)": "0x8859cebcc73558fc4daa8565f5a9f47736c21833eccd85b53cba0c35f5fb5c3e",
  "MarketRegistered(bytes32,address,address,uint256)": "0xbc4fbbb5481ff57956822613b90dbf4a8421c5aaca8262b490cb2d216ac35e3b",
  "MultiplierSet(address,uint256)": "0xa185044c465594570d559aa5a73966e5857a9d65e7e8403f08f9ebbfe9f648d6",
  "MultiplierUpdated(uint256)": "0x4dbe4840d7465bd162f67814cea0b519567a2e0e578bcde61e7f4ced361e5a3d",
  "OraclePausedSet(address,bool)": "0xb028b2b0cd936414a4198867072f992a7b82ef1aca2f172097829179f1d15380",
  "OwnershipTransferStarted(address,address)": "0x38d16b8cac22d99fc7c124b9cd0de2d3fa1faef420bfe791d8c362d765e22700",
  "OwnershipTransferred(address,address)": "0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0",
  "PartnerAdminSet(bytes32,address)": "0xcc69a7d1ed311edf12bd9a65eccb89f0a09848ab13e1b22402ccb3d9b7653aca",
  "PartnerCreated(bytes32,address,address,uint128)": "0x8101beb4f526c4dc2c7bc31b0a29141dbb349f1773b26cdd1ad1d17848553ce7",
  "PartnerDeposited(bytes32,address,uint256)": "0x7bf40f4dc546985c171867cbd27b0a79e5e46f674c10130c0ae9daa60489a12f",
  "PartnerUpdated(bytes32,uint32)": "0xe6aeb1328d61cd3e0b2208745ce58c17b96495f59e6a88cfd6712263a509016a",
  "PartnerWithdrawn(bytes32,address,uint256)": "0xa506129af378414eda0f401b9350468f4a2d238cf8981fbba714cdf5ea91caf1",
  "Paused(address,uint8[])": "0x3e849708b13f20dd0b87a503523c305e7604cd7e8f855e7a5ebe21397dfd7146",
  "PausedSet(bool)": "0x40db37ff5c0bdc2c427fbb2078c8f24afea940abac0e3c23bb4ea3bf2da2b212",
  "Payout(address,address,address,address,uint256,uint256,address)": "0x75a62e9990c53fc2532806e60b21b3b057e81b7924bad4640e9a7dd0310d7005",
  "PolicyAdminStaged(uint64,address,address)": "0xdbf3b34a4c956c56ca05cd4b8f9293a4347ad61994445a4b89817d4a19561136",
  "PolicyAdminUpdated(uint64,address,address)": "0x98925cfb1bc09c5b43dd0dd56d3d95aa04fb3300927580cc588c3f5dd58c15e1",
  "PolicyCreated(uint64,address,uint8)": "0x718d87917f0c4cfd1263707ef0e77c656ed8d8bfaca06152bdb0b8094142ec27",
  "PolicyUpdated(bytes32,uint64,uint64)": "0x8b4790f7ff717fc8f60f07ae099e47ef318dc04b37ae98056b50a22b79056626",
  "Protected(uint256,address,address,uint256,uint256,uint256,uint256,uint256,bytes32)": "0xc4b3a4508e924fa58f0a37b501b77bde60055ac86a8223cf545f7699f58bbcd8",
  "Protected(uint256,address,bytes32,uint256,uint256,uint256,uint256,uint256,uint256,bytes32)": "0x77c9658efaabd30c7db7765c03b34d4d3c43ed1ecf857f582dd11f772478a169",
  "Recalled(address,uint256,uint256)": "0xb6c9dd40980db8a360781b7c43875340d84d5e329a3b8481fd919998e651e2e5",
  "RedeemRequestCancelled(address,uint256)": "0x046d3e17087d323298991516e3fdec36fe1204d6bff7fb6e2b8eca77b80a22ad",
  "RedeemRequested(address,uint256,uint64)": "0x2bce3b57cea92a28770fa711cdba92da74de3482a36af80eeb9a2bd9bbb910f3",
  "Repaid(uint256,address,uint256,bool,bytes32)": "0x00f28d06c7301cad9f59aa30d1857db847a3efb3a91ee5e9e17436a3d9a62b42",
  "Repay(bytes32,address,address,uint256,uint256)": "0x52acb05cebbd3cd39715469f22afbf5a17496295ef3bc9bb5944056c63ccaa09",
  "Repay(uint256,address,address,uint256,uint256,(int256,int256,uint256))": "0xd765a0263e8a360da8dd4fdb8c0dc5553adec12a96f29a462cdb45e5bea407dd",
  "RoleAdminChanged(bytes32,bytes32,bytes32)": "0xbd79b86ffe0ab8e8776151514217cd7cacd52c909f66475c3af44e129f0b00ff",
  "RoleGranted(bytes32,address,address)": "0x2f8788117e7eff1d82e926ec794901d17c78024a50270940304540a733656f0d",
  "RoleRevoked(bytes32,address,address)": "0xf6391f5c32d9c69d2a47ea670b442974b53935d1edc7fd64eb21e047a839171b",
  "RouteSet(address,address,bool)": "0x92e5f83964c231e93cc6533c41599af491ab7eefb1644b06758d9f049aa746b1",
  "Seized(address,address,address,uint256)": "0xa9aec5d8b86e2fa2fd6ac3af62f2622e3dfdab1967d4cbbb56a5df7d74cb887c",
  "SetAuthorization(address,address,address,bool)": "0xd5e969f01efe921d3f766bdebad25f0a05e3f237311f56482bf132d0326309c0",
  "SetUserPositionManager(address,address,bool)": "0x413bea992b9956f4f10f6c819bf7a6c8ed5baa119a2901fe221ae03171d52277",
  "SinkAdded(address)": "0xf785f9bb7b7198ebb04ce272223e3b28ea051c0e063850f926b3895a77a2c683",
  "SinkRemoved(address)": "0x8e4f69096d1bfe0e5365848d86b29c4ee26b6aab65e9fa11361c45133f896c9b",
  "Supply(bytes32,address,address,uint256,uint256)": "0xedf8870433c83823eb071d3df1caa8d008f12f6440918c20d75a3602cda30fe0",
  "Supply(uint256,address,address,uint256,uint256)": "0xd986db228cb1fe8392c5f45ff5f2c639b7db6cbd9ca7d1fe70b2de90c2c8c961",
  "SupplyCapUpdated(address,uint256,uint256)": "0x6d14f44808ce024f263432bc38d019a9951fbe674e9898b54844dbc8dc09c23a",
  "SupplyCollateral(bytes32,address,address,uint256)": "0xa3b9472a1399e17e123f3c2e6586c23e504184d504de59cdaa2b375e880c6184",
  "Swept(address,address,uint256)": "0x7b09c29f9106defeccc9ac3b823f3aad0b470d120e5df7aed033b5c43a4bf718",
  "TickerPolicySet(bytes32,address,bool,uint64,uint128,uint128,uint128,uint32)": "0x03bfc095feaedc4f092ba9f13206bc7069bdd422e538eb507bec2911ad4f39d3",
  "Transfer(address,address,uint256)": "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
  "UIMultiplierUpdateCancelled(uint256,uint256)": "0x883856335ba5f60c18b9817c4505d3c7d3f6223dcf39516b30c508c46a5e1cad",
  "UIMultiplierUpdated(uint256,uint256,uint256)": "0x2205df4534432b2f60654a3fdb48737ffdaf3e9edb1a498bd985bc026b15b055",
  "Unpaused(address,uint8[])": "0x086a815e5123cf1af5cb7a82f8b052bf96c622204c98b2f4f9782bf77f753c57",
  "UpdatePositionManager(address,bool)": "0x8e04e916c2b397f8ab1cf9a55e94728a44837b3751f72369339ad991d371edc4",
  "UserDeposited(address,address,uint256)": "0x850c6acf6de637840ba0b63d346a5ded6fe578532c565edb26a8d2c5db4f2680",
  "UserWithdrawn(address,uint256)": "0xe6b386172074b393dc04ed6cb1a352475ffad5dd8cebc76231a3b683141ea6fb",
  "UtilisationCapSet(uint16)": "0xd3c62c642e7633586a74c139037256ea177c67338e50605a6038994d1b42f3d1",
  "Withdraw(address,address,address,uint256,uint256)": "0xfbde797d201c681b91056529119e0b02407c7bb96a4a2c75c01fc9667232c8db",
  "Withdraw(bytes32,address,address,address,uint256,uint256)": "0xa56fc0ad5702ec05ce63666221f796fb62437c32db1aa1aa075fc6484cf58fbf",
  "Withdraw(uint256,address,address,uint256,uint256)": "0xfe7813e2866053d5c3938554e517b554fce6666a6561bed9eaa7419b29fa9b68",
  "WithdrawCollateral(bytes32,address,address,address,uint256)": "0xe80ebd7cc9223d7382aab2e0d1d6155c65651f83d53c8b9b06901d167e321142",
  "WrittenDown(address,uint256,uint256)": "0xe56e33fdb76edb56cc2c14ad259b1adc185fe6895715144e858c3fafdf35bf80",
  "YearLoaded(uint256,uint256,uint256,string)": "0x15f4ed1c8ef4a6becbf192c93066d326bed8afcb9216bb5926029ea5e16870f6",
};
