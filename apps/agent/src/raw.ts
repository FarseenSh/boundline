// The hand-rolled Multicall3 and Morpho encoders live in @boundline/router's `./raw` subpath since 8 Oct 2026, so the
// agent and the partner API build route candidates from one copy. Re-exported here for the agent's own modules and tests.
export * from "@boundline/router/raw";
