import Lenis from 'lenis';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { createScene } from './scene.js';

gsap.registerPlugin(ScrollTrigger);

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

/* ---------- Scroll suave ---------- */
let lenis = null;
if (!reduced) {
  lenis = new Lenis({ lerp: 0.1, wheelMultiplier: 1 });
  lenis.on('scroll', ScrollTrigger.update);
  gsap.ticker.add((time) => lenis.raf(time * 1000));
  gsap.ticker.lagSmoothing(0);
}

function scrollToTarget(target) {
  const offset = target.id === 'top' ? 0 : -70;
  if (lenis) lenis.scrollTo(target, { offset, duration: 1.4 });
  else target.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth' });
}

/* ---------- Navegación y menú ---------- */
const nav = $('[data-nav]');
const menu = $('[data-menu]');
const toggle = $('[data-menu-toggle]');

function setMenu(open) {
  menu.hidden = !open;
  toggle.setAttribute('aria-expanded', String(open));
  $('.sr', toggle).textContent = open ? 'Cerrar menú' : 'Abrir menú';
  document.documentElement.style.overflow = open ? 'hidden' : '';
  if (lenis) open ? lenis.stop() : lenis.start();
}
toggle.addEventListener('click', () => setMenu(menu.hidden));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) setMenu(false); });

$$('a[href^="#"]').forEach((a) => {
  a.addEventListener('click', (e) => {
    const id = a.getAttribute('href').slice(1);
    if (a.hasAttribute('data-todo') || !id) { e.preventDefault(); return; }
    const target = document.getElementById(id);
    if (!target) return;
    e.preventDefault();
    if (!menu.hidden) setMenu(false);
    scrollToTarget(target);
  });
});

let lastY = 0;
function onScroll(y) {
  nav.classList.toggle('is-scrolled', y > 40);
  nav.classList.toggle('is-hidden', y > 400 && y > lastY && menu.hidden);
  lastY = y;
}
if (lenis) lenis.on('scroll', ({ scroll }) => onScroll(scroll));
else window.addEventListener('scroll', () => onScroll(window.scrollY), { passive: true });

/* ---------- Escena 3D ---------- */
const canvas = $('[data-scene]');
const scene = canvas ? createScene(canvas, { reducedMotion: reduced }) : null;
if (scene) {
  document.documentElement.classList.add('has-webgl');

  window.addEventListener('pointermove', (e) => {
    scene.setPointer((e.clientX / window.innerWidth) * 2 - 1, (e.clientY / window.innerHeight) * 2 - 1);
  }, { passive: true });

  if (!reduced) {
    ScrollTrigger.create({
      trigger: '.hero',
      start: 'top top',
      end: 'bottom top',
      scrub: true,
      onUpdate: (self) => scene.setScroll(self.progress),
    });
  }
}

/* ---------- Intro de la portada ---------- */
if (!reduced) {
  const tl = gsap.timeline({ defaults: { ease: 'expo.out' } });
  tl.from('[data-hero-title] .line > span', { yPercent: 115, duration: 1.4, stagger: 0.09 }, 0.1)
    .from('.hero__meta, .hero__foot', { y: 16, opacity: 0, duration: 1.2, stagger: 0.1 }, 0.5)
    .from('.nav', { y: -20, opacity: 0, duration: 1 }, 0.4);
  if (scene) {
    const state = { v: 0 };
    tl.to(state, { v: 1, duration: 2.2, ease: 'power2.out', onUpdate: () => scene.setIntro(state.v) }, 0);
  }

  // El título baja más lento que el scroll: queda "detrás" de la escultura.
  gsap.to('[data-hero-title]', {
    yPercent: 18,
    ease: 'none',
    scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true },
  });
}

/* ---------- Manifiesto: palabras que se encienden con el scroll ---------- */
const words = $('[data-words]');
if (words) {
  const text = words.textContent.trim().replace(/\s+/g, ' ');
  words.setAttribute('aria-label', text);
  words.innerHTML = text.split(' ').map((w) => `<span class="w" aria-hidden="true">${w}</span>`).join(' ');
  if (!reduced) {
    gsap.fromTo(words.querySelectorAll('.w'),
      { color: '#a9a9a3' },
      {
        color: '#121212',
        stagger: 0.1,
        ease: 'none',
        scrollTrigger: { trigger: words, start: 'top 80%', end: 'bottom 45%', scrub: true },
      });
  }
}

/* ---------- Servicios (acordeón) ---------- */
const svcItems = $$('[data-svc]');
function openSvc(item, open) {
  item.classList.toggle('is-open', open);
  $('.svc__row', item).setAttribute('aria-expanded', String(open));
}
svcItems.forEach((item, i) => {
  $('.svc__row', item).addEventListener('click', () => {
    const willOpen = !item.classList.contains('is-open');
    svcItems.forEach((other) => openSvc(other, false));
    openSvc(item, willOpen);
    setTimeout(() => ScrollTrigger.refresh(), 650);
  });
  if (i === 0) openSvc(item, true);
});

/* ---------- Profundidad: capas a distintas velocidades ---------- */
if (!reduced) {
  $$('[data-depth]').forEach((el) => {
    const depth = parseFloat(el.dataset.depth) || 0;
    const small = window.innerWidth <= 820;
    const amount = depth * (small ? 250 : 600);
    gsap.fromTo(el, { y: amount }, {
      y: -amount,
      ease: 'none',
      scrollTrigger: { trigger: el.closest('section') || el, start: 'top bottom', end: 'bottom top', scrub: true },
    });
  });

  gsap.from('.contact__title span', {
    yPercent: 40,
    ease: 'none',
    stagger: 0.15,
    scrollTrigger: { trigger: '.contact', start: 'top bottom', end: 'top 30%', scrub: true },
  });
}

/* ---------- Tarjetas: inclinación 3D con el mouse ---------- */
if (finePointer && !reduced) {
  $$('[data-tilt]').forEach((media) => {
    const art = media.firstElementChild;
    const rx = gsap.quickTo(art, 'rotationX', { duration: 0.8, ease: 'power3.out' });
    const ry = gsap.quickTo(art, 'rotationY', { duration: 0.8, ease: 'power3.out' });
    media.addEventListener('pointermove', (e) => {
      const r = media.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      ry(x * 12);
      rx(-y * 12);
    });
    media.addEventListener('pointerleave', () => { rx(0); ry(0); });
  });
}

/* ---------- Cursor ---------- */
const cursor = $('[data-cursor-el]');
if (finePointer && cursor) {
  const label = $('span', cursor);
  const cx = gsap.quickTo(cursor, 'x', { duration: 0.35, ease: 'power3.out' });
  const cy = gsap.quickTo(cursor, 'y', { duration: 0.35, ease: 'power3.out' });
  const dark = '.services, .contact, .footer, .marquee';
  window.addEventListener('pointermove', (e) => {
    cursor.classList.add('is-on');
    cx(e.clientX);
    cy(e.clientY);
    const el = e.target instanceof Element ? e.target : null;
    const hit = el?.closest('[data-cursor]');
    cursor.classList.toggle('is-big', !!hit);
    if (hit) label.textContent = hit.dataset.cursor;
    cursor.classList.toggle('is-dark', !!el?.closest(dark));
  }, { passive: true });
  document.addEventListener('pointerleave', () => cursor.classList.remove('is-on'));
}

/* ---------- Formulario de contacto ----------
   Para recibir mensajes, agregá data-endpoint="https://..." al <form>
   (Formspree, Basin, un webhook propio, etc.). */
const form = $('[data-form]');
if (form) {
  const status = $('[data-form-status]', form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    let firstInvalid = null;
    $$('input[required], textarea[required]', form).forEach((field) => {
      const ok = field.checkValidity();
      field.setAttribute('aria-invalid', String(!ok));
      if (!ok && !firstInvalid) firstInvalid = field;
    });
    if (firstInvalid) {
      status.textContent = 'Completá nombre, un email válido y contanos del proyecto.';
      firstInvalid.focus();
      return;
    }

    const data = Object.fromEntries(new FormData(form));
    data.servicio = new FormData(form).getAll('servicio');
    const endpoint = form.dataset.endpoint;
    if (!endpoint) {
      status.textContent = 'Vista previa: el formulario funciona, pero todavía no está conectado a un servicio de envío.';
      return;
    }
    status.textContent = 'Enviando…';
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error(String(res.status));
      form.reset();
      status.textContent = `Gracias, ${data.nombre}. Te respondemos en menos de 48 horas hábiles.`;
    } catch {
      status.textContent = 'No se pudo enviar. Revisá tu conexión y probá de nuevo.';
    }
  });
}

window.addEventListener('load', () => ScrollTrigger.refresh());
