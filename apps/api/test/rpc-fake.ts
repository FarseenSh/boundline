// A JSON-RPC endpoint in a function: eth_call to Multicall3's aggregate3 is decoded call by call and answered by
// `answer(target, calldata)` (null = that call fails); any other eth_call goes to `answer` directly.
const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";
const w = (x: bigint | number) => BigInt(x).toString(16).padStart(64, "0");

export function word(x: bigint | number | boolean): string {
  return w(typeof x === "boolean" ? (x ? 1n : 0n) : x);
}
export function addr(a: string): string {
  return a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

function decodeAggregate3Calldata(data: string): { target: string; callData: string }[] {
  const d = data.slice(10); // selector
  const at = (i: number) => BigInt(`0x${d.slice(i * 64, i * 64 + 64)}`);
  const arr = Number(at(0)) / 32;
  const n = Number(at(arr));
  const out: { target: string; callData: string }[] = [];
  for (let i = 0; i < n; i += 1) {
    const elemWord = arr + 1 + Number(at(arr + 1 + i)) / 32;
    const target = `0x${d.slice(elemWord * 64 + 24, elemWord * 64 + 64)}`;
    const bytesWord = elemWord + Number(at(elemWord + 2)) / 32;
    const len = Number(at(bytesWord));
    out.push({ target, callData: `0x${d.slice((bytesWord + 1) * 64, (bytesWord + 1) * 64 + len * 2)}` });
  }
  return out;
}

function encodeAggregate3Return(results: { success: boolean; data: string }[]): string {
  const elems = results.map((r) => {
    const body = r.data.replace(/^0x/, "");
    const padded = body.padEnd(Math.ceil(body.length / 64) * 64, "0");
    return word(r.success) + word(0x40) + word(body.length / 2) + padded;
  });
  let offset = results.length * 32;
  const offsets: string[] = [];
  for (const e of elems) {
    offsets.push(word(offset));
    offset += e.length / 2;
  }
  return `0x${word(0x20)}${word(results.length)}${offsets.join("")}${elems.join("")}`;
}

export interface RpcLog {
  calls: { to: string; data: string }[];
}

export function fakeRpc(answer: (to: string, data: string) => string | null): typeof fetch & RpcLog {
  const log: RpcLog = { calls: [] };
  const f = (async (_url: unknown, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as { id: number; method: string; params: [{ to: string; data: string }, string] };
    if (req.method !== "eth_call") return Response.json({ jsonrpc: "2.0", id: req.id, error: { message: `unexpected ${req.method}` } });
    const { to, data } = req.params[0];
    if (to.toLowerCase() === MULTICALL3 && data.startsWith("0x82ad56cb")) {
      const inner = decodeAggregate3Calldata(data);
      for (const c of inner) log.calls.push({ to: c.target, data: c.callData });
      const results = inner.map((c) => {
        const out = answer(c.target, c.callData);
        return out === null ? { success: false, data: "0x" } : { success: true, data: out };
      });
      return Response.json({ jsonrpc: "2.0", id: req.id, result: encodeAggregate3Return(results) });
    }
    log.calls.push({ to, data });
    const out = answer(to, data);
    return out === null ? Response.json({ jsonrpc: "2.0", id: req.id, error: { message: "execution reverted" } }) : Response.json({ jsonrpc: "2.0", id: req.id, result: out });
  }) as unknown as typeof fetch & RpcLog;
  Object.assign(f, log);
  return f;
}
