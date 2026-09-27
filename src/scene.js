// Escultura 3D de la portada: la "ō." del logo de Vō Studio.
// Tres piezas (la o, el macrón y el punto) flotan a distintas profundidades,
// siguen el mouse y se separan con el scroll.
import {
  WebGLRenderer,
  Scene,
  PerspectiveCamera,
  Group,
  Shape,
  Path,
  ExtrudeGeometry,
  SphereGeometry,
  TorusGeometry,
  Mesh,
  MeshPhysicalMaterial,
  MeshBasicMaterial,
  PMREMGenerator,
  DirectionalLight,
  ACESFilmicToneMapping,
  SRGBColorSpace,
  MathUtils,
} from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

export function createScene(canvas, { reducedMotion = false } = {}) {
  let renderer;
  try {
    renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch {
    return null;
  }

  const isSmall = () => window.innerWidth <= 820;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, isSmall() ? 1.5 : 2));
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = SRGBColorSpace;

  const scene = new Scene();
  const pmrem = new PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  const key = new DirectionalLight(0xffffff, 1.4);
  key.position.set(3, 4, 5);
  scene.add(key);

  const camera = new PerspectiveCamera(30, 1, 0.1, 100);
  camera.position.set(0, 0, 10);

  // Materiales: laca negra (tinta de la marca) y cromo para el punto.
  const lacquer = new MeshPhysicalMaterial({
    color: 0x0e0e0e,
    roughness: 0.22,
    metalness: 0.0,
    clearcoat: 1,
    clearcoatRoughness: 0.06,
  });
  const chrome = new MeshPhysicalMaterial({ color: 0xd9d9d4, roughness: 0.06, metalness: 1 });

  const seg = isSmall() ? 64 : 128;

  // La "o" didona: contorno exterior elíptico y contraforma más angosta,
  // así los laterales quedan gruesos y arriba/abajo finos, como en el logo.
  const outer = new Shape();
  outer.absellipse(0, 0, 1, 1.12, 0, Math.PI * 2, false, 0);
  const hole = new Path();
  hole.absellipse(0, 0, 0.56, 0.99, 0, Math.PI * 2, true, 0);
  outer.holes.push(hole);
  const oGeo = new ExtrudeGeometry(outer, {
    depth: 0.42,
    curveSegments: seg,
    bevelEnabled: true,
    bevelThickness: 0.1,
    bevelSize: 0.05,
    bevelSegments: 10,
  });
  oGeo.center();
  const o = new Mesh(oGeo, lacquer);

  const macron = new Mesh(new RoundedBoxGeometry(1.5, 0.11, 0.34, 6, 0.05), lacquer);
  const dot = new Mesh(new SphereGeometry(0.22, seg / 2, seg / 2), chrome);

  // Aro fino de fondo: da una referencia de profundidad detrás de la escultura.
  const ring = new Mesh(
    new TorusGeometry(2.6, 0.006, 8, 240),
    new MeshBasicMaterial({ color: 0x121212, transparent: true, opacity: 0.35 })
  );

  const sculpture = new Group();
  const pieces = [
    { mesh: o, base: [0, 0, 0], split: [0, 0, 0], phase: 0 },
    { mesh: macron, base: [0, 1.62, 0.15], split: [0.25, 0.9, 1.6], phase: 1.7 },
    { mesh: dot, base: [1.5, -0.98, 0.3], split: [0.9, -0.5, 2.2], phase: 3.1 },
  ];
  pieces.forEach((p) => sculpture.add(p.mesh));

  const rig = new Group();
  rig.add(sculpture);
  rig.add(ring);
  ring.position.z = -1.6;
  scene.add(rig);

  // Estado
  const pointer = { x: 0, y: 0 };
  const smooth = { x: 0, y: 0 };
  let scroll = 0;
  let intro = reducedMotion ? 1 : 0;
  let visible = true;
  let raf = 0;
  const start = performance.now();

  function layout() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();

    const vh = 2 * Math.tan(MathUtils.degToRad(camera.fov / 2)) * camera.position.z;
    const vw = vh * camera.aspect;
    if (isSmall()) {
      rig.position.set(0, -vh * 0.02, 0);
      rig.scale.setScalar(Math.min(0.95, vw / 6.2, vh / 5.8));
    } else {
      rig.position.set(vw * 0.23, vh * 0.1, 0);
      rig.scale.setScalar(Math.min(1.25, vh / 6.4));
    }
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (!visible) return;
    const t = (now - start) / 1000;

    smooth.x += (pointer.x - smooth.x) * 0.05;
    smooth.y += (pointer.y - smooth.y) * 0.05;

    const e = 1 - Math.pow(1 - intro, 3);
    const s = scroll;
    const float = reducedMotion ? 0 : 1;

    sculpture.rotation.y = (1 - e) * -1.4 + Math.sin(t * 0.35) * 0.35 * float + smooth.x * 0.5 + s * 1.6;
    sculpture.rotation.x = -0.12 + smooth.y * 0.3 + s * 0.35;
    sculpture.rotation.z = Math.sin(t * 0.25) * 0.04 * float;
    sculpture.scale.setScalar(0.7 + 0.3 * e);

    pieces.forEach((p) => {
      const bob = Math.sin(t * 0.9 + p.phase) * 0.06 * float;
      p.mesh.position.set(
        p.base[0] + p.split[0] * s,
        p.base[1] + p.split[1] * s + bob,
        p.base[2] + p.split[2] * s
      );
    });
    macron.rotation.z = Math.sin(t * 0.6) * 0.03 * float + s * 0.25;

    ring.rotation.x = 0.2 + smooth.y * 0.15;
    ring.rotation.y = smooth.x * 0.25;
    ring.material.opacity = 0.35 * e;

    renderer.render(scene, camera);
  }

  layout();
  window.addEventListener('resize', layout);
  raf = requestAnimationFrame(frame);

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; }).observe(canvas);
  }

  return {
    setPointer(x, y) { pointer.x = x; pointer.y = y; },
    setScroll(v) { scroll = v; },
    setIntro(v) { intro = v; },
    get introValue() { return intro; },
    destroy() {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', layout);
      renderer.dispose();
    },
  };
}
