import argon2 from 'argon2';

// argon2 is a native addon (prebuilt N-API binary, not pure JS) — worth a
// flag now for M7: esbuild (netlify.toml's configured bundler) needs the
// binary marked external or it can fail to bundle/run correctly on
// Netlify Functions. Confirm this works in the M7 preview deploy before
// launch; it's exactly the kind of thing that's invisible until then.
//
// Spec §3: "argon2 password hashing." argon2's own defaults (argon2id,
// its recommended memory/time cost) are used deliberately rather than
// tuned — this app runs on serverless functions where every cold start
// pays the hashing cost fresh, so a heavier profile has a real latency
// cost with no corresponding benefit for this threat model.
export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    // A malformed/foreign hash format throws rather than returning false —
    // treat that the same as a wrong password rather than a 500.
    return false;
  }
}
