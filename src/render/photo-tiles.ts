import * as THREE from "three";
import { TilesRenderer } from "3d-tiles-renderer";
import { CesiumIonAuthPlugin, GLTFExtensionsPlugin, GoogleCloudAuthPlugin, ReorientationPlugin, TileCompressionPlugin, UnloadTilesPlugin } from "3d-tiles-renderer/plugins";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import type { GeoRef } from "@/engine/types";

/**
 * Photorealistic 3D tiles (real buildings, trees and terrain from aerial photography) in the 3D view, for plans
 * that know where they are. Two sources, set when the app is built:
 *  - Google Maps Platform (Map Tiles API): NEXT_PUBLIC_GOOGLE_MAPS_API_KEY. Billed per session (one per time
 *    they are turned on; a session lasts up to 3 h); not served to projects billed in the EU/EEA since July 2025.
 *  - Cesium ion: NEXT_PUBLIC_CESIUM_ION_TOKEN, and NEXT_PUBLIC_CESIUM_ION_ASSET_ID (default 2275207: Google's
 *    Photorealistic 3D Tiles through Cesium ion).
 * They are only shown (never stored or edited), with their makers' credits, as the providers' terms ask.
 */
export type PhotoProvider = { kind: "google"; key: string } | { kind: "ion"; token: string; asset: string };

export function photoProvider(): PhotoProvider | null {
  const g = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY, t = process.env.NEXT_PUBLIC_CESIUM_ION_TOKEN;
  if (g) return { kind: "google", key: g };
  if (t) return { kind: "ion", token: t, asset: process.env.NEXT_PUBLIC_CESIUM_ION_ASSET_ID || "2275207" };
  return null;
}

export { GOOGLE_LOGO } from "./satellite";

let draco: DRACOLoader | null = null;

export class PhotoTiles {
  /** in the scene: the tiles, turned and lowered so the ground at the plan's origin is at its level */
  readonly root = new THREE.Group();
  private tiles: TilesRenderer;
  private cam: THREE.Camera | null = null;
  private probeAt = 0;
  private grounded = false;
  private ray = new THREE.Raycaster();

  constructor(readonly provider: PhotoProvider, geo: GeoRef, onError: (message: string) => void) {
    const tiles = new TilesRenderer();
    if (provider.kind === "google") tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: provider.key, autoRefreshToken: true }));
    else tiles.registerPlugin(new CesiumIonAuthPlugin({ apiToken: provider.token, assetId: provider.asset, autoRefreshToken: true }));
    draco ??= new DRACOLoader().setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.7/");
    tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: draco }));
    tiles.registerPlugin(new TileCompressionPlugin());
    tiles.registerPlugin(new UnloadTilesPlugin());
    // the plan's origin is at (lat, lon); there the tiles' frame has +Z north and +X west…
    tiles.registerPlugin(new ReorientationPlugin({ lat: THREE.MathUtils.degToRad(geo.lat), lon: THREE.MathUtils.degToRad(geo.lon), height: 0 }));
    tiles.addEventListener("load-error", (e: { error?: unknown; url?: unknown }) => {
      const msg = String((e.error as Error)?.message ?? e.error ?? "");
      if (!/40[13]/.test(msg) && !String(e.url ?? "").includes("root")) return;
      onError(provider.kind === "google"
        ? /403/.test(msg) ? "Google refused the 3D tiles (403): the API key isn't allowed, or the Google Cloud project is billed in the EU/EEA, where Google no longer serves them." : "Google's 3D tiles couldn't be loaded. Check the API key and that the Map Tiles API is enabled."
        : "Cesium ion's 3D tiles couldn't be loaded. Check the token and the asset.");
    });
    // …and the view's has +X east and +Z south: half a turn
    this.root.rotation.y = Math.PI;
    this.root.add(tiles.group);
    this.tiles = tiles;
  }

  /** follow the camera; once tiles are in, find the ground at the plan's origin and set it at height 0 */
  update(cam: THREE.PerspectiveCamera, renderer: THREE.WebGLRenderer, now: number) {
    if (this.cam !== cam) { if (this.cam) this.tiles.deleteCamera(this.cam); this.tiles.setCamera(cam); this.cam = cam; }
    this.tiles.setResolutionFromRenderer(cam, renderer);
    this.tiles.update();
    // (again now and then while finer tiles come in, then rarely)
    if (now > this.probeAt) {
      this.probeAt = now + (this.grounded ? 15000 : 1500);
      this.root.updateMatrixWorld(true);
      this.ray.set(new THREE.Vector3(0, 3000, 0), new THREE.Vector3(0, -1, 0));
      const hit = this.ray.intersectObject(this.tiles.group, true)[0];
      if (hit) {
        // (a little under the plan's own roads, so they show on top of the photographed ones)
        this.root.position.y -= hit.point.y + 0.4;
        this.grounded = true;
      }
    }
  }

  /** the credits to show with the tiles */
  credits(): string[] {
    return this.tiles.getAttributions().filter(a => a.type === "string" && a.value).map(a => String(a.value));
  }

  dispose() {
    this.root.removeFromParent();
    this.tiles.dispose();
  }
}
