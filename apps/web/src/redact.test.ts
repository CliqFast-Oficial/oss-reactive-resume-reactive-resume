import type { Plugin } from "vite-plus";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { loadConfigFromFile } from "vite-plus";

const configFile = fileURLToPath(new URL("../vite.config.ts", import.meta.url));
const appFile = fileURLToPath(new URL("./main.tsx", import.meta.url));
const pdfFile = fileURLToPath(new URL("../../../packages/pdf/src/forme/reconciler.ts", import.meta.url));

async function config(mode: string) {
	const loaded = await loadConfigFromFile({ command: "build", mode }, configFile);
	if (!loaded) throw new Error("Web Vite configuration did not load");
	const plugins = loaded.config.plugins?.flat(3).filter((plugin) => plugin && "name" in plugin) as Plugin[];
	return { config: loaded.config, plugins };
}

describe("Redact integration", () => {
	it("keeps normal production builds on native React", async () => {
		const { config: resolved, plugins } = await config("production");
		expect(plugins.some((plugin) => plugin.name.startsWith("redact"))).toBe(false);
		expect(resolved.ssr?.noExternal).toBeUndefined();
	});

	it("isolates the PDF dispatcher and compiler runtime from the web renderer", async () => {
		const { config: resolved, plugins } = await config("redact");
		const plugin = plugins.find((plugin) => plugin.name === "redact-with-native-pdf");
		expect(typeof plugin?.resolveId).toBe("function");
		const resolveId = plugin?.resolveId as (source: string, importer: string) => string | undefined;
		const webRequire = createRequire(appFile);
		const pdfRequire = createRequire(pdfFile);
		for (const source of ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "react/compiler-runtime"]) {
			expect(resolveId(source, appFile)).toBe(webRequire.resolve(source.replace(/^react/, "@tanstack/redact")));
			expect(resolveId(source, pdfFile)).toBe(pdfRequire.resolve(source));
		}
		const reconciler = pdfRequire.resolve("react-reconciler");
		expect(resolveId("react", reconciler)).toBe(createRequire(reconciler).resolve("react"));
		expect(resolveId("scheduler", reconciler)).toBe(createRequire(reconciler).resolve("scheduler"));
		expect(resolveId("scheduler", appFile)).toBe(webRequire.resolve("@tanstack/redact/scheduler"));
		expect(resolveId("unrelated", appFile)).toBeUndefined();
		expect(resolved.ssr?.noExternal).toBe(true);
	});
});
