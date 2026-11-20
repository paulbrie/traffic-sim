/**
 * The experiment's explainer video (ticket #277): bundles src/lib/experiments/dl-city/video.ts with the recorded runs,
 * steps it frame by frame in headless Chromium (over the DevTools protocol) and encodes the frames to VP9 WebM with the
 * ffmpeg Playwright ships (VP9 only, no audio: the video is captioned).
 *
 *   npx tsx scripts/dl-city-video.ts [--out docs/experiments/dl-city-277/video.webm]
 *   npx tsx scripts/dl-city-video.ts --stills 5,20,40 [--out /tmp/stills]   (PNG-ish JPEGs of those seconds, to check the layout)
 *
 * CHROME and FFMPEG override the binaries (default: the newest under ~/.cache/ms-playwright).
 */
import { build } from "esbuild";
import { spawn, type ChildProcess } from "child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const exp = join(root, "docs/experiments/dl-city-277");
const stills = arg("stills", "");
const OUT = arg("out", stills ? join(tmpdir(), "dl-city-stills") : join(exp, "video.webm"));
const pw = join(homedir(), ".cache/ms-playwright");
const newest = (prefix: string) => readdirSync(pw).filter(d => d.startsWith(prefix)).sort((a, b) => Number(a.split("-").pop()) - Number(b.split("-").pop())).pop();
const CHROME = process.env.CHROME ?? join(pw, newest("chromium_headless_shell-")!, "chrome-headless-shell-linux64/chrome-headless-shell");
const FFMPEG = process.env.FFMPEG ?? join(pw, newest("ffmpeg-")!, "ffmpeg-linux");

const jsonl = (f: string) => readFileSync(f, "utf8").split("\n").filter(l => l.trim()).map(l => JSON.parse(l));

async function main() {
  const js = await build({ entryPoints: [join(root, "src/lib/experiments/dl-city/video.ts")], bundle: true, format: "iife", platform: "browser", target: "es2022", minify: true, write: false, tsconfig: join(root, "tsconfig.json"), legalComments: "none" });
  const data = JSON.stringify({ runs: jsonl(join(exp, "runs.jsonl")), probe: jsonl(join(exp, "runs-probe.jsonl")) }).replace(/</g, "\\u003c");
  const work = join(tmpdir(), "dl-city-video");
  mkdirSync(work, { recursive: true });
  const page = join(work, "video.html");
  writeFileSync(page, `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#000}</style><body><script>window.DATA=${data}</script><script>${js.outputFiles[0].text.replace(/<\/script/gi, "<\\/script")}</script></body>`);

  const chrome = spawn(CHROME, ["--headless", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--remote-debugging-port=0", `--user-data-dir=${join(work, "profile")}`, "--window-size=1920,1080", `file://${page}`], { stdio: ["ignore", "ignore", "pipe"] });
  const wsUrl = await new Promise<string>((res, rej) => {
    let buf = "";
    chrome.stderr!.on("data", (b: Buffer) => { buf += b; const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf); if (m) res(m[1]); });
    chrome.on("exit", c => rej(new Error(`chrome exited ${c}: ${buf}`)));
  });
  const port = new URL(wsUrl).port;
  type Target = { type: string; url: string; webSocketDebuggerUrl: string };
  let target: Target | undefined;
  for (let k = 0; k < 50 && !target; k++) { target = ((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Target[]).find(t => t.type === "page" && t.url.endsWith("video.html")); if (!target) await new Promise(r => setTimeout(r, 200)); }
  const ws = new WebSocket(target!.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener("open", r, { once: true }));
  let id = 0;
  const pending = new Map<number, (v: { result?: { result?: { value?: unknown }; exceptionDetails?: unknown }; error?: unknown }) => void>();
  ws.addEventListener("message", e => { const m = JSON.parse(String(e.data)); pending.get(m.id)?.(m); pending.delete(m.id); });
  const evaluate = async <T>(expression: string): Promise<T> => {
    const n = ++id;
    const m = await new Promise<{ result?: { result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string } } }; error?: unknown }>(r => { pending.set(n, r as never); ws.send(JSON.stringify({ id: n, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } })); });
    if (m.error || m.result?.exceptionDetails) throw new Error(JSON.stringify(m.error ?? m.result?.exceptionDetails?.exception?.description ?? m.result?.exceptionDetails));
    return m.result!.result!.value as T;
  };
  for (let k = 0; k < 100 && !(await evaluate<boolean>("!!window.ready").catch(() => false)); k++) await new Promise(r => setTimeout(r, 200));
  const total = await evaluate<number>("window.TOTAL"), fps = await evaluate<number>("window.FPS");
  const jpeg = (url: string) => Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
  const t0 = Date.now();
  try {
    if (stills) {
      mkdirSync(OUT, { recursive: true });
      // (frames only ever step the simulations forward: draw the seconds asked for in order)
      for (const s of stills.split(",").map(Number).sort((a, b) => a - b)) {
        writeFileSync(join(OUT, `still-${String(s).padStart(3, "0")}.jpg`), jpeg(await evaluate<string>(`window.frame(${Math.round(s * fps)})`)));
      }
      console.log(`${OUT}: ${stills.split(",").length} stills, ${((Date.now() - t0) / 1000).toFixed(0)} s (video ${(total / fps).toFixed(0)} s)`);
    } else {
      const ff: ChildProcess = spawn(FFMPEG, ["-y", "-loglevel", "error", "-f", "image2pipe", "-c:v", "mjpeg", "-framerate", String(fps), "-i", "pipe:0", "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "30", "-deadline", "good", "-cpu-used", "4", "-row-mt", "1", "-pix_fmt", "yuv420p", OUT], { stdio: ["pipe", "inherit", "inherit"] });
      // (ffmpeg gone early, a bad option say: stop rather than wait for its input to drain forever)
      let exited: number | null = null;
      const done = new Promise<number>(r => ff.on("exit", c => { exited = c ?? 1; r(exited); }));
      ff.on("error", e => { throw e; });
      for (let i = 0; i < total; i++) {
        const buf = jpeg(await evaluate<string>(`window.frame(${i})`));
        if (exited !== null) throw new Error(`ffmpeg exited ${exited} at frame ${i}`);
        if (!ff.stdin!.write(buf)) await Promise.race([new Promise(r => ff.stdin!.once("drain", r)), done]);
        if (i % (fps * 10) === 0) console.log(`frame ${i}/${total} (${(i / fps).toFixed(0)} s), ${((Date.now() - t0) / 1000).toFixed(0)} s elapsed`);
      }
      ff.stdin!.end();
      const code = await done;
      if (code) throw new Error(`ffmpeg exited ${code}`);
      console.log(`${OUT}: ${(total / fps).toFixed(0)} s, ${total} frames, ${((Date.now() - t0) / 1000).toFixed(0)} s to make${existsSync(OUT) ? `, ${(readFileSync(OUT).length / 1e6).toFixed(1)} MB` : ""}`);
    }
  } finally { ws.close(); chrome.kill(); }
}
main().catch(e => { console.error(e); process.exit(1); });
