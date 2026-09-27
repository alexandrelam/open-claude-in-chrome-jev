import { createSession, planClick, planDrag, planType, planKey, sampleInBox } from "../extension/humanize/index.ts";
import type { Session, Step } from "../extension/humanize/index.ts";
let fail = 0;
const ok = (c: unknown, m: string) => {
  console.log((c ? "  PASS " : "  FAIL ") + m);
  if (!c) fail++;
};

type StepOf<K extends Step["k"]> = Extract<Step, { k: K }>;
/** The steps of one kind, typed as that kind. */
const only = <K extends Step["k"]>(plan: Step[], k: K) => plan.filter((p): p is StepOf<K> => p.k === k);
/** The longest sleep between a keydown and its keyup: how long a key was held. */
const maxHoldOf = (plan: Step[]): number => {
  let max = 0;
  plan.forEach((step, i) => {
    if (step.k !== "kdown") return;
    for (const next of plan.slice(i + 1)) {
      if (next.k === "sleep") max = Math.max(max, next.ms);
      if (next.k === "kup") break;
    }
  });
  return max;
};

console.log("== INVARIANT: click always lands exactly on target ==");
let landedAll = true;
const uniquePts = new Set<string>(),
  pathLens = new Set<number>();
for (let i = 0; i < 300; i++) {
  const s = createSession(i);
  const from = { x: 50 + i, y: 60 },
    to = { x: 700, y: 420 };
  const plan = planClick(s, from, to);
  const downs = only(plan, "down"),
    ups = only(plan, "up");
  const moves = only(plan, "move");
  if (downs[0].x !== to.x || downs[0].y !== to.y) landedAll = false;
  if (ups[0].x !== to.x || ups[0].y !== to.y) landedAll = false;
  if (moves.length) uniquePts.add(moves[Math.floor(moves.length / 2)].x + ":" + moves[Math.floor(moves.length / 2)].y);
  pathLens.add(moves.length);
}
ok(landedAll, "300 clicks all press+release exactly on the target point");
ok(uniquePts.size > 250, `paths are highly varied (${uniquePts.size}/300 distinct midpoints)`);
ok(pathLens.size > 8, `path length varies (${pathLens.size} distinct point counts)`);

console.log("== movement precedes every click ==");
{
  const s = createSession(7);
  const plan = planClick(s, { x: 10, y: 10 }, { x: 400, y: 300 });
  const firstDown = plan.findIndex((p) => p.k === "down");
  const movesBefore = plan.slice(0, firstDown).filter((p) => p.k === "move").length;
  ok(movesBefore >= 5, `${movesBefore} move events dispatched before the press`);
}

console.log("== double_click = 2 distinct press/release cycles ==");
{
  const s = createSession(3);
  const plan = planClick(s, { x: 0, y: 0 }, { x: 100, y: 100 }, { clickCount: 2 });
  ok(
    plan.filter((p) => p.k === "down").length === 2 && plan.filter((p) => p.k === "up").length === 2,
    "two down + two up (not one flagged event)",
  );
}

console.log("== INVARIANT: typed text is EXACTLY the input, once ==");
{
  let allExact = true;
  const samples = ["hello world", "OCIC-TEST-DO-NOT-SUBMIT", "a@b.co, x!", "Ünïcødé 😀 中文"];
  for (const t of samples)
    for (let i = 0; i < 40; i++) {
      const s = createSession(i);
      const out = only(planType(s, t), "text")
        .map((p) => p.text)
        .join("");
      if (out !== t) {
        allExact = false;
        console.log("   mismatch:", JSON.stringify(out));
      }
    }
  ok(allExact, "text reassembles byte-identical across 160 runs incl. unicode/emoji");
}

console.log("== typing: key events paired, no autoRepeat, dwell under threshold ==");
{
  const s = createSession(11);
  const plan = planType(s, "hello");
  const kd = only(plan, "kdown"),
    ku = only(plan, "kup");
  ok(kd.length === ku.length && kd.length === 5, `5 keydown + 5 keyup for 5 chars (got ${kd.length}/${ku.length})`);
  ok(!kd.some((p) => p.autoRepeat), "no autoRepeat during normal typing");
  // dwell = sleep between kdown and its kup
  const maxDwell = maxHoldOf(plan);
  ok(
    maxDwell < s.tm.initialDelayMs,
    `max key hold ${Math.round(maxDwell)}ms < typematic initial delay ${Math.round(s.tm.initialDelayMs)}ms (so no repeat is FAITHFUL)`,
  );
  ok(
    kd.every((p) => p.code && p.code.length),
    "every keydown carries a real code",
  );
}

console.log("== unmappable chars fall back to insertText only ==");
{
  const s = createSession(5);
  const plan = planType(s, "😀中");
  ok(
    plan.filter((p) => p.k === "kdown").length === 0 && plan.filter((p) => p.k === "text").length === 2,
    "emoji/CJK: no fabricated keystrokes, text still inserted",
  );
}

console.log("== deliberate long hold renders OS auto-repeat ==");
{
  const s = createSession(9);
  const plan = planKey(s, { key: "Backspace", code: "Backspace", keyCode: 8, holdMs: 1200 });
  const reps = only(plan, "kdown").filter((p) => p.autoRepeat).length;
  ok(reps > 10, `${reps} autoRepeat keydowns emitted for a 1.2s hold`);
  ok(plan.filter((p) => p.k === "kup").length === 1, "exactly one keyup closes the hold");
}
{
  const s = createSession(9);
  const plan = planKey(s, { key: "Enter", code: "Enter", keyCode: 13 });
  ok(
    plan.filter((p) => p.k === "kdown").length === 1 && !only(plan, "kdown").some((p) => p.autoRepeat),
    "a normal press does NOT repeat",
  );
}

// (No scroll invariant here any more: humanized scrolling was removed after
// two attempts changed where the page landed. The extension now issues the
// same single wheel event with or without humanization, so scroll equivalence
// holds by construction rather than by assertion.)

console.log("== sampleInBox stays inside the element ==");
{
  let inside = true;
  const s = createSession(2);
  const rect = { x: 100, y: 200, width: 60, height: 24 };
  const pts = new Set();
  for (let i = 0; i < 500; i++) {
    const p = sampleInBox(rect, s.rng, s.persona)!;
    pts.add(p.x + ":" + p.y);
    if (p.x < rect.x || p.x > rect.x + rect.width || p.y < rect.y || p.y > rect.y + rect.height) inside = false;
  }
  ok(inside, "500 samples all inside the box (never misses the target)");
  ok(pts.size > 40, `landing point varies (${pts.size} distinct points, not dead-centre every time)`);
}

console.log("== tiny target still safe ==");
{
  let inside = true;
  const s = createSession(4);
  const rect = { x: 10, y: 10, width: 8, height: 8 };
  for (let i = 0; i < 300; i++) {
    const p = sampleInBox(rect, s.rng, s.persona)!;
    if (p.x < rect.x || p.x > rect.x + rect.width || p.y < rect.y || p.y > rect.y + rect.height) inside = false;
  }
  ok(inside, "8x8px target: 300 samples all inside");
}

console.log("== drag: press at start, release at end, curve between ==");
{
  const s = createSession(6);
  const plan = planDrag(s, { x: 0, y: 0 }, { x: 100, y: 100 }, { x: 400, y: 250 });
  const d = only(plan, "down")[0],
    u = only(plan, "up")[0];
  ok(d.x === 100 && d.y === 100, "press exactly at start");
  ok(u.x === 400 && u.y === 250, "release exactly at end");
  const movesBetween = plan.slice(plan.indexOf(d), plan.indexOf(u)).filter((p) => p.k === "move").length;
  ok(movesBetween > 5, `${movesBetween} intermediate moves (not a straight 10-step line)`);
}

console.log("== sessions differ from one another (persona) ==");
{
  const a = createSession(),
    b = createSession();
  ok(
    a.persona.speed !== b.persona.speed || a.persona.typeTempo !== b.persona.typeTempo,
    "two sessions get different personas",
  );
}

// ---- speed tiers -----------------------------------------------------------
{
  const { createSession: mk, TEMPOS } = await import("../extension/humanize/index.ts");
  console.log("== speed tiers trade time for detail, never correctness ==");
  const dur = (plan: Step[]) => only(plan, "sleep").reduce((a, p) => a + p.ms, 0);
  const moves = (plan: Step[]) => only(plan, "move").length;
  const from = { x: 20, y: 20 },
    to = { x: 640, y: 400 };
  const rows = ["fastest", "fast", "natural", "relaxed"].map((tier) => {
    const s = mk(7, tier);
    const p = planClick(s, from, to);
    const d = only(p, "down"),
      u = only(p, "up");
    return { tier, ms: dur(p), moves: moves(p), landsOn: d[0].x === to.x && d[0].y === to.y && u[0].x === to.x };
  });
  for (const r of rows)
    console.log(`     ${r.tier.padEnd(11)} ${String(r.ms).padStart(5)}ms  ${String(r.moves).padStart(3)} moves`);
  const monotonic = rows.every((r, i) => i === 0 || rows[i - 1].ms < r.ms);
  ok(monotonic, "duration increases strictly across the four tiers, fastest -> relaxed");
  const movesMonotonic = rows.every((r, i) => i === 0 || rows[i - 1].moves <= r.moves);
  ok(movesMonotonic, "path sample count is non-decreasing across the tiers");
  ok(
    rows.every((r) => r.moves >= 3),
    `even the fastest tier MOVES before clicking (min ${Math.min(...rows.map((r) => r.moves))} samples, not zero)`,
  );
  ok(
    rows.every((r) => r.landsOn),
    "every tier still lands exactly on the target",
  );

  // typing text must stay byte-identical at every tier
  const txt = "user@example.com";
  ok(
    ["fastest", "fast", "natural", "relaxed"].every(
      (tier) =>
        only(planType(mk(3, tier), txt), "text")
          .map((p) => p.text)
          .join("") === txt,
    ),
    "typed text is byte-identical at every speed tier",
  );
  // and key hold must stay under the typematic threshold even when slowed down
  const sd = mk(3, "relaxed");
  const planD = planType(sd, "ab");
  const maxHold = maxHoldOf(planD);
  ok(
    maxHold < sd.tm.initialDelayMs,
    `slowest tier still holds keys under the typematic delay (${Math.round(maxHold)}ms < ${Math.round(sd.tm.initialDelayMs)}ms) — no accidental auto-repeat`,
  );
  ok(Object.keys(TEMPOS).length === 4, "four tiers exposed");

  // Typing cost is per CHARACTER, so a tier multiplier that is harmless on a
  // click compounds into seconds on a form field. Measured: a uniform 1.5x
  // tier typed 15 characters in 4.9s — slower than a tier already removed for
  // being unusable. The slow end of `keys` is therefore damped relative to
  // `time`, and this asserts that damping stays in place.
  const typeMs = (tier: string) => dur(planType(mk(5, tier), "Hello World 123"));
  const clickMs = (tier: string) => dur(planClick(mk(5, tier), { x: 20, y: 20 }, { x: 640, y: 400 }));
  const slowTypeRatio = typeMs("relaxed") / typeMs("natural");
  const slowClickRatio = clickMs("relaxed") / clickMs("natural");
  ok(
    slowClickRatio > slowTypeRatio,
    `the slowest tier slows MOTION more than TYPING (click x${slowClickRatio.toFixed(2)} vs type x${slowTypeRatio.toFixed(2)})`,
  );
  ok(
    typeMs("relaxed") < 3600,
    `slowest tier types 15 chars in ${typeMs("relaxed")}ms planned — stays under the ~4s line that got a tier cut`,
  );
  ok(
    typeMs("fastest") < typeMs("fast") && typeMs("fast") < typeMs("natural"),
    "typing still gets monotonically slower across the tiers",
  );
  // A default that costs a lot is a default nobody keeps.
  const { DEFAULT_TEMPO } = await import("../extension/humanize/index.ts");
  ok(DEFAULT_TEMPO === "fast", "the cheaper tier is the default");
}

// ---- a pinned seed makes the hand reproducible ------------------------------
{
  const { createSession: mk4 } = await import("../extension/humanize/index.ts");
  console.log("== humanize_seed pins the persona, so a comparison can be controlled ==");
  const hand = (s: Session) => JSON.stringify(s.persona);
  ok(hand(mk4(12345, "natural")) === hand(mk4(12345, "natural")), "same seed rebuilds an identical hand");
  ok(hand(mk4(12345, "natural")) !== hand(mk4(999, "natural")), "a different seed gives a different hand");
  // The hand must not depend on the tier, or a study varying only the speed
  // would silently be varying the operator too.
  ok(
    hand(mk4(12345, "fastest")) === hand(mk4(12345, "relaxed")),
    "the SAME seed gives the same hand at every speed tier — so tier is the only variable",
  );
  // And the same plan must reproduce exactly, not merely the persona.
  const planOf = (t: string) => JSON.stringify(planClick(mk4(777, t), { x: 5, y: 5 }, { x: 500, y: 300 }));
  ok(planOf("natural") === planOf("natural"), "a pinned seed reproduces the whole trajectory, not just the persona");
  ok(
    hand(mk4(undefined, "natural")) !== hand(mk4(undefined, "natural")),
    "with no seed, each session still draws its own hand (no shared signature)",
  );
}

// ---- device-like sampling cadence ------------------------------------------
{
  const { createSession: mk2 } = await import("../extension/humanize/index.ts");
  console.log("== cursor samples arrive on a steady clock, like a polling device ==");
  const gapsFor = (tier: string) => {
    const s = mk2(9, tier);
    const plan = planClick(s, { x: 20, y: 20 }, { x: 640, y: 420 });
    const g: number[] = [];
    plan.forEach((step, i) => {
      if (step.k === "sleep" && plan[i + 1]?.k === "move") g.push(step.ms);
    });
    return g;
  };
  const stat = (g: number[]) => {
    const m = g.reduce((a, b) => a + b, 0) / g.length;
    return { mean: m, sd: Math.sqrt(g.reduce((a, b) => a + (b - m) ** 2, 0) / g.length), n: g.length };
  };
  for (const tier of ["fastest", "fast", "natural", "relaxed"]) {
    const st = stat(gapsFor(tier));
    // A real mouse polls on a fixed clock; velocity lives in the SPACING of the
    // samples, not in varying the gaps. Irregular within-gesture timing is a
    // behavioural tell, so the interval must stay tight.
    ok(
      st.sd / st.mean < 0.25,
      `${tier}: sample interval is regular (mean ${st.mean.toFixed(1)}ms, sd ${st.sd.toFixed(2)}ms — ratio ${(st.sd / st.mean).toFixed(2)})`,
    );
  }
  const a = stat(gapsFor("fastest")),
    b = stat(gapsFor("fast")),
    c = stat(gapsFor("natural"));
  const d = stat(gapsFor("relaxed"));
  // Regression guard: a sample-count ceiling used to widen the interval on the
  // slowest tier (~12ms vs 8ms), making the tier change the apparent poll rate.
  ok(
    Math.abs(d.mean - c.mean) < 2,
    `the SLOWEST tier still reports at device cadence (${d.mean.toFixed(1)}ms vs ${c.mean.toFixed(1)}ms) — no widening from a sample cap`,
  );
  ok(
    Math.abs(a.mean - c.mean) < 2,
    `cadence does NOT change with the speed tier (${a.mean.toFixed(1)}ms vs ${c.mean.toFixed(1)}ms) — a device's poll rate is fixed`,
  );
  ok(
    a.n < b.n && b.n < c.n,
    `the tier changes the SAMPLE COUNT instead (${a.n} < ${b.n} < ${c.n}), which is how a real device encodes a longer movement`,
  );
}

console.log(fail === 0 ? "\nALL HUMANIZE UNIT TESTS PASSED" : `\n${fail} TEST(S) FAILED`);
process.exit(fail ? 1 : 0);
