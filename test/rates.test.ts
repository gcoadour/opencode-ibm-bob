import { beforeEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { BobRates, rateCacheFile, readCachedRates, sanitizeRateSums, solveRate } from "../src/rates.ts"
import { resetEnv } from "./helpers.ts"

beforeEach(resetEnv)

/** Feeds observations priced exactly like Bob prices them. */
function observe(rates: BobRates, model: string, input: number, output: number, inRate: number, outRate: number) {
  rates.record(model, input, output, (input * inRate + output * outRate) / 1e6)
}

describe("solveRate", () => {
  test("recovers a flat rate, the shape premium and ultra use", () => {
    const rates = new BobRates()
    observe(rates, "premium", 12, 4, 2, 2)
    observe(rates, "premium", 23, 123, 2, 2)

    const rate = rates.rate("premium")
    expect(rate?.input).toBeCloseTo(2, 6)
    expect(rate?.output).toBeCloseTo(2, 6)
    expect(rate?.samples).toBe(2)
  })

  test("separates input and output rates, the shape fast and explorer use", () => {
    const rates = new BobRates()
    observe(rates, "fast", 12, 4, 0.8, 0.84)
    observe(rates, "fast", 23, 123, 0.8, 0.84)
    observe(rates, "fast", 400, 10, 0.8, 0.84)

    const rate = rates.rate("fast")
    expect(rate?.input).toBeCloseTo(0.8, 3)
    expect(rate?.output).toBeCloseTo(0.84, 3)
  })

  test("falls back to a blended rate on a single observation", () => {
    const rates = new BobRates()
    observe(rates, "premium", 12, 4, 2, 2)

    const rate = rates.rate("premium")
    expect(rate?.input).toBeCloseTo(2, 6)
    expect(rate?.output).toBeCloseTo(2, 6)
    expect(rate?.samples).toBe(1)
  })

  test("falls back to a blended rate when every observation has the same shape", () => {
    const rates = new BobRates()
    // Proportional observations leave the two unknowns indistinguishable.
    observe(rates, "premium", 10, 10, 2, 2)
    observe(rates, "premium", 20, 20, 2, 2)

    const rate = rates.rate("premium")
    expect(rate?.input).toBeCloseTo(2, 6)
    expect(rate?.output).toBeCloseTo(2, 6)
  })

  test("reports a free model as free", () => {
    const rates = new BobRates()
    observe(rates, "granite-8b-code-instruct", 30, 40, 0, 0)
    expect(rates.rate("granite-8b-code-instruct")).toEqual({ input: 0, output: 0, samples: 1 })
  })

  test("never returns a negative rate, which rounding noise can otherwise produce", () => {
    const rates = new BobRates()
    // Credits rounded to six decimals can make the exact fit go negative.
    rates.record("fast", 12, 4, 0.000013)
    rates.record("fast", 13, 4, 0.000013)
    rates.record("fast", 14, 4, 0.000013)
    const rate = rates.rate("fast")
    expect(rate!.input).toBeGreaterThanOrEqual(0)
    expect(rate!.output).toBeGreaterThanOrEqual(0)
  })

  test("ignores a response with no tokens", () => {
    const rates = new BobRates()
    rates.record("premium", 0, 0, 0.5)
    expect(rates.rate("premium")).toBeUndefined()
  })

  test("keeps models apart", () => {
    const rates = new BobRates()
    observe(rates, "premium", 12, 4, 2, 2)
    observe(rates, "fast", 12, 4, 0.8, 0.8)

    expect(rates.rate("premium")?.input).toBeCloseTo(2, 6)
    expect(rates.rate("fast")?.input).toBeCloseTo(0.8, 6)
    expect(Object.keys(rates.all())).toEqual(["premium", "fast"])
  })

  test("returns nothing without an observation", () => {
    expect(solveRate({ n: 0, in: 0, out: 0, credits: 0, inIn: 0, inOut: 0, outOut: 0, inCredits: 0, outCredits: 0 })).toBeUndefined()
  })
})

describe("rate cache", () => {
  test("round-trips the learned rates through disk", () => {
    const rates = new BobRates()
    observe(rates, "premium", 12, 4, 2, 2)
    observe(rates, "premium", 23, 123, 2, 2)
    rates.flush()

    expect(new BobRates().rate("premium")?.input).toBeCloseTo(2, 6)
    expect(JSON.parse(readFileSync(rateCacheFile(), "utf8")).origin).toBe("https://api.us-east.bob.ibm.com")
  })

  test("holds no credential", () => {
    const rates = new BobRates()
    observe(rates, "premium", 12, 4, 2, 2)
    rates.flush()
    const raw = readFileSync(rateCacheFile(), "utf8")
    expect(raw).not.toContain("Bearer")
    expect(raw).not.toContain("Apikey")
  })

  test("ignores rates learned against another origin", () => {
    const rates = new BobRates()
    observe(rates, "premium", 12, 4, 2, 2)
    rates.flush()

    process.env.IBM_BOB_BASE_URL = "https://bob.internal.example/inference/v1"
    expect(readCachedRates()).toBeUndefined()
  })

  test("writes nothing when nothing was learned", () => {
    new BobRates().flush()
    expect(() => readFileSync(rateCacheFile(), "utf8")).toThrow()
  })

  test("drops malformed cache entries", () => {
    expect(sanitizeRateSums({ premium: { n: "two" } })).toBeUndefined()
    expect(sanitizeRateSums({ premium: { n: 0, in: 0, out: 0, credits: 0, inIn: 0, inOut: 0, outOut: 0, inCredits: 0, outCredits: 0 } })).toBeUndefined()
    expect(sanitizeRateSums("nope")).toBeUndefined()
  })
})
