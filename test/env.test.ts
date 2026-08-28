import { beforeEach, describe, expect, test } from "bun:test"
import {
  bobOrigin,
  bobWebLoginUrl,
  envBool,
  envCsv,
  npmPackage,
  parseApi,
  providerBaseUrl,
  requestBaseUrl,
  routingHeaders,
} from "../src/env.ts"
import { resetEnv } from "./helpers.ts"

beforeEach(resetEnv)

describe("endpoint configuration", () => {
  test("defaults to the documented Bob endpoint", () => {
    expect(providerBaseUrl()).toBe("https://api.us-east.bob.ibm.com/inference/v1")
    expect(bobOrigin()).toBe("https://api.us-east.bob.ibm.com")
    expect(requestBaseUrl("openai-completions")).toBe("https://api.us-east.bob.ibm.com/inference/v1")
    expect(requestBaseUrl("anthropic-messages")).toBe("https://api.us-east.bob.ibm.com/inference/v1")
  })

  test("trims trailing slashes from IBM_BOB_BASE_URL", () => {
    process.env.IBM_BOB_BASE_URL = "https://bob.example/inference/v1//"
    expect(providerBaseUrl()).toBe("https://bob.example/inference/v1")
    expect(bobOrigin()).toBe("https://bob.example")
  })

  test("maps the non-production hosts to their web login pages", () => {
    expect(bobWebLoginUrl()).toBe("https://bob.ibm.com/login")

    process.env.IBM_BOB_BASE_URL = "https://api.dev.bob.ibm.com/inference/v1"
    expect(bobWebLoginUrl()).toBe("https://public-dev.bob.ibm.com/login")

    process.env.IBM_BOB_BASE_URL = "https://api.qa-test.bob.ibm.com/inference/v1"
    expect(bobWebLoginUrl()).toBe("https://qa.bob.ibm.com/login")

    process.env.IBM_BOB_WEB_LOGIN_URL = "https://bob.internal/login"
    expect(bobWebLoginUrl()).toBe("https://bob.internal/login")
  })
})

describe("adapter selection", () => {
  test("defaults to Bob's OpenAI-compatible route", () => {
    expect(parseApi()).toBe("openai-completions")
    expect(npmPackage(parseApi())).toBe("@ai-sdk/openai-compatible")
  })

  test("supports the Anthropic and Responses adapters", () => {
    process.env.IBM_BOB_API = "anthropic-messages"
    expect(npmPackage(parseApi())).toBe("@ai-sdk/anthropic")

    process.env.IBM_BOB_API = "openai-responses"
    expect(npmPackage(parseApi())).toBe("@ai-sdk/openai")
  })

  test("falls back to openai-completions for an unknown adapter", () => {
    process.env.IBM_BOB_API = "nonsense"
    expect(parseApi()).toBe("openai-completions")
  })

  test("IBM_BOB_NPM overrides the adapter package", () => {
    process.env.IBM_BOB_NPM = "@ai-sdk/openai-compatible"
    process.env.IBM_BOB_API = "anthropic-messages"
    expect(npmPackage(parseApi())).toBe("@ai-sdk/openai-compatible")
  })
})

describe("routing headers", () => {
  test("only sends the headers that are configured", () => {
    expect(routingHeaders({})).toEqual({ "User-Agent": expect.stringContaining("opencode-ibm-bob/") })

    process.env.IBM_BOB_INSTANCE_ID = "instance-1"
    process.env.IBM_BOB_TEAM_ID = "team-1"
    expect(routingHeaders({})).toMatchObject({ "x-instance-id": "instance-1", "x-team-id": "team-1" })
  })

  test("environment overrides win over the Bob Shell settings", () => {
    expect(routingHeaders({ instanceId: "from-settings" })["x-instance-id"]).toBe("from-settings")

    process.env.IBM_BOB_INSTANCE_ID = "from-env"
    expect(routingHeaders({ instanceId: "from-settings" })["x-instance-id"]).toBe("from-env")
  })

  test("merges IBM_BOB_HEADERS_JSON and ignores malformed values", () => {
    process.env.IBM_BOB_HEADERS_JSON = '{"x-extra":"1","x-bad":2}'
    expect(routingHeaders({})).toMatchObject({ "x-extra": "1" })
    expect(routingHeaders({})["x-bad"]).toBeUndefined()

    process.env.IBM_BOB_HEADERS_JSON = "not json"
    expect(routingHeaders({})["x-extra"]).toBeUndefined()
  })
})

test("environment parsing helpers accept the documented spellings", () => {
  process.env.IBM_BOB_DISCOVER_MODELS = "OFF"
  expect(envBool("IBM_BOB_DISCOVER_MODELS", true)).toBe(false)

  process.env.IBM_BOB_DISCOVER_MODELS = "yes"
  expect(envBool("IBM_BOB_DISCOVER_MODELS", false)).toBe(true)

  process.env.IBM_BOB_DISCOVER_MODELS = "maybe"
  expect(envBool("IBM_BOB_DISCOVER_MODELS", true)).toBe(true)

  process.env.IBM_BOB_MODELS = " , "
  expect(envCsv("IBM_BOB_MODELS", ["premium"])).toEqual(["premium"])
})
