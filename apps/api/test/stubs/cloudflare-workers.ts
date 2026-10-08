// The slice of `cloudflare:workers` the API imports, for vitest in Node (the real module exists only in workerd).
export class WorkerEntrypoint<Env = unknown> {
  protected ctx: ExecutionContext;
  protected env: Env;
  constructor(ctx: ExecutionContext, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
