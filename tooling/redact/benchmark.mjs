import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { chromium } from "@playwright/test";

// Usage: node tooling/redact/benchmark.mjs <react snapshot> <redact snapshot> <results.json>
// Each snapshot contains dist/ and dist-prerender/. Public API fixtures isolate renderer work from backend latency.
const [reactDir, redactDir, output] = process.argv.slice(2);
assert(reactDir && redactDir && output, "Expected two build snapshots and an output JSON path");
const paths = ["/", "/ats-checker", "/auth/login"];
const mime = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml" };

async function sizes(directory) {
	const dist = join(directory, "dist");
	const html = await readFile(join(dist, "index.html"), "utf8");
	const entries = [...html.matchAll(/(?:src|href)="(\/assets\/[^"\s]+\.js)"/g)].map((match) => match[1]);
	assert(entries.length > 0, "Missing browser JavaScript entries");
	const eager = new Set();
	async function visit(file) {
		if (eager.has(file)) return;
		eager.add(file);
		const code = await readFile(join(dist, file), "utf8");
		for (const match of code.matchAll(/(?:import|export)\s*(?:[^"';]*?\s*from\s*)?["'](\.[^"']+\.js)["']/g)) {
			await visit(`/assets/${match[1].replace(/^\.\//, "")}`);
		}
	}
	for (const entry of entries) await visit(entry);
	const all = (await readdir(join(dist, "assets"))).filter((file) => file.endsWith(".js"));
	const sum = async (files) => {
		const contents = await Promise.all(files.map((file) => readFile(join(dist, file))));
		return {
			raw: contents.reduce((total, bytes) => total + bytes.length, 0),
			gzip: contents.reduce((total, bytes) => total + gzipSync(bytes).length, 0),
			files: files.length,
		};
	};
	return { eager: await sum([...eager]), all: await sum(all.map((file) => `/assets/${file}`)) };
}

async function serve(directory) {
	const dist = resolve(directory, "dist");
	const server = createServer(async (request, response) => {
		try {
			const url = new URL(request.url, "http://localhost");
			const { pathname } = url;
			const fixture = (path) => {
				if (path === "/api/auth/get-session") return null;
				if (path === "/api/rpc/auth/providers/list") return { json: [] };
				if (path === "/api/rpc/statistics/github/getStarCount") return { json: 40000 };
				if (path === "/api/rpc/statistics/getTotals")
					return { json: { users: 1000000, resumes: 2000000, cachedAt: null } };
				if (path !== "/api/rpc/flags/get") throw new Error(`Unmocked API: ${path}`);
				return {
					json: {
						disableSignups: false,
						disableEmailAuth: false,
						allowGuestLogin: false,
						smtpEnabled: false,
						careerSchedulingEnabled: false,
						appUrl: `http://${request.headers.host}`,
						customDomains: false,
						olacvSuggestion: false,
					},
				};
			};
			if (pathname.startsWith("/api/")) {
				const chunks = [];
				for await (const chunk of request) chunks.push(chunk);
				const batch = url.searchParams.get("batch") ?? Buffer.concat(chunks).toString();
				const json = pathname.endsWith("/__batch__")
					? JSON.parse(batch).map((item, index) => ({
							index,
							status: 200,
							body: fixture(new URL(item.url).pathname),
						}))
					: fixture(pathname);
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify(json));
				return;
			}
			const page = pathname === "/" ? "home" : pathname === "/ats-checker" ? "ats-checker" : undefined;
			const file = page
				? resolve(directory, "dist-prerender", page, "en-US.html")
				: extname(pathname)
					? resolve(dist, `.${pathname}`)
					: join(dist, "index.html");
			assert(file.startsWith(`${resolve(directory)}${sep}`), "Path outside snapshot");
			const content = gzipSync(await readFile(file));
			response.writeHead(200, {
				"content-type": mime[extname(file)] ?? "application/octet-stream",
				"content-encoding": "gzip",
				"content-length": content.length,
				"cache-control": "no-store",
			});
			response.end(content);
		} catch (error) {
			console.error(error);
			response.writeHead(500);
			response.end(String(error));
		}
	});
	await new Promise((done) => server.listen(0, "127.0.0.1", done));
	return { server, url: `http://127.0.0.1:${server.address().port}` };
}

const builds = {};
const browser = await chromium.launch();
const samples = [];
try {
	for (const [name, directory] of Object.entries({ react: reactDir, redact: redactDir })) {
		const size = await sizes(directory);
		builds[name] = { ...(await serve(directory)), sizes: size };
	}
	for (let round = -1; round < 10; round++) {
		// Alternate renderer order; one discarded warm-up per route/runtime, then ten cold-context samples each.
		for (const name of round % 2 === 0 ? ["react", "redact"] : ["redact", "react"]) {
			for (const path of paths) {
				const context = await browser.newContext({ reducedMotion: "reduce", colorScheme: "light", locale: "en-US" });
				try {
					const page = await context.newPage();
					const errors = [];
					page.on("pageerror", (error) => errors.push(error.message));
					page.on("response", (response) => {
						if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
					});
					await page.route("**/*", (route) =>
						route.request().url().startsWith(builds[name].url) ? route.continue() : route.abort(),
					);
					await page.addInitScript(() => {
						document.addEventListener(
							"load",
							(event) => {
								if (event.target instanceof HTMLScriptElement && event.target.type === "module")
									window.entryEvaluatedMs = performance.now();
							},
							true,
						);
					});
					const cdp = await context.newCDPSession(page);
					await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
					await cdp.send("Performance.enable");
					await page.goto(`${builds[name].url}${path}`, { waitUntil: "load" });
					await page.waitForFunction(() => window.entryEvaluatedMs > 0);
					assert.deepEqual(errors, [], `${name} ${path}: initial browser errors`);
					if (path === "/auth/login") {
						await page.getByLabel("Email address", { exact: true }).fill("benchmark@example.test");
					} else {
						await page
							.getByRole("button", { name: /^Switch to dark (?:theme|mode)$/ })
							.first()
							.click();
						await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
					}
					const timing = await page.evaluate(() => ({
						entryEvaluatedMs: window.entryEvaluatedMs,
						fcpMs: performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null,
					}));
					const { metrics } = await cdp.send("Performance.getMetrics");
					const metric = (key) => metrics.find((item) => item.name === key)?.value;
					assert.deepEqual(errors, [], `${name} ${path}: browser errors`);
					assert(timing.entryEvaluatedMs > 0);
					assert(timing.fcpMs > 0, "Missing first-contentful-paint measurement");
					assert(Number.isFinite(metric("ScriptDuration")), "Missing script-duration measurement");
					if (round >= 0) samples.push({ name, path, round, ...timing, scriptMs: metric("ScriptDuration") * 1000 });
				} finally {
					await context.close();
				}
			}
		}
		console.log(`Completed round ${round + 1}/10`);
	}
	const median = (values) => {
		const sorted = values.toSorted((a, b) => a - b);
		return (sorted[4] + sorted[5]) / 2;
	};
	const summary = paths.map((path) => ({
		path,
		...Object.fromEntries(
			Object.keys(builds).map((name) => {
				const subset = samples.filter((sample) => sample.name === name && sample.path === path);
				assert.equal(subset.length, 10);
				return [
					name,
					Object.fromEntries(
						["entryEvaluatedMs", "fcpMs", "scriptMs"].map((key) => [key, median(subset.map((sample) => sample[key]))]),
					),
				];
			}),
		),
	}));
	const result = {
		date: new Date().toISOString(),
		node: process.version,
		browser: browser.version(),
		cpuThrottle: 4,
		network: "Loopback, gzip, no simulated network latency; public APIs stubbed; external requests blocked",
		sizes: Object.fromEntries(Object.entries(builds).map(([name, build]) => [name, build.sizes])),
		summary,
		samples,
	};
	await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
	console.log(JSON.stringify({ sizes: result.sizes, summary }, null, 2));
} finally {
	await browser.close();
	for (const { server } of Object.values(builds)) await new Promise((done) => server.close(done));
}
