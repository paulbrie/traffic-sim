/**
 * A small neural network, by hand (ticket #277; no library, so it runs as is in Node and in the browser): a multi-layer
 * perceptron (ReLU hidden layers, linear outputs) trained with Adam on mean squared error, and an ensemble of them (each on
 * its own bootstrap sample, from its own random start), whose spread says how sure it is (a "deep ensemble").
 */
import { rng, type Rng } from "./city";

export interface MlpSpec { inputs: number; hidden: number[]; outputs: number }
interface Layer { W: Float64Array; b: Float64Array; nIn: number; nOut: number; mW: Float64Array; vW: Float64Array; mb: Float64Array; vb: Float64Array }

export class Mlp {
  layers: Layer[] = [];
  private t = 0;
  constructor(public spec: MlpSpec, R: Rng) {
    const sizes = [spec.inputs, ...spec.hidden, spec.outputs];
    for (let k = 0; k + 1 < sizes.length; k++) {
      const nIn = sizes[k], nOut = sizes[k + 1], s = Math.sqrt(2 / nIn);
      const W = new Float64Array(nIn * nOut);
      // (He initialisation, from a Box–Muller normal)
      for (let i = 0; i < W.length; i++) W[i] = s * Math.sqrt(-2 * Math.log(R() + 1e-12)) * Math.cos(2 * Math.PI * R());
      this.layers.push({ W, b: new Float64Array(nOut), nIn, nOut, mW: new Float64Array(W.length), vW: new Float64Array(W.length), mb: new Float64Array(nOut), vb: new Float64Array(nOut) });
    }
  }

  /** the outputs for one input (and, `keep`, every layer's activations, for the backward pass) */
  forward(x: ArrayLike<number>, keep?: Float64Array[]): Float64Array {
    let a = Float64Array.from(x as ArrayLike<number>);
    keep?.push(a);
    this.layers.forEach((L, li) => {
      const z = new Float64Array(L.nOut);
      for (let o = 0; o < L.nOut; o++) {
        let s = L.b[o];
        const row = o * L.nIn;
        for (let i = 0; i < L.nIn; i++) if (a[i] !== 0) s += L.W[row + i] * a[i];
        z[o] = li < this.layers.length - 1 ? Math.max(0, s) : s;
      }
      a = z;
      keep?.push(a);
    });
    return a;
  }

  /** one Adam step on a mini-batch; the batch's mean squared error */
  step(X: number[][], Y: number[][], lr: number, l2 = 1e-4): number {
    const gW = this.layers.map(L => new Float64Array(L.W.length)), gb = this.layers.map(L => new Float64Array(L.nOut));
    let loss = 0;
    for (let n = 0; n < X.length; n++) {
      const acts: Float64Array[] = [];
      const out = this.forward(X[n], acts);
      let d = new Float64Array(out.length);
      for (let o = 0; o < out.length; o++) { const e = out[o] - Y[n][o]; loss += e * e; d[o] = (2 * e) / (X.length * out.length); }
      for (let li = this.layers.length - 1; li >= 0; li--) {
        const L = this.layers[li], a = acts[li], dn = new Float64Array(L.nIn);
        for (let o = 0; o < L.nOut; o++) {
          const g = d[o];
          if (g === 0) continue;
          gb[li][o] += g;
          const row = o * L.nIn;
          for (let i = 0; i < L.nIn; i++) { gW[li][row + i] += g * a[i]; dn[i] += g * L.W[row + i]; }
        }
        // (through the ReLU before)
        if (li > 0) for (let i = 0; i < L.nIn; i++) if (acts[li][i] <= 0) dn[i] = 0;
        d = dn;
      }
    }
    this.t++;
    const b1 = 0.9, b2 = 0.999, eps = 1e-8, c1 = 1 - b1 ** this.t, c2 = 1 - b2 ** this.t;
    this.layers.forEach((L, li) => {
      for (let i = 0; i < L.W.length; i++) {
        const g = gW[li][i] + l2 * L.W[i];
        L.mW[i] = b1 * L.mW[i] + (1 - b1) * g; L.vW[i] = b2 * L.vW[i] + (1 - b2) * g * g;
        L.W[i] -= (lr * (L.mW[i] / c1)) / (Math.sqrt(L.vW[i] / c2) + eps);
      }
      for (let o = 0; o < L.nOut; o++) {
        const g = gb[li][o];
        L.mb[o] = b1 * L.mb[o] + (1 - b1) * g; L.vb[o] = b2 * L.vb[o] + (1 - b2) * g * g;
        L.b[o] -= (lr * (L.mb[o] / c1)) / (Math.sqrt(L.vb[o] / c2) + eps);
      }
    });
    return loss / (X.length * Y[0].length);
  }

  /** trained for `epochs` passes over (X, Y) in shuffled mini-batches */
  fit(X: number[][], Y: number[][], R: Rng, o: { epochs?: number; batch?: number; lr?: number; l2?: number } = {}): number {
    const ep = o.epochs ?? 200, bs = o.batch ?? 16, idx = X.map((_, i) => i);
    let last = 0;
    for (let e = 0; e < ep; e++) {
      for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
      const lr = (o.lr ?? 3e-3) * (0.5 + 0.5 * Math.cos((Math.PI * e) / ep));
      last = 0;
      for (let s = 0; s < idx.length; s += bs) { const b = idx.slice(s, s + bs); last += this.step(b.map(i => X[i]), b.map(i => Y[i]), lr, o.l2 ?? 1e-4) * b.length; }
      last /= idx.length;
    }
    return last;
  }
}

/** standardising targets (and back) */
export interface Scaler { mean: number[]; sd: number[] }
export function scaler(Y: number[][]): Scaler {
  const k = Y[0].length, mean = Array(k).fill(0), sd = Array(k).fill(0);
  for (const y of Y) y.forEach((v, i) => (mean[i] += v / Y.length));
  for (const y of Y) y.forEach((v, i) => (sd[i] += (v - mean[i]) ** 2 / Y.length));
  return { mean, sd: sd.map(s => Math.sqrt(s) || 1) };
}

/** several networks, each on a bootstrap sample of the data; its prediction their mean, its uncertainty their spread */
export class Ensemble {
  nets: Mlp[] = [];
  sc: Scaler = { mean: [], sd: [] };
  constructor(public size = 5, public hidden = [64, 32], private seed = 1) {}

  fit(X: number[][], Y: number[][], o: { epochs?: number; lr?: number; l2?: number } = {}) {
    const R = rng(this.seed);
    this.sc = scaler(Y);
    const Ys = Y.map(y => y.map((v, i) => (v - this.sc.mean[i]) / this.sc.sd[i]));
    this.nets = [];
    for (let k = 0; k < this.size; k++) {
      const net = new Mlp({ inputs: X[0].length, hidden: this.hidden, outputs: Y[0].length }, R);
      const pick = X.map(() => Math.floor(R() * X.length));
      // (L2 0.01: on a couple of hundred designs with 256 inputs they overfit without it; held-out R² 0.27 → 0.57 on a test target)
      net.fit(pick.map(i => X[i]), pick.map(i => Ys[i]), R, { epochs: o.epochs ?? 150, lr: o.lr, l2: o.l2 ?? 0.01 });
      this.nets.push(net);
    }
    return this;
  }

  /** each network's prediction (in the targets' own units) */
  members(x: number[]): number[][] {
    return this.nets.map(n => Array.from(n.forward(x)).map((v, i) => v * this.sc.sd[i] + this.sc.mean[i]));
  }

  /** per output: the mean and the spread of the networks' predictions (in the targets' own units) */
  predict(x: number[]): { mean: number[]; sd: number[] } {
    const outs = this.nets.map(n => Array.from(n.forward(x)).map((v, i) => v * this.sc.sd[i] + this.sc.mean[i]));
    const k = outs[0].length, mean = Array(k).fill(0), sd = Array(k).fill(0);
    for (const o of outs) o.forEach((v, i) => (mean[i] += v / outs.length));
    for (const o of outs) o.forEach((v, i) => (sd[i] += (v - mean[i]) ** 2 / outs.length));
    return { mean, sd: sd.map(Math.sqrt) };
  }
}

/** how much of the targets' variance predictions explain (1 perfect, 0 no better than their mean) */
export function r2(y: number[], p: number[]): number {
  const m = y.reduce((a, b) => a + b, 0) / y.length;
  const ss = y.reduce((a, v) => a + (v - m) ** 2, 0), res = y.reduce((a, v, i) => a + (v - p[i]) ** 2, 0);
  return 1 - res / (ss || 1);
}
/** Spearman's rank correlation (does it put designs in the right order) */
export function spearman(a: number[], b: number[]): number {
  const rank = (v: number[]) => { const o = v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]), r = Array(v.length); o.forEach(([, i], k) => (r[i] = k)); return r as number[]; };
  const ra = rank(a), rb = rank(b), n = a.length;
  return 1 - (6 * ra.reduce((s, x, i) => s + (x - rb[i]) ** 2, 0)) / (n * (n * n - 1));
}
