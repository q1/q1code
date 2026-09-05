#!/usr/bin/env node
/** Reproducible UI evidence using synthetic Clerk, identity, Prism and provider fixtures only. */
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const repo = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../..");
const web = NodePath.join(repo, "apps/web");
const output = process.env.Q1_IDENTITY_QA_OUTPUT
  ? NodePath.resolve(process.env.Q1_IDENTITY_QA_OUTPUT)
  : await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "q1-identity-qa-"));
const requireWeb = NodeModule.createRequire(NodePath.join(web, "package.json"));
const { chromium } = requireWeb("playwright");

// Vite loads these files itself. A clean worktree keeps local credentials out of fixture evidence.
for (const directory of [repo, web]) {
  for (const name of [".env", ".env.local", ".env.development", ".env.development.local"]) {
    try {
      await NodeFSP.access(NodePath.join(directory, name));
      throw new Error("Run browser QA in a clean checkout without local .env files.");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}
await NodeFSP.mkdir(output, { recursive: true });

const state = {
  offline: false,
  unpaired: false,
  holdStream: false,
  revoked: new Set(),
  strategy: "round-robin",
};
const metrics = {
  inferenceRequests: 0,
  cancelledStreams: 0,
  rejectedRequests: 0,
  routingWrites: 0,
};
const streams = new Map();
let webOrigin = "";
let fixtureOrigin = "";
let vite;
let viteLog;
let viteReady = false;
let browser;
let page;
const passed = [];
const pageErrors = [];
const environmentRequests = [];
const externalRequests = [];
const actorFor = (request) => {
  const header = request.headers.authorization;
  if (header === "Bearer fixture-member-session" || header === "Bearer msp1.member.signature")
    return "member";
  if (header === "Bearer fixture-admin-session" || header === "Bearer msp1.admin.signature")
    return "admin";
  return null;
};
const json = (response, status, value) => {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-prism-fallback-allowed": "false",
  });
  response.end(JSON.stringify(value));
};
const deny = (response, status) => {
  metrics.rejectedRequests += 1;
  json(response, status, {
    error: { code: status === 503 ? "authority_unavailable" : "access_denied" },
    prism: { fallbackAllowed: false },
  });
};
async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 262_144) throw new Error("Fixture request exceeded its limit.");
  }
  return JSON.parse(body);
}
const fixture = NodeHttp.createServer((request, response) => {
  void (async () => {
    const origin = request.headers.origin;
    if (origin && origin !== webOrigin) return deny(response, 403);
    if (origin) {
      response.setHeader("access-control-allow-origin", origin);
      response.setHeader("access-control-allow-methods", "GET, POST, PUT, OPTIONS");
      response.setHeader("access-control-allow-headers", "authorization, content-type, accept");
      response.setHeader("vary", "Origin");
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }
    const actor = actorFor(request);
    if (state.offline) return deny(response, 503);
    if (!actor) return deny(response, 401);
    if (state.revoked.has(actor)) return deny(response, 403);
    const pathname = new URL(request.url, fixtureOrigin).pathname;
    if (
      request.headers.authorization?.startsWith("Bearer msp1.") &&
      !["/prism/v1/status", "/v1/models", "/v1/chat/completions"].includes(pathname)
    )
      return deny(response, 403);
    const permissions = [
      "prism:inference",
      ...(actor === "admin"
        ? [
            "prism:routing:read",
            "prism:routing:write",
            "prism:accounts:read",
            "prism:accounts:write",
            "prism:instances:manage",
          ]
        : []),
    ];
    if (request.method === "GET" && pathname === "/v1/identity")
      return json(response, 200, {
        contractVersion: 1,
        subject: `fixture-${actor}`,
        sessionId: `fixture-session-${actor}`,
        role: actor === "admin" ? "global_admin" : "member",
        permissions,
        authorizationRevision: "fixture-revision",
        authorizationExpiresAt: Date.now() + 60_000,
      });
    if (request.method === "GET" && pathname === "/v1/prism/discovery")
      return json(response, 200, {
        contractVersion: 1,
        selectionRevision: 1,
        service: state.unpaired
          ? null
          : {
              serviceInstanceId: "fixture-prism",
              displayName: "Shared Prism",
              apiOrigin: fixtureOrigin,
              inferenceOrigin: fixtureOrigin,
              pairingRevision: 1,
              protocolVersion: 1,
              publicKey: "MCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
              status: "paired",
            },
      });
    if (request.method === "POST" && pathname === "/v1/prism/credentials") {
      const body = await readJson(request);
      if (
        state.unpaired ||
        body.serviceInstanceId !== "fixture-prism" ||
        body.pairingRevision !== 1
      )
        return deny(response, 403);
      return json(response, 200, {
        version: 1,
        tokenType: "Bearer",
        token: `msp1.${actor}.signature`,
        expiresAt: Date.now() + 850_000,
        serviceInstanceId: "fixture-prism",
        pairingRevision: 1,
      });
    }
    if (request.method === "GET" && pathname === "/prism/v1/status")
      return json(response, 200, {
        serviceInstanceId: "fixture-prism",
        pairingRevision: 1,
        authorization: "current",
        engineHealth: "unknown",
      });
    if (pathname === "/prism/v1/routing") {
      if (actor !== "admin") return deny(response, 403);
      if (request.method === "PUT") {
        let body = "";
        for await (const chunk of request) {
          body += chunk;
          if (body.length > 16_384) return deny(response, 400);
        }
        const { strategy } = JSON.parse(body);
        if (!["round-robin", "weighted-round-robin", "fill-first"].includes(strategy))
          return deny(response, 400);
        state.strategy = strategy;
        metrics.routingWrites += 1;
      } else if (request.method !== "GET") return deny(response, 405);
      return json(response, 200, { strategy: state.strategy });
    }
    if (request.method === "GET" && pathname === "/v1/models")
      return json(response, 200, {
        data: [
          { id: "claude-sonnet-4-6", account: "hidden-fixture-account@example.test" },
          { id: "gpt-5.4" },
        ],
      });
    if (request.method === "POST" && pathname === "/v1/chat/completions") {
      const body = await readJson(request);
      if (
        body.model !== "claude-sonnet-4-6" ||
        body.stream !== true ||
        body.messages?.[0]?.role !== "user"
      )
        return deny(response, 400);
      metrics.inferenceRequests += 1;
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        "x-prism-fallback-allowed": "false",
      });
      response.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "Prism is ready. Your prompt reached the paired service using inference access only." } }] })}\n\n`,
      );
      if (!state.holdStream) {
        response.end("data: [DONE]\n\n");
        return;
      }
      streams.set(response, actor);
      response.once("close", () => {
        if (streams.delete(response)) metrics.cancelledStreams += 1;
      });
      return;
    }
    return deny(response, 404);
  })().catch(() => {
    if (!response.headersSent) deny(response, 400);
    else response.destroy();
  });
});

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await NodeEvents.once(server, "listening");
  return server.address().port;
}
async function waitFor(check, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for fixture acceptance.");
}
async function bind(actor) {
  await page.evaluate(async (actor) => {
    const url = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .findLast((name) => name.includes("/src/fork/mic-identity/micIdentitySession.ts"));
    if (!url) throw new Error("Identity session module was not loaded.");
    const session = await import(url);
    const controls = {
      loaded: true,
      signIn: () => session.bindMicIdentitySession(async () => "fixture-member-session", controls),
      signOut: () => session.bindMicIdentitySession(undefined, controls),
    };
    session.bindMicIdentitySession(
      actor ? async () => `fixture-${actor}-session` : undefined,
      controls,
    );
  }, actor);
}
const photo = (name) => page.screenshot({ path: NodePath.join(output, name), fullPage: true });
async function closeOwnedResources() {
  await browser?.close();
  for (const response of streams.keys()) response.destroy();
  fixture.closeAllConnections();
  if (fixture.listening) await new Promise((resolve) => fixture.close(resolve));
  if (vite && vite.exitCode === null && vite.signalCode === null) {
    const stopped = NodeEvents.once(vite, "exit");
    vite.kill("SIGTERM");
    const force = setTimeout(() => vite.kill("SIGKILL"), 5000);
    await stopped;
    clearTimeout(force);
  }
  if (viteLog) await new Promise((resolve) => viteLog.end(resolve));
}

try {
  fixtureOrigin = `http://127.0.0.1:${await listen(fixture)}`;
  const reservation = NodeHttp.createServer();
  const port = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  webOrigin = `http://127.0.0.1:${port}`;
  viteLog = NodeFS.createWriteStream(NodePath.join(output, "vite.log"));
  vite = NodeChildProcess.spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
      import { createServer } from "vite";
      const server = await createServer();
      await server.listen();
      console.log("Q1_IDENTITY_QA_READY");
      server.printUrls();
      const stop = () => void server.close().then(() => process.exit(0));
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
    `,
    ],
    {
      cwd: web,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        CI: "1",
        T3CODE_SINGLE_ORIGIN_DEV: "1",
        T3CODE_BUNDLED_DEV: "0",
        HOST: "127.0.0.1",
        PORT: String(port),
        VITE_HOSTED_APP_URL: webOrigin,
        VITE_T3FORK_MIC_IDENTITY: "true",
        VITE_MIC_SC_AUTHORITY_URL: fixtureOrigin,
        VITE_MIC_SC_CLERK_PUBLISHABLE_KEY: `pk_test_${Buffer.from("fixture.clerk.example.test$").toString("base64")}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let readinessOutput = "";
  vite.stdout.on("data", (chunk) => {
    readinessOutput = (readinessOutput + chunk).slice(-1024);
    viteReady ||= readinessOutput.includes("Q1_IDENTITY_QA_READY");
  });
  vite.stdout.pipe(viteLog, { end: false });
  vite.stderr.pipe(viteLog, { end: false });
  await waitFor(async () => {
    if (vite.exitCode !== null || vite.signalCode !== null)
      throw new Error("The isolated Vite process exited. See vite.log.");
    if (!viteReady) return false;
    try {
      return (await fetch(webOrigin, { signal: AbortSignal.timeout(1000) })).ok;
    } catch {
      return false;
    }
  }, 120_000);
  browser = await chromium.launch({
    headless: true,
    ...(process.env.Q1_IDENTITY_QA_CHROMIUM
      ? { executablePath: process.env.Q1_IDENTITY_QA_CHROMIUM }
      : {}),
  });
  const context = await browser.newContext({
    viewport: { width: 1365, height: 1000 },
    colorScheme: "dark",
  });
  await context.route("**/*", (route) => {
    const origin = new URL(route.request().url()).origin;
    if (![webOrigin, fixtureOrigin].includes(origin)) {
      externalRequests.push(origin);
      return route.abort();
    }
    return route.continue();
  });
  page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith("/api/") || pathname === "/ws") environmentRequests.push(pathname);
  });
  await page.addInitScript(() => performance.setResourceTimingBufferSize(10_000));
  await page.route("**/src/fork/mic-identity/BrowserMicIdentity.tsx*", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: "export default function SyntheticClerkBoundary(){return null}",
    }),
  );
  await page.goto(`${webOrigin}/prism`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Your Prism connection" }).waitFor({ timeout: 60_000 });
  await bind(null);
  await photo("01-signed-out.png");
  await page.getByRole("button", { name: "Sign in to mic.sc", exact: true }).last().click();
  await page
    .getByRole("option", { name: "claude-sonnet-4-6", exact: true })
    .waitFor({ state: "attached", timeout: 30_000 });
  NodeAssert.equal(await page.getByLabel("Prism routing strategy").count(), 0);
  NodeAssert.equal(await page.getByText("hidden-fixture-account@example.test").count(), 0);
  const denied = await fetch(`${fixtureOrigin}/prism/v1/routing`, {
    headers: { authorization: "Bearer fixture-member-session" },
  });
  NodeAssert.equal(denied.status, 403);
  await page.getByLabel("Message to Prism").fill("How can I tell my Prism connection is working?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page
    .getByRole("region", { name: "Prism response" })
    .getByText(/Prism is ready/)
    .waitFor();
  await page.getByRole("button", { name: "Send", exact: true }).waitFor();
  await photo("02-member-inference.png");
  passed.push(
    "Synthetic sign-in, host discovery and ordinary inference; no management or account details",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await photo("03-mobile-inference.png");
  NodeAssert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
  );
  passed.push("Mobile viewport has no horizontal overflow");
  await page.setViewportSize({ width: 1365, height: 1000 });
  state.holdStream = true;
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await waitFor(() => streams.size === 1);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page.getByText("Response stopped.", { exact: true }).waitFor();
  await waitFor(() => metrics.cancelledStreams === 1);
  passed.push("Stop cancels the provider response without retry");
  state.holdStream = false;
  await bind("admin");
  await page.getByLabel("Prism routing strategy").waitFor();
  await page.getByLabel("Prism routing strategy").selectOption("fill-first");
  await page.getByText("Confirmed by Prism", { exact: true }).waitFor();
  NodeAssert.equal(state.strategy, "fill-first");
  NodeAssert.equal(metrics.routingWrites, 1);
  await photo("04-admin-routing.png");
  passed.push("Admin routing is acknowledged and read back");
  state.offline = true;
  await page.getByText("Offline", { exact: true }).waitFor({ timeout: 30_000 });
  NodeAssert.equal(await page.getByLabel("Prism routing strategy").isEnabled(), false);
  await photo("05-offline.png");
  passed.push("Offline retains last verified host and disables edits");
  state.offline = false;
  await page.getByRole("button", { name: "Check again", exact: true }).click();
  await page.getByText("Access verified", { exact: true }).waitFor();
  await bind("member");
  await page
    .getByRole("option", { name: "claude-sonnet-4-6", exact: true })
    .waitFor({ state: "attached" });
  state.holdStream = true;
  await page
    .getByLabel("Message to Prism")
    .fill("Keep this response open for revocation verification.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await waitFor(() => streams.size === 1);
  const beforeRevocation = metrics.inferenceRequests;
  state.revoked.add("member");
  for (const [response, actor] of streams)
    if (actor === "member") {
      streams.delete(response);
      response.end('event: error\ndata: {"error":{"code":"access_revoked"}}\n\n');
    }
  await page.getByRole("button", { name: "Stop", exact: true }).waitFor({ state: "hidden" });
  NodeAssert.equal(metrics.inferenceRequests, beforeRevocation);
  const rejected = await fetch(`${fixtureOrigin}/v1/models`, {
    headers: { authorization: "Bearer fixture-member-session" },
  });
  NodeAssert.equal(rejected.status, 403);
  await photo("06-revoked-stream.png");
  passed.push("Revocation ends active response, rejects new requests and never retries");
  state.revoked.clear();
  state.holdStream = false;
  state.unpaired = true;
  await bind("admin");
  await page.getByText("No paired host yet", { exact: true }).waitFor();
  await photo("07-unpaired-admin.png");
  passed.push("Unpaired administrators can reach host recovery");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("heading", { name: "Sign in to mic.sc", exact: true }).waitFor();
  NodeAssert.equal(await page.getByLabel("Prism routing strategy").count(), 0);
  NodeAssert.equal(await page.getByRole("region", { name: "Prism response" }).count(), 0);
  NodeAssert.deepEqual(environmentRequests, []);
  NodeAssert.deepEqual(externalRequests, []);
  NodeAssert.deepEqual(pageErrors, []);
  NodeAssert.deepEqual(await context.cookies(), []);
  passed.push(
    "Sign-out clears service data; hosted flow uses zero environment requests or cookies",
  );
  await NodeFSP.writeFile(
    NodePath.join(output, "results.json"),
    JSON.stringify(
      {
        evidence:
          "Real Chromium with source-owned synthetic Clerk, authority, gateway and provider fixtures; not live backend or real Clerk acceptance",
        passed,
        metrics,
        pageErrors,
        environmentRequests,
        externalRequests,
      },
      null,
      2,
    ),
  );
  await NodeFSP.rm(NodePath.join(output, "failure.json"), { force: true });
  await NodeFSP.rm(NodePath.join(output, "failure.png"), { force: true });
  console.log(`Passed ${passed.length} browser checks. Evidence: ${output}`);
} catch (error) {
  if (page) await photo("failure.png").catch(() => {});
  await NodeFSP.writeFile(
    NodePath.join(output, "failure.json"),
    JSON.stringify(
      { message: String(error), passed, pageErrors, environmentRequests, externalRequests },
      null,
      2,
    ),
  );
  process.exitCode = 1;
  console.error(`Browser QA failed. Inspect ${output}.`);
} finally {
  await closeOwnedResources();
}
