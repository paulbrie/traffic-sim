"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { buildRoadGeo, heightFn } from "@/render/geometry";
import { buildBuildings, buildFurniture, buildRoads, buildingShell, type Furniture } from "@/render/scene3d";
import { satelliteMosaic } from "@/render/satellite";
import type { BuildingDef } from "@/engine/types";
import { readPalette, speedColor, type Palette } from "@/render/palette";
import { LEVEL_H, linkExtent } from "@/engine/compile";
import { network$, select, ui, underlay$, type UiState } from "@/state/store";
import { underlayImg$ } from "@/state/underlay-image";
import { simController } from "@/state/sim-controller";
import { viewCmd$ } from "@/state/commands";
import * as ops from "@/state/ops";

const CAR3D = ["#ffffff", "#f1f2ee", "#e2e5e1", "#cdd1cd"];

export function View3D() {
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const wrap = wrapRef.current!;
    let pal: Palette = readPalette();
    let u: UiState = ui.getValue();
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    wrap.appendChild(renderer.domElement);
    renderer.domElement.className = "block";

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 2, 12000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.dampingFactor = 0.12; controls.maxPolarAngle = 1.45; controls.screenSpacePanning = false;
    const hemi = new THREE.HemisphereLight(0xffffff, 0x808080, 0.65);
    const sun = new THREE.DirectionalLight(0xffffff, 0.55);
    sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0008; sun.shadow.normalBias = 0.6;
    scene.add(hemi, sun, sun.target);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(40000, 40000), new THREE.MeshLambertMaterial({ color: pal.ground }));
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);

    const sigMats = {
      green: new THREE.MeshBasicMaterial({ color: pal.go }), yellow: new THREE.MeshBasicMaterial({ color: pal.slow }),
      red: new THREE.MeshBasicMaterial({ color: pal.stop }), off: new THREE.MeshLambertMaterial({ color: "#555" }),
    };
    let roads: THREE.Group | null = null, furniture: Furniture | null = null, builtVersion = -1;
    // buildings are rebuilt only when the buildings themselves (or the theme) change
    let houses: { mesh: THREE.Mesh; owner: Int32Array; list: BuildingDef[] } | null = null;
    function syncBuildings(force = false) {
      const list = network$.getValue().buildings ?? [];
      if (houses && houses.list === list && !force) { houses.mesh.visible = u.display.buildings; return; }
      if (houses) { scene.remove(houses.mesh); houses.mesh.geometry.dispose(); (houses.mesh.material as THREE.Material).dispose(); houses = null; }
      if (!list.length) return;
      const b = buildBuildings(list, pal);
      houses = { ...b, list };
      houses.mesh.visible = u.display.buildings;
      scene.add(houses.mesh);
    }
    const box = new THREE.BoxGeometry(1, 1, 1); box.translate(0, 0.5, 0);
    const MAXV = 50000; // body boxes (a truck uses two)
    const body = new THREE.InstancedMesh(box, new THREE.MeshLambertMaterial({ color: 0xffffff }), MAXV);
    const glass = new THREE.InstancedMesh(box, new THREE.MeshLambertMaterial({ color: 0x1e2830 }), MAXV);
    const white = new THREE.Color(1, 1, 1);
    for (let i = 0; i < MAXV; i++) body.setColorAt(i, white); // allocate colours while count = MAXV
    for (const m of [body, glass]) { m.castShadow = true; m.frustumCulled = false; m.count = 0; }
    scene.add(body, glass);
    // turn signals: small amber lamps at the front and rear corners
    const lampGeo = new THREE.BoxGeometry(0.28, 0.22, 0.2);
    const lamps = new THREE.InstancedMesh(lampGeo, new THREE.MeshBasicMaterial({ color: 0xffab1a }), 16000);
    lamps.frustumCulled = false; lamps.count = 0; scene.add(lamps);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 48), new THREE.MeshBasicMaterial({ color: pal.select, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.visible = false; scene.add(ring);
    const hl = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: pal.select, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }));
    scene.add(hl);
    const dummy = new THREE.Object3D(), col = new THREE.Color();

    // reference image on the ground, just above the grass and below the kerbs
    // the grass doesn't write depth, so the image never z-fights it and roads still cover the image
    (ground.material as THREE.MeshLambertMaterial).depthWrite = false; ground.renderOrder = -2;
    const ulMat = new THREE.MeshLambertMaterial({ transparent: true, depthWrite: false });
    const ulMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), ulMat);
    ulMesh.rotation.order = "YXZ"; ulMesh.receiveShadow = true; ulMesh.visible = false;
    scene.add(ulMesh);
    let ulTexFor: HTMLImageElement | null = null;
    function syncUnderlay() {
      const ud = underlay$.getValue(), img = underlayImg$.getValue();
      if (!ud || !img || !ud.visible || !ud.in3d) { ulMesh.visible = false; return; }
      if (ulTexFor !== img) {
        ulMat.map?.dispose();
        // keep within the GPU's texture limit
        const max = Math.min(8192, renderer.capabilities.maxTextureSize);
        let src: TexImageSource = img;
        if (Math.max(img.naturalWidth, img.naturalHeight) > max) {
          const k = max / Math.max(img.naturalWidth, img.naturalHeight), c = document.createElement("canvas");
          c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
          c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
          src = c;
        }
        const tex = new THREE.Texture(src as HTMLImageElement);
        tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = renderer.capabilities.getMaxAnisotropy(); tex.needsUpdate = true;
        ulMat.map = tex; ulMat.needsUpdate = true; ulTexFor = img;
      }
      ulMat.opacity = ud.opacity;
      ulMesh.scale.set(ud.w * ud.mpp, ud.h * ud.mpp, 1);
      // plane lies in XZ; world y (plan) maps to +z, clockwise plan rotation is a negative turn about +y
      ulMesh.rotation.set(-Math.PI / 2, (-ud.rot * Math.PI) / 180, 0);
      ulMesh.position.set(ud.x, 0.005, ud.y);
      ulMesh.visible = true;
    }

    // satellite imagery on the ground, for plans that know where they are
    const satMat = new THREE.MeshLambertMaterial({ depthWrite: false });
    const satMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), satMat);
    satMesh.rotation.x = -Math.PI / 2; satMesh.receiveShadow = true; satMesh.visible = false; satMesh.renderOrder = -1;
    scene.add(satMesh);
    let satKey = "", satGen = 0;
    function syncSatellite() {
      const net = network$.getValue(), geo = net.geo, want = !!geo && u.display.satellite;
      satMesh.visible = want && !!satMat.map;
      satMat.color.setScalar(u.display.satBrightness ?? 1);
      if (!want || !geo) return;
      const b = simController.compiled.bounds, pad = Math.max(150, 0.2 * Math.max(b.maxX - b.minX, b.maxY - b.minY));
      const key = `${geo.lat},${geo.lon}:${Math.round(b.minX / 100)},${Math.round(b.minY / 100)},${Math.round(b.maxX / 100)},${Math.round(b.maxY / 100)}`;
      if (key === satKey) return;
      satKey = key;
      const gen = ++satGen;
      satelliteMosaic(geo, { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad }).then(m => {
        if (!m || gen !== satGen) return;
        satMat.map?.dispose();
        const tex = new THREE.CanvasTexture(m.canvas);
        tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
        satMat.map = tex; satMat.needsUpdate = true;
        satMesh.scale.set(m.rect.maxX - m.rect.minX, m.rect.maxY - m.rect.minY, 1);
        satMesh.position.set((m.rect.minX + m.rect.maxX) / 2, 0.002, (m.rect.minY + m.rect.maxY) / 2);
        satMesh.visible = !!network$.getValue().geo && u.display.satellite;
      });
    }

    function applyTheme() {
      pal = readPalette();
      scene.background = new THREE.Color(pal.sky);
      scene.fog = new THREE.Fog(pal.sky, 1500, 6000);
      (ground.material as THREE.MeshLambertMaterial).color.set(pal.ground);
      sigMats.green.color.set(pal.go); sigMats.yellow.color.set(pal.slow); sigMats.red.color.set(pal.stop);
      (ring.material as THREE.MeshBasicMaterial).color.set(pal.select);
      (hl.material as THREE.MeshBasicMaterial).color.set(pal.select);
      const dark = matchMedia("(prefers-color-scheme: dark)").matches;
      hemi.intensity = dark ? 0.9 : 1.15; sun.intensity = dark ? 1.0 : 1.5;
      builtVersion = -1;
      syncBuildings(true);
    }
    applyTheme();

    function rebuild() {
      if (roads) { scene.remove(roads); roads.traverse(o => { if (o instanceof THREE.Mesh) o.geometry.dispose(); }); }
      if (furniture) { scene.remove(furniture.group); }
      const geo = buildRoadGeo(simController.compiled, network$.getValue()), hf = heightFn(simController.compiled, network$.getValue());
      roads = buildRoads(geo, pal, hf); scene.add(roads);
      furniture = buildFurniture(geo, pal, sigMats, hf); scene.add(furniture.group);
      syncBuildings();
      syncSatellite();
      builtVersion = simController.version;
      const b = simController.compiled.bounds;
      const cx = (b.minX + b.maxX) / 2, cz = (b.minY + b.maxY) / 2, span = Math.max(200, b.maxX - b.minX, b.maxY - b.minY);
      sun.position.set(cx - span * 0.6, span * 1.1, cz - span * 0.5); sun.target.position.set(cx, 0, cz);
      const sc = sun.shadow.camera; sc.left = -span; sc.right = span; sc.top = span; sc.bottom = -span; sc.near = 10; sc.far = span * 4; sc.updateProjectionMatrix();
    }
    let homed = "";
    function home() {
      const b = simController.compiled.bounds;
      const cx = (b.minX + b.maxX) / 2, cz = (b.minY + b.maxY) / 2, span = Math.max(150, b.maxX - b.minX, b.maxY - b.minY);
      controls.target.set(cx, 0, cz);
      camera.position.set(cx - span * 0.35, span * 0.75, cz + span * 0.85);
      controls.update();
    }

    const resize = () => {
      const r = wrap.getBoundingClientRect();
      renderer.setSize(Math.max(1, r.width), Math.max(1, r.height));
      camera.aspect = Math.max(1, r.width) / Math.max(1, r.height); camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize); ro.observe(wrap); resize();

    const subs = [
      ui.subscribe("**", () => { u = ui.getValue(); if (houses) houses.mesh.visible = u.display.buildings; syncSatellite(); }),
      underlay$.subscribe(syncUnderlay),
      underlayImg$.subscribe(syncUnderlay),
      viewCmd$.subscribe(c => {
        if (!c) return;
        if (c.cmd === "fit") home();
        else if (c.cmd === "north") {
          // swing the camera round the target so the view faces north (plan −y = world −z)
          controls.enableDamping = false; controls.update(); // drop any leftover spin
          const off = camera.position.clone().sub(controls.target), flat = Math.hypot(off.x, off.z);
          camera.position.set(controls.target.x, camera.position.y, controls.target.z + Math.max(flat, 1));
          controls.update(); controls.enableDamping = true;
        }
        else if (c.cmd === "zoomIn" || c.cmd === "zoomOut") {
          const off = camera.position.clone().sub(controls.target).multiplyScalar(c.cmd === "zoomIn" ? 1 / 1.4 : 1.4);
          camera.position.copy(controls.target).add(off); controls.update();
        }
      }),
    ];
    const mq = matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", applyTheme);

    // picking: select on click (no drag)
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit = new THREE.Vector3();
    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => { down = { x: e.clientX, y: e.clientY }; };
    const onUp = (e: PointerEvent) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5 || e.button !== 0) { down = null; return; }
      down = null;
      const r = renderer.domElement.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      if (!ray.ray.intersectPlane(plane, hit)) return;
      const p = { x: hit.x, y: hit.z }, net = network$.getValue();
      const dist = camera.position.distanceTo(hit), tol = Math.max(3, dist * 0.012);
      const sim = simController.sim;
      const v = sim?.vehicleNear(p.x, p.y, tol);
      if (v) return select({ kind: "vehicle", id: String(v.id) });
      const node = net.nodes.find(n => Math.hypot(n.x - p.x, n.y - p.y) < tol * 1.5);
      if (node) return select({ kind: "node", id: node.id });
      if (houses?.mesh.visible) {
        const h = ray.intersectObject(houses.mesh, false)[0];
        if (h && h.faceIndex != null && h.distance < ray.ray.origin.distanceTo(hit)) {
          const b = houses.list[houses.owner[h.faceIndex]];
          if (b) return select({ kind: "building", id: b.id });
        }
      }
      let best: { id: string; d: number } | null = null;
      for (const l of net.links) {
        const A = ops.nodeById(net, l.from), B = ops.nodeById(net, l.to); if (!A || !B) continue;
        const [lo, hi] = linkExtent(l), r2 = ops.nearestT(l, A, B, p);
        if (r2.d < Math.max(-lo, hi) + 1 && (!best || r2.d < best.d)) best = { id: l.id, d: r2.d };
      }
      select(best ? { kind: "link", id: best.id } : null);
    };
    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointerup", onUp);

    let raf = 0, hlFor = "", lastHeading = NaN;
    const compassEl = () => wrap.parentElement?.querySelector<HTMLElement>("[data-compass]");
    const frame = (now: number) => {
      if (u.view === "3d") {
        simController.advance();
        if (builtVersion !== simController.version) { rebuild(); hlFor = ""; }
        if (homed !== u.planId) { homed = u.planId; home(); }
        const sim = simController.sim;
        // vehicles
        let n = 0, ng = 0;
        if (sim) for (const v of sim.vehicles) {
          if (v.dead || n + 2 >= MAXV) continue;
          const q = sim.pose(v), mx = (q.fx + q.rx) / 2, mz = (q.fy + q.ry) / 2, y0 = v.z * LEVEL_H;
          const dx = q.fx - q.rx, dz = q.fy - q.ry, m = Math.hypot(dx, dz) || 1, a = Math.atan2(-dz, dx), ux = dx / m, uz = dz / m;
          const sc = u.display.bySpeed ? speedColor(pal, v.v / Math.max(1, v.v0)) : null;
          dummy.rotation.set(0, a, 0);
          if (v.kind === "truck") {
            dummy.position.set(mx - ux * v.len * 0.12, 0.55 + y0, mz - uz * v.len * 0.12); dummy.scale.set(v.len * 0.74, 3, v.width); dummy.updateMatrix();
            body.setMatrixAt(n, dummy.matrix); col.set(sc ?? pal.truck); body.setColorAt(n++, col);
            dummy.position.set(mx + ux * v.len * 0.385, 0.45 + y0, mz + uz * v.len * 0.385); dummy.scale.set(v.len * 0.21, 2.45, v.width * 0.98); dummy.updateMatrix();
            body.setMatrixAt(n, dummy.matrix); col.set(sc ?? CAR3D[1]); body.setColorAt(n++, col);
            dummy.position.set(mx + ux * v.len * 0.47, 1.75 + y0, mz + uz * v.len * 0.47); dummy.scale.set(0.35, 0.8, v.width * 0.9); dummy.updateMatrix();
            glass.setMatrixAt(ng++, dummy.matrix);
            continue;
          }
          const bus = v.kind === "bus";
          dummy.position.set(mx, (bus ? 0.3 : 0.28) + y0, mz); dummy.scale.set(v.len, bus ? 2.9 : 1.0, v.width); dummy.updateMatrix();
          body.setMatrixAt(n, dummy.matrix); col.set(sc ?? (bus ? pal.busVeh : CAR3D[v.tint % 4])); body.setColorAt(n++, col);
          if (bus) { dummy.position.set(mx, 1.75 + y0, mz); dummy.scale.set(v.len * 0.9, 0.85, v.width * 1.03); }
          else { const b = v.len * 0.07; dummy.position.set(mx - ux * b, 1.27 + y0, mz - uz * b); dummy.scale.set(v.len * 0.5, 0.55, v.width * 0.86); }
          dummy.updateMatrix(); glass.setMatrixAt(ng++, dummy.matrix);
        }
        // blinkers
        let nl = 0;
        if (sim && Math.floor(now / 380) % 2 === 0) for (const v of sim.vehicles) {
          const b = sim.blinker(v);
          if (!b || nl + 2 > 16000) continue;
          const q = sim.pose(v), mx = (q.fx + q.rx) / 2, mz = (q.fy + q.ry) / 2;
          const dx = q.fx - q.rx, dz = q.fy - q.ry, m = Math.hypot(dx, dz) || 1, ux = dx / m, uz = dz / m;
          const nx = -uz * b, nz = ux * b, half = v.len / 2 - 0.15, side = v.width / 2 + 0.02, h = (v.kind === "car" ? 0.6 : 0.9) + v.z * LEVEL_H;
          dummy.rotation.set(0, Math.atan2(-dz, dx), 0); dummy.scale.set(1, 1, 1);
          for (const f of [half, -half]) {
            dummy.position.set(mx + ux * f + nx * side, h, mz + uz * f + nz * side); dummy.updateMatrix();
            lamps.setMatrixAt(nl++, dummy.matrix);
          }
        }
        lamps.count = nl; lamps.instanceMatrix.needsUpdate = true;
        body.count = n; glass.count = ng;
        body.instanceMatrix.needsUpdate = true; glass.instanceMatrix.needsUpdate = true;
        if (body.instanceColor) body.instanceColor.needsUpdate = true;
        // signals and stop labels
        if (furniture) {
          for (const h of furniture.heads) h.mesh.material = sim ? sigMats[sim.signalFor(h.nodeIdx, h.arm, h.lane) ?? "red"] : sigMats.off;
          for (const L of furniture.labels) {
            const st = simController.compiled.stopById.get(L.id);
            const text = st ? `${st.def.name}${sim ? ` · ${Math.floor(st.waiting)}` : ""}` : "";
            if (L.sprite.userData.text === text) continue;
            L.sprite.userData.text = text;
            const g = L.canvas.getContext("2d")!;
            g.clearRect(0, 0, 256, 64); g.fillStyle = pal.select; g.beginPath(); g.roundRect(4, 8, 248, 48, 10); g.fill();
            g.fillStyle = "#fff"; g.font = `600 26px ${pal.sans}`; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(text, 128, 33);
            L.tex.needsUpdate = true;
          }
        }
        // selection: ring for vehicle/node, translucent overlay for link
        const sel = u.selection, net = network$.getValue();
        ring.visible = false;
        if (sel?.kind === "vehicle" && sim) {
          const v = sim.vehicles.find(x => String(x.id) === sel.id && !x.dead);
          if (v) { const q = sim.pose(v); ring.position.set((q.fx + q.rx) / 2, 0.12 + v.z * LEVEL_H, (q.fy + q.ry) / 2); const s = Math.max(3.5, v.len * 0.8); ring.scale.set(s, s, s); ring.visible = true; }
        } else if (sel?.kind === "node") {
          const nd = net.nodes.find(x => x.id === sel.id);
          if (nd) { ring.position.set(nd.x, 0.12, nd.y); ring.scale.set(12, 12, 12); ring.visible = true; }
        }
        const key = sel?.kind === "link" || sel?.kind === "building" ? `${sel.kind}:${sel.id}:${simController.version}` : "";
        if (key !== hlFor) {
          hlFor = key;
          hl.geometry.dispose();
          let geo = new THREE.BufferGeometry();
          const bld = sel?.kind === "building" ? net.buildings?.find(b => b.id === sel.id) : undefined;
          if (bld) geo = buildingShell(bld);
          else if (sel?.kind === "link") {
            const s = buildRoadGeo(simController.compiled, net).surfaces.find(x => x.linkId === sel.id);
            if (s) {
              const L = s.curb.left.pts, R = s.curb.right.pts, pos: number[] = [], hf = heightFn(simController.compiled, net);
              // on top of the road, bridges included
              const z = (x: number, y: number) => 0.25 + hf.at(s.on, x, y);
              for (let k = 0; k < Math.min(L.length, R.length) / 2 - 1; k++) {
                pos.push(L[2 * k], z(L[2 * k], L[2 * k + 1]), L[2 * k + 1], L[2 * k + 2], z(L[2 * k + 2], L[2 * k + 3]), L[2 * k + 3], R[2 * k + 2], z(R[2 * k + 2], R[2 * k + 3]), R[2 * k + 3]);
                pos.push(L[2 * k], z(L[2 * k], L[2 * k + 1]), L[2 * k + 1], R[2 * k + 2], z(R[2 * k + 2], R[2 * k + 3]), R[2 * k + 3], R[2 * k], z(R[2 * k], R[2 * k + 1]), R[2 * k + 1]);
              }
              geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
            }
          }
          hl.geometry = geo;
        }
        controls.update();
        // compass: heading of the camera's view direction, 0° = looking north
        const heading = Math.round((Math.atan2(controls.target.x - camera.position.x, -(controls.target.z - camera.position.z)) * 180) / Math.PI * 10) / 10;
        if (heading !== lastHeading) { lastHeading = heading; compassEl()?.style.setProperty("--heading", `${-heading}deg`); }
        renderer.render(scene, camera);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      subs.forEach(s => s.unsubscribe());
      mq.removeEventListener("change", applyTheme);
      renderer.domElement.removeEventListener("pointerdown", onDown);
      renderer.domElement.removeEventListener("pointerup", onUp);
      controls.dispose();
      if (houses) { houses.mesh.geometry.dispose(); (houses.mesh.material as THREE.Material).dispose(); }
      ulMat.map?.dispose(); ulMat.dispose(); ulMesh.geometry.dispose();
      satMat.map?.dispose(); satMat.dispose(); satMesh.geometry.dispose();
      renderer.dispose();
      wrap.removeChild(renderer.domElement);
      compassEl()?.style.setProperty("--heading", "0deg");
    };
  }, []);

  return <div ref={wrapRef} className="absolute inset-0 overflow-hidden" aria-label="3D view of the street plan" />;
}
